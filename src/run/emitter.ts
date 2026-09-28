/** A tiny typed event emitter, free of vscode so core logic stays testable. */
export class Emitter<T> {
    private readonly listeners = new Set<(value: T) => void>();

    readonly event = (listener: (value: T) => void): { dispose(): void } => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    };

    fire(value: T): void {
        for (const listener of [...this.listeners]) listener(value);
    }

    dispose(): void {
        this.listeners.clear();
    }
}
