import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

const TEMPLATE = `<?php

// OpenTinker scratch file: Ctrl/Cmd+Enter runs it against your app.
// End a line with //? to see its value inline.

`;

/** Git rules: scratch files stay private, shared snippets can be committed. */
export function gitignoreRules(dirName: string): string[] {
    return [`${dirName}/*`, `!${dirName}/snippets/`];
}

export class ScratchManager {
    private gitignoreChecked = false;

    constructor(
        private readonly workspaceFolder: vscode.WorkspaceFolder,
        private readonly dirName: string,
    ) {}

    get directory(): string {
        return path.join(this.workspaceFolder.uri.fsPath, this.dirName);
    }

    get snippetsDirectory(): string {
        return path.join(this.directory, 'snippets');
    }

    /** Scratch files are PHP files directly in the scratch folder (not snippets or helpers). */
    isScratch(uri: vscode.Uri): boolean {
        if (uri.scheme !== 'file') return false;
        return (
            path.dirname(uri.fsPath) === this.directory &&
            uri.fsPath.endsWith('.php') &&
            !path.basename(uri.fsPath).startsWith('_')
        );
    }

    async ensureDirectory(): Promise<void> {
        await fs.mkdir(this.directory, { recursive: true });
    }

    async list(): Promise<vscode.Uri[]> {
        let entries: string[];
        try {
            entries = await fs.readdir(this.directory);
        } catch {
            return [];
        }
        const withTimes = await Promise.all(
            entries
                .filter((entry) => entry.endsWith('.php') && !entry.startsWith('_'))
                .map(async (entry) => {
                    const file = path.join(this.directory, entry);
                    const stat = await fs.stat(file).catch(() => undefined);
                    return { file, time: stat?.mtimeMs ?? 0 };
                }),
        );
        return withTimes
            .sort((a, b) => b.time - a.time)
            .map((entry) => vscode.Uri.file(entry.file));
    }

    async create(content = TEMPLATE, prefix = 'scratch'): Promise<vscode.Uri> {
        await this.ensureDirectory();
        const entries = new Set(await fs.readdir(this.directory));
        let index = 1;
        while (entries.has(`${prefix}-${index}.php`)) index++;
        const file = path.join(this.directory, `${prefix}-${index}.php`);
        await fs.writeFile(file, content, 'utf8');
        return vscode.Uri.file(file);
    }

    /**
     * Offers once to keep scratch files out of git while letting shared
     * snippets in. Never edits .gitignore without asking.
     */
    async ensureGitignore(): Promise<void> {
        if (this.gitignoreChecked) return;
        this.gitignoreChecked = true;

        const gitignore = path.join(this.workspaceFolder.uri.fsPath, '.gitignore');
        let content: string;
        try {
            content = await fs.readFile(gitignore, 'utf8');
        } catch {
            return;
        }

        const lines = content.split(/\r?\n/).map((line) => line.trim());
        const rules = gitignoreRules(this.dirName);
        const ignoresAll = lines.includes(`${this.dirName}/`) || lines.includes(this.dirName);
        if (rules.every((rule) => lines.includes(rule))) return;

        const answer = await vscode.window.showInformationMessage(
            ignoresAll
                ? `Let shared snippets in ${this.dirName}/snippets be committed? Scratch files stay ignored.`
                : `Add ${this.dirName}/ to .gitignore? Scratch files stay private; shared snippets in ${this.dirName}/snippets can still be committed.`,
            'Update .gitignore',
            'Not now',
        );
        if (answer !== 'Update .gitignore') return;

        const kept = content
            .split(/\r?\n/)
            .filter((line) => line.trim() !== `${this.dirName}/` && line.trim() !== this.dirName);
        while (kept.length && kept[kept.length - 1] === '') kept.pop();
        const missing = rules.filter((rule) => !kept.map((line) => line.trim()).includes(rule));
        await fs.writeFile(gitignore, [...kept, ...missing].join('\n') + '\n', 'utf8');
    }

    async open(
        uri: vscode.Uri,
        column: vscode.ViewColumn = vscode.ViewColumn.One,
    ): Promise<vscode.TextEditor> {
        const document = await vscode.workspace.openTextDocument(uri);
        return vscode.window.showTextDocument(document, { viewColumn: column, preview: false });
    }
}
