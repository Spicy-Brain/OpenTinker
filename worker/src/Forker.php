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
 *
 * While a child runs, the parent watches stdin for cancel requests and turns a
 * child that dies without finishing (fatal error, exit() in app code, kill)
 * into a clean error frame.
 */
final class Forker
{
    /** @var array{pid: int, channel: resource, errorLog: string}|null */
    private ?array $session = null;

    public static function supported(): bool
    {
        return \function_exists('pcntl_fork')
            && \function_exists('pcntl_waitpid')
            && \function_exists('posix_kill')
            && \function_exists('stream_socket_pair')
            && \DIRECTORY_SEPARATOR === '/';
    }

    /**
     * @param \Closure(): void $prepareChild runs in each child before user code
     * @param \Closure(array<string, mixed>, callable(int, int): void): void $execute runs one run in a child
     * @param \Closure(): void $closeConnections runs in the parent before forking
     * @param \Closure(array<string, mixed>): void $onOtherRequest handles other requests that arrive mid-run
     * @param \Closure(): void $scope writes the kept session's variables (runs in the session child)
     */
    public function __construct(
        private readonly Protocol $protocol,
        private readonly \Closure $prepareChild,
        private readonly \Closure $execute,
        private readonly \Closure $closeConnections,
        private readonly \Closure $onOtherRequest,
        private readonly \Closure $scope,
    ) {
    }

    /** @param array<string, mixed> $run */
    public function runFresh(array $run): bool
    {
        $child = $this->fork(function ($channel) use ($run): void {
            $report = self::reporter($channel);
            ($this->execute)($run, static fn (int $stmt, int $line) => $report("s {$stmt} {$line}"));
            $report('done');
        });

        if ($child === null) {
            return false;
        }

        $this->supervise((string) $run['id'], $child, true);

        return true;
    }

    /** @param array<string, mixed> $run */
    public function runKept(array $run): bool
    {
        if (! $this->ensureSession()) {
            return false;
        }

        \fwrite($this->session['channel'], \json_encode(['type' => 'exec'] + $run) . "\n");
        \fflush($this->session['channel']);

        if (! $this->supervise((string) $run['id'], $this->session, false)) {
            $this->session = null;
        }

        return true;
    }

    /** Reports the kept session's variables, or an empty scope when there is none. */
    public function scope(string $id): void
    {
        if ($this->session === null) {
            $this->protocol->send(['type' => 'scope', 'id' => $id, 'vars' => [], 'truncated' => false]);

            return;
        }

        \fwrite($this->session['channel'], \json_encode(['type' => 'scope', 'id' => $id]) . "\n");
        \fflush($this->session['channel']);

        if (! $this->supervise($id, $this->session, false, true)) {
            $this->session = null;
        }
    }

    public function resetSession(): void
    {
        if ($this->session === null) {
            return;
        }

        \posix_kill($this->session['pid'], \SIGKILL);
        \pcntl_waitpid($this->session['pid'], $status);
        @\fclose($this->session['channel']);
        @\unlink($this->session['errorLog']);
        $this->session = null;
    }

    public function shutdown(): void
    {
        $this->resetSession();
    }

