import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { isSshEndpoint, type SshEndpoint } from '../ssh/types';
import { validateTarget, type Target } from '../targets/target';
import { newTargetId } from '../targets/targetStore';

export interface TargetFormOptions {
    existing?: Target;
    /** Pre-filled values for a new target (e.g. from detection). */
    draft?: Partial<Target>;
    services: string[];
    containers: string[];
    endpoints: SshEndpoint[];
    defaultWorkingDir: string;
    test(target: Target): Promise<{ ok: boolean; text: string }>;
    save(target: Target, use: boolean): Promise<void>;
    remove?(target: Target): Promise<void>;
}

let current: vscode.WebviewPanel | undefined;

/** One form for every kind of target, with an inline connection test. */
export function openTargetForm(options: TargetFormOptions): void {
    current?.dispose();
    const panel = vscode.window.createWebviewPanel(
        'opentinker.targetForm',
        options.existing ? `Edit target · ${options.existing.name}` : 'New OpenTinker target',
        vscode.ViewColumn.Active,
        // Kept alive while hidden so switching tabs to copy a host or path keeps the input.
        { enableScripts: true, retainContextWhenHidden: true },
    );
    current = panel;
    panel.onDidDispose(() => {
        if (current === panel) current = undefined;
    });

    const nonce = randomBytes(16).toString('base64');
    const initial = {
        id: options.existing?.id ?? newTargetId(),
        kind: 'compose',
        name: '',
        environment: 'local',
        workingDir: options.defaultWorkingDir,
        bootstrap: 'auto',
        port: 22,
        ...options.draft,
        ...options.existing,
    };
    const data = JSON.stringify({
        target: initial,
        isNew: !options.existing,
        services: options.services,
        containers: options.containers,
        endpoints: options.endpoints,
    }).replaceAll('<', '\\u003c');

    panel.webview.html = targetFormHtml(nonce, data);
    panel.webview.onDidReceiveMessage(
        async (message: { kind?: string; target?: unknown; use?: boolean }) => {
            const post = (reply: object): void => void panel.webview.postMessage(reply);

            if (message.kind === 'cancel') {
                panel.dispose();
                return;
            }

            if (message.kind === 'delete' && options.existing && options.remove) {
                const confirm = await vscode.window.showWarningMessage(
                    `Delete the target "${options.existing.name}"?`,
                    { modal: true },
                    'Delete',
                );
                if (confirm === 'Delete') {
                    await options.remove(options.existing);
                    panel.dispose();
                }
                return;
            }

            if (message.kind !== 'test' && message.kind !== 'save') return;

            const target = normalize(message.target);
            const problem = target ? validateTarget(target) : 'The form data is incomplete.';
            if (!target || problem) {
                post({ kind: 'status', ok: false, text: problem ?? 'Check the form.' });
                return;
            }

            if (message.kind === 'test') {
                post({ kind: 'status', pending: true, text: 'Starting the app on this target…' });
                try {
                    post({ kind: 'status', ...(await options.test(target)) });
                } catch (error) {
                    post({
                        kind: 'status',
                        ok: false,
                        text: error instanceof Error ? error.message : String(error),
                    });
                }
                return;
            }

            try {
                await options.save(target, message.use === true);
                panel.dispose();
            } catch (error) {
                post({
                    kind: 'status',
                    ok: false,
                    text: `Could not save: ${error instanceof Error ? error.message : String(error)}`,
                });
            }
        },
    );
}

function normalize(value: unknown): Target | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const raw = value as Record<string, unknown>;
    const text = (key: string): string =>
        typeof raw[key] === 'string' ? (raw[key] as string).trim() : '';
    const base = {
        id: text('id') || newTargetId(),
        name: text('name'),
        environment: (['local', 'staging', 'production', 'unknown'].includes(text('environment'))
            ? text('environment')
            : 'unknown') as Target['environment'],
        workingDir: text('workingDir'),
        phpBinary: text('phpBinary') || undefined,
        bootstrap:
            text('bootstrap') && text('bootstrap') !== 'auto' ? text('bootstrap') : undefined,
    };

    let target: Target;
    switch (text('kind')) {
        case 'local':
            target = { ...base, kind: 'local', workingDir: '' };
            break;
        case 'compose':
            target = { ...base, kind: 'compose', service: text('service') };
            break;
        case 'docker':
            target = { ...base, kind: 'docker', container: text('container') };
            break;
        case 'ssh':
            target = {
                ...base,
                kind: 'ssh',
                host: text('host'),
                user: text('user'),
                port: Number(raw.port) || 22,
                identityFile: text('identityFile') || undefined,
                ...(isSshEndpoint(raw.source) ? { source: raw.source } : {}),
            };
            break;
        default:
            return undefined;
    }

    if (!target.name) {
        target.name =
            target.kind === 'compose'
                ? target.service
                : target.kind === 'docker'
                  ? target.container
                  : target.kind === 'ssh'
                    ? target.host
                    : 'Local PHP';
    }
    return target;
}

