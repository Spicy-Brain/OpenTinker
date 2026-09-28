import { randomUUID } from 'node:crypto';
import type * as vscode from 'vscode';
import type { ExecutionMode, RunFrame } from '../shared/protocol';

export interface RunRecord {
    id: string;
    key: string;
    label: string;
    code: string;
    imports?: string[];
    mode: ExecutionMode;
    sourceLine: number;
    target: string;
    environment: string;
    at: number;
    ms: number;
    ok: boolean;
    statements: number;
    targetId?: string;
    sessionMode?: 'fresh' | 'keep';
    rollback?: boolean;
    rolledBack?: boolean | null;
    ended?: 'exit' | 'dd' | 'stopped' | null;
    /** Per-statement output fingerprints, used to mark what changed next run. */
    signatures?: Record<string, string>;
}

export interface StoredRun {
    record: RunRecord;
    frames: RunFrame[];
}

const HISTORY_KEY = 'opentinker.history.v2';
const RESULTS_KEY = 'opentinker.historyResults.v2';
const DEFAULT_LIMIT = 50;
const MAX_RESULT_BYTES = 512_000;
const MAX_TOTAL_RESULT_BYTES = 2_000_000;
const MAX_IN_MEMORY_RUNS = 15;

/** Workspace history is bounded. Result frames stay in memory unless explicitly enabled. */
export class RunStore {
    private readonly runs = new Map<string, RunFrame[]>();
    private recent: RunRecord[];

    constructor(
        private readonly memento: vscode.Memento,
        private readonly limit = DEFAULT_LIMIT,
        private readonly persistResults = false,
    ) {
        const saved = memento.get<unknown>(HISTORY_KEY);
        if (saved === undefined) {
            const legacy = memento.get<
                Array<Pick<RunRecord, 'key' | 'label' | 'at' | 'ms' | 'ok' | 'statements'>>
            >('opentinker.recentRuns', []);
            this.recent = legacy
                .filter((entry) => typeof entry.key === 'string' && typeof entry.label === 'string')
                .map((entry) => ({
                    ...entry,
                    id: randomUUID(),
                    code: '',
                    mode: 'statements' as const,
                    sourceLine: 1,
                    target: 'Unknown target',
                    environment: 'unknown',
                }))
                .slice(0, limit);
            if (this.recent.length) void memento.update(HISTORY_KEY, this.recent);
        } else {
            this.recent = Array.isArray(saved) ? saved.filter(isRunRecord).slice(0, limit) : [];
        }
        if (persistResults) {
            const saved = memento.get<Record<string, RunFrame[]>>(RESULTS_KEY, {});
            for (const record of this.recent) {
                const frames = saved[record.id];
                if (Array.isArray(frames)) this.runs.set(record.id, frames);
            }
        }
    }

    async add(record: RunRecord, frames: RunFrame[]): Promise<void> {
        this.recent = [record, ...this.recent.filter((entry) => entry.id !== record.id)].slice(
            0,
            this.limit,
        );
        this.runs.set(record.id, frames);
        const retain = new Set(this.recent.slice(0, MAX_IN_MEMORY_RUNS).map((entry) => entry.id));
        for (const id of this.runs.keys()) {
            if (!retain.has(id)) this.runs.delete(id);
        }
        await this.memento.update(HISTORY_KEY, this.recent);
        if (this.persistResults) {
            const saved: Record<string, RunFrame[]> = {};
            let totalBytes = 0;
            for (const entry of this.recent) {
                const candidate = this.runs.get(entry.id);
                const bytes = candidate ? Buffer.byteLength(JSON.stringify(candidate)) : 0;
                if (
                    candidate &&
                    bytes <= MAX_RESULT_BYTES &&
                    totalBytes + bytes <= MAX_TOTAL_RESULT_BYTES
                ) {
                    saved[entry.id] = candidate;
                    totalBytes += bytes;
                }
            }
            await this.memento.update(RESULTS_KEY, saved);
        }
    }

    get(id: string): StoredRun | undefined {
        const record = this.recent.find((entry) => entry.id === id);
        return record ? { record, frames: this.runs.get(id) ?? [] } : undefined;
    }

    latestForFile(key: string): StoredRun | undefined {
        const record = this.recent.find((entry) => entry.key === key);
        return record ? this.get(record.id) : undefined;
    }

    recentRuns(query = ''): RunRecord[] {
        const normalized = query.trim().toLowerCase();
        return normalized
            ? this.recent.filter((record) =>
                  [record.label, record.code, record.target, record.environment].some((part) =>
                      part.toLowerCase().includes(normalized),
                  ),
              )
            : [...this.recent];
    }

    async clear(): Promise<void> {
        this.recent = [];
        this.runs.clear();
        await this.memento.update(HISTORY_KEY, []);
        await this.memento.update(RESULTS_KEY, {});
    }
}

function isRunRecord(value: unknown): value is RunRecord {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Partial<RunRecord>;
    return (
        typeof candidate.id === 'string' &&
        typeof candidate.key === 'string' &&
        typeof candidate.label === 'string' &&
        typeof candidate.code === 'string' &&
        (candidate.mode === 'file' || candidate.mode === 'statements') &&
        typeof candidate.target === 'string' &&
        typeof candidate.environment === 'string' &&
        typeof candidate.at === 'number'
    );
}
