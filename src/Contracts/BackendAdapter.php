<?php

declare(strict_types=1);

namespace App\Contracts;

interface BackendAdapter
{
    /**
     * @param array<int, array{role: string, content: string|array<int, array<string, mixed>>}> $messages
     */
    public function chatCompletions(array $messages, string $model): array;

    public function completions(string $prompt, string $model): array;

    /**
     * @param string|string[] $input
     */
    public function embeddings(array|string $input, string $model): array;

    public function models(): array;
}
