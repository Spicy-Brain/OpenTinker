import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { Transport, TransportContext } from './transport';

export class LocalTransport implements Transport {
    readonly label: string;
    private readonly workerPath: string;

    constructor(private readonly context: TransportContext) {
        this.label = `local ${context.phpBinary}`;
        this.workerPath = path.join(context.storageDir, 'worker.php');
    }

    async ensureWorker(): Promise<void> {
        await mkdir(this.context.storageDir, { recursive: true });
        await writeFile(this.workerPath, this.context.workerSource, 'utf8');
    }

    spawn(): ChildProcess {
        return spawn(
            this.context.phpBinary,
            [this.workerPath, '--base-path', this.context.workspaceFolder],
            {
                cwd: this.context.workspaceFolder,
                stdio: ['pipe', 'pipe', 'pipe'],
            },
        );
    }
}
