import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type { Snippet } from '../state/snippetStore';

export function collectSnippetParameters(
    snippet: Snippet,
): Promise<Record<string, string> | undefined> {
    if (snippet.parameters.length === 0) return Promise.resolve({});
    return new Promise((resolve) => {
        const panel = vscode.window.createWebviewPanel(
            'opentinker.snippetForm',
            `Run ${snippet.name}`,
            vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true },
        );
        const nonce = randomUUID().replaceAll('-', '');
        const parameters = JSON.stringify(snippet.parameters).replaceAll('<', '\\u003c');
        panel.webview.html = `<!doctype html><html lang="en"><head><meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';" />
<style nonce="${nonce}">
body { font: var(--vscode-font-size) var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 20px; max-width: 620px; }
label { display: block; margin: 14px 0; font-weight: 600; }
input, textarea, select { box-sizing: border-box; display: block; width: 100%; margin-top: 5px; padding: 7px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); font: inherit; }
button { padding: 7px 14px; border: 0; color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; }
small { display: block; opacity: .8; margin-top: 3px; font-weight: normal; }
</style></head><body><h1>${escapeHtml(snippet.name)}</h1><p>Enter values for this snippet. It will run on the selected OpenTinker target.</p><form id="form"></form>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const parameters = ${parameters};
const form = document.getElementById('form');
for (const param of parameters) {
    const label = document.createElement('label');
    label.textContent = param.name;
    let input;
    if (param.type === 'bool') {
        input = document.createElement('select');
        for (const value of ['false', 'true']) {
            const option = document.createElement('option'); option.value = value; option.textContent = value; input.appendChild(option);
        }
    } else if (param.type === 'json') {
        input = document.createElement('textarea'); input.rows = 4; input.placeholder = '{"key": "value"}';
        input.required = true;
        input.addEventListener('input', () => input.setCustomValidity(''));
    } else {
        input = document.createElement('input'); input.type = param.type === 'number' ? 'number' : 'text'; input.required = true;
    }
    input.name = param.name;
    label.appendChild(input);
    const hint = document.createElement('small'); hint.textContent = param.type; label.appendChild(hint);
    form.appendChild(label);
}
const button = document.createElement('button'); button.type = 'submit'; button.textContent = 'Run snippet'; form.appendChild(button);
form.querySelector('input, textarea, select')?.focus();
form.addEventListener('submit', (event) => {
    event.preventDefault();
    const values = {};
    for (const param of parameters) {
        const input = form.elements.namedItem(param.name);
        if (param.type === 'json') {
            try { JSON.parse(input.value); }
            catch { input.setCustomValidity('Enter valid JSON.'); input.reportValidity(); return; }
        }
        values[param.name] = input.value;
    }
    vscode.postMessage({ kind: 'submit', values });
});
</script></body></html>`;
        let settled = false;
        panel.webview.onDidReceiveMessage((message: { kind?: string; values?: unknown }) => {
            if (
                settled ||
                message.kind !== 'submit' ||
                !message.values ||
                typeof message.values !== 'object'
            )
                return;
            const values = message.values as Record<string, unknown>;
            if (!snippet.parameters.every((param) => typeof values[param.name] === 'string'))
                return;
            settled = true;
            resolve(values as Record<string, string>);
            panel.dispose();
        });
        panel.onDidDispose(() => {
            if (!settled) resolve(undefined);
            settled = true;
        });
    });
}

function escapeHtml(value: string): string {
    return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
