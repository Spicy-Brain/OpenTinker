<?php

declare(strict_types=1);

namespace OpenTinker;

/**
 * Keeps the booted worker process pristine and runs code in forked children.
 *
 * - Fresh runs fork a child per run. Every run starts from the freshly booted
 *   app and leaves nothing behind: no variables, imports, declared functions
 *   or mutated container state.
 * - Kept-session runs go to one long-lived "session" child, so variables carry
 *   over between runs. Restarting the session only kills that child; Laravel
 *   does not boot again.
 * - Tasks that load app code outside a run (model hints) also get a throwaway
 *   child, so a fatal error in app code can never take the worker down.
 *
 * While a child runs, the parent watches stdin for cancel requests and turns a
 * child that dies without finishing (fatal error, exit() in app code, kill)
 * into a clean error frame. User code never runs in this process: if a child
 * cannot be started, the run fails with an error instead.
 *
 * @phpstan-type Child array{pid: int, channel: resource, errorLog: string}
 * @phpstan-type Outcome array{finished: bool, alive: bool, cancelled: bool, status: int, messages: string, errors: string}
 */
final class Forker
{
    /** @var Child|null */
    private ?array $session = null;

    /** @var array<int, Child> Every child started and not yet reaped, by pid. */
    private array $children = [];

    public static function supported(): bool
    {
        return \function_exists('pcntl_fork')
            && \function_exists('pcntl_waitpid')
            && \function_exists('posix_kill')
            && \function_exists('stream_socket_pair')
            && \DIRECTORY_SEPARATOR === '/';
    }

    /**
     * @param string $tempDir private directory for the children's error logs
     * @param \Closure(): void $prepareChild runs in each child before user code
     * @param \Closure(array<string, mixed>, callable(int, int): void): void $execute runs one run in a child
     * @param \Closure(): void $closeConnections runs in the parent before forking
     * @param \Closure(array<string, mixed>): void $onOtherRequest handles other requests that arrive mid-run
     * @param \Closure(string): void $scope writes the kept session's variables (runs in the session child)
     */
    public function __construct(
        private readonly Protocol $protocol,
        private readonly string $tempDir,
        private readonly \Closure $prepareChild,
        private readonly \Closure $execute,
        private readonly \Closure $closeConnections,
        private readonly \Closure $onOtherRequest,
        private readonly \Closure $scope,
    ) {
    }

    /** @param array<string, mixed> $run */
    public function runFresh(array $run): void
    {
        $id = (string) ($run['id'] ?? '');
        $child = $this->fork(function ($channel) use ($run): void {
            $report = self::reporter($channel);
            ($this->execute)($run, static fn (int $stmt, int $line) => $report("s {$stmt} {$line}"));
            $report('done');
        });

        if (\is_string($child)) {
            $this->refuse($id, $child);

            return;
        }

        $this->report($id, $this->supervise($id, $child, true), true);
    }

    /** @param array<string, mixed> $run */
    public function runKept(array $run): void
    {
        $id = (string) ($run['id'] ?? '');
        $session = $this->ensureSession();

        if (\is_string($session)) {
            $this->refuse($id, $session);

            return;
        }

        self::write($session['channel'], ['type' => 'exec'] + $run);
        $outcome = $this->supervise($id, $session, false);

        if (! $outcome['alive']) {
            $this->session = null;
        }

        $this->report($id, $outcome, false);
    }

    /**
     * Runs $task in a throwaway child.
     *
     * @return string|null null when the task finished, otherwise why it did not
     */
    public function runTask(string $id, \Closure $task): ?string
    {
        $child = $this->fork(static function ($channel) use ($task): void {
            $task();
            self::reporter($channel)('done');
        });

        if (\is_string($child)) {
            return "Could not start a process: {$child}";
        }

        $outcome = $this->supervise($id, $child, true);

        if ($outcome['finished']) {
            return null;
        }

        return $outcome['cancelled'] ? 'Stopped.' : $this->failure($outcome);
    }

