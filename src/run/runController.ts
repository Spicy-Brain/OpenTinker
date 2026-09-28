import { randomUUID } from 'node:crypto';
import { TinkerSession, type SessionStatus } from '../session/session';
import type { Transport } from '../session/transport';
import {
    isRunFrame,
    type ExecutionMode,
    type ReadyFrame,
    type ResultFrame,
    type RunFrame,
    type ScopeFrame,
    type WorkerFrame,
} from '../shared/protocol';
import type { RunRecord } from '../state/runStore';
import { isProduction, targetDetail, type Target } from '../targets/target';
import { compareRuns, type StatementChange } from './compare';
import { Emitter } from './emitter';
import { productionPrompt, type ConfirmPolicy } from './guard';

export type RunState = 'idle' | 'starting' | 'running' | 'stopping';

export interface RunRequest {
    code: string;
    mode: ExecutionMode;
    label: string;
    /** Document URI the code came from, or '' for snippets and the clipboard. */
    key: string;
    /** First line of the code within its document. */
    sourceLine: number;
    /** Imports to apply first (history re-runs). */
    imports?: string[];
    /** Whole document text, to apply its imports to a partial run. */
    contextSource?: string;
    /** Run on this target instead of the file's or active target. */
    target?: Target;
}

export interface RunSettings {
    sessionMode: 'fresh' | 'keep';
    rollback: boolean;
    timeoutMs: number;
    maxOutputBytes: number;
    confirmPolicy: ConfirmPolicy;
}

export interface RunHost {
    workspacePath: string;
    settings(): RunSettings;
    createTransport(target: Target): Promise<Transport>;
    /** Throws if an imported target's source changed since it was saved. */
    validateTarget(target: Target): Promise<void>;
    /** Asks before running on production; resolves false to cancel. */
    confirmProduction(target: Target, environment: string, writes: string[]): Promise<boolean>;
    targetFor(key: string): Target | undefined;
    previousSignatures(key: string): Record<string, string> | undefined;
    log(line: string): void;
}

export interface ActiveRun {
    record: RunRecord;
    target: Target;
    frames: RunFrame[];
    outputBytes: number;
    truncated: boolean;
}

export interface FinishedRun {
    record: RunRecord;
    result: ResultFrame;
    frames: RunFrame[];
    changes: Record<number, StatementChange>;
    scope?: ScopeFrame;
}

export class NoTargetError extends Error {
    constructor() {
        super('Choose where OpenTinker should run code.');
    }
}

const MAX_STORED_FRAMES = 2000;
const STOP_GRACE_MS = 3000;

/**
 * Owns the run lifecycle: one run at a time, sessions per target, stop and
 * timeout handling, production guard and run comparison. UI subscribes to
 * its events and never touches sessions directly.
 */
export class RunController {
    private stateValue: RunState = 'idle';
    private active?: ActiveRun;
    private activeSession?: TinkerSession;
    private startingSession?: TinkerSession;
    private runTimer?: NodeJS.Timeout;
    private stopTimer?: NodeJS.Timeout;
    private readonly sessions = new Map<string, TinkerSession>();
    private readonly readyInfo = new Map<string, ReadyFrame>();

    readonly onDidChangeState = new Emitter<RunState>();
    readonly onDidStartRun = new Emitter<ActiveRun>();
    readonly onDidReceiveFrame = new Emitter<{ run: ActiveRun; frame: RunFrame }>();
    readonly onDidFinishRun = new Emitter<FinishedRun>();
    readonly onDidReceiveScope = new Emitter<{ target: Target; scope: ScopeFrame }>();
    readonly onDidChangeSession = new Emitter<{
        target: Target;
        status: SessionStatus;
        ready?: ReadyFrame;
        detail?: string;
    }>();

    constructor(private readonly host: RunHost) {}

    get state(): RunState {
        return this.stateValue;
    }

    get current(): ActiveRun | undefined {
        return this.active;
    }

    /** What the worker reported when it last started for this target. */
    info(target: Target | undefined): ReadyFrame | undefined {
        return target ? this.readyInfo.get(target.id) : undefined;
    }

    /** The environment to trust: the app's own APP_ENV once known, else the declared one. */
    environment(target: Target): string {
        return this.readyInfo.get(target.id)?.env ?? target.environment;
    }

