import { describe, expect, it } from 'vitest';
import { obviousChoice, projectRoot, type DetectedTarget } from '../src/targets/detect';
import {
    isTarget,
    normalizeEnvironment,
    targetSummary,
    toLocalPath,
    validateTarget,
    type Target,
} from '../src/targets/target';
import { migrateLegacy } from '../src/targets/targetStore';

const compose: Target = {
    id: 'a',
    kind: 'compose',
    name: 'app',
    service: 'app',
    workingDir: '/var/www',
    environment: 'local',
};

describe('targets', () => {
    it('validates saved targets', () => {
        expect(isTarget(compose)).toBe(true);
        expect(isTarget({ ...compose, service: '' })).toBe(false);
        expect(
            isTarget({
                id: 'l',
                kind: 'local',
                name: 'Local',
                workingDir: '',
                environment: 'local',
            }),
        ).toBe(true);
        expect(
            isTarget({
                id: 's',
                kind: 'ssh',
                name: 'Prod',
                host: 'app',
                user: 'forge',
                port: 22,
                workingDir: '/srv',
                environment: 'production',
            }),
        ).toBe(true);
        expect(
            isTarget({
                id: 's',
                kind: 'ssh',
                name: 'Prod',
                host: 'app',
                user: 'forge',
                port: 0,
                workingDir: '/srv',
                environment: 'production',
            }),
        ).toBe(false);
        expect(isTarget(null)).toBe(false);
    });

    it('explains invalid forms', () => {
        expect(validateTarget({ ...compose, workingDir: 'var/www' })).toMatch(/absolute/);
        expect(validateTarget({ ...compose, name: ' ' })).toMatch(/name/);
        expect(validateTarget(compose)).toBeUndefined();
    });

    it('summarises where code runs', () => {
        expect(targetSummary(compose)).toBe('compose · app');
        expect(
            targetSummary({
                id: 's',
                kind: 'ssh',
                name: 'P',
                host: 'h',
                user: 'u',
                port: 2222,
                workingDir: '/',
                environment: 'local',
            }),
        ).toBe('ssh · u@h:2222');
    });

    it('normalises environment names', () => {
        expect(normalizeEnvironment('prod')).toBe('production');
        expect(normalizeEnvironment('Production')).toBe('production');
        expect(normalizeEnvironment('dev')).toBe('local');
        expect(normalizeEnvironment('qa')).toBe('unknown');
    });

    it('maps runtime paths back to the workspace', () => {
        expect(toLocalPath(compose, '/var/www/app/Models/User.php', '/Users/me/app')).toBe(
            '/Users/me/app/app/Models/User.php',
        );
        expect(toLocalPath(compose, '/usr/lib/php/x.php', '/Users/me/app')).toBeUndefined();
    });

    it('migrates the old single connection setting', () => {
        const migrated = migrateLegacy(
            { kind: 'compose', service: 'php' },
            { workingDir: '/app', phpBinary: 'php' },
        );
        expect(migrated).toMatchObject({ kind: 'compose', service: 'php', workingDir: '/app' });
        expect(
            migrateLegacy({ kind: 'nope' }, { workingDir: '/', phpBinary: 'php' }),
        ).toBeUndefined();
    });
});

describe('detection', () => {
    const workspace = '/Users/me/eventwise-app';

    it('infers the project root from root and sub-folder mounts', () => {
        expect(
            projectRoot({ type: 'bind', source: workspace, target: '/var/www/html' }, workspace),
        ).toBe('/var/www/html');
        expect(
            projectRoot(
                { type: 'bind', source: `${workspace}/app`, target: '/var/www/app' },
                workspace,
            ),
        ).toBe('/var/www');
        expect(
            projectRoot({ type: 'bind', source: '/elsewhere', target: '/data' }, workspace),
        ).toBeUndefined();
        expect(
            projectRoot({ type: 'volume', source: 'db', target: '/var/lib/mysql' }, workspace),
        ).toBeUndefined();
        expect(
            projectRoot(
                { type: 'bind', source: `${workspace}/app`, target: '/srv/code' },
                workspace,
            ),
        ).toBeUndefined();
        expect(
            projectRoot(
                {
                    type: 'bind',
                    source: `${workspace}/paperless/export`,
                    target: '/usr/src/paperless/export',
                },
                workspace,
            ),
        ).toBeUndefined();
    });

    const candidate = (name: string, running: boolean, score: number): DetectedTarget => ({
        target: { ...compose, id: name, name, service: name },
        running,
        score,
        reason: '',
    });

    it('picks the running app service without asking', () => {
        const found = [
            candidate('app', true, 34),
            candidate('queue', true, 14),
            candidate('testapp', false, -6),
        ];
        expect(obviousChoice(found)?.target.name).toBe('app');
    });

    it('asks when two app-like services are running', () => {
        expect(
            obviousChoice([candidate('app', true, 34), candidate('web', true, 34)]),
        ).toBeUndefined();
    });

    it('uses the only candidate', () => {
        expect(obviousChoice([candidate('php', false, 2)])?.target.name).toBe('php');
        expect(obviousChoice([])).toBeUndefined();
    });
});
