<?php

declare(strict_types=1);

namespace OpenTinker;

use Psy\Shell;
use Throwable;

/**
 * Executes one run statement by statement, emitting a frame per result.
 *
 * The same Runner serves both session modes: in a fresh session it runs in a
 * forked child with a pristine shell; in a kept session it runs in the worker
 * process and relies on ImportAliases to tolerate re-declared imports.
 */
final class Runner
{
    /** @var (callable(int, int): void)|null */
    private $onStatement = null;

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
     * @param array{id: string, code: string, mode: string, imports: array<int, string>, rollback: bool, fresh: bool} $run
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

        $rolledBack = $run['rollback'] ? $this->beginTransaction() : null;

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
                $this->capture->setLineContext($line, 0);
                $this->capture->resetCount();
                $this->sql->reset();

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

                    if (\class_exists(\Psy\CodeCleaner\NoReturnValue::class, false) && $value instanceof \Psy\CodeCleaner\NoReturnValue) {
                        $value = null;
                    }

                    $this->inspect($id, $stmtIndex, $line, $statement['code'], $value, $magic);

                    $showValue = $value !== null && $this->capture->count() === 0;
                    if ($showValue) {
                        $this->protocol->send([
                            'type' => 'value',
                            'id' => $id,
                            'stmt' => $stmtIndex,
                            'line' => $line,
                            'short' => Values::short($value),
                            'html' => $this->capture->capture($value),
                        ] + Values::structured($value));
                    }

                    $this->protocol->send($this->statementFrame(
                        $id,
                        $stmtIndex,
                        $line,
                        true,
                        $statementStart,
                        null,
                        false,
                        $showValue ? Values::short($value) : null,
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
            if ($rolledBack === true) {
                $rolledBack = $this->rollBack();
            }
        }

        $this->protocol->stmt = 0;
        $this->protocol->line = null;
        $this->capture->setLineContext(null, 0);

        $scope = $this->scope->read($this->shell);
        $this->protocol->send(['type' => 'scope', 'id' => $id] + $scope);

        $this->finish($id, $startedAt, $stmtIndex, $failed, $rolledBack, $ended);
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

    private function finish(string $id, float $startedAt, int $statements, bool $failed, ?bool $rolledBack, ?string $ended): void
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
            'ended' => $ended,
        ]);
    }

    /** Starts a transaction to roll back; null when there is no database to protect. */
    private function beginTransaction(): ?bool
    {
        if (! $this->hasDatabase) {
            return null;
        }

        try {
            \Illuminate\Support\Facades\DB::connection()->beginTransaction();

            return true;
        } catch (Throwable $throwable) {
            $this->protocol->output('[opentinker] Could not start a rollback transaction: ' . $throwable->getMessage() . "\n");

            return null;
        }
    }

    private function rollBack(): bool
    {
        try {
            $connection = \Illuminate\Support\Facades\DB::connection();

            while ($connection->transactionLevel() > 0) {
                $connection->rollBack();
            }

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

        if ($exit !== null) $frame['exit'] = $exit;
        if ($import) $frame['import'] = true;
        if ($short !== null) $frame['short'] = $short;

        return $frame;
    }
}
