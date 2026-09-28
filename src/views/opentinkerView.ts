import * as vscode from 'vscode';
import type { ScratchManager } from '../scratch/scratchManager';
import type { RunRecord, RunStore } from '../state/runStore';
import type { Snippet, SnippetStore } from '../state/snippetStore';
import { isProduction, targetSummary, type Target } from '../targets/target';

export type OpenTinkerTreeItem =
    TargetItem | GroupItem | ScratchItem | RecentItem | SnippetItem | ActionItem;

class TargetItem extends vscode.TreeItem {
    constructor(target: Target | undefined, environment: string, status: string) {
        super(target ? target.name : 'Choose a target', vscode.TreeItemCollapsibleState.None);
        this.description = target
            ? [environment && environment !== 'unknown' ? environment : '', status]
                  .filter(Boolean)
                  .join(' · ')
            : 'where code runs';
        this.tooltip = target
            ? `${targetSummary(target)}\nClick to change target`
            : 'Choose where OpenTinker runs code';
        this.iconPath = new vscode.ThemeIcon(
            target && (isProduction(environment) || isProduction(target.environment))
                ? 'warning'
                : 'server-environment',
            target && (isProduction(environment) || isProduction(target.environment))
                ? new vscode.ThemeColor('errorForeground')
                : undefined,
        );
        this.contextValue = 'target';
        this.command = { command: 'opentinker.selectTarget', title: 'Choose Target' };
    }
}

type GroupKind = 'scratch' | 'recent' | 'snippets';

class GroupItem extends vscode.TreeItem {
    constructor(
        label: string,
        readonly kind: GroupKind,
    ) {
        super(label, vscode.TreeItemCollapsibleState.Expanded);
        this.iconPath = new vscode.ThemeIcon(
            kind === 'scratch' ? 'folder' : kind === 'recent' ? 'history' : 'symbol-snippet',
        );
        this.contextValue = `group-${kind}`;
    }
}

class ScratchItem extends vscode.TreeItem {
    constructor(
        readonly uri: vscode.Uri,
        target: Target | undefined,
    ) {
        super(uri, vscode.TreeItemCollapsibleState.None);
        this.description = target ? `→ ${target.name}` : undefined;
        this.iconPath = new vscode.ThemeIcon('file-code');
        this.contextValue = 'scratch';
        this.command = {
            command: 'opentinker.openScratch',
            title: 'Open Scratch File',
            arguments: [uri],
        };
    }
}

class RecentItem extends vscode.TreeItem {
    constructor(readonly record: RunRecord) {
        super(record.label, vscode.TreeItemCollapsibleState.None);
        const time = new Date(record.at).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
        });
        const state = record.ended === 'stopped' ? 'stopped' : record.ok ? '' : 'failed';
        this.description = [
            time,
            record.environment !== 'unknown' ? record.environment : '',
            `${Math.round(record.ms)} ms`,
            state,
        ]
            .filter(Boolean)
            .join(' · ');
        this.tooltip = new vscode.MarkdownString()
            .appendMarkdown(`${record.target}\n`)
            .appendCodeblock(record.code.slice(0, 400), 'php');
        this.contextValue = 'run';
        this.iconPath = new vscode.ThemeIcon(
            record.ok ? 'pass' : record.ended === 'stopped' ? 'debug-stop' : 'error',
        );
        this.command = { command: 'opentinker.openRecent', title: 'Open Run', arguments: [record] };
    }
}

class SnippetItem extends vscode.TreeItem {
    constructor(readonly snippet: Snippet) {
        super(snippet.name, vscode.TreeItemCollapsibleState.None);
        this.description = snippet.parameters.length
            ? `${snippet.parameters.length} ${snippet.parameters.length === 1 ? 'input' : 'inputs'}`
            : snippet.description;
        this.tooltip = new vscode.MarkdownString()
            .appendMarkdown(snippet.description ? `${snippet.description}\n` : '')
            .appendCodeblock(snippet.code.slice(0, 400), 'php');
        this.iconPath = new vscode.ThemeIcon('symbol-snippet');
        this.contextValue = 'snippet';
        this.command = {
            command: 'opentinker.runSnippet',
            title: 'Run Snippet',
            arguments: [snippet],
        };
    }
}

class ActionItem extends vscode.TreeItem {
    constructor(label: string, command: string, icon = 'add') {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon(icon);
        this.command = { command, title: label };
    }
}

export interface ViewSource {
    target(): Target | undefined;
    targetForFile(uri: vscode.Uri): Target | undefined;
    hasOwnTarget(uri: vscode.Uri): boolean;
    environment(target: Target): string;
    status(): string;
}

export class OpenTinkerViewProvider implements vscode.TreeDataProvider<OpenTinkerTreeItem> {
    private readonly emitter = new vscode.EventEmitter<OpenTinkerTreeItem | undefined>();
    readonly onDidChangeTreeData = this.emitter.event;

    constructor(
        private readonly source: ViewSource,
        private readonly scratch: ScratchManager | undefined,
        private readonly store: RunStore,
        private readonly snippets: SnippetStore | undefined,
    ) {}

    refresh(): void {
        this.emitter.fire(undefined);
    }

    getTreeItem(element: OpenTinkerTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: OpenTinkerTreeItem): Promise<OpenTinkerTreeItem[]> {
        if (!element) {
            const target = this.source.target();
            return [
                new TargetItem(
                    target,
                    target ? this.source.environment(target) : '',
                    this.source.status(),
                ),
                new GroupItem('Scratch Files', 'scratch'),
                new GroupItem('Recent Runs', 'recent'),
                new GroupItem('Snippets', 'snippets'),
            ];
        }

        if (element instanceof GroupItem && element.kind === 'scratch') {
            const files = (await this.scratch?.list()) ?? [];
            return files.length
                ? files.map(
                      (uri) =>
                          new ScratchItem(
                              uri,
                              this.source.hasOwnTarget(uri)
                                  ? this.source.targetForFile(uri)
                                  : undefined,
                          ),
                  )
                : [new ActionItem('Create a scratch file', 'opentinker.newScratch')];
        }

        if (element instanceof GroupItem && element.kind === 'recent') {
            const runs = this.store.recentRuns().slice(0, 20);
            return runs.length
                ? runs.map((record) => new RecentItem(record))
                : [new ActionItem('Runs will appear here', 'opentinker.open', 'play')];
        }

        if (element instanceof GroupItem && element.kind === 'snippets') {
            const snippets = (await this.snippets?.list()) ?? [];
            return snippets.length
                ? snippets.map((snippet) => new SnippetItem(snippet))
                : [new ActionItem('Save a snippet', 'opentinker.saveSnippet')];
        }

        return [];
    }
}
