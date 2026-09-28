import * as path from 'node:path';
import * as vscode from 'vscode';
import type { CallableTarget } from '../run/callable';
import type { Target } from '../targets/target';

export interface LensContext {
    isScratch(uri: vscode.Uri): boolean;
    targetFor(uri: vscode.Uri): Target | undefined;
    hasOwnTarget(uri: vscode.Uri): boolean;
    environment(target: Target): string;
    sessionMode(): 'fresh' | 'keep';
    rollback(): boolean;
}

const MODEL_PARENT =
    /\bextends\s+\\?([\w\\]*\\)?(Model|Authenticatable|User|Pivot|MorphPivot|\w+Model)\b/;

/**
 * Scratch files get a control strip on line 1 (run, target, session mode,
 * rollback); PHP functions and methods get "Run"; Eloquent models get
 * "Tinker this model".
 */
export class OpenTinkerCodeLens implements vscode.CodeLensProvider {
    private readonly changed = new vscode.EventEmitter<void>();
    readonly onDidChangeCodeLenses = this.changed.event;

    constructor(private readonly context: LensContext) {}

    refresh(): void {
        this.changed.fire();
    }

    async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
        const lenses: vscode.CodeLens[] = [];
        const top = new vscode.Range(0, 0, 0, 0);

        if (this.context.isScratch(document.uri)) {
            const target = this.context.targetFor(document.uri);
            const env = target ? this.context.environment(target) : '';
            lenses.push(
                new vscode.CodeLens(top, {
                    title: `$(play) Run Scratch File (${process.platform === 'darwin' ? '⌘↵' : 'Ctrl+Enter'})`,
                    command: 'opentinker.runFile',
                    tooltip: 'Run this scratch file (Ctrl/Cmd+Enter)',
                }),
                new vscode.CodeLens(top, {
                    title: target
                        ? `$(server-environment) ${target.name}${env && env !== 'unknown' ? ' · ' + env : ''}${this.context.hasOwnTarget(document.uri) ? ' (this file)' : ''}`
                        : '$(server-environment) Choose target',
                    command: 'opentinker.selectTargetForFile',
                    arguments: [document.uri],
                    tooltip: 'Choose where this scratch file runs',
                }),
                new vscode.CodeLens(top, {
                    title:
                        this.context.sessionMode() === 'fresh'
                            ? '$(refresh) Fresh session'
                            : '$(history) Keep session',
                    command: 'opentinker.toggleSessionMode',
                    tooltip: 'Fresh: every run starts clean. Keep: variables carry over.',
                }),
                new vscode.CodeLens(top, {
                    title: this.context.rollback()
                        ? '$(shield) Rollback on'
                        : '$(circle-slash) Rollback off',
                    command: 'opentinker.toggleRollback',
                    tooltip: 'Roll back database changes after each run',
                }),
            );
        }

        const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[] | undefined>(
            'vscode.executeDocumentSymbolProvider',
            document.uri,
        );
        if (!symbols?.length) return lenses;

        const text = document.getText();
        const namespace = text.match(/\bnamespace\s+([A-Za-z_][A-Za-z0-9_\\]*)\s*;/)?.[1] ?? '';
        const scratch = this.context.isScratch(document.uri);

        const visit = (symbol: vscode.DocumentSymbol, parentClass?: string): void => {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(symbol.name)) return;

            if (symbol.kind === vscode.SymbolKind.Namespace) {
                for (const child of symbol.children) visit(child);
                return;
            }

            if (symbol.kind === vscode.SymbolKind.Class) {
                const declaration = document.getText(
                    new vscode.Range(symbol.range.start, symbol.selectionRange.end.translate(1, 0)),
                );
                if (!scratch && (MODEL_PARENT.test(declaration) || isModelsPath(document.uri))) {
                    lenses.push(
                        new vscode.CodeLens(symbol.selectionRange, {
                            title: '$(beaker) Tinker this model',
                            command: 'opentinker.tinkerModel',
                            arguments: [[namespace, symbol.name].filter(Boolean).join('\\')],
                            tooltip: 'Open a scratch file that loads this model',
                        }),
                    );
                }
                for (const child of symbol.children) visit(child, symbol.name);
                return;
            }

            if (scratch) return;
            const method = parentClass && symbol.kind === vscode.SymbolKind.Method;
            const func = !parentClass && symbol.kind === vscode.SymbolKind.Function;
            if (!method && !func) return;

            const target: CallableTarget = {
                kind: method ? 'method' : 'function',
                name: symbol.name,
                className: method ? [namespace, parentClass].filter(Boolean).join('\\') : namespace,
                label: `${path.basename(document.fileName)} · ${parentClass ? parentClass + '::' : ''}${symbol.name}()`,
                key: document.uri.toString(),
                line: symbol.range.start.line + 1,
            };
            lenses.push(
                new vscode.CodeLens(symbol.selectionRange, {
                    title: `$(play) Run ${method ? 'method' : 'function'}`,
                    command: 'opentinker.runCallable',
                    arguments: [target],
                }),
            );
        };

        for (const symbol of symbols) {
            if ('children' in symbol) visit(symbol);
        }
        return lenses;
    }
}

function isModelsPath(uri: vscode.Uri): boolean {
    return /[/\\]app[/\\]Models[/\\]/.test(uri.fsPath);
}
