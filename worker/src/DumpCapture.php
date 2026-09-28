<?php

declare(strict_types=1);

namespace OpenTinker;

use Symfony\Component\VarDumper\Cloner\VarCloner;
use Symfony\Component\VarDumper\Dumper\HtmlDumper;
use Symfony\Component\VarDumper\VarDumper;

/**
 * Renders VarDumper output to HTML fragments for the webview.
 */
final class DumpCapture
{
    private readonly VarCloner $cloner;

    private int $dumpCount = 0;

    private ?int $statementLine = null;

    private int $prefixLines = 0;

    public function __construct(private readonly Protocol $protocol)
    {
        $this->cloner = new VarCloner();
    }

    /** Casters (e.g. Laravel Tinker's) so models and collections dump like in `artisan tinker`. */
    public function addCasters(array $casters): void
    {
        $this->cloner->addCasters($casters);
    }

    public function install(): void
    {
        VarDumper::setHandler(function (mixed $value, ?string $label = null): void {
            $this->dumpCount++;
            $frame = [
                'type' => 'dump',
                'id' => $this->protocol->requestId,
                'html' => $this->toHtml($value, $label),
                // dump($a, $b) labels arguments 1, 2, …; only show real labels.
                'short' => ($label !== null && $label !== '' && ! \ctype_digit($label) ? $label . ': ' : '') . Values::short($value),
                'stmt' => $this->protocol->stmt,
                'line' => $this->resolveLine(),
            ];
            $this->protocol->send($frame + $this->structured($value));
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

    public function setLineContext(?int $statementLine, int $prefixLines): void
    {
        $this->statementLine = $statementLine;
        $this->prefixLines = $prefixLines;
    }

    public function capture(mixed $value, ?string $label = null): string
    {
        return $this->toHtml($value, $label);
    }

    /** @return array<string, mixed> */
    public function structured(mixed $value): array
    {
        return Values::structured($value);
    }

    /**
     * Resolve the line in the original file that produced a dump.
     */
    private function resolveLine(): ?int
    {
        if ($this->statementLine === null) {
            return $this->protocol->line;
        }

        $trace = \debug_backtrace(\DEBUG_BACKTRACE_IGNORE_ARGS, 3);

        foreach ($trace as $frame) {
            $file = $frame['file'] ?? '';

            if ($file !== '' && \str_contains($file, "eval()'d code") && isset($frame['line'])) {
                $offset = (int) $frame['line'] - ($this->prefixLines + 1);
                $line = $this->statementLine + \max(0, $offset);

                return $line;
            }
        }

        return $this->statementLine;
    }

    private function toHtml(mixed $value, ?string $label): string
    {
        $dumper = new HtmlDumper;

        if (\method_exists($dumper, 'setDumpHeader')) {
            $dumper->setDumpHeader('');
        }

        if (\method_exists($dumper, 'setDumpBoundaries')) {
            $dumper->setDumpBoundaries('', '');
        }

        $theme = \getenv('OPENTINKER_DUMP_THEME') ?: 'dark';

        if (\method_exists($dumper, 'setTheme')) {
            $dumper->setTheme($theme);
        }

        $stream = \fopen('php://temp', 'r+');

        if ($stream === false) {
            return '';
        }

        $dumper->setOutput($stream);

        $data = $this->cloner->cloneVar($value);

        if ($label !== null && $label !== '' && ! \ctype_digit($label)) {
            $data = $data->withContext(['label' => $label]);
        }

        $dumper->dump($data);

        \rewind($stream);
        $html = \stream_get_contents($stream);
        \fclose($stream);

        return $html === false ? '' : $html;
    }
}
