<?php

declare(strict_types=1);

namespace OpenTinker;

use Throwable;

/**
 * Keeps a run's outbound side effects inside the process. Every mailer sends
 * into a capture transport (including mailers the app resolved while booting),
 * and notifications, jobs and Laravel HTTP client calls go to Laravel's own
 * fakes. After each statement, collect() reports what was captured since the
 * last call. restore() puts the real implementations back, so a kept session
 * only has fakes while a run asks for them.
 */
final class SideEffects
{
    private const MAX_HTML = 262144;
    private const MAX_SUMMARY = 300;
    private const CAPTURE = 'opentinker-capture';

    private ?object $capture = null;
    /** @var array<string, mixed>|null */
    private ?array $mailConfig = null;
    /** @var list<string> */
    private array $mailersBefore = [];
    /** @var list<array{0: object, 1: object}> mailer and its real transport */
    private array $mailers = [];
    /** @var array<class-string, object> facade => real root */
    private array $originals = [];
    /** @var array<class-string, object> facade => fake */
    private array $fakes = [];
    /** @var array<string, true> */
    private array $reported = [];
    private int $mailReported = 0;
    private int $httpReported = 0;

    /** Whether this app can fake everything install() fakes. */
    public static function available(): bool
    {
        try {
            return function_exists('app')
                && app()->bound('mail.manager')
                && class_exists(\Illuminate\Mail\Transport\ArrayTransport::class)
                && class_exists(\Illuminate\Support\Testing\Fakes\NotificationFake::class)
                && class_exists(\Illuminate\Support\Testing\Fakes\BusFake::class)
                && class_exists(\Illuminate\Support\Testing\Fakes\QueueFake::class)
                && method_exists(\Illuminate\Http\Client\Factory::class, 'fake');
        } catch (Throwable) {
            return false;
        }
    }

    /** Installs every fake, or none: a partial install is undone and the error rethrown. */
    public function install(): void
    {
        try {
            $this->captureMail();
            $this->fake(\Illuminate\Support\Facades\Notification::class, static fn () => \Illuminate\Support\Facades\Notification::fake());
            $this->fake(\Illuminate\Support\Facades\Bus::class, static fn () => \Illuminate\Support\Facades\Bus::fake());
            $this->fake(\Illuminate\Support\Facades\Queue::class, static fn () => \Illuminate\Support\Facades\Queue::fake());
            // Http::fake() changes the app's own client factory, so fake a separate one.
            $this->fake(\Illuminate\Support\Facades\Http::class, static function (): object {
                $factory = new \Illuminate\Http\Client\Factory(app('events'));
                $factory->fake();
                \Illuminate\Support\Facades\Http::swap($factory);

                return $factory;
            });
        } catch (Throwable $error) {
            $this->restore();

            throw $error;
        }
    }

    /**
     * What was captured since the last call.
     *
     * @return list<array{kind: string, summary: string, html?: string}>
     */
    public function collect(): array
    {
        $found = [];
        foreach (['mail', 'notifications', 'jobs', 'http'] as $kind) {
            try {
                array_push($found, ...match ($kind) {
                    'mail' => $this->collectMail(),
                    'notifications' => $this->collectNotifications(),
                    'jobs' => $this->collectJobs(),
                    'http' => $this->collectHttp(),
                });
            } catch (Throwable) {
                // Reading what a fake recorded must never fail a run.
            }
        }

        return $found;
    }

    /** Puts the real mailers, notifications, bus, queue and HTTP client back. */
    public function restore(): void
    {
        foreach ($this->originals as $facade => $original) {
            try {
                $facade::swap($original);
            } catch (Throwable) {
            }
        }
        $this->originals = [];
        $this->fakes = [];

        if ($this->mailConfig !== null) {
            try {
                config(['mail.mailers' => $this->mailConfig]);
                foreach ($this->mailers as [$mailer, $transport]) {
                    $mailer->setSymfonyTransport($transport);
                }
                // Mailers first resolved during the run captured too; resolve them for real next time.
                $manager = app('mail.manager');
                foreach (array_keys($this->resolvedMailers($manager)) as $name) {
                    if (! in_array($name, $this->mailersBefore, true)) {
                        $manager->purge($name);
                    }
                }
            } catch (Throwable) {
            }
        }
        $this->mailConfig = null;
        $this->mailers = [];
        $this->capture = null;
    }

    private function fake(string $facade, callable $install): void
    {
        $original = $facade::getFacadeRoot();
        $fake = $install();
        $this->originals[$facade] = $original;
        $this->fakes[$facade] = $fake;
    }

