<?php

declare(strict_types=1);

namespace OpenTinker;

/**
 * Splits code into top-level statements so each can run and render as its
 * own card. Uses the host app's php-parser (a PsySH dependency) so every PHP
 * construct is split exactly; falls back to a tokenizer only if it is missing.
 *
 * @phpstan-type Statement array{code: string, line: int, import: bool}
 * @phpstan-type Split array{safe: bool, statements: array<int, Statement>, error?: array{message: string, line: int}}
 */
final class StatementSplitter
{
    /** @return Split */
    public static function split(string $code): array
    {
        if (\str_contains($code, '<?=')) {
            return self::wholeFile($code);
        }

        $code = SourceCode::stripOuterTags($code);

        if (\trim($code) === '') {
            return ['safe' => true, 'statements' => []];
        }

        $parser = SourceCode::parser();

        return $parser === null ? self::splitTokens($code) : self::splitAst($parser, $code);
    }

    /** @return Split */
    private static function splitAst(object $parser, string $code): array
    {
        $prefix = SourceCode::PARSE_PREFIX;

        try {
            $nodes = $parser->parse($prefix . $code) ?? [];
        } catch (\PhpParser\Error $error) {
            // Scratch files often end with an expression and no semicolon, as
            // PsySH allows. Accept that before reporting a syntax error.
            try {
                $nodes = $parser->parse($prefix . $code . ';') ?? [];
            } catch (\PhpParser\Error) {
                return [
                    'safe' => true,
                    'statements' => [],
                    'error' => ['message' => $error->getRawMessage(), 'line' => \max(1, $error->getStartLine())],
                ];
            }
        }

        $statements = [];
        $offset = \strlen($prefix);

        foreach ($nodes as $node) {
            if ($node instanceof \PhpParser\Node\Stmt\Nop) {
                continue;
            }

            if ($node instanceof \PhpParser\Node\Stmt\Namespace_
                || $node instanceof \PhpParser\Node\Stmt\HaltCompiler
                || $node instanceof \PhpParser\Node\Stmt\InlineHTML
                || $node instanceof \PhpParser\Node\Stmt\Declare_) {
                return self::wholeFile($code);
            }

            $start = $node->getStartFilePos() - $offset;
            $end = \min($node->getEndFilePos() - $offset, \strlen($code) - 1);

            if ($start < 0 || $end < $start) {
                return self::wholeFile($code);
            }

            $statements[] = [
                'code' => \substr($code, $start, $end - $start + 1),
                'line' => $node->getStartLine(),
                'import' => $node instanceof \PhpParser\Node\Stmt\Use_ || $node instanceof \PhpParser\Node\Stmt\GroupUse,
            ];
        }

        return ['safe' => true, 'statements' => $statements];
    }

    /** @return Split */
    private static function splitTokens(string $code): array
    {
        $tokens = \token_get_all(SourceCode::PARSE_PREFIX . $code);
        \array_shift($tokens);

        $unsafe = [\T_ENDIF, \T_ENDFOR, \T_ENDFOREACH, \T_ENDWHILE, \T_ENDSWITCH, \T_ENDDECLARE, \T_INLINE_HTML, \T_HALT_COMPILER, \T_OPEN_TAG_WITH_ECHO, \T_DECLARE, \T_NAMESPACE];

        foreach ($tokens as $token) {
            if (\is_array($token) && \in_array($token[0], $unsafe, true)) {
                return self::wholeFile($code);
            }
        }

        $statements = [];
        $buffer = '';
        $startLine = null;
        $lastLine = 1;
        $depth = 0;
        $isImport = false;

        foreach ($tokens as $token) {
            $text = \is_array($token) ? $token[1] : $token;

            if (\is_array($token)) {
                $lastLine = $token[2];
            }

            if ($startLine === null) {
                if (\is_array($token) && \in_array($token[0], [\T_WHITESPACE, \T_COMMENT, \T_DOC_COMMENT], true)) {
                    continue;
                }

                $startLine = $lastLine;
                $isImport = \is_array($token) && $token[0] === \T_USE;
            }

            $buffer .= $text;

            if ($text === '{') {
                $depth++;
            } elseif ($text === '}') {
                $depth--;

                // A group import (`use A\{B, C};`) ends at its semicolon, not its brace.
                if ($depth <= 0 && ! $isImport) {
                    $statements[] = ['code' => $buffer, 'line' => $startLine, 'import' => false];
                    $buffer = '';
                    $startLine = null;
                    $depth = 0;
                }
            } elseif ($text === ';' && $depth === 0) {
                $statements[] = ['code' => $buffer, 'line' => $startLine, 'import' => $isImport];
                $buffer = '';
                $startLine = null;
                $isImport = false;
            }
        }

        if ($startLine !== null && \trim($buffer) !== '') {
            $statements[] = ['code' => $buffer, 'line' => $startLine, 'import' => $isImport];
        }

        return ['safe' => true, 'statements' => $statements];
    }

    /** @return Split */
    private static function wholeFile(string $code): array
    {
        return [
            'safe' => false,
            'statements' => [['code' => \trim(SourceCode::stripOuterTags($code)), 'line' => 1, 'import' => false]],
        ];
    }
}
