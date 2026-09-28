import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    resolve: {
        // Modules that import 'vscode' get a stub; the real API only exists in the extension host.
        alias: { vscode: fileURLToPath(new URL('./test/support/vscode.ts', import.meta.url)) },
    },
    test: {
        include: ['test/**/*.test.ts'],
        exclude: ['test/e2e/**', 'node_modules/**'],
    },
});
