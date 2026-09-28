import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { SshEndpoint } from '../ssh/types';
import type { Target } from '../targets/target';
import {
    buildContainerUploadCommand,
    buildContainerWorkerCommand,
    buildRemoteWorkerCommand,
    buildSshArgs,
    buildUploadCommand,
    type SshConnectionSpec,
} from './sshArgs';
import {
    runCommand,
    workerArgs,
    workerHash,
    type Transport,
    type TransportContext,
} from './transport';

export class LocalTransport implements Transport {
    readonly label: string;
    private readonly workerPath: string;

    constructor(private readonly context: TransportContext) {
        this.label = `local ${context.phpBinary}`;
        this.workerPath = path.join(
            context.storageDir,
            `worker-${workerHash(context.workerSource)}.php`,
        );
    }

    async ensureWorker(): Promise<void> {
        await mkdir(this.context.storageDir, { recursive: true });
        await writeFile(this.workerPath, this.context.workerSource, 'utf8');
    }

    spawn(): ChildProcess {
        return spawn(this.context.phpBinary, workerArgs(this.context, this.workerPath), {
            cwd: this.context.workingDir,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
    }
}

/**
 * docker compose exec and docker exec differ only in how the container is addressed.
 * The worker lives in a per-user private directory under the container's /tmp.
 */
class ContainerTransport implements Transport {
    readonly label: string;
    private readonly hash: string;

    constructor(
        private readonly context: TransportContext,
        private readonly execPrefix: string[],
        label: string,
    ) {
        this.label = label;
        this.hash = workerHash(context.workerSource);
    }

    async ensureWorker(): Promise<void> {
        await runCommand(
            'docker',
            [...this.execPrefix, 'sh', '-c', buildContainerUploadCommand(this.hash)],
            this.context.workspaceFolder,
            this.context.workerSource,
        );
    }

    spawn(): ChildProcess {
        return spawn(
            'docker',
            [
                ...this.execPrefix,
                'sh',
                '-c',
                buildContainerWorkerCommand(
                    this.hash,
                    this.context.phpBinary,
                    this.context.workingDir,
                    this.context.bootstrap,
                ),
            ],
            { cwd: this.context.workspaceFolder, stdio: ['pipe', 'pipe', 'pipe'] },
        );
    }
}

export class DockerComposeTransport extends ContainerTransport {
    constructor(context: TransportContext, service: string) {
        super(context, ['compose', 'exec', '-T', service], `docker compose exec ${service}`);
    }
}

export class DockerExecTransport extends ContainerTransport {
    constructor(context: TransportContext, container: string) {
        super(context, ['exec', '-i', container], `docker exec ${container}`);
    }
}

export class SshTransport implements Transport {
    readonly label: string;
    private readonly hash: string;

    constructor(
        private readonly context: TransportContext,
        private readonly spec: SshConnectionSpec,
        private readonly sshBinary = 'ssh',
    ) {
        this.label = `ssh ${spec.user}@${spec.host}:${spec.port}`;
        this.hash = workerHash(context.workerSource);
    }

    async ensureWorker(): Promise<void> {
        await runCommand(
            this.sshBinary,
            [...buildSshArgs(this.spec), buildUploadCommand(this.hash)],
            this.context.workspaceFolder,
            this.context.workerSource,
        );
    }

    spawn(): ChildProcess {
        return spawn(
            this.sshBinary,
            [
                ...buildSshArgs(this.spec),
                buildRemoteWorkerCommand(
                    this.hash,
                    this.context.phpBinary,
                    this.context.workingDir,
                    this.context.bootstrap,
                ),
            ],
            { cwd: this.context.workspaceFolder, stdio: ['pipe', 'pipe', 'pipe'] },
        );
    }
}

/** SSH connection details for a target, using an imported key only for the same host. */
export function sshSpec(
    target: Extract<Target, { kind: 'ssh' }>,
    source?: SshEndpoint,
): SshConnectionSpec {
    let identityFile = target.identityFile;
    if (
        !identityFile &&
        source?.authMethod === 'key' &&
        source.keyPath &&
        source.host === target.host &&
        source.port === target.port &&
        source.user === target.user
    ) {
        identityFile = source.keyPath;
    }
    return { host: target.host, user: target.user, port: target.port, identityFile };
}

export function createTransport(
    target: Target,
    context: TransportContext,
    source?: SshEndpoint,
): Transport {
    switch (target.kind) {
        case 'local':
            return new LocalTransport(context);
        case 'compose':
            return new DockerComposeTransport(context, target.service);
        case 'docker':
            return new DockerExecTransport(context, target.container);
        case 'ssh':
            if (source?.authMethod === 'password') {
                throw new Error(
                    'Password SSH authentication is not supported. Use an SSH key or agent.',
                );
            }
            return new SshTransport(context, sshSpec(target, source ?? target.source));
    }
}
