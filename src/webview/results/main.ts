import type {
    HostMessage,
    PanelAction,
    PanelContext,
    PanelMessage,
    StatementChange,
} from '../../shared/panelMessages';
import type { ScopeFrame } from '../../shared/protocol';
import { copyMenu, dumpView, errorView, sqlView, valueView, type Ctx } from './components';
import { button, h } from './dom';
import {
    applyFrame,
    beginRun,
    emptyContext,
    emptyRun,
    environmentClass,
    excerpt,
    formatMs,
    isHidden,
    orderedCards,
    sourceLine,
    summaryText,
    type Card,
    type RunModel,
} from './model';
import './styles.css';

interface VsCodeApi {
    postMessage(message: PanelMessage): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

interface CardView {
    root: HTMLDetailsElement;
    line: HTMLButtonElement;
    excerpt: HTMLElement;
    change: HTMLElement;
    meta: HTMLElement;
    body: HTMLElement;
    sql: HTMLElement;
    rendered: number;
    outputs: Map<number, HTMLElement>;
}

export class ResultsApp {
    private model: RunModel = emptyRun();
    private context: PanelContext = emptyContext();
    private scope: ScopeFrame | null = null;
    private scopeNote = '';
    private readonly views = new Map<number, CardView>();
    private tab: 'results' | 'variables' = 'results';
    private readonly ctx: Ctx;

    private readonly el = {
        title: h('h1', { class: 'title', text: 'OpenTinker' }),
        environment: h('span', { class: 'pill env' }),
        target: h('button', { class: 'pill target', attrs: { type: 'button' } }),
        mode: h('button', { class: 'pill mode', attrs: { type: 'button' } }),
        rollback: h('button', { class: 'pill rollback', attrs: { type: 'button' } }),
        status: h('span', { class: 'status', attrs: { role: 'status', 'aria-live': 'polite' } }),
        toolbar: h('div', { class: 'toolbar' }),
        summary: h('div', { class: 'summary' }),
        code: h('details', { class: 'code-view' }),
        cards: h('div', { class: 'cards' }),
        results: h('section', { class: 'results', attrs: { role: 'tabpanel' } }),
        variables: h('section', { class: 'variables', attrs: { role: 'tabpanel' } }),
        search: h('input', {
            class: 'search',
            attrs: {
                type: 'search',
                placeholder: 'Search results…',
                'aria-label': 'Search results',
            },
        }),
        resultsTab: h('button', {
            class: 'tab',
            text: 'Results',
            attrs: { type: 'button', role: 'tab' },
        }),
        variablesTab: h('button', {
            class: 'tab',
            text: 'Variables',
            attrs: { type: 'button', role: 'tab' },
        }),
    };

    private readonly buttons: Record<'rerun' | 'stop' | 'restart' | 'clear', HTMLButtonElement>;

    constructor(
        private readonly root: HTMLElement,
        private readonly api: VsCodeApi,
    ) {
        this.ctx = { post: (message) => this.api.postMessage(message), run: () => this.model.run };
        this.buttons = {
            rerun: button('▶ Run', () => this.action('run'), {
                class: 'tool primary run',
                title: 'Run the scratch file',
            }),
            stop: button('Stop', () => this.action('stop'), {
                class: 'tool danger',
                title: 'Stop the current run',
            }),
            restart: button('Reset session', () => this.action('restartSession'), {
                class: 'tool',
                title: 'Clear the kept session’s variables (keep-session mode)',
            }),
            clear: button('Clear', () => this.action('clear'), {
                class: 'tool',
                title: 'Clear this view',
            }),
        };
        this.layout();
        this.renderContext();
        this.renderRun();
        this.renderVariables();
    }

