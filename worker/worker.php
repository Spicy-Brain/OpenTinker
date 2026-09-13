<?php

declare(strict_types=1);

/*
 * OpenTinker worker.
 *
 * Boots the host Laravel application, embeds a persistent PsySH shell and
 * speaks newline-delimited JSON over stdin/stdout with the VS Code extension.
 *
 * This file is delivered to the runtime by the extension (docker cp or local
 * storage), so it must not require any dependencies beyond the host app's
 * vendor/ directory.
 */

namespace OpenTinker;

use Illuminate\Support\Facades\DB;
use Psy\Configuration;
use Psy\Output\ShellOutput;
use Psy\Shell;
use Symfony\Component\VarDumper\Cloner\VarCloner;
use Symfony\Component\VarDumper\Dumper\HtmlDumper;
use Symfony\Component\VarDumper\VarDumper;
use Throwable;

final class ExitCalledException extends \RuntimeException
{
}

/**
 * Newline-delimited JSON protocol handler.
 */
final class Protocol
{
    /** Statement index of the currently executing statement. */
    public int $stmt = 0;

    /** Source line of the currently executing statement. */
    public ?int $line = null;

    /** Request id of the currently executing snippet. */
    public ?string $requestId = null;

    /** @var resource */
    private $stdin;

    /** @var resource */
    private $stdout;

    public function __construct()
    {
        $this->stdin = \fopen('php://stdin', 'rb');
        $this->stdout = \fopen('php://stdout', 'wb');
    }

    /**
     * @param array<string, mixed> $frame
     */
    public function send(array $frame): void
    {
        $encoded = \json_encode(
            $frame,
            \JSON_UNESCAPED_SLASHES | \JSON_UNESCAPED_UNICODE | \JSON_INVALID_UTF8_SUBSTITUTE
        );

        if ($encoded === false) {
            $encoded = \json_encode(['type' => 'fatal', 'message' => 'Failed to encode frame']);
        }

        \fwrite($this->stdout, $encoded . "\n");
        \fflush($this->stdout);
    }

    /**
     * @return array<string, mixed>|null
     */
    public function read(): ?array
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
                $this->send(['type' => 'output', 'text' => "[unparsable frame] {$line}\n"]);

                continue;
            }

            /** @var array<string, mixed> $decoded */
            return $decoded;
        }
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

/**
 * Rewrites constructs that would terminate the worker process.
 *
 * - dd(...) becomes dump(...) so execution continues.
 * - exit/die become a catchable ExitCalledException.
 */
final class TokenRewriter
{
    public static function rewrite(string $code): string
    {
        $code = \str_replace(['<?php', '?>'], '', $code);

        if (\trim($code) === '') {
            return 'return null;';
        }

        $tokens = \token_get_all('<?php ' . $code);

        // Drop the synthetic opening tag.
        \array_shift($tokens);

        $output = '';
        $count = \count($tokens);

        for ($i = 0; $i < $count; $i++) {
            $token = $tokens[$i];

            if (\is_array($token) && $token[0] === \T_EXIT) {
                [$expression, $lastIndex] = self::consumeExitExpression($tokens, $i + 1);
                $message = $expression === null ? "''" : '(string) (' . $expression . ')';
                $output .= 'throw new \\OpenTinker\\ExitCalledException(' . $message . ')';
                $i = $lastIndex;

                continue;
            }

            if (\is_array($token) && self::isDdCall($tokens, $i)) {
                $output .= \str_starts_with($token[1], '\\') ? '\\dump' : 'dump';

                continue;
            }

            $output .= \is_array($token) ? $token[1] : $token;
        }

        return $output;
    }

