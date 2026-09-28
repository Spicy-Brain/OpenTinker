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

/**
 * Uploads the worker (read from stdin) inside a container. /tmp is shared by
 * every user of the container, so the directory is per user and must be a real
 * directory owned by that user; the file is written privately and moved into
 * place. The ownership test fails closed on a shell without `test -O`.
 */
export function buildContainerUploadCommand(hash: string, root = '/tmp'): string {
    return (
        `umask 077; d=${containerWorkerDir(root)}; mkdir -p "$d" 2>/dev/null; ` +
        'if [ -d "$d" ] && [ ! -L "$d" ] && [ -O "$d" ]; then :; else ' +
        'echo "OpenTinker: refusing to use $d: it is not a directory owned by this user" >&2; exit 1; fi; ' +
        'chmod 700 "$d" && tmp=$(mktemp "$d/.worker.XXXXXXXX") && ' +
        'trap \'rm -f "$tmp"\' EXIT && cat > "$tmp" && ' +
        `mv -f "$tmp" "$d/worker-${hash}.php"`
    );
}

/** Runs the worker uploaded by buildContainerUploadCommand. */
export function buildContainerWorkerCommand(
    hash: string,
    phpBinary: string,
    workingDir: string,
    bootstrap = 'auto',
    root = '/tmp',
): string {
    return `exec ${shellQuote(phpBinary)} ${containerWorkerDir(root)}"/worker-${hash}.php" ${shellQuote(`--base-path=${workingDir}`)} ${shellQuote(`--bootstrap=${bootstrap}`)}`;
}

function containerWorkerDir(root: string): string {
    return `${shellQuote(root)}"/opentinker-$(id -u)"`;
}

export function buildRemoteWorkerCommand(
    hash: string,
    phpBinary: string,
    workingDir: string,
    bootstrap = 'auto',
): string {
    return `exec ${shellQuote(phpBinary)} ${remoteWorkerPath(hash)} ${shellQuote(`--base-path=${workingDir}`)} ${shellQuote(`--bootstrap=${bootstrap}`)}`;
}
