import { describe, expect, it } from 'vitest';
import {
    NoTargetError,
    RunController,
    type RunHost,
    type RunSettings,
} from '../src/run/runController';
import type { Target } from '../src/targets/target';
import { fakeTransport, type FakeOptions } from './support/fakeWorker';

const target: Target = {
    id: 't1',
    kind: 'compose',
    name: 'app',
    service: 'app',
    workingDir: '/var/www',
    environment: 'local',
};

function setup(
    options: FakeOptions & {
        settings?: Partial<RunSettings>;
        confirm?: boolean;
        target?: Target | null;
    } = {},
) {
    const fake = fakeTransport(options);
    const prompts: string[][] = [];
    const signatures = new Map<string, Record<string, string>>();
    const host: RunHost = {
        workspacePath: '/ws',
        settings: () => ({
            sessionMode: 'fresh',
            rollback: false,
            timeoutMs: 0,
            maxOutputBytes: 1_000_000,
            confirmPolicy: 'writes',
            ...options.settings,
        }),
        createTransport: async () => fake.transport,
        validateTarget: async () => undefined,
        confirmProduction: async (_target, _env, writes) => {
            prompts.push(writes);
            return options.confirm ?? true;
        },
        targetFor: () => (options.target === null ? undefined : (options.target ?? target)),
        previousSignatures: (key) => signatures.get(key),
        log: () => undefined,
    };
    const controller = new RunController(host);
    controller.onDidFinishRun.event((run) =>
        signatures.set(run.record.key, run.record.signatures ?? {}),
    );
    return { controller, fake, prompts };
}

const request = (code: string) => ({
    code,
    mode: 'statements' as const,
    label: 'scratch.php',
    key: 'file:///ws/.tinker/scratch.php',
    sourceLine: 1,
});

describe('RunController', () => {
    it('runs code and moves through its states', async () => {
        const { controller } = setup();
        const states: string[] = [];
        const frames: string[] = [];
        controller.onDidChangeState.event((state) => states.push(state));
        controller.onDidReceiveFrame.event(({ frame }) => frames.push(frame.type));
        const finished = await controller.run(request('1;'));
        expect(finished?.result.ok).toBe(true);
        expect(finished?.record.sessionMode).toBe('fresh');
        expect(states).toEqual(['starting', 'running', 'idle']);
        expect(frames).toEqual(['value', 'statement']);
        controller.dispose();
    });

    it('reports the variables each run leaves', async () => {
        const { controller } = setup();
        const scopes: string[] = [];
        controller.onDidReceiveScope.event(({ scope }) =>
            scopes.push(scope.vars.map((item) => item.name).join()),
        );
        await controller.run(request('1;'));
        expect(scopes).toEqual(['x']);
        controller.dispose();
    });

    it('marks statements that changed since the last run', async () => {
        const { controller } = setup();
        await controller.run(request('1;'));
        const same = await controller.run(request('1;'));
        expect(same?.changes[1]).toBe('same');
        controller.dispose();
    });

    it('asks before running writes on production and cancels on no', async () => {
        const { controller, prompts, fake } = setup({ env: 'production', confirm: false });
        const result = await controller.run(request('User::first()->delete();'));
        expect(result).toBeUndefined();
        expect(prompts[0]).toContain('delete records');
        expect(fake.workers[0]?.requests.some((item) => item.type === 'exec')).toBe(false);
        expect(controller.state).toBe('idle');
        controller.dispose();
    });

    it('does not ask for read-only code on production', async () => {
        const { controller, prompts } = setup({ env: 'production' });
        expect((await controller.run(request('User::count();')))?.result.ok).toBe(true);
        expect(prompts).toHaveLength(0);
        controller.dispose();
    });

    it('stops a fresh run by cancelling it, keeping the worker warm', async () => {
        const { controller, fake } = setup({ hang: (code) => code.includes('sleep') });
        const running = controller.run(request('sleep(9);'));
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(controller.state).toBe('running');
        controller.stop();
        const finished = await running;
        expect(finished?.result.stopped).toBe(true);
        expect(finished?.record.ended).toBe('stopped');
        expect(fake.workers).toHaveLength(1);
        controller.dispose();
    });

    it('restarts PHP before each fresh run when the runtime cannot fork', async () => {
        const { controller, fake } = setup({ fork: false });
        await controller.run(request('1;'));
        await controller.run(request('2;'));
        expect(fake.workers.length).toBeGreaterThanOrEqual(2);
        controller.dispose();
    });

    it('sends the rollback flag and records the outcome', async () => {
        const { controller } = setup({ settings: { rollback: true } });
        const finished = await controller.run(request('1;'));
        expect(finished?.record.rolledBack).toBe(true);
        controller.dispose();
    });

    it('needs a target', async () => {
        const { controller } = setup({ target: null });
        await expect(controller.run(request('1;'))).rejects.toBeInstanceOf(NoTargetError);
        controller.dispose();
    });

    it('refuses a second run while one is active', async () => {
        const { controller } = setup({ hang: () => true });
        const first = controller.run(request('1;'));
        await new Promise((resolve) => setTimeout(resolve, 20));
        await expect(controller.run(request('2;'))).rejects.toThrow('already in progress');
        controller.stop();
        await first;
        controller.dispose();
    });
});
