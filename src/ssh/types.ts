export interface SshEndpoint {
    id: string;
    name: string;
    host: string;
    port: number;
    user: string;
    authMethod: 'password' | 'key' | 'agent';
    keyPath?: string;
    environment?: 'local' | 'staging' | 'prod';
}

export interface SshTarget {
    host: string;
    port: number;
    user: string;
    workingDir: string;
    environment: 'local' | 'staging' | 'prod';
}

export function isSshEndpoint(value: unknown): value is SshEndpoint {
    if (typeof value !== 'object' || value === null) {
        return false;
    }

    const item = value as Partial<Record<keyof SshEndpoint, unknown>>;
    return (
        typeof item.id === 'string' &&
        item.id.trim() !== '' &&
        typeof item.name === 'string' &&
        typeof item.host === 'string' &&
        item.host.trim() !== '' &&
        typeof item.user === 'string' &&
        item.user.trim() !== '' &&
        Number.isInteger(item.port) &&
        (item.port as number) >= 1 &&
        (item.port as number) <= 65535 &&
        (item.authMethod === 'password' ||
            item.authMethod === 'key' ||
            item.authMethod === 'agent') &&
        (item.keyPath === undefined || typeof item.keyPath === 'string') &&
        (item.authMethod !== 'key' ||
            (typeof item.keyPath === 'string' && item.keyPath.trim() !== '')) &&
        (item.environment === undefined ||
            item.environment === 'local' ||
            item.environment === 'staging' ||
            item.environment === 'prod')
    );
}

export function isSshTarget(value: unknown): value is SshTarget {
    if (typeof value !== 'object' || value === null) {
        return false;
    }

    const item = value as Partial<Record<keyof SshTarget, unknown>>;
    return (
        typeof item.host === 'string' &&
        item.host.trim() !== '' &&
        typeof item.user === 'string' &&
        item.user.trim() !== '' &&
        Number.isInteger(item.port) &&
        (item.port as number) >= 1 &&
        (item.port as number) <= 65535 &&
        typeof item.workingDir === 'string' &&
        item.workingDir.startsWith('/') &&
        (item.environment === 'local' ||
            item.environment === 'staging' ||
            item.environment === 'prod')
    );
}

/** A saved import is invalidated when its source changes. */
export function sameSshSource(saved: SshEndpoint, current: SshEndpoint): boolean {
    return (
        saved.id === current.id &&
        saved.host === current.host &&
        saved.port === current.port &&
        saved.user === current.user &&
        saved.authMethod === current.authMethod &&
        saved.keyPath === current.keyPath &&
        saved.environment === current.environment
    );
}
