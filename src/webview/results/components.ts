import type { PanelMessage, RunView } from '../../shared/panelMessages';
import type {
    DumpFrame,
    ErrorFrame,
    FatalFrame,
    HtmlPreview,
    ModelCard,
    QueryRecord,
    SideEffect,
    SqlSummary,
    TableValue,
    TraceFrame,
    ValueFrame,
} from '../../shared/protocol';
import { button, h, shortClass } from './dom';
import { formatMs, sourceLine, toCsv, toMarkdown } from './model';

export interface Ctx {
    post(message: PanelMessage): void;
    run(): RunView | null;
}

/**
 * VarDumper HTML without its bundled script: add our own expand/collapse
 * toggles to each nested level. The HTML comes from VarDumper, which escapes
 * every dumped value.
 */
export function dumpView(html: string): HTMLElement {
    const container = h('div', { class: 'dump' });
    container.innerHTML = html;
    for (const samp of container.querySelectorAll<HTMLElement>('samp[data-depth]')) {
        const collapsed = samp.classList.contains('sf-dump-compact');
        const toggle = h('button', {
            class: 'dump-toggle',
            text: collapsed ? '▸' : '▾',
            title: collapsed ? 'Expand' : 'Collapse',
            attrs: { type: 'button', 'aria-expanded': String(!collapsed) },
        });
        toggle.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            const expand = samp.classList.contains('sf-dump-compact');
            samp.classList.toggle('sf-dump-compact', !expand);
            samp.classList.toggle('sf-dump-expanded', expand);
            toggle.textContent = expand ? '▾' : '▸';
            toggle.title = expand ? 'Collapse' : 'Expand';
            toggle.setAttribute('aria-expanded', String(expand));
        });
        samp.before(toggle);
    }
    return container;
}

export interface CopyOption {
    label: string;
    value: () => string;
    save?: string;
}

const menus = new Set<{ wrap: HTMLElement; menu: HTMLElement }>();
let menuListener = false;

function trackMenu(wrap: HTMLElement, menu: HTMLElement): void {
    menus.add({ wrap, menu });
    if (menuListener) return;
    menuListener = true;
    document.addEventListener('click', (event) => {
        for (const item of menus) {
            if (!item.wrap.isConnected) menus.delete(item);
            else if (!item.wrap.contains(event.target as Node)) item.menu.hidden = true;
        }
    });
}

/** A small "Copy ▾" menu offering several formats. */
export function copyMenu(ctx: Ctx, options: CopyOption[]): HTMLElement {
    const wrap = h('span', { class: 'copy-menu' });
    const menu = h('div', { class: 'menu', attrs: { role: 'menu' } });
    menu.hidden = true;
    const trigger = button(
        options.length > 1 ? 'Copy ▾' : `Copy ${options[0]?.label.toLowerCase() ?? ''}`.trim(),
        () => {
            if (options.length === 1) {
                const [only] = options;
                if (only) ctx.post({ kind: 'copy', text: only.value() });
                return;
            }
            setOpen(menu.hidden);
        },
        { title: 'Copy this value' },
    );
    const setOpen = (open: boolean): void => {
        menu.hidden = !open;
        trigger.setAttribute('aria-expanded', String(open));
        if (open) (menu.firstElementChild as HTMLElement | null)?.focus();
    };
    for (const option of options) {
        const item = button(
            option.label,
            () => {
                setOpen(false);
                if (option.save)
                    ctx.post({ kind: 'save', filename: option.save, content: option.value() });
                else ctx.post({ kind: 'copy', text: option.value() });
            },
            { class: 'menu-item' },
        );
        item.setAttribute('role', 'menuitem');
        menu.append(item);
    }
    if (options.length > 1) {
        trigger.setAttribute('aria-haspopup', 'menu');
        trigger.setAttribute('aria-expanded', 'false');
    }
    menu.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        setOpen(false);
        trigger.focus();
    });
    wrap.append(trigger, menu);
    trackMenu(wrap, menu);
    return wrap;
}

