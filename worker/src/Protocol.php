<?php

declare(strict_types=1);

namespace OpenTinker;

/**
 * Newline-delimited JSON protocol spoken over stdin/stdout.
 *
 * Bump VERSION whenever a frame or request changes shape; the extension
 * refuses to talk to a worker that reports a different version.
 */
final class Protocol
{
    public const VERSION = 2;

    /** Statement index of the currently executing statement. */
    public int $stmt = 0;

    /** Source line of the currently executing statement. */
    public ?int $line = null;

    /** Request id of the currently executing run. */
    public ?string $requestId = null;

    /** @var array<int, array<string, mixed>> Requests that arrived while a run was busy. */
    private array $queue = [];

    /** @var resource */
    private $stdin;

    /** @var resource */
    private $stdout;

    public function __construct()
    {
        $this->stdin = \fopen('php://stdin', 'rb');
        $this->stdout = \fopen('php://stdout', 'wb');
    }

    /** @return resource */
    public function input()
    {
        return $this->stdin;
    }

    /** @param array<string, mixed> $frame */
    public function send(array $frame): void
    {
        $encoded = \json_encode(
            $frame,
            \JSON_UNESCAPED_SLASHES | \JSON_UNESCAPED_UNICODE | \JSON_INVALID_UTF8_SUBSTITUTE | \JSON_PARTIAL_OUTPUT_ON_ERROR
        );

        if ($encoded === false) {
            $encoded = \json_encode(['type' => 'fatal', 'message' => 'Failed to encode frame']);
        }

        \fwrite($this->stdout, $encoded . "\n");
        \fflush($this->stdout);
    }

    /** @param array<string, mixed> $request */
    public function defer(array $request): void
    {
        $this->queue[] = $request;
    }

    /** @return array<string, mixed>|null */
    public function read(): ?array
    {
        if ($this->queue !== []) {
            return \array_shift($this->queue);
        }

        return $this->readStream();
    }

    /** @return array<string, mixed>|null */
    public function readStream(): ?array
    {
        while (true) {
            $line = \fgets($this->stdin);

            if ($line === false) {
                return null;
            }

            $line = \trim($line);

            if ($line === '') {
                continue;
            }

            $decoded = \json_decode($line, true);

            if (! \is_array($decoded)) {
                $this->send(['type' => 'output', 'text' => "[opentinker] Ignored an unreadable request.\n"]);

                continue;
            }

            /** @var array<string, mixed> $decoded */
            return $decoded;
        }
    }

    /** Wait up to $micros for a request without blocking longer. */
    public function readReady(int $micros): bool
    {
        $read = [$this->stdin];
        $write = null;
        $except = null;

        return @\stream_select($read, $write, $except, 0, $micros) > 0;
    }

    public function output(string $text): void
    {
        $this->send([
            'type' => 'output',
            'id' => $this->requestId,
            'text' => $text,
            'stmt' => $this->stmt,
            'line' => $this->line,
        ]);
    }
}
