import type {
    HostMessage,
    PanelAction,
    PanelContext,
    PanelMessage,
    StatementChange,
} from '../../shared/panelMessages';
import type { ScopeFrame } from '../../shared/protocol';
import {
    copyMenu,
    dumpView,
    errorView,
    sideEffectsView,
    sqlView,
    valueView,
    type Ctx,
} from './components';
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
    effects: HTMLElement;
    sql: HTMLElement;
    rendered: number;
    outputs: Map<number, HTMLElement>;
    /** What the SQL and side-effect sections were built from, so they only rebuild on change. */
    built: { queries?: unknown; sideEffects?: unknown };
}

/** The parts of a card that search looks at: its content, not its buttons and menus. */
const SEARCHABLE = [
    '.excerpt',
    'pre.output',
    // The shown view of a value (dump, model, table), without its copy menu.
    '.value-body',
    '.inline-result',
    '.error-class',
    '.error-message',
    '.trace',
    '.sql-text',
    '.n-plus-one',
    '.side-effect-summary',
].join(', ');

export class ResultsApp {
    private model: RunModel = emptyRun();
    private context: PanelContext = emptyContext();
    private scope: ScopeFrame | null = null;
    private scopeNote = '';
    private readonly views = new Map<number, CardView>();
    /** Highest statement with a card, so cards arriving in order are simply appended. */
    private lastStmt = -1;
    /** The welcome or "no output" message shown instead of cards. */
    private placeholder?: HTMLElement;
    private announced = '';
    private readonly ctx: Ctx;

