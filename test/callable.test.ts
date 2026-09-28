import { describe, expect, it } from 'vitest';
import { callableCode } from '../src/run/callable';

describe('callableCode', () => {
    it('uses reflection and the Laravel container for class methods', () => {
        const code = callableCode({
            kind: 'method',
            name: 'report',
            className: 'App\\Services\\Report',
            label: 'report',
            key: 'file:///report.php',
            line: 1,
        });
        expect(code).toContain('new \\ReflectionMethod(\\App\\Services\\Report::class');
        expect(code).toContain('app(\\App\\Services\\Report::class)');
        expect(code).toContain('getNumberOfRequiredParameters()');
    });

    it('rejects names that could inject PHP', () => {
        expect(() =>
            callableCode({
                kind: 'function',
                name: "foo'); exit(); //",
                label: 'x',
                key: '',
                line: 1,
            }),
        ).toThrow('Invalid callable name');
    });
});
