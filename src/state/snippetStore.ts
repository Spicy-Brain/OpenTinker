import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

export type ParameterType = 'string' | 'number' | 'bool' | 'json';

export interface SnippetParameter {
    name: string;
    type: ParameterType;
}

export interface Snippet {
    /** File name within the snippets folder (or a legacy id). */
    id: string;
    name: string;
    description: string;
    code: string;
    parameters: SnippetParameter[];
    /** Absolute path of the PHP file. */
    file?: string;
    /** Loaded from the pre-0.3 .opentinker/snippets folder. */
    legacy?: boolean;
}

const PLACEHOLDER = /\{\{([a-zA-Z_][a-zA-Z0-9_]*)(?::(string|number|bool|json))?\}\}/g;
const HEADER = /^\s*(?:<\?php\s*)?\/\*\*([\s\S]*?)\*\//;

export function parametersIn(code: string): SnippetParameter[] {
    const seen = new Set<string>();
    const parameters: SnippetParameter[] = [];
    for (const match of code.matchAll(PLACEHOLDER)) {
        if (seen.has(match[1])) continue;
        seen.add(match[1]);
        parameters.push({ name: match[1], type: (match[2] as ParameterType) || 'string' });
    }
    return parameters;
}

function phpString(value: string): string {
    return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

export function renderSnippet(snippet: Snippet, values: Record<string, string>): string {
    const expected = new Map(snippet.parameters.map((param) => [param.name, param.type]));
    return snippet.code.replace(PLACEHOLDER, (_placeholder, name: string, declared: string) => {
        const type = expected.get(name);
        if (!type || (declared && declared !== type)) throw new Error(`Unknown parameter ${name}`);
        const raw = values[name];
        if (raw === undefined) throw new Error(`Missing parameter ${name}`);
        if (type === 'number') {
            const number = Number(raw);
            if (!Number.isFinite(number) || raw.trim() === '')
                throw new Error(`${name} must be a number`);
            return String(number);
        }
        if (type === 'bool') {
            const value = raw.trim().toLowerCase();
            if (value !== 'true' && value !== 'false')
                throw new Error(`${name} must be true or false`);
            return value;
        }
        if (type === 'json') {
            const parsed = JSON.parse(raw) as unknown;
            return `json_decode(${phpString(JSON.stringify(parsed))}, true, 512, JSON_THROW_ON_ERROR)`;
        }
        return phpString(raw);
    });
}

/** Reads `@name` and `@description` from a snippet's leading docblock. */
export function parseHeader(code: string): { name?: string; description?: string } {
    const block = HEADER.exec(code)?.[1];
    if (!block) return {};
    const tag = (name: string): string | undefined =>
        new RegExp(`@${name}\\s+(.+)`).exec(block)?.[1]?.trim();
    return { name: tag('name'), description: tag('description') };
}

export function slugify(name: string): string {
    return (
        name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 60) || 'snippet'
    );
}

/**
 * Project snippets live in .tinker/snippets as plain PHP files with a small
 * docblock header, so a team can commit, review and share them.
 */
export class SnippetStore {
    readonly directory: string;
    private readonly legacyDirectory: string;

    constructor(workspacePath: string, scratchDir = '.tinker') {
        this.directory = path.join(workspacePath, scratchDir, 'snippets');
        this.legacyDirectory = path.join(workspacePath, '.opentinker', 'snippets');
    }

    isSnippet(file: string): boolean {
        return (
            file.startsWith(this.directory + path.sep) ||
            file.startsWith(this.legacyDirectory + path.sep)
        );
    }

    async list(): Promise<Snippet[]> {
        const [current, legacy] = await Promise.all([this.listCurrent(), this.listLegacy()]);
        return [...current, ...legacy].sort((a, b) => a.name.localeCompare(b.name));
    }

    async save(name: string, code: string, description = ''): Promise<Snippet> {
        const trimmedName = name.trim();
        if (!trimmedName || !code.trim()) throw new Error('Snippet needs a name and code');

        const body = code
            .replace(/^\s*<\?php\s*/, '')
            .replace(HEADER, '')
            .trimStart();
        const header = [
            '/**',
            ` * @name ${trimmedName.replace(/\*\//g, '')}`,
            ...(description.trim()
                ? [` * @description ${description.trim().replace(/\*\//g, '')}`]
                : []),
            ' *',
            ' * Inputs: {{name}}, {{count:number}}, {{enabled:bool}} or {{data:json}}.',
            ' */',
        ].join('\n');
        const content = `<?php\n\n${header}\n\n${body}${body.endsWith('\n') ? '' : '\n'}`;

        await mkdir(this.directory, { recursive: true });
        const existing = new Set(await readdir(this.directory).catch(() => [] as string[]));
        const slug = slugify(trimmedName);
        let file = `${slug}.php`;
        for (let index = 2; existing.has(file); index++) file = `${slug}-${index}.php`;

        const fullPath = path.join(this.directory, file);
        await writeFile(fullPath, content, { flag: 'wx' });
        return {
            id: file,
            name: trimmedName,
            description: description.trim(),
            code: content,
            parameters: parametersIn(content),
            file: fullPath,
        };
    }

    private async listCurrent(): Promise<Snippet[]> {
        let entries: string[];
        try {
            entries = await readdir(this.directory);
        } catch {
            return [];
        }
        const snippets = await Promise.all(
            entries
                .filter((entry) => entry.endsWith('.php'))
                .map(async (entry): Promise<Snippet | undefined> => {
                    const file = path.join(this.directory, entry);
                    try {
                        const code = await readFile(file, 'utf8');
                        if (!code.trim()) return undefined;
                        const header = parseHeader(code);
                        return {
                            id: entry,
                            name: header.name ?? entry.replace(/\.php$/, '').replace(/[-_]+/g, ' '),
                            description: header.description ?? '',
                            code,
                            parameters: parametersIn(code),
                            file,
                        };
                    } catch {
                        return undefined;
                    }
                }),
        );
        return snippets.filter((item): item is Snippet => !!item);
    }

    /** The pre-0.3 format: JSON metadata next to a PHP file named by UUID. */
    private async listLegacy(): Promise<Snippet[]> {
        let entries: string[];
        try {
            entries = await readdir(this.legacyDirectory);
        } catch {
            return [];
        }
        const snippets = await Promise.all(
            entries
                .filter((entry) => entry.endsWith('.json'))
                .map(async (entry): Promise<Snippet | undefined> => {
                    try {
                        const meta = JSON.parse(
                            await readFile(path.join(this.legacyDirectory, entry), 'utf8'),
                        ) as Record<string, unknown>;
                        if (typeof meta.id !== 'string' || typeof meta.name !== 'string')
                            return undefined;
                        if (!/^[0-9a-f-]{36}$/i.test(meta.id)) return undefined;
                        const file = path.join(this.legacyDirectory, `${meta.id}.php`);
                        const code = await readFile(file, 'utf8').catch(() =>
                            typeof meta.code === 'string' ? meta.code : '',
                        );
                        if (!code.trim()) return undefined;
                        return {
                            id: meta.id,
                            name: meta.name,
                            description:
                                typeof meta.description === 'string' ? meta.description : '',
                            code,
                            parameters: parametersIn(code),
                            file,
                            legacy: true,
                        };
                    } catch {
                        return undefined;
                    }
                }),
        );
        return snippets.filter((item): item is Snippet => !!item);
    }
}
