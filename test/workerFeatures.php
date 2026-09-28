<?php

declare(strict_types=1);

// Load the worker's pure classes without booting an app. The runtime is
// covered by test/integration/worker.php against real projects.
foreach (['Protocol', 'TempDir', 'SourceCode', 'FileImports', 'ImportAliases', 'StatementSplitter', 'TokenRewriter', 'Values', 'ErrorFormatter', 'Runner', 'ModelHints'] as $class) {
    require __DIR__ . "/../worker/src/{$class}.php";
}

$runnerClass = new ReflectionClass('OpenTinker\\Runner');
$runner = $runnerClass->newInstanceWithoutConstructor();
$markers = $runner->magicLines("<?php\n\$value = 1; //?\n\$text = '//?';\n");
if ($markers !== [2 => 'value']) throw new RuntimeException('Magic comment parsing failed');

$table = OpenTinker\Values::table([['name' => 'Ada', 'count' => 2], ['name' => 'Lin', 'count' => 3]]);
if ($table['columns'] !== ['name', 'count'] || $table['rows'][1] !== ['Lin', '3']) {
    throw new RuntimeException('Table conversion failed');
}
$preview = OpenTinker\Values::preview('<h1>Hello</h1>');
if ($preview['kind'] !== 'html') throw new RuntimeException('HTML preview detection failed');

$rewritten = OpenTinker\TokenRewriter::rewrite('<?php $html = "<?php and ?>";');
if (!str_contains($rewritten, '"<?php and ?>"')) {
    throw new RuntimeException('Token rewrite changed a quoted PHP tag');
}

$imports = OpenTinker\FileImports::extract(<<<'PHP'
<?php
namespace App\Http;
use App\Models\User as Person;
use App\Services\{Mailer, Reports\Report};
use function App\Support\format_name;
use const App\Support\DEFAULT_LIMIT;
class Example {
    use SomeTrait;
}
$callback = function () use ($captured) {};
Person::first();
namespace Other;
use Other\Model;
PHP, 12);
if ($imports !== [
    'use App\Models\User as Person;',
    'use App\Services\{Mailer, Reports\Report};',
    'use function App\Support\format_name;',
    'use const App\Support\DEFAULT_LIMIT;',
]) throw new RuntimeException('Active-file import extraction failed');
if (OpenTinker\FileImports::extract("<?php\nuse Foo\\Bar;\nBar::first();", 2) !== []) {
    throw new RuntimeException('Future import was included');
}
if (OpenTinker\FileImports::valid('use Foo\Bar; echo "bad";')) {
    throw new RuntimeException('Unsafe import was accepted');
}
if (!OpenTinker\FileImports::valid('use Foo\{Bar, Baz as Alias};')) {
    throw new RuntimeException('Valid group import was rejected');
}
$bracketed = OpenTinker\FileImports::extract(<<<'PHP'
<?php
namespace First {
    use First\Thing;
    Thing::first();
}
namespace Second {
    use Second\Thing as Item;
    Item::first();
}
PHP, 8);
if ($bracketed !== ['use Second\Thing as Item;']) {
    throw new RuntimeException('Bracketed namespace imports leaked between scopes');
}


// Re-running imports needs PsySH, which lives in the host app. Point
// OPENTINKER_APP_AUTOLOAD at a Laravel app's vendor/autoload.php to include it.
$appAutoload = getenv('OPENTINKER_APP_AUTOLOAD');
if (is_string($appAutoload) && $appAutoload !== '') {
    require $appAutoload;
    $split = OpenTinker\StatementSplitter::split("use Illuminate\\Support\\{Arr, Collection as Coll};\nArr::first([7]);\n");
    if (array_column($split['statements'], 'code') !== ['use Illuminate\\Support\\{Arr, Collection as Coll};', "Arr::first([7]);"]
        || $split['statements'][0]['import'] !== true) {
        throw new RuntimeException('Group import was split at its brace');
    }
    if (OpenTinker\StatementSplitter::split("namespace App;\n\$a = 1;\n")['safe'] !== false) {
        throw new RuntimeException('A namespaced file was split');
    }

    // A lazy collection must be shown by type: counting it would run its (here endless) source.
    $endless = Illuminate\Support\LazyCollection::make(function () { while (true) { yield 1; } });
    if (OpenTinker\Values::short($endless) !== 'Illuminate\\Support\\LazyCollection'
        || (OpenTinker\Values::copyFormats($endless)['json'] ?? null) !== '"Illuminate\\\\Support\\\\LazyCollection"'
        || OpenTinker\Values::table($endless) !== null) {
        throw new RuntimeException('A lazy collection was iterated');
    }
    if (OpenTinker\Values::short(collect([1, 2])) !== 'Illuminate\\Support\\Collection(2)') {
        throw new RuntimeException('An eager collection lost its count');
    }

    $cleaner = new Psy\CodeCleaner();
    $cleaner->clean(['use Illuminate\Support\Str; use Illuminate\Support\{Arr, Collection as Coll};']);
    $rerun = "use Illuminate\\Support\\Str;\nuse Illuminate\\Support\\{Arr, Collection as Coll};\nStr::upper('x');\n";
    $kept = OpenTinker\ImportAliases::withoutKnown($cleaner, $rerun);
    // PsySH before 0.12.22 neither tracks nor rejects re-declared imports.
    $expected = method_exists($cleaner, 'getAliasesByTypeForNamespace') ? "Str::upper('x');" : trim($rerun);
    if (substr_count($kept, "\n") !== 3 || trim($kept) !== $expected) {
        throw new RuntimeException('Known imports were not handled on re-run');
    }
    $changed = "use Illuminate\\Support\\Stringable as Str;\n";
    if (OpenTinker\ImportAliases::withoutKnown($cleaner, $changed) !== $changed) {
        throw new RuntimeException('A changed import was dropped');
    }
    echo "Import re-run checks passed\n";
}

