import type { ChildProcess } from 'node:child_process';

export interface Transport {
    /** Human readable description shown in the output panel status line. */
    readonly label: string;

    /** Makes the worker script available to the runtime before spawning. */
    ensureWorker(): Promise<void>;

    /** Spawns the long-lived worker process. */
    spawn(): ChildProcess;
}

export interface TransportContext {
    workspaceFolder: string;
    workingDir: string;
    phpBinary: string;
    storageDir: string;
    workerSource: string;
}
