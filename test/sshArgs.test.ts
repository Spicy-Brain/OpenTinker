import { spawn } from 'node:child_process';
import {
    chmod,
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    rm,
    stat,
    symlink,
    writeFile,
} from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    buildContainerUploadCommand,
    buildContainerWorkerCommand,
    buildRemoteWorkerCommand,
    buildSshArgs,
    buildUploadCommand,
    shellQuote,
} from '../src/session/sshArgs';
import { sshSpec } from '../src/session/transports';
import { sameSshSource, type SshEndpoint } from '../src/ssh/types';
import type { SshTargetProfile } from '../src/targets/target';

const source: SshEndpoint = {
    id: 'db-1',
    name: 'DB',
    host: 'bastion',
    port: 2222,
    user: 'tunnel',
    authMethod: 'key',
    keyPath: '~/.ssh/id_app',
    environment: 'prod',
};
const target: SshTargetProfile = {
    id: 't',
    kind: 'ssh',
    name: 'Prod',
    host: 'bastion',
    port: 2222,
    user: 'tunnel',
    workingDir: "/srv/app's dir",
    environment: 'production',
};

describe('SSH command construction', () => {
    it('quotes remote PHP paths and arguments, including single quotes', () => {
        expect(shellQuote("a'b")).toBe("'a'\\''b'");
        const command = buildRemoteWorkerCommand(
            'abc123',
            '/opt/php 8/php',
            target.workingDir,
            'laravel',
        );
        expect(command).toContain("'--base-path=/srv/app'\\''s dir'");
        expect(command).toContain("'--bootstrap=laravel'");
    });

    it('uses a noninteractive, verified connection and an explicit port', () => {
        const args = buildSshArgs(sshSpec(target, source));
        expect(args).toContain('-T');
        expect(args).toContain('BatchMode=yes');
        expect(args).toContain('StrictHostKeyChecking=yes');
        expect(args.slice(-2)).toEqual(['--', 'bastion']);
        expect(args.slice(args.indexOf('-p'), args.indexOf('-p') + 2)).toEqual(['-p', '2222']);
        expect(args).toContain('-i');
        expect(args[args.indexOf('-i') + 1]).toMatch(/[/\\]\.ssh[/\\]id_app$/);
    });

    it('uses SSH config identity for a different application host', () => {
        const args = buildSshArgs(sshSpec({ ...target, host: 'app.internal' }, source));
        expect(args).not.toContain('-i');
        expect(args.slice(-2)).toEqual(['--', 'app.internal']);
    });

    it('prefers a key file set on the target', () => {
        const args = buildSshArgs(
            sshSpec({ ...target, host: 'app.internal', identityFile: '~/.ssh/deploy' }, source),
        );
        expect(args[args.indexOf('-i') + 1]).toMatch(/deploy$/);
    });

    it('uploads to a private directory through a temporary file', () => {
        const command = buildUploadCommand('abc123');
        expect(command).toContain('chmod 700');
        expect(command).toContain('mktemp');
        expect(command).toContain('worker-abc123.php');
    });

    it.skipIf(process.platform === 'win32')(
        'runs the upload and quoted worker command in a shell',
        async () => {
            const home = await mkdtemp(path.join(os.tmpdir(), "opentinker shell '"));
            try {
                const workerSource = '<?php echo "worker";\n';
                await runShell(buildUploadCommand('abc123'), home, workerSource);
                const worker = path.join(home, '.opentinker', 'worker-abc123.php');
                expect(await readFile(worker, 'utf8')).toBe(workerSource);
                expect((await stat(path.dirname(worker))).mode & 0o777).toBe(0o700);

                const argsFile = path.join(home, 'args.txt');
                const fakePhp = path.join(home, "php's binary");
                await writeFile(
                    fakePhp,
                    `#!/bin/sh\nprintf '%s\\n' "$@" > ${shellQuote(argsFile)}\n`,
                );
                await chmod(fakePhp, 0o700);
                await runShell(
                    buildRemoteWorkerCommand('abc123', fakePhp, target.workingDir),
                    home,
                );
                expect((await readFile(argsFile, 'utf8')).trimEnd().split('\n')).toEqual([
                    worker,
                    `--base-path=${target.workingDir}`,
                    '--bootstrap=auto',
                ]);
            } finally {
                await rm(home, { recursive: true, force: true });
            }
        },
    );
});

