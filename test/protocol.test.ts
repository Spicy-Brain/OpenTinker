import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    LineDecoder,
    PROTOCOL_VERSION,
    encodeRequest,
    isRunFrame,
    isWorkerFrame,
    stripAnsi,
} from '../src/shared/protocol';

describe('protocol version', () => {
    it('matches the PHP worker', () => {
        const php = readFileSync('worker/src/Protocol.php', 'utf8');
        expect(php).toMatch(new RegExp(`public const VERSION = ${PROTOCOL_VERSION};`));
    });
});

describe('LineDecoder', () => {
    it('decodes complete lines', () => {
        expect(new LineDecoder().push('{"a":1}\n{"b":2}\n')).toEqual(['{"a":1}', '{"b":2}']);
    });

    it('buffers partial lines across chunks', () => {
        const decoder = new LineDecoder();
        expect(decoder.push('{"hel')).toEqual([]);
        expect(decoder.push('lo":1}\n')).toEqual(['{"hello":1}']);
    });

    it('tolerates CRLF line endings', () => {
        expect(new LineDecoder().push('{"a":1}\r\n')).toEqual(['{"a":1}']);
    });

    it('resets buffered data', () => {
        const decoder = new LineDecoder();
        decoder.push('{"partial"');
        decoder.reset();
        expect(decoder.push('{"a":1}\n')).toEqual(['{"a":1}']);
    });
});

describe('requests and frames', () => {
    it('writes newline terminated json', () => {
        expect(
            encodeRequest({
                id: 'r1',
                type: 'exec',
                code: '1;',
                mode: 'statements',
                fresh: true,
                rollback: false,
            }),
        ).toBe(
            '{"id":"r1","type":"exec","code":"1;","mode":"statements","fresh":true,"rollback":false}\n',
        );
    });

    it('recognises frames and run frames', () => {
        expect(isWorkerFrame({ type: 'ready' })).toBe(true);
        expect(isWorkerFrame({})).toBe(false);
        expect(isWorkerFrame(null)).toBe(false);
        expect(isRunFrame({ type: 'value', id: 'r', html: '' })).toBe(true);
        expect(
            isRunFrame({
                type: 'pong',
                id: 'p',
                php: '',
                laravel: null,
                env: '',
                basePath: '',
                pid: 1,
            }),
        ).toBe(false);
    });

    it('strips ANSI colours from stray output', () => {
        expect(stripAnsi('\u001b[31mboom\u001b[0m')).toBe('boom');
    });
});
