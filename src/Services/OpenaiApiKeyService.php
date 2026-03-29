<?php

declare(strict_types=1);

namespace App\Services;

use App\Repositories\LogRepository;
use App\Repositories\OpenaiApiKeyRepository;

class OpenaiApiKeyService
{
    public function __construct(
        private readonly OpenaiApiKeyRepository $repository,
        private readonly LogRepository $logs
    ) {
    }

    /**
     * Generate a new API key. Returns ['key' => full key (shown once), 'record' => db row].
     */
    public function generate(string $name, ?int $adminUserId = null, int $rateLimitRpm = 60, ?string $expiresAt = null): array
    {
        $key = 'sk-coco-' . bin2hex(random_bytes(32));
        $record = $this->repository->create($key, $name, $adminUserId, $rateLimitRpm, $expiresAt);

        $this->logs->log(null, 'openai.key.create', [
            'key_id' => $record['id'] ?? null,
            'name' => $name,
            'admin_user_id' => $adminUserId,
        ]);

        return [
            'key' => $key,
            'record' => $record,
        ];
    }

    /**
     * Validate a bearer token. Returns the key record if valid, null otherwise.
     */
    public function validate(string $bearerToken): ?array
    {
        $record = $this->repository->findByKey($bearerToken);
        if ($record === null) {
            return null;
        }

        if (empty($record['is_active'])) {
            return null;
        }

        if (!empty($record['expires_at'])) {
            $now = gmdate(DATE_ATOM);
            if ($record['expires_at'] < $now) {
                return null;
            }
        }

        $this->repository->touch((int) $record['id']);

        return $record;
    }

    /**
     * List all keys (without encrypted values).
     */
    public function list(): array
    {
        return $this->repository->listAll();
    }

    public function toggleActive(int $id, bool $active): void
    {
        $this->repository->setActive($id, $active);

        $this->logs->log(null, $active ? 'openai.key.enable' : 'openai.key.disable', [
            'key_id' => $id,
        ]);
    }

    public function delete(int $id): void
    {
        $this->repository->delete($id);

        $this->logs->log(null, 'openai.key.delete', [
            'key_id' => $id,
        ]);
    }
}
