import type { Target } from './target';

/** Turns common start-up failures into a next step. */
export function explain(error: unknown, target: Target): string {
    const message = error instanceof Error ? error.message : String(error);
    const lower = message.toLowerCase();
    if (
        target.kind === 'compose' &&
        (lower.includes('no such service') ||
            lower.includes('is not running') ||
            (lower.includes('service') && lower.includes('not running')))
    ) {
        return `${message}\nStart it with: docker compose up -d ${target.service}`;
    }
    if (lower.includes('cannot connect to the docker daemon') || lower.includes('docker daemon')) {
        return `${message}\nIs Docker running?`;
    }
    if (lower.includes('vendor/autoload.php')) {
        return `${message}\nCheck the target's project path${target.kind === 'local' ? '' : ` (${target.workingDir})`} and that composer install has run.`;
    }
    if (lower.includes('host key verification failed')) {
        const command =
            target.kind === 'ssh'
                ? `ssh ${target.port === 22 ? '' : `-p ${target.port} `}${target.user}@${target.host}`
                : 'ssh';
        return `${message}\nConnect once with ${command} in a terminal to trust the host key.`;
    }
    if (lower.includes('permission denied (publickey')) {
        return `${message}\nAdd your key to the SSH agent (ssh-add) or set the key file on the target.`;
    }
    if (lower.includes('parse error') && lower.includes('worker')) {
        return `${message}\nOpenTinker needs PHP 8.1 or later where your app runs.`;
    }
    if (lower.includes('enoent') && lower.includes('spawn')) {
        return `${message}\n${target.kind === 'local' ? 'Is PHP installed and on your PATH?' : 'Is the docker/ssh command installed?'}`;
    }
    return message;
}
