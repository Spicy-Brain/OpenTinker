import type { PanelMessage, RunView } from '../../shared/panelMessages';
import type {
    DumpFrame,
    ErrorFrame,
    FatalFrame,
    HtmlPreview,
    ModelCard,
    QueryRecord,
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
    for (const option of options) {
        menu.append(
            button(
                option.label,
                () => {
                    menu.hidden = true;
                    if (option.save)
                        ctx.post({ kind: 'save', filename: option.save, content: option.value() });
                    else ctx.post({ kind: 'copy', text: option.value() });
                },
                { class: 'menu-item' },
            ),
        );
    }
    const trigger = button(
        options.length > 1 ? 'Copy ▾' : `Copy ${options[0]?.label.toLowerCase() ?? ''}`.trim(),
        () => {
            if (options.length === 1) {
                const [only] = options;
                if (only) ctx.post({ kind: 'copy', text: only.value() });
                return;
            }
            menu.hidden = !menu.hidden;
        },
        { title: 'Copy this value' },
    );
    wrap.append(trigger, menu);
    trackMenu(wrap, menu);
    return wrap;
}

/** A dumped or returned value, with switchable views and copy formats. */
export function valueView(ctx: Ctx, frame: DumpFrame | ValueFrame): HTMLElement {
    const section = h('div', { class: `value-item ${frame.type}` });
    const views: Array<{ name: string; build: () => HTMLElement }> = [];

    if (frame.model)
        views.push({ name: 'Model', build: () => modelView(frame.model as ModelCard) });
    views.push({ name: 'Dump', build: () => dumpView(frame.html) });
    if (frame.table?.columns.length && frame.table.rows.length)
        views.push({ name: 'Table', build: () => tableView(frame.table as TableValue) });
    if (frame.preview?.html)
        views.push({
            name: previewLabel(frame.preview),
            build: () => previewView(frame.preview as HtmlPreview),
        });

    const body = h('div', { class: 'value-body' });
    const built = new Map<string, HTMLElement>();
    const tabs = h('div', { class: 'view-tabs', attrs: { role: 'tablist' } });
    const show = (name: string): void => {
        for (const tab of tabs.children)
            tab.setAttribute('aria-selected', String(tab.textContent === name));
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
                    attrs: { type: 'button', role: 'tab', 'aria-selected': 'false' },
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

export function previewView(preview: HtmlPreview): HTMLElement {
    const frame = h('iframe', {
        class: 'preview',
        attrs: { sandbox: '', title: previewLabel(preview) + ' preview' },
    });
    const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: https:; font-src data:">`;
    frame.srcdoc = policy + preview.html;
    return frame;
}

export function errorView(ctx: Ctx, frame: ErrorFrame | FatalFrame): HTMLElement {
    const box = h('div', { class: 'error-box', attrs: { role: 'alert' } });

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

    if (!frames.length && frame.trace) {
        box.append(
            h(
                'details',
                {},
                h('summary', { text: 'Stack trace' }),
                h('pre', { class: 'output', text: frame.trace }),
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
