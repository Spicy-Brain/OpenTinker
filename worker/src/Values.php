<?php

declare(strict_types=1);

namespace OpenTinker;

use Throwable;

/**
 * Structured views of a result value for the results panel: tables, HTML
 * previews, Eloquent model cards and copy formats. Every view is optional and
 * bounded; a failure in one never blocks the plain dump.
 *
 * Generators, lazy collections, cursors and other iterators are never counted
 * or iterated here: that would run their source (a database cursor, an
 * endless generator) and use them up before the scratch code gets to.
 */
final class Values
{
    private const MAX_ROWS = 500;
    private const MAX_COLUMNS = 30;
    private const MAX_CELL = 2000;
    private const MAX_TABLE_BYTES = 500_000;
    private const MAX_COPY_BYTES = 200_000;
    private const MAX_PREVIEW_BYTES = 200_000;
    private const SHORT_WIDTH = 120;

    /** @return array<string, mixed> */
    public static function structured(mixed $value): array
    {
        $result = [];

        foreach ([
            'table' => fn () => self::table($value),
            'preview' => fn () => self::preview($value),
            'model' => fn () => self::model($value),
            'copy' => fn () => self::copyFormats($value),
        ] as $key => $build) {
            try {
                $view = $build();
            } catch (Throwable) {
                $view = null;
            }

            if ($view !== null && $view !== []) {
                $result[$key] = $view;
            }
        }

        return $result;
    }

    /** A one-line summary. Never throws, even when the value's own code does. */
    public static function short(mixed $value): string
    {
        try {
            return self::summarise($value);
        } catch (Throwable) {
            return \get_debug_type($value);
        }
    }

    /**
     * Iterators whose items are not all in memory yet: counting, iterating or
     * casting them to a string would run their source.
     */
    public static function isLazy(mixed $value): bool
    {
        return $value instanceof \Illuminate\Support\LazyCollection
            || ($value instanceof \Traversable && ! self::isEager($value));
    }

    /** @return array{columns: array<int, string>, rows: array<int, array<int, string>>, truncated: bool}|null */
    public static function table(mixed $value): ?array
    {
        if ($value instanceof \Illuminate\Support\Collection) {
            $value = $value->all();
        }

        if (! \is_array($value) || ! \array_is_list($value) || $value === []) {
            return null;
        }

        $rows = [];
        $columns = [];

        foreach (\array_slice($value, 0, self::MAX_ROWS) as $item) {
            if (self::isLazy($item)) {
                return null;
            }

            if ($item instanceof \Illuminate\Contracts\Support\Arrayable) {
                $item = $item->toArray();
            } elseif (\is_object($item) && ! $item instanceof \JsonSerializable) {
                $item = \get_object_vars($item);
            }

            if (! \is_array($item) || \array_is_list($item)) {
                return null;
            }

            $rows[] = $item;

            foreach (\array_keys($item) as $column) {
                $column = (string) $column;

                if (! \in_array($column, $columns, true) && \count($columns) < self::MAX_COLUMNS) {
                    $columns[] = $column;
                }
            }
        }

        if ($columns === []) {
            return null;
        }

        $displayRows = [];
        $bytes = 0;
        $truncated = \count($value) > self::MAX_ROWS;

        foreach ($rows as $item) {
            $display = [];

            foreach ($columns as $column) {
                $cell = \substr(self::cell($item[$column] ?? null), 0, self::MAX_CELL);
                $bytes += \strlen($cell);
                $display[] = $cell;
            }

            if ($bytes > self::MAX_TABLE_BYTES) {
                $truncated = true;
                break;
            }

            $displayRows[] = $display;
        }

        return ['columns' => $columns, 'rows' => $displayRows, 'truncated' => $truncated];
    }

    /** @return array{html: string, kind: string}|null */
    public static function preview(mixed $value): ?array
    {
        if ($value instanceof \Illuminate\Mail\Mailable) {
            $html = $value->render();
            $kind = 'mailable';
        } elseif ($value instanceof \Illuminate\Http\Client\Response
            && \str_contains(\strtolower((string) $value->header('Content-Type')), 'text/html')) {
            $html = $value->body();
            $kind = 'response';
        } elseif (\is_string($value) && \strlen($value) <= self::MAX_PREVIEW_BYTES
            && \preg_match('/\A\s*<(!doctype|html|body|div|p|table|h[1-6]|span|section|main|ul)\b/i', $value)) {
            $html = $value;
            $kind = 'html';
        } elseif ($value instanceof \Illuminate\Contracts\Support\Htmlable) {
            $html = $value->toHtml();
            $kind = 'html';
        } else {
            return null;
        }

        if (! \is_string($html) || \strlen($html) > self::MAX_PREVIEW_BYTES) {
            return null;
        }

        return ['html' => $html, 'kind' => $kind];
    }

