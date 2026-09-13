export interface RunTargetInput {
    hasSelection: boolean;
    selectionText: string;
    lineText: string;
    lineNumber: number;
    fileText: string;
    isScratch: boolean;
    fileName: string;
}

export interface RunTarget {
    mode: 'selection' | 'line' | 'file';
    code: string;
    label: string;
}

/**
 * Decides what to execute for a run command:
 * - a non-empty selection always wins;
 * - scratch files run as a whole;
 * - anything else runs the current line.
 */
export function resolveRunTarget(input: RunTargetInput): RunTarget | undefined {
    if (input.hasSelection && input.selectionText.trim() !== '') {
        return {
            mode: 'selection',
            code: input.selectionText,
            label: `${input.fileName} · selection`,
        };
    }

    if (input.isScratch) {
        if (input.fileText.trim() === '') {
            return undefined;
        }

        return { mode: 'file', code: input.fileText, label: input.fileName };
    }

    if (input.lineText.trim() === '') {
        return undefined;
    }

    return {
        mode: 'line',
        code: input.lineText,
        label: `${input.fileName}:${input.lineNumber}`,
    };
}
