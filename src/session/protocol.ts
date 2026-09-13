export type ExecutionMode = 'statements' | 'file';

export interface ExecRequest {
    id: string;
    type: 'exec';
    code: string;
    mode: ExecutionMode;
}

export interface ScopeRequest {
    id: string;
    type: 'scope';
}

export interface PingRequest {
    id: string;
    type: 'ping';
}

export interface ShutdownRequest {
    type: 'shutdown';
}

export type WorkerRequest = ExecRequest | ScopeRequest | PingRequest | ShutdownRequest;

export interface ReadyFrame {
    type: 'ready';
    php: string;
    laravel: string;
    env: string;
    basePath: string;
    pid: number;
}

export interface OutputFrame {
    type: 'output';
    id?: string | null;
    text: string;
    stmt?: number;
    line?: number | null;
}

export interface DumpFrame {
    type: 'dump';
    id?: string | null;
    html: string;
    stmt?: number;
    line?: number | null;
}

export interface ValueFrame {
    type: 'value';
    id: string;
    html: string;
    stmt?: number;
    line?: number | null;
}

export interface QueryRecord {
    sql: string;
    bindings: string[];
    time: number | null;
}

export interface StatementFrame {
    type: 'statement';
    id: string;
    stmt: number;
    line: number;
    ok: boolean;
    ms: number;
    memory: number;
    exit?: string;
    queries?: QueryRecord[];
}

export interface ResultFrame {
    type: 'result';
    id: string;
    ok: boolean;
    failed?: boolean;
    statements?: number;
    ms: number;
    memory: number;
}

export interface ErrorFrame {
    type: 'error';
    id: string;
    stmt?: number;
    line?: number | null;
    ok: false;
    errorClass: string;
    message: string;
    file?: string;
    errorLine?: number;
    trace?: string;
    ms: number;
}

export interface ScopeFrame {
    type: 'scope';
    id: string;
    vars: Array<{ name: string; html: string }>;
}

export interface PongFrame {
    type: 'pong';
    id: string;
}

export interface FatalFrame {
    type: 'fatal';
    message: string;
}

export type WorkerFrame =
    | ReadyFrame
    | OutputFrame
    | DumpFrame
    | ValueFrame
    | StatementFrame
    | ResultFrame
    | ErrorFrame
    | ScopeFrame
    | PongFrame
    | FatalFrame;

export function isWorkerFrame(value: unknown): value is WorkerFrame {
    return (
        typeof value === 'object' &&
        value !== null &&
        typeof (value as { type?: unknown }).type === 'string'
    );
}

export function encodeRequest(request: WorkerRequest): string {
    return JSON.stringify(request) + '\n';
}

/**
 * Decodes newline-delimited JSON frames from arbitrary chunks.
 * Tolerates CRLF line endings so Windows and WSL transports work unchanged.
 */
export class LineDecoder {
    private buffer = '';

    push(chunk: string): string[] {
        this.buffer += chunk;
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() ?? '';

        return lines.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
    }

    reset(): void {
        this.buffer = '';
    }
}
