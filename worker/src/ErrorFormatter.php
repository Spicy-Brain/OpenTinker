<?php

declare(strict_types=1);

namespace OpenTinker;

use Throwable;

/**
 * Turns a Throwable into an error frame the panel can present well: a clean
 * message, the scratch line first, app frames that open in the editor, vendor
 * frames collapsed and PsySH/OpenTinker internals removed.
 */
final class ErrorFormatter
{
    private const MAX_FRAMES = 40;

    public function __construct(
        private readonly string $basePath,
        private readonly string $workerFile,
    ) {
    }

    /** @return array<string, mixed> */
    public function describe(Throwable $throwable, int $statementLine): array
    {
        $original = $throwable;

        // PsySH wraps some engine errors; show the error the user caused.
        if ($throwable instanceof \Psy\Exception\ErrorException && $throwable->getPrevious() !== null) {
            $throwable = $throwable->getPrevious();
        }

        $frames = [];
        $scratchLine = null;

        $origin = $this->frame($throwable->getFile(), $throwable->getLine(), '', $statementLine);
        if ($origin !== null) {
            $frames[] = $origin;
            if ($origin['kind'] === 'scratch') $scratchLine = $origin['line'];
        }

        foreach ($throwable->getTrace() as $trace) {
            if (\count($frames) >= self::MAX_FRAMES) {
                break;
            }

            $call = ($trace['class'] ?? '') . ($trace['type'] ?? '') . ($trace['function'] ?? '');
            $frame = $this->frame($trace['file'] ?? null, $trace['line'] ?? null, $call, $statementLine);

            if ($frame === null) {
                continue;
            }

            if ($frame['kind'] === 'scratch' && $scratchLine === null) {
                $scratchLine = $frame['line'];
            }

            $frames[] = $frame;
        }

        return [
            'errorClass' => $throwable::class,
            'message' => $this->cleanMessage($original, $throwable),
            'scratchLine' => $scratchLine ?? $statementLine,
            'file' => $this->isInternal($throwable->getFile()) ? null : $throwable->getFile(),
            'errorLine' => $throwable->getLine(),
            'frames' => $frames,
        ];
    }

    /** @return array{file: string|null, line: int|null, call: string, kind: string}|null */
    private function frame(?string $file, ?int $line, string $call, int $statementLine): ?array
    {
        if ($file !== null && \str_contains($file, "eval()'d code")) {
            // PsySH pretty-prints code before eval, so only the statement start is reliable.
            return ['file' => null, 'line' => $statementLine, 'call' => $call, 'kind' => 'scratch'];
        }

        if ($file === null || $file === '') {
            return $call === '' || $this->isInternalCall($call)
                ? null
                : ['file' => null, 'line' => null, 'call' => $call, 'kind' => 'internal'];
        }

        if ($this->isInternal($file)) {
            return null;
        }

        $vendor = \str_starts_with($file, $this->basePath . '/vendor/');

        return ['file' => $file, 'line' => $line, 'call' => $call, 'kind' => $vendor ? 'vendor' : 'app'];
    }

    private function isInternal(string $file): bool
    {
        return $file === $this->workerFile
            || \str_contains($file, '/vendor/psy/psysh/')
            || \str_contains($file, '/vendor/nikic/php-parser/')
            || \str_contains($file, '/opentinker/worker')
            || \str_contains($file, '/.opentinker/worker');
    }

    private function isInternalCall(string $call): bool
    {
        return \str_starts_with($call, 'Psy\\') || \str_starts_with($call, 'OpenTinker\\');
    }

    private function cleanMessage(Throwable $original, Throwable $throwable): string
    {
        $message = $throwable->getMessage();

        if ($original instanceof \Psy\Exception\FatalErrorException || $original instanceof \Psy\Exception\ParseErrorException) {
            $message = \preg_replace('/^PHP (Fatal error|Parse error):\s+/', '', $message) ?? $message;
            $message = \preg_replace("/ in eval\\(\\)'d code on line \\d+$/", '', $message) ?? $message;
        }

        return \trim($message);
    }
}
