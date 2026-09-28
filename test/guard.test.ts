import { describe, expect, it } from 'vitest';
import { compareRuns } from '../src/run/compare';
import { findWrites, productionPrompt } from '../src/run/guard';
import type { RunFrame } from '../src/shared/protocol';

describe('production guard', () => {
    it('finds data changes and side effects', () => {
        expect(findWrites('User::find(1)->update(["name" => "x"]);')).toContain('update records');
        expect(findWrites('$user->delete();')).toContain('delete records');
        expect(findWrites('Order::create([]);')).toContain('create records');
        expect(findWrites('Mail::to($u)->send(new Welcome);')).toContain(
            'send mail or notifications',
        );
        expect(findWrites("Artisan::call('cache:clear');")).toContain('run Artisan commands');
        expect(findWrites('dispatch(new SyncJob);')).toContain('dispatch jobs');
    });

    it('ignores reads, comments and strings', () => {
        expect(findWrites('User::where("status", "delete")->count();')).toEqual([]);
        expect(findWrites('// $user->delete();\nUser::first();')).toEqual([]);
        expect(findWrites('User::latest()->first();')).toEqual([]);
    });

    it('applies the confirm policy', () => {
        expect(productionPrompt('User::count();', 'writes')).toBeUndefined();
        expect(productionPrompt('User::count();', 'always')).toEqual({ writes: [] });
        expect(productionPrompt('$u->delete();', 'never')).toBeUndefined();
    });
});

describe('run comparison', () => {
    const frames = (value: string): RunFrame[] => [
        { type: 'value', id: 'r', stmt: 1, line: 1, html: '', short: 'same' },
        { type: 'statement', id: 'r', stmt: 1, line: 1, ok: true, ms: 1, memory: 0 },
        { type: 'value', id: 'r', stmt: 2, line: 2, html: '', short: value },
        { type: 'statement', id: 'r', stmt: 2, line: 2, ok: true, ms: 1, memory: 0 },
    ];
    const code = '$a = 1;\n$b = time();';

    it('marks changed and unchanged statements', () => {
        const first = compareRuns(frames('1'), code, undefined);
        const second = compareRuns(frames('2'), code, first.signatures);
        expect(second.changes).toEqual({ 1: 'same', 2: 'changed' });
    });

    it('matches statements by their text when lines move', () => {
        const first = compareRuns(frames('1'), code, undefined);
        const moved = compareRuns(
            frames('1').map((frame) =>
                'line' in frame && typeof frame.line === 'number'
                    ? { ...frame, line: frame.line + 1 }
                    : frame,
            ) as RunFrame[],
            '\n' + code,
            first.signatures,
        );
        expect(moved.changes).toEqual({ 1: 'same', 2: 'same' });
    });
});
