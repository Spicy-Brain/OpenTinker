import { randomUUID } from 'node:crypto';
import type * as vscode from 'vscode';
import { isSshEndpoint, isSshTarget } from '../ssh/types';
import { isTarget, normalizeEnvironment, type Target } from './target';

const TARGETS_KEY = 'opentinker.targets.v1';
const ACTIVE_KEY = 'opentinker.activeTarget.v1';
const FILE_TARGETS_KEY = 'opentinker.fileTargets.v1';
const LEGACY_CONNECTION_KEY = 'opentinker.connection';

type Listener = () => void;

/**
 * Saved runtime targets for this workspace, which one is active, and which
 * scratch files remember their own target.
 */
export class TargetStore {
    private targets: Target[];
    private activeId: string | undefined;
    private fileTargets: Record<string, string>;
    private readonly listeners = new Set<Listener>();

    constructor(
        private readonly memento: vscode.Memento,
        legacyDefaults: { workingDir: string; phpBinary: string } = {
            workingDir: '/var/www',
            phpBinary: 'php',
        },
    ) {
        const saved = memento.get<unknown>(TARGETS_KEY);
        this.targets = Array.isArray(saved) ? saved.filter(isTarget) : [];
        this.activeId = memento.get<string>(ACTIVE_KEY);
        const files = memento.get<unknown>(FILE_TARGETS_KEY);
        this.fileTargets =
            files && typeof files === 'object' ? { ...(files as Record<string, string>) } : {};

        if (this.targets.length === 0) {
            const migrated = migrateLegacy(
                memento.get<unknown>(LEGACY_CONNECTION_KEY),
                legacyDefaults,
            );
            if (migrated) {
                this.targets = [migrated];
                this.activeId = migrated.id;
                void this.persist();
            }
        }
    }

    onDidChange(listener: Listener): { dispose(): void } {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    }

    all(): Target[] {
        return [...this.targets];
    }

    get(id: string | undefined): Target | undefined {
        return id ? this.targets.find((target) => target.id === id) : undefined;
    }

    active(): Target | undefined {
        return this.get(this.activeId) ?? this.targets[0];
    }

    /** The target a file runs on: its own remembered target, else the active one. */
    forFile(uri: string | undefined): Target | undefined {
        return (uri ? this.get(this.fileTargets[uri]) : undefined) ?? this.active();
    }

    fileOverride(uri: string): Target | undefined {
        return this.get(this.fileTargets[uri]);
    }

    async save(target: Target): Promise<Target> {
        const index = this.targets.findIndex((item) => item.id === target.id);
        if (index >= 0) this.targets[index] = target;
        else this.targets.push(target);
        await this.persist();
        return target;
    }

    async remove(id: string): Promise<void> {
        this.targets = this.targets.filter((target) => target.id !== id);
        if (this.activeId === id) this.activeId = this.targets[0]?.id;
        for (const [uri, target] of Object.entries(this.fileTargets)) {
            if (target === id) delete this.fileTargets[uri];
        }
        await this.persist();
    }

    async setActive(id: string): Promise<void> {
        this.activeId = id;
        await this.persist();
    }

    async setForFile(uri: string, id: string | undefined): Promise<void> {
        if (id) this.fileTargets[uri] = id;
        else delete this.fileTargets[uri];
        await this.persist();
    }

    private async persist(): Promise<void> {
        await this.memento.update(TARGETS_KEY, this.targets);
        await this.memento.update(ACTIVE_KEY, this.activeId);
        await this.memento.update(FILE_TARGETS_KEY, this.fileTargets);
        for (const listener of this.listeners) listener();
    }
}

export function newTargetId(): string {
    return randomUUID();
}

/** Converts the pre-0.3 single "connection" setting into a saved target. */
export function migrateLegacy(
    value: unknown,
    defaults: { workingDir: string; phpBinary: string },
): Target | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const legacy = value as Record<string, unknown>;
    const id = newTargetId();

    if (legacy.kind === 'local') {
        return {
            id,
            kind: 'local',
            name: 'Local PHP',
            environment: 'local',
            workingDir: '',
            phpBinary: defaults.phpBinary,
        };
    }
    if (legacy.kind === 'compose' && typeof legacy.service === 'string' && legacy.service) {
        return {
            id,
            kind: 'compose',
            name: legacy.service,
            service: legacy.service,
            environment: 'local',
            workingDir: defaults.workingDir,
        };
    }
    if (legacy.kind === 'docker' && typeof legacy.container === 'string' && legacy.container) {
        return {
            id,
            kind: 'docker',
            name: legacy.container,
            container: legacy.container,
            environment: 'local',
            workingDir: defaults.workingDir,
        };
    }
    if (legacy.kind === 'ssh' && isSshEndpoint(legacy.source) && isSshTarget(legacy.target)) {
        return {
            id,
            kind: 'ssh',
            name: legacy.source.name,
            host: legacy.target.host,
            user: legacy.target.user,
            port: legacy.target.port,
            workingDir: legacy.target.workingDir,
            environment: normalizeEnvironment(legacy.target.environment),
            source: legacy.source,
        };
    }
    return undefined;
}