    /**
     * @param array<int, array{0: int, 1: string, 2: int}|string> $tokens
     * @return array{0: string|null, 1: int}
     */
    private static function consumeExitExpression(array $tokens, int $start): array
    {
        $count = \count($tokens);
        $i = $start;

        while ($i < $count && \is_array($tokens[$i]) && $tokens[$i][0] === \T_WHITESPACE) {
            $i++;
        }

        if ($i >= $count) {
            return [null, $i - 1];
        }

        if ($tokens[$i] === '(') {
            $depth = 0;
            $expression = '';

            for (; $i < $count; $i++) {
                $text = \is_array($tokens[$i]) ? $tokens[$i][1] : $tokens[$i];

                if ($text === '(') {
                    $depth++;

                    if ($depth === 1) {
                        continue;
                    }
                } elseif ($text === ')') {
                    $depth--;

                    if ($depth === 0) {
                        break;
                    }
                }

                $expression .= $text;
            }

            return [$expression === '' ? "''" : $expression, $i];
        }

        if ($tokens[$i] === ';') {
            return [null, $i - 1];
        }

        // Legacy syntax: exit "message";
        $expression = '';
        $depth = 0;

        for (; $i < $count; $i++) {
            $text = \is_array($tokens[$i]) ? $tokens[$i][1] : $tokens[$i];

            if ($text === ';' && $depth === 0) {
                break;
            }

            if (\in_array($text, ['(', '[', '{'], true)) {
                $depth++;
            } elseif (\in_array($text, [')', ']', '}'], true)) {
                $depth--;
            }

            $expression .= $text;
        }

        return [\trim($expression) === '' ? "''" : $expression, $i - 1];
    }

    /**
     * @param array<int, array{0: int, 1: string, 2: int}|string> $tokens
     */
    private static function isDdCall(array $tokens, int $index): bool
    {
        $token = $tokens[$index];

        if (! \is_array($token)) {
            return false;
        }

        $isName = \in_array($token[0], [\T_STRING, \T_NAME_FULLY_QUALIFIED, \T_NAME_QUALIFIED], true);

        if (! $isName || \ltrim($token[1], '\\') !== 'dd') {
            return false;
        }

        $count = \count($tokens);

        for ($i = $index + 1; $i < $count; $i++) {
            if (\is_array($tokens[$i]) && $tokens[$i][0] === \T_WHITESPACE) {
                continue;
            }

            return $tokens[$i] === '(';
        }

        return false;
    }
}

/**
 * Splits a scratch file into top-level statements so each can be executed and
 * rendered as its own card, Tinkerwell style.
 */
final class StatementSplitter
{
    /**
     * @return array{safe: bool, statements: array<int, array{code: string, line: int, import: bool}>}
     */
    public static function split(string $code): array
    {
        if (\str_contains($code, '<?=')) {
            return self::wholeFile($code);
        }

        $code = \str_replace(['<?php', '?>'], '', $code);

        if (\trim($code) === '') {
            return ['safe' => true, 'statements' => []];
        }

        $tokens = \token_get_all('<?php ' . $code);
        \array_shift($tokens);

        $unsafe = [\T_ENDIF, \T_ENDFOR, \T_ENDFOREACH, \T_ENDWHILE, \T_ENDSWITCH, \T_ENDDECLARE, \T_INLINE_HTML, \T_HALT_COMPILER, \T_OPEN_TAG_WITH_ECHO, \T_DECLARE];

        foreach ($tokens as $token) {
            if (\is_array($token) && \in_array($token[0], $unsafe, true)) {
                return self::wholeFile($code);
            }
        }

        $statements = [];
        $buffer = '';
        $startLine = null;
        $lastLine = 1;
        $depth = 0;
        $isImport = false;

        foreach ($tokens as $token) {
            $text = \is_array($token) ? $token[1] : $token;

            if (\is_array($token)) {
                $lastLine = $token[2];
            }

            if ($startLine === null) {
                if (\is_array($token) && \in_array($token[0], [\T_WHITESPACE, \T_COMMENT, \T_DOC_COMMENT], true)) {
                    continue;
                }

                $startLine = $lastLine;
                $isImport = \is_array($token) && $token[0] === \T_USE;

                if (\is_array($token) && $token[0] === \T_NAMESPACE) {
                    return self::wholeFile($code);
                }
            }

            $buffer .= $text;

            if ($text === '{') {
                $depth++;
            } elseif ($text === '}') {
                $depth--;

                if ($depth <= 0) {
                    $statements[] = self::statement($buffer, $startLine, $isImport);
                    $buffer = '';
                    $startLine = null;
                    $isImport = false;
                    $depth = 0;
                }
            } elseif ($text === ';' && $depth === 0) {
                $statements[] = self::statement($buffer, $startLine, $isImport);
                $buffer = '';
                $startLine = null;
                $isImport = false;
            }
        }

        if ($startLine !== null && \trim($buffer) !== '') {
            $statements[] = self::statement($buffer, $startLine, $isImport);
        }

        return ['safe' => true, 'statements' => $statements];
    }

