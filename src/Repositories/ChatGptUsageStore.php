<?php

namespace App\Repositories;

interface ChatGptUsageStore
{
    public function record(array $snapshot): array;

    public function latest(): ?array;
}
