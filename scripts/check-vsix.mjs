// Checks that a packaged VSIX holds exactly the runtime files, so a missing
// build output or a stray local file fails the release instead of reaching users.
//
//   node scripts/check-vsix.mjs opentinker-0.3.0.vsix
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';

const EXPECTED = [
    '[Content_Types].xml',
    'extension.vsixmanifest',
    'extension/package.json',
    'extension/readme.md',
    'extension/changelog.md',
    'extension/LICENSE.txt',
    'extension/dist/extension.js',
    'extension/dist/worker.php',
    'extension/dist/webview/results.js',
    'extension/dist/webview/results.css',
    'extension/media/icon.png',
    'extension/media/opentinker.svg',
    'extension/media/walkthrough/run.jpg',
    'extension/media/walkthrough/targets.jpg',
    'extension/media/walkthrough/safety.jpg',
    'extension/media/walkthrough/anywhere.md',
    'extension/media/walkthrough/setup.md',
];
const MAX_BYTES = 1024 * 1024;

const file = process.argv[2];
if (!file) {
    console.error('Usage: node scripts/check-vsix.mjs <file.vsix>');
    process.exit(2);
}

const entries = execFileSync('unzip', ['-Z1', file], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.endsWith('/'));
const manifest = JSON.parse(
    execFileSync('unzip', ['-p', file, 'extension/package.json'], { encoding: 'utf8' }),
);
const size = statSync(file).size;

const problems = [
    ...EXPECTED.filter((entry) => !entries.includes(entry)).map((entry) => `missing ${entry}`),
    ...entries.filter((entry) => !EXPECTED.includes(entry)).map((entry) => `unexpected ${entry}`),
];
if (size > MAX_BYTES) problems.push(`${size} bytes is over the ${MAX_BYTES} byte budget`);

console.log(
    `${manifest.publisher}.${manifest.name} ${manifest.version}: ${entries.length} files, ${(size / 1024).toFixed(1)} KB`,
);
if (problems.length) {
    for (const problem of problems) console.error(`  ✗ ${problem}`);
    process.exit(1);
}
console.log('  ✓ contents match the expected runtime files');
