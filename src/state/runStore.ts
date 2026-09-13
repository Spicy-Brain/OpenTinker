import type * as vscode from 'vscode';
import type { WorkerFrame } from '../session/protocol';

export interface RunRecord {
    key: string;
    label: string;
    at: number;
    ms: number;
    ok: boolean;
    statements: number;
}

export interface StoredRun {
    record: RunRecord;
    frames: WorkerFrame[];
}

const RECENT_KEY = 'opentinker.recentRuns';

export class RunStore {
    private readonly runs = new Map<string, StoredRun>();
    private recent: RunRecord[];

    constructor(private readonly memento: vscode.Memento) {
        this.recent = memento.get<RunRecord[]>(RECENT_KEY, []);
    }

    set(key: string, frames: WorkerFrame[], record: RunRecord): void {
        this.runs.set(key, { record, frames });
        this.recent = [record, ...this.recent.filter((entry) => entry.key !== key)].slice(0, 15);
        void this.memento.update(RECENT_KEY, this.recent);
    }

    get(key: string): StoredRun | undefined {
        return this.runs.get(key);
    }

    recentRuns(): RunRecord[] {
        return this.recent;
    }
}
