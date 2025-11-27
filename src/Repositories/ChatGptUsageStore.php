<?php

namespace App\Repositories;

interface ChatGptUsageStore
{
    public function record(array $snapshot): array;

    public function latest(): ?array;

    /**
     * @return array<int, array<string, mixed>>
     */
    public function history(?string $since = null): array;
}
