import { describe, expect, it } from 'vitest';
import { resolveRunTarget } from '../src/run/target';

const base = {
    hasSelection: false,
    selectionText: '',
    lineText: 'dump($user);',
    lineNumber: 12,
    fileText: '<?php\n\ndump($user);\n',
    isScratch: false,
    fileName: 'UserController.php',
};

describe('resolveRunTarget', () => {
    it('prefers a non-empty selection', () => {
        const target = resolveRunTarget({
            ...base,
            hasSelection: true,
            selectionText: 'User::first()',
        });

        expect(target?.mode).toBe('selection');
        expect(target?.code).toBe('User::first()');
    });

    it('runs the whole file for scratch files', () => {
        const target = resolveRunTarget({ ...base, isScratch: true, fileName: 'scratch-1.php' });

        expect(target?.mode).toBe('file');
        expect(target?.code).toBe(base.fileText);
    });

    it('ignores a whitespace-only selection in a scratch file', () => {
        const target = resolveRunTarget({
            ...base,
            hasSelection: true,
            selectionText: '   \n',
            isScratch: true,
        });

        expect(target?.mode).toBe('file');
    });

    it('runs the current line for regular files', () => {
        const target = resolveRunTarget(base);

        expect(target?.mode).toBe('line');
        expect(target?.code).toBe('dump($user);');
        expect(target?.label).toBe('UserController.php:12');
    });

    it('returns undefined for empty input', () => {
        expect(resolveRunTarget({ ...base, lineText: '   ' })).toBeUndefined();
        expect(resolveRunTarget({ ...base, isScratch: true, fileText: '\n' })).toBeUndefined();
    });
});
