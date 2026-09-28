<?php

declare(strict_types=1);

/*
 * Drives the built worker against a real app over the JSON protocol.
 *
 *   php test/integration/worker.php --base-path=/path/to/laravel-app
 *   php test/integration/worker.php --command="docker compose exec -T app php /tmp/worker.php --base-path=/var/www"
 *
 * Add --laravel=0 for a plain Composer project (skips database checks), and
 * --no-writes against a real database (skips the rollback check, which
 * creates and drops a probe table).
 */

$options = getopt('', ['base-path:', 'command:', 'worker:', 'laravel:', 'no-writes']);
$writes = ! isset($options['no-writes']);
$workerFile = $options['worker'] ?? __DIR__ . '/../../dist/worker.php';
$laravel = ($options['laravel'] ?? '1') !== '0';

if (isset($options['command'])) {
    $command = $options['command'];
} elseif (isset($options['base-path'])) {
    $command = escapeshellarg(PHP_BINARY) . ' ' . escapeshellarg($workerFile) . ' ' . escapeshellarg('--base-path=' . $options['base-path']);
} else {
    fwrite(STDERR, "Pass --base-path or --command\n");
    exit(2);
}

final class Worker
{
    /** @var resource */
    private $process;
    /** @var array<int, resource> */
    private array $pipes = [];
    private string $buffer = '';
    private int $sequence = 0;
    /** @var array<int, array<string, mixed>> */
    public array $ready = [];

    public function __construct(string $command)
    {
        $this->process = proc_open($command, [['pipe', 'r'], ['pipe', 'w'], ['pipe', 'w']], $this->pipes);
        stream_set_blocking($this->pipes[1], false);
        stream_set_blocking($this->pipes[2], false);
        $this->ready = $this->until(fn (array $f) => in_array($f['type'], ['ready', 'fatal'], true), 60)[0];
    }

    public function send(array $request): void
    {
        fwrite($this->pipes[0], json_encode($request) . "\n");
        fflush($this->pipes[0]);
    }

    /** @return array<int, array<string, mixed>> frames, last one matching */
    public function until(callable $match, float $timeout = 30): array
    {
        $frames = [];
        $deadline = microtime(true) + $timeout;

        while (microtime(true) < $deadline) {
            while (($pos = strpos($this->buffer, "\n")) !== false) {
                $line = substr($this->buffer, 0, $pos);
                $this->buffer = substr($this->buffer, $pos + 1);
                $frame = json_decode($line, true);
                if (! is_array($frame)) {
                    $frame = ['type' => 'raw', 'text' => $line];
                }
                if ($frame['type'] === 'ready' || $frame['type'] === 'fatal') {
                    return [$frame];
                }
                $frames[] = $frame;
                if ($match($frame)) {
                    return $frames;
                }
            }
            $read = [$this->pipes[1]];
            $w = $e = null;
            if (@stream_select($read, $w, $e, 0, 100000)) {
                $this->buffer .= (string) stream_get_contents($this->pipes[1]);
            }
            stream_get_contents($this->pipes[2]);
        }

        throw new RuntimeException('Timed out; frames so far: ' . json_encode($frames));
    }

    /** @return array<int, array<string, mixed>> */
    public function run(string $code, array $options = []): array
    {
        $id = 'r' . (++$this->sequence);
        $this->send(['type' => 'exec', 'id' => $id, 'code' => $code] + $options + ['mode' => 'statements', 'fresh' => true]);

        return $this->until(fn (array $f) => $f['type'] === 'result' && $f['id'] === $id, $options['timeout'] ?? 30);
    }

    public function request(string $type, array $extra = []): array
    {
        $id = $type[0] . (++$this->sequence);
        $this->send(['type' => $type, 'id' => $id] + $extra);

        return $this->until(fn (array $f) => ($f['id'] ?? null) === $id && $f['type'] !== 'output', 30);
    }

    public function close(): void
    {
        $this->send(['type' => 'shutdown']);
        fclose($this->pipes[0]);
        proc_close($this->process);
    }
}

$failures = 0;
$passed = 0;

function check(string $name, bool $ok, mixed $detail = null): void
{
    global $failures, $passed;
    if ($ok) {
        $passed++;
        echo "  ✓ {$name}\n";
    } else {
        $failures++;
        echo "  ✗ {$name}\n    " . json_encode($detail, JSON_UNESCAPED_SLASHES) . "\n";
    }
}

function result(array $frames): array { return end($frames); }
function ofType(array $frames, string $type): array { return array_values(array_filter($frames, fn ($f) => $f['type'] === $type)); }

