// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PanelContext, PanelMessage, RunView } from '../../src/shared/panelMessages';
import type { ResultFrame, RunFrame } from '../../src/shared/protocol';
import { previewView } from '../../src/webview/results/components';
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
    fake: false,
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

    it('keeps newlines that arrive as their own fragments', () => {
        // PsySH flushes each echo, so `echo $i, PHP_EOL;` arrives as "1", "\n", "2", "\n".
        const model = beginRun(run);
        for (const text of ['1', '\n', '2', '\n'])
            applyFrame(model, { type: 'output', id: 'demo', stmt: 1, line: 1, text });
        expect(model.cards.get(1)?.items).toEqual([{ kind: 'output', text: '1\n2\n' }]);
        applyFrame(model, { type: 'output', id: 'demo', stmt: 2, line: 2, text: '\n' });
        expect(model.cards.has(2)).toBe(false);
    });

    it('exports tables safely', () => {
        expect(toCsv(['a'], [['=SUM(1)'], ['x"y']])).toBe('"a"\r\n"\'=SUM(1)"\r\n"x""y"');
        expect(toCsv(['n'], [['-12.50'], ['+44'], ['1e5'], ['-cmd'], ['@user']])).toBe(
            '"n"\r\n"-12.50"\r\n"+44"\r\n"1e5"\r\n"\'-cmd"\r\n"\'@user"',
        );
        expect(toMarkdown(['a', 'b'], [['1|2', 'x']])).toBe(
            '| a | b |\n| --- | --- |\n| 1\\|2 | x |',
        );
        expect(toMarkdown(['a'], [['one\r\ntwo\rthree']])).toBe(
            '| a |\n| --- |\n| one two three |',
        );
    });

    it('blocks remote images in previews until asked', () => {
        const view = previewView({
            kind: 'mailable',
            html: '<p>Hi</p><img src="https://track.example/pixel.gif">',
        });
        const frame = view.querySelector('iframe') as HTMLIFrameElement;
        expect(frame.srcdoc).toContain('img-src data:;');
        (view.querySelector('.preview-note button') as HTMLButtonElement).click();
        expect(frame.srcdoc).toContain('img-src data: https:;');
        expect(view.querySelector('.preview-note')).toBeNull();
        expect(previewView({ kind: 'html', html: '<p>No images</p>' }).tagName).toBe('IFRAME');
    });
});

const baseContext: PanelContext = {
    targetName: 'app',
    targetDetail: 'compose · app',
    environment: 'local',
    sessionMode: 'fresh',
    rollback: false,
    fake: false,
    state: 'idle',
    fork: true,
    hasTarget: true,
    scratchName: 'scratch-1.php',
};

const visibleCards = (): Element[] =>
    [...document.querySelectorAll('.card')].filter((card) => !(card as HTMLElement).hidden);

