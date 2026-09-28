<?php

declare(strict_types=1);

// Load the worker's pure classes without booting an app. The runtime is
// covered by test/integration/worker.php against real projects.
foreach (['Protocol', 'SourceCode', 'FileImports', 'ImportAliases', 'StatementSplitter', 'TokenRewriter', 'Values', 'ErrorFormatter', 'Runner'] as $class) {
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

$split = OpenTinker\StatementSplitter::split("use Illuminate\\Support\\{Arr, Collection as Coll};\nArr::first([7]);\n");
if (array_column($split['statements'], 'code') !== ['use Illuminate\\Support\\{Arr, Collection as Coll};', "Arr::first([7]);"]
    || $split['statements'][0]['import'] !== true) {
    throw new RuntimeException('Group import was split at its brace');
}

// Re-running imports needs PsySH, which lives in the host app. Point
// OPENTINKER_APP_AUTOLOAD at a Laravel app's vendor/autoload.php to include it.
$appAutoload = getenv('OPENTINKER_APP_AUTOLOAD');
if (is_string($appAutoload) && $appAutoload !== '') {
    require $appAutoload;
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
if (OpenTinker\Values::short("line one\nline two") !== 'line one↵line two') {
    throw new RuntimeException('Short value formatting failed');
}
$copy = OpenTinker\Values::copyFormats(['a' => [1, true]]);
if (! str_contains($copy['php'] ?? '', "'a' => [") || ! str_contains($copy['json'] ?? '', '"a"')) {
    throw new RuntimeException('Copy formats failed');
}

echo "Worker feature checks passed\n";