$worker = new Worker($command);
$ready = $worker->ready;
echo "Worker: PHP {$ready['php']}, " . ($ready['laravel'] ? "Laravel {$ready['laravel']}" : $ready['framework'] ?? '?') . ", PsySH " . ($ready['psysh'] ?? '?') . "\n";
check('handshake reports protocol 2', ($ready['protocol'] ?? null) === 2, $ready);
$fork = (bool) ($ready['capabilities']['fork'] ?? false);
check('parser available', (bool) ($ready['capabilities']['parser'] ?? false), $ready);

$imports = $laravel ? "use Illuminate\\Support\\Str;\nuse Illuminate\\Support\\{Arr, Collection as Coll};\n" : "";
$scratch = "<?php\n{$imports}\$greeting = 'hi';\n" . ($laravel ? "Str::upper(\$greeting) . Arr::first([1]);\n" : "strtoupper(\$greeting);\n");

$first = $worker->run($scratch);
$second = $worker->run($scratch);
check('same scratch runs twice', result($first)['ok'] && result($second)['ok'], [$first, $second]);
$value = ofType($second, 'value');
check('value is returned', (end($value)['short'] ?? null) === ($laravel ? 'HI1' : 'HI'), $value);

if ($fork) {
    $changed = $worker->run("<?php\nuse Illuminate\\Support\\Stringable as Str;\n\$s = 1;");
    check('changing an import between fresh runs works', result($changed)['ok'], $changed);

    $fn = "<?php\nfunction opentinker_probe() { return 41 + 1; }\nopentinker_probe();";
    $worker->run($fn);
    $again = $worker->run($fn);
    check('redeclaring a function in a fresh run works', result($again)['ok'] && (ofType($again, 'value')[0]['short'] ?? null) === '42', $again);

    $worker->run('$leftover = 5;');
    $isolated = $worker->run("isset(\$leftover) ? 'kept' : 'fresh';");
    check('variables do not leak between fresh runs', (ofType($isolated, 'value')[0]['short'] ?? null) === 'fresh', $isolated);

    $exit = $worker->run("echo 'before';\neval('exit(4);');\necho 'after';");
    check('exit() in called code ends the run cleanly', result($exit)['ok'] && (result($exit)['ended'] ?? null) === 'exit', $exit);
    check('output before exit() is kept', str_contains(json_encode($exit), 'before') && ! str_contains(json_encode($exit), 'after'), $exit);

    $fatal = $worker->run("ini_set('memory_limit', '32M');\n\$big = str_repeat('x', 64 * 1024 * 1024);");
    $error = ofType($fatal, 'error')[0] ?? [];
    check('a fatal error in a run is reported, not fatal to the worker', ! result($fatal)['ok'] && str_contains($error['message'] ?? '', 'memory'), $fatal);
    check('fatal error points at the right line', ($error['line'] ?? null) === 2, $error);

    $id = 'cancel-me';
    $started = microtime(true);
    $worker->send(['type' => 'exec', 'id' => $id, 'code' => "sleep(20);", 'mode' => 'statements', 'fresh' => true]);
    usleep(400_000);
    $worker->send(['type' => 'cancel', 'id' => $id]);
    $stopped = $worker->until(fn ($f) => $f['type'] === 'result' && $f['id'] === $id, 10);
    check('Stop cancels a running fresh run quickly', (result($stopped)['stopped'] ?? false) && microtime(true) - $started < 5, $stopped);
    $pong = $worker->request('ping');
    check('worker stays alive after Stop', result($pong)['type'] === 'pong', $pong);
}

$worker->run("\$kept = 7;", ['fresh' => false]);
$kept = $worker->run("\$kept * 6;", ['fresh' => false]);
check('keep-session runs share variables', (ofType($kept, 'value')[0]['short'] ?? null) === '42', $kept);
$keptImports = $worker->run($scratch, ['fresh' => false]);
$keptImportsAgain = $worker->run($scratch, ['fresh' => false]);
check('keep-session tolerates re-declared imports', result($keptImports)['ok'] && result($keptImportsAgain)['ok'], $keptImportsAgain);

if ($fork) {
    $freshAfterKept = $worker->run("isset(\$kept) ? 'leaked' : 'isolated';");
    check('fresh runs stay isolated from the kept session', (ofType($freshAfterKept, 'value')[0]['short'] ?? null) === 'isolated', $freshAfterKept);

    $keptScope = result($worker->request('scope'));
    check('scope request reads the kept session', in_array('kept', array_column($keptScope['vars'] ?? [], 'name'), true), $keptScope);

    $reset = result($worker->request('reset'));
    $afterReset = $worker->run("isset(\$kept) ? 'kept' : 'cleared';", ['fresh' => false]);
    check('restart clears the kept session without re-booting', ($reset['ok'] ?? false) && (ofType($afterReset, 'value')[0]['short'] ?? null) === 'cleared', [$reset, $afterReset]);

    $keptFatal = $worker->run("ini_set('memory_limit', '32M');\n\$big = str_repeat('x', 64 * 1024 * 1024);", ['fresh' => false]);
    check('a fatal error resets the kept session and says so', (result($keptFatal)['sessionReset'] ?? false) && str_contains(ofType($keptFatal, 'error')[0]['message'] ?? '', 'reset'), $keptFatal);
}

