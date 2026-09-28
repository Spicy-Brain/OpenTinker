<?php

declare(strict_types=1);

namespace OpenTinker;

final class SourceCode
{
    public const PARSE_PREFIX = '<?php ';

    public static function stripOuterTags(string $code): string
    {
        // Replace tags with spaces so source line numbers stay aligned. Quoted
        // strings that contain PHP tags remain untouched.
        $code = \preg_replace('/\A(\s*)<\?php\b/', '$1     ', $code) ?? $code;

        return \preg_replace('/\?>[ \t]*\z/', '  ', $code) ?? $code;
    }

    /** The host app's php-parser, when PsySH brought one along. */
    public static function parser(): ?object
    {
        static $parser = null;

        if ($parser !== null) {
            return $parser;
        }

        // Not cached when missing: the autoloader may register it later.
        if (! \class_exists(\PhpParser\ParserFactory::class)) {
            return null;
        }

        $factory = new \PhpParser\ParserFactory();

        if (\method_exists($factory, 'createForHostVersion')) {
            return $parser = $factory->createForHostVersion();
        }

        // php-parser 4 (PsySH 0.11) only records file offsets when asked to.
        $lexer = new \PhpParser\Lexer\Emulative([
            'usedAttributes' => ['comments', 'startLine', 'endLine', 'startFilePos', 'endFilePos'],
        ]);

        return $parser = $factory->create(\PhpParser\ParserFactory::PREFER_PHP7, $lexer);
    }
}
