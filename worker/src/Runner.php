<?php

declare(strict_types=1);

namespace OpenTinker;

use Psy\Shell;
use Throwable;

/**
 * Executes one run statement by statement, emitting a frame per result.
 *
 * The same Runner serves both session modes: in a fresh session it runs in a
 * forked child with a pristine shell; in a kept session it runs in the session
 * child and relies on ImportAliases to tolerate re-declared imports.
 */
final class Runner
{
    /** @var (callable(int, int): void)|null */
    private $onStatement = null;

    /** Fakes for the current run, when it asked for them. */
    private ?SideEffects $effects = null;

    public function __construct(
        private readonly Shell $shell,
        private readonly Protocol $protocol,
        private readonly DumpCapture $capture,
        private readonly SqlCollector $sql,
        private readonly ErrorFormatter $errors,
        private readonly ScopeReader $scope,
        private readonly ?\Psy\CodeCleaner $cleaner,
        private readonly bool $hasDatabase,
    ) {
    }

    /** Reports statement progress to a supervising parent process. */
    public function onStatement(?callable $callback): void
    {
        $this->onStatement = $callback;
    }

    /**
     * @param array{id: string, code: string, mode: string, imports: array<int, string>, rollback: bool, fresh: bool, fake?: bool} $run
     */
    public function run(array $run): void
    {
        $id = $run['id'];
        $code = $run['code'];
        $startedAt = \microtime(true);
        $stmtIndex = 0;
        $failed = false;
        $ended = null;

        $this->protocol->requestId = $id;
        $magic = $this->magicLines($code);
        $split = $run['mode'] === 'file' ? null : StatementSplitter::split($code);

        if (isset($split['error'])) {
            $this->protocol->send([
                'type' => 'error',
                'id' => $id,
                'stmt' => 0,
                'line' => $split['error']['line'],
                'ok' => false,
                'errorClass' => 'ParseError',
                'message' => 'Syntax error: ' . $split['error']['message'],
                'scratchLine' => $split['error']['line'],
                'frames' => [],
                'ms' => 0,
            ]);
            $this->finish($id, $startedAt, 0, true, null, null);

            return;
        }

        if ($split === null || ! $split['safe']) {
            $trimmed = \trim(SourceCode::stripOuterTags($code));
            $statements = $trimmed === '' ? [] : [['code' => $trimmed, 'line' => 1, 'import' => false]];
        } else {
            $statements = $split['statements'];
        }

        // Fake side effects promises that nothing is sent; without every fake in place, run nothing.
        $effects = null;

        if ($run['fake'] ?? false) {
            $effects = new SideEffects();

            try {
                if (! SideEffects::available()) {
                    throw new \RuntimeException('it needs Laravel');
                }

                $effects->install();
            } catch (Throwable $throwable) {
                $this->reportError($id, 0, 1, new \RuntimeException('Fake Side Effects could not fake mail, notifications, jobs and HTTP calls, so nothing was run: ' . $throwable->getMessage(), 0, $throwable), $startedAt);
                $this->finish($id, $startedAt, 0, true, null, null, false);

                return;
            }
        }

        $transaction = $run['rollback'] ? $this->beginTransaction() : null;
        $rolledBack = null;

        if (\is_string($transaction)) {
            $effects?->restore();
            // Rollback mode promises that nothing is saved; without a transaction, run nothing.
            $this->reportError($id, 0, 1, new \RuntimeException("Rollback mode could not start a database transaction, so nothing was run: {$transaction}"), $startedAt);
            $this->finish($id, $startedAt, 0, true, null, null);

            return;
        }

        $this->effects = $effects;

        try {
            foreach ($run['imports'] as $import) {
                if (! FileImports::valid($import)) {
                    $this->reportError($id, 0, 1, new \InvalidArgumentException('Invalid file import'), $startedAt);
                    $failed = true;
                    break;
                }

                try {
                    $this->execute($import, $run['fresh']);
                } catch (Throwable $throwable) {
                    $this->reportError($id, 0, 1, new \RuntimeException("Could not apply file import {$import}: " . $throwable->getMessage(), 0, $throwable), $startedAt);
                    $failed = true;
                    break;
                }
            }

            foreach ($failed ? [] : $statements as $statement) {
                $stmtIndex++;
                $line = $statement['line'];
                $this->protocol->stmt = $stmtIndex;
                $this->protocol->line = $line;
                $this->capture->setLine($line);
                $this->capture->resetCount();
                $this->sql->reset();
                ExitCalledException::$raised = null;

                if ($this->onStatement !== null) {
                    ($this->onStatement)($stmtIndex, $line);
                }

                $statementStart = \microtime(true);

                try {
                    if ($statement['import']) {
                        $this->execute($statement['code'], $run['fresh']);
                        $this->protocol->send($this->statementFrame($id, $stmtIndex, $line, true, $statementStart, null, true));

                        continue;
                    }

                    $value = $this->execute(TokenRewriter::rewrite($statement['code']), $run['fresh']);

                    // A dd() or exit that the scratch code caught itself still ends the run.
                    if (ExitCalledException::$raised !== null) {
                        throw ExitCalledException::$raised;
                    }

                    if (\class_exists(\Psy\CodeCleaner\NoReturnValue::class, false) && $value instanceof \Psy\CodeCleaner\NoReturnValue) {
                        $value = null;
                    }

                    $this->inspect($id, $stmtIndex, $line, $statement['code'], $value, $magic);

                    // Rendering never throws: a value whose own code fails to
                    // display must not turn a statement that worked into an error.
                    $short = null;

                    if ($value !== null && $this->capture->count() === 0) {
                        $short = Values::short($value);
                        $this->protocol->send([
                            'type' => 'value',
                            'id' => $id,
                            'stmt' => $stmtIndex,
                            'line' => $line,
                            'short' => $short,
                            'html' => $this->capture->capture($value),
                        ] + Values::structured($value));
                    }

                    // Let go of the value now: a returned PendingDispatch dispatches
                    // when released, and that belongs to this statement.
                    $value = null;

                    $this->protocol->send($this->statementFrame(
                        $id,
                        $stmtIndex,
                        $line,
                        true,
                        $statementStart,
                        null,
                        false,
                        $short,
                        $line + \substr_count(\rtrim($statement['code']), "\n"),
                    ));
                } catch (ExitCalledException $exception) {
                    $ended = $exception->kind;
                    $message = $exception->getMessage() !== '' ? $exception->getMessage() : 'exit()';
                    $this->protocol->send($this->statementFrame($id, $stmtIndex, $line, true, $statementStart, $message));
                    break;
                } catch (Throwable $throwable) {
                    $this->reportError($id, $stmtIndex, $line, $throwable, $statementStart);
                    $failed = true;
                    break;
                }
            }
        } finally {
            if (\is_array($transaction)) {
                $rolledBack = $this->rollBack($transaction);
            }

            $this->effects?->restore();
            $this->effects = null;
        }

        $this->protocol->stmt = 0;
        $this->protocol->line = null;
        $this->capture->setLine(null);

        $scope = $this->scope->read($this->shell);
        $this->protocol->send(['type' => 'scope', 'id' => $id] + $scope);

        $this->finish($id, $startedAt, $stmtIndex, $failed, $rolledBack, $ended, $effects !== null ? true : null);
    }

