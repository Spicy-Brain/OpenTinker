import * as vscode from 'vscode';
import type { ConfirmPolicy } from './run/guard';
import type { RunSettings } from './run/runController';
import type { ExecutionMode } from './shared/protocol';

const SECTION = 'opentinker';

function config(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration(SECTION);
}

export const settings = {
    run(): RunSettings {
        const c = config();
        return {
            sessionMode: c.get<'fresh' | 'keep'>('session.mode', 'fresh'),
            rollback: c.get<boolean>('database.rollback', false),
            fake: c.get<boolean>('fakeSideEffects', false),
            timeoutMs: c.get<number>('timeoutMs', 30000),
            maxOutputBytes: c.get<number>('maxOutputBytes', 2097152),
            confirmPolicy: c.get<ConfirmPolicy>('production.confirm', 'writes'),
        };
    },
    scratchDir(): string {
        return config().get<string>('scratchDir', '.tinker');
    },
    executionMode(): ExecutionMode {
        return config().get<ExecutionMode>('executionMode', 'statements');
    },
    resultsLocation(): 'beside' | 'panel' {
        return config().get<'beside' | 'panel'>('results.location', 'beside');
    },
    inlineResults(): boolean {
        return config().get<boolean>('inlineResults', true);
    },
    codeLensRunMethods(): boolean {
        return config().get<boolean>('codeLens.runMethods', true);
    },
    codeLensTinkerModel(): boolean {
        return config().get<boolean>('codeLens.tinkerModel', true);
    },
    bootstrap(): string {
        return config().get<string>('bootstrap', 'auto') || 'auto';
    },
    phpBinary(): string {
        return config().get<string>('php.binary', 'php');
    },
    sshPhpBinary(): string {
        return config().get<string>('ssh.phpBinary', 'php');
    },
    defaultWorkingDir(): string {
        return config().get<string>('docker.workingDir', '/var/www');
    },
    historyLimit(): number {
        return config().get<number>('history.maxEntries', 50);
    },
    persistResults(): boolean {
        return config().get<boolean>('history.persistResults', false);
    },
    async setSessionMode(mode: 'fresh' | 'keep'): Promise<void> {
        await config().update('session.mode', mode, vscode.ConfigurationTarget.Workspace);
    },
    async setRollback(enabled: boolean): Promise<void> {
        await config().update('database.rollback', enabled, vscode.ConfigurationTarget.Workspace);
    },
    async setFakeSideEffects(enabled: boolean): Promise<void> {
        await config().update('fakeSideEffects', enabled, vscode.ConfigurationTarget.Workspace);
    },
};
