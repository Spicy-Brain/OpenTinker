import type * as vscode from 'vscode';
import { DockerComposeTransport } from './dockerComposeTransport';
import { DockerExecTransport } from './dockerExecTransport';
import { LocalTransport } from './localTransport';
import type { Transport, TransportContext } from './transport';

export type Connection =
    | { kind: 'compose'; service: string }
    | { kind: 'docker'; container: string }
    | { kind: 'local' };

export const CONNECTION_KEY = 'opentinker.connection';

export function isConnection(value: unknown): value is Connection {
    if (typeof value !== 'object' || value === null) {
        return false;
    }

    const candidate = value as { kind?: unknown; service?: unknown; container?: unknown };

    if (candidate.kind === 'compose') {
        return typeof candidate.service === 'string' && candidate.service !== '';
    }

    if (candidate.kind === 'docker') {
        return typeof candidate.container === 'string' && candidate.container !== '';
    }

    return candidate.kind === 'local';
}

export function connectionLabel(connection: Connection): string {
    if (connection.kind === 'compose') {
        return `docker compose exec ${connection.service}`;
    }

    if (connection.kind === 'docker') {
        return `docker exec ${connection.container}`;
    }

    return 'local PHP';
}

export function createTransport(connection: Connection, context: TransportContext): Transport {
    if (connection.kind === 'compose') {
        return new DockerComposeTransport(context, connection.service);
    }

    if (connection.kind === 'docker') {
        return new DockerExecTransport(context, connection.container);
    }

    return new LocalTransport(context);
}

export function storedConnection(memento: vscode.Memento): Connection | undefined {
    const stored = memento.get<unknown>(CONNECTION_KEY);

    return isConnection(stored) ? stored : undefined;
}
