import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { isPanelMessage, type HostMessage, type PanelMessage } from '../shared/panelMessages';

export const RESULTS_VIEW_ID = 'opentinker.results';

/**
 * Hosts the results front end either as an editor tab beside the scratch file
 * (Tinkerwell style) or as a view in the bottom panel next to Terminal.
 * Messages sent before the front end says it is ready are dropped: it gets a
 * snapshot of the current state instead, whenever it is (re)created.
 */
export class ResultsHost implements vscode.WebviewViewProvider, vscode.Disposable {
    private panel?: vscode.WebviewPanel;
    private view?: vscode.WebviewView;
    private webview?: vscode.Webview;
    private ready = false;
    /** Listeners for the current webview, dropped when it is replaced. */
    private attached: vscode.Disposable[] = [];

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly location: () => 'beside' | 'panel',
        private readonly onMessage: (message: PanelMessage) => void,
        /** Messages that rebuild the current state in a fresh front end. */
        private readonly snapshot: () => HostMessage[],
    ) {}

    /** Shows the results, creating the panel or revealing the view. */
    show(preserveFocus = true): void {
        if (this.location() === 'panel') {
            this.panel?.dispose();
            if (this.view) this.view.show(preserveFocus);
            else void vscode.commands.executeCommand(`${RESULTS_VIEW_ID}.focus`, { preserveFocus });
            return;
        }

        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.Beside, preserveFocus);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'opentinker.output',
            'OpenTinker',
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus },
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [this.webviewRoot()],
            },
        );
        panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'opentinker.svg');
        this.panel = panel;
        this.attach(panel.webview);
        const disposed = panel.onDidDispose(() => {
            disposed.dispose();
            if (this.panel !== panel) return;
            this.panel = undefined;
            if (this.webview === panel.webview) this.detach();
        });
    }

    get visible(): boolean {
        return !!(this.panel?.visible || this.view?.visible);
    }

    setTitle(title: string): void {
        if (this.panel) this.panel.title = title ? `OpenTinker · ${title}` : 'OpenTinker';
        if (this.view) this.view.description = title;
    }

    post(message: HostMessage): void {
        if (this.webview && this.ready) void this.webview.postMessage(message);
    }

    resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        view.webview.options = { enableScripts: true, localResourceRoots: [this.webviewRoot()] };
        this.attach(view.webview);
        const disposed = view.onDidDispose(() => {
            disposed.dispose();
            if (this.view !== view) return;
            this.view = undefined;
            if (this.webview === view.webview) this.detach();
        });
    }

    dispose(): void {
        this.panel?.dispose();
        this.detach();
    }

    private attach(webview: vscode.Webview): void {
        this.detach();
        this.webview = webview;
        webview.html = this.html(webview);
        this.attached.push(
            webview.onDidReceiveMessage((message: unknown) => {
                if (!isPanelMessage(message) || webview !== this.webview) return;
                if (message.kind === 'ready') {
                    this.ready = true;
                    for (const replay of this.snapshot()) void webview.postMessage(replay);
                    return;
                }
                this.onMessage(message);
            }),
        );
    }

    private detach(): void {
        for (const disposable of this.attached) disposable.dispose();
        this.attached = [];
        this.webview = undefined;
        this.ready = false;
    }

    private webviewRoot(): vscode.Uri {
        return vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview');
    }

    private html(webview: vscode.Webview): string {
        const nonce = randomBytes(16).toString('base64');
        const script = webview.asWebviewUri(vscode.Uri.joinPath(this.webviewRoot(), 'results.js'));
        const style = webview.asWebviewUri(vscode.Uri.joinPath(this.webviewRoot(), 'results.css'));
        // https: images are only for previews, whose own policy blocks them
        // until the user asks (see previewView).
        const csp = [
            "default-src 'none'",
            `style-src ${webview.cspSource} 'unsafe-inline'`,
            `script-src 'nonce-${nonce}'`,
            `img-src ${webview.cspSource} data: https:`,
            `font-src ${webview.cspSource} data:`,
            "form-action 'none'",
            "base-uri 'none'",
        ].join('; ');
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>OpenTinker</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
    }
}
