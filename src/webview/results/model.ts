import type { PanelContext, RunView, StatementChange } from '../../shared/panelMessages';
import type {
    DumpFrame,
    ErrorFrame,
    FatalFrame,
    QueryRecord,
    ResultFrame,
    RunFrame,
    SqlSummary,
    ValueFrame,
} from '../../shared/protocol';

export type CardItem =
    | { kind: 'output'; text: string }
    | { kind: 'value'; frame: DumpFrame | ValueFrame }
    | { kind: 'inline'; text: string }
    | { kind: 'error'; frame: ErrorFrame | FatalFrame };

export interface Card {
    stmt: number;
    /** Line within the executed code (1-based). */
    line: number;
    endLine: number;
    items: CardItem[];
    status: 'running' | 'ok' | 'failed' | 'ended';
    ms?: number;
    exit?: string;
    import: boolean;
    short?: string;
    queries: QueryRecord[];
    sql?: SqlSummary;
    change?: StatementChange;
}

export interface RunModel {
    run: RunView | null;
    cards: Map<number, Card>;
    result: ResultFrame | null;
    running: boolean;
    stored: boolean;
}

export function emptyRun(): RunModel {
    return { run: null, cards: new Map(), result: null, running: false, stored: false };
}

export function beginRun(run: RunView): RunModel {
    return { run, cards: new Map(), result: null, running: true, stored: false };
}

export function cardFor(
    model: RunModel,
    stmt: number | undefined,
    line: number | null | undefined,
): Card {
    const key = Math.max(0, stmt ?? 0);
    let card = model.cards.get(key);
    if (!card) {
        card = {
            stmt: key,
            line: line ?? 1,
            endLine: line ?? 1,
            items: [],
            status: 'running',
            import: false,
            queries: [],
        };
        model.cards.set(key, card);
    }
    return card;
}

/** Applies one frame. Returns the card it changed, if any. */
export function applyFrame(model: RunModel, frame: RunFrame): Card | undefined {
    switch (frame.type) {
        case 'result':
            model.result = frame;
            model.running = false;
            for (const card of model.cards.values()) {
                if (card.status === 'running') card.status = frame.ok ? 'ok' : 'failed';
            }
            return undefined;
        case 'output': {
            if (!frame.text.trim()) return undefined;
            const card = cardFor(model, frame.stmt, frame.line);
            const last = card.items.at(-1);
            // Echo output arrives in fragments; keep it together.
            if (last?.kind === 'output') last.text += frame.text;
            else card.items.push({ kind: 'output', text: frame.text });
            return card;
        }
        case 'dump':
        case 'value': {
            const card = cardFor(model, frame.stmt, frame.line);
            card.items.push({ kind: 'value', frame });
            return card;
        }
        case 'inline': {
            const card = cardFor(model, frame.stmt, frame.line);
            card.items.push({ kind: 'inline', text: frame.text });
            return card;
        }
        case 'error':
        case 'fatal': {
            const stmt = frame.type === 'error' ? frame.stmt : undefined;
            const line = frame.type === 'error' ? frame.line : undefined;
            const card = cardFor(model, stmt, line);
            card.items.push({ kind: 'error', frame });
            card.status = 'failed';
            return card;
        }
        case 'statement': {
            const card = cardFor(model, frame.stmt, frame.line);
            card.line = frame.line;
            card.endLine = frame.endLine ?? frame.line;
            card.ms = frame.ms;
            card.exit = frame.exit;
            card.import = frame.import === true;
            card.short = frame.short;
            card.queries = frame.queries ?? [];
            card.sql = frame.sql;
            card.status = frame.ok ? (frame.exit ? 'ended' : 'ok') : 'failed';
            return card;
        }
    }
}

/** Import statements that ran cleanly are noise; hide them like Tinkerwell does. */
export function isHidden(card: Card): boolean {
    return card.import && card.status === 'ok' && card.items.length === 0;
}

export function orderedCards(model: RunModel): Card[] {
    return [...model.cards.values()].sort((a, b) => a.stmt - b.stmt);
}

export function queryCount(model: RunModel): number {
    let total = 0;
    for (const card of model.cards.values()) total += card.sql?.total ?? card.queries.length;
    return total;
}

export function sourceLine(run: RunView | null, line: number): number {
    return Math.max(1, (run?.sourceLine ?? 1) + line - 1);
}

export function excerpt(run: RunView | null, line: number, endLine = line): string {
    const lines = (run?.code ?? '').split('\n');
    const first = (lines[line - 1] ?? '').trim();
    return endLine > line ? `${first} …` : first;
}

export function summaryText(model: RunModel): string {
    const result = model.result;
    if (!result) return '';
    const parts: string[] = [];
    parts.push(
        result.stopped
            ? 'Stopped'
            : result.ended === 'dd'
              ? 'Ended by dd()'
              : result.ended === 'exit'
                ? 'Ended by exit()'
                : result.ok
                  ? 'Completed'
                  : 'Failed',
    );
    const statements = orderedCards(model).filter((card) => !isHidden(card)).length;
    parts.push(`${statements} ${statements === 1 ? 'statement' : 'statements'}`);
    const queries = queryCount(model);
    if (queries) parts.push(`${queries} ${queries === 1 ? 'query' : 'queries'}`);
    if (result.ms) parts.push(formatMs(result.ms));
    if (result.memory) parts.push(`${(result.memory / 1048576).toFixed(1)} MB`);
    if (result.rolledBack === true) parts.push('database changes rolled back');
    if (result.rolledBack === false) parts.push('rollback failed');
    if (result.sessionReset) parts.push('kept session reset');
    return parts.join(' · ');
}

export function formatMs(ms: number): string {
    if (ms < 1) return '<1 ms';
    if (ms < 1000) return `${ms.toFixed(ms < 10 ? 1 : 0)} ms`;
    return `${(ms / 1000).toFixed(2)} s`;
}

export function environmentClass(
    environment: string,
): 'production' | 'staging' | 'local' | 'unknown' {
    const lower = environment.toLowerCase();
    if (['prod', 'production', 'live'].includes(lower)) return 'production';
    if (['staging', 'stage', 'uat'].includes(lower)) return 'staging';
    if (['local', 'dev', 'development', 'testing'].includes(lower)) return 'local';
    return 'unknown';
}

export function emptyContext(): PanelContext {
    return {
        targetName: 'No target',
        targetDetail: '',
        environment: 'unknown',
        sessionMode: 'fresh',
        rollback: false,
        state: 'idle',
        fork: true,
        hasTarget: false,
        scratchName: '',
    };
}

/** Tables as CSV, guarding against spreadsheet formula injection. */
export function toCsv(columns: string[], rows: string[][]): string {
    const quote = (value: string): string => {
        const safe = value && '=+-@\t\r'.includes(value.charAt(0)) ? `'${value}` : value;
        return `"${safe.replaceAll('"', '""')}"`;
    };
    return [columns, ...rows]
        .map((row) => row.map((cell) => quote(cell ?? '')).join(','))
        .join('\r\n');
}

export function toMarkdown(columns: string[], rows: string[][]): string {
    const escape = (value: string): string =>
        (value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
    return [
        `| ${columns.map(escape).join(' | ')} |`,
        `| ${columns.map(() => '---').join(' | ')} |`,
        ...rows.map((row) => `| ${row.map(escape).join(' | ')} |`),
    ].join('\n');
}
