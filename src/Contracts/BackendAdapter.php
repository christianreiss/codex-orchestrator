<?php

declare(strict_types=1);

namespace App\Contracts;

interface BackendAdapter
{
    /**
     * @param array<int, array{role: string, content: string|array<int, array<string, mixed>>}> $messages
     */
    public function chatCompletions(array $messages, string $model, array $params = []): array;

    /**
     * @param array<int, array{role: string, content: string|array<int, array<string, mixed>>}> $messages
     * @return array{id: string, type: string, role: string, content: list<array<string, mixed>>, model: string, stop_reason: string, stop_sequence: ?string, usage: array<string, int>}
     */
    public function messages(array $messages, string $model, array $params = []): array;

    public function completions(string $prompt, string $model, array $params = []): array;

    /**
     * @param string|string[] $input
     */
    public function embeddings(array|string $input, string $model): array;

    public function models(): array;
}