/** A dumped or returned value, with switchable views and copy formats. */
export function valueView(ctx: Ctx, frame: DumpFrame | ValueFrame): HTMLElement {
    const section = h('div', { class: `value-item ${frame.type}` });
    const views: Array<{ name: string; build: () => HTMLElement }> = [];

    // The most useful view comes first and opens by default: a model's card, a
    // collection's table, a mailable or response rendered. The dump is always there.
    const preview = frame.preview?.html ? frame.preview : undefined;
    const rendered = preview
        ? { name: previewLabel(preview), build: () => previewView(preview) }
        : undefined;
    if (frame.model)
        views.push({ name: 'Model', build: () => modelView(frame.model as ModelCard) });
    if (frame.table?.columns.length && frame.table.rows.length)
        views.push({ name: 'Table', build: () => tableView(frame.table as TableValue) });
    if (rendered && preview?.kind !== 'html') views.push(rendered);
    views.push({ name: 'Dump', build: () => dumpView(frame.html) });
    if (rendered && preview?.kind === 'html') views.push(rendered);

    const body = h('div', { class: 'value-body' });
    const built = new Map<string, HTMLElement>();
    const tabs = h('div', { class: 'view-tabs', attrs: { role: 'group', 'aria-label': 'View' } });
    const show = (name: string): void => {
        for (const tab of tabs.children)
            tab.setAttribute('aria-pressed', String(tab.textContent === name));
        let view = built.get(name);
        if (!view) {
            view = views.find((item) => item.name === name)?.build() ?? h('div');
            built.set(name, view);
        }
        body.replaceChildren(view);
    };

    if (views.length > 1) {
        for (const view of views) {
            tabs.append(
                h('button', {
                    class: 'view-tab',
                    text: view.name,
                    attrs: { type: 'button', 'aria-pressed': 'false' },
                    on: { click: () => show(view.name) },
                }),
            );
        }
    }

    const copyOptions: CopyOption[] = [
        {
            label: 'As text',
            value: () =>
                ((built.get('Dump') ?? dumpView(frame.html)).textContent ?? '')
                    .replace(/[▸▾]/g, '')
                    .trim(),
        },
    ];
    if (frame.copy?.json)
        copyOptions.push({ label: 'As JSON', value: () => frame.copy?.json ?? '' });
    if (frame.copy?.php)
        copyOptions.push({ label: 'As PHP array', value: () => frame.copy?.php ?? '' });
    const table = frame.table;
    if (table?.columns.length) {
        copyOptions.push({ label: 'As CSV', value: () => toCsv(table.columns, table.rows) });
        copyOptions.push({
            label: 'As Markdown table',
            value: () => toMarkdown(table.columns, table.rows),
        });
        copyOptions.push({
            label: 'Save as CSV…',
            value: () => toCsv(table.columns, table.rows),
            save: 'opentinker-results.csv',
        });
    }

    const prefix = frame.type === 'value' ? h('span', { class: 'value-prefix', text: '=' }) : null;
    if (views.length === 1) {
        // A plain value reads best on one line: "= 42 … Copy".
        section.classList.add('single');
        section.append(...(prefix ? [prefix] : []), body, copyMenu(ctx, copyOptions));
    } else {
        const bar = h(
            'div',
            { class: 'value-bar' },
            prefix,
            tabs,
            h('span', { class: 'spacer' }),
            copyMenu(ctx, copyOptions),
        );
        section.append(bar, body);
    }
    show(views[0]?.name ?? 'Dump');
    return section;
}

function previewLabel(preview: HtmlPreview): string {
    return preview.kind === 'mailable'
        ? 'Email'
        : preview.kind === 'response'
          ? 'Response'
          : 'HTML';
}

export function modelView(model: ModelCard): HTMLElement {
    const card = h('div', { class: 'model-card' });
    const title = h(
        'div',
        { class: 'model-title' },
        h('span', { class: 'model-class', text: shortClass(model.class), title: model.class }),
        model.key !== null ? h('span', { class: 'model-key', text: `#${model.key}` }) : null,
        h('span', { class: 'model-table', text: model.table }),
        !model.exists ? h('span', { class: 'badge warn', text: 'not saved' }) : null,
        model.recentlyCreated ? h('span', { class: 'badge ok', text: 'just created' }) : null,
        model.exists && model.dirty.length
            ? h('span', { class: 'badge warn', text: `unsaved: ${model.dirty.join(', ')}` })
            : null,
    );
    card.append(title);

    const rows = h('tbody');
    for (const attribute of model.attributes) {
        rows.append(
            h(
                'tr',
                { class: model.exists && attribute.dirty ? 'dirty' : '' },
                h('th', { text: attribute.name, attrs: { scope: 'row' } }),
                h('td', { class: `attr-value type-${attribute.type}`, text: attribute.value }),
                h(
                    'td',
                    { class: 'attr-meta' },
                    attribute.cast ? h('span', { class: 'badge', text: attribute.cast }) : null,
                    attribute.hidden ? h('span', { class: 'badge muted', text: 'hidden' }) : null,
                ),
            ),
        );
    }

    if (model.attributes.length > 12) {
        const filter = h('input', {
            class: 'filter',
            attrs: {
                type: 'search',
                placeholder: 'Filter attributes…',
                'aria-label': 'Filter attributes',
            },
        });
        filter.addEventListener('input', () => {
            const term = filter.value.toLowerCase();
            for (const row of rows.rows)
                row.hidden = !!term && !row.textContent?.toLowerCase().includes(term);
        });
        card.append(filter);
    }

    card.append(h('table', { class: 'attributes' }, rows));

    if (model.relations.length) {
        const list = h('ul', { class: 'relations' });
        for (const relation of model.relations) {
            list.append(h('li', {}, h('code', { text: relation.name }), ` ${relation.summary}`));
        }
        card.append(h('div', { class: 'section-label', text: 'Loaded relations' }), list);
    }

    return card;
}

