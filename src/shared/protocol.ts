/**
 * Worker protocol, version 2. The PHP side lives in worker/src and must report
 * the same PROTOCOL_VERSION in its ready frame; test/protocol.test.ts checks
 * that the two stay in step.
 */
export const PROTOCOL_VERSION = 2;

export type ExecutionMode = 'statements' | 'file';

export interface ExecRequest {
    id: string;
    type: 'exec';
    code: string;
    mode: ExecutionMode;
    imports?: string[];
    /** Run in a fresh child process (true) or the kept session (false). */
    fresh: boolean;
    /** Wrap the run in a database transaction and roll it back. */
    rollback: boolean;
}

export type SimpleRequestType = 'ping' | 'log' | 'scope' | 'reset' | 'modelHints';

export type WorkerRequest =
    | ExecRequest
    | { id: string; type: 'imports'; source: string; line: number }
    | { id: string; type: 'cancel' }
    | { id: string; type: SimpleRequestType }
    | { type: 'shutdown' };

export interface Capabilities {
    fork: boolean;
    parser: boolean;
    database: boolean;
}

export interface ReadyFrame {
    type: 'ready';
    protocol?: number;
    php: string;
    framework?: 'laravel' | 'composer' | 'custom';
    laravel: string | null;
    psysh?: string;
    env: string;
    basePath: string;
    pid: number;
    capabilities?: Capabilities;
}

export interface OutputFrame {
    type: 'output';
    id?: string | null;
    text: string;
    stmt?: number;
    line?: number | null;
}

export interface TableValue {
    columns: string[];
    rows: string[][];
    truncated?: boolean;
}

export interface HtmlPreview {
    html: string;
    kind: 'html' | 'mailable' | 'response';
}

export interface ModelAttribute {
    name: string;
    value: string;
    type: string;
    cast: string | null;
    hidden: boolean;
    dirty: boolean;
}

export interface ModelCard {
    class: string;
    key: string | null;
    keyName: string;
    table: string;
    exists: boolean;
    recentlyCreated: boolean;
    attributes: ModelAttribute[];
    relations: Array<{ name: string; summary: string }>;
    dirty: string[];
}

export interface CopyFormats {
    json?: string;
    php?: string;
}

/** Structured views attached to dump and value frames. All optional. */
export interface ValueViews {
    table?: TableValue;
    preview?: HtmlPreview;
    model?: ModelCard;
    copy?: CopyFormats;
}

export interface DumpFrame extends ValueViews {
    type: 'dump';
    id?: string | null;
    html: string;
    short?: string;
    stmt?: number;
    line?: number | null;
}

export interface ValueFrame extends ValueViews {
    type: 'value';
    id: string;
    html: string;
    short?: string;
    stmt?: number;
    line?: number | null;
}

export interface InlineFrame {
    type: 'inline';
    id: string;
    stmt: number;
    line: number;
    text: string;
    html: string;
}

export interface QueryRecord {
    sql: string;
    bindings: string[];
    time: number | null;
}

export interface SqlSummary {
    total: number;
    time: number;
    repeated: Array<{ sql: string; count: number }>;
}

export interface StatementFrame {
    type: 'statement';
    id: string;
    stmt: number;
    line: number;
    endLine?: number;
    ok: boolean;
    ms: number;
    memory: number;
    exit?: string;
    import?: boolean;
    short?: string;
    queries?: QueryRecord[];
    sql?: SqlSummary;
}

export interface ResultFrame {
    type: 'result';
    id: string;
    ok: boolean;
    failed?: boolean;
    stopped?: boolean;
    statements?: number;
    ms: number;
    memory: number;
    rolledBack?: boolean | null;
    ended?: 'exit' | 'dd' | null;
    sessionReset?: boolean;
}

export interface TraceFrame {
    file: string | null;
    line: number | null;
    call: string;
    kind: 'scratch' | 'app' | 'vendor' | 'internal';
}

export interface ErrorFrame {
    type: 'error';
    id: string;
    stmt?: number;
    line?: number | null;
    ok: false;
    errorClass: string;
    message: string;
    scratchLine?: number;
    file?: string | null;
    errorLine?: number;
    frames?: TraceFrame[];
    /** Legacy workers sent a plain trace string. */
    trace?: string;
    ms: number;
}

export interface ScopeVariable {
    name: string;
    type?: string;
    short?: string;
    html: string;
}

export interface ScopeFrame {
    type: 'scope';
    id: string;
    vars: ScopeVariable[];
    truncated?: boolean;
}

export interface ImportsFrame {
    type: 'imports';
    id: string;
    statements: string[];
}

export interface PongFrame extends Omit<ReadyFrame, 'type'> {
    type: 'pong';
    id: string;
}

export interface LogFrame {
    type: 'log';
    id: string;
    path: string;
    lines: string;
}

export interface ResetFrame {
    type: 'reset';
    id: string;
    ok: boolean;
}

export interface ModelHintsFrame {
    type: 'modelHints';
    id: string;
    php: string;
    count: number;
    skipped: string[];
}

export interface UnsupportedFrame {
    type: 'unsupported';
    id: string;
    request: string;
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
    | InlineFrame
    | StatementFrame
    | ResultFrame
    | ErrorFrame
    | ScopeFrame
    | ImportsFrame
    | PongFrame
    | LogFrame
    | ResetFrame
    | ModelHintsFrame
    | UnsupportedFrame
    | FatalFrame;

/** Frames that belong to a run and are shown in the results panel. */
export type RunFrame =
    | OutputFrame
    | DumpFrame
    | ValueFrame
    | InlineFrame
    | StatementFrame
    | ResultFrame
    | ErrorFrame
    | FatalFrame;

const RUN_FRAME_TYPES = new Set([
    'output',
    'dump',
    'value',
    'inline',
    'statement',
    'result',
    'error',
    'fatal',
]);

export function isRunFrame(frame: WorkerFrame): frame is RunFrame {
    return RUN_FRAME_TYPES.has(frame.type);
}

/** Response frames that settle a pending request with the same id. */
export const RESPONSE_TYPES = new Set([
    'result',
    'pong',
    'log',
    'scope',
    'imports',
    'reset',
    'modelHints',
    'unsupported',
]);

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

/** Removes ANSI colour codes from stray process output. */
export function stripAnsi(text: string): string {
    // eslint-disable-next-line no-control-regex
    return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
}
