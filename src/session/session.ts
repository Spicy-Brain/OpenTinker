import type { ChildProcess } from 'node:child_process';
import {
    LineDecoder,
    encodeRequest,
    isWorkerFrame,
    type ExecutionMode,
    type WorkerFrame,
} from './protocol';
import type { Transport } from './transport';

export type SessionStatus = 'stopped' | 'starting' | 'ready';

export interface SessionEvents {
    onFrame(frame: WorkerFrame): void;
    onStatus(status: SessionStatus, detail?: string): void;
}

interface PendingRequest {
    resolve: (frame: WorkerFrame) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
}

export class TinkerSession {
    private child?: ChildProcess;
    private readonly decoder = new LineDecoder();
    private readonly pending = new Map<string, PendingRequest>();
    private sequence = 0;
    private startPromise?: Promise<void>;
    private ready = false;
    private disposed = false;
    private readyWaiter?: {
        resolve: () => void;
        reject: (error: Error) => void;
        timer: NodeJS.Timeout;
    };

    constructor(
        private readonly transport: Transport,
        private readonly events: SessionEvents,
        private readonly timeoutMs: number,
    ) {}

    get isReady(): boolean {
        return this.ready;
    }

    get transportLabel(): string {
        return this.transport.label;
    }

    async ensureStarted(): Promise<void> {
        if (this.disposed) {
            throw new Error('Session has been disposed');
        }
        if (this.ready && this.child && this.child.exitCode === null) {
            return;
        }
        if (!this.startPromise) {
            this.startPromise = this.start().finally(() => {
                this.startPromise = undefined;
            });
        }
        return this.startPromise;
    }

    async exec(code: string, mode: ExecutionMode = 'statements'): Promise<void> {
        await this.ensureStarted();
        const id = `r${++this.sequence}`;
        const settled = this.waitFor(id);
        this.child?.stdin?.write(encodeRequest({ id, type: 'exec', code, mode }));
        await settled;
    }

    async restart(): Promise<void> {
        this.kill();
        this.resetPending(new Error('Session restarted'));
        await this.ensureStarted();
    }

    dispose(): void {
        this.disposed = true;
        this.resetPending(new Error('Session disposed'));
        if (this.child?.stdin?.writable) {
            this.child.stdin.write(encodeRequest({ type: 'shutdown' }));
        }
        this.kill(1500);
        this.events.onStatus('stopped');
    }

    private async start(): Promise<void> {
        this.events.onStatus('starting');
        await this.transport.ensureWorker();

        const child = this.transport.spawn();
        this.child = child;
        this.decoder.reset();
        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => this.handleChunk(chunk));

        let stderr = '';
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (chunk: string) => {
            stderr = (stderr + chunk).slice(-8192);
        });

        let exited = false;
        child.on('error', (error) => {
            exited = true;
            this.handleExit(error.message);
        });
        child.on('close', (code) => {
            if (exited) {
                return;
            }
            exited = true;
            this.handleExit(stderr.trim() || `worker exited with code ${code}`);
        });

        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.readyWaiter = undefined;
                this.kill();
                reject(new Error('Timed out waiting for the worker to start'));
            }, 15000);

            this.readyWaiter = { resolve, reject, timer };
        });
    }

    private handleChunk(chunk: string): void {
        for (const line of this.decoder.push(chunk)) {
            if (line.trim() === '') {
                continue;
            }

            let parsed: unknown;
            try {
                parsed = JSON.parse(line);
            } catch {
                this.events.onFrame({ type: 'output', text: line + '\n' });
                continue;
            }

            if (!isWorkerFrame(parsed)) {
                continue;
            }

            const frame = parsed;
            this.events.onFrame(frame);

            if (frame.type === 'ready') {
                this.ready = true;
                if (this.readyWaiter) {
                    clearTimeout(this.readyWaiter.timer);
                    this.readyWaiter.resolve();
                    this.readyWaiter = undefined;
                }
                this.events.onStatus('ready');
            }

            if (frame.type === 'fatal') {
                this.failStart(new Error(frame.message));
            }

            // Per-statement errors render as cards; only result/pong settle a run.
            if ((frame.type === 'result' || frame.type === 'pong') && 'id' in frame) {
                const pending = this.pending.get(frame.id);
                if (pending) {
                    this.pending.delete(frame.id);
                    clearTimeout(pending.timer);
                    pending.resolve(frame);
                }
            }
        }
    }

    private handleExit(detail: string): void {
        this.ready = false;
        this.child = undefined;
        this.failStart(new Error(detail));
        this.resetPending(new Error(detail));
        if (!this.disposed) {
            this.events.onStatus('stopped', detail);
            this.events.onFrame({ type: 'fatal', message: detail });
        }
    }

    private failStart(error: Error): void {
        if (this.readyWaiter) {
            clearTimeout(this.readyWaiter.timer);
            this.readyWaiter.reject(error);
            this.readyWaiter = undefined;
        }
    }

    private waitFor(id: string): Promise<WorkerFrame> {
        return new Promise<WorkerFrame>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                this.kill();
                reject(new Error(`Snippet timed out after ${this.timeoutMs}ms`));
            }, this.timeoutMs);

            this.pending.set(id, { resolve, reject, timer });
        });
    }

    private resetPending(error: Error): void {
        for (const [id, pending] of this.pending) {
            clearTimeout(pending.timer);
            pending.reject(error);
            this.pending.delete(id);
        }
    }

    private kill(graceMs = 0): void {
        const child = this.child;
        if (!child || child.exitCode !== null) {
            return;
        }
        if (graceMs > 0) {
            setTimeout(() => child.kill('SIGKILL'), graceMs).unref?.();
        } else {
            child.kill('SIGKILL');
        }
    }
}