    private function execute(string $code, bool $fresh): mixed
    {
        // A fresh shell has no earlier imports; a kept session must skip them.
        if (! $fresh && $this->cleaner !== null) {
            $code = ImportAliases::withoutKnown($this->cleaner, $code);
        }

        if (\trim($code) === '') {
            return null;
        }

        return $this->shell->execute($code, true);
    }

    private function finish(string $id, float $startedAt, int $statements, bool $failed, ?bool $rolledBack, ?string $ended, ?bool $faked = null): void
    {
        $this->protocol->requestId = null;
        $this->protocol->send([
            'type' => 'result',
            'id' => $id,
            'ok' => ! $failed,
            'failed' => $failed,
            'statements' => $statements,
            'ms' => \round((\microtime(true) - $startedAt) * 1000, 2),
            'memory' => \memory_get_peak_usage(true),
            'rolledBack' => $rolledBack,
            'faked' => $faked,
            'ended' => $ended,
        ]);
    }

    /**
     * Starts the rollback transaction on the default connection.
     *
     * @return array{connection: \Illuminate\Database\ConnectionInterface, level: int}|string|null
     *         the transaction, why it could not start, or null when there is no database
     */
    private function beginTransaction(): array|string|null
    {
        if (! $this->hasDatabase) {
            return null;
        }

        try {
            $connection = \Illuminate\Support\Facades\DB::connection();
            $connection->beginTransaction();

            return ['connection' => $connection, 'level' => $connection->transactionLevel()];
        } catch (Throwable $throwable) {
            return $throwable->getMessage();
        }
    }