    /** Reports the kept session's variables, or an empty scope when there is none. */
    public function scope(string $id): void
    {
        $outcome = null;

        if ($this->session !== null) {
            self::write($this->session['channel'], ['type' => 'scope', 'id' => $id]);
            $outcome = $this->supervise($id, $this->session, false);

            if (! $outcome['alive']) {
                $this->session = null;
            }
        }

        if ($outcome === null || ! $outcome['finished']) {
            $this->protocol->send(['type' => 'scope', 'id' => $id, 'vars' => [], 'truncated' => false]);
        }
    }

    public function resetSession(): void
    {
        if ($this->session !== null) {
            $this->kill($this->session);
            $this->session = null;
        }
    }

    /** Kills every child and removes its files: on shutdown, end of input or a termination signal. */
    public function terminate(): void
    {
        foreach ($this->children as $child) {
            $this->kill($child);
        }

        $this->session = null;
    }

    /** @return Child|string the session, or why it could not be started */
    private function ensureSession(): array|string
    {
        if ($this->session !== null) {
            if (\pcntl_waitpid($this->session['pid'], $status, \WNOHANG) === 0) {
                return $this->session;
            }

            // It died while idle (killed from outside); start a new one.
            $this->release($this->session);
            $this->session = null;
        }

        $session = $this->fork(function ($channel): void {
            $report = self::reporter($channel);

            while (($line = \fgets($channel)) !== false) {
                $request = \json_decode($line, true);

                if (! \is_array($request)) {
                    continue;
                }

                if (($request['type'] ?? null) === 'scope') {
                    ($this->scope)((string) ($request['id'] ?? ''));
                } else {
                    ($this->execute)($request, static fn (int $stmt, int $line) => $report("s {$stmt} {$line}"));
                }

                $report('done');
            }
        });

        if (\is_array($session)) {
            $this->session = $session;
        }

        return $session;
    }

    /**
     * @param \Closure(resource): void $body
     * @return Child|string the child, or why it could not be started
     */
    private function fork(\Closure $body): array|string
    {
        ($this->closeConnections)();

        $pair = @\stream_socket_pair(\STREAM_PF_UNIX, \STREAM_SOCK_STREAM, \STREAM_IPPROTO_IP);

        if ($pair === false) {
            return 'could not create a socket pair';
        }

        [$parentEnd, $childEnd] = $pair;
        $errorLog = @\tempnam($this->tempDir, 'err-');

        if ($errorLog === false) {
            \fclose($parentEnd);
            \fclose($childEnd);

            return "could not create a file in {$this->tempDir}";
        }

        $pid = @\pcntl_fork();

        if ($pid === -1) {
            \fclose($parentEnd);
            \fclose($childEnd);
            @\unlink($errorLog);

            return 'fork failed: ' . \pcntl_strerror(\pcntl_get_last_error());
        }

        if ($pid === 0) {
            \fclose($parentEnd);
            $this->detach();

            // Record fatals where the parent can read them if this process dies.
            \ini_set('log_errors', '1');
            \ini_set('error_log', $errorLog);

            try {
                ($this->prepareChild)();
                $body($childEnd);
            } catch (\Throwable $throwable) {
                self::reporter($childEnd)('crash ' . \str_replace("\n", ' ', $throwable->getMessage()));
            }

            // Skip destructors and shutdown handlers inherited from the parent
            // app: they would close shared resources or write output.
            \posix_kill(\getmypid(), \SIGKILL);

            exit(0);
        }

        \fclose($childEnd);
        \stream_set_blocking($parentEnd, false);

        return $this->children[$pid] = ['pid' => $pid, 'channel' => $parentEnd, 'errorLog' => $errorLog];
    }

    /** In a new child, lets go of what belongs to the parent. */
    private function detach(): void
    {
        // The parent's termination handlers would kill the parent's other children.
        if (\function_exists('pcntl_signal')) {
            foreach ([\SIGTERM, \SIGHUP, \SIGINT] as $signal) {
                \pcntl_signal($signal, \SIG_DFL);
            }
        }

        // Holding the kept session's channel would keep that session alive if
        // this child outlived the worker.
        foreach ($this->children as $sibling) {
            if (\is_resource($sibling['channel'])) {
                \fclose($sibling['channel']);
            }
        }

        $this->children = [];
        $this->session = null;
    }

