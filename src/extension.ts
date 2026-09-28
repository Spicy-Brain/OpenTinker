import * as vscode from 'vscode';
import { OpenTinkerApp } from './app';
import type { CallableTarget } from './run/callable';
import type { RunRecord } from './state/runStore';
import type { Snippet } from './state/snippetStore';
import type { Target } from './targets/target';

let app: OpenTinkerApp | undefined;

/** Returns the app only for the end-to-end tests (OPENTINKER_E2E=1). */
export function activate(context: vscode.ExtensionContext): OpenTinkerApp | undefined {
    const current = new OpenTinkerApp(context);
    app = current;

    const command = (id: string, handler: (...args: never[]) => unknown): void => {
        context.subscriptions.push(
            vscode.commands.registerCommand(id, async (...args: never[]) => {
                try {
                    await handler(...args);
                } catch (error) {
                    current.showError(error);
                }
            }),
        );
    };
    const withEditor = (run: (editor: vscode.TextEditor) => unknown) => () => {
        const editor = vscode.window.activeTextEditor;
        if (editor) return run(editor);
        void vscode.window.showInformationMessage('Open a PHP file or scratch file to run it.');
        return undefined;
    };

    command('opentinker.open', () => current.openTinkerWindow());
    command(
        'opentinker.run',
        withEditor((editor) => current.runEditor(editor, 'auto')),
    );
    command(
        'opentinker.runSelection',
        withEditor((editor) => current.runEditor(editor, 'selection')),
    );
    command('opentinker.runFile', () => current.runScratch());
    command('opentinker.runClipboard', () => current.runClipboard());
    command('opentinker.runCallable', (target: CallableTarget) => current.runCallable(target));
    command('opentinker.stop', () => current.controller.stop());
    command('opentinker.rerun', () => current.rerunDisplayed());

    command('opentinker.newScratch', () => current.newScratch());
    command('opentinker.openScratch', (uri?: vscode.Uri) => current.openScratch(uri));
    command('opentinker.tinkerModel', (className: string) => current.tinkerModel(className));

    command('opentinker.selectTarget', () => current.selectTarget());
    command('opentinker.selectConnection', () => current.selectTarget());
    command('opentinker.selectTargetForFile', (uri?: vscode.Uri) =>
        current.selectTarget(uri ?? vscode.window.activeTextEditor?.document.uri),
    );
    command('opentinker.newTarget', () => current.editTarget());
    command('opentinker.editTarget', (target?: Target) => {
        const selected = target ?? current.currentTarget();
        return selected ? current.editTarget(selected) : current.selectTarget();
    });

    command('opentinker.toggleSessionMode', () => current.toggleSessionMode());
    command('opentinker.toggleRollback', () => current.toggleRollback());
    command('opentinker.restartSession', () => current.restartSession());

    command('opentinker.saveSnippet', () => current.saveSnippet());
    command('opentinker.runSnippet', (snippet?: Snippet) => current.runSnippet(snippet));
    command('opentinker.openSnippet', (snippet?: Snippet) => current.openSnippet(snippet));

    command('opentinker.openRecent', (record?: RunRecord) => current.openRecent(record));
    command('opentinker.searchHistory', () => current.searchHistory());
    command('opentinker.clearHistory', () => current.clearHistory());

    command('opentinker.doctor', () => current.doctor());
    command('opentinker.generateModelHints', () => current.generateModelHints());
    command('opentinker.showLogs', () => current.showLogs());
    command('opentinker.stopLogs', () => current.stopLogs());
    command('opentinker.clearOutput', () => current.clearResults());
    command('opentinker.focusOutput', () => current.results.show(false));

    context.subscriptions.push(current);
    return process.env.OPENTINKER_E2E === '1' ? current : undefined;
}

export function deactivate(): void {
    app?.dispose();
    app = undefined;
}
