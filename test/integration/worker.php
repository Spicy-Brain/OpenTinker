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
        @fwrite($this->pipes[0], json_encode($request) . "\n"); // The worker may already be gone.
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
                if (trim($line) === '') {
                    continue; // Frames start on a fresh line; decoders skip the blank ones.
                }
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

    public function closeInput(): void
    {
        if (is_resource($this->pipes[0])) {
            fclose($this->pipes[0]);
        }
    }

    public function close(): void
    {
        if (is_resource($this->pipes[0])) {
            $this->send(['type' => 'shutdown']);
        }
        $this->closeInput();
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
function lastOf(array $frames, string $type): array { $all = ofType($frames, $type); return end($all) ?: []; }
function printed(array $frames): string { return implode('', array_column(ofType($frames, 'output'), 'text')); }

$worker = new Worker($command);
$ready = $worker->ready;
echo "Worker: PHP {$ready['php']}, " . ($ready['laravel'] ? "Laravel {$ready['laravel']}" : $ready['framework'] ?? '?') . ", PsySH " . ($ready['psysh'] ?? '?') . "\n";
check('handshake reports protocol 2', ($ready['protocol'] ?? null) === 2, $ready);
$fork = (bool) ($ready['capabilities']['fork'] ?? false);
check('parser available', (bool) ($ready['capabilities']['parser'] ?? false), $ready);

if (isset($options['base-path']) && ! isset($options['command']) && DIRECTORY_SEPARATOR === '/') {
    // Older workers used a predictable PsySH config dir in the shared temp dir,
    // so anyone could plant a config.php there. Plant one and prove it never runs.
    $tmp = sys_get_temp_dir() . '/opentinker-it-' . bin2hex(random_bytes(4));
    mkdir($tmp, 0700);
    $marker = "{$tmp}/planted-config-ran";
    $legacy = "{$tmp}/opentinker-" . substr(sha1(rtrim($options['base-path'], '/\\')), 0, 12);
    mkdir($legacy);
    file_put_contents("{$legacy}/config.php", '<?php touch(' . var_export($marker, true) . '); return [];');
    $isolated = new Worker('TMPDIR=' . escapeshellarg($tmp) . ' ' . $command);
    $probe = $isolated->run('1 + 1;');
    $private = array_values(array_diff(glob("{$tmp}/opentinker-*", GLOB_ONLYDIR) ?: [], [$legacy]));
    check(
        'a config.php planted in the shared temp dir never runs',
        result($probe)['ok'] && ! file_exists($marker) && count($private) === 1 && (fileperms($private[0]) & 0777) === 0700,
        [$private, file_exists($marker)],
    );
    $isolated->close();
    check('the private temp dir is removed on shutdown', (glob("{$tmp}/opentinker-*") ?: []) === [$legacy], glob("{$tmp}/*"));
    @unlink("{$legacy}/config.php");
    @unlink($marker);
    @rmdir($legacy);
    @rmdir($tmp);
}

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

    // The limit sits just above what the run already uses, so the fatal comes from the run itself.
    $exhaust = "ini_set('memory_limit', (string) (memory_get_usage(true) + 16 * 1024 * 1024));\n\$big = str_repeat('x', 64 * 1024 * 1024);";
    $fatal = $worker->run($exhaust);
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

// Requests reach the kept session over a socket whose buffer is 8 KB on macOS;
// a larger request used to be cut short and the run never started.
$bigKept = $worker->run("<?php\n\$big = '" . str_repeat('x', 100_000) . "';\nstrlen(\$big);", ['fresh' => false]);
$bigValues = ofType($bigKept, 'value');
check('a keep-session run larger than the socket buffer arrives whole', result($bigKept)['ok'] && (end($bigValues)['short'] ?? null) === '100000', result($bigKept));

if ($fork) {
    $freshAfterKept = $worker->run("isset(\$kept) ? 'leaked' : 'isolated';");
    check('fresh runs stay isolated from the kept session', (ofType($freshAfterKept, 'value')[0]['short'] ?? null) === 'isolated', $freshAfterKept);

    $keptScope = result($worker->request('scope'));
    check('scope request reads the kept session', in_array('kept', array_column($keptScope['vars'] ?? [], 'name'), true), $keptScope);

    $reset = result($worker->request('reset'));
    $afterReset = $worker->run("isset(\$kept) ? 'kept' : 'cleared';", ['fresh' => false]);
    check('restart clears the kept session without re-booting', ($reset['ok'] ?? false) && (ofType($afterReset, 'value')[0]['short'] ?? null) === 'cleared', [$reset, $afterReset]);

    $keptFatal = $worker->run($exhaust, ['fresh' => false]);
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

// Showing a value must not use it up: a generator stays iterable.
$generator = $worker->run("<?php\n\$g = (function () { yield 1; yield 2; })();\niterator_to_array(\$g);");
check('a generator shown as a value can still be iterated', result($generator)['ok'] && (lastOf($generator, 'value')['short'] ?? null) === 'array(2)', $generator);

$warning = $worker->run("<?php\n\$a = [];\n\$a['missing'];\ntrigger_error('an old api', E_USER_DEPRECATED);\n'done';");
check('PHP warnings reach the results, deprecations do not', result($warning)['ok'] && str_contains(printed($warning), 'Undefined array key') && ! str_contains(printed($warning), 'an old api'), $warning);

$caughtDd = $worker->run("<?php\ntry { dd('x'); } catch (Exception \$e) { echo 'caught'; }\necho 'after';");
$caughtExit = $worker->run("<?php\ntry { exit; } catch (Throwable \$e) { echo 'swallowed'; }\necho 'after';");
check(
    'catch blocks in scratch code cannot keep a run going past dd() or exit',
    (result($caughtDd)['ended'] ?? null) === 'dd' && ! str_contains(printed($caughtDd), 'caught') && ! str_contains(printed($caughtDd), 'after')
        && (result($caughtExit)['ended'] ?? null) === 'exit' && ! str_contains(printed($caughtExit), 'after'),
    [$caughtDd, $caughtExit],
);

$bareExit = $worker->run("<?php\n\$x = 0;\n\$y = match (\$x) { 0 => exit, default => [\$x ?: exit, 1] };\necho 'after';");
check('a bare exit inside an expression ends the run', result($bareExit)['ok'] && (result($bareExit)['ended'] ?? null) === 'exit' && ! str_contains(printed($bareExit), 'after'), $bareExit);

$stringable = $worker->run("<?php\n\$o = new class implements Stringable { public function __toString(): string { throw new RuntimeException('no'); } };\n'next';");
check('a value that fails to display does not fail the run', result($stringable)['ok'] && (lastOf($stringable, 'value')['short'] ?? null) === 'next', $stringable);

$stray = $worker->run("<?php\nfwrite(STDOUT, 'progress');\n1 + 1;");
check('bytes written straight to stdout cannot swallow a frame', result($stray)['ok'] && array_column(ofType($stray, 'value'), 'short') === ['8', '2'], $stray);

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
        $rolled = $worker->run("DB::table('opentinker_probe')->insertGetId([]);\nDB::table('opentinker_probe')->count();", ['rollback' => true]);
        $after = ofType($worker->run("DB::table('opentinker_probe')->count();"), 'value')[0]['short'] ?? 'y';
        check('rollback mode undoes database writes', result($rolled)['rolledBack'] === true && $before === $after, [$before, $after, result($rolled)]);
        $committed = $worker->run("DB::table('opentinker_probe')->insertGetId([]);\nDB::commit();", ['rollback' => true]);
        $afterCommit = ofType($worker->run("DB::table('opentinker_probe')->count();"), 'value')[0]['short'] ?? 'z';
        check(
            'rollback mode reports a run that committed its own transaction',
            result($committed)['rolledBack'] === false && str_contains(printed($committed), 'may have been saved') && $afterCommit === (string) ((int) $before + 1),
            [$before, $afterCommit, $committed],
        );
        $worker->run("Schema::dropIfExists('opentinker_probe');");
    }

    // Nothing may count or iterate a lazy value to display it: a cursor would
    // run its query and an endless LazyCollection would never finish.
    $lazy = $worker->run("<?php\n\$users = App\\Models\\User::cursor();\n\$endless = Illuminate\\Support\\LazyCollection::make(function () { while (true) { yield 1; } });", ['timeout' => 15]);
    check('cursors and lazy collections are shown without running them', result($lazy)['ok'] && (ofType($lazy, 'statement')[0]['sql']['total'] ?? -1) === 0, $lazy);

    $hints = result($worker->request('modelHints'));
    check('model hints describe real columns', ($hints['count'] ?? 0) >= 1 && str_contains($hints['php'] ?? '', '@property'), $hints);

    // Fake side effects: nothing leaves the process, each statement says what it
    // would have sent, and a kept session gets the real services back afterwards.
    check('the handshake offers fakes', ($ready['capabilities']['fakes'] ?? null) === true, $ready);
    $probe = "<?php\n\$services = [get_class(Bus::getFacadeRoot()), get_class(Queue::getFacadeRoot()), get_class(Notification::getFacadeRoot()), spl_object_id(Http::getFacadeRoot()), get_class(app('mail.manager')->mailer()->getSymfonyTransport())];\n(str_contains(implode(' ', \$services), 'Fake') ? 'fakes ' : 'real ') . md5(serialize(\$services));";
    $realServices = lastOf($worker->run($probe, ['fresh' => false]), 'value')['short'] ?? 'x';
    $fakeCode = <<<'PHP'
<?php
Mail::raw('Hello Ada', fn ($message) => $message->to('ada@example.com')->subject('Hi Ada'));
Notification::route('mail', 'grace@example.com')->notify(new class extends Illuminate\Notifications\Notification { public function via($notifiable) { return ['mail']; } public function toMail($notifiable) { return (new Illuminate\Notifications\Messages\MailMessage)->line('Welcome, Grace'); } });
dispatch(function () { throw new RuntimeException('a faked job must not run'); });
Http::post('https://opentinker.invalid/charges', ['amount' => 5])->status();
PHP;
    foreach (['fresh' => true, 'kept-session' => false] as $mode => $fresh) {
        $faked = $worker->run($fakeCode, ['fake' => true, 'fresh' => $fresh]);
        $statements = ofType($faked, 'statement');
        $effects = array_merge(...array_map(fn (array $statement) => $statement['sideEffects'] ?? [], $statements));
        $summaries = implode(' | ', array_column($effects, 'summary'));
        check(
            "a {$mode} run with fakes reports what each statement would have sent",
            result($faked)['ok'] && result($faked)['faked'] === true
                && array_map(fn (array $statement) => array_column($statement['sideEffects'] ?? [], 'kind'), $statements) === [['mail'], ['notification'], ['job'], ['http']]
                && str_contains($summaries, '"Hi Ada" to ada@example.com')
                && str_contains($summaries, 'to grace@example.com via mail')
                && str_contains($summaries, 'Closure job')
                && str_contains($summaries, 'POST https://opentinker.invalid/charges')
                && str_contains($effects[0]['html'] ?? '', 'Hello Ada')
                && str_contains($effects[1]['html'] ?? '', 'Welcome, Grace')
                && (lastOf($faked, 'value')['short'] ?? null) === '200'
                && ! str_contains(json_encode($faked), 'must not run'),
            $faked,
        );
    }
    $lastDispatch = $worker->run("<?php\n1;\ndispatch(fn () => null);", ['fake' => true]);
    check('a job dispatched on the last line is captured by that line', array_column(ofType($lastDispatch, 'statement')[1]['sideEffects'] ?? [], 'kind') === ['job'], $lastDispatch);
    $afterFakes = lastOf($worker->run($probe, ['fresh' => false]), 'value')['short'] ?? 'y';
    check('a kept session gets the real services back after a run with fakes', str_starts_with($realServices, 'real ') && $realServices === $afterFakes, [$realServices, $afterFakes]);
}

