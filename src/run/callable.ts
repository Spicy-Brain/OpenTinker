export type CallableTarget = {
    kind: 'function' | 'method';
    name: string;
    className?: string;
    label: string;
    key: string;
    line: number;
};

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