    handle(message: HostMessage): void {
        switch (message.kind) {
            case 'begin':
                this.model = beginRun(message.run);
                this.renderRun();
                break;
            case 'frame': {
                const card = applyFrame(this.model, message.frame);
                if (card) this.renderCard(card);
                if (message.frame.type === 'result') this.renderRun();
                else this.renderStatus();
                break;
            }
            case 'finish':
                applyFrame(this.model, message.result);
                this.applyChanges(message.changes);
                this.renderRun();
                break;
            case 'render':
                this.model = beginRun(message.run);
                this.model.running = false;
                this.model.stored = true;
                for (const frame of message.frames) applyFrame(this.model, frame);
                this.applyChanges(message.changes);
                this.renderRun();
                break;
            case 'scope':
                this.scope = message.scope;
                this.scopeNote = message.note ?? '';
                this.renderVariables();
                break;
            case 'context':
                this.context = message.context;
                this.renderContext();
                this.renderStatus();
                break;
            case 'clear':
                this.model = emptyRun();
                this.renderRun();
                break;
        }
    }

    private action(action: PanelAction): void {
        this.api.postMessage({ kind: 'action', action });
    }

    private applyChanges(changes: Record<number, StatementChange>): void {
        for (const [stmt, change] of Object.entries(changes)) {
            const card = this.model.cards.get(Number(stmt));
            if (card) card.change = change;
        }
    }

    private layout(): void {
        const { el } = this;
        el.target.addEventListener('click', () => this.action('chooseTarget'));
        el.mode.addEventListener('click', () => this.action('toggleMode'));
        el.rollback.addEventListener('click', () => this.action('toggleRollback'));
        el.search.addEventListener('input', () => this.applySearch());
        el.resultsTab.addEventListener('click', () => this.showTab('results'));
        el.variablesTab.addEventListener('click', () => this.showTab('variables'));

        el.toolbar.append(
            this.buttons.rerun,
            this.buttons.stop,
            this.buttons.restart,
            this.buttons.clear,
        );

        const header = h(
            'header',
            {},
            h('div', { class: 'title-row' }, el.title, el.toolbar),
            h(
                'div',
                { class: 'context-row' },
                el.environment,
                el.target,
                el.mode,
                el.rollback,
                el.status,
            ),
            h(
                'div',
                { class: 'tabs-row' },
                h(
                    'div',
                    { class: 'tabs', attrs: { role: 'tablist' } },
                    el.resultsTab,
                    el.variablesTab,
                ),
                h(
                    'div',
                    { class: 'tools' },
                    el.search,
                    button('Collapse all', () => this.setAllOpen(false), { class: 'link-button' }),
                    button('Expand all', () => this.setAllOpen(true), { class: 'link-button' }),
                ),
            ),
        );

        el.results.append(el.summary, el.code, el.cards);
        this.root.replaceChildren(header, el.results, el.variables);
        this.showTab('results');
    }

    private showTab(tab: 'results' | 'variables'): void {
        this.tab = tab;
        const variables = tab === 'variables';
        this.el.results.hidden = variables;
        this.el.variables.hidden = !variables;
        this.el.search.parentElement?.toggleAttribute('hidden', variables);
        this.el.resultsTab.setAttribute('aria-selected', String(!variables));
        this.el.variablesTab.setAttribute('aria-selected', String(variables));
        if (variables && this.context.sessionMode === 'keep') this.action('refreshScope');
    }

    private renderContext(): void {
        const { el, context } = this;
        const env = environmentClass(context.environment);
        el.environment.textContent =
            env === 'unknown' ? context.environment.toUpperCase() || 'UNKNOWN' : env.toUpperCase();
        el.environment.className = `pill env ${env}`;
        el.environment.title = `APP_ENV: ${context.environment}`;
        document.body.classList.toggle('production', env === 'production');

        el.target.textContent = context.hasTarget ? `${context.targetName} ▾` : 'Choose target ▾';
        el.target.title = context.targetDetail || 'Choose where code runs';

        el.mode.textContent = context.sessionMode === 'fresh' ? 'Fresh session' : 'Keep session';
        el.mode.className = `pill mode ${context.sessionMode}`;
        el.mode.title =
            context.sessionMode === 'fresh'
                ? `Every run starts from a freshly booted app${context.fork ? '' : ' (restarts PHP each run: pcntl is unavailable)'}. Click to keep variables between runs.`
                : 'Variables and imports carry over between runs. Click to start fresh each run.';

        el.rollback.textContent = context.rollback ? 'Rollback on' : 'Rollback off';
        el.rollback.className = `pill rollback ${context.rollback ? 'on' : 'off'}`;
        el.rollback.title = context.rollback
            ? 'Database changes are rolled back after each run. Mail, queues and files are not.'
            : 'Click to roll back database changes after each run.';

        this.buttons.restart.hidden = context.sessionMode !== 'keep';
        this.renderButtons();
    }