    /** @return \Closure(string): void */
    private static function reporter($channel): \Closure
    {
        return static function (string $line) use ($channel): void {
            @\fwrite($channel, $line . "\n");
            @\fflush($channel);
        };
    }

    /**
     * Sends a request to the kept session. The channel is non-blocking so the
     * parent can poll it; a non-blocking write would silently cut a request
     * larger than the socket buffer (8 KB on macOS), so block while writing.
     *
     * @param resource $channel
     * @param array<string, mixed> $request
     */
    private static function write($channel, array $request): void
    {
        $data = \json_encode($request, \JSON_INVALID_UTF8_SUBSTITUTE | \JSON_PARTIAL_OUTPUT_ON_ERROR) . "\n";
        \stream_set_blocking($channel, true);

        try {
            for ($offset = 0, $length = \strlen($data); $offset < $length; $offset += $written) {
                $written = @\fwrite($channel, \substr($data, $offset));

                if ($written === false || $written === 0) {
                    return; // The session died; supervise() reports it.
                }
            }
        } finally {
            \stream_set_blocking($channel, false);
        }
    }

    /**
     * Waits for a child to finish the current request, serving other requests meanwhile.
     *
     * @param Child $child
     * @return Outcome
     */
    private function supervise(string $id, array $child, bool $oneShot): array
    {
        $messages = '';
        $cancelled = false;
        $status = 0;
        $alive = true;
        $finished = false;

        while (true) {
            $messages .= (string) @\stream_get_contents($child['channel']);

            if (! $finished && \preg_match('/^done$/m', $messages)) {
                $finished = true;

                if (! $oneShot) {
                    break;
                }
            }

            $waited = \pcntl_waitpid($child['pid'], $status, \WNOHANG);

            if ($waited === $child['pid'] || $waited === -1) {
                $alive = false;
                $messages .= (string) @\stream_get_contents($child['channel']);
                $finished = $finished || (bool) \preg_match('/^done$/m', $messages);
                break;
            }

            if (! $this->protocol->readReady(20_000)) {
                continue;
            }

            $request = $this->protocol->readStream();

            if ($request === null || ($request['type'] ?? null) === 'shutdown') {
                $this->terminate();
                exit(0);
            }

            if (($request['type'] ?? null) === 'cancel') {
                // A late cancel for a run that already ended must not stop this one.
                $target = (string) ($request['id'] ?? '');

                if ($target === '' || $target === $id) {
                    $cancelled = true;
                    \posix_kill($child['pid'], \SIGKILL);
                }

                continue;
            }

            ($this->onOtherRequest)($request);
        }

        $errors = (string) @\file_get_contents($child['errorLog']);

        if (! $alive) {
            $this->release($child);
        } elseif ($errors !== '') {
            @\file_put_contents($child['errorLog'], '');
        }

        return ['finished' => $finished, 'alive' => $alive, 'cancelled' => $cancelled, 'status' => $status, 'messages' => $messages, 'errors' => $errors];
    }