    /**
     * @return array{safe: bool, statements: array<int, array{code: string, line: int, import: bool}>}
     */
    private static function wholeFile(string $code): array
    {
        return [
            'safe' => false,
            'statements' => [['code' => \trim($code), 'line' => 1, 'import' => false]],
        ];
    }

    /**
     * @return array{code: string, line: int, import: bool}
     */
    private static function statement(string $code, ?int $line, bool $import): array
    {
        return ['code' => $code, 'line' => $line ?? 1, 'import' => $import];
    }
}

/**
 * Renders VarDumper output to HTML fragments for the webview.
 */
final class DumpCapture
{
    private readonly VarCloner $cloner;

    private int $dumpCount = 0;

    private ?int $statementLine = null;

    private int $prefixLines = 0;

    public function __construct(private readonly Protocol $protocol)
    {
        $this->cloner = new VarCloner();
    }

    public function install(): void
    {
        VarDumper::setHandler(function (mixed $value, ?string $label = null): void {
            $this->dumpCount++;

            $this->protocol->send([
                'type' => 'dump',
                'id' => $this->protocol->requestId,
                'html' => $this->toHtml($value, $label),
                'stmt' => $this->protocol->stmt,
                'line' => $this->resolveLine(),
            ]);
        });
    }

    public function resetCount(): void
    {
        $this->dumpCount = 0;
    }

    public function count(): int
    {
        return $this->dumpCount;
    }

    public function setLineContext(?int $statementLine, int $prefixLines): void
    {
        $this->statementLine = $statementLine;
        $this->prefixLines = $prefixLines;
    }

    public function capture(mixed $value, ?string $label = null): string
    {
        return $this->toHtml($value, $label);
    }

    public function captureTrace(Throwable $throwable): string
    {
        $lines = \explode("\n", $throwable->getTraceAsString());

        return \implode("\n", \array_slice($lines, 0, 30));
    }

    /**
     * Resolve the line in the original file that produced a dump.
     */
    private function resolveLine(): ?int
    {
        if ($this->statementLine === null) {
            return $this->protocol->line;
        }

        $trace = \debug_backtrace(\DEBUG_BACKTRACE_IGNORE_ARGS, 3);

        foreach ($trace as $frame) {
            $file = $frame['file'] ?? '';

            if ($file !== '' && \str_contains($file, "eval()'d code") && isset($frame['line'])) {
                $offset = (int) $frame['line'] - ($this->prefixLines + 1);
                $line = $this->statementLine + \max(0, $offset);

                return $line;
            }
        }

        return $this->statementLine;
    }

    private function toHtml(mixed $value, ?string $label): string
    {
        $dumper = new HtmlDumper;

        if (\method_exists($dumper, 'setDumpHeader')) {
            $dumper->setDumpHeader('');
        }

        if (\method_exists($dumper, 'setDumpBoundaries')) {
            $dumper->setDumpBoundaries('', '');
        }

        $theme = \getenv('OPENTINKER_DUMP_THEME') ?: 'dark';

        if (\method_exists($dumper, 'setTheme')) {
            $dumper->setTheme($theme);
        }

        $stream = \fopen('php://temp', 'r+');

        if ($stream === false) {
            return '';
        }

        $dumper->setOutput($stream);

        $data = $this->cloner->cloneVar($value);

        if ($label !== null && $label !== '') {
            $data = $data->withContext(['label' => $label]);
        }

        $dumper->dump($data);

        \rewind($stream);
        $html = \stream_get_contents($stream);
        \fclose($stream);

        return $html === false ? '' : $html;
    }
}

/**
 * Collects SQL executed while a statement runs.
 */
final class SqlCollector
{
    /** @var array<int, array{sql: string, bindings: array<int, string>, time: float|null}> */
    private array $queries = [];

    private bool $registered = false;

