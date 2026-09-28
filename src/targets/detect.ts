import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { Target } from './target';
import { newTargetId } from './targetStore';

const execFileAsync = promisify(execFile);

const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml'];
/** Service names that usually run the app itself (Sail uses laravel.test). */
const PRIMARY_NAMES = /^(app|laravel(\.test)?|php|php-fpm|web|api|backend|workspace|application)$/i;
/** Services that share the code but are not where you would tinker. */
const SECONDARY_NAMES = /(queue|horizon|worker|scheduler|cron|test|ci|node|vite|npm)/i;
const CODE_FOLDERS = new Set([
    'app',
    'src',
    'lib',
    'vendor',
    'routes',
    'config',
    'database',
    'resources',
    'bootstrap',
    'storage',
    'public',
    'tests',
    'artisan',
    'composer.json',
    'composer.lock',
]);

export interface DetectedTarget {
    target: Target;
    running: boolean;
    score: number;
    reason: string;
}

interface ComposeService {
    name: string;
    running: boolean;
    workingDir?: string;
    bindCount: number;
}

/**
 * Finds places this workspace's code can run: Compose services that mount it
 * (Sail included) and local PHP. Best candidates first.
 */
export async function detectTargets(workspace: string): Promise<DetectedTarget[]> {
    const found: DetectedTarget[] = [];

    if (COMPOSE_FILES.some((file) => existsSync(path.join(workspace, file)))) {
        for (const service of await composeServices(workspace)) {
            let score = service.bindCount;
            if (service.running) score += 20;
            if (PRIMARY_NAMES.test(service.name)) score += 10;
            if (SECONDARY_NAMES.test(service.name)) score -= 10;
            found.push({
                target: {
                    id: newTargetId(),
                    kind: 'compose',
                    name: service.name,
                    service: service.name,
                    workingDir: service.workingDir ?? '/var/www',
                    environment: 'local',
                },
                running: service.running,
                score,
                reason: `Compose service mounting this project${service.running ? '' : ' (stopped)'}`,
            });
        }
    }

    if (existsSync(path.join(workspace, 'vendor', 'autoload.php')) && (await localPhp())) {
        found.push({
            target: {
                id: newTargetId(),
                kind: 'local',
                name: 'Local PHP',
                workingDir: '',
                phpBinary: 'php',
                environment: 'local',
            },
            running: true,
            // Prefer a running container when there is one: that is where the app's services live.
            score: found.some((item) => item.running) ? 5 : 25,
            reason: 'PHP on this machine (Herd, Valet or a local install)',
        });
    }

    return found.sort((a, b) => b.score - a.score);
}

/** The candidate to use without asking, when one is clearly right. */
export function obviousChoice(candidates: DetectedTarget[]): DetectedTarget | undefined {
    if (candidates.length === 1) return candidates[0];
    const [best, next] = candidates;
    if (!best?.running) return undefined;
    const primaryRunning = candidates.filter(
        (item) =>
            item.running && item.target.kind === 'compose' && PRIMARY_NAMES.test(item.target.name),
    );
    if (primaryRunning.length === 1 && primaryRunning[0] === best) return best;
    return next && best.score - next.score >= 15 ? best : undefined;
}

async function composeServices(workspace: string): Promise<ComposeService[]> {
    let config: { services?: Record<string, { working_dir?: string; volumes?: unknown[] }> };
    try {
        const { stdout } = await execFileAsync(
            'docker',
            ['compose', 'config', '--format', 'json'],
            {
                cwd: workspace,
                timeout: 15000,
                maxBuffer: 10 * 1024 * 1024,
            },
        );
        config = JSON.parse(stdout) as typeof config;
    } catch {
        return [];
    }

    const running = await runningServices(workspace);
    const services: ComposeService[] = [];

    for (const [name, service] of Object.entries(config.services ?? {})) {
        const roots = new Map<string, number>();
        let bindCount = 0;

        for (const volume of service.volumes ?? []) {
            const root = projectRoot(volume, workspace);
            if (root === undefined) continue;
            bindCount++;
            roots.set(root, (roots.get(root) ?? 0) + 1);
        }

        if (bindCount === 0) continue;

        const workingDir =
            [...roots.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? service.working_dir;
        services.push({ name, running: running.has(name), workingDir, bindCount });
    }

    return services;
}

/**
 * Where the workspace root sits inside the container, from one bind mount.
 * `./app:/var/www/app` and `.:/var/www` both mean the root is /var/www.
 */
export function projectRoot(volume: unknown, workspace: string): string | undefined {
    if (!volume || typeof volume !== 'object') return undefined;
    const bind = volume as { type?: string; source?: string; target?: string };
    if (bind.type !== 'bind' || !bind.source || !bind.target) return undefined;

    const relative = path.relative(workspace, bind.source);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
    if (relative === '') return bind.target.replace(/\/+$/, '') || '/';
    // Only folders that hold the PHP project's code say where the project lives.
    if (!CODE_FOLDERS.has(relative.split(path.sep)[0] ?? '')) return undefined;

    const suffix = '/' + relative.split(path.sep).join('/');
    const target = bind.target.replace(/\/+$/, '');
    return target.endsWith(suffix) ? target.slice(0, -suffix.length) || '/' : undefined;
}

async function runningServices(workspace: string): Promise<Set<string>> {
    const running = new Set<string>();
    try {
        const { stdout } = await execFileAsync('docker', ['compose', 'ps', '--format', 'json'], {
            cwd: workspace,
            timeout: 10000,
        });
        for (const row of parseJsonLines(stdout)) {
            if (typeof row.Service === 'string' && row.State === 'running')
                running.add(row.Service);
        }
    } catch {
        // Docker not running: every service counts as stopped.
    }
    return running;
}

async function localPhp(): Promise<boolean> {
    try {
        await execFileAsync('php', ['-r', 'echo PHP_VERSION;'], { timeout: 5000 });
        return true;
    } catch {
        return false;
    }
}

export function parseJsonLines(stdout: string): Array<Record<string, unknown>> {
    const trimmed = stdout.trim();
    if (trimmed === '') return [];

    try {
        const parsed: unknown = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
            return parsed.filter(
                (entry): entry is Record<string, unknown> =>
                    typeof entry === 'object' && entry !== null,
            );
        }
        if (typeof parsed === 'object' && parsed !== null)
            return [parsed as Record<string, unknown>];
    } catch {
        // Older Compose versions print one JSON object per line.
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

/** Running containers, for manual docker exec targets. */
export async function listRunningContainers(): Promise<string[]> {
    try {
        const { stdout } = await execFileAsync('docker', ['ps', '--format', '{{.Names}}'], {
            timeout: 10000,
        });
        return stdout
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean);
    } catch {
        return [];
    }
}

/** All Compose service names, for the target form. */
export async function listComposeServiceNames(workspace: string): Promise<string[]> {
    try {
        const { stdout } = await execFileAsync('docker', ['compose', 'config', '--services'], {
            cwd: workspace,
            timeout: 10000,
        });
        return stdout
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean);
    } catch {
        return [];
    }
}