describe('container command construction', () => {
    it('uploads into a per-user private directory through a temporary file', () => {
        const command = buildContainerUploadCommand('abc123');
        expect(command).toContain('umask 077');
        expect(command).toContain('\'/tmp\'"/opentinker-$(id -u)"');
        expect(command).toContain('[ ! -L "$d" ] && [ -O "$d" ]');
        expect(command).toContain('mktemp');
        expect(command).toContain('mv -f "$tmp" "$d/worker-abc123.php"');
    });

    it.skipIf(process.platform === 'win32')(
        'uploads privately and runs the quoted worker command in a shell',
        async () => {
            const root = await mkdtemp(path.join(os.tmpdir(), "opentinker container '"));
            try {
                const workerSource = '<?php echo "worker";\n';
                await runShell(buildContainerUploadCommand('abc123', root), root, workerSource);
                const dir = path.join(root, `opentinker-${process.getuid?.()}`);
                const worker = path.join(dir, 'worker-abc123.php');
                expect(await readFile(worker, 'utf8')).toBe(workerSource);
                expect((await stat(dir)).mode & 0o777).toBe(0o700);
                expect((await stat(worker)).mode & 0o777).toBe(0o600);
                expect(await readdir(dir)).toEqual(['worker-abc123.php']);

                const argsFile = path.join(root, 'args.txt');
                const fakePhp = path.join(root, "php's binary");
                await writeFile(
                    fakePhp,
                    `#!/bin/sh\nprintf '%s\\n' "$@" > ${shellQuote(argsFile)}\n`,
                );
                await chmod(fakePhp, 0o700);
                await runShell(
                    buildContainerWorkerCommand(
                        'abc123',
                        fakePhp,
                        target.workingDir,
                        'laravel',
                        root,
                    ),
                    root,
                );
                expect((await readFile(argsFile, 'utf8')).trimEnd().split('\n')).toEqual([
                    worker,
                    `--base-path=${target.workingDir}`,
                    '--bootstrap=laravel',
                ]);
            } finally {
                await rm(root, { recursive: true, force: true });
            }
        },
    );

    it.skipIf(process.platform === 'win32')(
        'refuses a worker directory that is a symlink',
        async () => {
            const root = await mkdtemp(path.join(os.tmpdir(), 'opentinker-container-'));
            try {
                const elsewhere = path.join(root, 'elsewhere');
                await mkdir(elsewhere);
                await symlink(elsewhere, path.join(root, `opentinker-${process.getuid?.()}`));
                await expect(
                    runShell(buildContainerUploadCommand('abc123', root), root, 'x'),
                ).rejects.toThrow(/refusing to use/);
                expect(await readdir(elsewhere)).toEqual([]);
            } finally {
                await rm(root, { recursive: true, force: true });
            }
        },
    );
});

function runShell(command: string, home: string, input = ''): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn('/bin/sh', ['-c', command], {
            env: { ...process.env, HOME: home },
            stdio: ['pipe', 'ignore', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString();
        });
        child.on('error', reject);
        child.on('close', (code) =>
            code === 0 ? resolve() : reject(new Error(stderr || `sh exited ${code}`)),
        );
        child.stdin.end(input);
    });
}

describe('import validation', () => {
    it('rejects a source whose environment or SSH destination changed', () => {
        expect(sameSshSource(source, { ...source, environment: 'staging' })).toBe(false);
        expect(sameSshSource(source, { ...source, host: 'other-bastion' })).toBe(false);
        expect(sameSshSource(source, { ...source, name: 'Renamed DB' })).toBe(true);
    });
});
