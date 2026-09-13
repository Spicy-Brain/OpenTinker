import { describe, expect, it } from 'vitest';
import { connectionLabel, isConnection } from '../src/session/connection';

describe('connectionLabel', () => {
    it('labels compose connections', () => {
        expect(connectionLabel({ kind: 'compose', service: 'app' })).toBe(
            'docker compose exec app',
        );
    });

    it('labels docker connections', () => {
        expect(connectionLabel({ kind: 'docker', container: 'spicybrain-app-1' })).toBe(
            'docker exec spicybrain-app-1',
        );
    });

    it('labels local connections', () => {
        expect(connectionLabel({ kind: 'local' })).toBe('local PHP');
    });
});

describe('isConnection', () => {
    it('accepts valid connections', () => {
        expect(isConnection({ kind: 'compose', service: 'app' })).toBe(true);
        expect(isConnection({ kind: 'docker', container: 'app-1' })).toBe(true);
        expect(isConnection({ kind: 'local' })).toBe(true);
    });

    it('rejects malformed values', () => {
        expect(isConnection(undefined)).toBe(false);
        expect(isConnection(null)).toBe(false);
        expect(isConnection('compose')).toBe(false);
        expect(isConnection({ kind: 'compose' })).toBe(false);
        expect(isConnection({ kind: 'compose', service: '' })).toBe(false);
        expect(isConnection({ kind: 'docker', container: '' })).toBe(false);
        expect(isConnection({ kind: 'ssh' })).toBe(false);
    });
});