    public function register(): void
    {
        if ($this->registered || ! \class_exists(DB::class)) {
            return;
        }

        try {
            DB::listen(function ($query): void {
                if (\count($this->queries) >= 50) {
                    return;
                }

                $bindings = [];

                foreach ((array) $query->bindings as $binding) {
                    if (\is_scalar($binding) || $binding === null) {
                        $bindings[] = (string) ($binding ?? 'null');
                    } else {
                        $bindings[] = \get_debug_type($binding);
                    }
                }

                $this->queries[] = [
                    'sql' => (string) $query->sql,
                    'bindings' => $bindings,
                    'time' => isset($query->time) ? (float) $query->time : null,
                ];
            });

            $this->registered = true;
        } catch (Throwable) {
            // Database is not available; queries simply won't be reported.
        }
    }

    public function reset(): void
    {
        $this->queries = [];
    }

    /**
     * @return array<int, array{sql: string, bindings: array<int, string>, time: float|null}>
     */
    public function all(): array
    {
        return $this->queries;
    }
}

/**
 * Executes a run statement by statement, emitting per-line frames.
 */
final class Runner
{
    public function __construct(
        private readonly Shell $shell,
        private readonly Protocol $protocol,
        private readonly DumpCapture $capture,
        private readonly SqlCollector $sql,
    ) {
    }

    public function run(string $code, string $id, string $mode): void
    {
        $split = $mode === 'file' ? null : StatementSplitter::split($code);

        if ($split === null || ! $split['safe']) {
            $statements = \trim($code) === '' ? [] : [['code' => \trim($code), 'line' => 1, 'import' => false]];

            if ($split !== null && \trim($code) !== '') {
                $this->protocol->send([
                    'type' => 'output',
                    'id' => $id,
                    'text' => "[opentinker] Statement splitting unavailable for this snippet; running it as a whole.\n",
                    'stmt' => 0,
                    'line' => 1,
                ]);
            }
        } else {
            $statements = $split['statements'];
        }

        $startedAt = \microtime(true);
        $stmtIndex = 0;
        $failed = false;

        $this->protocol->requestId = $id;

        foreach ($statements as $statement) {
            if ($statement['import']) {
                // PsySH persists use statements via its UseStatementPass, so the
                // import runs on its own and later statements inherit the alias.
                $stmtIndex++;
                $line = $statement['line'];
                $this->protocol->stmt = $stmtIndex;
                $this->protocol->line = $line;
                $statementStart = \microtime(true);

                try {
                    $this->shell->execute($statement['code'], true);
                } catch (Throwable $throwable) {
                    $this->reportError($id, $stmtIndex, $line, $throwable, $statementStart);
                    $failed = true;

                    break;
                }

                continue;
            }

            $stmtIndex++;
            $line = $statement['line'];

            $this->protocol->stmt = $stmtIndex;
            $this->protocol->line = $line;
            $this->capture->setLineContext($line, 0);
            $this->capture->resetCount();
            $this->sql->reset();

            $statementStart = \microtime(true);

            try {
                $value = $this->shell->execute(TokenRewriter::rewrite($statement['code']), true);

                if (\class_exists(\Psy\CodeCleaner\NoReturnValue::class) && $value instanceof \Psy\CodeCleaner\NoReturnValue) {
                    $value = null;
                }

                if ($value !== null && $this->capture->count() === 0) {
                    $this->protocol->send([
                        'type' => 'value',
                        'id' => $id,
                        'stmt' => $stmtIndex,
                        'line' => $line,
                        'html' => $this->capture->capture($value),
                    ]);
                }

                $this->protocol->send($this->statementFrame($id, $stmtIndex, $line, true, $statementStart));
            } catch (ExitCalledException $exception) {
                $message = $exception->getMessage() !== '' ? $exception->getMessage() : 'exit() called';

                $this->protocol->send($this->statementFrame($id, $stmtIndex, $line, true, $statementStart, $message));
                break;
            } catch (Throwable $throwable) {
                $this->reportError($id, $stmtIndex, $line, $throwable, $statementStart);
                $failed = true;

                break;
            }
        }

        $this->protocol->stmt = 0;
        $this->protocol->line = null;
        $this->protocol->requestId = null;
        $this->capture->setLineContext(null, 0);

        $this->protocol->send([
            'type' => 'result',
            'id' => $id,
            'ok' => ! $failed,
            'failed' => $failed,
            'statements' => $stmtIndex,
            'ms' => \round((\microtime(true) - $startedAt) * 1000, 2),
            'memory' => \memory_get_usage(true),
        ]);
    }