    private renderButtons(): void {
        const busy = this.context.state !== 'idle' || this.model.running;
        this.buttons.stop.hidden = !busy;
        this.buttons.rerun.hidden = busy;
        const run = this.model.run;
        const scratch = this.context.scratchName;
        this.buttons.rerun.disabled = !run?.code && !scratch;
        this.buttons.rerun.title =
            run && !run.scratch
                ? `Run ${run.label} again`
                : `Run ${scratch || run?.label || 'the scratch file'} (Ctrl/Cmd+Enter)`;
        this.buttons.clear.disabled = busy;
        this.buttons.restart.disabled = busy;
    }

    private renderStatus(): void {
        const { state } = this.context;
        let text = '';
        if (state === 'starting') text = 'Starting…';
        else if (state === 'stopping') text = 'Stopping…';
        else if (state === 'running' || this.model.running) {
            const cards = orderedCards(this.model).filter((card) => !isHidden(card));
            const last = cards.at(-1);
            text = last ? `Running line ${sourceLine(this.model.run, last.line)}…` : 'Running…';
        } else if (this.model.stored) text = 'From history';
        this.el.status.textContent = text;
        this.renderButtons();
    }

    private renderRun(): void {
        const { el, model } = this;
        const run = model.run;
        el.title.textContent = run?.label || 'OpenTinker';
        el.title.title = run?.target ?? '';

        el.summary.textContent = summaryText(model);
        el.summary.className = `summary ${model.result ? (model.result.ok ? 'ok' : 'failed') : ''}`;
        el.summary.hidden = !model.result;

        el.code.hidden = !run;
        el.code.open = false;
        if (run) {
            el.code.replaceChildren(
                h('summary', { text: 'Executed code' }),
                run.imports.length
                    ? h(
                          'div',
                          { class: 'imports' },
                          h('div', { class: 'muted', text: 'Imports applied from the file:' }),
                          h('pre', { text: run.imports.join('\n') }),
                      )
                    : null,
                h('pre', { class: 'code', text: run.code }),
                h('div', {
                    class: 'code-meta muted',
                    text: `${run.target} · ${run.sessionMode === 'fresh' ? 'fresh session' : 'kept session'}${run.rollback ? ' · rollback' : ''} · ${new Date(run.at).toLocaleString()}`,
                }),
                copyMenu(this.ctx, [{ label: 'Code', value: () => run.code }]),
            );
        }

        this.views.clear();
        el.cards.replaceChildren();
        const cards = orderedCards(model);
        for (const card of cards) this.renderCard(card);

        if (!run) this.renderWelcome();
        else if (!cards.some((card) => !isHidden(card))) {
            el.cards.append(
                h('div', {
                    class: 'empty',
                    text: model.running
                        ? 'Running…'
                        : model.stored && !model.result
                          ? 'Output was not kept for this run. Enable opentinker.history.persistResults to keep it.'
                          : 'Finished with no output. End a line with an expression, or use dump(), to see values.',
                }),
            );
        }

        this.renderStatus();
        this.applySearch();
    }

