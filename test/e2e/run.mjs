/* global process, console */
// Launches a real VS Code with OpenTinker against a disposable Laravel app and
// drives it through its commands. It writes workspace settings, scratch files
// and a test row (rolled back) into that app, so never point it at a real project.
//
//   node test/e2e/run.mjs /path/to/throwaway-laravel-app [--reset]
//
// --reset removes the app's .tinker and .vscode folders first.
import { runTests } from '@vscode/test-electron';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const workspace = process.argv[2];
if (!workspace) {
    console.error('Pass the path of a Laravel app to test against.');
    process.exit(2);
}

const profile = await mkdtemp(join(tmpdir(), 'opentinker-e2e-'));
await mkdir(join(profile, 'User'), { recursive: true });
await writeFile(
    join(profile, 'User', 'settings.json'),
    JSON.stringify({
        'security.workspace.trust.enabled': false,
        'workbench.startupEditor': 'none',
    }),
);
if (process.argv.includes('--reset')) {
    await rm(join(workspace, '.tinker'), { recursive: true, force: true });
    await rm(join(workspace, '.vscode'), { recursive: true, force: true });
}

try {
    await runTests({
        extensionDevelopmentPath: root,
        extensionTestsPath: join(root, 'test', 'e2e', 'suite.cjs'),
        launchArgs: [
            workspace,
            '--disable-extensions',
            '--skip-welcome',
            '--skip-release-notes',
            `--user-data-dir=${profile}`,
        ],
        extensionTestsEnv: {
            OPENTINKER_E2E: '1',
            OPENTINKER_E2E_REPORT: process.env.OPENTINKER_E2E_REPORT ?? '',
        },
    });
} catch (error) {
    console.error(error);
    process.exitCode = 1;
} finally {
    await rm(profile, { recursive: true, force: true });
}
