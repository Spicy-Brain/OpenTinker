import { createHash } from 'node:crypto';
import type { StatementChange } from '../shared/panelMessages';
import type { RunFrame } from '../shared/protocol';

export type { StatementChange };

/**
 * A fingerprint of what each statement produced, keyed by the statement's
 * source text so edits elsewhere in the file don't break the match.
 */
export function statementSignatures(frames: RunFrame[], code: string): Record<string, string> {
    const lines = code.split('\n');
    const outputs = new Map<number, string[]>();
    const starts = new Map<number, number>();

    for (const frame of frames) {
        if (!('stmt' in frame) || typeof frame.stmt !== 'number' || frame.stmt <= 0) continue;
        const parts = outputs.get(frame.stmt) ?? [];
        if (frame.type === 'value' || frame.type === 'dump') parts.push(frame.short ?? frame.html);
        else if (frame.type === 'output') parts.push(frame.text);
        else if (frame.type === 'error') parts.push(`${frame.errorClass}: ${frame.message}`);
        else if (frame.type === 'inline') parts.push(frame.text);
        else if (frame.type === 'statement') {
            starts.set(frame.stmt, frame.line);
            parts.push(frame.ok ? 'ok' : 'failed');
            if (frame.exit) parts.push(`exit ${frame.exit}`);
        }
        outputs.set(frame.stmt, parts);
    }

    const signatures: Record<string, string> = {};
    const seen = new Map<string, number>();

    for (const [stmt, parts] of [...outputs.entries()].sort((a, b) => a[0] - b[0])) {
        const line = starts.get(stmt) ?? 1;
        const text = (lines[line - 1] ?? '').trim();
        const occurrence = (seen.get(text) ?? 0) + 1;
        seen.set(text, occurrence);
        signatures[`${text}#${occurrence}`] = createHash('sha1')
            .update(parts.join('\u0000'))
            .digest('hex')
            .slice(0, 16);
    }

    return signatures;
}

/** Per-statement change markers, keyed by statement index. */
export function compareRuns(
    frames: RunFrame[],
    code: string,
    previous: Record<string, string> | undefined,
): { signatures: Record<string, string>; changes: Record<number, StatementChange> } {
    const signatures = statementSignatures(frames, code);
    const changes: Record<number, StatementChange> = {};
    if (!previous) return { signatures, changes };

    const keys = Object.keys(signatures);
    const lines = code.split('\n');
    const seen = new Map<string, number>();
    const statementLines = frames
        .filter(
            (frame): frame is Extract<RunFrame, { type: 'statement' }> =>
                frame.type === 'statement',
        )
        .sort((a, b) => a.stmt - b.stmt);

    for (const frame of statementLines) {
        const text = (lines[frame.line - 1] ?? '').trim();
        const occurrence = (seen.get(text) ?? 0) + 1;
        seen.set(text, occurrence);
        const key = `${text}#${occurrence}`;
        if (!keys.includes(key)) continue;
        changes[frame.stmt] =
            previous[key] === undefined
                ? 'new'
                : previous[key] === signatures[key]
                  ? 'same'
                  : 'changed';
    }

    return { signatures, changes };
}
