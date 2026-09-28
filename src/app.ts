import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { collectSnippetParameters } from './panels/snippetForm';
import { callableCode, type CallableTarget } from './run/callable';
import {
    NoTargetError,
    RunController,
    type FinishedRun,
    type RunRequest,
} from './run/runController';
import { resolveRunTarget } from './run/target';
import { ScratchManager } from './scratch/scratchManager';
import { TinkerSession } from './session/session';
import type { Transport } from './session/transport';
import { createTransport } from './session/transports';
import { settings } from './settings';
import type {
    HostMessage,
    PanelContext,
    PanelMessage,
    RunView,
    StatementChange,
} from './shared/panelMessages';
import type { RunFrame, ScopeFrame } from './shared/protocol';
import { getImportedSshEndpoint, listImportedSshEndpoints } from './ssh/openVsdbBridge';
import { sameSshSource } from './ssh/types';
import { RunStore, type RunRecord } from './state/runStore';
import { renderSnippet, SnippetStore, type Snippet } from './state/snippetStore';
import {
    detectTargets,
    listComposeServiceNames,
    listRunningContainers,
    obviousChoice,
    type DetectedTarget,
} from './targets/detect';
import {
    isProduction,
    targetDetail,
    targetSummary,
    toLocalPath,
    type Target,
} from './targets/target';
import { TargetStore } from './targets/targetStore';
import { OpenTinkerCodeLens } from './ui/codeLens';
import { InlineResults } from './ui/inlineResults';
import { ProductionBanner } from './ui/productionBanner';
import { ResultsHost } from './ui/resultsHost';
import { StatusBar } from './ui/statusBar';
import { openTargetForm } from './ui/targetForm';
import { OpenTinkerViewProvider } from './views/opentinkerView';

interface Displayed {
    record: RunRecord;
    frames: RunFrame[];
    changes: Record<number, StatementChange>;
    finished: boolean;
}

const KEYMAP_CONFLICTS: Record<string, string> = {
    'k--kato.intellij-idea-keybindings':
        'IntelliJ IDEA Keybindings binds Cmd/Ctrl+Enter to "insert line break".',
};

/**
 * Wires the run controller, targets and all UI surfaces together. Each
 * surface only renders; state lives in the controller and the stores.
 */
export class OpenTinkerApp implements vscode.Disposable {
    readonly output = vscode.window.createOutputChannel('OpenTinker');
    private readonly logOutput = vscode.window.createOutputChannel('OpenTinker: Laravel log');
    readonly folder = vscode.workspace.workspaceFolders?.[0];
    readonly targets: TargetStore;
    readonly store: RunStore;
    readonly scratch?: ScratchManager;
    readonly snippets?: SnippetStore;
    readonly controller: RunController;
    readonly results: ResultsHost;
    readonly statusBar = new StatusBar();
    readonly inline: InlineResults;
    readonly codeLens: OpenTinkerCodeLens;
    readonly banner: ProductionBanner;
    readonly sidebar: OpenTinkerViewProvider;

    private displayed?: Displayed;
    /** The scratch file most recently focused, for run buttons outside the editor. */
    private lastScratch?: vscode.Uri;
    private scope: ScopeFrame | null = null;
    private scopeNote = '';
    private workerSource?: string;
    private booting = new Set<string>();
    private logTimer?: NodeJS.Timeout;
    private detecting?: Promise<Target | undefined>;
    private readonly disposables: vscode.Disposable[] = [];

    constructor(private readonly context: vscode.ExtensionContext) {
        this.targets = new TargetStore(context.workspaceState, {
            workingDir: settings.defaultWorkingDir(),
            phpBinary: settings.phpBinary(),
        });
        this.store = new RunStore(
            context.workspaceState,
            settings.historyLimit(),
            settings.persistResults(),
        );
        if (this.folder) {
            this.scratch = new ScratchManager(this.folder, settings.scratchDir());
            this.snippets = new SnippetStore(this.folder.uri.fsPath, settings.scratchDir());
        }

        this.controller = new RunController({
            workspacePath: this.workspacePath,
            settings: () => settings.run(),
            createTransport: (target) => this.transportFor(target),
            validateTarget: (target) => this.validateTarget(target),
            confirmProduction: (target, environment, writes) =>
                this.confirmProduction(target, environment, writes),
            targetFor: (key) => this.targets.forFile(key || undefined),
            previousSignatures: (key) => this.store.latestForFile(key)?.record.signatures,
            log: (line) => this.output.appendLine(line),
        });

        this.results = new ResultsHost(
            context.extensionUri,
            () => settings.resultsLocation(),
            (message) =>
                void this.handlePanel(message).catch((error: unknown) => this.showError(error)),
            () => this.snapshot(),
        );
        this.inline = new InlineResults(() => settings.inlineResults());
        this.codeLens = new OpenTinkerCodeLens({
            isScratch: (uri) => this.scratch?.isScratch(uri) ?? false,
            targetFor: (uri) => this.targets.forFile(uri.toString()),
            hasOwnTarget: (uri) => !!this.targets.fileOverride(uri.toString()),
            environment: (target) => this.controller.environment(target),
            sessionMode: () => settings.run().sessionMode,
            rollback: () => settings.run().rollback,
        });
        this.banner = new ProductionBanner(
            (uri) => this.scratch?.isScratch(uri) ?? false,
            (uri) => this.targets.forFile(uri.toString()),
            (target) => this.controller.environment(target),
        );
        this.sidebar = new OpenTinkerViewProvider(
            {
                target: () => this.currentTarget(),
                targetForFile: (uri) => this.targets.forFile(uri.toString()),
                hasOwnTarget: (uri) => !!this.targets.fileOverride(uri.toString()),
                environment: (target) => this.controller.environment(target),
                status: () => this.statusText(),
            },
            this.scratch,
            this.store,
            this.snippets,
        );

        this.wireController();
        this.disposables.push(
            this.output,
            this.logOutput,
            this.statusBar,
            this.inline,
            this.banner,
            this.results,
            this.targets.onDidChange(() => this.refreshUi()),
            vscode.window.registerWebviewViewProvider('opentinker.results', this.results, {
                webviewOptions: { retainContextWhenHidden: true },
            }),
            vscode.window.registerTreeDataProvider('opentinker.main', this.sidebar),
            vscode.languages.registerCodeLensProvider({ language: 'php' }, this.codeLens),
            vscode.window.onDidChangeActiveTextEditor(() => this.onEditorChange()),
            vscode.window.onDidChangeVisibleTextEditors(() => this.banner.refresh()),
            vscode.workspace.onDidChangeConfiguration((event) => this.onConfigChange(event)),
            vscode.workspace.onDidSaveTextDocument((document) => {
                if (this.snippets?.isSnippet(document.uri.fsPath)) this.sidebar.refresh();
            }),
            vscode.workspace.onDidGrantWorkspaceTrust(() => this.refreshUi()),
        );
        this.onEditorChange();
        this.refreshUi();
    }