    private function captureMail(): void
    {
        $manager = app('mail.manager');
        $capture = new \Illuminate\Mail\Transport\ArrayTransport();
        $manager->extend(self::CAPTURE, static fn () => $capture);

        $config = config('mail.mailers', []);
        $this->mailConfig = is_array($config) ? $config : [];
        $captured = [];
        foreach ($this->mailConfig as $name => $mailer) {
            $captured[$name] = array_merge(is_array($mailer) ? $mailer : [], ['transport' => self::CAPTURE]);
        }
        config(['mail.mailers' => $captured]);

        // Mailers resolved while booting may be held by app services, so change them in place.
        $resolved = $this->resolvedMailers($manager);
        $this->mailersBefore = array_map('strval', array_keys($resolved));
        foreach ($resolved as $mailer) {
            $this->mailers[] = [$mailer, $mailer->getSymfonyTransport()];
            $mailer->setSymfonyTransport($capture);
        }
        $this->capture = $capture;
    }

    /** @return array<string, object> */
    private function resolvedMailers(object $manager): array
    {
        $mailers = (fn () => $this->mailers ?? [])->call($manager);

        return is_array($mailers) ? $mailers : [];
    }

    /** @return list<array{kind: string, summary: string, html?: string}> */
    private function collectMail(): array
    {
        if ($this->capture === null) {
            return [];
        }
        $messages = array_values($this->capture->messages()->all());
        $found = [];
        for ($index = $this->mailReported; $index < count($messages); $index++) {
            $email = $messages[$index]->getOriginalMessage();
            $found[] = $this->describeEmail($email);
        }
        $this->mailReported = count($messages);

        return $found;
    }

    /** @return array{kind: string, summary: string, html?: string} */
    private function describeEmail(object $email): array
    {
        $subject = method_exists($email, 'getSubject') ? (string) $email->getSubject() : '';
        $to = method_exists($email, 'getTo')
            ? implode(', ', array_map(static fn ($address) => $address->getAddress(), $email->getTo()))
            : '';
        $effect = [
            'kind' => 'mail',
            'summary' => $this->limit(trim(($subject !== '' ? '"' . $subject . '"' : 'Email') . ($to !== '' ? ' to ' . $to : ''))),
        ];
        $html = method_exists($email, 'getHtmlBody') ? $email->getHtmlBody() : null;
        if (is_resource($html)) {
            $html = stream_get_contents($html);
        }
        if (! is_string($html) || $html === '') {
            $text = method_exists($email, 'getTextBody') ? $email->getTextBody() : null;
            $html = is_string($text) && $text !== '' ? '<pre>' . htmlspecialchars($text) . '</pre>' : null;
        }
        if (is_string($html) && strlen($html) <= self::MAX_HTML) {
            $effect['html'] = $html;
        }

        return $effect;
    }

    /** @return list<array{kind: string, summary: string, html?: string}> */
    private function collectNotifications(): array
    {
        $fake = $this->fakes[\Illuminate\Support\Facades\Notification::class] ?? null;
        if ($fake === null) {
            return [];
        }
        $found = [];
        foreach ($fake->sentNotifications() as $notifiableClass => $byKey) {
            foreach ($byKey as $key => $byNotification) {
                foreach ($byNotification as $notificationClass => $sends) {
                    foreach (array_values($sends) as $index => $send) {
                        $id = "notification|{$notificationClass}|{$notifiableClass}|{$key}#{$index}";
                        if (isset($this->reported[$id])) {
                            continue;
                        }
                        $this->reported[$id] = true;
                        $found[] = $this->describeNotification($send, (string) $notifiableClass, (string) $key, (string) $notificationClass);
                    }
                }
            }
        }

        return $found;
    }

    /**
     * @param array<string, mixed> $send
     * @return array{kind: string, summary: string, html?: string}
     */
    private function describeNotification(array $send, string $notifiableClass, string $key, string $notificationClass): array
    {
        $notifiable = $send['notifiable'] ?? null;
        $channels = array_map('strval', (array) ($send['channels'] ?? []));
        $to = $notifiable instanceof \Illuminate\Notifications\AnonymousNotifiable
            ? implode(', ', array_map(static fn ($route) => is_scalar($route) ? (string) $route : get_debug_type($route), $notifiable->routes))
            : $notifiableClass . ($key !== '' ? ' #' . $key : '');
        $effect = [
            'kind' => 'notification',
            'summary' => $this->limit("{$notificationClass} to {$to}" . ($channels ? ' via ' . implode(', ', $channels) : '')),
        ];

        $notification = $send['notification'] ?? null;
        if (in_array('mail', $channels, true) && is_object($notification) && method_exists($notification, 'toMail')) {
            try {
                $mail = $notification->toMail($notifiable);
                $html = is_object($mail) && method_exists($mail, 'render') ? (string) $mail->render() : '';
                if ($html !== '' && strlen($html) <= self::MAX_HTML) {
                    $effect['html'] = $html;
                }
            } catch (Throwable) {
            }
        }

        return $effect;
    }