/** Exported for tests. */
export function targetFormHtml(nonce: string, data: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 16px 24px; max-width: 680px; }
h1 { font-size: 1.3em; margin: 0 0 4px; }
p.lead { color: var(--vscode-descriptionForeground); margin: 0 0 16px; }
fieldset { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 10px 14px 12px; margin: 0 0 14px; }
legend { padding: 0 6px; color: var(--vscode-descriptionForeground); }
label { display: block; margin: 10px 0 0; font-weight: 600; }
small { display: block; font-weight: normal; color: var(--vscode-descriptionForeground); margin-top: 2px; }
input, select { box-sizing: border-box; display: block; width: 100%; margin-top: 4px; padding: 5px 7px; font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 3px; }
.kinds { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 6px; }
.kind { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 8px; cursor: pointer; background: transparent; color: inherit; font: inherit; text-align: left; }
.kind[aria-pressed="true"] { border-color: var(--vscode-focusBorder); background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.kind strong { display: block; }
.kind span { font-size: .85em; opacity: .8; }
.row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 16px; }
button.btn { font: inherit; padding: 6px 14px; border-radius: 3px; border: 1px solid var(--vscode-button-border, var(--vscode-panel-border)); cursor: pointer; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border-color: var(--vscode-button-border, transparent); }
button.danger { margin-left: auto; color: var(--vscode-errorForeground); background: transparent; border-color: var(--vscode-errorForeground); }
#status { margin-top: 14px; padding: 8px 10px; border-radius: 4px; white-space: pre-wrap; font-family: var(--vscode-editor-font-family); font-size: .92em; }
#status.ok { border-left: 3px solid var(--vscode-testing-iconPassed); background: var(--vscode-editorWidget-background); }
#status.fail { border-left: 3px solid var(--vscode-errorForeground); background: var(--vscode-inputValidation-errorBackground); }
#status.pending { border-left: 3px solid var(--vscode-progressBar-background); background: var(--vscode-editorWidget-background); }
[hidden] { display: none !important; }
</style>
</head>
<body>
<h1 id="heading"></h1>
<p class="lead">Where OpenTinker boots your app and runs code.</p>
<form id="form" novalidate>
<fieldset>
<legend>Runtime</legend>
<div class="kinds" role="group" aria-label="Runtime type">
<button type="button" class="kind" data-kind="compose"><strong>Docker Compose</strong><span>docker compose exec</span></button>
<button type="button" class="kind" data-kind="docker"><strong>Docker container</strong><span>docker exec</span></button>
<button type="button" class="kind" data-kind="local"><strong>Local PHP</strong><span>Herd, Valet, Homebrew</span></button>
<button type="button" class="kind" data-kind="ssh"><strong>SSH</strong><span>a remote server</span></button>
</div>
<div data-for="compose"><label>Service<select name="service"></select><small>The Compose service that runs your app.</small></label></div>
<div data-for="docker"><label>Container<input name="container" list="containers" placeholder="my-app-1"><datalist id="containers"></datalist></label></div>
<div data-for="ssh">
<label data-if-endpoints>Import from OpenVSDB<select name="endpoint"><option value="">Enter details by hand</option></select><small>Fills in the SSH details. OpenTinker re-checks the connection before each run.</small></label>
<div class="row"><label>Host<input name="host" placeholder="app.example.com"></label><label>User<input name="user" placeholder="forge"></label></div>
<div class="row"><label>Port<input name="port" type="number" min="1" max="65535"></label><label>Private key<input name="identityFile" placeholder="~/.ssh/id_ed25519"><small>Leave empty to use your SSH agent or ~/.ssh/config.</small></label></div>
</div>
<div data-not="local"><label>Project path<input name="workingDir" placeholder="/var/www"><small>Where the project lives inside the container or on the server.</small></label></div>
</fieldset>
<fieldset>
<legend>Details</legend>
<div class="row">
<label>Name<input name="name" placeholder="My app"></label>
<label>Environment<select name="environment"><option value="local">Local</option><option value="staging">Staging</option><option value="production">Production</option><option value="unknown">Not sure</option></select><small>Your app’s APP_ENV is used once connected.</small></label>
</div>
<div class="row">
<label>PHP binary<input name="phpBinary" placeholder="php"></label>
<label>Bootstrap<input name="bootstrap" placeholder="auto" list="bootstraps"><datalist id="bootstraps"><option value="auto"><option value="laravel"><option value="composer"></datalist><small>auto, laravel, composer, or a bootstrap file for other frameworks.</small></label>
</div>
</fieldset>
<div class="actions">
<button type="button" class="btn" id="test">Test connection</button>
<button type="submit" class="btn primary" id="saveUse">Save and use</button>
<button type="button" class="btn" id="save">Save</button>
<button type="button" class="btn" id="cancel">Cancel</button>
<button type="button" class="btn danger" id="delete" hidden>Delete</button>
</div>
<div id="status" role="status" aria-live="polite" hidden></div>
</form>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const data = ${data};
const form = document.getElementById('form');
const status = document.getElementById('status');
let target = data.target;
let source = target.source;
const option = (text, value) => { const item = document.createElement('option'); item.textContent = text; item.value = value === undefined ? text : value; return item; };

