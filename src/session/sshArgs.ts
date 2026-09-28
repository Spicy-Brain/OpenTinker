import * as os from 'node:os';
import * as path from 'node:path';

export interface SshConnectionSpec {
    host: string;
    user: string;
    port: number;
    /** Private key to use; omit to rely on the agent or ~/.ssh/config. */
    identityFile?: string;
}

export function shellQuote(value: string): string {
    return `'${value.replaceAll("'", "'\\''")}'`;
}

export function expandHome(value: string): string {
    return value === '~' || value.startsWith('~/')
        ? path.join(os.homedir(), value.slice(1))
        : value;
}

export function buildSshArgs(spec: SshConnectionSpec): string[] {
    const args = [
        '-T',
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=10',
        '-o',
        'ServerAliveInterval=15',
        '-o',
        'ServerAliveCountMax=2',
        '-o',
        'StrictHostKeyChecking=yes',
        '-o',
        'LogLevel=ERROR',
        '-p',
        String(spec.port),
        '-l',
        spec.user,
    ];

    if (spec.identityFile) {
        args.push('-i', expandHome(spec.identityFile), '-o', 'IdentitiesOnly=yes');
    }

    args.push('--', spec.host);
    return args;
}

export function remoteWorkerPath(hash: string): string {
    return `"$HOME/.opentinker/worker-${hash}.php"`;
}

export function buildUploadCommand(hash: string): string {
    return (
        'umask 077; mkdir -p "$HOME/.opentinker" && ' +
        'test ! -L "$HOME/.opentinker" && chmod 700 "$HOME/.opentinker" && ' +
        'tmp=$(mktemp "$HOME/.opentinker/.worker.XXXXXXXX") && ' +
        'trap \'rm -f "$tmp"\' EXIT && cat > "$tmp" && ' +
        `mv -f "$tmp" ${remoteWorkerPath(hash)}`
    );
}

export function buildRemoteWorkerCommand(
    hash: string,
    phpBinary: string,
    workingDir: string,
    bootstrap = 'auto',
): string {
    return `exec ${shellQuote(phpBinary)} ${remoteWorkerPath(hash)} ${shellQuote(`--base-path=${workingDir}`)} ${shellQuote(`--bootstrap=${bootstrap}`)}`;
}
