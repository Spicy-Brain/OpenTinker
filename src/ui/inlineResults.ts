import * as vscode from 'vscode';
import type { RunFrame } from '../shared/protocol';

interface LineResult {
    line: number;
    text: string;
    kind: 'value' | 'error' | 'exit' | 'inline';
    detail: string;
}

const MAX_TEXT = 80;

/**
 * Tinkerwell-style results at the end of each line: the value a statement
 * returned, errors in red, and //? inspections. Hover shows the full text.
 */
export class InlineResults implements vscode.Disposable {
    private readonly valueType = vscode.window.createTextEditorDecorationType({
        after: {
            color: new vscode.ThemeColor('editorCodeLens.foreground'),
            margin: '0 0 0 2em',
            fontStyle: 'italic',
        },
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });
    private readonly errorType = vscode.window.createTextEditorDecorationType({
        after: {
            color: new vscode.ThemeColor('errorForeground'),
            margin: '0 0 0 2em',
        },
        backgroundColor: new vscode.ThemeColor('diffEditor.removedLineBackground'),
        isWholeLine: true,
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });
    private readonly results = new Map<string, Map<number, LineResult>>();
    private readonly disposables: vscode.Disposable[] = [];

    constructor(private readonly enabled: () => boolean) {
        this.disposables.push(
            vscode.window.onDidChangeVisibleTextEditors(() => this.renderAll()),
            vscode.workspace.onDidChangeTextDocument((event) => {
                const key = event.document.uri.toString();
                const lines = this.results.get(key);
                if (!lines || !event.contentChanges.length) return;
                // Drop results on edited lines; move the rest with the text.
                for (const change of event.contentChanges) {
                    const start = change.range.start.line;
                    const end = change.range.end.line;
                    const delta = (change.text.match(/\n/g)?.length ?? 0) - (end - start);
                    const moved = new Map<number, LineResult>();
                    for (const [line, result] of lines) {
                        if (line >= start && line <= end) continue;
                        const next = line > end ? line + delta : line;
                        moved.set(next, { ...result, line: next });
                    }
                    lines.clear();
                    for (const [line, result] of moved) lines.set(line, result);
                }
                this.render(key);
            }),
        );
    }

    begin(key: string): void {
        if (!key) return;
        this.results.set(key, new Map());
        this.render(key);
    }

    add(key: string, sourceLine: number, frame: RunFrame): void {
        if (!key || !this.enabled()) return;
        const lines = this.results.get(key);
        if (!lines) return;

        const toDocLine = (line: number): number => sourceLine + line - 2;

        if (frame.type === 'statement' && !frame.import) {
            const line = toDocLine(frame.endLine ?? frame.line);
            if (frame.exit && !lines.has(line)) {
                lines.set(line, {
                    line,
                    text: `⏹ ${frame.exit}`,
                    kind: 'exit',
                    detail: frame.exit,
                });
            } else if (frame.short !== undefined && !lines.has(line)) {
                lines.set(line, {
                    line,
                    text: `= ${frame.short}`,
                    kind: 'value',
                    detail: frame.short,
                });
            }
        } else if (frame.type === 'dump' && typeof frame.line === 'number') {
            const line = toDocLine(frame.line);
            const existing = lines.get(line);
            const text = frame.short ?? 'dumped';
            if (!existing || existing.kind === 'value') {
                lines.set(line, {
                    line,
                    text: existing ? `${existing.text}, ${text}` : `dump: ${text}`,
                    kind: 'value',
                    detail: existing ? `${existing.detail}\n${text}` : text,
                });
            }
        } else if (frame.type === 'inline') {
            const line = toDocLine(frame.line);
            lines.set(line, {
                line,
                text: `//? ${frame.text}`,
                kind: 'inline',
                detail: frame.text,
            });
        } else if (frame.type === 'error') {
            const line = toDocLine(frame.scratchLine ?? frame.line ?? 1);
            lines.set(line, {
                line,
                text: `✗ ${frame.message.split('\n')[0]}`,
                kind: 'error',
                detail: `${frame.errorClass}: ${frame.message}`,
            });
        } else {
            return;
        }
        this.render(key);
    }

    clear(key: string): void {
        this.results.delete(key);
        this.render(key);
    }

    dispose(): void {
        this.valueType.dispose();
        this.errorType.dispose();
        for (const disposable of this.disposables) disposable.dispose();
    }

    private renderAll(): void {
        for (const editor of vscode.window.visibleTextEditors)
            this.render(editor.document.uri.toString());
    }

    private render(key: string): void {
        const lines = this.results.get(key);
        for (const editor of vscode.window.visibleTextEditors) {
            if (editor.document.uri.toString() !== key) continue;
            const values: vscode.DecorationOptions[] = [];
            const errors: vscode.DecorationOptions[] = [];
            for (const result of lines?.values() ?? []) {
                if (result.line < 0 || result.line >= editor.document.lineCount) continue;
                const end = editor.document.lineAt(result.line).range.end;
                const text =
                    result.text.length > MAX_TEXT
                        ? result.text.slice(0, MAX_TEXT - 1) + '…'
                        : result.text;
                const hover = new vscode.MarkdownString();
                hover.appendCodeblock(result.detail, result.kind === 'error' ? 'text' : 'php');
                hover.appendMarkdown('\n[Show results](command:opentinker.focusOutput)');
                hover.isTrusted = { enabledCommands: ['opentinker.focusOutput'] };
                const option: vscode.DecorationOptions = {
                    range: new vscode.Range(end, end),
                    hoverMessage: hover,
                    renderOptions: { after: { contentText: text } },
                };
                (result.kind === 'error' ? errors : values).push(option);
            }
            editor.setDecorations(this.valueType, values);
            editor.setDecorations(this.errorType, errors);
        }
    }
}