    private renderWelcome(): void {
        this.el.cards.replaceChildren(
            h(
                'div',
                { class: 'welcome' },
                h('h2', { text: 'Tinker with your app' }),
                h('p', {
                    text: 'Write PHP in a scratch file and run it against your app. Each line gets its own result card.',
                }),
                h(
                    'ul',
                    {},
                    h('li', {}, h('kbd', { text: 'Ctrl/Cmd+Enter' }), ' runs a scratch file'),
                    h(
                        'li',
                        {},
                        h('kbd', { text: 'Ctrl/Cmd+Shift+Enter' }),
                        ' runs the selection or current line in any PHP file',
                    ),
                    h(
                        'li',
                        {},
                        h('code', { text: '//?' }),
                        ' at the end of a line shows its value inline',
                    ),
                ),
                h(
                    'div',
                    { class: 'welcome-actions' },
                    this.context.scratchName
                        ? button(`▶ Run ${this.context.scratchName}`, () => this.action('run'), {
                              class: 'tool primary run big',
                          })
                        : null,
                    button('New scratch file', () => this.action('newScratch'), {
                        class: this.context.scratchName ? 'tool' : 'tool primary',
                    }),
                    button(
                        this.context.hasTarget ? 'Change target' : 'Choose target',
                        () => this.action('chooseTarget'),
                        { class: 'tool' },
                    ),
                ),
            ),
        );
    }

    private renderCard(card: Card): void {
        if (!this.model.run) return;
        let view = this.views.get(card.stmt);

        if (!view) {
            view = this.createCardView(card);
            this.views.set(card.stmt, view);
            this.el.cards.querySelector('.empty, .welcome')?.remove();
            const after = [...this.views.entries()]
                .filter(([stmt]) => stmt > card.stmt)
                .sort((a, b) => a[0] - b[0])[0];
            this.el.cards.insertBefore(view.root, after ? after[1].root : null);
        }

        view.root.hidden = isHidden(card);
        view.root.className = `card ${card.status}`;
        const run = this.model.run;
        const line = sourceLine(run, card.line);
        view.line.textContent = card.stmt === 0 ? 'Run' : `Line ${line}`;
        view.line.disabled = !run.hasSource || card.stmt === 0;
        view.excerpt.textContent = card.stmt === 0 ? '' : excerpt(run, card.line, card.endLine);
        view.excerpt.title = view.excerpt.textContent;

        view.change.hidden = !card.change || card.change === 'same';
        view.change.textContent = card.change === 'new' ? 'new' : 'changed';
        view.change.className = `badge change ${card.change ?? ''}`;
        view.change.title =
            card.change === 'changed'
                ? 'Different from the previous run of this file'
                : 'Not in the previous run';

        const meta: Array<Node | string> = [];
        if (card.exit) meta.push(h('span', { class: 'exit', text: card.exit }));
        if (card.ms !== undefined) meta.push(h('span', { text: formatMs(card.ms) }));
        view.meta.replaceChildren(...meta);

        card.items.forEach((item, index) => {
            if (index < view.rendered) {
                // Echo output streams in fragments that merge into one item.
                const output = view.outputs.get(index);
                if (item.kind === 'output' && output) output.textContent = item.text;
                return;
            }
            if (item.kind === 'output') {
                const pre = h('pre', { class: 'output', text: item.text });
                view.outputs.set(index, pre);
                view.body.append(
                    h(
                        'div',
                        { class: 'output-block' },
                        pre,
                        copyMenu(this.ctx, [
                            { label: 'Output', value: () => pre.textContent ?? '' },
                        ]),
                    ),
                );
            } else if (item.kind === 'value') view.body.append(valueView(this.ctx, item.frame));
            else if (item.kind === 'inline')
                view.body.append(h('div', { class: 'inline-result', text: `//? ${item.text}` }));
            else view.body.append(errorView(this.ctx, item.frame));
        });
        view.rendered = card.items.length;

        const sql = sqlView(this.ctx, card.queries, card.sql);
        view.sql.replaceChildren(...(sql ? [sql] : []));
        if (card.sql?.repeated.length)
            view.meta.prepend(h('span', { class: 'badge warn', text: 'N+1?' }));
        else if ((card.sql?.total ?? 0) > 0)
            view.meta.prepend(h('span', { class: 'muted', text: `${card.sql?.total} SQL` }));
    }

