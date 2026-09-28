import * as vscode from 'vscode';
import { isProduction, type Target } from '../targets/target';

/**
 * Marks scratch files that run against production: a red band on the first
 * line and in the overview ruler, so it is visible while you type.
 */
export class ProductionBanner implements vscode.Disposable {
    private readonly decoration = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        backgroundColor: new vscode.ThemeColor('inputValidation.errorBackground'),
        overviewRulerColor: new vscode.ThemeColor('editorError.foreground'),
        overviewRulerLane: vscode.OverviewRulerLane.Full,
        after: {
            color: new vscode.ThemeColor('errorForeground'),
            fontWeight: 'bold',
            margin: '0 0 0 2em',
        },
    });

    constructor(
        private readonly isScratch: (uri: vscode.Uri) => boolean,
        private readonly targetFor: (uri: vscode.Uri) => Target | undefined,
        private readonly environment: (target: Target) => string,
    ) {}

    refresh(): void {
        for (const editor of vscode.window.visibleTextEditors) {
            const uri = editor.document.uri;
            const target = this.isScratch(uri) ? this.targetFor(uri) : undefined;
            const production =
                target &&
                (isProduction(this.environment(target)) || isProduction(target.environment));
            editor.setDecorations(
                this.decoration,
                production && editor.document.lineCount > 0
                    ? [
                          {
                              range: editor.document.lineAt(0).range,
                              renderOptions: {
                                  after: { contentText: `⚠ PRODUCTION · ${target.name}` },
                              },
                          },
                      ]
                    : [],
            );
        }
    }

    dispose(): void {
        this.decoration.dispose();
    }
}
