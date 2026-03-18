<?php

declare(strict_types=1);

namespace App\Support;

final class WorkerHeartbeat
{
    private \Closure $clock;

    public function __construct(
        private readonly string $path,
        ?callable $clock = null
    ) {
        $this->clock = $clock instanceof \Closure
            ? $clock
            : \Closure::fromCallable($clock ?? static fn (): int => time());
    }

    public function recordAttempt(string $state = 'running'): void
    {
        $data = $this->read() ?? [];
        $data['state'] = $state;
        $data['last_attempt_at'] = $this->nowIso();
        $this->write($data);
    }

    public function recordSuccess(array $meta = []): void
    {
        $data = $this->read() ?? [];
        $now = $this->nowIso();
        $data = array_merge($data, $meta);
        $data['state'] = 'ok';
        $data['last_attempt_at'] = $now;
        $data['last_success_at'] = $now;
        $data['last_error'] = null;
        $this->write($data);
    }

    public function recordFailure(string $message): void
    {
        $data = $this->read() ?? [];
        $now = $this->nowIso();
        $data['state'] = 'fail';
        $data['last_attempt_at'] = $now;
        $data['last_failure_at'] = $now;
        $data['last_error'] = $message;
        $this->write($data);
    }

    public function read(): ?array
    {
        if ($this->path === '' || !is_file($this->path)) {
            return null;
        }

        $raw = @file_get_contents($this->path);
        if (!is_string($raw) || trim($raw) === '') {
            return null;
        }

        $decoded = json_decode($raw, true);
        if (!is_array($decoded)) {
            return null;
        }

        return $decoded;
    }

    /**
     * @return array{healthy: bool, reason: string, data: ?array}
     */
    public function evaluateHealth(int $maxAgeSeconds, int $startupGraceSeconds = 120): array
    {
        $data = $this->read();
        if ($data === null) {
            return [
                'healthy' => false,
                'reason' => 'missing_heartbeat',
                'data' => null,
            ];
        }

        $now = ($this->clock)();
        $lastSuccessAt = $this->parseIso($data['last_success_at'] ?? null);
        if ($lastSuccessAt !== null) {
            $successAge = max(0, $now - $lastSuccessAt);
            if ($successAge <= $maxAgeSeconds) {
                return [
                    'healthy' => true,
                    'reason' => 'fresh_success',
                    'data' => $data,
                ];
            }

            return [
                'healthy' => false,
                'reason' => 'stale_success',
                'data' => $data,
            ];
        }

        $lastAttemptAt = $this->parseIso($data['last_attempt_at'] ?? null);
        if ($lastAttemptAt !== null) {
            $attemptAge = max(0, $now - $lastAttemptAt);
            if ($attemptAge <= $startupGraceSeconds) {
                return [
                    'healthy' => true,
                    'reason' => 'startup_grace',
                    'data' => $data,
                ];
            }
        }

        return [
            'healthy' => false,
            'reason' => 'no_success_yet',
            'data' => $data,
        ];
    }

    private function write(array $data): void
    {
        if ($this->path === '') {
            return;
        }

        $directory = dirname($this->path);
        if ($directory !== '' && $directory !== '.' && !is_dir($directory)) {
            @mkdir($directory, 0775, true);
        }

        $tmpPath = $this->path . '.' . getmypid() . '.tmp';
        $payload = json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
        if ($payload === false) {
            return;
        }

        if (@file_put_contents($tmpPath, $payload . PHP_EOL) === false) {
            return;
        }

        @rename($tmpPath, $this->path);
    }

    private function parseIso(mixed $value): ?int
    {
        if (!is_string($value) || trim($value) === '') {
            return null;
        }

        $timestamp = strtotime($value);
        return $timestamp === false ? null : $timestamp;
    }

    private function nowIso(): string
    {
        return gmdate(DATE_ATOM, ($this->clock)());
    }
}
