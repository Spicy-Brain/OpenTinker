import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { containerIsRunning, listComposeServices, listRunningContainers } from './docker/services';
import { OutputPanel } from './panels/outputPanel';
import { resolveRunTarget } from './run/target';
import { ScratchManager } from './scratch/scratchManager';
import {
    CONNECTION_KEY,
    connectionLabel,
    createTransport,
    storedConnection,
    type Connection,
} from './session/connection';
import type { ExecutionMode, ResultFrame, WorkerFrame } from './session/protocol';
import { TinkerSession, type SessionStatus } from './session/session';
import type { TransportContext } from './session/transport';
import { RunStore, type RunRecord } from './state/runStore';
import { OpenTinkerViewProvider } from './views/opentinkerView';

const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
const MAX_STORED_FRAMES = 2000;

interface ActiveRun {
    key: string;
    label: string;
    code: string;
    mode: ExecutionMode;
    frames: WorkerFrame[];
}

interface ConnectionQuickPickItem extends vscode.QuickPickItem {
    connection?: Connection;
    custom?: boolean;
    running?: boolean;
}

let activeSession: TinkerSession | undefined;

export function activate(context: vscode.ExtensionContext): void {
    const output = vscode.window.createOutputChannel('OpenTinker');
    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 40);
    statusBar.command = 'opentinker.focusOutput';

    const config = (): vscode.WorkspaceConfiguration =>
        vscode.workspace.getConfiguration('opentinker');

    const folder = vscode.workspace.workspaceFolders?.[0];
    const scratch = folder
        ? new ScratchManager(folder, config().get<string>('scratchDir', '.tinker'))
        : undefined;

    const store = new RunStore(context.workspaceState);
    const viewProvider = new OpenTinkerViewProvider(scratch, store);

    let panel: OutputPanel | undefined;
    let activeRun: ActiveRun | undefined;
    const lastRuns = new Map<string, { code: string; mode: ExecutionMode; label: string }>();

    const defaultConnection = (): Connection => {
        const mode = config().get<string>('transport', 'auto');
        const service = config().get<string>('docker.service', 'app');

        if (mode === 'local') {
            return { kind: 'local' };
        }

        if (mode === 'docker-compose') {
            return { kind: 'compose', service };
        }

        const hasComposeFile = folder
            ? COMPOSE_FILES.some((file) => existsSync(path.join(folder.uri.fsPath, file)))
            : false;

        return hasComposeFile ? { kind: 'compose', service } : { kind: 'local' };
    };

    const resolveConnection = (): Connection =>
        storedConnection(context.workspaceState) ?? defaultConnection();

    setStatus(statusBar, `idle · ${connectionLabel(resolveConnection())}`);
    viewProvider.setStatus('idle', connectionLabel(resolveConnection()));

    const getPanel = (): OutputPanel => {
        panel ??= OutputPanel.show(context.extensionUri, {
            onAction: (action) => void handlePanelAction(action),
            onDispose: () => {
                panel = undefined;
            },
        });

        return panel;
    };

    const finalize = (result: ResultFrame | undefined): void => {
        if (!activeRun) {
            return;
        }

        const finished = activeRun;
        activeRun = undefined;

        const record: RunRecord = {
            key: finished.key,
            label: finished.label,
            at: Date.now(),
            ms: result?.ms ?? 0,
            ok: result?.ok ?? false,
            statements: result?.statements ?? 0,
        };

        store.set(finished.key, finished.frames.slice(-MAX_STORED_FRAMES), record);
        viewProvider.refresh();
    };

    const onFrame = (frame: WorkerFrame): void => {
        if (frame.type === 'result') {
            panel?.finish(frame);
        } else {
            panel?.push(frame);
        }

        if (activeRun && activeRun.frames.length < MAX_STORED_FRAMES) {
            activeRun.frames.push(frame);
        }

        if (frame.type === 'ready') {
            output.appendLine(
                `ready: PHP ${frame.php}, Laravel ${frame.laravel}, env ${frame.env}, pid ${frame.pid}`,
            );
            viewProvider.setStatus('ready', activeSession?.transportLabel);
        }

        if (frame.type === 'fatal') {
            output.appendLine(`fatal: ${frame.message}`);
        }

        if (frame.type === 'result') {
            finalize(frame);
        }
    };

    const onStatus = (status: SessionStatus, detail?: string): void => {
        setStatus(
            statusBar,
            `${status}${detail ? ` · ${detail}` : ''} · ${connectionLabel(resolveConnection())}`,
        );
        viewProvider.setStatus(status, activeSession?.transportLabel);
        panel?.status(
            `OpenTinker · ${activeSession?.transportLabel ?? ''} · ${status}${detail ? ` · ${detail}` : ''}`,
        );
    };

    const ensureSession = async (): Promise<TinkerSession> => {
        if (!vscode.workspace.isTrusted) {
            throw new Error('OpenTinker needs a trusted workspace to execute code');
        }

        if (activeSession) {
            return activeSession;
        }

        if (!folder) {
            throw new Error('Open a workspace folder containing your Laravel application');
        }

        const workerSource = await readFile(context.asAbsolutePath('worker/worker.php'), 'utf8');
        const storageDir = context.storageUri?.fsPath ?? path.join(folder.uri.fsPath, '.tinker');

        const transportContext: TransportContext = {
            workspaceFolder: folder.uri.fsPath,
            workingDir: config().get<string>('docker.workingDir', '/var/www'),
            phpBinary: config().get<string>('php.binary', 'php'),
            storageDir,
            workerSource,
        };

        const connection = resolveConnection();
        const transport = createTransport(connection, transportContext);
        output.appendLine(`transport: ${transport.label}`);

        activeSession = new TinkerSession(
            transport,
            { onFrame, onStatus },
            config().get<number>('timeoutMs', 30000),
        );

        return activeSession;
    };

    const setConnection = async (connection: Connection): Promise<void> => {
        await context.workspaceState.update(CONNECTION_KEY, connection);
        activeSession?.dispose();
        activeSession = undefined;

        const label = connectionLabel(connection);
        output.appendLine(`connection: ${label}`);
        viewProvider.setStatus('idle', label);
        panel?.status(`OpenTinker · ${label} · idle`);
        setStatus(statusBar, `idle · ${label}`);
    };

    const selectConnection = async (): Promise<void> => {
        if (!folder) {
            void vscode.window.showErrorMessage('OpenTinker needs an open workspace folder.');
            return;
        }

        const current = resolveConnection();
        const items: ConnectionQuickPickItem[] = [];
        const services = await listComposeServices(folder.uri.fsPath);

        if (services.length > 0) {
            items.push({
                label: 'Docker Compose services',
                kind: vscode.QuickPickItemKind.Separator,
            });

            for (const service of services) {
                items.push({
                    label: service.name,
                    description: service.running ? 'running' : 'stopped',
                    iconPath: new vscode.ThemeIcon(
                        service.running ? 'circle-filled' : 'circle-outline',
                    ),
                    picked: current.kind === 'compose' && current.service === service.name,
                    connection: { kind: 'compose', service: service.name },
                    running: service.running,
                });
            }
        } else {
            const containers = await listRunningContainers();

            if (containers.length > 0) {
                items.push({
                    label: 'Running containers',
                    kind: vscode.QuickPickItemKind.Separator,
                });

                for (const container of containers) {
                    items.push({
                        label: container,
                        description: 'docker exec',
                        iconPath: new vscode.ThemeIcon('server-process'),
                        picked: current.kind === 'docker' && current.container === container,
                        connection: { kind: 'docker', container },
                        running: true,
                    });
                }
            }
        }

        items.push({ label: 'Other', kind: vscode.QuickPickItemKind.Separator });
        items.push({
            label: 'Local PHP',
            description: config().get<string>('php.binary', 'php'),
            iconPath: new vscode.ThemeIcon('terminal'),
            picked: current.kind === 'local',
            connection: { kind: 'local' },
            running: true,
        });
        items.push({
            label: 'Docker container…',
            description: 'Enter a container name',
            iconPath: new vscode.ThemeIcon('add'),
            custom: true,
        });

        const picked = await vscode.window.showQuickPick(items, {
            title: 'OpenTinker: where should code run?',
            placeHolder: `Current: ${connectionLabel(current)}`,
        });

        if (!picked) {
            return;
        }

        if (picked.custom) {
            const name = await vscode.window.showInputBox({
                prompt: 'Docker container name',
                placeHolder: 'my-app-1',
            });

            if (!name) {
                return;
            }

            if (!(await containerIsRunning(name))) {
                const action = await vscode.window.showWarningMessage(
                    `Container "${name}" is not running.`,
                    'Show all containers',
                );

                if (action === 'Show all containers') {
                    const terminal = vscode.window.createTerminal('OpenTinker');
                    terminal.show();
                    terminal.sendText('docker ps -a');
                }

                return;
            }

            await setConnection({ kind: 'docker', container: name });
            return;
        }

        if (!picked.connection) {
            return;
        }

        await setConnection(picked.connection);

        if (picked.connection.kind === 'compose' && picked.running === false) {
            const action = await vscode.window.showWarningMessage(
                `Service "${picked.connection.service}" is not running.`,
                'Start it',
            );

            if (action === 'Start it') {
                const terminal = vscode.window.createTerminal('OpenTinker');
                terminal.show();
                terminal.sendText(`docker compose up -d ${picked.connection.service}`);
            }
        }
    };

    const executeRun = async (
        code: string,
        mode: ExecutionMode,
        label: string,
        key: string,
    ): Promise<void> => {
        const currentPanel = getPanel();
        currentPanel.show();
        currentPanel.beginRun(label, Date.now());

        activeRun = { key, label, code, mode, frames: [] };
        lastRuns.set(key, { code, mode, label });

        try {
            const session = await ensureSession();
            await session.exec(code, mode);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            output.appendLine(`error: ${message}`);

            const frame: WorkerFrame = { type: 'fatal', message };
            currentPanel.push(frame);

            if (activeRun) {
                activeRun.frames.push(frame);
            }

            finalize(undefined);
            currentPanel.status('stopped');
        }
    };

    const handlePanelAction = async (action: 'rerun' | 'restart' | 'clear'): Promise<void> => {
        if (action === 'clear') {
            panel?.clear();
            return;
        }

        if (action === 'restart') {
            try {
                await activeSession?.restart();
                panel?.status('session restarted');
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                panel?.push({ type: 'fatal', message });
            }

            return;
        }

        const editor = vscode.window.activeTextEditor;
        const key = editor?.document.uri.toString();
        const last = key ? lastRuns.get(key) : undefined;

        if (!key || !last) {
            panel?.status('nothing to re-run yet');
            return;
        }

        await executeRun(last.code, last.mode, last.label, key);
    };

    const runEditor = async (editor: vscode.TextEditor, forceWholeFile = false): Promise<void> => {
        if (!folder) {
            void vscode.window.showErrorMessage('OpenTinker needs an open workspace folder.');
            return;
        }

        const document = editor.document;
        const isScratch = scratch?.isScratch(document.uri) ?? false;

        const target = resolveRunTarget({
            hasSelection: !editor.selection.isEmpty,
            selectionText: document.getText(editor.selection),
            lineText: document.lineAt(editor.selection.active.line).text,
            lineNumber: editor.selection.active.line + 1,
            fileText: document.getText(),
            isScratch,
            fileName: path.basename(document.fileName),
        });

        if (!target) {
            void vscode.window.showInformationMessage('OpenTinker: nothing to run here.');
            return;
        }

        const mode: ExecutionMode = forceWholeFile
            ? 'file'
            : target.mode === 'file'
              ? config().get<ExecutionMode>('executionMode', 'statements')
              : 'statements';

        await executeRun(target.code, mode, target.label, document.uri.toString());
    };

    const newScratch = async (): Promise<void> => {
        if (!scratch || !folder) {
            void vscode.window.showErrorMessage('OpenTinker needs an open workspace folder.');
            return;
        }

        await scratch.ensureGitignore();
        const uri = await scratch.create();
        await scratch.open(uri, vscode.ViewColumn.One);
        getPanel().show();
        viewProvider.refresh();
    };

    const openScratch = async (uri?: vscode.Uri): Promise<void> => {
        if (!scratch) {
            return;
        }

        if (!uri) {
            const files = await scratch.list();

            if (files.length === 0) {
                await newScratch();
                return;
            }

            const picked = await vscode.window.showQuickPick(
                files.map((file) => ({
                    label: path.basename(file.fsPath),
                    description: vscode.workspace.asRelativePath(file, false),
                    uri: file,
                })),
                { placeHolder: 'Open a scratch file' },
            );

            if (!picked) {
                return;
            }

            uri = picked.uri;
        }

        await scratch.open(uri, vscode.ViewColumn.One);

        const stored = store.get(uri.toString());

        if (stored) {
            getPanel().renderRun(stored.record.label, stored.frames);
        }
    };

    const openRecent = async (record?: RunRecord): Promise<void> => {
        if (!record) {
            return;
        }

        const uri = vscode.Uri.parse(record.key);

        try {
            await vscode.window.showTextDocument(uri, {
                viewColumn: vscode.ViewColumn.One,
                preserveFocus: false,
            });
        } catch {
            void vscode.window.showErrorMessage(`OpenTinker: could not open ${record.label}`);
            return;
        }

        const stored = store.get(record.key);

        if (stored) {
            getPanel().renderRun(stored.record.label, stored.frames);
        }
    };

    context.subscriptions.push(
        output,
        statusBar,
        vscode.window.registerTreeDataProvider('opentinker.main', viewProvider),
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (!event.affectsConfiguration('opentinker')) {
                return;
            }

            activeSession?.dispose();
            activeSession = undefined;

            const label = connectionLabel(resolveConnection());
            viewProvider.setStatus('idle', label);
            setStatus(statusBar, `idle · ${label}`);
        }),
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (!editor || !scratch?.isScratch(editor.document.uri)) {
                return;
            }

            const key = editor.document.uri.toString();

            if (activeRun && activeRun.key !== key) {
                return;
            }

            const stored = store.get(key);

            if (stored) {
                getPanel().renderRun(stored.record.label, stored.frames);
            }
        }),
        vscode.languages.registerCodeLensProvider(
            { language: 'php' },
            {
                provideCodeLenses: (document) => {
                    if (!scratch?.isScratch(document.uri)) {
                        return [];
                    }

                    return [
                        new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
                            title: '▶ Run scratch file',
                            command: 'opentinker.runFile',
                        }),
                    ];
                },
            },
        ),
        vscode.commands.registerCommand('opentinker.run', async () => {
            const editor = vscode.window.activeTextEditor;

            if (editor) {
                await runEditor(editor);
            }
        }),
        vscode.commands.registerCommand('opentinker.runSelection', async () => {
            const editor = vscode.window.activeTextEditor;

            if (editor) {
                await runEditor(editor);
            }
        }),
        vscode.commands.registerCommand('opentinker.runFile', async () => {
            const editor = vscode.window.activeTextEditor;

            if (editor) {
                await runEditor(editor, true);
            }
        }),
        vscode.commands.registerCommand('opentinker.newScratch', () => void newScratch()),
        vscode.commands.registerCommand(
            'opentinker.openScratch',
            (uri?: vscode.Uri) => void openScratch(uri),
        ),
        vscode.commands.registerCommand(
            'opentinker.openRecent',
            (record?: RunRecord) => void openRecent(record),
        ),
        vscode.commands.registerCommand(
            'opentinker.selectConnection',
            () => void selectConnection(),
        ),
        vscode.commands.registerCommand('opentinker.restartSession', async () => {
            try {
                await activeSession?.restart();
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                getPanel().push({ type: 'fatal', message });
            }
        }),
        vscode.commands.registerCommand('opentinker.clearOutput', () => {
            getPanel().clear();
        }),
        vscode.commands.registerCommand('opentinker.focusOutput', () => {
            getPanel().show();
        }),
    );
}

export function deactivate(): void {
    activeSession?.dispose();
    activeSession = undefined;
}

function setStatus(item: vscode.StatusBarItem, text: string): void {
    item.text = `$(beaker) OpenTinker: ${text}`;
    item.tooltip = 'OpenTinker session';
    item.show();
}
