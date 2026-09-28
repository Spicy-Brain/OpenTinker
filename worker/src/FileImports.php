<?php

declare(strict_types=1);

namespace OpenTinker;

/** Extract only imports visible at a line in a PHP file. */
final class FileImports
{
    /** @return array<int, string> */
    public static function extract(string $source, int $line): array
    {
        if ($line < 1 || \strlen($source) > 2_000_000) return [];

        $source = \implode("\n", \array_slice(\explode("\n", $source), 0, $line - 1));
        $tokens = \token_get_all($source);
        $imports = [];
        $depth = 0;
        $topDepth = 0;
        $count = \count($tokens);

        for ($i = 0; $i < $count; $i++) {
            $token = $tokens[$i];
            if ($token === '{') {
                $depth++;
                continue;
            }
            if ($token === '}') {
                $depth--;
                if ($depth < $topDepth) {
                    $imports = [];
                    $topDepth = 0;
                }
                continue;
            }
            if (! \is_array($token)) continue;

            if ($token[0] === \T_NAMESPACE && $depth === 0) {
                $imports = [];
                while (++$i < $count) {
                    if ($tokens[$i] === ';') {
                        $topDepth = 0;
                        break;
                    }
                    if ($tokens[$i] === '{') {
                        $depth++;
                        $topDepth = $depth;
                        break;
                    }
                }
                continue;
            }

            if ($token[0] !== \T_USE || $depth !== $topDepth || $token[2] >= $line) continue;

            $next = $i + 1;
            while ($next < $count && \is_array($tokens[$next]) && \in_array($tokens[$next][0], [\T_WHITESPACE, \T_COMMENT, \T_DOC_COMMENT], true)) {
                $next++;
            }
            if (($tokens[$next] ?? null) === '(') continue; // Closure capture, not an import.

            $statement = '';
            $groupDepth = 0;
            for (; $i < $count; $i++) {
                $part = $tokens[$i];
                $statement .= \is_array($part) ? $part[1] : $part;
                if ($part === '{') $groupDepth++;
                if ($part === '}') $groupDepth--;
                if ($part === ';' && $groupDepth === 0) break;
            }
            if (\str_ends_with(\trim($statement), ';') && \strlen($statement) <= 32_000) {
                $imports[] = \trim($statement);
                if (\count($imports) >= 100) break;
            }
        }

        return $imports;
    }

    public static function valid(string $statement): bool
    {
        $found = self::extract('<?php ' . $statement, 1000000);
        return \count($found) === 1 && \trim($found[0]) === \trim($statement);
    }
}
