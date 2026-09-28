// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PanelMessage, RunView } from '../../src/shared/panelMessages';
import type { RunFrame } from '../../src/shared/protocol';
import { ResultsApp } from '../../src/webview/results/main';
import {
    applyFrame,
    beginRun,
    isHidden,
    orderedCards,
    summaryText,
    toCsv,
    toMarkdown,
} from '../../src/webview/results/model';

const fixture = JSON.parse(readFileSync('test/webview/fixtures/frames.json', 'utf8')) as {
    code: string;
    frames: RunFrame[];
};

const run: RunView = {
    id: 'demo',
    label: 'scratch-1.php',
    code: fixture.code,
    imports: [],
    sourceLine: 1,
    hasSource: true,
    scratch: true,
    target: 'compose · app · /var/www',
    targetName: 'app',
    environment: 'local',
    sessionMode: 'fresh',
    rollback: false,
    at: Date.now(),
};

describe('results model', () => {
    it('builds one card per statement in source order and hides clean imports', () => {
        const model = beginRun(run);
        for (const frame of fixture.frames) applyFrame(model, frame);
        const visible = orderedCards(model).filter((card) => !isHidden(card));
        expect(visible.map((card) => card.line)).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14]);
        expect(summaryText(model)).toMatch(/^Failed · 9 statements · 4 queries/);
    });

    it('merges streamed output fragments', () => {
        const model = beginRun(run);
        applyFrame(model, { type: 'output', id: 'demo', stmt: 1, line: 1, text: 'Hel' });
        applyFrame(model, { type: 'output', id: 'demo', stmt: 1, line: 1, text: 'lo' });
        expect(model.cards.get(1)?.items).toEqual([{ kind: 'output', text: 'Hello' }]);
    });

    it('exports tables safely', () => {
        expect(toCsv(['a'], [['=SUM(1)'], ['x"y']])).toBe('"a"\r\n"\'=SUM(1)"\r\n"x""y"');
        expect(toMarkdown(['a', 'b'], [['1|2', 'x']])).toBe(
            '| a | b |\n| --- | --- |\n| 1\\|2 | x |',
        );
    });
});