export function tableView(table: TableValue): HTMLElement {
    const wrap = h('div', { class: 'table-view' });
    const filter = h('input', {
        class: 'filter',
        attrs: { type: 'search', placeholder: 'Filter rows…', 'aria-label': 'Filter table rows' },
    });
    const head = h(
        'tr',
        {},
        ...table.columns.map((column) => h('th', { text: column, attrs: { scope: 'col' } })),
    );
    const body = h('tbody');
    for (const row of table.rows)
        body.append(h('tr', {}, ...row.map((cell) => h('td', { text: cell }))));
    filter.addEventListener('input', () => {
        const term = filter.value.toLowerCase();
        for (const row of body.rows)
            row.hidden = !!term && !row.textContent?.toLowerCase().includes(term);
    });
    wrap.append(
        h(
            'div',
            { class: 'table-tools' },
            filter,
            h('span', {
                class: 'muted',
                text: `${table.rows.length} rows${table.truncated ? ' (first 500)' : ''} · ${table.columns.length} columns`,
            }),
        ),
        h(
            'div',
            { class: 'table-scroll' },
            h('table', { class: 'grid' }, h('thead', {}, head), body),
        ),
    );
    return wrap;
}

const REMOTE_IMAGE = /(?:src|srcset|background)\s*=\s*["']?\s*https:|url\(\s*["']?\s*https:/i;

/**
 * HTML in a sandboxed frame with no scripts. Remote images stay blocked until
 * asked for: in an email they can be tracking pixels that tell the sender it
 * was opened, from where.
 */
export function previewView(preview: HtmlPreview): HTMLElement {
    const frame = h('iframe', {
        class: 'preview',
        attrs: { sandbox: '', title: previewLabel(preview) + ' preview' },
    });
    const load = (remoteImages: boolean): void => {
        const images = remoteImages ? 'data: https:' : 'data:';
        frame.srcdoc = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src ${images}; font-src data:">${preview.html}`;
    };
    load(false);
    if (!REMOTE_IMAGE.test(preview.html)) return frame;

    const note = h('div', { class: 'preview-note muted' }, 'Remote images are blocked. ');
    note.append(
        button(
            'Load remote images',
            () => {
                load(true);
                note.remove();
            },
            { title: 'Remote images can tell the sender that this was opened' },
        ),
    );
    return h('div', { class: 'preview-wrap' }, note, frame);
}

export function errorView(ctx: Ctx, frame: ErrorFrame | FatalFrame): HTMLElement {
    const box = h('div', { class: 'error-box' });

    if (frame.type === 'fatal') {
        box.append(h('div', { class: 'error-message', text: frame.message }));
        return box;
    }

    const run = ctx.run();
    const line = frame.scratchLine ?? frame.line ?? null;
    box.append(
        h(
            'div',
            { class: 'error-head' },
            h('span', {
                class: 'error-class',
                text: shortClass(frame.errorClass),
                title: frame.errorClass,
            }),
            line && run?.hasSource
                ? button(
                      `Line ${sourceLine(run, line)}`,
                      () => ctx.post({ kind: 'openLine', line: sourceLine(run, line) }),
                      {
                          class: 'link-button line-link',
                          title: 'Go to this line',
                      },
                  )
                : null,
        ),
        h('div', { class: 'error-message', text: frame.message }),
    );

    const frames = frame.frames ?? [];
    const appFrames = frames.filter((item) => item.kind === 'app');
    const vendorFrames = frames.filter((item) => item.kind === 'vendor');

    if (appFrames.length) {
        const list = h('ol', { class: 'trace' });
        for (const item of appFrames) list.append(traceItem(ctx, item));
        box.append(list);
    }

    if (vendorFrames.length) {
        const list = h('ol', { class: 'trace vendor' });
        for (const item of vendorFrames) list.append(traceItem(ctx, item));
        box.append(
            h(
                'details',
                { class: 'vendor-frames' },
                h('summary', {
                    text: `${vendorFrames.length} vendor ${vendorFrames.length === 1 ? 'frame' : 'frames'}`,
                }),
                list,
            ),
        );
    }

    const copyText = [
        `${frame.errorClass}: ${frame.message}`,
        ...frames
            .filter((item) => item.file)
            .map((item) => `  at ${item.call || '{main}'} (${item.file}:${item.line ?? '?'})`),
    ].join('\n');
    box.append(
        h(
            'div',
            { class: 'error-actions' },
            copyMenu(ctx, [{ label: 'Error', value: () => copyText }]),
        ),
    );
    return box;
}

function traceItem(ctx: Ctx, item: TraceFrame): HTMLElement {
    const file = item.file ?? '';
    const location = `${file.split('/').slice(-3).join('/')}${item.line ? ':' + item.line : ''}`;
    return h(
        'li',
        {},
        h('code', { class: 'call', text: item.call || '{main}' }),
        ' ',
        file
            ? button(location, () => ctx.post({ kind: 'openFile', file, line: item.line }), {
                  class: 'link-button file-link',
                  title: `Open ${file}`,
              })
            : null,
    );
}

const SIDE_EFFECT_NAMES: Record<SideEffect['kind'], [string, string]> = {
    mail: ['email', 'emails'],
    notification: ['notification', 'notifications'],
    job: ['job', 'jobs'],
    http: ['HTTP request', 'HTTP requests'],
};

/** What a statement would have sent, captured by fakes instead. */
export function sideEffectsView(effects: SideEffect[]): HTMLElement | null {
    if (!effects.length) return null;
    const counts = new Map<SideEffect['kind'], number>();
    for (const effect of effects) counts.set(effect.kind, (counts.get(effect.kind) ?? 0) + 1);

    const details = h('details', { class: 'side-effects' });
    details.open = true;
    details.append(
        h(
            'summary',
            {},
            h('span', { class: 'side-effects-label', text: 'Faked' }),
            ` ${[...counts].map(([kind, count]) => `${count} ${SIDE_EFFECT_NAMES[kind][count === 1 ? 0 : 1]}`).join(' · ')}`,
        ),
    );

    const list = h('ul', { class: 'side-effect-list' });
    for (const effect of effects) {
        const item = h(
            'li',
            { class: `side-effect ${effect.kind}` },
            h('span', {
                class: 'badge',
                text: effect.kind === 'http' ? 'HTTP' : SIDE_EFFECT_NAMES[effect.kind][0],
            }),
            h('span', { class: 'side-effect-summary', text: effect.summary }),
        );
        const html = effect.html;
        if (html) {
            let preview: HTMLElement | undefined;
            const toggle = button(
                'Preview',
                () => {
                    if (preview) {
                        preview.remove();
                        preview = undefined;
                        toggle.textContent = 'Preview';
                        return;
                    }
                    preview = previewView({ kind: 'mailable', html });
                    item.append(preview);
                    toggle.textContent = 'Hide preview';
                },
                { title: 'Show the email that would have been sent' },
            );
            item.append(toggle);
        }
        list.append(item);
    }
    details.append(list);
    return details;
}

export function sqlView(
    ctx: Ctx,
    queries: QueryRecord[],
    summary: SqlSummary | undefined,
): HTMLElement | null {
    const total = summary?.total ?? queries.length;
    if (!total) return null;

    const time = summary?.time ?? queries.reduce((sum, query) => sum + (query.time ?? 0), 0);
    const details = h('details', { class: 'sql' });
    details.append(
        h(
            'summary',
            {},
            h('span', { class: 'sql-label', text: 'SQL' }),
            ` ${total} ${total === 1 ? 'query' : 'queries'} · ${formatMs(time)}`,
            summary?.repeated.length
                ? h('span', { class: 'badge warn', text: 'possible N+1' })
                : null,
        ),
    );

    for (const repeated of summary?.repeated ?? []) {
        details.append(
            h(
                'div',
                { class: 'n-plus-one' },
                h('strong', { text: `Ran ${repeated.count} times: ` }),
                h('code', { text: repeated.sql }),
                h('div', {
                    class: 'muted',
                    text: 'Eager load the relation (with()) or batch the lookup.',
                }),
            ),
        );
    }

    for (const query of queries) {
        details.append(
            h(
                'div',
                { class: 'query' },
                h('code', { class: 'sql-text', text: query.sql }),
                h(
                    'div',
                    { class: 'query-meta' },
                    query.bindings.length
                        ? h('span', { text: `[${query.bindings.join(', ')}]` })
                        : null,
                    typeof query.time === 'number'
                        ? h('span', { text: formatMs(query.time) })
                        : null,
                    copyMenu(ctx, [{ label: 'SQL', value: () => query.sql }]),
                ),
            ),
        );
    }

    if (total > queries.length) {
        details.append(
            h('div', { class: 'muted', text: `${total - queries.length} more not listed.` }),
        );
    }

    return details;
}
