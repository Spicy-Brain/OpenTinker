import { describe, expect, it } from 'vitest';
import { TinkerSession, type SessionStatus } from '../src/session/session';
import { fakeTransport } from './support/fakeWorker';

const events = (statuses: SessionStatus[] = []) => ({
    onFrame: () => undefined,
    onStatus: (status: SessionStatus) => statuses.push(status),
});

describe('TinkerSession', () => {
    it('starts, answers requests and runs code', async () => {
        const { transport, workers } = fakeTransport();
        const statuses: SessionStatus[] = [];
        const session = new TinkerSession(transport, events(statuses));
        await session.ensureStarted();
        expect(session.readyInfo?.env).toBe('local');
        expect(session.capabilities.fork).toBe(true);
        expect((await session.readLog()).lines).toBe('hello');
        expect((await session.scope()).vars[0]?.name).toBe('user');
        expect((await session.imports('<?php use App\\Models\\User;', 2)).statements).toEqual([
            'use App\\Models\\User;',
        ]);
        const result = await session.exec({
            id: 'r1',
            code: '1;',
            mode: 'statements',
            fresh: true,
            rollback: true,
            imports: [],
        });
        expect(result.rolledBack).toBe(true);
        expect(workers[0]?.requests.at(-1)).toMatchObject({
            type: 'exec',
            fresh: true,
            rollback: true,
        });
        expect(statuses.at(-1)).toBe('ready');
        session.dispose();
    });

    it('refuses a worker that speaks another protocol version', async () => {
        const { transport } = fakeTransport({ protocol: 1 });
        const session = new TinkerSession(transport, events());
        await expect(session.ensureStarted()).rejects.toThrow('protocol 1');
        session.dispose();
    });

    it('cancels a run without restarting the worker', async () => {
        const { transport, workers } = fakeTransport({ hang: (code) => code.includes('sleep') });
        const session = new TinkerSession(transport, events());
        await session.ensureStarted();
        const pending = session.exec({
            id: 'r2',
            code: 'sleep(9);',
            mode: 'statements',
            fresh: true,
            rollback: false,
        });
        await new Promise((resolve) => setImmediate(resolve));
        session.cancel('r2');
        expect((await pending).stopped).toBe(true);
        expect(workers).toHaveLength(1);
        session.dispose();
    });

    it('rejects pending work on a hard stop and can start again', async () => {
        const { transport, workers } = fakeTransport({ hang: () => true });
        const session = new TinkerSession(transport, events());
        await session.ensureStarted();
        const pending = session.exec({
            id: 'r3',
            code: 'x',
            mode: 'statements',
            fresh: false,
            rollback: false,
        });
        await new Promise((resolve) => setImmediate(resolve));
        session.stop();
        await expect(pending).rejects.toThrow('Run stopped by user');
        await session.ensureStarted();
        expect(workers).toHaveLength(2);
        session.dispose();
    });

    it('resets the kept session through the worker', async () => {
        const { transport, workers } = fakeTransport();
        const session = new TinkerSession(transport, events());
        await session.ensureStarted();
        expect(await session.resetKeptSession()).toBe(true);
        expect(workers).toHaveLength(1);
        session.dispose();
    });
});
