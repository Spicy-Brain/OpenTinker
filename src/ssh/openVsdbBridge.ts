import * as vscode from 'vscode';
import { isSshEndpoint, type SshEndpoint } from './types';

/** The published extension first, then local development builds. */
const OPENVSDB_IDS = ['snitzle.openvsdb', 'local.openvsdb'];

interface OpenVsdbApi {
    apiVersion: 1;
    listSshEndpoints(): Promise<SshEndpoint[]>;
    getSshEndpoint(id: string): Promise<SshEndpoint | undefined>;
}

function isOpenVsdbApi(value: unknown): value is OpenVsdbApi {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const api = value as Partial<Record<keyof OpenVsdbApi, unknown>>;
    return (
        api.apiVersion === 1 &&
        typeof api.listSshEndpoints === 'function' &&
        typeof api.getSshEndpoint === 'function'
    );
}

async function getApi(): Promise<OpenVsdbApi | undefined> {
    const extension = OPENVSDB_IDS.map((id) => vscode.extensions.getExtension<unknown>(id)).find(
        Boolean,
    );
    if (!extension) {
        return undefined;
    }

    const api: unknown = await extension.activate();
    if (!isOpenVsdbApi(api)) {
        throw new Error('OpenVSDB must be updated before OpenTinker can import SSH connections.');
    }
    return api;
}

export async function listImportedSshEndpoints(): Promise<SshEndpoint[] | undefined> {
    const api = await getApi();
    if (!api) {
        return undefined;
    }
    const endpoints: unknown = await api.listSshEndpoints();
    if (!Array.isArray(endpoints) || !endpoints.every(isSshEndpoint)) {
        throw new Error('OpenVSDB returned invalid SSH connection data.');
    }
    return endpoints;
}

export async function getImportedSshEndpoint(id: string): Promise<SshEndpoint | undefined> {
    const api = await getApi();
    if (!api) {
        throw new Error('OpenVSDB is unavailable. Select another runtime.');
    }
    const endpoint: unknown = await api.getSshEndpoint(id);
    if (endpoint !== undefined && !isSshEndpoint(endpoint)) {
        throw new Error('OpenVSDB returned invalid SSH connection data.');
    }
    return endpoint;
}