    /**
     * Sends the frames for a run whose child ended without finishing it.
     *
     * @param Outcome $outcome
     */
    private function report(string $id, array $outcome, bool $oneShot): void
    {
        if ($outcome['finished']) {
            return;
        }

        [$stmt, $line] = $this->lastStatement($outcome['messages']);
        $sessionNote = $oneShot ? '' : ' The kept session was reset.';
        $status = $outcome['status'];

        if ($outcome['cancelled']) {
            $this->protocol->send(['type' => 'statement', 'id' => $id, 'stmt' => $stmt, 'line' => $line, 'endLine' => $line, 'ok' => false, 'ms' => 0, 'memory' => 0, 'exit' => 'Stopped']);
            $this->protocol->send(['type' => 'result', 'id' => $id, 'ok' => false, 'failed' => true, 'stopped' => true, 'statements' => $stmt, 'ms' => 0, 'memory' => 0, 'sessionReset' => ! $oneShot]);

            return;
        }

        $crashed = $this->lastFatal($outcome['errors']) !== null || \preg_match('/^crash /m', $outcome['messages']);

        if (! $crashed && \pcntl_wifexited($status)) {
            // exit()/die/dd() in app or vendor code ends the run like dd() in scratch.
            $this->protocol->send(['type' => 'statement', 'id' => $id, 'stmt' => $stmt, 'line' => $line, 'endLine' => $line, 'ok' => true, 'ms' => 0, 'memory' => 0, 'exit' => 'exit(' . \pcntl_wexitstatus($status) . ')' . $sessionNote]);
            $this->protocol->send(['type' => 'result', 'id' => $id, 'ok' => true, 'failed' => false, 'statements' => $stmt, 'ms' => 0, 'memory' => 0, 'ended' => 'exit', 'sessionReset' => ! $oneShot]);

            return;
        }

        $this->protocol->send([
            'type' => 'error',
            'id' => $id,
            'stmt' => $stmt,
            'line' => $line,
            'ok' => false,
            'errorClass' => 'FatalError',
            'message' => $this->failure($outcome) . $sessionNote,
            'scratchLine' => $line,
            'frames' => [],
            'ms' => 0,
        ]);
        $this->protocol->send(['type' => 'statement', 'id' => $id, 'stmt' => $stmt, 'line' => $line, 'endLine' => $line, 'ok' => false, 'ms' => 0, 'memory' => 0]);
        $this->protocol->send(['type' => 'result', 'id' => $id, 'ok' => false, 'failed' => true, 'statements' => $stmt, 'ms' => 0, 'memory' => 0, 'sessionReset' => ! $oneShot]);
    }

    /** Fails a run that could not get a child process, rather than running it here. */
    private function refuse(string $id, string $reason): void
    {
        $this->protocol->send([
            'type' => 'error',
            'id' => $id,
            'stmt' => 0,
            'line' => 1,
            'ok' => false,
            'errorClass' => 'RuntimeException',
            'message' => "Could not start a process for this run: {$reason}.",
            'scratchLine' => 1,
            'frames' => [],
            'ms' => 0,
        ]);
        $this->protocol->send(['type' => 'result', 'id' => $id, 'ok' => false, 'failed' => true, 'statements' => 0, 'ms' => 0, 'memory' => 0]);
    }

    /** @param Outcome $outcome */
    private function failure(array $outcome): string
    {
        $crash = \preg_match('/^crash (.*)$/m', $outcome['messages'], $match) ? $match[1] : null;
        $signal = \pcntl_wifsignaled($outcome['status']) ? ' (signal ' . \pcntl_wtermsig($outcome['status']) . ')' : '';

        return $this->lastFatal($outcome['errors']) ?? $crash ?? "The run process ended unexpectedly{$signal}.";
    }

    /** @param Child $child */
    private function kill(array $child): void
    {
        @\posix_kill($child['pid'], \SIGKILL);
        @\pcntl_waitpid($child['pid'], $status);
        $this->release($child);
    }

    /** @param Child $child */
    private function release(array $child): void
    {
        unset($this->children[$child['pid']]);

        if (\is_resource($child['channel'])) {
            \fclose($child['channel']);
        }

        @\unlink($child['errorLog']);
    }

    /** @return array{0: int, 1: int} */
    private function lastStatement(string $messages): array
    {
        if (\preg_match_all('/^s (\d+) (\d+)$/m', $messages, $matches) > 0) {
            return [(int) \end($matches[1]), (int) \end($matches[2])];
        }

        return [0, 1];
    }

    private function lastFatal(string $errors): ?string
    {
        if (! \preg_match_all('/PHP (?:Fatal error|Parse error):\s+(.+?)(?: in \S+(?: : eval\(\)\'d code)? on line \d+)?$/m', $errors, $matches)) {
            return null;
        }

        // The first fatal is the cause; later ones come from shutdown handlers.
        $message = \trim((string) $matches[1][0]);

        return \preg_replace('/^Uncaught /', '', $message) ?? $message;
    }
}
