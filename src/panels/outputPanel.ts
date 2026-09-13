import * as vscode from 'vscode';
import type { ResultFrame, WorkerFrame } from '../session/protocol';

export interface OutputPanelHandlers {
    onAction(action: 'rerun' | 'restart' | 'clear'): void;
    onDispose(): void;
}

export class OutputPanel {
    private static current: OutputPanel | undefined;

    private readonly disposables: vscode.Disposable[] = [];

    static show(extensionUri: vscode.Uri, handlers: OutputPanelHandlers): OutputPanel {
        if (OutputPanel.current) {
            OutputPanel.current.panel.reveal(vscode.ViewColumn.Beside, true);
            return OutputPanel.current;
        }

        const panel = vscode.window.createWebviewPanel(
            'opentinker.output',
            'OpenTinker',
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
            {
                enableScripts: true,
                retainContextWhenHidden: true,
            },
        );

        OutputPanel.current = new OutputPanel(panel, extensionUri, handlers);
        return OutputPanel.current;
    }

    private constructor(
        private readonly panel: vscode.WebviewPanel,
        _extensionUri: vscode.Uri,
        handlers: OutputPanelHandlers,
    ) {
        this.panel.webview.html = renderHtml();
        this.panel.webview.onDidReceiveMessage(
            (message: { kind?: string; action?: 'rerun' | 'restart' | 'clear' }) => {
                if (message?.kind === 'action' && message.action) {
                    handlers.onAction(message.action);
                }
            },
            undefined,
            this.disposables,
        );
        this.panel.onDidDispose(
            () => {
                OutputPanel.current = undefined;
                handlers.onDispose();
            },
            undefined,
            this.disposables,
        );
    }

    show(): void {
        this.panel.reveal(vscode.ViewColumn.Beside, true);
    }

    setTitle(label: string): void {
        this.panel.title = label === '' ? 'OpenTinker' : `OpenTinker — ${label}`;
    }

    beginRun(label: string, at: number): void {
        this.setTitle(label);
        this.post({ kind: 'begin', label, at });
    }

    renderRun(label: string, frames: WorkerFrame[]): void {
        this.setTitle(label);
        this.post({ kind: 'render', label, frames });
    }

    push(frame: WorkerFrame): void {
        this.post({ kind: 'frame', frame });
    }

    finish(frame: ResultFrame): void {
        this.post({ kind: 'finish', frame });
    }

    status(text: string): void {
        this.post({ kind: 'status', text });
    }

    clear(): void {
        this.post({ kind: 'clear' });
    }

    dispose(): void {
        this.panel.dispose();
        this.disposables.forEach((disposable) => disposable.dispose());
    }

    private post(message: unknown): void {
        void this.panel.webview.postMessage(message);
    }
}

