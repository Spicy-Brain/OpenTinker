import { describe, expect, it } from 'vitest';
import { LineDecoder, encodeRequest, isWorkerFrame } from '../src/session/protocol';

describe('LineDecoder', () => {
    it('decodes complete lines', () => {
        const decoder = new LineDecoder();

        expect(decoder.push('{"a":1}\n{"b":2}\n')).toEqual(['{"a":1}', '{"b":2}']);
    });

    it('buffers partial lines across chunks', () => {
        const decoder = new LineDecoder();

        expect(decoder.push('{"hel')).toEqual([]);
        expect(decoder.push('lo":1}\n')).toEqual(['{"hello":1}']);
    });

    it('tolerates CRLF line endings', () => {
        const decoder = new LineDecoder();

        expect(decoder.push('{"a":1}\r\n')).toEqual(['{"a":1}']);
    });

    it('resets buffered data', () => {
        const decoder = new LineDecoder();
        decoder.push('{"partial"');
        decoder.reset();

        expect(decoder.push('{"a":1}\n')).toEqual(['{"a":1}']);
    });
});

describe('encodeRequest', () => {
    it('writes newline terminated json', () => {
        expect(encodeRequest({ id: 'r1', type: 'exec', code: '1 + 1;', mode: 'statements' })).toBe(
            '{"id":"r1","type":"exec","code":"1 + 1;","mode":"statements"}\n',
        );
    });
});

describe('isWorkerFrame', () => {
    it('accepts frames with a string type', () => {
        expect(isWorkerFrame({ type: 'ready' })).toBe(true);
    });

    it('rejects everything else', () => {
        expect(isWorkerFrame(undefined)).toBe(false);
        expect(isWorkerFrame(null)).toBe(false);
        expect(isWorkerFrame('ready')).toBe(false);
        expect(isWorkerFrame({})).toBe(false);
        expect(isWorkerFrame({ type: 1 })).toBe(false);
    });
});