$noJunk = $worker->run("<?php\nuse Illuminate\\Support\\Str;\nuse Illuminate\\Support\\Str;");
check('crash renderers never write junk to the protocol', ofType($noJunk, 'raw') === [], $noJunk);

$dd = $worker->run("\$x = 1;\ndd(\$x, 'two');\necho 'after';");
check('dd() dumps every argument', count(ofType($dd, 'dump')) === 2, $dd);
check('dd() ends the run cleanly', result($dd)['ok'] && (result($dd)['ended'] ?? null) === 'dd' && ! str_contains(json_encode($dd), 'after'), $dd);

$syntax = $worker->run("\$a = 1;\n\$b = ;\n");
$syntaxError = ofType($syntax, 'error')[0] ?? [];
check('syntax errors are reported before running, with the line', ($syntaxError['errorClass'] ?? '') === 'ParseError' && ($syntaxError['line'] ?? 0) === 2, $syntax);

$noSemicolon = $worker->run("1 + 1");
check('a final expression without a semicolon runs', (ofType($noSemicolon, 'value')[0]['short'] ?? null) === '2', $noSemicolon);

$thrown = $worker->run("\$a = 1;\n\nthrow new RuntimeException('boom');");
$thrownError = ofType($thrown, 'error')[0] ?? [];
check('exceptions report the scratch line', ($thrownError['message'] ?? '') === 'boom' && ($thrownError['scratchLine'] ?? 0) === 3, $thrownError);
check('internal frames are hidden', ! str_contains(json_encode($thrownError['frames'] ?? []), 'psysh') && ! str_contains(json_encode($thrownError['frames'] ?? []), 'worker.php'), $thrownError);

$copy = $worker->run("['a' => 1, 'b' => [true, null]];");
$copyValue = ofType($copy, 'value')[0] ?? [];
check('copy formats include JSON and PHP', str_contains($copyValue['copy']['json'] ?? '', '"a": 1') && str_contains($copyValue['copy']['php'] ?? '', "'a' => 1"), $copyValue);

$scope = $worker->run("\$user = 'Ada';\n\$count = 3;");
$scopeFrame = ofType($scope, 'scope')[0] ?? [];
check('each run reports the variables it left', array_column($scopeFrame['vars'] ?? [], 'name') === ['user', 'count'], $scopeFrame);

$group = $worker->run("<?php\nuse Psy\\{Shell, Configuration as Config};\nShell::class;");
check('group imports split and run', result($group)['ok'] && (ofType($group, 'value')[0]['short'] ?? null) === 'Psy\\Shell', $group);

if ($laravel) {
    $model = $worker->run("new App\\Models\\User(['name' => 'Ada', 'email' => 'ada@example.com']);");
    $card = ofType($model, 'value')[0]['model'] ?? [];
    check('models render as a card', ($card['class'] ?? '') === 'App\\Models\\User' && in_array('name', array_column($card['attributes'] ?? [], 'name'), true), $model);

    $n1 = $worker->run("foreach (range(1, 5) as \$i) { DB::select('select ? as n', [\$i]); }");
    $sql = ofType($n1, 'statement')[0]['sql'] ?? [];
    check('repeated queries are flagged', ($sql['total'] ?? 0) === 5 && ($sql['repeated'][0]['count'] ?? 0) === 5, $sql);

    if ($writes && ($ready['capabilities']['database'] ?? false)) {
        $worker->run("Schema::hasTable('opentinker_probe') || Schema::create('opentinker_probe', function (\$t) { \$t->id(); });");
        $before = ofType($worker->run("DB::table('opentinker_probe')->count();"), 'value')[0]['short'] ?? 'x';
        $rolled = $worker->run("DB::table('opentinker_probe')->insert([]);\nDB::table('opentinker_probe')->count();", ['rollback' => true]);
        $after = ofType($worker->run("DB::table('opentinker_probe')->count();"), 'value')[0]['short'] ?? 'y';
        check('rollback mode undoes database writes', result($rolled)['rolledBack'] === true && $before === $after, [$before, $after, result($rolled)]);
        $worker->run("Schema::dropIfExists('opentinker_probe');");
    }

    $hints = result($worker->request('modelHints'));
    check('model hints describe real columns', ($hints['count'] ?? 0) >= 1 && str_contains($hints['php'] ?? '', '@property'), $hints);
}

$worker->close();
echo "\n{$passed} passed, {$failures} failed\n";
exit($failures > 0 ? 1 : 0);