if (! $laravel) {
    check('the handshake does not offer fakes without Laravel', ($ready['capabilities']['fakes'] ?? null) === false, $ready);
    $refusedFake = $worker->run("<?php\necho 'ran';", ['fake' => true]);
    check(
        'a run with fakes on a project that cannot fake runs nothing',
        ! result($refusedFake)['ok'] && result($refusedFake)['faked'] === false && ! str_contains(printed($refusedFake), 'ran')
            && str_contains(ofType($refusedFake, 'error')[0]['message'] ?? '', 'nothing was run'),
        $refusedFake,
    );
}

if ($fork && isset($options['base-path']) && ! isset($options['command']) && function_exists('posix_kill')) {
    // Children must not outlive the worker, whether it is signalled or its input closes.
    foreach (['a termination signal' => SIGTERM, 'end of input' => null] as $how => $signal) {
        $doomed = new Worker($command);
        $sessionPid = (int) trim(printed($doomed->run('echo getmypid();', ['fresh' => false])));
        $doomed->send(['type' => 'exec', 'id' => 'doomed', 'code' => "echo getmypid();\nsleep(30);", 'mode' => 'statements', 'fresh' => true]);
        $runPid = (int) trim(printed($doomed->until(fn (array $f) => $f['type'] === 'output' && ctype_digit(trim($f['text'])), 10)));
        $signal !== null ? posix_kill((int) $doomed->ready['pid'], $signal) : $doomed->closeInput();
        $deadline = microtime(true) + 5;
        while (microtime(true) < $deadline && (posix_kill($runPid, 0) || posix_kill($sessionPid, 0))) {
            usleep(50_000);
        }
        check("run and kept-session processes end with the worker on {$how}", $runPid > 0 && $sessionPid > 0 && ! posix_kill($runPid, 0) && ! posix_kill($sessionPid, 0), [$runPid, $sessionPid]);
        $doomed->close();
    }
}

if ($fork && isset($options['base-path']) && ! isset($options['command']) && function_exists('posix_setrlimit') && function_exists('pcntl_exec') && posix_geteuid() !== 0) {
    // With no processes left to fork, a run must fail rather than run inside the pristine worker.
    $limit = 'posix_setrlimit(POSIX_RLIMIT_NPROC, 1, 1); pcntl_exec(PHP_BINARY, array_slice($argv, 1));';
    $limited = new Worker(escapeshellarg(PHP_BINARY) . ' -r ' . escapeshellarg($limit) . ' -- ' . escapeshellarg($workerFile) . ' ' . escapeshellarg('--base-path=' . $options['base-path']));
    $refused = $limited->run("echo 'ran';");
    check(
        'a run that cannot get a process fails instead of running in the worker',
        ! result($refused)['ok'] && str_contains(ofType($refused, 'error')[0]['message'] ?? '', 'Could not start a process') && ! str_contains(printed($refused), 'ran')
            && result($limited->request('ping'))['type'] === 'pong',
        $refused,
    );
    $limited->close();
}

$worker->close();
echo "\n{$passed} passed, {$failures} failed\n";
exit($failures > 0 ? 1 : 0);
