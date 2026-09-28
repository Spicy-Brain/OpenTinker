import type { ChildProcess } from 'node:child_process';
import {
    LineDecoder,
    PROTOCOL_VERSION,
    RESPONSE_TYPES,
    encodeRequest,
    isWorkerFrame,
    stripAnsi,
    type Capabilities,
    type ExecRequest,
    type ImportsFrame,
    type LogFrame,
    type ModelHintsFrame,
    type PongFrame,
    type ReadyFrame,
    type ResetFrame,
    type ResultFrame,
    type ScopeFrame,
    type SimpleRequestType,
    type WorkerFrame,
    type WorkerRequest,
} from '../shared/protocol';
import type { Transport } from './transport';

export type SessionStatus = 'stopped' | 'starting' | 'ready';

export interface SessionEvents {
    onFrame(frame: WorkerFrame): void;
    onStatus(status: SessionStatus, detail?: string): void;
}

interface PendingRequest {
    /** The frame type that answers this request (a run also sends scope frames). */
    expects: WorkerFrame['type'];
    resolve: (frame: WorkerFrame) => void;
    reject: (error: Error) => void;
    timer?: NodeJS.Timeout;
}

const START_TIMEOUT_MS = 30000;
const REQUEST_TIMEOUT_MS = 30000;
/** How long the worker gets to stop its runs after SIGTERM before it is killed. */
const KILL_GRACE_MS = 1500;

/**
 * One worker process for one target. The worker boots the app once; runs are
 * forked from it (fresh sessions) or sent to its kept-session child.
 */
export class TinkerSession {
    private child?: ChildProcess;
    private readonly decoder = new LineDecoder();
    private readonly pending = new Map<string, PendingRequest>();
    private sequence = 0;
    private startPromise?: Promise<void>;
    private ready = false;
    private disposed = false;
    private lastReady?: ReadyFrame;
    private readyWaiter?: {
        resolve: () => void;
        reject: (error: Error) => void;
        timer: NodeJS.Timeout;
    };

    constructor(
        private readonly transport: Transport,
        private readonly events: SessionEvents,
    ) {}

    get isReady(): boolean {
        return this.ready;
    }

    get transportLabel(): string {
        return this.transport.label;
    }

    get readyInfo(): ReadyFrame | undefined {
        return this.lastReady;
    }

    get capabilities(): Capabilities {
        return this.lastReady?.capabilities ?? { fork: false, parser: false, database: false };
    }

    nextId(prefix: string): string {
        return `${prefix}${++this.sequence}`;
    }

    async ensureStarted(): Promise<void> {
        if (this.disposed) throw new Error('Session has been disposed');
        if (this.ready && this.child && this.child.exitCode === null) return;
        this.startPromise ??= this.start().finally(() => {
            this.startPromise = undefined;
        });
        return this.startPromise;
    }

    /** Runs code; resolves with the result frame. Timeouts are the caller's job. */
    async exec(request: Omit<ExecRequest, 'type'>): Promise<ResultFrame> {
        await this.ensureStarted();
        const settled = this.waitFor(request.id, 'result', 0);
        this.write({ type: 'exec', ...request });
        const frame = await settled;
        if (frame.type !== 'result') throw new Error('Unexpected response to a run');
        return frame;
    }

    /** Asks the worker to stop a running fresh run; the worker stays warm. */
    cancel(runId: string): void {
        if (this.child?.stdin?.writable) this.write({ type: 'cancel', id: runId });
    }

    async imports(source: string, line: number): Promise<ImportsFrame> {
        await this.ensureStarted();
        const id = this.nextId('i');
        const settled = this.waitFor(id, 'imports');
        this.write({ id, type: 'imports', source, line });
        return this.expect<ImportsFrame>(await settled, 'imports');
    }

    async ping(): Promise<PongFrame> {
        return this.expect<PongFrame>(await this.simple('ping'), 'pong');
    }

    async readLog(): Promise<LogFrame> {
        return this.expect<LogFrame>(await this.simple('log'), 'log');
    }

    async scope(): Promise<ScopeFrame> {
        return this.expect<ScopeFrame>(await this.simple('scope'), 'scope');
    }

    async modelHints(): Promise<ModelHintsFrame> {
        return this.expect<ModelHintsFrame>(await this.simple('modelHints', 120000), 'modelHints');
    }

    /** Clears the kept session. Returns false when the worker cannot fork. */
    async resetKeptSession(): Promise<boolean> {
        if (!this.ready) return true;
        const frame = this.expect<ResetFrame>(await this.simple('reset'), 'reset');
        return frame.ok;
    }

    /** Hard stop: kills the worker process. */
    stop(reason = 'Run stopped by user'): void {
        this.ready = false;
        this.lastReady = undefined;
        this.kill();
        this.child = undefined;
        this.failStart(new Error(reason));
        this.resetPending(new Error(reason));
        this.events.onStatus('stopped');
    }

    async restart(): Promise<void> {
        this.kill();
        this.child = undefined;
        this.ready = false;
        this.lastReady = undefined;
        this.failStart(new Error('Session restarted'));
        this.resetPending(new Error('Session restarted'));
        if (this.startPromise) await this.startPromise.catch(() => undefined);
        await this.ensureStarted();
    }

    dispose(): void {
        this.disposed = true;
        this.resetPending(new Error('Session closed'));
        if (this.child?.stdin?.writable) this.write({ type: 'shutdown' });
        this.kill();
        this.events.onStatus('stopped');
    }