document.getElementById('heading').textContent = data.isNew ? 'New target' : 'Edit ' + target.name;
document.getElementById('delete').hidden = data.isNew;
document.getElementById('saveUse').textContent = data.isNew ? 'Save and use' : 'Save';
document.getElementById('save').hidden = !data.isNew;

const service = form.elements.namedItem('service');
const services = [...new Set([...(data.services || []), ...(target.service ? [target.service] : [])])];
for (const name of services) service.append(option(name, name));
if (!services.length) service.append(option('No services found. Is Docker running?', ''));
for (const name of data.containers || []) document.getElementById('containers').append(option(name));
const endpoint = form.elements.namedItem('endpoint');
for (const item of data.endpoints || []) endpoint.append(option(item.name + ' · ' + item.user + '@' + item.host, item.id));
document.querySelector('[data-if-endpoints]').hidden = !(data.endpoints || []).length;

for (const name of ['name','environment','workingDir','phpBinary','bootstrap','service','container','host','user','port','identityFile']) {
    const field = form.elements.namedItem(name);
    if (field && target[name] !== undefined && target[name] !== null) field.value = target[name];
}
if (source) endpoint.value = source.id;

function setKind(kind) {
    target.kind = kind;
    for (const button of document.querySelectorAll('.kind')) button.setAttribute('aria-pressed', String(button.dataset.kind === kind));
    for (const section of document.querySelectorAll('[data-for]')) section.hidden = section.dataset.for !== kind;
    for (const section of document.querySelectorAll('[data-not]')) section.hidden = section.dataset.not === kind;
}
for (const button of document.querySelectorAll('.kind')) button.addEventListener('click', () => setKind(button.dataset.kind));
setKind(target.kind || 'compose');

endpoint.addEventListener('change', () => {
    const item = (data.endpoints || []).find((entry) => entry.id === endpoint.value);
    source = item;
    if (!item) return;
    form.elements.namedItem('host').value = item.host;
    form.elements.namedItem('user').value = item.user;
    form.elements.namedItem('port').value = item.port;
    form.elements.namedItem('identityFile').value = item.authMethod === 'key' ? (item.keyPath || '') : '';
    if (!form.elements.namedItem('name').value) form.elements.namedItem('name').value = item.name;
    if (item.environment) form.elements.namedItem('environment').value = item.environment === 'prod' ? 'production' : item.environment;
});

function collect() {
    const value = { id: target.id, kind: target.kind };
    for (const name of ['name','environment','workingDir','phpBinary','bootstrap','service','container','host','user','port','identityFile']) {
        const field = form.elements.namedItem(name);
        if (field) value[name] = field.value;
    }
    if (target.kind === 'ssh' && source) value.source = source;
    return value;
}

document.getElementById('test').addEventListener('click', () => vscode.postMessage({ kind: 'test', target: collect() }));
document.getElementById('save').addEventListener('click', () => vscode.postMessage({ kind: 'save', target: collect(), use: false }));
// Only a new target becomes the active one; saving an edit must never switch where code runs.
form.addEventListener('submit', (event) => { event.preventDefault(); vscode.postMessage({ kind: 'save', target: collect(), use: data.isNew }); });
document.getElementById('cancel').addEventListener('click', () => vscode.postMessage({ kind: 'cancel' }));
document.getElementById('delete').addEventListener('click', () => vscode.postMessage({ kind: 'delete' }));

window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.kind !== 'status') return;
    status.hidden = false;
    status.className = message.pending ? 'pending' : message.ok ? 'ok' : 'fail';
    status.textContent = message.text;
    document.getElementById('test').disabled = !!message.pending;
});
</script>
</body>
</html>`;
}
