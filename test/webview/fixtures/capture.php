<?php

declare(strict_types=1);

/*
 * Captures real worker frames for the results panel tests and preview.
 *   php test/webview/fixtures/capture.php /path/to/laravel-app > test/webview/fixtures/frames.json
 */

$base = $argv[1] ?? exit("Pass a Laravel app path\n");
$code = <<<'PHP'
<?php

use App\Models\User;
use Illuminate\Support\Str;

$user = new User(['name' => 'Ada Lovelace', 'email' => 'ada@example.com']);
$user->name = 'Ada King';
echo "Hello from OpenTinker\n";
collect([['id' => 1, 'name' => 'Ada'], ['id' => 2, 'name' => 'Grace'], ['id' => 3, 'name' => 'Linus']]);
dump(Str::of('opentinker')->title(), ['nested' => ['a' => 1, 'b' => [true, null, 1.5]]]);
foreach (range(1, 4) as $i) { DB::select('select ? as n', [$i]); }
$total = 21 * 2; //?
'<h1 style="font-family:sans-serif">Hello</h1><p>An HTML preview</p>';
throw new RuntimeException('Something went wrong in the scratch file');
PHP;

$process = proc_open([PHP_BINARY, __DIR__ . '/../../../dist/worker.php', '--base-path=' . $base], [['pipe', 'r'], ['pipe', 'w'], ['pipe', 'w']], $pipes);
fwrite($pipes[0], json_encode(['type' => 'exec', 'id' => 'demo', 'code' => $code, 'mode' => 'statements', 'fresh' => true, 'rollback' => false]) . "\n");
fflush($pipes[0]);

$frames = [];
while (($line = fgets($pipes[1])) !== false) {
    $frame = json_decode($line, true);
    if (! is_array($frame) || $frame['type'] === 'ready') continue;
    $frames[] = $frame;
    if ($frame['type'] === 'result') break;
}
fwrite($pipes[0], "{\"type\":\"shutdown\"}\n");
proc_close($process);

echo json_encode(['code' => $code, 'frames' => $frames], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), "\n";
