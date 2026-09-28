<?php

declare(strict_types=1);

namespace OpenTinker;

/**
 * Splits code into top-level statements so each can run and render as its
 * own card. Uses the host app's php-parser (a PsySH dependency) so every PHP
 * construct is split exactly.
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

        // php-parser comes with PsySH, so it is always there in practice.
        $parser = SourceCode::parser();

        return $parser === null ? self::wholeFile($code) : self::splitAst($parser, $code);
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
    private static function wholeFile(string $code): array
    {
        return [
            'safe' => false,
            'statements' => [['code' => \trim(SourceCode::stripOuterTags($code)), 'line' => 1, 'import' => false]],
        ];
    }
}
