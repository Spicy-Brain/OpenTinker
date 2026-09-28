import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { RunStore, type RunRecord } from '../src/state/runStore';

function memoryState(): vscode.Memento {
    const values = new Map<string, unknown>();
    return {
        get: <T>(key: string, fallback?: T): T => (values.get(key) as T) ?? (fallback as T),
        update: async (key: string, value: unknown) => {
            values.set(key, value);
        },
        keys: () => [...values.keys()],
    };
}

function record(id: string, code: string): RunRecord {
    return {
        id,
        key: 'file:///app/scratch.php',
        label: 'scratch.php',
        code,
        mode: 'statements',
        sourceLine: 1,
        target: 'local PHP',
        environment: 'local',
        at: Date.now(),
        ms: 10,
        ok: true,
        statements: 1,
    };
}

describe('RunStore', () => {
    it('keeps separate runs of the same file and searches their code', async () => {
        const state = memoryState();
        const store = new RunStore(state);
        await store.add(record('first', 'User::count()'), []);
        await store.add(record('second', 'Order::count()'), []);
        expect(store.recentRuns().map((entry) => entry.id)).toEqual(['second', 'first']);
        expect(store.recentRuns('user').map((entry) => entry.id)).toEqual(['first']);
        expect(new RunStore(state).recentRuns()).toHaveLength(2);
    });

    it('only retains results across reloads when enabled', async () => {
        const state = memoryState();
        const frames = [{ type: 'output' as const, text: 'secret' }];
        const store = new RunStore(state);
        await store.add(record('first', '1'), frames);
        expect(new RunStore(state).get('first')?.frames).toEqual([]);
        const persistent = new RunStore(state, 50, true);
        await persistent.add(record('second', '2'), frames);
        expect(new RunStore(state, 50, true).get('second')?.frames).toEqual(frames);
    });

    it('preserves existing recent entries as metadata-only history', async () => {
        const state = memoryState();
        await state.update('opentinker.recentRuns', [
            {
                key: 'file:///app/old.php',
                label: 'old.php',
                at: 1,
                ms: 4,
                ok: true,
                statements: 1,
            },
        ]);
        const migrated = new RunStore(state).recentRuns();
        expect(migrated).toHaveLength(1);
        expect(migrated[0].code).toBe('');
        expect(migrated[0].label).toBe('old.php');
    });
});
