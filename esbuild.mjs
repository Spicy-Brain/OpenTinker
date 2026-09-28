import { build, context } from 'esbuild';
import { buildWorker } from './scripts/build-worker.mjs';

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const extension = {
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'dist/extension.js',
    external: ['vscode'],
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    sourcemap: true,
    minify: !watch,
    logLevel: 'info',
};

/** The results panel front end: one script and one stylesheet. */
const webview = {
    entryPoints: { results: 'src/webview/results/main.ts' },
    bundle: true,
    outdir: 'dist/webview',
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    sourcemap: watch ? 'inline' : false,
    minify: !watch,
    logLevel: 'info',
};

/** Rebuilds dist/worker.php whenever the PHP sources change. */
const workerPlugin = {
    name: 'worker',
    setup(builder) {
        builder.onStart(async () => {
            await buildWorker();
        });
    },
};

if (watch) {
    const contexts = await Promise.all([
        context({ ...extension, plugins: [workerPlugin] }),
        context(webview),
    ]);
    await Promise.all(contexts.map((ctx) => ctx.watch()));
} else {
    await buildWorker();
    await Promise.all([build(extension), build(webview)]);
}
