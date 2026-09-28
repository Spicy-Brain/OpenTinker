<?php

declare(strict_types=1);

namespace OpenTinker;

/** Thrown in place of exit/die/dd so a run ends cleanly instead of killing PHP. */
final class ExitCalledException extends \RuntimeException
{
    public function __construct(string $message, public readonly string $kind = 'exit')
    {
        parent::__construct($message);
    }
}

/** Target of rewritten dd() calls in user code: dump every argument, then end the run. */
final class Dd
{
    public static function call(mixed ...$values): never
    {
        foreach ($values as $value) {
            \Symfony\Component\VarDumper\VarDumper::dump($value);
        }

        throw new ExitCalledException('dd()', 'dd');
    }
}

/**
 * Rewrites constructs in user code that would terminate the worker process.
 *
 * - dd(...) dumps its arguments, then ends the run cleanly.
 * - exit/die become a catchable ExitCalledException.
 */
final class TokenRewriter
{
    public static function rewrite(string $code): string
    {
        $code = SourceCode::stripOuterTags($code);

        if (\trim($code) === '') {
            return 'return null;';
        }

        $tokens = \token_get_all(SourceCode::PARSE_PREFIX . $code);
        \array_shift($tokens);

        $output = '';
        $count = \count($tokens);

        for ($i = 0; $i < $count; $i++) {
            $token = $tokens[$i];

            if (\is_array($token) && $token[0] === \T_EXIT) {
                [$expression, $lastIndex] = self::consumeExitExpression($tokens, $i + 1);
                $message = $expression === null ? "''" : '(string) (' . $expression . ')';
                $output .= 'throw new \\OpenTinker\\ExitCalledException(' . $message . ')';
                $i = $lastIndex;

                continue;
            }

            if (\is_array($token) && self::isDdCall($tokens, $i)) {
                $output .= '\\OpenTinker\\Dd::call';

                continue;
            }

            $output .= \is_array($token) ? $token[1] : $token;
        }

        return $output;
    }

    /**
     * @param array<int, array{0: int, 1: string, 2: int}|string> $tokens
     * @return array{0: string|null, 1: int}
     */
    private static function consumeExitExpression(array $tokens, int $start): array
    {
        $count = \count($tokens);
        $i = $start;

        while ($i < $count && \is_array($tokens[$i]) && $tokens[$i][0] === \T_WHITESPACE) {
            $i++;
        }

        if ($i >= $count) {
            return [null, $i - 1];
        }

        if ($tokens[$i] === '(') {
            $depth = 0;
            $expression = '';

            for (; $i < $count; $i++) {
                $text = \is_array($tokens[$i]) ? $tokens[$i][1] : $tokens[$i];

                if ($text === '(') {
                    $depth++;

                    if ($depth === 1) {
                        continue;
                    }
                } elseif ($text === ')') {
                    $depth--;

                    if ($depth === 0) {
                        break;
                    }
                }

                $expression .= $text;
            }

            return [$expression === '' ? "''" : $expression, $i];
        }

        if ($tokens[$i] === ';') {
            return [null, $i - 1];
        }

        // Legacy syntax: exit "message";
        $expression = '';
        $depth = 0;

        for (; $i < $count; $i++) {
            $text = \is_array($tokens[$i]) ? $tokens[$i][1] : $tokens[$i];

            if ($text === ';' && $depth === 0) {
                break;
            }

            if (\in_array($text, ['(', '[', '{'], true)) {
                $depth++;
            } elseif (\in_array($text, [')', ']', '}'], true)) {
                $depth--;
            }

            $expression .= $text;
        }

        return [\trim($expression) === '' ? "''" : $expression, $i - 1];
    }

    /** @param array<int, array{0: int, 1: string, 2: int}|string> $tokens */
    private static function isDdCall(array $tokens, int $index): bool
    {
        $token = $tokens[$index];

        if (! \is_array($token)) {
            return false;
        }

        $isName = \in_array($token[0], [\T_STRING, \T_NAME_FULLY_QUALIFIED, \T_NAME_QUALIFIED], true);

        if (! $isName || \ltrim($token[1], '\\') !== 'dd') {
            return false;
        }

        // Skip method and static calls such as $collection->dd() or Foo::dd().
        for ($i = $index - 1; $i >= 0; $i--) {
            if (\is_array($tokens[$i]) && $tokens[$i][0] === \T_WHITESPACE) {
                continue;
            }

            if (\is_array($tokens[$i]) && \in_array($tokens[$i][0], [\T_OBJECT_OPERATOR, \T_NULLSAFE_OBJECT_OPERATOR, \T_DOUBLE_COLON, \T_FUNCTION], true)) {
                return false;
            }

            break;
        }

        $count = \count($tokens);

        for ($i = $index + 1; $i < $count; $i++) {
            if (\is_array($tokens[$i]) && $tokens[$i][0] === \T_WHITESPACE) {
                continue;
            }

            return $tokens[$i] === '(';
        }

        return false;
    }
}