describe('results panel', () => {
    let posted: PanelMessage[];
    let app: ResultsApp;

    beforeEach(() => {
        document.body.innerHTML = '<div id="app"></div>';
        posted = [];
        app = new ResultsApp(document.getElementById('app') as HTMLElement, {
            postMessage: (message) => posted.push(message),
        });
        app.handle({ kind: 'context', context: baseContext });
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
        // With a scratch file open, running it is the main action.
        (document.querySelector('.welcome-actions .primary') as HTMLButtonElement).click();
        expect(posted).toContainEqual({ kind: 'action', action: 'run' });
        const create = [...document.querySelectorAll('.welcome-actions button')].find(
            (item) => item.textContent === 'New scratch file',
        ) as HTMLButtonElement;
        create.click();
        expect(posted).toContainEqual({ kind: 'action', action: 'newScratch' });
    });

    it('updates the welcome when the context changes', () => {
        app.handle({
            kind: 'context',
            context: { ...baseContext, scratchName: '', hasTarget: false },
        });
        expect(document.querySelector('.welcome-actions .primary')?.textContent).toBe(
            'New scratch file',
        );
        expect(document.querySelector('.welcome-actions')?.textContent).toContain('Choose target');
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

    it('opens a collection as a table, with the dump a click away', () => {
        render();
        expect([...document.querySelectorAll('table.grid th')].map((th) => th.textContent)).toEqual(
            ['id', 'name'],
        );
        const item = document.querySelector('table.grid')?.closest('.value-item') as HTMLElement;
        const tabs = [...item.querySelectorAll('.view-tab')] as HTMLButtonElement[];
        expect(tabs.map((tab) => [tab.textContent, tab.getAttribute('aria-pressed')])).toEqual([
            ['Table', 'true'],
            ['Dump', 'false'],
        ]);
        tabs[1].click();
        expect(item.querySelector('.value-body .dump')).not.toBeNull();
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

    const search = (term: string): void => {
        const input = document.querySelector('input.search') as HTMLInputElement;
        input.value = term;
        input.dispatchEvent(new Event('input'));
    };
    const streamed = (): RunFrame[] =>
        fixture.frames.filter(
            (frame) => frame.type !== 'result' && frame.type !== ('scope' as string),
        );

    it('filters cards with search', () => {
        render();
        search('Grace');
        expect(visibleCards()).toHaveLength(1);
    });

    it('searches card content, not button and menu labels', () => {
        render();
        search('as json');
        expect(visibleCards()).toHaveLength(0);
    });

    it('applies search to cards that stream in', () => {
        search('Grace');
        app.handle({ kind: 'begin', run });
        for (const frame of streamed()) app.handle({ kind: 'frame', frame });
        expect(visibleCards()).toHaveLength(1);
    });

    it('finishes a run in place, keeping collapsed cards and focus', () => {
        app.handle({ kind: 'context', context: { ...baseContext, state: 'running' } });
        app.handle({ kind: 'begin', run });
        for (const frame of streamed()) app.handle({ kind: 'frame', frame });
        const first = visibleCards()[0] as HTMLDetailsElement;
        first.open = false;
        const runButton = document.querySelector('.toolbar button') as HTMLButtonElement;
        expect(runButton.textContent).toBe('Stop');
        runButton.focus();

        app.handle({ kind: 'context', context: baseContext });
        app.handle({
            kind: 'finish',
            result: fixture.frames.find((frame) => frame.type === 'result') as ResultFrame,
            changes: {},
        });
        expect(first.isConnected).toBe(true);
        expect(first.open).toBe(false);
        expect(document.activeElement).toBe(runButton);
        expect(runButton.textContent).toBe('▶ Run');
        expect(document.querySelector('[role="status"]')?.textContent).toMatch(
            /^Failed · 9 statements/,
        );
    });

    it('streams a live run and swaps Run for Stop', () => {
        app.handle({
            kind: 'context',
            context: {
                ...baseContext,
                targetDetail: '',
                environment: 'production',
                sessionMode: 'keep',
                rollback: true,
                state: 'running',
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
        expect(document.querySelector('.status')?.textContent).toBe('Running line 8…');
        stop.click();
        expect(posted).toContainEqual({ kind: 'action', action: 'stop' });
        expect(document.querySelector('.pill.env')?.className).toContain('production');
        expect(document.querySelector('.pill.rollback')?.textContent).toBe('Rollback on');
        expect(document.body.classList.contains('production')).toBe(true);
    });

    it('shows what a statement would have sent when side effects are faked', () => {
        app.handle({ kind: 'context', context: { ...baseContext, fake: true } });
        expect(document.querySelector('.pill.fakes')?.textContent).toBe('Fakes on');
        (document.querySelector('.pill.fakes') as HTMLButtonElement).click();
        expect(posted).toContainEqual({ kind: 'action', action: 'toggleFakes' });

        app.handle({
            kind: 'render',
            run: {
                ...run,
                code: "<?php\nMail::to('ada@example.com')->send(new Welcome);\n",
                fake: true,
            },
            frames: [
                {
                    type: 'statement',
                    id: 'demo',
                    stmt: 1,
                    line: 2,
                    ok: true,
                    ms: 3,
                    memory: 0,
                    sideEffects: [
                        {
                            kind: 'mail',
                            summary: 'App\\Mail\\Welcome to ada@example.com',
                            html: '<p>Welcome, Ada</p>',
                        },
                        { kind: 'http', summary: 'POST https://api.example.com/charges' },
                    ],
                },
                {
                    type: 'result',
                    id: 'demo',
                    ok: true,
                    statements: 1,
                    ms: 3,
                    memory: 0,
                    faked: true,
                },
            ],
            changes: {},
        });
        expect(document.querySelector('.side-effects summary')?.textContent).toBe(
            'Faked 1 email · 1 HTTP request',
        );
        expect(
            [...document.querySelectorAll('.side-effect-summary')].map((item) => item.textContent),
        ).toEqual([
            'App\\Mail\\Welcome to ada@example.com',
            'POST https://api.example.com/charges',
        ]);
        expect(document.querySelector('.badge.faked')?.textContent).toBe('2 faked');
        expect(document.querySelector('.summary')?.textContent).toContain('2 side effects faked');

        const preview = [...document.querySelectorAll('.side-effect button')].find(
            (item) => item.textContent === 'Preview',
        ) as HTMLButtonElement;
        preview.click();
        expect(
            (document.querySelector('.side-effect iframe') as HTMLIFrameElement).srcdoc,
        ).toContain('Welcome, Ada');
        search('api.example.com');
        expect(visibleCards()).toHaveLength(1);
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