    async run(request: RunRequest): Promise<FinishedRun | undefined> {
        if (this.stateValue !== 'idle') {
            throw new Error('A run is already in progress. Stop it first.');
        }

        const target = request.target ?? this.host.targetFor(request.key);
        if (!target) throw new NoTargetError();

        const settings = this.host.settings();
        this.setState('starting');

        let session: TinkerSession;
        try {
            await this.host.validateTarget(target);
            session = await this.session(target);
            this.startingSession = session;
            await session.ensureStarted();

            const environment = this.environment(target);
            if (isProduction(environment) || isProduction(target.environment)) {
                const prompt = productionPrompt(request.code, settings.confirmPolicy);
                if (
                    prompt &&
                    !(await this.host.confirmProduction(target, environment, prompt.writes))
                ) {
                    this.setState('idle');
                    return undefined;
                }
            }

            // Without pcntl the worker cannot fork, so a fresh run needs a fresh process.
            if (settings.sessionMode === 'fresh' && !session.capabilities.fork) {
                await session.restart();
            }
        } catch (error) {
            this.setState('idle');
            throw error;
        } finally {
            this.startingSession = undefined;
        }

        const imports = request.contextSource
            ? ((
                  await session
                      .imports(request.contextSource, request.sourceLine)
                      .catch(() => undefined)
              )?.statements ?? [])
            : (request.imports ?? []);

        const record: RunRecord = {
            id: randomUUID(),
            key: request.key,
            label: request.label,
            code: request.code,
            imports,
            mode: request.mode,
            sourceLine: request.sourceLine,
            target: targetDetail(target, this.host.workspacePath),
            targetId: target.id,
            environment: this.environment(target),
            sessionMode: settings.sessionMode,
            rollback: settings.rollback,
            at: Date.now(),
            ms: 0,
            ok: false,
            statements: 0,
        };

        const active: ActiveRun = { record, target, frames: [], outputBytes: 0, truncated: false };
        this.active = active;
        this.activeSession = session;
        this.setState('running');
        this.onDidStartRun.fire(active);

        if (settings.timeoutMs > 0) {
            this.runTimer = setTimeout(() => {
                this.push({
                    type: 'output',
                    id: record.id,
                    text: `[OpenTinker] Stopped after ${Math.round(settings.timeoutMs / 1000)} s (opentinker.timeoutMs).\n`,
                });
                this.stop();
            }, settings.timeoutMs);
        }

        let result: ResultFrame;
        try {
            result = await session.exec({
                id: record.id,
                code: request.code,
                mode: request.mode,
                imports,
                fresh: settings.sessionMode === 'fresh',
                rollback: settings.rollback,
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.host.log(`run failed: ${message}`);
            // Stop may have changed the state while we awaited the run.
            const stopped = (this.stateValue as RunState) === 'stopping';
            if (!stopped) this.push({ type: 'fatal', message });
            result = {
                type: 'result',
                id: record.id,
                ok: false,
                failed: true,
                stopped,
                statements: active.frames.filter((frame) => frame.type === 'statement').length,
                ms: Date.now() - record.at,
                memory: 0,
            };
        }

        return this.finish(active, result);
    }

    /** Stops the current run. Fresh runs are cancelled; the worker stays warm. */
    stop(): void {
        if (this.stateValue === 'starting') {
            this.startingSession?.stop('Cancelled while starting');
            return;
        }
        const session = this.activeSession;
        const active = this.active;
        if (!session || !active || this.stateValue === 'stopping') return;
        this.setState('stopping');

        if (session.capabilities.fork) {
            session.cancel(active.record.id);
            this.stopTimer = setTimeout(() => session.stop('Run stopped'), STOP_GRACE_MS);
        } else {
            session.stop('Run stopped');
        }
    }

    /** Clears the kept session. Instant when the worker can fork; otherwise restarts it. */
    async restartSession(target: Target | undefined): Promise<void> {
        if (this.stateValue !== 'idle') throw new Error('Stop the current run first.');
        const session = target && this.sessions.get(target.id);
        if (!session) return;
        if (session.isReady && session.capabilities.fork) {
            if (await session.resetKeptSession()) return;
        }
        await session.restart();
    }

    /** The kept session's variables (keep mode). Fresh runs report theirs with each result. */
    async scope(target: Target): Promise<ScopeFrame | undefined> {
        const session = this.sessions.get(target.id);
        if (!session?.isReady || this.stateValue !== 'idle') return undefined;
        return session.scope();
    }

    /** A started session for non-run requests (log tail, model hints, runtime test). */
    async sessionFor(target: Target): Promise<TinkerSession> {
        await this.host.validateTarget(target);
        const session = await this.session(target);
        await session.ensureStarted();
        return session;
    }

    /** Drops a target's worker after its settings change. */
    invalidate(targetId: string): void {
        const session = this.sessions.get(targetId);
        if (!session) return;
        if (this.activeSession === session && this.stateValue !== 'idle') return;
        session.dispose();
        this.sessions.delete(targetId);
        this.readyInfo.delete(targetId);
    }

    invalidateAll(): void {
        for (const id of [...this.sessions.keys()]) this.invalidate(id);
    }

    dispose(): void {
        clearTimeout(this.runTimer);
        clearTimeout(this.stopTimer);
        for (const session of this.sessions.values()) session.dispose();
        this.sessions.clear();
    }

    private async session(target: Target): Promise<TinkerSession> {
        const existing = this.sessions.get(target.id);
        if (existing) return existing;

        const transport = await this.host.createTransport(target);
        this.host.log(`transport: ${transport.label}`);
        const session = new TinkerSession(transport, {
            onFrame: (frame) => this.handleFrame(target, session, frame),
            onStatus: (status, detail) => {
                if (status !== 'ready') this.readyInfo.delete(target.id);
                this.onDidChangeSession.fire({
                    target,
                    status,
                    ready: this.readyInfo.get(target.id),
                    detail,
                });
            },
        });
        this.sessions.set(target.id, session);
        return session;
    }

    private handleFrame(target: Target, session: TinkerSession, frame: WorkerFrame): void {
        if (frame.type === 'ready') {
            this.readyInfo.set(target.id, frame);
            this.host.log(
                `ready: PHP ${frame.php}, ${frame.laravel ? `Laravel ${frame.laravel}` : frame.framework}, PsySH ${frame.psysh}, env ${frame.env}, fork ${frame.capabilities?.fork ? 'yes' : 'no'}`,
            );
            return;
        }

        if (frame.type === 'fatal') this.host.log(`fatal: ${frame.message}`);

        const active = this.active;
        const belongs =
            active &&
            this.activeSession === session &&
            (('id' in frame && frame.id === active.record.id) ||
                (frame.type === 'output' && !frame.id) ||
                frame.type === 'fatal');
        if (!active || !belongs) return;

        if (frame.type === 'scope') {
            this.onDidReceiveScope.fire({ target, scope: frame });
            return;
        }

        if (isRunFrame(frame) && frame.type !== 'result') this.push(frame);
    }

    private push(frame: RunFrame): void {
        const active = this.active;
        if (!active) return;

        const isOutput = ['output', 'dump', 'value', 'inline'].includes(frame.type);
        if (isOutput) {
            const limit = Math.max(1024, this.host.settings().maxOutputBytes);
            const size = Buffer.byteLength(JSON.stringify(frame));
            if (active.outputBytes + size > limit) {
                if (!active.truncated) {
                    active.truncated = true;
                    this.push({
                        type: 'output',
                        id: active.record.id,
                        text: `[OpenTinker] Output truncated at ${limit} bytes (opentinker.maxOutputBytes).\n`,
                    });
                }
                return;
            }
            active.outputBytes += size;
        }

        if (
            active.frames.length < MAX_STORED_FRAMES ||
            frame.type === 'result' ||
            frame.type === 'fatal'
        ) {
            active.frames.push(frame);
        }
        this.onDidReceiveFrame.fire({ run: active, frame });
    }

    private finish(active: ActiveRun, result: ResultFrame): FinishedRun {
        clearTimeout(this.runTimer);
        clearTimeout(this.stopTimer);

        if (!active.frames.includes(result)) active.frames.push(result);

        const record = active.record;
        record.ms = result.ms;
        record.ok = result.ok;
        record.statements = result.statements ?? 0;
        record.rolledBack = result.rolledBack ?? null;
        record.ended = result.stopped ? 'stopped' : (result.ended ?? null);

        const previous = record.key ? this.host.previousSignatures(record.key) : undefined;
        const { signatures, changes } = compareRuns(active.frames, record.code, previous);
        record.signatures = signatures;

        this.active = undefined;
        this.activeSession = undefined;
        this.setState('idle');

        const finished: FinishedRun = { record, result, frames: active.frames, changes };
        this.onDidFinishRun.fire(finished);
        return finished;
    }

    private setState(state: RunState): void {
        if (this.stateValue === state) return;
        this.stateValue = state;
        this.onDidChangeState.fire(state);
    }
}
