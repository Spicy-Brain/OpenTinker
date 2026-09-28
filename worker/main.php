<?php

declare(strict_types=1);

namespace OpenTinker;

use Psy\Configuration;
use Psy\Output\ShellOutput;
use Psy\Shell;
use Throwable;

/*
 * Entry point. Boots the host application once, then serves requests over
 * newline-delimited JSON on stdin/stdout. Runs execute in a forked child when
 * a fresh session is requested and pcntl is available, otherwise in-process.
 */

\ini_set('display_errors', 'stderr');

$protocol = new Protocol;

$options = ['base-path' => null, 'bootstrap' => 'auto'];

for ($i = 1; $i < \count($argv ?? []); $i++) {
    foreach (\array_keys($options) as $name) {
        if ($argv[$i] === "--{$name}" && isset($argv[$i + 1])) {
            $options[$name] = $argv[++$i];
        } elseif (\str_starts_with($argv[$i], "--{$name}=")) {
            $options[$name] = \substr($argv[$i], \strlen("--{$name}="));
        }
    }
}

$basePath = \rtrim((string) ($options['base-path'] ?? (\getcwd() ?: '.')), '/\\');
$bootstrap = (string) $options['bootstrap'];

$fail = static function (string $message) use ($protocol): never {
    $protocol->send(['type' => 'fatal', 'message' => $message]);
    exit(1);
};

$autoload = $basePath . '/vendor/autoload.php';
$laravelBootstrap = $basePath . '/bootstrap/app.php';

if ($bootstrap === 'auto') {
    $bootstrap = \is_file($laravelBootstrap) ? 'laravel' : 'composer';
}

$app = null;
$framework = $bootstrap === 'laravel' ? 'laravel' : ($bootstrap === 'composer' ? 'composer' : 'custom');

try {
    if (\is_file($autoload)) {
        require $autoload;
    } elseif ($framework !== 'custom') {
        $fail("Could not find vendor/autoload.php in {$basePath}. Run composer install, or check the runtime's working directory.");
    }

    if ($framework === 'laravel') {
        $app = require $laravelBootstrap;

        if (! $app instanceof \Illuminate\Foundation\Application) {
            throw new \RuntimeException('bootstrap/app.php did not return an Application instance');
        }

        $app->make(\Illuminate\Contracts\Console\Kernel::class)->bootstrap();
    } elseif ($framework === 'custom') {
        $custom = \str_starts_with($bootstrap, '/') ? $bootstrap : $basePath . '/' . $bootstrap;

        if (! \is_file($custom)) {
            $fail("Custom bootstrap file not found: {$custom}");
        }

        require $custom;
    }
} catch (Throwable $throwable) {
    $fail(($framework === 'laravel' ? 'Failed to boot Laravel: ' : 'Failed to bootstrap: ') . $throwable->getMessage());
}

if (! \class_exists(Shell::class)) {
    $fail('PsySH is not installed in this project. Run: composer require --dev psy/psysh (Laravel apps usually get it from laravel/tinker).');
}

/**
 * Routes PsySH and echo output into protocol frames instead of stdout.
 * Declared after autoloading because its parent class lives in the host app.
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

if ($app !== null) {
    /**
     * Reports exceptions like the app's own handler but never renders them to
     * the console, which would write over the protocol stream when a run dies.
     */
    final class QuietExceptionHandler implements \Illuminate\Contracts\Debug\ExceptionHandler
    {
        public function __construct(private readonly \Illuminate\Contracts\Debug\ExceptionHandler $inner)
        {
        }

        public function report(Throwable $e)
        {
            $this->inner->report($e);
        }

        public function shouldReport(Throwable $e)
        {
            return $this->inner->shouldReport($e);
        }

        public function render($request, Throwable $e)
        {
            return $this->inner->render($request, $e);
        }

        public function renderForConsole($output, Throwable $e)
        {
        }
    }
}

$runtimeDir = \sys_get_temp_dir() . '/opentinker-' . \substr(\sha1($basePath), 0, 12);

