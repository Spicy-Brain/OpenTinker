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

        // Every frame starts on a fresh line, so bytes that bypass the protocol
        // (a BOM, fwrite(STDOUT), a child killed mid-write) end their own line
        // instead of corrupting this frame. Decoders skip the empty lines.
        // A failed write means the extension has gone; the worker exits when
        // it sees stdin close, so there is nothing else to do here.
        @\fwrite($this->stdout, "\n" . $encoded . "\n");
        @\fflush($this->stdout);
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

    /**
     * Like read(), but waits in short select() calls rather than one blocking
     * read, so asynchronous signal handlers get to run while the worker is idle.
     *
     * @return array<string, mixed>|null
     */
    public function readPolling(): ?array
    {
        while ($this->queue === [] && ! $this->readReady(1_000_000)) {
            // Keep waiting; a signal handler may run in between.
        }

        return $this->read();
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

        return @\stream_select($read, $write, $except, \intdiv($micros, 1_000_000), $micros % 1_000_000) > 0;
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
