import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

const TEMPLATE = `<?php

// OpenTinker scratchpad — Ctrl/Cmd+Enter runs this file against your app.
`;

export class ScratchManager {
    private gitignorePrompted = false;

    constructor(
        private readonly workspaceFolder: vscode.WorkspaceFolder,
        private readonly dirName: string,
    ) {}

    get directory(): string {
        return path.join(this.workspaceFolder.uri.fsPath, this.dirName);
    }

    isScratch(uri: vscode.Uri): boolean {
        return uri.fsPath.startsWith(this.directory + path.sep);
    }

    async ensureDirectory(): Promise<void> {
        await fs.mkdir(this.directory, { recursive: true });
    }

    async list(): Promise<vscode.Uri[]> {
        await this.ensureDirectory();
        const entries = await fs.readdir(this.directory);

        return entries
            .filter((entry) => entry.endsWith('.php'))
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
            .map((entry) => vscode.Uri.file(path.join(this.directory, entry)));
    }

    async create(): Promise<vscode.Uri> {
        await this.ensureDirectory();
        const entries = await fs.readdir(this.directory);

        let index = 1;

        while (entries.includes(`scratch-${index}.php`)) {
            index++;
        }

        const file = path.join(this.directory, `scratch-${index}.php`);
        await fs.writeFile(file, TEMPLATE, 'utf8');

        return vscode.Uri.file(file);
    }

    async ensureGitignore(): Promise<void> {
        if (this.gitignorePrompted) {
            return;
        }

        this.gitignorePrompted = true;
        const gitignore = path.join(this.workspaceFolder.uri.fsPath, '.gitignore');

        let content: string;

        try {
            content = await fs.readFile(gitignore, 'utf8');
        } catch {
            return;
        }

        const ignored = content
            .split(/\r?\n/)
            .some((line) => line.trim() === `${this.dirName}/` || line.trim() === this.dirName);

        if (ignored) {
            return;
        }

        const answer = await vscode.window.showInformationMessage(
            `Add ${this.dirName}/ to .gitignore? Scratch files should not be committed.`,
            'Add',
            'Not now',
        );

        if (answer === 'Add') {
            const separator = content === '' || content.endsWith('\n') ? '' : '\n';
            await fs.appendFile(gitignore, `${separator}${this.dirName}/\n`, 'utf8');
        }
    }

    async open(uri: vscode.Uri, column: vscode.ViewColumn = vscode.ViewColumn.One): Promise<void> {
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document, column, false);
    }
}
