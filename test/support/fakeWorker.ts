import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { Transport } from '../../src/session/transport';

export interface FakeOptions {
    fork?: boolean;
    env?: string;
    protocol?: number;
    /** Runs that should hang until cancelled. */
    hang?: (code: string) => boolean;
}

/** Speaks enough of protocol v2 to exercise sessions and the run controller. */
export class FakeWorker extends EventEmitter {
    readonly stdin = new PassThrough();
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    exitCode: number | null = null;
    readonly requests: Array<Record<string, unknown>> = [];
    private buffer = '';

    constructor(private readonly options: FakeOptions = {}) {
        super();
        this.stdin.on('data', (chunk: Buffer) => {
            this.buffer += chunk.toString();
            let index: number;
            while ((index = this.buffer.indexOf('\n')) >= 0) {
                const line = this.buffer.slice(0, index);
                this.buffer = this.buffer.slice(index + 1);
                if (line.trim()) this.handle(JSON.parse(line) as Record<string, unknown>);
            }
        });
        queueMicrotask(() =>
            this.send({
                type: 'ready',
                protocol: options.protocol ?? 2,
                php: '8.3.0',
                framework: 'laravel',
                laravel: '12.0.0',
                psysh: 'v0.12.24',
                env: options.env ?? 'local',
                basePath: '/app',
                pid: 1,
                capabilities: { fork: options.fork ?? true, parser: true, database: true },
            }),
        );
    }

    send(frame: object): void {
        this.stdout.write(JSON.stringify(frame) + '\n');
    }

    kill(): boolean {
        if (this.exitCode !== null) return false;
        this.exitCode = 137;
        queueMicrotask(() => this.emit('close', 137));
        return true;
    }

    private handle(request: Record<string, unknown>): void {
        this.requests.push(request);
        const id = request.id as string;
        switch (request.type) {
            case 'ping':
                this.send({
                    type: 'pong',
                    id,
                    php: '8.3.0',
                    laravel: '12',
                    env: 'local',
                    basePath: '/app',
                    pid: 1,
                });
                break;
            case 'log':
                this.send({ type: 'log', id, path: 'laravel.log', lines: 'hello' });
                break;
            case 'scope':
                this.send({ type: 'scope', id, vars: [{ name: 'user', html: 'Ada' }] });
                break;
            case 'reset':
                this.send({ type: 'reset', id, ok: this.options.fork ?? true });
                break;
            case 'imports':
                this.send({ type: 'imports', id, statements: ['use App\\Models\\User;'] });
                break;
            case 'cancel':
                this.send({
                    type: 'statement',
                    id,
                    stmt: 1,
                    line: 1,
                    ok: false,
                    ms: 0,
                    memory: 0,
                    exit: 'Stopped',
                });
                this.send({
                    type: 'result',
                    id,
                    ok: false,
                    failed: true,
                    stopped: true,
                    statements: 1,
                    ms: 0,
                    memory: 0,
                });
                break;
            case 'exec': {
                const code = String(request.code);
                if (this.options.hang?.(code)) break;
                this.send({
                    type: 'value',
                    id,
                    stmt: 1,
                    line: 1,
                    short: code.length > 20 ? 'long' : code.replace(/;$/, ''),
                    html: '<span>v</span>',
                });
                this.send({
                    type: 'statement',
                    id,
                    stmt: 1,
                    line: 1,
                    ok: true,
                    ms: 1,
                    memory: 0,
                    short: 'v',
                });
                this.send({ type: 'scope', id, vars: [{ name: 'x', html: '1' }] });
                this.send({
                    type: 'result',
                    id,
                    ok: true,
                    statements: 1,
                    ms: 2,
                    memory: 1024,
                    rolledBack: request.rollback ? true : null,
                });
                break;
            }
        }
    }
}

export function fakeTransport(options: FakeOptions = {}): {
    transport: Transport;
    workers: FakeWorker[];
} {
    const workers: FakeWorker[] = [];
    return {
        workers,
        transport: {
            label: 'fake',
            ensureWorker: async () => undefined,
            spawn: () => {
                const worker = new FakeWorker(options);
                workers.push(worker);
                return worker as unknown as ChildProcess;
            },
        },
    };
}
