import type { ResultFrame, RunFrame, ScopeFrame } from './protocol';

export type StatementChange = 'same' | 'changed' | 'new';

/** What the results panel needs to know about a run. */
export interface RunView {
    id: string;
    label: string;
    code: string;
    imports: string[];
    sourceLine: number;
    /** Whether the run came from a document the panel can jump into. */
    hasSource: boolean;
    /** Whether the run came from a scratch file (Run then re-reads that file). */
    scratch: boolean;
    target: string;
    targetName: string;
    environment: string;
    sessionMode: 'fresh' | 'keep';
    rollback: boolean;
    at: number;
}

/** Header state: where code runs and how. */
export interface PanelContext {
    targetName: string;
    targetDetail: string;
    environment: string;
    sessionMode: 'fresh' | 'keep';
    rollback: boolean;
    state: 'idle' | 'starting' | 'running' | 'stopping';
    /** False when the runtime cannot fork, so fresh runs restart the worker. */
    fork: boolean;
    hasTarget: boolean;
    /** The scratch file the panel's Run button runs; empty when there is none yet. */
    scratchName: string;
}

export type HostMessage =
    | { kind: 'begin'; run: RunView }
    | { kind: 'frame'; frame: RunFrame }
    | { kind: 'finish'; result: ResultFrame; changes: Record<number, StatementChange> }
    | {
          kind: 'render';
          run: RunView;
          frames: RunFrame[];
          changes: Record<number, StatementChange>;
      }
    | { kind: 'scope'; scope: ScopeFrame | null; note?: string }
    | { kind: 'context'; context: PanelContext }
    | { kind: 'clear' };

export type PanelAction =
    | 'rerun'
    | 'run'
    | 'stop'
    | 'restartSession'
    | 'clear'
    | 'toggleMode'
    | 'toggleRollback'
    | 'chooseTarget'
    | 'refreshScope'
    | 'newScratch';

export type PanelMessage =
    | { kind: 'ready' }
    | { kind: 'action'; action: PanelAction }
    | { kind: 'openLine'; line: number }
    | { kind: 'openFile'; file: string; line: number | null }
    | { kind: 'copy'; text: string }
    | { kind: 'save'; filename: string; content: string };

const ACTIONS: PanelAction[] = [
    'rerun',
    'run',
    'stop',
    'restartSession',
    'clear',
    'toggleMode',
    'toggleRollback',
    'chooseTarget',
    'refreshScope',
    'newScratch',
];

/** Validates messages from the webview; everything it sends is untrusted. */
export function isPanelMessage(value: unknown): value is PanelMessage {
    if (!value || typeof value !== 'object') return false;
    const message = value as Record<string, unknown>;
    switch (message.kind) {
        case 'ready':
            return true;
        case 'action':
            return ACTIONS.includes(message.action as PanelAction);
        case 'openLine':
            return Number.isInteger(message.line) && (message.line as number) > 0;
        case 'openFile':
            return (
                typeof message.file === 'string' &&
                message.file.length < 4096 &&
                (message.line === null || Number.isInteger(message.line))
            );
        case 'copy':
            return typeof message.text === 'string' && message.text.length < 10_000_000;
        case 'save':
            return (
                typeof message.filename === 'string' &&
                /^[\w.-]{1,100}$/.test(message.filename) &&
                typeof message.content === 'string' &&
                message.content.length < 20_000_000
            );
        default:
            return false;
    }
}
