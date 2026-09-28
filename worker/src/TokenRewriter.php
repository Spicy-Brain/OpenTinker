<?php

declare(strict_types=1);

namespace OpenTinker;

/**
 * Thrown in place of exit/die/dd so a run ends cleanly instead of killing PHP.
 * An Error rather than an Exception, so `catch (Exception $e)` in scratch code
 * does not swallow it.
 */
final class ExitCalledException extends \Error
{
    /**
     * The last one raised. The runner checks it after every statement, so even
     * a `catch (\Throwable)` in scratch code cannot keep a run going past dd().
     */
    public static ?self $raised = null;

    public function __construct(string $message, public readonly string $kind = 'exit')
    {
        parent::__construct($message);
        self::$raised = $this;
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
 * - exit/die become a thrown ExitCalledException.
 */
final class TokenRewriter
{
    private const IGNORABLE = [\T_WHITESPACE, \T_COMMENT, \T_DOC_COMMENT];

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
                [$expression, $lastIndex] = self::exitArgument($tokens, $i);
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
     * The argument of the exit/die at $index. PHP only accepts one in
     * parentheses; a bare exit (`$x ?: exit`, `[exit, 1]`, `1 => exit,`)
     * has none, and whatever follows it is left alone.
     *
     * @param array<int, array{0: int, 1: string, 2: int}|string> $tokens
     * @return array{0: string|null, 1: int} the expression, and the index of the last token consumed
     */
    private static function exitArgument(array $tokens, int $index): array
    {
        $count = \count($tokens);
        $i = $index + 1;

        while ($i < $count && \is_array($tokens[$i]) && \in_array($tokens[$i][0], self::IGNORABLE, true)) {
            $i++;
        }

        if ($i >= $count || $tokens[$i] !== '(') {
            return [null, $index];
        }

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

        return [\trim($expression) === '' ? null : $expression, $i];
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

        // Skip method and static calls such as $collection->dd() or Foo::dd(),
        // declarations and `new dd()`.
        for ($i = $index - 1; $i >= 0; $i--) {
            if (\is_array($tokens[$i]) && $tokens[$i][0] === \T_WHITESPACE) {
                continue;
            }

            if (\is_array($tokens[$i]) && \in_array($tokens[$i][0], [\T_OBJECT_OPERATOR, \T_NULLSAFE_OBJECT_OPERATOR, \T_DOUBLE_COLON, \T_FUNCTION, \T_NEW], true)) {
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
