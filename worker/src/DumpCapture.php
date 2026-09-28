<?php

declare(strict_types=1);

namespace OpenTinker;

use Symfony\Component\VarDumper\Cloner\VarCloner;
use Symfony\Component\VarDumper\Dumper\HtmlDumper;
use Symfony\Component\VarDumper\VarDumper;

/**
 * Renders VarDumper output to HTML fragments for the webview, bounded in size.
 */
final class DumpCapture
{
    public const TOO_LARGE = '<em>Too large to display.</em>';

    /** Longest string shown in full; VarDumper marks where the rest was cut. */
    private const MAX_STRING = 100_000;

    /** A dump larger than this is rendered again with tighter limits. */
    private const MAX_HTML_BYTES = 1_000_000;

    private readonly VarCloner $cloner;

    private readonly VarCloner $compactCloner;

    private readonly HtmlDumper $dumper;

    private int $dumpCount = 0;

    private ?int $statementLine = null;

    public function __construct(private readonly Protocol $protocol)
    {
        $this->cloner = new VarCloner();
        $this->cloner->setMaxString(self::MAX_STRING);
        $this->compactCloner = new VarCloner();
        $this->compactCloner->setMaxItems(250);
        $this->compactCloner->setMaxString(2_000);

        // No header (its CSS and JS) or <pre> wrapper: the webview styles dumps itself.
        $this->dumper = new HtmlDumper();
        $this->dumper->setDumpHeader('');
        $this->dumper->setDumpBoundaries('', '');
    }

    /** Casters (e.g. Laravel Tinker's) so models and collections dump like in `artisan tinker`. */
    public function addCasters(array $casters): void
    {
        $this->cloner->addCasters($casters);
        $this->compactCloner->addCasters($casters);
    }

    public function install(): void
    {
        VarDumper::setHandler(function (mixed $value, ?string $label = null): void {
            $this->dumpCount++;
            // dump($a, $b) labels arguments 1, 2, …; only show real labels.
            $label = $label !== null && $label !== '' && ! \ctype_digit($label) ? $label : null;

            $this->protocol->send([
                'type' => 'dump',
                'id' => $this->protocol->requestId,
                'html' => $this->capture($value, $label),
                'short' => ($label !== null ? $label . ': ' : '') . Values::short($value),
                'stmt' => $this->protocol->stmt,
                'line' => $this->resolveLine(),
            ] + Values::structured($value));
        });
    }

    public function resetCount(): void
    {
        $this->dumpCount = 0;
    }

    public function count(): int
    {
        return $this->dumpCount;
    }

    /** The scratch line of the statement running now, used to place dumps. */
    public function setLine(?int $statementLine): void
    {
        $this->statementLine = $statementLine;
    }

    /** VarDumper HTML for a value, at most $maxBytes long. Never throws. */
    public function capture(mixed $value, ?string $label = null, int $maxBytes = self::MAX_HTML_BYTES): string
    {
        try {
            $html = $this->render($this->cloner, $value, $label);

            if (\strlen($html) > $maxBytes) {
                $html = $this->render($this->compactCloner, $value, $label);
            }

            return \strlen($html) > $maxBytes ? self::TOO_LARGE : $html;
        } catch (\Throwable $throwable) {
            return '<em>Could not display this value: ' . \htmlspecialchars($throwable->getMessage(), \ENT_QUOTES | \ENT_SUBSTITUTE) . '</em>';
        }
    }

    /** Resolve the line in the original file that produced a dump. */
    private function resolveLine(): ?int
    {
        if ($this->statementLine === null) {
            return $this->protocol->line;
        }

        foreach (\debug_backtrace(\DEBUG_BACKTRACE_IGNORE_ARGS, 3) as $frame) {
            $file = $frame['file'] ?? '';

            if ($file !== '' && \str_contains($file, "eval()'d code") && isset($frame['line'])) {
                return $this->statementLine + \max(0, (int) $frame['line'] - 1);
            }
        }

        return $this->statementLine;
    }

    private function render(VarCloner $cloner, mixed $value, ?string $label): string
    {
        $data = $cloner->cloneVar($value);

        if ($label !== null) {
            $data = $data->withContext(['label' => $label]);
        }

        $stream = \fopen('php://temp', 'r+');

        if ($stream === false) {
            return '';
        }

        $this->dumper->dump($data, $stream);
        \rewind($stream);
        $html = \stream_get_contents($stream);
        \fclose($stream);

        return $html === false ? '' : $html;
    }
}
