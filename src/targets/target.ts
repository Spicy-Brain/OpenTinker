import { isSshEndpoint, type SshEndpoint } from '../ssh/types';

export type Environment = 'local' | 'staging' | 'production' | 'unknown';

interface TargetBase {
    id: string;
    name: string;
    /** Declared environment; the worker's reported APP_ENV takes precedence once connected. */
    environment: Environment;
    /** Where the project lives inside the runtime (container or remote path). */
    workingDir: string;
    phpBinary?: string;
    /** 'auto', 'laravel', 'composer' or a bootstrap file path. */
    bootstrap?: string;
}

export interface LocalTarget extends TargetBase {
    kind: 'local';
}

export interface ComposeTarget extends TargetBase {
    kind: 'compose';
    service: string;
}

export interface DockerTarget extends TargetBase {
    kind: 'docker';
    container: string;
}

export interface SshTargetProfile extends TargetBase {
    kind: 'ssh';
    host: string;
    user: string;
    port: number;
    /** Private key path; omit to use the SSH agent or ~/.ssh/config. */
    identityFile?: string;
    /** Set when imported from OpenVSDB; the source is re-validated before each run. */
    source?: SshEndpoint;
}

export type Target = LocalTarget | ComposeTarget | DockerTarget | SshTargetProfile;
export type TargetKind = Target['kind'];

const ENVIRONMENTS: Environment[] = ['local', 'staging', 'production', 'unknown'];

export function normalizeEnvironment(value: string | undefined): Environment {
    const lower = (value ?? '').toLowerCase();
    if (lower === 'prod' || lower === 'production' || lower === 'live') return 'production';
    if (lower === 'staging' || lower === 'stage' || lower === 'uat') return 'staging';
    if (lower === 'local' || lower === 'dev' || lower === 'development' || lower === 'testing')
        return 'local';
    return 'unknown';
}

export function isProduction(environment: string | undefined): boolean {
    return normalizeEnvironment(environment) === 'production';
}

export function isTarget(value: unknown): value is Target {
    if (typeof value !== 'object' || value === null) return false;
    const item = value as Record<string, unknown>;
    if (typeof item.id !== 'string' || item.id === '') return false;
    if (typeof item.name !== 'string' || item.name.trim() === '') return false;
    if (!ENVIRONMENTS.includes(item.environment as Environment)) return false;
    if (typeof item.workingDir !== 'string') return false;
    if (item.phpBinary !== undefined && typeof item.phpBinary !== 'string') return false;
    if (item.bootstrap !== undefined && typeof item.bootstrap !== 'string') return false;

    switch (item.kind) {
        case 'local':
            return true;
        case 'compose':
            return typeof item.service === 'string' && item.service !== '';
        case 'docker':
            return typeof item.container === 'string' && item.container !== '';
        case 'ssh':
            return (
                typeof item.host === 'string' &&
                item.host.trim() !== '' &&
                typeof item.user === 'string' &&
                item.user.trim() !== '' &&
                Number.isInteger(item.port) &&
                (item.port as number) >= 1 &&
                (item.port as number) <= 65535 &&
                item.workingDir.startsWith('/') &&
                (item.identityFile === undefined || typeof item.identityFile === 'string') &&
                (item.source === undefined || isSshEndpoint(item.source))
            );
        default:
            return false;
    }
}

/** A short "where does this run" description, e.g. "docker compose · app". */
export function targetSummary(target: Target): string {
    switch (target.kind) {
        case 'local':
            return `local ${target.phpBinary ?? 'php'}`;
        case 'compose':
            return `compose · ${target.service}`;
        case 'docker':
            return `docker · ${target.container}`;
        case 'ssh':
            return `ssh · ${target.user}@${target.host}${target.port === 22 ? '' : ':' + target.port}`;
    }
}

export function targetDetail(target: Target, workspacePath: string): string {
    const where = target.kind === 'local' ? workspacePath : target.workingDir;
    return `${targetSummary(target)} · ${where}`;
}

export function validateTarget(target: Target): string | undefined {
    if (!target.name.trim()) return 'Give the target a name.';
    if (target.kind !== 'local' && !target.workingDir.startsWith('/'))
        return 'The project path must be absolute, for example /var/www.';
    if (target.kind === 'compose' && !target.service.trim()) return 'Choose a Compose service.';
    if (target.kind === 'docker' && !target.container.trim()) return 'Enter a container name.';
    if (target.kind === 'ssh') {
        if (!target.host.trim()) return 'Enter the SSH host.';
        if (!target.user.trim()) return 'Enter the SSH user.';
        if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535)
            return 'Enter a port from 1 to 65535.';
    }
    return undefined;
}

/** Maps a path reported by the runtime back to the local workspace, when possible. */
export function toLocalPath(
    target: Target,
    runtimePath: string,
    workspacePath: string,
): string | undefined {
    if (target.kind === 'local') return runtimePath;
    const base = target.workingDir.replace(/\/+$/, '');
    if (runtimePath === base) return workspacePath;
    if (runtimePath.startsWith(base + '/')) {
        return workspacePath + runtimePath.slice(base.length);
    }
    return undefined;
}
