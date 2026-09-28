// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

async function load(data: object): Promise<Array<Record<string, unknown>>> {
    const { targetFormHtml } = await import('../../src/ui/targetForm');
    const html = targetFormHtml('n', JSON.stringify(data));
    const posted: Array<Record<string, unknown>> = [];
    document.documentElement.innerHTML = html.replace(/^<!DOCTYPE html>/, '');
    const script = document.querySelector('script')?.textContent ?? '';
    (window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
        postMessage: (message: Record<string, unknown>) => posted.push(message),
    });
    new Function(script)();
    return posted;
}

const base = {
    isNew: true,
    services: ['app', 'queue'],
    containers: ['eventwise-app-app-1'],
    endpoints: [
        {
            id: 'db',
            name: 'Prod DB',
            host: 'bastion',
            port: 22,
            user: 'forge',
            authMethod: 'key',
            keyPath: '~/.ssh/id',
            environment: 'prod',
        },
    ],
};

describe('target form', () => {
    it('collects a Compose target and saves it for use', async () => {
        const posted = await load({
            ...base,
            target: {
                id: 't1',
                kind: 'compose',
                name: '',
                environment: 'local',
                workingDir: '/var/www',
                port: 22,
            },
        });
        const form = document.getElementById('form') as HTMLFormElement;
        (form.elements.namedItem('service') as HTMLSelectElement).value = 'app';
        (form.elements.namedItem('name') as HTMLInputElement).value = 'Eventwise';
        form.dispatchEvent(new Event('submit', { cancelable: true }));
        expect(posted.at(-1)).toMatchObject({
            kind: 'save',
            use: true,
            target: { kind: 'compose', service: 'app', name: 'Eventwise', workingDir: '/var/www' },
        });
    });

    it('switches to SSH and imports details from OpenVSDB', async () => {
        const posted = await load({
            ...base,
            target: {
                id: 't2',
                kind: 'compose',
                name: '',
                environment: 'local',
                workingDir: '/var/www',
                port: 22,
            },
        });
        (document.querySelector('[data-kind="ssh"]') as HTMLButtonElement).click();
        expect((document.querySelector('[data-for="ssh"]') as HTMLElement).hidden).toBe(false);
        expect((document.querySelector('[data-for="compose"]') as HTMLElement).hidden).toBe(true);
        const endpoint = document.querySelector('select[name="endpoint"]') as HTMLSelectElement;
        endpoint.value = 'db';
        endpoint.dispatchEvent(new Event('change'));
        (document.getElementById('test') as HTMLButtonElement).click();
        expect(posted.at(-1)).toMatchObject({
            kind: 'test',
            target: {
                kind: 'ssh',
                host: 'bastion',
                user: 'forge',
                identityFile: '~/.ssh/id',
                environment: 'production',
                name: 'Prod DB',
                source: { id: 'db' },
            },
        });
    });

    it('shows test results', async () => {
        await load({
            ...base,
            target: {
                id: 't3',
                kind: 'local',
                name: 'Local',
                environment: 'local',
                workingDir: '',
                port: 22,
            },
        });
        window.dispatchEvent(
            new MessageEvent('message', {
                data: { kind: 'status', ok: true, text: '✓ Connected' },
            }),
        );
        const status = document.getElementById('status') as HTMLElement;
        expect(status.hidden).toBe(false);
        expect(status.className).toBe('ok');
        expect((document.querySelector('[data-not="local"]') as HTMLElement).hidden).toBe(true);
    });
});