    /**
     * A readable card for an Eloquent model: key, attributes with casts,
     * loaded relations and unsaved changes.
     *
     * @return array<string, mixed>|null
     */
    public static function model(mixed $value): ?array
    {
        if (! self::isModel($value)) {
            return null;
        }

        $casts = $value->getCasts();
        $hidden = $value->getHidden();
        $dirty = \array_keys($value->getDirty());
        $attributes = [];

        foreach ($value->getAttributes() as $name => $raw) {
            $attributes[] = [
                'name' => (string) $name,
                'value' => \substr(self::cell($raw), 0, 500),
                'type' => \get_debug_type($raw),
                'cast' => isset($casts[$name]) ? (\is_string($casts[$name]) ? $casts[$name] : \get_debug_type($casts[$name])) : null,
                'hidden' => \in_array($name, $hidden, true),
                'dirty' => \in_array($name, $dirty, true),
            ];

            if (\count($attributes) >= 200) {
                break;
            }
        }

        $relations = [];

        foreach ($value->getRelations() as $name => $related) {
            if ($related instanceof \Illuminate\Support\Collection) {
                $summary = $related->count() . ' × ' . ($related->first() !== null ? \class_basename($related->first()) : 'item');
            } elseif ($related === null) {
                $summary = 'null';
            } else {
                $summary = self::short($related);
            }

            $relations[] = ['name' => (string) $name, 'summary' => $summary];
        }

        $key = $value->getKey();

        return [
            'class' => $value::class,
            'key' => \is_scalar($key) ? (string) $key : null,
            'keyName' => $value->getKeyName(),
            'table' => $value->getTable(),
            'exists' => $value->exists,
            'recentlyCreated' => $value->wasRecentlyCreated,
            'attributes' => $attributes,
            'relations' => $relations,
            'dirty' => $dirty,
        ];
    }

    /**
     * JSON and PHP renderings, skipped (not truncated) when the value is too
     * large to be worth copying.
     *
     * @return array{json?: string, php?: string}
     */
    public static function copyFormats(mixed $value): array
    {
        if ($value === null || \is_resource($value)) {
            return [];
        }

        $budget = self::MAX_COPY_BYTES;

        try {
            $normalized = self::normalize($value, 0, $budget);
        } catch (\LengthException) {
            return [];
        }

        $formats = [];

        $json = \json_encode($normalized, \JSON_PRETTY_PRINT | \JSON_UNESCAPED_SLASHES | \JSON_UNESCAPED_UNICODE | \JSON_INVALID_UTF8_SUBSTITUTE | \JSON_PARTIAL_OUTPUT_ON_ERROR);
        if (\is_string($json) && \strlen($json) <= self::MAX_COPY_BYTES) {
            $formats['json'] = $json;
        }

        $php = self::export($normalized, 0);
        if (\strlen($php) <= self::MAX_COPY_BYTES) {
            $formats['php'] = $php;
        }

        return $formats;
    }

    public static function isModel(mixed $value): bool
    {
        return \class_exists(\Illuminate\Database\Eloquent\Model::class, false)
            && $value instanceof \Illuminate\Database\Eloquent\Model;
    }

    private static function summarise(mixed $value): string
    {
        if ($value === null) return 'null';
        if (\is_bool($value)) return $value ? 'true' : 'false';
        if (\is_string($value)) return self::clip($value);
        if (\is_scalar($value)) return (string) $value;
        if (\is_array($value)) return 'array(' . \count($value) . ')';

        if (self::isModel($value)) {
            $key = $value->getKey();

            return \class_basename($value) . ($key !== null && \is_scalar($key) ? ' #' . $key : '');
        }

        if (self::isLazy($value)) {
            return \get_debug_type($value);
        }

        if ($value instanceof \Countable) {
            return \get_debug_type($value) . '(' . \count($value) . ')';
        }

        if ($value instanceof \Stringable) {
            return self::clip((string) $value);
        }

        return \get_debug_type($value);
    }

