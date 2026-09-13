import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ComposeService {
    name: string;
    running: boolean;
}

/**
 * Lists the services defined in a docker-compose file and whether they have a
 * running container. Returns an empty list when Docker or Compose is unavailable.
 */
export async function listComposeServices(workspaceFolder: string): Promise<ComposeService[]> {
    let names: string[];

    try {
        const { stdout } = await execFileAsync('docker', ['compose', 'config', '--services'], {
            cwd: workspaceFolder,
            timeout: 10000,
        });

        names = stdout
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line !== '');
    } catch {
        return [];
    }

    if (names.length === 0) {
        return [];
    }

    const running = new Set<string>();

    try {
        const { stdout } = await execFileAsync('docker', ['compose', 'ps', '--format', 'json'], {
            cwd: workspaceFolder,
            timeout: 10000,
        });

        for (const row of parseJsonLines(stdout)) {
            const service = row['Service'];
            const state = row['State'];

            if (typeof service === 'string' && state === 'running') {
                running.add(service);
            }
        }
    } catch {
        // Containers may all be stopped; that is not an error for this list.
    }

    return names.map((name) => ({ name, running: running.has(name) }));
}

export async function listRunningContainers(): Promise<string[]> {
    try {
        const { stdout } = await execFileAsync('docker', ['ps', '--format', '{{.Names}}'], {
            timeout: 10000,
        });

        return stdout
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line !== '');
    } catch {
        return [];
    }
}

export async function containerIsRunning(name: string): Promise<boolean> {
    try {
        const { stdout } = await execFileAsync(
            'docker',
            ['inspect', '-f', '{{.State.Running}}', name],
            { timeout: 10000 },
        );

        return stdout.trim() === 'true';
    } catch {
        return false;
    }
}

function parseJsonLines(stdout: string): Array<Record<string, unknown>> {
    const trimmed = stdout.trim();

    if (trimmed === '') {
        return [];
    }

    try {
        const parsed: unknown = JSON.parse(trimmed);

        if (Array.isArray(parsed)) {
            return parsed.filter(
                (entry): entry is Record<string, unknown> =>
                    typeof entry === 'object' && entry !== null,
            );
        }

        if (typeof parsed === 'object' && parsed !== null) {
            return [parsed as Record<string, unknown>];
        }
    } catch {
        // Fall through to line-by-line parsing for older Compose versions.
    }

    return trimmed
        .split('\n')
        .map((line) => {
            try {
                const entry: unknown = JSON.parse(line);

                return typeof entry === 'object' && entry !== null
                    ? (entry as Record<string, unknown>)
                    : undefined;
            } catch {
                return undefined;
            }
        })
        .filter((entry): entry is Record<string, unknown> => entry !== undefined);
}
