/* eslint-disable */
// Runs inside the VS Code extension host. See run.mjs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const log = (line) => console.log(line);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function setText(editor, text) {
    const document = editor.document;
    const all = new vscode.Range(0, 0, document.lineCount, 0);
    await editor.edit((builder) => builder.replace(all, text));
}

exports.run = async function run() {
    const failures = [];
    const step = async (name, fn) => {
        const started = Date.now();
        try {
            await fn();
            log(`  ✓ ${name} (${Date.now() - started} ms)`);
        } catch (error) {
            failures.push(`${name}: ${error && error.stack ? error.stack : error}`);
            log(`  ✗ ${name}\n      ${error && error.message}`);
        }
    };

    const extension = vscode.extensions.getExtension('open-tinker.opentinker');
    assert.ok(extension, 'extension is installed');
    const app = await extension.activate();
    assert.ok(app, 'test API is exposed');
    const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const finished = [];
    app.controller.onDidFinishRun.event((run) => finished.push(run));
    const last = () => finished[finished.length - 1];
    const values = (run) =>
        run.frames.filter((frame) => frame.type === 'value').map((frame) => frame.short);

    log(`OpenTinker end-to-end in ${workspace}`);

    let scratch;
    await step('creates a scratch file and marks it as scratch', async () => {
        await vscode.commands.executeCommand('opentinker.newScratch');
        scratch = vscode.window.activeTextEditor;
        assert.ok(scratch, 'an editor opened');
        assert.equal(path.dirname(scratch.document.uri.fsPath), path.join(workspace, '.tinker'));
    });

    const code =
        "<?php\n\nuse Illuminate\\Support\\Str;\nuse Illuminate\\Support\\{Arr, Collection as Coll};\n\n$greeting = 'hi';\nStr::upper($greeting) . Arr::first([1]);\n";

    await step('first run detects the target and runs the file', async () => {
        await setText(scratch, code);
        await vscode.window.showTextDocument(scratch.document);
        await vscode.commands.executeCommand('opentinker.run');
        const run = last();
        assert.ok(run, 'a run finished');
        assert.equal(
            run.result.ok,
            true,
            JSON.stringify(run.frames.filter((f) => f.type === 'error')),
        );
        assert.deepEqual(values(run).slice(-1), ['HI1']);
        assert.equal(app.targets.active().kind, 'local');
    });

    await step('running the same file again works (the original bug)', async () => {
        await vscode.commands.executeCommand('opentinker.run');
        assert.equal(last().result.ok, true);
        assert.equal(finished.length, 2);
        assert.equal(last().changes[4], 'same', `changes ${JSON.stringify(last().changes)}`);
    });

    await step('changing an import between runs works', async () => {
        await setText(scratch, '<?php\nuse Illuminate\\Support\\Stringable as Str;\nStr::class;\n');
        await vscode.commands.executeCommand('opentinker.run');
        assert.equal(last().result.ok, true);
        assert.deepEqual(values(last()), ['Illuminate\\Support\\Stringable']);
    });

    await step('scratch files get the control CodeLens', async () => {
        const lenses = await vscode.commands.executeCommand(
            'vscode.executeCodeLensProvider',
            scratch.document.uri,
        );
        const titles = lenses.map((lens) => lens.command && lens.command.title);
        assert.ok(titles.includes('$(play) Run'), titles.join(', '));
        assert.ok(
            titles.some((title) => title && title.includes('Fresh session')),
            titles.join(', '),
        );
    });

    await step('keep-session mode carries variables over', async () => {
        await vscode.commands.executeCommand('opentinker.toggleSessionMode');
        await sleep(300);
        await setText(scratch, '<?php\n$kept = 21;\n');
        await vscode.commands.executeCommand('opentinker.run');
        await setText(scratch, '<?php\n$kept * 2;\n');
        await vscode.commands.executeCommand('opentinker.run');
        assert.deepEqual(values(last()), ['42']);
        await vscode.commands.executeCommand('opentinker.restartSession');
        await setText(scratch, "<?php\nisset($kept) ? 'kept' : 'reset';\n");
        await vscode.commands.executeCommand('opentinker.run');
        assert.deepEqual(values(last()), ['reset']);
        await vscode.commands.executeCommand('opentinker.toggleSessionMode');
        await sleep(300);
    });

    await step('rollback mode undoes database writes', async () => {
        await setText(scratch, "<?php\nDB::table('users')->count();\n");
        await vscode.commands.executeCommand('opentinker.run');
        const before = values(last())[0];
        await vscode.commands.executeCommand('opentinker.toggleRollback');
        await sleep(300);
        await setText(
            scratch,
            "<?php\nDB::table('users')->insert(['name' => 'E2E', 'email' => 'e2e-' . uniqid() . '@example.com', 'password' => 'x']);\n",
        );
        await vscode.commands.executeCommand('opentinker.run');
        assert.equal(
            last().record.rolledBack,
            true,
            JSON.stringify(last().frames.filter((f) => f.type === 'error')),
        );
        await vscode.commands.executeCommand('opentinker.toggleRollback');
        await sleep(300);
        await setText(scratch, "<?php\nDB::table('users')->count();\n");
        await vscode.commands.executeCommand('opentinker.run');
        assert.equal(values(last())[0], before);
    });

    await step('Stop cancels a long run quickly', async () => {
        await setText(scratch, '<?php\nsleep(20);\n');
        const started = Date.now();
        const running = vscode.commands.executeCommand('opentinker.run');
        await sleep(1500);
        await vscode.commands.executeCommand('opentinker.stop');
        await running;
        assert.equal(last().result.stopped, true);
        assert.ok(Date.now() - started < 8000, `took ${Date.now() - started} ms`);
    });

    await step('errors report the scratch line without internal frames', async () => {
        await setText(scratch, "<?php\n$a = 1;\n\nthrow new RuntimeException('boom');\n");
        await vscode.commands.executeCommand('opentinker.run');
        const error = last().frames.find((frame) => frame.type === 'error');
        assert.equal(error.message, 'boom');
        assert.equal(error.scratchLine, 4);
    });

    await step('Run Selection applies the file’s imports', async () => {
        const file = path.join(workspace, 'opentinker-e2e-probe.php');
        fs.writeFileSync(
            file,
            "<?php\n\nuse Illuminate\\Support\\Str;\n\nStr::upper('selection');\n",
        );
        const editor = await vscode.window.showTextDocument(vscode.Uri.file(file));
        editor.selection = new vscode.Selection(4, 0, 4, 26);
        await vscode.commands.executeCommand('opentinker.runSelection');
        fs.unlinkSync(file);
        assert.deepEqual(values(last()), ['SELECTION']);
        assert.deepEqual(last().record.imports, ['use Illuminate\\Support\\Str;']);
    });

    await step('Tinker this model opens and runs a model scratch file', async () => {
        const count = finished.length;
        await vscode.commands.executeCommand('opentinker.tinkerModel', 'App\\Models\\User');
        assert.equal(finished.length, count + 1);
        assert.equal(last().result.ok, true);
        assert.ok(
            vscode.window.activeTextEditor.document.getText().includes('use App\\Models\\User;'),
        );
    });

    await step('model hints are generated for autocomplete', async () => {
        await vscode.commands.executeCommand('opentinker.generateModelHints');
        const hints = fs.readFileSync(
            path.join(workspace, '.tinker', '_ide_helper_models.php'),
            'utf8',
        );
        assert.ok(hints.includes('@property int $id'), hints.slice(0, 400));
    });

    await step('snippets are saved as shareable files', async () => {
        const snippet = await app.snippets.save('Count users', 'User::count();', 'How many users');
        assert.ok(fs.existsSync(snippet.file));
        assert.equal(
            (await app.snippets.list()).some((item) => item.name === 'Count users'),
            true,
        );
    });

    await step('history keeps each run', async () => {
        assert.ok(app.store.recentRuns().length >= 8);
    });

    await step('the results panel is showing', async () => {
        assert.equal(app.results.visible, true);
    });

    const report = process.env.OPENTINKER_E2E_REPORT;
    if (report)
        fs.writeFileSync(report, JSON.stringify({ failures, runs: finished.length }, null, 2));
    if (failures.length)
        throw new Error(`${failures.length} end-to-end checks failed:\n${failures.join('\n\n')}`);
    log(`\nAll end-to-end checks passed (${finished.length} runs).`);
};