    /** @return list<array{kind: string, summary: string, html?: string}> */
    private function collectJobs(): array
    {
        $found = [];
        $bus = $this->fakes[\Illuminate\Support\Facades\Bus::class] ?? null;
        if ($bus !== null) {
            $lists = (fn () => [
                'queued' => $this->commands ?? [],
                'sync' => $this->commandsSync ?? [],
                'after response' => $this->commandsAfterResponse ?? [],
            ])->call($bus);
            foreach ($lists as $list => $byClass) {
                foreach ($byClass as $class => $jobs) {
                    foreach (array_values($jobs) as $index => $job) {
                        $id = "bus|{$list}|{$class}#{$index}";
                        if (! isset($this->reported[$id])) {
                            $this->reported[$id] = true;
                            $found[] = $this->describeJob($job, $list === 'queued' ? '' : $list);
                        }
                    }
                }
            }
            $batches = (fn () => $this->batches ?? [])->call($bus);
            foreach (array_values(is_array($batches) ? $batches : []) as $index => $batch) {
                $id = "batch#{$index}";
                if (! isset($this->reported[$id])) {
                    $this->reported[$id] = true;
                    $count = is_object($batch) && isset($batch->jobs) && is_countable($batch->jobs) ? count($batch->jobs) : 0;
                    $found[] = ['kind' => 'job', 'summary' => "Batch of {$count} " . ($count === 1 ? 'job' : 'jobs')];
                }
            }
        }

        $queue = $this->fakes[\Illuminate\Support\Facades\Queue::class] ?? null;
        if ($queue !== null) {
            foreach ($queue->pushedJobs() as $class => $pushes) {
                foreach (array_values($pushes) as $index => $push) {
                    $id = "queue|{$class}#{$index}";
                    if (! isset($this->reported[$id])) {
                        $this->reported[$id] = true;
                        $found[] = $this->describeJob($push['job'] ?? $class, '', is_string($push['queue'] ?? null) ? $push['queue'] : '');
                    }
                }
            }
        }

        return $found;
    }

    /** @return array{kind: string, summary: string} */
    private function describeJob(mixed $job, string $how, string $queue = ''): array
    {
        $summary = match (true) {
            $job instanceof \Illuminate\Mail\SendQueuedMailable => 'Queued mail ' . get_class($job->mailable)
                . $this->recipients($job->mailable),
            $job instanceof \Illuminate\Events\CallQueuedListener => 'Queued listener ' . $job->class,
            $job instanceof \Illuminate\Broadcasting\BroadcastEvent => 'Broadcast ' . get_class($job->event),
            $job instanceof \Illuminate\Queue\CallQueuedClosure => 'Closure job',
            is_object($job) => get_class($job),
            default => (string) $job,
        };
        if ($queue === '' && is_object($job) && isset($job->queue) && is_string($job->queue)) {
            $queue = $job->queue;
        }
        $details = array_filter([$how, $queue !== '' ? "queue {$queue}" : '']);

        return [
            'kind' => 'job',
            'summary' => $this->limit($summary . ($details ? ' (' . implode(', ', $details) . ')' : '')),
        ];
    }

    private function recipients(object $mailable): string
    {
        $to = isset($mailable->to) && is_array($mailable->to)
            ? array_filter(array_map(static fn ($recipient) => is_array($recipient) ? ($recipient['address'] ?? '') : '', $mailable->to))
            : [];

        return $to ? ' to ' . implode(', ', $to) : '';
    }

    /** @return list<array{kind: string, summary: string}> */
    private function collectHttp(): array
    {
        $http = $this->fakes[\Illuminate\Support\Facades\Http::class] ?? null;
        if ($http === null) {
            return [];
        }
        $recorded = array_values($http->recorded()->all());
        $found = [];
        for ($index = $this->httpReported; $index < count($recorded); $index++) {
            [$request] = $recorded[$index];
            $found[] = ['kind' => 'http', 'summary' => $this->limit($request->method() . ' ' . $request->url())];
        }
        $this->httpReported = count($recorded);

        return $found;
    }

    private function limit(string $text): string
    {
        return strlen($text) > self::MAX_SUMMARY ? substr($text, 0, self::MAX_SUMMARY - 3) . '...' : $text;
    }
}