if (! \is_dir($runtimeDir)) {
    @\mkdir($runtimeDir, 0700, true);
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
        'Illuminate\Database\Eloquent\Model' => 'Laravel\Tinker\TinkerCaster::castModel',
        'Illuminate\Process\ProcessResult' => 'Laravel\Tinker\TinkerCaster::castProcessResult',
        'Illuminate\Foundation\Application' => 'Laravel\Tinker\TinkerCaster::castApplication',
    ];

    $casters = \array_filter(
        $casters,
        static fn (string $class): bool => \class_exists($class),
        \ARRAY_FILTER_USE_KEY,
    );
    $config->getPresenter()->addCasters($casters);
} else {
    $casters = [];
}

$shell = new Shell($config);
$shell->setOutput(new ProtocolOutput($protocol));

$classMap = $basePath . '/vendor/composer/autoload_classmap.php';

if ($app !== null && \class_exists(\Laravel\Tinker\ClassAliasAutoloader::class) && \is_file($classMap)) {
    \Laravel\Tinker\ClassAliasAutoloader::register(
        $shell,
        $classMap,
        (array) \config('tinker.alias', []),
        (array) \config('tinker.dont_alias', [])
    );
}

$capture = new DumpCapture($protocol);
$capture->addCasters($casters);
$capture->install();

$sql = new SqlCollector;
$sql->register();

$hasDatabase = $app !== null && $app->bound('db');
$scopeReader = new ScopeReader($capture);
$runner = new Runner(
    $shell,
    $protocol,
    $capture,
    $sql,
    new ErrorFormatter($basePath, __FILE__),
    $scopeReader,
    $config->getCodeCleaner(),
    $hasDatabase,
);

$environment = $app !== null ? $app->environment() : ((string) (\getenv('APP_ENV') ?: 'unknown'));

$ready = [
    'type' => 'ready',
    'protocol' => Protocol::VERSION,
    'php' => \PHP_VERSION,
    'framework' => $framework,
    'laravel' => $app !== null ? $app->version() : null,
    'psysh' => \defined('Psy\Shell::VERSION') ? Shell::VERSION : 'unknown',
    'env' => $environment,
    'basePath' => $basePath,
    'pid' => \getmypid(),
    'capabilities' => [
        'fork' => Forker::supported(),
        'parser' => SourceCode::parser() !== null,
        'database' => $hasDatabase,
    ],
];

/** Close pooled connections before forking so parent and child never share a socket. */
$closeConnections = static function () use ($app): void {
    if ($app === null) {
        return;
    }

    foreach (['db', 'redis'] as $service) {
        if (! $app->resolved($service)) {
            continue;
        }

        try {
            $manager = $app->make($service);
            $open = \method_exists($manager, 'getConnections') ? $manager->getConnections() : $manager->connections();

            foreach (\array_keys((array) $open) as $name) {
                $manager->purge($name);
            }
        } catch (Throwable) {
            // Best effort; a missing driver just means nothing to close.
        }
    }
};

/** Runs one exec request; progress reports statements to a supervising parent. */
$execute = static function (array $run, ?callable $progress = null) use ($runner, $protocol): void {
    $runner->onStatement($progress);

    try {
        $runner->run([
            'id' => (string) ($run['id'] ?? ''),
            'code' => (string) ($run['code'] ?? ''),
            'mode' => ($run['mode'] ?? 'statements') === 'file' ? 'file' : 'statements',
            'imports' => \array_values(\array_filter(\array_slice((array) ($run['imports'] ?? []), 0, 100), 'is_string')),
            'rollback' => (bool) ($run['rollback'] ?? false),
            'fresh' => (bool) ($run['fresh'] ?? true),
        ]);
    } catch (Throwable $throwable) {
        $protocol->send([
            'type' => 'error',
            'id' => (string) ($run['id'] ?? ''),
            'ok' => false,
            'errorClass' => $throwable::class,
            'message' => $throwable->getMessage(),
            'scratchLine' => 1,
            'frames' => [],
            'ms' => 0,
        ]);
        $protocol->send(['type' => 'result', 'id' => (string) ($run['id'] ?? ''), 'ok' => false, 'failed' => true, 'statements' => 0, 'ms' => 0, 'memory' => \memory_get_usage(true)]);
    }
};

