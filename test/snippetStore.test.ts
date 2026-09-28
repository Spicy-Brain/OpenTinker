import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    parametersIn,
    parseHeader,
    renderSnippet,
    SnippetStore,
    type Snippet,
} from '../src/state/snippetStore';

describe('snippet parameters', () => {
    it('finds distinct typed placeholders', () => {
        expect(parametersIn('User::find({{id:number}}); dump({{id:number}}, {{name}});')).toEqual([
            { name: 'id', type: 'number' },
            { name: 'name', type: 'string' },
        ]);
    });

    it('renders string inputs without allowing PHP code injection', () => {
        const snippet: Snippet = {
            id: 'a',
            name: 'Test',
            description: '',
            code: 'User::where("name", {{name}})->first();',
            parameters: [{ name: 'name', type: 'string' }],
        };
        expect(renderSnippet(snippet, { name: "O'Reilly'); exit(); //" })).toBe(
            "User::where(\"name\", 'O\\'Reilly\\'); exit(); //')->first();",
        );
    });

    it('validates numbers and JSON before rendering', () => {
        const snippet: Snippet = {
            id: 'a',
            name: 'Test',
            description: '',
            code: 'dump({{count:number}}, {{data:json}});',
            parameters: [
                { name: 'count', type: 'number' },
                { name: 'data', type: 'json' },
            ],
        };
        expect(renderSnippet(snippet, { count: '2', data: '[1,2]' })).toContain('json_decode');
        expect(() => renderSnippet(snippet, { count: 'oops', data: '[]' })).toThrow(
            'must be a number',
        );
        expect(() => renderSnippet(snippet, { count: '2', data: '{oops}' })).toThrow();
    });

    it('saves a shareable PHP file with a header and reloads edits', async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), 'opentinker-snippet-'));
        try {
            const store = new SnippetStore(root);
            const saved = await store.save('Count users', 'User::count();', 'How many users');
            expect(saved.file).toBe(path.join(root, '.tinker', 'snippets', 'count-users.php'));
            const file = saved.file ?? '';
            const content = await readFile(file, 'utf8');
            expect(content).toContain('@name Count users');
            expect(content).toContain('@description How many users');
            expect((await store.save('Count users', 'x;')).id).toBe('count-users-2.php');
            await writeFile(file, '<?php\n/** @name Orders */\nOrder::count();');
            const edited = (await store.list()).find((item) => item.id === 'count-users.php');
            expect(edited?.name).toBe('Orders');
            expect(edited?.code).toContain('Order::count()');
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('still lists snippets saved by older versions', async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), 'opentinker-snippet-'));
        try {
            const id = '11111111-2222-3333-4444-555555555555';
            const legacy = path.join(root, '.opentinker', 'snippets');
            await mkdir(legacy, { recursive: true });
            await writeFile(
                path.join(legacy, `${id}.json`),
                JSON.stringify({ id, name: 'Old one', description: '' }),
            );
            await writeFile(path.join(legacy, `${id}.php`), '<?php\n1;');
            const [snippet] = await new SnippetStore(root).list();
            expect(snippet).toMatchObject({ name: 'Old one', legacy: true });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('reads names and descriptions from the header', () => {
        expect(
            parseHeader(
                '<?php\n/**\n * @name Find user\n * @description By email\n */\nUser::first();',
            ),
        ).toEqual({
            name: 'Find user',
            description: 'By email',
        });
    });
});
