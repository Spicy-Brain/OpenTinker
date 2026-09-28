import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';

export interface Transport {
    /** Human readable description of where the worker runs. */
    readonly label: string;

    /** Makes the worker script available to the runtime before spawning. */
    ensureWorker(): Promise<void>;

    /** Spawns the long-lived worker process. */
    spawn(): ChildProcess;
}

export interface TransportContext {
    /** Local workspace folder. */
    workspaceFolder: string;
    /** Project path inside the runtime (container, remote host or local folder). */
    workingDir: string;
    phpBinary: string;
    /** Local folder for the worker file (local transport). */
    storageDir: string;
    workerSource: string;
    /** 'auto', 'laravel', 'composer' or a bootstrap file path. */
    bootstrap: string;
}

/** Content hash so different extension versions never overwrite each other's worker. */
export function workerHash(source: string): string {
    return createHash('sha256').update(source).digest('hex').slice(0, 16);
}

export function workerArgs(context: TransportContext, workerPath: string): string[] {
    return [workerPath, `--base-path=${context.workingDir}`, `--bootstrap=${context.bootstrap}`];
}

/** Runs a short command and resolves when it exits cleanly. */
export function runCommand(
    command: string,
    args: string[],
    cwd: string,
    input?: string,
    timeoutMs = 30000,
): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd,
            stdio: [input === undefined ? 'ignore' : 'pipe', 'ignore', 'pipe'],
        });

        let stderr = '';
        let settled = false;
        const finish = (error?: Error): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error) reject(error);
            else resolve();
        };
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            finish(new Error(`${command} ${args.slice(0, 3).join(' ')} timed out`));
        }, timeoutMs);

        child.stderr?.on('data', (chunk: Buffer) => {
            stderr = (stderr + chunk.toString()).slice(-8192);
        });
        child.on('error', (error) => finish(error));
        child.stdin?.on('error', (error) => finish(error));
        child.on('close', (code) => {
            if (code === 0) finish();
            else
                finish(
                    new Error(stderr.trim() || `${command} ${args.join(' ')} exited with ${code}`),
                );
        });

        if (input !== undefined) child.stdin?.end(input);
    });
}