    /** One line of at most SHORT_WIDTH columns, without copying a huge string first. */
    private static function clip(string $text): string
    {
        $line = \str_replace(["\r", "\n"], ['', '↵'], \substr($text, 0, self::SHORT_WIDTH * 8));

        return \mb_strimwidth($line, 0, self::SHORT_WIDTH, '…');
    }

    /** Containers that already hold all their items, so iterating them runs no source. */
    private static function isEager(object $value): bool
    {
        return $value instanceof \Illuminate\Support\Collection
            || $value instanceof \Illuminate\Pagination\AbstractPaginator
            || $value instanceof \Illuminate\Pagination\AbstractCursorPaginator
            || $value instanceof \ArrayObject
            || $value instanceof \ArrayIterator
            || $value instanceof \SplFixedArray
            || $value instanceof \SplObjectStorage
            || $value instanceof \SplDoublyLinkedList;
    }

    private static function cell(mixed $value): string
    {
        if ($value === null) return 'null';
        if (\is_bool($value)) return $value ? 'true' : 'false';
        if (\is_scalar($value)) return (string) $value;
        if ($value instanceof \DateTimeInterface) return $value->format('Y-m-d H:i:s');
        if ($value instanceof \BackedEnum) return (string) $value->value;
        if ($value instanceof \UnitEnum) return $value->name;
        if (self::isLazy($value)) return \get_debug_type($value);
        if ($value instanceof \Stringable) return (string) $value;

        return \json_encode($value, \JSON_UNESCAPED_UNICODE | \JSON_INVALID_UTF8_SUBSTITUTE | \JSON_PARTIAL_OUTPUT_ON_ERROR) ?: \get_debug_type($value);
    }

    /**
     * Plain data for the copy formats. $budget counts down the bytes kept;
     * running out throws, since a partial copy would be misleading.
     */
    private static function normalize(mixed $value, int $depth, int &$budget): mixed
    {
        $budget -= \is_string($value) ? \strlen($value) : 8;

        if ($budget < 0) throw new \LengthException();
        if ($depth > 8) return '…';
        if ($value === null || \is_scalar($value)) return $value;
        if ($value instanceof \DateTimeInterface) return $value->format(\DATE_ATOM);
        if ($value instanceof \BackedEnum) return $value->value;
        if ($value instanceof \UnitEnum) return $value->name;
        if (\is_resource($value) || $value instanceof \Illuminate\Support\LazyCollection) return \get_debug_type($value);

        if ($value instanceof \Illuminate\Contracts\Support\Arrayable) {
            $value = $value->toArray();
        } elseif ($value instanceof \JsonSerializable) {
            $value = $value->jsonSerialize();
        } elseif ($value instanceof \Traversable) {
            if (! self::isEager($value)) {
                return \get_debug_type($value);
            }

            $value = \iterator_to_array($value);
        } elseif (\is_object($value)) {
            $vars = \get_object_vars($value);

            if ($vars === [] && $value instanceof \Stringable) {
                return (string) $value;
            }

            $value = $vars === [] ? \get_debug_type($value) : $vars;
        }

        if (! \is_array($value)) {
            return self::normalize($value, $depth + 1, $budget);
        }

        $result = [];
        $count = 0;

        foreach ($value as $key => $item) {
            if (++$count > 1000) {
                $result['…'] = 'truncated';
                break;
            }

            $budget -= \strlen((string) $key);
            $result[$key] = self::normalize($item, $depth + 1, $budget);
        }

        return $result;
    }

    /** var_export with short array syntax and stable indentation. */
    private static function export(mixed $value, int $depth): string
    {
        if (! \is_array($value)) {
            return \var_export($value, true);
        }

        if ($value === []) {
            return '[]';
        }

        $pad = \str_repeat('    ', $depth + 1);
        $list = \array_is_list($value);
        $lines = [];

        foreach ($value as $key => $item) {
            $prefix = $list ? '' : \var_export($key, true) . ' => ';
            $lines[] = $pad . $prefix . self::export($item, $depth + 1) . ',';
        }

        return "[\n" . \implode("\n", $lines) . "\n" . \str_repeat('    ', $depth) . ']';
    }
}
