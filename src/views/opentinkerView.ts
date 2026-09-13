import * as vscode from 'vscode';
import type { ScratchManager } from '../scratch/scratchManager';
import type { RunRecord, RunStore } from '../state/runStore';

export type OpenTinkerTreeItem = SessionItem | GroupItem | ScratchItem | RecentItem;

class SessionItem extends vscode.TreeItem {
    constructor(status: string, transport: string) {
        super(`Session: ${status}`, vscode.TreeItemCollapsibleState.None);
        this.description = transport;
        this.iconPath = new vscode.ThemeIcon('beaker');
        this.contextValue = 'session';
        this.tooltip = 'Click to choose where OpenTinker runs';
        this.command = {
            command: 'opentinker.selectConnection',
            title: 'Select Runtime',
        };
    }
}

type GroupKind = 'scratch' | 'recent';

class GroupItem extends vscode.TreeItem {
    constructor(
        label: string,
        readonly kind: GroupKind,
    ) {
        super(label, vscode.TreeItemCollapsibleState.Expanded);
        this.iconPath = new vscode.ThemeIcon(kind === 'scratch' ? 'folder' : 'history');
        this.contextValue = kind;
    }
}

class ScratchItem extends vscode.TreeItem {
    constructor(readonly uri: vscode.Uri) {
        super(vscode.workspace.asRelativePath(uri, false), vscode.TreeItemCollapsibleState.None);
        this.resourceUri = uri;
        this.iconPath = new vscode.ThemeIcon('file-code');
        this.command = {
            command: 'opentinker.openScratch',
            title: 'Open Scratch File',
            arguments: [uri],
        };
    }
}

class RecentItem extends vscode.TreeItem {
    constructor(readonly record: RunRecord) {
        const time = new Date(record.at).toLocaleTimeString();
        super(record.label, vscode.TreeItemCollapsibleState.None);
        this.description = `${time} · ${record.ms.toFixed(0)} ms${record.ok ? '' : ' · failed'}`;
        this.iconPath = new vscode.ThemeIcon(record.ok ? 'pass' : 'error');
        this.command = {
            command: 'opentinker.openRecent',
            title: 'Open Run',
            arguments: [record],
        };
    }
}

export class OpenTinkerViewProvider implements vscode.TreeDataProvider<OpenTinkerTreeItem> {
    private readonly emitter = new vscode.EventEmitter<OpenTinkerTreeItem | undefined>();

    readonly onDidChangeTreeData = this.emitter.event;

    private status = 'idle';
    private transport = '';

    constructor(
        private readonly scratch: ScratchManager | undefined,
        private readonly store: RunStore,
    ) {}

    setStatus(status: string, transport?: string): void {
        this.status = status;

        if (transport) {
            this.transport = transport;
        }

        this.refresh();
    }

    refresh(): void {
        this.emitter.fire(undefined);
    }

    getTreeItem(element: OpenTinkerTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: OpenTinkerTreeItem): Promise<OpenTinkerTreeItem[]> {
        if (!element) {
            return [
                new SessionItem(this.status, this.transport),
                new GroupItem('Scratch Files', 'scratch'),
                new GroupItem('Recent Runs', 'recent'),
            ];
        }

        if (element instanceof GroupItem && element.kind === 'scratch') {
            if (!this.scratch) {
                return [];
            }

            const files = await this.scratch.list();
            return files.map((uri) => new ScratchItem(uri));
        }

        if (element instanceof GroupItem && element.kind === 'recent') {
            return this.store.recentRuns().map((record) => new RecentItem(record));
        }

        return [];
    }
}