    /**
     * Rolls back to where the run started, on the connection it started on.
     * False when that cannot be promised: the run ended the transaction itself
     * (DB::commit(), a disconnect) or the database committed it implicitly.
     *
     * @param array{connection: \Illuminate\Database\ConnectionInterface, level: int} $transaction
     */
    private function rollBack(array $transaction): bool
    {
        ['connection' => $connection, 'level' => $level] = $transaction;
        $lost = '[opentinker] The run ended the rollback transaction itself (for example with DB::commit(), or a schema change on MySQL), so its changes may have been saved.' . "\n";

        try {
            $pdo = \method_exists($connection, 'getPdo') ? $connection->getPdo() : null;

            if ($connection->transactionLevel() < $level || ($pdo instanceof \PDO && ! $pdo->inTransaction())) {
                $this->protocol->output($lost);

                return false;
            }

            $connection->rollBack($level - 1);

            return true;
        } catch (Throwable $throwable) {
            $this->protocol->output('[opentinker] Rollback failed: ' . $throwable->getMessage() . "\n");

            return false;
        }
    }

    /** @param array<int, string> $magic */
    private function inspect(string $id, int $stmt, int $line, string $code, mixed $value, array $magic): void
    {
        $inspectionLine = $line + \substr_count(\rtrim($code), "\n");

        if (! \array_key_exists($inspectionLine, $magic)) {
            return;
        }

        $inspected = $value;
        $variable = $magic[$inspectionLine];

        if ($variable !== '') {
            try {
                $inspected = $this->shell->getScopeVariables(false)[$variable] ?? $value;
            } catch (Throwable) {
                // The expression value remains available as a fallback.
            }
        }

        $this->protocol->send([
            'type' => 'inline',
            'id' => $id,
            'stmt' => $stmt,
            'line' => $inspectionLine,
            'text' => Values::short($inspected),
            'html' => $this->capture->capture($inspected),
        ]);
    }

    /** @return array<int, string> */
    public function magicLines(string $code): array
    {
        $lines = \explode("\n", $code);
        $markers = [];

        foreach (\token_get_all(SourceCode::PARSE_PREFIX . SourceCode::stripOuterTags($code)) as $token) {
            if (! \is_array($token) || $token[0] !== \T_COMMENT || \trim($token[1]) !== '//?') {
                continue;
            }

            $line = $token[2];
            $before = \explode('//?', $lines[$line - 1] ?? '', 2)[0];
            $variable = '';

            if (\preg_match('/^\s*(\$[A-Za-z_][A-Za-z0-9_]*)\s*(?:=|\+=|-=|\.=)/', $before, $match)) {
                $variable = \substr($match[1], 1);
            }

            $markers[$line] = $variable;
        }

        return $markers;
    }

    private function reportError(string $id, int $stmt, int $line, Throwable $throwable, float $startedAt): void
    {
        $this->protocol->send([
            'type' => 'error',
            'id' => $id,
            'stmt' => $stmt,
            'line' => $line,
            'ok' => false,
            'ms' => \round((\microtime(true) - $startedAt) * 1000, 2),
        ] + $this->errors->describe($throwable, $line));

        $this->protocol->send($this->statementFrame($id, $stmt, $line, false, $startedAt));
    }

    /** @return array<string, mixed> */
    private function statementFrame(
        string $id,
        int $stmt,
        int $line,
        bool $ok,
        float $startedAt,
        ?string $exit = null,
        bool $import = false,
        ?string $short = null,
        ?int $endLine = null,
    ): array {
        $frame = [
            'type' => 'statement',
            'id' => $id,
            'stmt' => $stmt,
            'line' => $line,
            'endLine' => $endLine ?? $line,
            'ok' => $ok,
            'ms' => \round((\microtime(true) - $startedAt) * 1000, 2),
            'memory' => \memory_get_usage(true),
            'queries' => $this->sql->all(),
            'sql' => $this->sql->summary(),
        ];

        $sideEffects = $this->effects?->collect() ?? [];

        if ($sideEffects !== []) $frame['sideEffects'] = $sideEffects;
        if ($exit !== null) $frame['exit'] = $exit;
        if ($import) $frame['import'] = true;
        if ($short !== null) $frame['short'] = $short;

        return $frame;
    }
}