function renderHtml(): string {
    const nonce = [...Array(32)].map(() => Math.floor(Math.random() * 36).toString(36)).join('');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
    :root {
        color-scheme: light dark;
    }
    body {
        margin: 0;
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
    }
    header {
        position: sticky;
        top: 0;
        z-index: 10;
        background: var(--vscode-editor-background);
        border-bottom: 1px solid var(--vscode-panel-border);
        padding: 8px 12px 6px;
    }
    .title-row {
        display: flex;
        align-items: center;
        gap: 8px;
    }
    #title {
        font-weight: 600;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .toolbar {
        margin-left: auto;
        display: flex;
        gap: 4px;
    }
    .toolbar button {
        font: inherit;
        font-size: 0.85em;
        color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
        background: var(--vscode-button-secondaryBackground, transparent);
        border: 1px solid var(--vscode-panel-border);
        border-radius: 4px;
        padding: 2px 8px;
        cursor: pointer;
    }
    .toolbar button:hover {
        background: var(--vscode-button-secondaryHoverBackground, var(--vscode-toolbar-hoverBackground));
    }
    #status {
        margin-top: 4px;
        font-size: 0.8em;
        opacity: 0.7;
    }
    #cards {
        padding: 10px 12px 32px;
        display: flex;
        flex-direction: column;
        gap: 10px;
    }
    .summary {
        font-size: 0.8em;
        opacity: 0.75;
        padding: 2px 0;
    }
    .summary.failed {
        color: var(--vscode-editorError-foreground, #f14c4c);
        opacity: 1;
    }
    .card {
        border: 1px solid var(--vscode-panel-border);
        border-radius: 6px;
        overflow: hidden;
    }
    .card-head {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 4px 10px;
        background: var(--vscode-editorWidget-background, rgba(128, 128, 128, 0.08));
        font-size: 0.8em;
    }
    .badge {
        font-weight: 600;
        color: var(--vscode-textLink-foreground);
    }
    .card-head .meta {
        opacity: 0.7;
        margin-left: auto;
    }
    .card-head .exit {
        color: var(--vscode-editorWarning-foreground, #cca700);
    }
    .card-head .failed {
        color: var(--vscode-editorError-foreground, #f14c4c);
    }
    .card-body {
        padding: 6px 10px;
    }
    pre.output {
        white-space: pre-wrap;
        word-break: break-word;
        font-family: var(--vscode-editor-font-family, monospace);
        margin: 4px 0;
    }
    .value {
        margin: 2px 0;
    }
    .value .prefix {
        opacity: 0.7;
        margin-right: 4px;
    }
    .error {
        margin: 6px 0;
        padding: 6px 8px;
        border-left: 3px solid var(--vscode-editorError-foreground, #f14c4c);
        background: var(--vscode-inputValidation-errorBackground, rgba(255, 0, 0, 0.1));
        font-family: var(--vscode-editor-font-family, monospace);
        white-space: pre-wrap;
        word-break: break-word;
    }
    .error summary {
        cursor: pointer;
    }
    .queries {
        border-top: 1px dashed var(--vscode-panel-border);
        padding: 6px 10px;
        display: flex;
        flex-direction: column;
        gap: 4px;
        font-size: 0.85em;
    }
    .query code {
        font-family: var(--vscode-editor-font-family, monospace);
        color: var(--vscode-terminal-ansiCyan, #29b8db);
        white-space: pre-wrap;
        word-break: break-word;
    }
    .query .query-meta {
        display: block;
        opacity: 0.6;
        font-size: 0.9em;
    }
    .empty {
        opacity: 0.6;
        margin-top: 24px;
        text-align: center;
    }
    .sf-dump {
        background: transparent !important;
    }
</style>
</head>
<body>
<header>
    <div class="title-row">
        <div id="title">OpenTinker</div>
        <div class="toolbar">
            <button data-action="rerun" title="Run the last snippet again">Run Again</button>
            <button data-action="restart" title="Restart the session and clear state">Restart</button>
            <button data-action="clear" title="Clear this view">Clear</button>
        </div>
    </div>
    <div id="status">idle</div>
</header>
<div id="cards"></div>
<script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const titleEl = document.getElementById('title');
    const statusEl = document.getElementById('status');
    const cardsEl = document.getElementById('cards');

    let run = emptyRun('OpenTinker');
    let cards = [];
    let cardIndex = new Map();

    function emptyRun(label) {
        return { label, cards: [], summary: null };
    }

    function resetRun(label) {
        run = emptyRun(label);
        cards = [];
        cardIndex = new Map();
        render();
    }

    function ensureCard(stmt, line) {
        const key = stmt || 0;
        let card = cardIndex.get(key);
        if (!card) {
            card = { stmt: key, line: line || null, items: [], queries: [], ok: true, ms: null, exit: null };
            cards.unshift(card);
            cardIndex.set(key, card);
        }
        if (line) {
            card.line = line;
        }
        return card;
    }

    function addItem(stmt, line, item) {
        const card = ensureCard(stmt, line);
        card.items.push(item);
        render();
    }

    function handleFrame(frame) {
        switch (frame.type) {
            case 'output':
                if (frame.text.trim() === '') return;
                addItem(frame.stmt, frame.line, { kind: 'output', text: frame.text });
                break;
            case 'dump':
                addItem(frame.stmt, frame.line, { kind: 'html', html: frame.html });
                break;
            case 'value':
                addItem(frame.stmt, frame.line, { kind: 'value', html: frame.html });
                break;
            case 'error': {
                const card = ensureCard(frame.stmt, frame.line);
                card.ok = false;
                card.items.push({ kind: 'error', frame });
                render();
                break;
            }
            case 'statement': {
                const card = ensureCard(frame.stmt, frame.line);
                card.ok = frame.ok;
                card.ms = frame.ms;
                card.queries = frame.queries || [];
                card.exit = frame.exit || null;
                render();
                break;
            }
            case 'fatal':
                addItem(0, null, { kind: 'fatal', message: frame.message });
                break;
        }
    }

    function render() {
        cardsEl.innerHTML = '';

        if (run.summary) {
            const summary = document.createElement('div');
            summary.className = 'summary' + (run.summary.failed ? ' failed' : '');
            const bits = [];
            bits.push(run.summary.ok ? 'ok' : 'failed');
            if (typeof run.summary.statements === 'number') {
                bits.push(run.summary.statements + (run.summary.statements === 1 ? ' statement' : ' statements'));
            }
            bits.push(run.summary.ms.toFixed(1) + ' ms');
            if (run.summary.memory) {
                bits.push(formatBytes(run.summary.memory));
            }
            summary.textContent = bits.join(' · ');
            cardsEl.appendChild(summary);
        }

        if (cards.length === 0 && !run.summary) {
            const empty = document.createElement('div');
            empty.className = 'empty';
            empty.textContent = 'No runs yet for this file. Press Ctrl/Cmd+Enter to run a scratch file.';
            cardsEl.appendChild(empty);
            return;
        }

        for (const card of cards) {
            cardsEl.appendChild(renderCard(card));
        }
    }

    function renderCard(card) {
        const root = document.createElement('div');
        root.className = 'card';

        const head = document.createElement('div');
        head.className = 'card-head';

        if (card.line) {
            const badge = document.createElement('span');
            badge.className = 'badge';
            badge.textContent = 'Line ' + card.line;
            head.appendChild(badge);
        }

        if (card.exit) {
            const exit = document.createElement('span');
            exit.className = 'exit';
            exit.textContent = 'exit: ' + card.exit;
            head.appendChild(exit);
        }

        if (!card.ok) {
            const failed = document.createElement('span');
            failed.className = 'failed';
            failed.textContent = 'error';
            head.appendChild(failed);
        }

        const meta = document.createElement('span');
        meta.className = 'meta';
        meta.textContent = card.ms === null ? '' : card.ms.toFixed(1) + ' ms';
        head.appendChild(meta);
        root.appendChild(head);

        const body = document.createElement('div');
        body.className = 'card-body';

        for (const item of card.items) {
            if (item.kind === 'output') {
                const pre = document.createElement('pre');
                pre.className = 'output';
                pre.textContent = item.text;
                body.appendChild(pre);
            } else if (item.kind === 'html') {
                const div = document.createElement('div');
                div.innerHTML = item.html;
                body.appendChild(div);
            } else if (item.kind === 'value') {
                const div = document.createElement('div');
                div.className = 'value';
                const prefix = document.createElement('span');
                prefix.className = 'prefix';
                prefix.textContent = '=';
                div.appendChild(prefix);
                const dump = document.createElement('span');
                dump.innerHTML = item.html;
                div.appendChild(dump);
                body.appendChild(div);
            } else if (item.kind === 'error') {
                body.appendChild(errorElement(item.frame));
            } else if (item.kind === 'fatal') {
                body.appendChild(errorElement({ message: item.message }));
            }
        }

        root.appendChild(body);

        if (card.queries.length > 0) {
            const queries = document.createElement('div');
            queries.className = 'queries';

            for (const query of card.queries) {
                const row = document.createElement('div');
                row.className = 'query';
                const code = document.createElement('code');
                code.textContent = query.sql;
                row.appendChild(code);
                const metaText = [];
                if (query.bindings && query.bindings.length > 0) {
                    metaText.push(query.bindings.join(', '));
                }
                if (typeof query.time === 'number') {
                    metaText.push(query.time.toFixed(2) + ' ms');
                }
                if (metaText.length > 0) {
                    const queryMeta = document.createElement('span');
                    queryMeta.className = 'query-meta';
                    queryMeta.textContent = metaText.join(' · ');
                    row.appendChild(queryMeta);
                }
                queries.appendChild(row);
            }

            root.appendChild(queries);
        }

        return root;
    }

    function errorElement(frame) {
        const details = document.createElement('details');
        details.className = 'error';
        details.open = true;
        const summary = document.createElement('summary');
        summary.textContent = (frame.errorClass ? frame.errorClass + ': ' : '') + frame.message;
        details.appendChild(summary);

        const location = [];
        if (frame.file) location.push(frame.file);
        if (frame.errorLine) location.push(frame.errorLine);
        if (location.length > 0) {
            const line = document.createElement('div');
            line.textContent = location.join(':');
            details.appendChild(line);
        }

        if (frame.trace) {
            const trace = document.createElement('pre');
            trace.className = 'output';
            trace.textContent = frame.trace;
            details.appendChild(trace);
        }

        return details;
    }

    function formatBytes(bytes) {
        if (!bytes) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB'];
        const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
        const value = bytes / Math.pow(1024, index);
        return value.toFixed(index === 0 ? 0 : 1) + ' ' + units[index];
    }

    document.querySelectorAll('.toolbar button').forEach((button) => {
        button.addEventListener('click', () => {
            vscode.postMessage({ kind: 'action', action: button.dataset.action });
        });
    });

    window.addEventListener('message', (event) => {
        const message = event.data;
        if (!message || typeof message.kind !== 'string') return;

        if (message.kind === 'clear') {
            resetRun(run.label);
            return;
        }

        if (message.kind === 'status') {
            statusEl.textContent = message.text;
            return;
        }

        if (message.kind === 'begin') {
            resetRun(message.label);
            statusEl.textContent = 'running…';
            return;
        }

        if (message.kind === 'render') {
            resetRun(message.label);
            for (const frame of message.frames) {
                applyWithoutRender(frame);
            }
            render();
            statusEl.textContent = 'stored run';
            return;
        }

        if (message.kind === 'frame') {
            handleFrame(message.frame);
            return;
        }

        if (message.kind === 'finish') {
            run.summary = message.frame;
            render();
            statusEl.textContent = 'idle';
        }
    });

    function applyWithoutRender(frame) {
        switch (frame.type) {
            case 'output':
                if (frame.text.trim() === '') return;
                ensureCard(frame.stmt, frame.line).items.push({ kind: 'output', text: frame.text });
                break;
            case 'dump':
                ensureCard(frame.stmt, frame.line).items.push({ kind: 'html', html: frame.html });
                break;
            case 'value':
                ensureCard(frame.stmt, frame.line).items.push({ kind: 'value', html: frame.html });
                break;
            case 'error': {
                const card = ensureCard(frame.stmt, frame.line);
                card.ok = false;
                card.items.push({ kind: 'error', frame });
                break;
            }
            case 'statement': {
                const card = ensureCard(frame.stmt, frame.line);
                card.ok = frame.ok;
                card.ms = frame.ms;
                card.queries = frame.queries || [];
                card.exit = frame.exit || null;
                break;
            }
            case 'fatal':
                ensureCard(0, null).items.push({ kind: 'fatal', message: frame.message });
                break;
            case 'result':
                run.summary = frame;
                break;
        }
    }
</script>
</body>
</html>`;
}