    private function reportError(string $id, int $stmt, int $line, Throwable $throwable, float $startedAt): void
    {
        $this->protocol->send([
            'type' => 'error',
            'id' => $id,
            'stmt' => $stmt,
            'line' => $line,
            'ok' => false,
            'errorClass' => $throwable::class,
            'message' => $throwable->getMessage(),
            'file' => $throwable->getFile(),
            'errorLine' => $throwable->getLine(),
            'trace' => $this->capture->captureTrace($throwable),
            'ms' => \round((\microtime(true) - $startedAt) * 1000, 2),
        ]);

        $this->protocol->send($this->statementFrame($id, $stmt, $line, false, $startedAt));
    }

    /**
     * @return array<string, mixed>
     */
    private function statementFrame(string $id, int $stmt, int $line, bool $ok, float $startedAt, ?string $exit = null): array
    {
        $frame = [
            'type' => 'statement',
            'id' => $id,
            'stmt' => $stmt,
            'line' => $line,
            'ok' => $ok,
            'ms' => \round((\microtime(true) - $startedAt) * 1000, 2),
            'memory' => \memory_get_usage(true),
            'queries' => $this->sql->all(),
        ];

        if ($exit !== null) {
            $frame['exit'] = $exit;
        }

        return $frame;
    }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

$protocol = new Protocol;

$basePath = null;

for ($i = 1; $i < \count($argv ?? []); $i++) {
    $argument = $argv[$i];

    if ($argument === '--base-path' && isset($argv[$i + 1])) {
        $basePath = $argv[$i + 1];
        break;
    }

    if (\str_starts_with($argument, '--base-path=')) {
        $basePath = \substr($argument, \strlen('--base-path='));
        break;
    }
}

$basePath = \rtrim($basePath ?? (\getcwd() ?: '.'), '/\\');

$autoload = $basePath . '/vendor/autoload.php';

if (! \is_file($autoload)) {
    $protocol->send([
        'type' => 'fatal',
        'message' => "Could not find vendor/autoload.php at {$autoload}",
    ]);
    exit(1);
}

try {
    require $autoload;

    $app = require $basePath . '/bootstrap/app.php';

    if (! $app instanceof \Illuminate\Foundation\Application) {
        throw new \RuntimeException('bootstrap/app.php did not return an Application instance');
    }

    $app->make(\Illuminate\Contracts\Console\Kernel::class)->bootstrap();
} catch (Throwable $throwable) {
    $protocol->send([
        'type' => 'fatal',
        'message' => 'Failed to bootstrap Laravel: ' . $throwable->getMessage(),
    ]);
    exit(1);
}

/**
 * Routes PsySH and echo output into protocol frames instead of stdout.
 *
 * Declared after the autoloader is registered: the parent class lives in the
 * host application's vendor directory, which is not available at compile time.
 */
final class ProtocolOutput extends ShellOutput
{
    public function __construct(private readonly Protocol $protocol)
    {
        parent::__construct(self::VERBOSITY_NORMAL, false);
    }

