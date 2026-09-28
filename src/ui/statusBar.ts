import * as vscode from 'vscode';
import type { RunState } from '../run/runController';
import { isProduction, targetSummary, type Target } from '../targets/target';

export interface StatusInfo {
    target: Target | undefined;
    environment: string;
    state: RunState;
    sessionMode: 'fresh' | 'keep';
    rollback: boolean;
    fake: boolean;
    booting: boolean;
    /** The active scratch file; the Run button only shows for scratch files. */
    scratchName?: string;
}

/**
 * A Run/Stop button while a scratch file is active, then two items: where code runs (click to change; red on production), and how
 * it runs (fresh or kept session, rollback), which toggles the session mode.
 */
export class StatusBar implements vscode.Disposable {
    private readonly run = vscode.window.createStatusBarItem(
        'opentinker.run',
        vscode.StatusBarAlignment.Left,
        41,
    );
    private readonly target = vscode.window.createStatusBarItem(
        'opentinker.target',
        vscode.StatusBarAlignment.Left,
        40,
    );
    private readonly mode = vscode.window.createStatusBarItem(
        'opentinker.mode',
        vscode.StatusBarAlignment.Left,
        39,
    );

    constructor() {
        this.run.name = 'OpenTinker run';
        this.target.name = 'OpenTinker target';
        this.target.command = 'opentinker.selectTarget';
        this.mode.name = 'OpenTinker session mode';
        this.mode.command = 'opentinker.toggleSessionMode';
    }

    update(info: StatusInfo): void {
        const { target, environment, state } = info;
        const production =
            isProduction(environment) || (target ? isProduction(target.environment) : false);
        const icon =
            state === 'running' || state === 'starting' || info.booting
                ? '$(loading~spin)'
                : production
                  ? '$(warning)'
                  : '$(beaker)';

        if (!target) {
            this.target.text = '$(beaker) OpenTinker: choose target';
            this.target.tooltip = 'Choose where OpenTinker runs code';
            this.target.backgroundColor = undefined;
        } else {
            const env = environment && environment !== 'unknown' ? ` · ${environment}` : '';
            this.target.text = `${icon} ${target.name}${env}`;
            const tooltip = new vscode.MarkdownString(undefined, true);
            tooltip.appendMarkdown(`**OpenTinker** runs code on **${target.name}**\n\n`);
            tooltip.appendMarkdown(`${targetSummary(target)}\n\n`);
            tooltip.appendMarkdown(`Environment: **${environment || target.environment}**`);
            if (production) tooltip.appendMarkdown(' — production data');
            tooltip.appendMarkdown('\n\nClick to change target.');
            this.target.tooltip = tooltip;
            this.target.backgroundColor = production
                ? new vscode.ThemeColor('statusBarItem.errorBackground')
                : undefined;
        }

        this.mode.text =
            (info.sessionMode === 'fresh' ? '$(refresh) Fresh' : '$(history) Keep session') +
            (info.rollback ? ' · $(shield) Rollback' : '') +
            (info.fake ? ' · $(debug-disconnect) Fakes' : '');
        this.mode.tooltip =
            (info.sessionMode === 'fresh'
                ? 'Each run starts from a freshly booted app. Click to keep variables between runs.'
                : 'Variables carry over between runs. Click to start fresh each run.') +
            (info.rollback ? '\nDatabase changes are rolled back after each run.' : '') +
            (info.fake ? '\nMail, notifications, jobs and HTTP calls are faked.' : '');

        const busy = state === 'running' || state === 'starting' || state === 'stopping';
        if (busy) {
            this.run.text = '$(debug-stop) Stop';
            this.run.tooltip = 'Stop the current run (Ctrl/Cmd+Alt+C)';
            this.run.command = 'opentinker.stop';
            this.run.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
            this.run.show();
        } else if (info.scratchName) {
            this.run.text = '$(play) Run';
            this.run.tooltip = `Run ${info.scratchName} (Ctrl/Cmd+Enter)`;
            this.run.command = 'opentinker.runFile';
            this.run.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            this.run.show();
        } else {
            this.run.hide();
        }

        this.target.show();
        this.mode.show();
    }

    dispose(): void {
        this.run.dispose();
        this.target.dispose();
        this.mode.dispose();
    }
}