$rewritten = OpenTinker\TokenRewriter::rewrite('dd($a); $c->dd(); Foo::dd(1); exit(2);');
if (! str_contains($rewritten, '\\OpenTinker\\Dd::call($a)') || ! str_contains($rewritten, '$c->dd()') || ! str_contains($rewritten, 'Foo::dd(1)') || ! str_contains($rewritten, 'ExitCalledException')) {
    throw new RuntimeException('dd/exit rewrite failed: ' . $rewritten);
}
// A bare exit takes no argument; whatever follows it must survive the rewrite.
foreach ([
    'match ($x) { 1 => exit, default => 2 };',
    'foo($x ?: exit);',
    '$a = [exit, 1];',
    'die("bye");',
    'exit /* why */ (3);',
    '$f = fn () => exit;',
] as $source) {
    $rewritten = OpenTinker\TokenRewriter::rewrite($source);
    try {
        token_get_all('<?php ' . $rewritten, TOKEN_PARSE);
    } catch (ParseError $error) {
        throw new RuntimeException("exit rewrite broke '{$source}': {$rewritten}");
    }
    if (! str_contains($rewritten, 'ExitCalledException')) {
        throw new RuntimeException("exit was not rewritten in '{$source}'");
    }
}
if (OpenTinker\TokenRewriter::rewrite('new dd(1);') !== 'new dd(1);') {
    throw new RuntimeException('new dd() was rewritten');
}

// dd() and exit end a run even from inside catch (Exception); the runner also
// sees one caught by catch (Throwable).
OpenTinker\ExitCalledException::$raised = null;
try {
    OpenTinker\Dd::call();
} catch (Exception) {
    throw new RuntimeException('dd() was caught as an Exception');
} catch (Error $error) {
    if (! $error instanceof OpenTinker\ExitCalledException || OpenTinker\ExitCalledException::$raised !== $error) {
        throw new RuntimeException('dd() did not record itself');
    }
}

// Showing a value must not use it up.
$generator = (function () { yield 1; yield 2; })();
OpenTinker\Values::short($generator);
OpenTinker\Values::table($generator);
if (OpenTinker\Values::copyFormats($generator) !== ['json' => '"Generator"', 'php' => "'Generator'"] || iterator_to_array($generator) !== [1, 2]) {
    throw new RuntimeException('A generator was consumed while being shown');
}
$failing = new class implements Stringable {
    public function __toString(): string { throw new RuntimeException('no'); }
};
if (OpenTinker\Values::short($failing) !== 'Stringable@anonymous') {
    throw new RuntimeException('A throwing __toString escaped short()');
}

// Views stay bounded.
$huge = str_repeat('x', 5_000_000);
if (mb_strlen(OpenTinker\Values::short($huge)) !== 120 || OpenTinker\Values::copyFormats($huge) !== [] || OpenTinker\Values::copyFormats(array_fill(0, 1000, str_repeat('y', 1000))) !== []) {
    throw new RuntimeException('Oversized values were not skipped');
}
$wide = OpenTinker\Values::table(array_fill(0, 500, array_fill_keys(range(1, 30), str_repeat('z', 2000))));
if (! $wide['truncated'] || strlen(json_encode($wide['rows'])) > 600_000) {
    throw new RuntimeException('Table was not bounded');
}

// Private temp dirs are fresh, 0700, never reused, and removed without following symlinks.
$outside = sys_get_temp_dir() . '/opentinker-feature-' . bin2hex(random_bytes(4));
mkdir($outside);
touch("{$outside}/keep");
$dir = OpenTinker\TempDir::create(sys_get_temp_dir());
$other = OpenTinker\TempDir::create(sys_get_temp_dir());
if ($dir === null || $other === null || $other === $dir || ! is_dir($dir) || (fileperms($dir) & 0777) !== 0700) {
    throw new RuntimeException('Private temp dir was not created privately');
}
OpenTinker\TempDir::remove($other);
symlink($outside, "{$dir}/link");
touch("{$dir}/history");
OpenTinker\TempDir::remove($dir);
if (file_exists($dir) || ! file_exists("{$outside}/keep")) {
    throw new RuntimeException('Private temp dir was not removed safely');
}
unlink("{$outside}/keep");
rmdir($outside);

// Generated model hints only ever contain plain identifiers.
$hints = OpenTinker\ModelHints::render([
    'App\\Models\\User' => ['id' => 'int', 'x */ } echo 1; /*' => 'string', 'meta' => '\\Illuminate\\Support\\Collection|null', 'bad' => 'int */'],
    'App\\Models\\{Evil}' => ['id' => 'int'],
]);
try {
    token_get_all($hints['php'], TOKEN_PARSE);
} catch (ParseError $error) {
    throw new RuntimeException('Model hints are not valid PHP: ' . $error->getMessage());
}
if ($hints['count'] !== 1 || str_contains($hints['php'], 'echo') || ! str_contains($hints['php'], '@property \\Illuminate\\Support\\Collection|null $meta') || count($hints['skipped']) !== 3) {
    throw new RuntimeException('Model hints kept an unusual name: ' . json_encode($hints));
}
if (OpenTinker\Values::short("line one\nline two") !== 'line one↵line two') {
    throw new RuntimeException('Short value formatting failed');
}
$copy = OpenTinker\Values::copyFormats(['a' => [1, true]]);
if (! str_contains($copy['php'] ?? '', "'a' => [") || ! str_contains($copy['json'] ?? '', '"a"')) {
    throw new RuntimeException('Copy formats failed');
}

echo "Worker feature checks passed\n";