    public function doWrite($message, $newline): void
    {
        $this->protocol->output($newline ? $message . "\n" : $message);
    }
}

$runtimeDir = \sys_get_temp_dir() . '/opentinker-' . \substr(\sha1($basePath), 0, 12);

if (! \is_dir($runtimeDir)) {
    @\mkdir($runtimeDir, 0777, true);
}

$config = new Configuration([
    'configDir' => $runtimeDir,
    'dataDir' => $runtimeDir,
    'runtimeDir' => $runtimeDir,
    'historyFile' => $runtimeDir . '/history',
    'updateCheck' => 'never',
    'updateManualCheck' => 'never',
    'startupMessage' => '',
    'useReadline' => false,
    'useBracketedPaste' => false,
    'usePcntl' => false,
    'pager' => false,
    'rawOutput' => true,
    'trustProject' => true,
]);

if (\class_exists(\Laravel\Tinker\TinkerCaster::class)) {
    $casters = [
        'Illuminate\Support\Collection' => 'Laravel\Tinker\TinkerCaster::castCollection',
        'Illuminate\Support\HtmlString' => 'Laravel\Tinker\TinkerCaster::castHtmlString',
        'Illuminate\Support\Stringable' => 'Laravel\Tinker\TinkerCaster::castStringable',
    ];

    if (\class_exists('Illuminate\Database\Eloquent\Model')) {
        $casters['Illuminate\Database\Eloquent\Model'] = 'Laravel\Tinker\TinkerCaster::castModel';
    }

    if (\class_exists('Illuminate\Process\ProcessResult')) {
        $casters['Illuminate\Process\ProcessResult'] = 'Laravel\Tinker\TinkerCaster::castProcessResult';
    }

    if (\class_exists('Illuminate\Foundation\Application')) {
        $casters['Illuminate\Foundation\Application'] = 'Laravel\Tinker\TinkerCaster::castApplication';
    }

    $config->getPresenter()->addCasters($casters);
}

$shell = new Shell($config);
$shell->setOutput(new ProtocolOutput($protocol));

$aliasLoader = null;
$classMap = $basePath . '/vendor/composer/autoload_classmap.php';

if (\class_exists(\Laravel\Tinker\ClassAliasAutoloader::class) && \is_file($classMap)) {
    $aliasLoader = \Laravel\Tinker\ClassAliasAutoloader::register(
        $shell,
        $classMap,
        (array) \config('tinker.alias', []),
        (array) \config('tinker.dont_alias', [])
    );
}

$capture = new DumpCapture($protocol);
$capture->install();

$sql = new SqlCollector;
$sql->register();

$runner = new Runner($shell, $protocol, $capture, $sql);

$protocol->send([
    'type' => 'ready',
    'php' => \PHP_VERSION,
    'laravel' => $app->version(),
    'env' => $app->environment(),
    'basePath' => $basePath,
    'pid' => \getmypid(),
]);

while (true) {
    $request = $protocol->read();

    if ($request === null) {
        break;
    }

    $type = $request['type'] ?? null;

    if ($type === 'shutdown') {
        break;
    }

    if ($type === 'ping') {
        $protocol->send(['type' => 'pong', 'id' => (string) ($request['id'] ?? '')]);

        continue;
    }

    if ($type === 'scope') {
        $id = (string) ($request['id'] ?? '');
        $variables = [];

        try {
            $scope = $shell->getScopeVariables(false);
        } catch (Throwable) {
            $scope = [];
        }

        foreach ($scope as $name => $value) {
            if (\count($variables) >= 50) {
                break;
            }

            if (\in_array($name, ['__psysh__'], true)) {
                continue;
            }

            try {
                $html = $capture->capture($value);
            } catch (Throwable) {
                continue;
            }

            if (\strlen($html) > 100_000) {
                $html = '<em>output truncated</em>';
            }

            $variables[] = ['name' => (string) $name, 'html' => $html];
        }

        $protocol->send(['type' => 'scope', 'id' => $id, 'vars' => $variables]);

        continue;
    }

    if ($type !== 'exec') {
        continue;
    }

    $id = (string) ($request['id'] ?? '');
    $code = (string) ($request['code'] ?? '');
    $mode = (string) ($request['mode'] ?? 'statements');

    try {
        $runner->run($code, $id, $mode);
    } catch (Throwable $throwable) {
        $protocol->send([
            'type' => 'error',
            'id' => $id,
            'ok' => false,
            'errorClass' => $throwable::class,
            'message' => $throwable->getMessage(),
            'file' => $throwable->getFile(),
            'errorLine' => $throwable->getLine(),
            'trace' => $capture->captureTrace($throwable),
            'ms' => 0,
        ]);

        $protocol->send([
            'type' => 'result',
            'id' => $id,
            'ok' => false,
            'failed' => true,
            'statements' => 0,
            'ms' => 0,
            'memory' => \memory_get_usage(true),
        ]);
    }
}
