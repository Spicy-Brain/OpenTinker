type Child = Node | string | number | null | undefined | false;

export interface Props {
    class?: string;
    text?: string;
    title?: string;
    attrs?: Record<string, string>;
    on?: Partial<Record<keyof HTMLElementEventMap, (event: Event) => void>>;
}

/** Creates an element. Text is always set as text, never parsed as HTML. */
export function h<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    props: Props = {},
    ...children: Child[]
): HTMLElementTagNameMap[K] {
    const element = document.createElement(tag);
    if (props.class) element.className = props.class;
    if (props.text !== undefined) element.textContent = props.text;
    if (props.title) element.title = props.title;
    for (const [name, value] of Object.entries(props.attrs ?? {}))
        element.setAttribute(name, value);
    for (const [event, handler] of Object.entries(props.on ?? {})) {
        if (handler) element.addEventListener(event, handler);
    }
    for (const child of children) {
        if (child === null || child === undefined || child === false) continue;
        element.append(child instanceof Node ? child : String(child));
    }
    return element;
}

export function button(
    label: string,
    onClick: (event: Event) => void,
    options: { class?: string; title?: string } = {},
): HTMLButtonElement {
    return h('button', {
        class: options.class ?? 'link-button',
        text: label,
        title: options.title,
        attrs: { type: 'button' },
        on: {
            click: (event) => {
                event.preventDefault();
                event.stopPropagation();
                onClick(event);
            },
        },
    });
}

export function shortClass(name: string): string {
    return name.split('\\').at(-1) ?? name;
}