    private createCardView(card: Card): CardView {
        const root = h('details', { class: 'card' });
        root.open = true;
        const line = button(
            '',
            () => {
                const run = this.model.run;
                if (run?.hasSource)
                    this.api.postMessage({
                        kind: 'openLine',
                        line: sourceLine(run, this.model.cards.get(card.stmt)?.line ?? card.line),
                    });
            },
            { class: 'line-badge', title: 'Go to this line' },
        );
        const excerptEl = h('code', { class: 'excerpt' });
        const change = h('span', { class: 'badge change' });
        const meta = h('span', { class: 'meta' });
        const body = h('div', { class: 'card-body' });
        const sql = h('div', { class: 'card-sql' });
        root.append(h('summary', { class: 'card-head' }, line, excerptEl, change, meta), body, sql);
        return {
            root,
            line,
            excerpt: excerptEl,
            change,
            meta,
            body,
            sql,
            rendered: 0,
            outputs: new Map(),
        };
    }

    private renderVariables(): void {
        const { variables } = this.el;
        const vars = this.scope?.vars ?? [];
        const filter = h('input', {
            class: 'search',
            attrs: {
                type: 'search',
                placeholder: 'Filter variables…',
                'aria-label': 'Filter variables',
            },
        });
        const list = h('div', { class: 'var-list' });

        const render = (): void => {
            const term = filter.value.trim().toLowerCase().replace(/^\$/, '');
            list.replaceChildren();
            for (const variable of vars.filter((item) => item.name.toLowerCase().includes(term))) {
                const item = h(
                    'details',
                    { class: 'var' },
                    h(
                        'summary',
                        {},
                        h('code', { class: 'var-name', text: `$${variable.name}` }),
                        variable.type
                            ? h('span', { class: 'var-type', text: variable.type })
                            : null,
                        variable.short
                            ? h('span', { class: 'var-short', text: variable.short })
                            : null,
                    ),
                );
                item.addEventListener('toggle', () => {
                    if (item.open && !item.querySelector('.dump'))
                        item.append(dumpView(variable.html));
                });
                list.append(item);
            }
            if (!vars.length)
                list.append(
                    h('div', {
                        class: 'empty',
                        text:
                            this.scopeNote ||
                            'Run some code to see the variables it leaves behind.',
                    }),
                );
        };
        filter.addEventListener('input', render);

        const heading =
            this.context.sessionMode === 'keep'
                ? 'Variables in the kept session'
                : 'Variables the last run left behind';
        variables.replaceChildren(
            h(
                'div',
                { class: 'var-head' },
                h('span', { text: heading }),
                this.scope?.truncated
                    ? h('span', { class: 'badge warn', text: 'truncated' })
                    : null,
                this.context.sessionMode === 'keep'
                    ? button('Refresh', () => this.action('refreshScope'), { class: 'link-button' })
                    : null,
            ),
            filter,
            list,
        );
        render();
    }

    private applySearch(): void {
        const term = this.el.search.value.trim().toLowerCase();
        for (const [stmt, view] of this.views) {
            const card = this.model.cards.get(stmt);
            const hidden = card ? isHidden(card) : false;
            view.root.hidden =
                hidden || (!!term && !view.root.textContent?.toLowerCase().includes(term));
        }
    }

    private setAllOpen(open: boolean): void {
        for (const view of this.views.values()) view.root.open = open;
    }

    get currentTab(): string {
        return this.tab;
    }
}

export function start(): ResultsApp {
    const api = acquireVsCodeApi();
    const root = document.getElementById('app') ?? document.body;
    const app = new ResultsApp(root, api);
    window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
        if (event.data && typeof event.data.kind === 'string') app.handle(event.data);
    });
    api.postMessage({ kind: 'ready' });
    return app;
}

if (typeof acquireVsCodeApi === 'function') start();
