<?php

declare(strict_types=1);

namespace OpenTinker;

/**
 * Collects SQL executed while a statement runs. Keeps the first queries in
 * full and counts every query by shape, so repeated queries (a likely N+1)
 * are reported even when there are too many to list.
 */
final class SqlCollector
{
    private const MAX_LISTED = 100;

    /** Bulk inserts and binary bindings can be huge; frames only need enough to recognise them. */
    private const MAX_SQL = 10_000;
    private const MAX_BINDINGS = 100;
    private const MAX_BINDING = 1_000;
    private const MAX_SHAPES = 1_000;

    /** @var array<int, array{sql: string, bindings: array<int, string>, time: float|null}> */
    private array $queries = [];

    /** @var array<string, int> */
    private array $shapes = [];

    private int $total = 0;

    private float $time = 0.0;

    private bool $registered = false;

    public function register(): void
    {
        if ($this->registered
            || ! \class_exists(\Illuminate\Support\Facades\DB::class)
            || ! \function_exists('app')
            || ! \app()->bound('db')) {
            return;
        }

        try {
            \Illuminate\Support\Facades\DB::listen(function ($query): void {
                $sql = \substr((string) $query->sql, 0, self::MAX_SQL);
                $this->total++;
                $this->time += isset($query->time) ? (float) $query->time : 0.0;

                if (isset($this->shapes[$sql]) || \count($this->shapes) < self::MAX_SHAPES) {
                    $this->shapes[$sql] = ($this->shapes[$sql] ?? 0) + 1;
                }

                if (\count($this->queries) >= self::MAX_LISTED) {
                    return;
                }

                $bindings = [];

                foreach (\array_slice((array) $query->bindings, 0, self::MAX_BINDINGS) as $binding) {
                    if (\is_scalar($binding) || $binding === null) {
                        $bindings[] = \substr((string) ($binding ?? 'null'), 0, self::MAX_BINDING);
                    } elseif ($binding instanceof \DateTimeInterface) {
                        $bindings[] = $binding->format('Y-m-d H:i:s');
                    } else {
                        $bindings[] = \get_debug_type($binding);
                    }
                }

                $this->queries[] = [
                    'sql' => $sql,
                    'bindings' => $bindings,
                    'time' => isset($query->time) ? (float) $query->time : null,
                ];
            });

            $this->registered = true;
        } catch (\Throwable) {
            // Database is not available; queries simply won't be reported.
        }
    }

    public function reset(): void
    {
        $this->queries = [];
        $this->shapes = [];
        $this->total = 0;
        $this->time = 0.0;
    }

    /** @return array<int, array{sql: string, bindings: array<int, string>, time: float|null}> */
    public function all(): array
    {
        return $this->queries;
    }

    /** @return array{total: int, time: float, repeated: array<int, array{sql: string, count: int}>} */
    public function summary(): array
    {
        $repeated = [];

        foreach ($this->shapes as $sql => $count) {
            if ($count >= 3) {
                $repeated[] = ['sql' => $sql, 'count' => $count];
            }
        }

        \usort($repeated, fn (array $a, array $b): int => $b['count'] <=> $a['count']);

        return ['total' => $this->total, 'time' => \round($this->time, 2), 'repeated' => \array_slice($repeated, 0, 5)];
    }
}
