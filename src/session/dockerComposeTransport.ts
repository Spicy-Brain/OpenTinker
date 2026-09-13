import { spawn, type ChildProcess } from 'node:child_process';
import type { Transport, TransportContext } from './transport';

const CONTAINER_WORKER_DIR = '/tmp/opentinker';
const CONTAINER_WORKER_PATH = `${CONTAINER_WORKER_DIR}/worker.php`;

export class DockerComposeTransport implements Transport {
    readonly label: string;

    constructor(
        private readonly context: TransportContext,
        private readonly service: string,
    ) {
        this.label = `docker compose exec ${service}`;
    }

    async ensureWorker(): Promise<void> {
        await this.run([
            'compose',
            'exec',
            '-T',
            this.service,
            'mkdir',
            '-p',
            CONTAINER_WORKER_DIR,
        ]);
        await this.run(
            ['compose', 'exec', '-T', this.service, 'sh', '-c', `cat > ${CONTAINER_WORKER_PATH}`],
            this.context.workerSource,
        );
    }

    spawn(): ChildProcess {
        return spawn(
            'docker',
            [
                'compose',
                'exec',
                '-T',
                this.service,
                'php',
                CONTAINER_WORKER_PATH,
                `--base-path=${this.context.workingDir}`,
            ],
            {
                cwd: this.context.workspaceFolder,
                stdio: ['pipe', 'pipe', 'pipe'],
            },
        );
    }

    private run(args: string[], input?: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const child = spawn('docker', args, {
                cwd: this.context.workspaceFolder,
                stdio: [input === undefined ? 'ignore' : 'pipe', 'ignore', 'pipe'],
            });

            let stderr = '';
            child.stderr?.on('data', (chunk: Buffer) => {
                stderr += chunk.toString();
            });

            child.on('error', reject);
            child.on('close', (code) => {
                if (code === 0) {
                    resolve();
                } else {
                    reject(
                        new Error(
                            stderr.trim() || `docker ${args.join(' ')} exited with code ${code}`,
                        ),
                    );
                }
            });

            if (input !== undefined) {
                child.stdin?.end(input);
            }
        });
    }
}
