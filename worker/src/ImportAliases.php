<?php

declare(strict_types=1);

namespace OpenTinker;

/**
 * PsySH 0.12.22+ remembers `use` aliases between inputs and rejects any second
 * declaration of an alias, even one pointing at the same name. Re-running a
 * file redeclares its imports, so blank out imports the session already has.
 */
final class ImportAliases
{
    public static function withoutKnown(\Psy\CodeCleaner $cleaner, string $code): string
    {
        if (\stripos($code, 'use') === false || ! \method_exists($cleaner, 'getAliasesByTypeForNamespace')) {
            return $code;
        }

        $known = $cleaner->getAliasesByTypeForNamespace(null);
        if ($known === []) return $code;

        $parser = SourceCode::parser();
        if ($parser === null) return $code;

        try {
            $prefix = SourceCode::PARSE_PREFIX;
            $nodes = $parser->parse($prefix . $code) ?? [];
        } catch (\Throwable) {
            return $code;
        }

        // Walk backwards so earlier byte offsets stay valid while blanking.
        foreach (\array_reverse($nodes) as $node) {
            if (! $node instanceof \PhpParser\Node\Stmt\Use_ && ! $node instanceof \PhpParser\Node\Stmt\GroupUse) continue;

            $groupPrefix = $node instanceof \PhpParser\Node\Stmt\GroupUse ? $node->prefix->toString() . '\\' : '';
            foreach ($node->uses as $item) {
                $type = $item->type !== \PhpParser\Node\Stmt\Use_::TYPE_UNKNOWN ? $item->type : $node->type;
                $existing = $known[$type][\strtolower($item->getAlias()->toString())] ?? null;
                $name = \ltrim($groupPrefix . $item->name->toString(), '\\');
                if (! $existing instanceof \PhpParser\Node\Name || \strcasecmp(\ltrim($existing->toString(), '\\'), $name) !== 0) {
                    continue 2; // New or changed import: let PsySH handle it.
                }
            }

            $start = $node->getStartFilePos() - \strlen($prefix);
            $end = $node->getEndFilePos() - \strlen($prefix);
            if ($start < 0 || $end < $start) continue;
            // Keep newlines so reported line numbers still match the source.
            $blank = \preg_replace('/[^\n]/', ' ', \substr($code, $start, $end - $start + 1)) ?? '';
            $code = \substr_replace($code, $blank, $start, $end - $start + 1);
        }

        return $code;
    }
}
