<?php

declare(strict_types=1);

namespace OpenTinker;

use Psy\Shell;
use Throwable;

/** Reads the variables a run left behind, bounded for the Variables tab. */
final class ScopeReader
{
    private const MAX_VARIABLES = 50;
    private const MAX_VARIABLE_BYTES = 100_000;
    private const MAX_TOTAL_BYTES = 1_000_000;

    public function __construct(private readonly DumpCapture $capture)
    {
    }

    /** @return array{vars: array<int, array{name: string, type: string, short: string, html: string}>, truncated: bool} */
    public function read(Shell $shell): array
    {
        try {
            $scope = $shell->getScopeVariables(false);
        } catch (Throwable) {
            $scope = [];
        }

        $variables = [];
        $totalBytes = 0;
        $truncated = false;

        foreach ($scope as $name => $value) {
            if (\in_array($name, ['__psysh__', '_', '_e', '__out', '__class', '__namespace', '__file', '__line', '__dir', '__function', '__method'], true)) {
                continue;
            }

            if (\count($variables) >= self::MAX_VARIABLES) {
                $truncated = true;
                break;
            }

            try {
                $html = $this->capture->capture($value);
            } catch (Throwable) {
                continue;
            }

            if (\strlen($html) > self::MAX_VARIABLE_BYTES) {
                $html = '<em>Too large to display.</em>';
                $truncated = true;
            }

            if ($totalBytes + \strlen($html) > self::MAX_TOTAL_BYTES) {
                $truncated = true;
                break;
            }

            $totalBytes += \strlen($html);
            $variables[] = [
                'name' => (string) $name,
                'type' => \get_debug_type($value),
                'short' => Values::short($value),
                'html' => $html,
            ];
        }

        return ['vars' => $variables, 'truncated' => $truncated];
    }
}