describe('results panel', () => {
    let posted: PanelMessage[];
    let app: ResultsApp;

    beforeEach(() => {
        document.body.innerHTML = '<div id="app"></div>';
        posted = [];
        app = new ResultsApp(document.getElementById('app') as HTMLElement, {
            postMessage: (message) => posted.push(message),
        });
        app.handle({
            kind: 'context',
            context: {
                targetName: 'app',
                targetDetail: 'compose · app',
                environment: 'local',
                sessionMode: 'fresh',
                rollback: false,
                state: 'idle',
                fork: true,
                hasTarget: true,
                scratchName: 'scratch-1.php',
            },
        });
    });

    const render = (): void =>
        app.handle({
            kind: 'render',
            run,
            frames: fixture.frames,
            changes: { 3: 'changed', 4: 'same' },
        });

    it('shows a welcome with actions before the first run', () => {
        expect(document.querySelector('.welcome')?.textContent).toContain('Tinker with your app');
        (document.querySelector('.welcome-actions .primary') as HTMLButtonElement).click();
        expect(posted).toContainEqual({ kind: 'action', action: 'newScratch' });
    });

    it('renders cards with model, table, dump, preview, SQL and error views', () => {
        render();
        const cards = [...document.querySelectorAll('.card')].filter(
            (card) => !(card as HTMLElement).hidden,
        );
        expect(cards).toHaveLength(9);
        expect(document.querySelector('.model-class')?.textContent).toBe('User');
        expect(
            [...document.querySelectorAll('.attributes th')].map((th) => th.textContent),
        ).toContain('email');
        expect(document.querySelector('.model-title')?.textContent).toContain('not saved');
        expect(document.querySelectorAll('.dump-toggle').length).toBeGreaterThan(0);
        expect(document.querySelector('.n-plus-one')?.textContent).toContain('Ran 4 times');
        expect(document.querySelector('.error-message')?.textContent).toBe(
            'Something went wrong in the scratch file',
        );
        expect(document.querySelector('.inline-result')?.textContent).toBe('//? 42');
        expect(document.querySelector('.summary')?.textContent).toMatch(/^Failed/);
        expect(document.querySelector('.badge.change.changed')).not.toBeNull();
    });

    it('switches a collection to its table view', () => {
        render();
        const tab = [...document.querySelectorAll('.view-tab')].find(
            (item) => item.textContent === 'Table',
        ) as HTMLButtonElement;
        tab.click();
        expect([...document.querySelectorAll('table.grid th')].map((th) => th.textContent)).toEqual(
            ['id', 'name'],
        );
    });

    it('jumps to the source line and copies values in several formats', () => {
        render();
        const firstVisible = [...document.querySelectorAll('.card')].find(
            (card) => !(card as HTMLElement).hidden,
        ) as HTMLElement;
        (firstVisible.querySelector('.line-badge') as HTMLButtonElement).click();
        expect(posted).toContainEqual({ kind: 'openLine', line: 6 });
        const menu = document.querySelector('.value-item .copy-menu') as HTMLElement;
        (menu.querySelector('.link-button') as HTMLButtonElement).click();
        const json = [...menu.querySelectorAll('.menu-item')].find(
            (item) => item.textContent === 'As JSON',
        ) as HTMLButtonElement;
        json.click();
        const copied = posted.find((message) => message.kind === 'copy');
        expect(copied && 'text' in copied ? copied.text : '').toContain(
            '"email": "ada@example.com"',
        );
    });

    it('expands and collapses nested dump levels', () => {
        render();
        const toggle = document.querySelector('.dump-toggle') as HTMLButtonElement;
        const samp = toggle.nextElementSibling as HTMLElement;
        const wasCompact = samp.classList.contains('sf-dump-compact');
        toggle.click();
        expect(samp.classList.contains('sf-dump-compact')).toBe(!wasCompact);
    });

    it('filters cards with search', () => {
        render();
        const search = document.querySelector('input.search') as HTMLInputElement;
        search.value = 'Grace';
        search.dispatchEvent(new Event('input'));
        const visible = [...document.querySelectorAll('.card')].filter(
            (card) => !(card as HTMLElement).hidden,
        );
        expect(visible).toHaveLength(1);
    });

    it('streams a live run and swaps Run again for Stop', () => {
        app.handle({
            kind: 'context',
            context: {
                targetName: 'app',
                targetDetail: '',
                environment: 'production',
                sessionMode: 'keep',
                rollback: true,
                state: 'running',
                fork: true,
                hasTarget: true,
                scratchName: 'scratch-1.php',
            },
        });
        app.handle({ kind: 'begin', run });
        app.handle({
            kind: 'frame',
            frame: fixture.frames.find((frame) => frame.type === 'output') as RunFrame,
        });
        expect(document.querySelector('.output')?.textContent).toContain('Hello from OpenTinker');
        const stop = [...document.querySelectorAll('.toolbar button')].find(
            (button) => button.textContent === 'Stop',
        ) as HTMLButtonElement;
        expect(stop.hidden).toBe(false);
        stop.click();
        expect(posted).toContainEqual({ kind: 'action', action: 'stop' });
        expect(document.querySelector('.pill.env')?.className).toContain('production');
        expect(document.querySelector('.pill.rollback')?.textContent).toBe('Rollback on');
        expect(document.body.classList.contains('production')).toBe(true);
    });

    it('lists variables and expands their dumps on demand', () => {
        app.handle({
            kind: 'scope',
            scope: fixture.frames.find((frame) => frame.type === 'scope') as never,
        });
        (document.querySelectorAll('.tab')[1] as HTMLButtonElement).click();
        const names = [...document.querySelectorAll('.var-name')].map((item) => item.textContent);
        expect(names).toEqual(['$user', '$i', '$total']);
        const first = document.querySelector('details.var') as HTMLDetailsElement;
        first.open = true;
        first.dispatchEvent(new Event('toggle'));
        expect(first.querySelector('.dump')).not.toBeNull();
    });
});