    private readonly el = {
        title: h('h1', { class: 'title', text: 'OpenTinker' }),
        environment: h('span', { class: 'pill env' }),
        target: h('button', { class: 'pill target', attrs: { type: 'button' } }),
        mode: h('button', { class: 'pill mode', attrs: { type: 'button' } }),
        rollback: h('button', { class: 'pill rollback', attrs: { type: 'button' } }),
        fakes: h('button', { class: 'pill fakes', attrs: { type: 'button' } }),
        status: h('span', { class: 'status' }),
        /** Screen readers hear state changes and the final summary, not every frame. */
        announcer: h('div', {
            class: 'sr-only',
            attrs: { role: 'status', 'aria-live': 'polite' },
        }),
        toolbar: h('div', { class: 'toolbar' }),
        summary: h('div', { class: 'summary' }),
        code: h('details', { class: 'code-view' }),
        cards: h('div', { class: 'cards' }),
        results: h('section', {
            class: 'results',
            attrs: { role: 'tabpanel', id: 'results-panel', 'aria-labelledby': 'results-tab' },
        }),
        variables: h('section', {
            class: 'variables',
            attrs: {
                role: 'tabpanel',
                id: 'variables-panel',
                'aria-labelledby': 'variables-tab',
            },
        }),
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
            attrs: {
                type: 'button',
                role: 'tab',
                id: 'results-tab',
                'aria-controls': 'results-panel',
            },
        }),
        variablesTab: h('button', {
            class: 'tab',
            text: 'Variables',
            attrs: {
                type: 'button',
                role: 'tab',
                id: 'variables-tab',
                'aria-controls': 'variables-panel',
            },
        }),
        varHead: h('div', { class: 'var-head' }),
        varFilter: h('input', {
            class: 'search',
            attrs: {
                type: 'search',
                placeholder: 'Filter variables…',
                'aria-label': 'Filter variables',
            },
        }),
        varList: h('div', { class: 'var-list' }),
    };

    private readonly buttons: Record<'run' | 'restart' | 'clear', HTMLButtonElement>;

    constructor(
        private readonly root: HTMLElement,
        private readonly api: VsCodeApi,
    ) {
        this.ctx = { post: (message) => this.api.postMessage(message), run: () => this.model.run };
        this.buttons = {
            // One button that switches between Run and Stop, so focus stays put.
            run: button('▶ Run', () => this.action(this.busy ? 'stop' : 'run'), {
                class: 'tool primary run',
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
                this.renderStatus();
                break;
            }
            case 'finish':
                applyFrame(this.model, message.result);
                this.applyChanges(message.changes);
                this.finishRun();
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
            case 'context': {
                const modeChanged = message.context.sessionMode !== this.context.sessionMode;
                this.context = message.context;
                this.renderContext();
                this.renderStatus();
                if (!this.model.run) this.renderWelcome();
                if (modeChanged) this.renderVariables();
                break;
            }
            case 'clear':
                this.model = emptyRun();
                this.renderRun();
                break;
        }
    }

    private get busy(): boolean {
        return this.context.state !== 'idle' || this.model.running;
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
        el.fakes.addEventListener('click', () => this.action('toggleFakes'));
        el.search.addEventListener('input', () => this.applySearch());
        el.resultsTab.addEventListener('click', () => this.showTab('results'));
        el.variablesTab.addEventListener('click', () => this.showTab('variables'));
        el.varFilter.addEventListener('input', () => this.renderVariableList());

        el.toolbar.append(this.buttons.run, this.buttons.restart, this.buttons.clear);

        const tablist = h(
            'div',
            { class: 'tabs', attrs: { role: 'tablist' } },
            el.resultsTab,
            el.variablesTab,
        );
        tablist.addEventListener('keydown', (event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const next =
                event.key === 'Home'
                    ? 'results'
                    : event.key === 'End'
                      ? 'variables'
                      : el.results.hidden
                        ? 'results'
                        : 'variables';
            this.showTab(next);
            (next === 'results' ? el.resultsTab : el.variablesTab).focus();
        });

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
                el.fakes,
                el.status,
            ),
            h(
                'div',
                { class: 'tabs-row' },
                tablist,
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
        el.variables.append(el.varHead, el.varFilter, el.varList);
        this.root.replaceChildren(header, el.results, el.variables, el.announcer);
        this.showTab('results');
    }

    private showTab(tab: 'results' | 'variables'): void {
        const variables = tab === 'variables';
        this.el.results.hidden = variables;
        this.el.variables.hidden = !variables;
        this.el.search.parentElement?.toggleAttribute('hidden', variables);
        this.el.resultsTab.setAttribute('aria-selected', String(!variables));
        this.el.variablesTab.setAttribute('aria-selected', String(variables));
        this.el.resultsTab.tabIndex = variables ? -1 : 0;
        this.el.variablesTab.tabIndex = variables ? 0 : -1;
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

        el.fakes.textContent = context.fake ? 'Fakes on' : 'Fakes off';
        el.fakes.className = `pill fakes ${context.fake ? 'on' : 'off'}`;
        el.fakes.title = context.fake
            ? 'Mail, notifications, jobs and HTTP calls are faked, and each card shows what would have been sent.'
            : 'Click to fake mail, notifications, jobs and HTTP calls during runs.';

        this.buttons.restart.hidden = context.sessionMode !== 'keep';
        this.renderButtons();
    }

    private renderButtons(): void {
        const busy = this.busy;
        const runButton = this.buttons.run;
        const run = this.model.run;
        const scratch = this.context.scratchName;
        runButton.textContent = busy ? 'Stop' : '▶ Run';
        runButton.className = busy ? 'tool danger' : 'tool primary run';
        runButton.disabled = busy ? this.context.state === 'stopping' : !run?.code && !scratch;
        runButton.title = busy
            ? 'Stop the current run (Ctrl/Cmd+Alt+C)'
            : run && !run.scratch
              ? `Run ${run.label} again`
              : `Run ${scratch || run?.label || 'the scratch file'} (Ctrl/Cmd+Enter)`;
        this.buttons.clear.disabled = busy;
        this.buttons.restart.disabled = busy;
    }

    private renderStatus(): void {
        const { state } = this.context;
        let text = '';
        let announcement = '';
        if (state === 'starting') text = announcement = 'Starting…';
        else if (state === 'stopping') text = announcement = 'Stopping…';
        else if (state === 'running' || this.model.running) {
            announcement = 'Running…';
            const last = this.lastVisibleCard();
            text = last ? `Running line ${sourceLine(this.model.run, last.line)}…` : 'Running…';
        } else if (this.model.stored) text = 'From history';
        this.el.status.textContent = text;
        if (announcement) this.announce(announcement);
        this.renderButtons();
    }

    private announce(text: string): void {
        if (text === this.announced) return;
        this.announced = text;
        this.el.announcer.textContent = text;
    }

    private lastVisibleCard(): Card | undefined {
        let last: Card | undefined;
        for (const card of this.model.cards.values()) {
            if (!isHidden(card) && (!last || card.stmt > last.stmt)) last = card;
        }
        return last;
    }

    private renderRun(): void {
        const { el, model } = this;
        const run = model.run;
        el.title.textContent = run?.label || 'OpenTinker';
        el.title.title = run?.target ?? '';
        this.renderSummary();

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
                    text: `${run.target} · ${run.sessionMode === 'fresh' ? 'fresh session' : 'kept session'}${run.rollback ? ' · rollback' : ''}${run.fake ? ' · fakes' : ''} · ${new Date(run.at).toLocaleString()}`,
                }),
                copyMenu(this.ctx, [{ label: 'Code', value: () => run.code }]),
            );
        }

        this.views.clear();
        this.lastStmt = -1;
        this.placeholder = undefined;
        el.cards.replaceChildren();
        for (const card of orderedCards(model)) this.renderCard(card);
        this.renderPlaceholder();
        this.renderStatus();
    }

    /** Updates cards in place when a run ends, so open cards, chosen views and focus survive. */
    private finishRun(): void {
        for (const card of this.model.cards.values()) this.renderCard(card);
        this.renderSummary();
        this.renderPlaceholder();
        this.renderStatus();
        this.announce(summaryText(this.model));
    }

    private renderSummary(): void {
        const { el, model } = this;
        el.summary.textContent = summaryText(model);
        el.summary.className = `summary ${model.result ? (model.result.ok ? 'ok' : 'failed') : ''}`;
        el.summary.hidden = !model.result;
    }

    /** The welcome before any run, or a note when a run has nothing to show. */
    private renderPlaceholder(): void {
        const { model } = this;
        if (!model.run) {
            this.renderWelcome();
            return;
        }
        if (orderedCards(model).some((card) => !isHidden(card))) {
            this.removePlaceholder();
            return;
        }
        this.removePlaceholder();
        this.placeholder = h('div', {
            class: 'empty',
            text: model.running
                ? 'Running…'
                : model.stored && !model.result
                  ? 'Output was not kept for this run. Enable opentinker.history.persistResults to keep it.'
                  : 'Finished with no output. End a line with an expression, or use dump(), to see values.',
        });
        this.el.cards.append(this.placeholder);
    }

    private removePlaceholder(): void {
        this.placeholder?.remove();
        this.placeholder = undefined;
    }

    private renderWelcome(): void {
        this.placeholder = h(
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
        );
        this.el.cards.replaceChildren(this.placeholder);
    }

    private renderCard(card: Card): void {
        if (!this.model.run) return;
        let view = this.views.get(card.stmt);

        if (!view) {
            view = this.createCardView(card);
            this.views.set(card.stmt, view);
            this.removePlaceholder();
            const next = card.stmt > this.lastStmt ? undefined : this.viewAfter(card.stmt);
            this.el.cards.insertBefore(view.root, next?.root ?? null);
            this.lastStmt = Math.max(this.lastStmt, card.stmt);
        }

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

        // Rebuilt only when a statement frame brings new data, so open sections stay open.
        if (view.built.queries !== card.queries) {
            view.built.queries = card.queries;
            const sql = sqlView(this.ctx, card.queries, card.sql);
            view.sql.replaceChildren(...(sql ? [sql] : []));
        }
        if (view.built.sideEffects !== card.sideEffects) {
            view.built.sideEffects = card.sideEffects;
            const effects = sideEffectsView(card.sideEffects);
            view.effects.replaceChildren(...(effects ? [effects] : []));
        }
        if (card.sql?.repeated.length)
            view.meta.prepend(h('span', { class: 'badge warn', text: 'N+1?' }));
        else if ((card.sql?.total ?? 0) > 0)
            view.meta.prepend(h('span', { class: 'muted', text: `${card.sql?.total} SQL` }));
        if (card.sideEffects.length)
            view.meta.prepend(
                h('span', { class: 'badge faked', text: `${card.sideEffects.length} faked` }),
            );

        this.updateVisibility(view, card);
    }

    /** The first card view after this statement, to insert a late card before it. */
    private viewAfter(stmt: number): CardView | undefined {
        let next: [number, CardView] | undefined;
        for (const entry of this.views) {
            if (entry[0] > stmt && (!next || entry[0] < next[0])) next = entry;
        }
        return next?.[1];
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
        const effects = h('div', { class: 'card-effects' });
        const sql = h('div', { class: 'card-sql' });
        root.append(
            h('summary', { class: 'card-head' }, line, excerptEl, change, meta),
            body,
            effects,
            sql,
        );
        return {
            root,
            line,
            excerpt: excerptEl,
            change,
            meta,
            body,
            effects,
            sql,
            rendered: 0,
            outputs: new Map(),
            built: {},
        };
    }

    private renderVariables(): void {
        const keep = this.context.sessionMode === 'keep';
        this.el.varHead.replaceChildren(
            h('span', {
                text: keep ? 'Variables in the kept session' : 'Variables the last run left behind',
            }),
            this.scope?.truncated ? h('span', { class: 'badge warn', text: 'truncated' }) : null,
            keep
                ? button('Refresh', () => this.action('refreshScope'), { class: 'link-button' })
                : null,
        );
        this.renderVariableList();
    }

    private renderVariableList(): void {
        const vars = this.scope?.vars ?? [];
        const term = this.el.varFilter.value.trim().toLowerCase().replace(/^\$/, '');
        const list = this.el.varList;
        list.replaceChildren();
        for (const variable of vars.filter((item) => item.name.toLowerCase().includes(term))) {
            const item = h(
                'details',
                { class: 'var' },
                h(
                    'summary',
                    {},
                    h('code', { class: 'var-name', text: `$${variable.name}` }),
                    variable.type ? h('span', { class: 'var-type', text: variable.type }) : null,
                    variable.short ? h('span', { class: 'var-short', text: variable.short }) : null,
                ),
            );
            item.addEventListener('toggle', () => {
                if (item.open && !item.querySelector('.dump')) item.append(dumpView(variable.html));
            });
            list.append(item);
        }
        if (!vars.length)
            list.append(
                h('div', {
                    class: 'empty',
                    text: this.scopeNote || 'Run some code to see the variables it leaves behind.',
                }),
            );
    }

    private searchTerm(): string {
        return this.el.search.value.trim().toLowerCase();
    }

    private updateVisibility(view: CardView, card: Card, term = this.searchTerm()): void {
        view.root.hidden = isHidden(card) || (!!term && !matches(view.root, term));
    }

    private applySearch(): void {
        const term = this.searchTerm();
        for (const [stmt, view] of this.views) {
            const card = this.model.cards.get(stmt);
            if (card) this.updateVisibility(view, card, term);
        }
    }

    private setAllOpen(open: boolean): void {
        for (const view of this.views.values()) view.root.open = open;
    }
}

function matches(root: HTMLElement, term: string): boolean {
    for (const element of root.querySelectorAll(SEARCHABLE)) {
        if (element.textContent?.toLowerCase().includes(term)) return true;
    }
    return false;
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