    private function ensureSession(): bool
    {
        if ($this->session !== null && \pcntl_waitpid($this->session['pid'], $status, \WNOHANG) === 0) {
            return true;
        }

        $this->session = $this->fork(function ($channel): void {
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

        return $this->session !== null;
    }

    /**
     * @param \Closure(resource): void $body
     * @return array{pid: int, channel: resource, errorLog: string}|null
     */
    private function fork(\Closure $body): ?array
    {
        ($this->closeConnections)();

        $pair = @\stream_socket_pair(\STREAM_PF_UNIX, \STREAM_SOCK_STREAM, \STREAM_IPPROTO_IP);
        $errorLog = @\tempnam(\sys_get_temp_dir(), 'opentinker-err-');

        if ($pair === false || $errorLog === false) {
            return null;
        }

        [$parentEnd, $childEnd] = $pair;
        $pid = \pcntl_fork();

        if ($pid === -1) {
            \fclose($parentEnd);
            \fclose($childEnd);
            @\unlink($errorLog);

            return null;
        }

        if ($pid === 0) {
            \fclose($parentEnd);

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

        return ['pid' => $pid, 'channel' => $parentEnd, 'errorLog' => $errorLog];
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
     * Waits for a child to finish the current request.
     *
     * @param array{pid: int, channel: resource, errorLog: string} $child
     * @return bool whether the child is still alive (kept sessions only)
     */
    private function supervise(string $id, array $child, bool $oneShot, bool $quiet = false): bool
    {
        $messages = '';
        $cancelled = false;
        $status = 0;
        $alive = true;
        $finished = false;

        while (true) {
            $messages .= (string) @\stream_get_contents($child['channel']);

            if (\preg_match('/^done$/m', $messages)) {
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
                \posix_kill($child['pid'], \SIGKILL);
                \pcntl_waitpid($child['pid'], $status);
                $this->resetSession();
                exit(0);
            }

            if (($request['type'] ?? null) === 'cancel') {
                $cancelled = true;
                \posix_kill($child['pid'], \SIGKILL);

                continue;
            }

            ($this->onOtherRequest)($request);
        }

        if (! $alive) {
            @\fclose($child['channel']);
        }

        $errors = \is_file($child['errorLog']) ? (string) @\file_get_contents($child['errorLog']) : '';

        if (! $alive) {
            @\unlink($child['errorLog']);
        } elseif ($errors !== '') {
            @\file_put_contents($child['errorLog'], '');
        }

        if ($finished || $quiet) {
            return $alive;
        }

        [$stmt, $line] = $this->lastStatement($messages);
        $sessionNote = $oneShot ? '' : ' The kept session was reset.';

        if ($cancelled) {
            $this->protocol->send(['type' => 'statement', 'id' => $id, 'stmt' => $stmt, 'line' => $line, 'endLine' => $line, 'ok' => false, 'ms' => 0, 'memory' => 0, 'exit' => 'Stopped']);
            $this->protocol->send(['type' => 'result', 'id' => $id, 'ok' => false, 'failed' => true, 'stopped' => true, 'statements' => $stmt, 'ms' => 0, 'memory' => 0, 'sessionReset' => ! $oneShot]);

            return false;
        }

        $fatal = $this->lastFatal($errors);
        $crash = \preg_match('/^crash (.*)$/m', $messages, $match) ? $match[1] : null;

        if ($fatal === null && $crash === null && \pcntl_wifexited($status)) {
            // exit()/die/dd() in app or vendor code ends the run like dd() in scratch.
            $this->protocol->send(['type' => 'statement', 'id' => $id, 'stmt' => $stmt, 'line' => $line, 'endLine' => $line, 'ok' => true, 'ms' => 0, 'memory' => 0, 'exit' => 'exit(' . \pcntl_wexitstatus($status) . ')' . $sessionNote]);
            $this->protocol->send(['type' => 'result', 'id' => $id, 'ok' => true, 'failed' => false, 'statements' => $stmt, 'ms' => 0, 'memory' => 0, 'ended' => 'exit', 'sessionReset' => ! $oneShot]);

            return false;
        }

        $signal = \pcntl_wifsignaled($status) ? ' (signal ' . \pcntl_wtermsig($status) . ')' : '';
        $message = ($fatal ?? $crash ?? "The run process ended unexpectedly{$signal}.") . $sessionNote;

        $this->protocol->send([
            'type' => 'error',
            'id' => $id,
            'stmt' => $stmt,
            'line' => $line,
            'ok' => false,
            'errorClass' => 'FatalError',
            'message' => $message,
            'scratchLine' => $line,
            'frames' => [],
            'ms' => 0,
        ]);
        $this->protocol->send(['type' => 'statement', 'id' => $id, 'stmt' => $stmt, 'line' => $line, 'endLine' => $line, 'ok' => false, 'ms' => 0, 'memory' => 0]);
        $this->protocol->send(['type' => 'result', 'id' => $id, 'ok' => false, 'failed' => true, 'statements' => $stmt, 'ms' => 0, 'memory' => 0, 'sessionReset' => ! $oneShot]);

        return false;
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