    get workspacePath(): string {
        return this.folder?.uri.fsPath ?? '';
    }

    dispose(): void {
        if (this.logTimer) clearInterval(this.logTimer);
        this.controller.dispose();
        for (const disposable of this.disposables) disposable.dispose();
    }

    // ---- Running -------------------------------------------------------

    /** Runs code, choosing a target first if none is set up yet. */
    async run(request: RunRequest): Promise<FinishedRun | undefined> {
        if (!vscode.workspace.isTrusted) {
            void vscode.window
                .showWarningMessage(
                    'OpenTinker runs code only in trusted workspaces.',
                    'Manage Workspace Trust',
                )
                .then((choice) => {
                    if (choice) void vscode.commands.executeCommand('workbench.trust.manage');
                });
            return undefined;
        }
        if (this.controller.state !== 'idle') {
            const choice = await vscode.window.showInformationMessage(
                'OpenTinker is already running code.',
                'Stop it',
            );
            if (choice) this.controller.stop();
            return undefined;
        }

        if (!request.target && !this.targets.forFile(request.key || undefined)) {
            const target = await this.ensureTarget();
            if (!target) return undefined;
        }

        this.results.show(true);
        try {
            return await this.controller.run(request);
        } catch (error) {
            if (error instanceof NoTargetError) {
                await this.selectTarget();
                return undefined;
            }
            this.showStartError(error);
            return undefined;
        }
    }

    async runEditor(editor: vscode.TextEditor, mode: 'auto' | 'file' | 'selection'): Promise<void> {
        const document = editor.document;
        if (document.languageId !== 'php') {
            void vscode.window.showInformationMessage('OpenTinker runs PHP files.');
            return;
        }
        const isScratch = this.scratch?.isScratch(document.uri) ?? false;
        const fileName = path.basename(document.fileName);

        if (mode === 'file' || (mode === 'auto' && isScratch && editor.selection.isEmpty)) {
            const code = document.getText();
            if (!code.trim()) {
                void vscode.window.showInformationMessage('This file is empty.');
                return;
            }
            await this.run({
                code,
                mode: isScratch ? settings.executionMode() : 'file',
                label: fileName,
                key: document.uri.toString(),
                sourceLine: 1,
            });
            return;
        }

        const target = resolveRunTarget({
            hasSelection: !editor.selection.isEmpty,
            selectionText: document.getText(editor.selection),
            lineText: document.lineAt(editor.selection.active.line).text,
            lineNumber: editor.selection.active.line + 1,
            fileText: document.getText(),
            isScratch: false,
            fileName,
        });
        if (!target?.code.trim()) {
            void vscode.window.showInformationMessage('Nothing to run on this line.');
            return;
        }
        const sourceLine =
            target.mode === 'selection'
                ? editor.selection.start.line + 1
                : editor.selection.active.line + 1;
        await this.run({
            code: target.code,
            mode: 'statements',
            label: target.label,
            key: document.uri.toString(),
            sourceLine,
            contextSource: isScratch ? undefined : document.getText(),
        });
    }

    /**
     * The big Run buttons (status bar, editor toolbar, results panel): runs the
     * active PHP file, or else the scratch file last worked on.
     */
    async runScratch(): Promise<void> {
        const active = vscode.window.activeTextEditor;
        if (active?.document.languageId === 'php') return this.runEditor(active, 'file');

        const displayedKey = this.displayed?.record.key;
        if (displayedKey && !this.isScratchKey(displayedKey)) return this.rerunDisplayed();

        const uri = displayedKey ? vscode.Uri.parse(displayedKey) : this.lastScratch;
        if (!uri) return this.openTinkerWindow();
        const visible = vscode.window.visibleTextEditors.find(
            (editor) => editor.document.uri.toString() === uri.toString(),
        );
        const editor = visible ?? (await this.scratch?.open(uri));
        if (editor) await this.runEditor(editor, 'file');
    }

    private isScratchKey(key: string): boolean {
        try {
            return this.scratch?.isScratch(vscode.Uri.parse(key)) ?? false;
        } catch {
            return false;
        }
    }

    async runClipboard(): Promise<void> {
        const code = await vscode.env.clipboard.readText();
        if (!code.trim()) {
            void vscode.window.showInformationMessage('The clipboard is empty.');
            return;
        }
        await this.run({ code, mode: 'statements', label: 'Clipboard', key: '', sourceLine: 1 });
    }

