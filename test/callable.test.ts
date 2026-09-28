import { describe, expect, it } from 'vitest';
import { callableCode, requiredParameterCount } from '../src/run/callable';

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

describe('requiredParameterCount', () => {
    it('counts parameters without defaults', () => {
        expect(requiredParameterCount('() {')).toBe(0);
        expect(requiredParameterCount('(): Collection\n    {')).toBe(0);
        expect(requiredParameterCount('(Request $request, int $id) {')).toBe(2);
        expect(requiredParameterCount('(int $limit = 10, string ...$tags) {')).toBe(0);
        expect(requiredParameterCount('(User $user, bool $force = false) {')).toBe(1);
    });

    it('ignores commas and brackets inside defaults, strings and attributes', () => {
        expect(requiredParameterCount("(array $keys = ['a', 'b'], string $glue = ', ') {")).toBe(0);
        expect(requiredParameterCount('(#[SensitiveParameter] string $password) {')).toBe(1);
        expect(requiredParameterCount("(string $x = ')', $y = new Foo(1, 2)) {")).toBe(0);
        expect(
            requiredParameterCount('(\n        int $a,\n        ?string $b = null,\n    ) {'),
        ).toBe(1);
    });

    it('gives up on text it cannot read', () => {
        expect(requiredParameterCount('name() {')).toBeUndefined();
        expect(requiredParameterCount('(int $a')).toBeUndefined();
    });
});