$forker = null;

/** @param array<string, mixed> $request */
$serviceRequest = static function (array $request, bool $busy) use (&$forker, $protocol, $shell, $scopeReader, $app, $basePath, $ready): void {
    $type = $request['type'] ?? null;
    $id = (string) ($request['id'] ?? '');

    if ($type === 'ping') {
        $protocol->send(['type' => 'pong', 'id' => $id] + $ready);

        return;
    }

    if ($busy) {
        // Anything else waits until the current run finishes.
        $protocol->defer($request);

        return;
    }

    if ($type === 'log') {
        $paths = $app !== null ? (\glob(\storage_path('logs/*.log')) ?: []) : [];
        \usort($paths, static fn (string $a, string $b): int => (@\filemtime($b) ?: 0) <=> (@\filemtime($a) ?: 0));
        $path = $paths[0] ?? '';
        $content = '';

        if ($path !== '' && ($file = @\fopen($path, 'rb')) !== false) {
            $size = @\filesize($path) ?: 0;
            \fseek($file, \max(0, $size - 131072));
            $content = \implode("\n", \array_slice(\explode("\n", \stream_get_contents($file) ?: ''), -200));
            \fclose($file);
        }

        $protocol->send(['type' => 'log', 'id' => $id, 'path' => $path, 'lines' => $content]);

        return;
    }

    if ($type === 'scope') {
        if ($forker !== null) {
            $forker->scope($id);
        } else {
            $protocol->send(['type' => 'scope', 'id' => $id] + $scopeReader->read($shell));
        }

        return;
    }

    if ($type === 'reset') {
        $forker?->resetSession();
        $protocol->send(['type' => 'reset', 'id' => $id, 'ok' => $forker !== null]);

        return;
    }

    if ($type === 'imports') {
        $protocol->send([
            'type' => 'imports',
            'id' => $id,
            'statements' => FileImports::extract((string) ($request['source'] ?? ''), (int) ($request['line'] ?? 1)),
        ]);

        return;
    }

    if ($type === 'modelHints') {
        try {
            $protocol->send(['type' => 'modelHints', 'id' => $id] + ModelHints::generate($basePath));
        } catch (Throwable $throwable) {
            $protocol->send(['type' => 'modelHints', 'id' => $id, 'php' => '', 'count' => 0, 'skipped' => [$throwable->getMessage()]]);
        }

        return;
    }

    if ($type !== 'cancel') {
        $protocol->send(['type' => 'unsupported', 'id' => $id, 'request' => (string) $type]);
    }
};

/** Runs in each forked child before any user code. */
$prepareChild = static function () use ($app): void {
    \ini_set('display_errors', '0');

    if ($app !== null && $app->bound(\Illuminate\Contracts\Debug\ExceptionHandler::class)) {
        try {
            $app->instance(
                \Illuminate\Contracts\Debug\ExceptionHandler::class,
                new QuietExceptionHandler($app->make(\Illuminate\Contracts\Debug\ExceptionHandler::class)),
            );
        } catch (Throwable) {
            // Keep the app's handler if it cannot be wrapped.
        }
    }
};

if (Forker::supported()) {
    $forker = new Forker(
        $protocol,
        \Closure::fromCallable($prepareChild),
        \Closure::fromCallable($execute),
        \Closure::fromCallable($closeConnections),
        static fn (array $request) => $serviceRequest($request, true),
        static fn (string $id) => $protocol->send(['type' => 'scope', 'id' => $id] + $scopeReader->read($shell)),
    );
}

$protocol->send($ready);

while (true) {
    $request = $protocol->read();

    if ($request === null || ($request['type'] ?? null) === 'shutdown') {
        $forker?->shutdown();
        break;
    }

    if (($request['type'] ?? null) !== 'exec') {
        $serviceRequest($request, false);

        continue;
    }

    $fresh = (bool) ($request['fresh'] ?? true);

    if ($forker !== null && ($fresh ? $forker->runFresh($request) : $forker->runKept($request))) {
        continue;
    }

    // Without pcntl, runs share this process. The extension restarts the
    // worker before each fresh run, so a fresh run still starts clean.
    $execute($request);
}
