export type CallableTarget = {
    kind: 'function' | 'method';
    name: string;
    className?: string;
    label: string;
    key: string;
    line: number;
};

/**
 * Counts the required parameters in a declaration's parameter list, given the
 * source that follows the function name. Undefined when it cannot be parsed.
 */
export function requiredParameterCount(afterName: string): number | undefined {
    const open = afterName.indexOf('(');
    if (open < 0 || afterName.slice(0, open).trim() !== '') return undefined;
    const parameters: string[] = [];
    let current = '';
    let depth = 0;
    let quote = '';
    for (let index = open + 1; index < afterName.length; index++) {
        const char = afterName[index];
        if (quote) {
            current += char;
            if (char === '\\') current += afterName[++index] ?? '';
            else if (char === quote) quote = '';
            continue;
        }
        if (char === '"' || char === "'") quote = char;
        else if (char === '(' || char === '[' || char === '{') depth++;
        else if (char === ')' || char === ']' || char === '}') {
            if (depth === 0) {
                if (current.trim()) parameters.push(current);
                return parameters.filter(isRequired).length;
            }
            depth--;
        } else if (char === ',' && depth === 0) {
            parameters.push(current);
            current = '';
            continue;
        }
        current += char;
    }
    return undefined;
}

function isRequired(parameter: string): boolean {
    const text = parameter.replace(/#\[[^\]]*\]/g, '').trim();
    return text !== '' && !text.includes('=') && !text.includes('...');
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CLASS = /^\\?[A-Za-z_][A-Za-z0-9_]*(?:\\[A-Za-z_][A-Za-z0-9_]*)*$/;

/** Generate a zero-argument invocation. Reflection gives a clear error for unsupported callables. */
export function callableCode(target: CallableTarget): string {
    if (!NAME.test(target.name)) throw new Error('Invalid callable name');
    if (target.kind === 'method') {
        if (!target.className || !CLASS.test(target.className))
            throw new Error('Invalid class name');
        const className = '\\' + target.className.replace(/^\\/, '');
        return `(function () {
    $method = new \\ReflectionMethod(${className}::class, '${target.name}');
    if (!$method->isPublic() || $method->getNumberOfRequiredParameters() > 0) {
        throw new \\RuntimeException('Method must be public and take no required arguments.');
    }
    return $method->invoke($method->isStatic() ? null : app(${className}::class));
})();`;
    }
    const functionName = target.className
        ? target.className.replace(/^\\/, '') + '\\' + target.name
        : target.name;
    if (!CLASS.test(functionName)) throw new Error('Invalid function name');
    return `(function () {
    $function = new \\ReflectionFunction('\\\\${functionName}');
    if ($function->getNumberOfRequiredParameters() > 0) {
        throw new \\RuntimeException('Function must take no required arguments.');
    }
    return $function->invoke();
})();`;
}