    async runCallable(target: CallableTarget): Promise<void> {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(target.key));
        if (document.isDirty) {
            const choice = await vscode.window.showWarningMessage(
                'Save the file first: the app loads the saved version of this class.',
                'Save and run',
            );
            if (choice !== 'Save and run' || !(await document.save())) return;
        }
        await this.run({
            code: callableCode(target),
            mode: 'file',
            label: target.label,
            key: target.key,
            sourceLine: target.line,
        });
    }

    async rerunDisplayed(): Promise<void> {
        const record = this.displayed?.record;
        if (!record?.code) return;
        const saved = this.targets.get(record.targetId);
        await this.run({
            code: record.code,
            mode: record.mode,
            label: record.label,
            key: record.key,
            sourceLine: record.sourceLine,
            imports: record.imports ?? [],
            target: saved,
        });
    }

    // ---- Scratch files, snippets, models --------------------------------

    /** Opens the Tinker window: latest scratch file on the left, results on the right. */
    async openTinkerWindow(): Promise<void> {
        if (!this.requireFolder()) return;
        const [latest] = (await this.scratch?.list()) ?? [];
        const uri = latest ?? (await this.scratch?.create());
        if (!uri) return;
        void this.scratch?.ensureGitignore();
        const editor = await this.scratch?.open(uri, vscode.ViewColumn.One);
        this.results.show(true);
        if (editor) {
            await vscode.window.showTextDocument(editor.document, {
                viewColumn: editor.viewColumn,
                preserveFocus: false,
            });
            this.showStoredRun(uri.toString());
        }
    }

    async newScratch(content?: string, prefix?: string): Promise<vscode.Uri | undefined> {
        if (!this.requireFolder() || !this.scratch) return undefined;
        // Asked in the background: the scratch file opens straight away.
        void this.scratch.ensureGitignore();
        const uri = await this.scratch.create(content, prefix);
        const editor = await this.scratch.open(uri, vscode.ViewColumn.One);
        const end = editor.document.lineAt(editor.document.lineCount - 1).range.end;
        editor.selection = new vscode.Selection(end, end);
        this.results.show(true);
        this.sidebar.refresh();
        void this.checkIntelephense();
        return uri;
    }

    async openScratch(uri?: vscode.Uri): Promise<void> {
        if (!this.scratch) return;
        if (!uri) {
            const files = await this.scratch.list();
            if (!files.length) {
                await this.newScratch();
                return;
            }
            const picked = await vscode.window.showQuickPick(
                files.map((file) => ({
                    label: path.basename(file.fsPath),
                    description: this.targets.fileOverride(file.toString())?.name,
                    uri: file,
                })),
                { placeHolder: 'Open a scratch file' },
            );
            if (!picked) return;
            uri = picked.uri;
        }
        await this.scratch.open(uri, vscode.ViewColumn.One);
    }

    async tinkerModel(className: string): Promise<void> {
        if (!/^[A-Za-z_][\w\\]*$/.test(className)) return;
        const short = className.split('\\').at(-1) ?? className;
        const content = `<?php\n\nuse ${className};\n\n${short}::query()->latest()->first();\n`;
        const uri = await this.newScratch(content, short.toLowerCase());
        const editor = vscode.window.visibleTextEditors.find(
            (item) => item.document.uri.toString() === uri?.toString(),
        );
        if (editor) await this.runEditor(editor, 'file');
    }

    async saveSnippet(): Promise<void> {
        if (!this.snippets) return;
        const editor = vscode.window.activeTextEditor;
        const selected =
            editor?.document.languageId === 'php' && !editor.selection.isEmpty
                ? editor.document.getText(editor.selection)
                : undefined;
        const code =
            selected ||
            (editor && this.scratch?.isScratch(editor.document.uri)
                ? editor.document.getText()
                : '') ||
            this.displayed?.record.code ||
            '';
        if (!code.trim()) {
            void vscode.window.showInformationMessage(
                'Select or run some PHP first, then save it as a snippet.',
            );
            return;
        }
        const name = await vscode.window.showInputBox({
            title: 'Save snippet (1/2): name',
            prompt: 'Snippets are saved in .tinker/snippets so your team can share them.',
            value: this.displayed?.record.label.replace(/\.php$/, '') ?? '',
            validateInput: (value) => (value.trim() ? undefined : 'Enter a name'),
        });
        if (!name) return;
        const description = await vscode.window.showInputBox({
            title: 'Save snippet (2/2): description',
            prompt: 'Optional. Use {{name}}, {{id:number}}, {{flag:bool}} or {{data:json}} in the code for inputs.',
        });
        if (description === undefined) return;
        const snippet = await this.snippets.save(name, code, description);
        this.sidebar.refresh();
        if (snippet.file)
            await vscode.window.showTextDocument(vscode.Uri.file(snippet.file), {
                viewColumn: vscode.ViewColumn.One,
            });
    }

    async runSnippet(provided?: Snippet): Promise<void> {
        const snippet = provided ?? (await this.pickSnippet('Run snippet'));
        if (!snippet) return;
        const fresh =
            (await this.snippets?.list())?.find((item) => item.id === snippet.id) ?? snippet;
        const values = await collectSnippetParameters(fresh);
        if (!values) return;
        try {
            await this.run({
                code: renderSnippet(fresh, values),
                mode: 'statements',
                label: fresh.name,
                key: '',
                sourceLine: 1,
            });
        } catch (error) {
            this.showError(error);
        }
    }

    async openSnippet(provided?: Snippet): Promise<void> {
        const snippet = provided ?? (await this.pickSnippet('Edit snippet'));
        if (snippet?.file)
            await vscode.window.showTextDocument(vscode.Uri.file(snippet.file), {
                viewColumn: vscode.ViewColumn.One,
            });
    }

    async generateModelHints(): Promise<void> {
        const target = await this.targetOrAsk();
        if (!target || !this.scratch) return;
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'OpenTinker: reading your models',
            },
            async () => {
                try {
                    const session = await this.controller.sessionFor(target);
                    const hints = await session.modelHints();
                    if (!hints.count) {
                        void vscode.window.showWarningMessage(
                            `No Eloquent models found in app/Models.${hints.skipped.length ? ' ' + hints.skipped[0] : ''}`,
                        );
                        return;
                    }
                    await this.scratch?.ensureDirectory();
                    const file = path.join(this.scratch?.directory ?? '', '_ide_helper_models.php');
                    await writeFile(file, hints.php, 'utf8');
                    void vscode.window.showInformationMessage(
                        `Model hints written for ${hints.count} models. $user-> now completes real columns in scratch files.`,
                    );
                    void this.checkIntelephense(true);
                } catch (error) {
                    this.showError(error);
                }
            },
        );
    }

    // ---- Targets ---------------------------------------------------------

    currentTarget(): Target | undefined {
        const editor = vscode.window.activeTextEditor;
        const key =
            editor && this.scratch?.isScratch(editor.document.uri)
                ? editor.document.uri.toString()
                : undefined;
        return this.targets.forFile(key);
    }

    /** The first-run path: detect, pick the obvious target silently, or ask. */
    async ensureTarget(): Promise<Target | undefined> {
        if (!this.requireFolder()) return undefined;
        this.detecting ??= this.detectAndChoose().finally(() => {
            this.detecting = undefined;
        });
        return this.detecting;
    }

    private async detectAndChoose(): Promise<Target | undefined> {
        const candidates = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Window, title: 'OpenTinker: finding your app' },
            () => detectTargets(this.workspacePath),
        );
        const obvious = obviousChoice(candidates);
        if (obvious) {
            await this.adopt(obvious.target);
            void vscode.window
                .showInformationMessage(
                    `OpenTinker will run code in ${obvious.target.name} (${obvious.reason.toLowerCase()}).`,
                    'Change',
                )
                .then((choice) => {
                    if (choice) void this.selectTarget();
                });
            return obvious.target;
        }
        if (candidates.length)
            return this.pickTarget({
                detected: candidates,
                title: 'Where should OpenTinker run code?',
            });
        void vscode.window.showInformationMessage(
            'OpenTinker could not find your app automatically. Tell it where the app runs.',
        );
        await this.editTarget();
        return undefined;
    }

    async selectTarget(forFile?: vscode.Uri): Promise<void> {
        if (!this.requireFolder()) return;
        await this.pickTarget({
            forFile,
            title: forFile
                ? `Where should ${path.basename(forFile.fsPath)} run?`
                : 'Where should OpenTinker run code?',
        });
    }

    private async pickTarget(options: {
        forFile?: vscode.Uri;
        detected?: DetectedTarget[];
        title: string;
    }): Promise<Target | undefined> {
        type Item = vscode.QuickPickItem & {
            target?: Target;
            detected?: DetectedTarget;
            action?: 'new' | 'default' | 'detect';
        };
        const picker = vscode.window.createQuickPick<Item>();
        picker.title = options.title;
        picker.placeholder = 'Pick a target, or add a new one';
        picker.matchOnDescription = true;
        const edit: vscode.QuickInputButton = {
            iconPath: new vscode.ThemeIcon('gear'),
            tooltip: 'Edit target',
        };
        const current = options.forFile
            ? this.targets.fileOverride(options.forFile.toString())
            : this.targets.active();
        let detected = options.detected;

        const render = (): void => {
            const saved = this.targets.all();
            const items: Item[] = saved.map((target) => ({
                label: `${target.id === current?.id ? '$(check) ' : ''}${target.name}`,
                description: `${targetSummary(target)}${target.kind === 'local' ? '' : ' · ' + target.workingDir}`,
                detail:
                    isProduction(this.controller.environment(target)) ||
                    isProduction(target.environment)
                        ? '$(warning) production'
                        : undefined,
                target,
                buttons: [edit],
            }));
            const fresh = (detected ?? []).filter(
                (candidate) => !saved.some((target) => sameRuntime(target, candidate.target)),
            );
            if (fresh.length) {
                items.push({
                    label: 'Found in this project',
                    kind: vscode.QuickPickItemKind.Separator,
                });
                for (const candidate of fresh) {
                    items.push({
                        label: `$(search) ${candidate.target.name}`,
                        description: `${targetSummary(candidate.target)}${candidate.running ? '' : ' · stopped'}`,
                        detail: candidate.reason,
                        detected: candidate,
                    });
                }
            }
            items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
            if (!detected)
                items.push({
                    label: '$(search) Look for targets in this project',
                    action: 'detect',
                });
            items.push({
                label: '$(add) New target…',
                description: 'Docker, local PHP or SSH',
                action: 'new',
            });
            if (options.forFile && this.targets.fileOverride(options.forFile.toString())) {
                items.push({ label: '$(discard) Use the workspace default', action: 'default' });
            }
            picker.items = items;
        };

        render();
        if (!detected) {
            picker.busy = true;
            void detectTargets(this.workspacePath).then((found) => {
                detected = found;
                picker.busy = false;
                render();
            });
        }

        return new Promise((resolve) => {
            let settled = false;
            const done = (target: Target | undefined): void => {
                if (settled) return;
                settled = true;
                resolve(target);
                picker.hide();
            };
            picker.onDidTriggerItemButton(({ item }) => {
                if (item.target) {
                    done(undefined);
                    void this.editTarget(item.target);
                }
            });
            picker.onDidAccept(async () => {
                const [item] = picker.selectedItems;
                if (!item) return;
                if (item.action === 'new') {
                    done(undefined);
                    await this.editTarget();
                    return;
                }
                if (item.action === 'detect') {
                    picker.busy = true;
                    detected = await detectTargets(this.workspacePath);
                    picker.busy = false;
                    render();
                    return;
                }
                if (item.action === 'default' && options.forFile) {
                    await this.targets.setForFile(options.forFile.toString(), undefined);
                    done(this.targets.active());
                    return;
                }
                const target = item.target ?? item.detected?.target;
                if (!target) return;
                if (item.detected) await this.targets.save(target);
                if (options.forFile)
                    await this.targets.setForFile(options.forFile.toString(), target.id);
                else await this.targets.setActive(target.id);
                done(target);
            });
            picker.onDidHide(() => {
                done(undefined);
                picker.dispose();
            });
            picker.show();
        });
    }

    async editTarget(existing?: Target): Promise<void> {
        const [services, containers, endpoints] = await Promise.all([
            listComposeServiceNames(this.workspacePath),
            listRunningContainers(),
            listImportedSshEndpoints().catch(() => undefined),
        ]);
        openTargetForm({
            existing,
            services,
            containers,
            endpoints: endpoints ?? [],
            defaultWorkingDir: settings.defaultWorkingDir(),
            test: (target) => this.testTarget(target),
            save: async (target, use) => {
                await this.targets.save(target);
                this.controller.invalidate(target.id);
                if (use || !this.targets.active()) await this.targets.setActive(target.id);
                void vscode.window.showInformationMessage(`Saved target ${target.name}.`);
            },
            remove: async (target) => {
                this.controller.invalidate(target.id);
                await this.targets.remove(target.id);
            },
        });
    }

    private async adopt(target: Target): Promise<void> {
        await this.targets.save(target);
        await this.targets.setActive(target.id);
    }

    private async targetOrAsk(): Promise<Target | undefined> {
        return this.currentTarget() ?? (await this.ensureTarget());
    }

    /** Starts a throwaway worker to prove a target works, and explains failures. */
    async testTarget(target: Target): Promise<{ ok: boolean; text: string }> {
        const session = new TinkerSession(await this.transportFor(target), {
            onFrame: () => undefined,
            onStatus: () => undefined,
        });
        const started = Date.now();
        try {
            await this.validateTarget(target);
            await session.ensureStarted();
            const info = session.readyInfo;
            if (!info) throw new Error('The worker did not report its environment.');
            const lines = [
                `Connected in ${((Date.now() - started) / 1000).toFixed(1)} s`,
                `PHP ${info.php} · ${info.laravel ? `Laravel ${info.laravel}` : info.framework} · PsySH ${info.psysh ?? '?'}`,
                `APP_ENV: ${info.env}${isProduction(info.env) ? '  ⚠ production' : ''}`,
                `Project: ${info.basePath}`,
                info.capabilities?.fork
                    ? 'Fresh sessions: fast (each run forks from the booted app)'
                    : 'Fresh sessions: restart PHP each run (pcntl is not available)',
                info.capabilities?.database
                    ? 'Database: available (rollback supported)'
                    : 'Database: not configured',
            ];
            return { ok: true, text: `✓ ${lines.join('\n')}` };
        } catch (error) {
            return { ok: false, text: `✗ ${explain(error, target)}` };
        } finally {
            session.dispose();
        }
    }

    // ---- Checks ------------------------------------------------------------

    async doctor(): Promise<void> {
        const report: string[] = ['OpenTinker setup check', ''];
        const problems: string[] = [];
        const add = (ok: boolean, text: string): void => {
            report.push(`${ok ? '✓' : '✗'} ${text}`);
            if (!ok) problems.push(text);
        };

        add(
            vscode.workspace.isTrusted,
            vscode.workspace.isTrusted
                ? 'Workspace is trusted'
                : 'Workspace is not trusted, so code cannot run',
        );
        const target = await this.targetOrAsk();
        add(
            !!target,
            target ? `Target: ${target.name} (${targetSummary(target)})` : 'No target selected',
        );
        if (target) {
            const result = await this.testTarget(target);
            report.push(...result.text.split('\n').map((line) => `  ${line}`));
            if (!result.ok) problems.push(`Could not start ${target.name}`);
        }

        for (const [id, why] of Object.entries(KEYMAP_CONFLICTS)) {
            if (vscode.extensions.getExtension(id)) {
                add(false, `${why} Add a user keybinding so Cmd/Ctrl+Enter runs scratch files.`);
            }
        }
        if (vscode.extensions.getExtension('xdebug.php-debug')) {
            report.push(
                'ℹ The Xdebug "Run PHP File" button runs host PHP without your app. In scratch files, use OpenTinker’s ▶ button or Cmd/Ctrl+Enter.',
            );
        }
        const excluded = this.intelephenseExcludes();
        add(
            !excluded,
            excluded
                ? `Intelephense excludes ${excluded}, so scratch files get no completion`
                : 'Intelephense indexes scratch files',
        );

        this.output.appendLine(report.join('\n'));
        this.output.appendLine('');
        this.output.show(true);

        const actions = problems.some((problem) => problem.includes('keybinding'))
            ? ['Copy keybinding']
            : [];
        const choice = await (problems.length
            ? vscode.window.showWarningMessage(
                  `OpenTinker: ${problems.length} ${problems.length === 1 ? 'thing needs' : 'things need'} attention. Details are in the output.`,
                  ...actions,
              )
            : vscode.window.showInformationMessage('OpenTinker: everything looks good.'));
        if (choice === 'Copy keybinding') {
            await vscode.env.clipboard.writeText(
                JSON.stringify(
                    {
                        key: process.platform === 'darwin' ? 'cmd+enter' : 'ctrl+enter',
                        command: 'opentinker.run',
                        when: 'editorTextFocus && opentinker.isScratch',
                    },
                    null,
                    4,
                ),
            );
            await vscode.commands.executeCommand('workbench.action.openGlobalKeybindingsFile');
            void vscode.window.showInformationMessage(
                'Paste the copied keybinding into the list in keybindings.json.',
            );
        }
    }

    private intelephenseExcludes(): string | undefined {
        const excludes =
            vscode.workspace.getConfiguration('intelephense').get<string[]>('files.exclude') ?? [];
        const dir = settings.scratchDir();
        return excludes.find(
            (pattern) => pattern.includes(dir) || pattern === '**/.*/**' || pattern === '**/.*',
        );
    }

    private async checkIntelephense(force = false): Promise<void> {
        const key = 'opentinker.intelephenseChecked';
        if (!force && this.context.workspaceState.get<boolean>(key)) return;
        await this.context.workspaceState.update(key, true);
        const excluded = this.intelephenseExcludes();
        if (!excluded) return;
        const choice = await vscode.window.showWarningMessage(
            `Intelephense excludes "${excluded}", so scratch files won't get completion.`,
            'Open settings',
        );
        if (choice)
            await vscode.commands.executeCommand(
                'workbench.action.openSettings',
                'intelephense.files.exclude',
            );
    }

    // ---- Log tail ------------------------------------------------------------

    async showLogs(): Promise<void> {
        const target = await this.targetOrAsk();
        if (!target) return;
        const poll = async (): Promise<void> => {
            if (this.controller.state !== 'idle') return;
            try {
                const session = await this.controller.sessionFor(target);
                const frame = await session.readLog();
                this.logOutput.replace(
                    `${target.name} · ${frame.path || 'No log file found'}\n\n${frame.lines || 'The log is empty.'}`,
                );
            } catch (error) {
                this.logOutput.replace(
                    `Could not read the log: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        };
        await poll();
        this.logOutput.show(true);
        if (this.logTimer) clearInterval(this.logTimer);
        this.logTimer = setInterval(() => void poll(), 3000);
    }

    stopLogs(): void {
        if (this.logTimer) clearInterval(this.logTimer);
        this.logTimer = undefined;
        this.logOutput.appendLine('\nStopped following the log.');
    }

    // ---- History -------------------------------------------------------------

    async openRecent(record?: RunRecord): Promise<void> {
        if (!record) return;
        if (record.key.startsWith('file:')) {
            try {
                await vscode.window.showTextDocument(vscode.Uri.parse(record.key), {
                    viewColumn: vscode.ViewColumn.One,
                    preview: false,
                });
            } catch {
                await vscode.window.showTextDocument(
                    await vscode.workspace.openTextDocument({
                        language: 'php',
                        content: record.code,
                    }),
                );
            }
        }
        const stored = this.store.get(record.id);
        if (stored) this.display(stored.record, stored.frames, {}, true);
        this.results.show(true);
    }

    searchHistory(): void {
        const picker = vscode.window.createQuickPick<
            vscode.QuickPickItem & { record: RunRecord }
        >();
        picker.title = 'OpenTinker: search run history';
        picker.placeholder = 'Search code, file, target or environment';
        const update = (query: string): void => {
            picker.items = this.store.recentRuns(query).map((record) => ({
                label: `${record.ok ? '$(pass)' : '$(error)'} ${record.label}`,
                description: `${new Date(record.at).toLocaleString()} · ${record.environment}`,
                detail: `${record.target} · ${record.code.replaceAll('\n', ' ').slice(0, 140)}`,
                alwaysShow: true,
                record,
            }));
        };
        update('');
        picker.onDidChangeValue(update);
        picker.onDidAccept(() => {
            const record = picker.selectedItems[0]?.record;
            picker.hide();
            if (record) void this.openRecent(record);
        });
        picker.onDidHide(() => picker.dispose());
        picker.show();
    }

    async clearHistory(): Promise<void> {
        const choice = await vscode.window.showWarningMessage(
            'Clear OpenTinker run history for this workspace?',
            { modal: true },
            'Clear history',
        );
        if (choice !== 'Clear history') return;
        await this.store.clear();
        this.sidebar.refresh();
    }

    // ---- Settings toggles ------------------------------------------------------

    async toggleSessionMode(): Promise<void> {
        const next = settings.run().sessionMode === 'fresh' ? 'keep' : 'fresh';
        await settings.setSessionMode(next);
        void vscode.window.setStatusBarMessage(
            next === 'fresh'
                ? 'OpenTinker: each run starts fresh'
                : 'OpenTinker: variables now carry over between runs',
            3000,
        );
    }

    async toggleRollback(): Promise<void> {
        const next = !settings.run().rollback;
        await settings.setRollback(next);
        void vscode.window.setStatusBarMessage(
            next
                ? 'OpenTinker: database changes will be rolled back'
                : 'OpenTinker: database changes will be kept',
            3000,
        );
    }

    async restartSession(): Promise<void> {
        const target = this.targets.get(this.displayed?.record.targetId) ?? this.currentTarget();
        try {
            await this.controller.restartSession(target);
            this.scope = null;
            this.scopeNote = 'Session reset.';
            this.results.post({ kind: 'scope', scope: null, note: this.scopeNote });
            void vscode.window.setStatusBarMessage('OpenTinker: session reset', 3000);
        } catch (error) {
            this.showError(error);
        }
    }

    clearResults(): void {
        if (this.controller.state !== 'idle') return;
        this.displayed = undefined;
        this.results.post({ kind: 'clear' });
    }

    // ---- Internals -------------------------------------------------------------

    private wireController(): void {
        const { controller } = this;
        this.disposables.push(
            controller.onDidChangeState.event((state) => {
                void vscode.commands.executeCommand(
                    'setContext',
                    'opentinker.running',
                    state !== 'idle',
                );
                this.refreshUi();
            }),
            controller.onDidStartRun.event((run) => {
                this.display(run.record, [], {}, false);
                this.inline.begin(run.record.key);
            }),
            controller.onDidReceiveFrame.event(({ run, frame }) => {
                if (this.displayed?.record.id === run.record.id) {
                    this.displayed.frames = run.frames;
                    this.results.post({ kind: 'frame', frame });
                }
                this.inline.add(run.record.key, run.record.sourceLine, frame);
            }),
            controller.onDidReceiveScope.event(({ scope }) => {
                this.scope = scope;
                this.scopeNote = '';
                this.results.post({ kind: 'scope', scope });
            }),
            controller.onDidFinishRun.event((finished) => {
                if (this.displayed?.record.id === finished.record.id) {
                    this.displayed = {
                        record: finished.record,
                        frames: finished.frames,
                        changes: finished.changes,
                        finished: true,
                    };
                    this.results.post({
                        kind: 'finish',
                        result: finished.result,
                        changes: finished.changes,
                    });
                }
                void this.store
                    .add(finished.record, finished.frames)
                    .catch((error: unknown) =>
                        this.output.appendLine(`History save failed: ${String(error)}`),
                    )
                    .finally(() => this.sidebar.refresh());
            }),
            controller.onDidChangeSession.event(({ target, status }) => {
                if (status === 'starting') this.booting.add(target.id);
                else this.booting.delete(target.id);
                this.refreshUi();
            }),
        );
    }

    private display(
        record: RunRecord,
        frames: RunFrame[],
        changes: Record<number, StatementChange>,
        finished: boolean,
    ): void {
        this.displayed = { record, frames, changes, finished };
        this.results.setTitle(record.label);
        if (finished)
            this.results.post({ kind: 'render', run: this.runView(record), frames, changes });
        else this.results.post({ kind: 'begin', run: this.runView(record) });
    }

    private showStoredRun(key: string): void {
        if (this.controller.state !== 'idle' || this.displayed?.record.key === key) return;
        const stored = this.store.latestForFile(key);
        if (stored) this.display(stored.record, stored.frames, {}, true);
    }

    private runView(record: RunRecord): RunView {
        return {
            id: record.id,
            label: record.label,
            code: record.code,
            imports: record.imports ?? [],
            sourceLine: record.sourceLine,
            hasSource: record.key.startsWith('file:') || record.key.startsWith('untitled:'),
            scratch: this.isScratchKey(record.key),
            target: record.target,
            targetName: this.targets.get(record.targetId)?.name ?? record.target,
            environment: record.environment,
            sessionMode: record.sessionMode ?? 'keep',
            rollback: record.rollback ?? false,
            at: record.at,
        };
    }

    private panelContext(): PanelContext {
        const target = this.targets.get(this.displayed?.record.targetId) ?? this.currentTarget();
        const run = settings.run();
        return {
            targetName: target?.name ?? 'No target',
            targetDetail: target ? targetDetail(target, this.workspacePath) : '',
            environment: target ? this.controller.environment(target) : 'unknown',
            sessionMode: run.sessionMode,
            rollback: run.rollback,
            state: this.controller.state,
            fork: this.controller.info(target)?.capabilities?.fork ?? true,
            hasTarget: !!target,
            scratchName: this.lastScratch ? path.basename(this.lastScratch.fsPath) : '',
        };
    }

    /** Everything a freshly created results view needs to catch up. */
    private snapshot(): HostMessage[] {
        const messages: HostMessage[] = [{ kind: 'context', context: this.panelContext() }];
        const shown = this.displayed;
        if (shown) {
            if (shown.finished) {
                messages.push({
                    kind: 'render',
                    run: this.runView(shown.record),
                    frames: shown.frames,
                    changes: shown.changes,
                });
            } else {
                messages.push({ kind: 'begin', run: this.runView(shown.record) });
                for (const frame of shown.frames) messages.push({ kind: 'frame', frame });
            }
        }
        messages.push({ kind: 'scope', scope: this.scope, note: this.scopeNote });
        return messages;
    }

    private async handlePanel(message: PanelMessage): Promise<void> {
        switch (message.kind) {
            case 'action':
                switch (message.action) {
                    case 'rerun':
                        return this.rerunDisplayed();
                    case 'run':
                        return this.runScratch();
                    case 'stop':
                        return this.controller.stop();
                    case 'restartSession':
                        return this.restartSession();
                    case 'clear':
                        return this.clearResults();
                    case 'toggleMode':
                        return this.toggleSessionMode();
                    case 'toggleRollback':
                        return this.toggleRollback();
                    case 'chooseTarget': {
                        const editor = vscode.window.visibleTextEditors.find((item) =>
                            this.scratch?.isScratch(item.document.uri),
                        );
                        return this.selectTarget(
                            editor && this.targets.fileOverride(editor.document.uri.toString())
                                ? editor.document.uri
                                : undefined,
                        );
                    }
                    case 'refreshScope': {
                        const target =
                            this.targets.get(this.displayed?.record.targetId) ??
                            this.currentTarget();
                        const scope = target
                            ? await this.controller.scope(target).catch(() => undefined)
                            : undefined;
                        if (scope) {
                            this.scope = scope;
                            this.results.post({ kind: 'scope', scope });
                        }
                        return;
                    }
                    case 'newScratch':
                        await this.newScratch();
                        return;
                }
                return;
            case 'openLine': {
                const key = this.displayed?.record.key;
                if (!key) return;
                const editor = await vscode.window.showTextDocument(vscode.Uri.parse(key), {
                    viewColumn: vscode.ViewColumn.One,
                });
                reveal(editor, message.line);
                return;
            }
            case 'openFile': {
                const target =
                    this.targets.get(this.displayed?.record.targetId) ?? this.currentTarget();
                const local = target
                    ? toLocalPath(target, message.file, this.workspacePath)
                    : undefined;
                if (!local || !existsSync(local)) {
                    void vscode.window.showInformationMessage(
                        `That file is inside the runtime: ${message.file}`,
                    );
                    return;
                }
                const editor = await vscode.window.showTextDocument(vscode.Uri.file(local), {
                    viewColumn: vscode.ViewColumn.One,
                });
                if (message.line) reveal(editor, message.line);
                return;
            }
            case 'copy':
                await vscode.env.clipboard.writeText(message.text);
                void vscode.window.setStatusBarMessage('Copied', 2000);
                return;
            case 'save': {
                const uri = await vscode.window.showSaveDialog({
                    defaultUri: vscode.Uri.joinPath(
                        this.folder?.uri ?? vscode.Uri.file(process.cwd()),
                        message.filename,
                    ),
                });
                if (uri)
                    await vscode.workspace.fs.writeFile(uri, Buffer.from(message.content, 'utf8'));
                return;
            }
            default:
                return;
        }
    }

    private refreshUi(): void {
        const target = this.currentTarget();
        const run = settings.run();
        this.statusBar.update({
            target,
            environment: target ? this.controller.environment(target) : '',
            state: this.controller.state,
            sessionMode: run.sessionMode,
            rollback: run.rollback,
            booting: target ? this.booting.has(target.id) : false,
            scratchName: this.activeScratchName(),
        });
        this.results.post({ kind: 'context', context: this.panelContext() });
        this.codeLens.refresh();
        this.banner.refresh();
        this.sidebar.refresh();
    }

    private statusText(): string {
        const state = this.controller.state;
        if (state !== 'idle') return state;
        const target = this.currentTarget();
        if (target && this.booting.has(target.id)) return 'starting';
        return this.controller.info(target) ? 'ready' : '';
    }

    private activeScratchName(): string | undefined {
        const editor = vscode.window.activeTextEditor;
        return editor && this.scratch?.isScratch(editor.document.uri)
            ? path.basename(editor.document.fileName)
            : undefined;
    }

    private onEditorChange(): void {
        const editor = vscode.window.activeTextEditor;
        const isScratch = !!editor && (this.scratch?.isScratch(editor.document.uri) ?? false);
        void vscode.commands.executeCommand('setContext', 'opentinker.isScratch', isScratch);
        if (isScratch && editor) {
            this.lastScratch = editor.document.uri;
            this.showStoredRun(editor.document.uri.toString());
        }
        this.refreshUi();
    }

    private onConfigChange(event: vscode.ConfigurationChangeEvent): void {
        if (!event.affectsConfiguration('opentinker')) return;
        if (
            event.affectsConfiguration('opentinker.bootstrap') ||
            event.affectsConfiguration('opentinker.php.binary') ||
            event.affectsConfiguration('opentinker.ssh.phpBinary')
        ) {
            this.controller.invalidateAll();
        }
        if (event.affectsConfiguration('opentinker.results.location') && this.displayed)
            this.results.show(true);
        this.refreshUi();
    }

    private async transportFor(target: Target): Promise<Transport> {
        this.workerSource ??= await readFile(
            this.context.asAbsolutePath(path.join('dist', 'worker.php')),
            'utf8',
        );
        const storage = this.context.storageUri ?? this.context.globalStorageUri;
        return createTransport(
            target,
            {
                workspaceFolder: this.workspacePath,
                workingDir: target.kind === 'local' ? this.workspacePath : target.workingDir,
                phpBinary:
                    target.phpBinary ||
                    (target.kind === 'ssh' ? settings.sshPhpBinary() : settings.phpBinary()),
                storageDir: storage.fsPath,
                workerSource: this.workerSource,
                bootstrap: target.bootstrap || settings.bootstrap(),
            },
            target.kind === 'ssh' ? target.source : undefined,
        );
    }

    private async validateTarget(target: Target): Promise<void> {
        if (target.kind !== 'ssh' || !target.source) return;
        const current = await getImportedSshEndpoint(target.source.id);
        if (!current || !sameSshSource(target.source, current)) {
            throw new Error(
                `The OpenVSDB connection "${target.source.name}" changed or was removed. Edit the target "${target.name}" to confirm its details.`,
            );
        }
    }

    private async confirmProduction(
        target: Target,
        environment: string,
        writes: string[],
    ): Promise<boolean> {
        const rollback = settings.run().rollback;
        const detail = [
            `${target.name} (${targetSummary(target)}) reports APP_ENV=${environment}.`,
            writes.length ? `This code looks like it will ${joinList(writes)}.` : '',
            rollback
                ? 'Database changes will be rolled back; mail, queues, files and external calls will not.'
                : '',
        ]
            .filter(Boolean)
            .join('\n\n');
        const choice = await vscode.window.showWarningMessage(
            'Run this on PRODUCTION?',
            { modal: true, detail },
            'Run on production',
        );
        return choice === 'Run on production';
    }

    private async pickSnippet(title: string): Promise<Snippet | undefined> {
        const available = (await this.snippets?.list()) ?? [];
        if (!available.length) {
            void vscode.window.showInformationMessage(
                'No snippets yet. Select some PHP and run "OpenTinker: Save Snippet".',
            );
            return undefined;
        }
        const picked = await vscode.window.showQuickPick(
            available.map((snippet) => ({
                label: snippet.name,
                description: snippet.parameters.length
                    ? `${snippet.parameters.length} inputs`
                    : snippet.description,
                detail: snippet.code
                    .replace(/^<\?php\s*/, '')
                    .replace(/\/\*\*[\s\S]*?\*\/\s*/, '')
                    .replaceAll('\n', ' ')
                    .slice(0, 140),
                snippet,
            })),
            { title, matchOnDetail: true, placeHolder: 'Search snippets' },
        );
        return picked?.snippet;
    }

    private requireFolder(): boolean {
        if (this.folder) return true;
        void vscode.window.showErrorMessage('Open your project folder to use OpenTinker.');
        return false;
    }

    private showStartError(error: unknown): void {
        const target = this.currentTarget();
        const message = target
            ? explain(error, target)
            : error instanceof Error
              ? error.message
              : String(error);
        this.output.appendLine(`start failed: ${message}`);
        void vscode.window
            .showErrorMessage(`OpenTinker: ${message}`, 'Check setup', 'Change target')
            .then((choice) => {
                if (choice === 'Check setup') void this.doctor();
                if (choice === 'Change target') void this.selectTarget();
            });
    }

    showError(error: unknown): void {
        void vscode.window.showErrorMessage(
            `OpenTinker: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}

function reveal(editor: vscode.TextEditor, line: number): void {
    const index = Math.min(Math.max(0, line - 1), editor.document.lineCount - 1);
    editor.selection = new vscode.Selection(index, 0, index, 0);
    editor.revealRange(editor.selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

function sameRuntime(a: Target, b: Target): boolean {
    if (a.kind !== b.kind) return false;
    if (a.kind === 'compose' && b.kind === 'compose') return a.service === b.service;
    if (a.kind === 'docker' && b.kind === 'docker') return a.container === b.container;
    if (a.kind === 'ssh' && b.kind === 'ssh')
        return a.host === b.host && a.user === b.user && a.port === b.port;
    return a.kind === 'local';
}

function joinList(items: string[]): string {
    if (items.length < 2) return items.join('');
    return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/** Turns common start-up failures into a next step. */
export function explain(error: unknown, target: Target): string {
    const message = error instanceof Error ? error.message : String(error);
    const lower = message.toLowerCase();
    if (
        target.kind === 'compose' &&
        (lower.includes('no such service') ||
            lower.includes('is not running') ||
            (lower.includes('service') && lower.includes('not running')))
    ) {
        return `${message}\nStart it with: docker compose up -d ${target.service}`;
    }
    if (lower.includes('cannot connect to the docker daemon') || lower.includes('docker daemon')) {
        return `${message}\nIs Docker running?`;
    }
    if (lower.includes('vendor/autoload.php')) {
        return `${message}\nCheck the target's project path${target.kind === 'local' ? '' : ` (${target.workingDir})`} and that composer install has run.`;
    }
    if (lower.includes('host key verification failed')) {
        return `${message}\nConnect once with ssh ${target.kind === 'ssh' ? `${target.user}@${target.host}` : ''} in a terminal to trust the host key.`;
    }
    if (lower.includes('permission denied (publickey')) {
        return `${message}\nAdd your key to the SSH agent (ssh-add) or set the key file on the target.`;
    }
    if (lower.includes('enoent') && lower.includes('spawn')) {
        return `${message}\n${target.kind === 'local' ? 'Is PHP installed and on your PATH?' : 'Is the docker/ssh command installed?'}`;
    }
    return message;
}