    private async simple(
        type: SimpleRequestType,
        timeoutMs = REQUEST_TIMEOUT_MS,
    ): Promise<WorkerFrame> {
        await this.ensureStarted();
        const id = this.nextId(type[0]);
        const expects: Record<SimpleRequestType, WorkerFrame['type']> = {
            ping: 'pong',
            log: 'log',
            scope: 'scope',
            reset: 'reset',
            modelHints: 'modelHints',
        };
        const settled = this.waitFor(id, expects[type], timeoutMs);
        this.write({ id, type });
        return settled;
    }

    private expect<T extends WorkerFrame>(frame: WorkerFrame, type: T['type']): T {
        if (frame.type === 'unsupported') {
            throw new Error('This worker does not support that request. Restart the session.');
        }
        if (frame.type !== type) throw new Error(`Unexpected ${frame.type} response`);
        return frame as T;
    }

    private write(request: WorkerRequest): void {
        this.child?.stdin?.write(encodeRequest(request));
    }

    private async start(): Promise<void> {
        this.events.onStatus('starting');
        await this.transport.ensureWorker();
        if (this.disposed) throw new Error('Session closed during startup');

        const child = this.transport.spawn();
        this.child = child;
        this.decoder.reset();
        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => {
            if (this.child === child) this.handleChunk(chunk);
        });

        let stderr = '';
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (chunk: string) => {
            stderr = (stderr + chunk).slice(-8192);
        });

        let exited = false;
        child.on('error', (error) => {
            exited = true;
            this.handleExit(error.message, child);
        });
        child.on('close', (code) => {
            if (exited) return;
            exited = true;
            this.handleExit(stripAnsi(stderr).trim() || `worker exited with code ${code}`, child);
        });

        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.readyWaiter = undefined;
                this.kill();
                reject(new Error('Timed out waiting for the app to boot'));
            }, START_TIMEOUT_MS);

            this.readyWaiter = { resolve, reject, timer };
        });
    }

    private handleChunk(chunk: string): void {
        for (const line of this.decoder.push(chunk)) {
            if (line.trim() === '') continue;

            let parsed: unknown;
            try {
                parsed = JSON.parse(line);
            } catch {
                // Stray process output (a framework renderer, fwrite(STDOUT)).
                this.events.onFrame({ type: 'output', id: null, text: stripAnsi(line) + '\n' });
                continue;
            }

            if (!isWorkerFrame(parsed)) continue;
            const frame = parsed;

            if (frame.type === 'ready') {
                if (frame.protocol !== PROTOCOL_VERSION) {
                    this.failStart(
                        new Error(
                            `The worker speaks protocol ${frame.protocol ?? 1}, but this extension needs ${PROTOCOL_VERSION}. Reload the window to update it.`,
                        ),
                    );
                    this.kill();
                    continue;
                }
                this.ready = true;
                this.lastReady = frame;
                if (this.readyWaiter) {
                    clearTimeout(this.readyWaiter.timer);
                    this.readyWaiter.resolve();
                    this.readyWaiter = undefined;
                }
                this.events.onFrame(frame);
                this.events.onStatus('ready');
                continue;
            }

            this.events.onFrame(frame);

            if (frame.type === 'fatal') this.failStart(new Error(frame.message));

            if (RESPONSE_TYPES.has(frame.type) && 'id' in frame && typeof frame.id === 'string') {
                const pending = this.pending.get(frame.id);
                if (pending && (frame.type === pending.expects || frame.type === 'unsupported')) {
                    this.pending.delete(frame.id);
                    if (pending.timer) clearTimeout(pending.timer);
                    pending.resolve(frame);
                }
            }
        }
    }

    private handleExit(detail: string, source: ChildProcess): void {
        if (this.child !== source) return;
        this.ready = false;
        this.lastReady = undefined;
        this.child = undefined;
        this.failStart(new Error(detail));
        this.resetPending(new Error(detail));
        if (!this.disposed) this.events.onStatus('stopped', detail);
    }

    private failStart(error: Error): void {
        if (this.readyWaiter) {
            clearTimeout(this.readyWaiter.timer);
            this.readyWaiter.reject(error);
            this.readyWaiter = undefined;
        }
    }

    private waitFor(
        id: string,
        expects: WorkerFrame['type'],
        timeoutMs = REQUEST_TIMEOUT_MS,
    ): Promise<WorkerFrame> {
        return new Promise<WorkerFrame>((resolve, reject) => {
            const timer =
                timeoutMs > 0
                    ? setTimeout(() => {
                          this.pending.delete(id);
                          reject(new Error('The worker did not respond in time'));
                      }, timeoutMs)
                    : undefined;
            this.pending.set(id, { expects, resolve, reject, timer });
        });
    }

    private resetPending(error: Error): void {
        for (const [id, pending] of this.pending) {
            if (pending.timer) clearTimeout(pending.timer);
            pending.reject(error);
            this.pending.delete(id);
        }
    }

    /**
     * Asks the worker to exit, then forces it. SIGTERM lets it stop its forked
     * runs first; SIGKILL alone would leave them running as orphans. Docker and
     * SSH clients exit on SIGTERM, which closes the worker's input, and the
     * worker cleans up on that too.
     */
    private kill(graceMs = KILL_GRACE_MS): void {
        const child = this.child;
        if (!child || child.exitCode !== null || child.signalCode !== null) return;
        child.kill('SIGTERM');
        setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }, graceMs).unref?.();
    }
}
