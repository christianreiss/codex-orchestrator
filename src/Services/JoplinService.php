<?php

declare(strict_types=1);

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 * GitHub: https://github.com/christianreiss/codex-orchestrator
 */

namespace App\Services;

class JoplinService
{
    private readonly string $baseUrl;

    public function __construct(
        string $baseUrl,
        private readonly string $apiToken,
        private readonly float $timeoutSeconds = 10.0
    ) {
        $this->baseUrl = rtrim($baseUrl, '/');
    }

    /**
     * @return array{reachable: bool, reason: ?string, version: ?string}
     */
    public function testConnection(): array
    {
        $url = $this->buildUrl('/ping');
        [$status, $body] = $this->get($url);

        if ($status === 200) {
            $version = null;
            if (is_string($body) && trim($body) !== '') {
                $decoded = json_decode($body, true);
                if (is_array($decoded) && isset($decoded['version'])) {
                    $version = (string) $decoded['version'];
                }
            }

            return ['reachable' => true, 'reason' => null, 'version' => $version];
        }

        // Fallback: try listing notes
        $url = $this->buildUrl('/notes', ['limit' => '1']);
        [$status] = $this->get($url);

        if ($status === 200) {
            return ['reachable' => true, 'reason' => null, 'version' => null];
        }

        $reason = $status !== null ? 'Joplin returned HTTP ' . $status : 'Joplin is unreachable';

        return ['reachable' => false, 'reason' => $reason, 'version' => null];
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    public function listNotes(int $limit = 100): array
    {
        $notes = [];
        $page = 1;
        $fields = 'id,title,body,parent_id,updated_time';

        while (true) {
            $url = $this->buildUrl('/notes', [
                'fields' => $fields,
                'limit'  => $limit,
                'page'   => $page,
            ]);

            [$status, $body] = $this->get($url);

            if ($status !== 200 || !is_string($body)) {
                break;
            }

            $decoded = json_decode($body, true);
            if (!is_array($decoded)) {
                break;
            }

            $items = $decoded['items'] ?? $decoded;
            if (!is_array($items) || $items === []) {
                break;
            }

            foreach ($items as $item) {
                if (is_array($item)) {
                    $notes[] = $item;
                }
            }

            $hasMore = isset($decoded['has_more']) && $decoded['has_more'] === true;
            if (!$hasMore) {
                break;
            }

            $page++;
        }

        return $notes;
    }

    /**
     * @return array<string, mixed>|null
     */
    public function getNote(string $noteId): ?array
    {
        $url = $this->buildUrl('/notes/' . rawurlencode($noteId), [
            'fields' => 'id,title,body,parent_id,updated_time',
        ]);

        [$status, $body] = $this->get($url);

        if ($status !== 200 || !is_string($body)) {
            return null;
        }

        $decoded = json_decode($body, true);

        return is_array($decoded) ? $decoded : null;
    }

    /**
     * @param string[] $tags
     * @return array<string, mixed>|null
     */
    public function createNote(string $title, string $body, string $notebookId = '', array $tags = []): ?array
    {
        $payload = ['title' => $title, 'body' => $body];
        if ($notebookId !== '') {
            $payload['parent_id'] = $notebookId;
        }

        $url = $this->buildUrl('/notes');
        [$status, $responseBody] = $this->sendWithBody('POST', $url, $payload);

        if ($status !== 200 && $status !== 201) {
            return null;
        }

        if (!is_string($responseBody)) {
            return null;
        }

        $note = json_decode($responseBody, true);
        if (!is_array($note)) {
            return null;
        }

        if ($tags !== [] && isset($note['id'])) {
            $this->setNoteTags($note['id'], $tags);
        }

        return $note;
    }

    /**
     * @return array<string, mixed>|null
     */
    public function updateNote(string $noteId, ?string $title = null, ?string $body = null, ?string $notebookId = null): ?array
    {
        $payload = [];
        if ($title !== null) {
            $payload['title'] = $title;
        }
        if ($body !== null) {
            $payload['body'] = $body;
        }
        if ($notebookId !== null) {
            $payload['parent_id'] = $notebookId;
        }

        if ($payload === []) {
            return $this->getNote($noteId);
        }

        $url = $this->buildUrl('/notes/' . rawurlencode($noteId));
        [$status, $responseBody] = $this->sendWithBody('PUT', $url, $payload);

        if ($status !== 200 && $status !== 204) {
            return null;
        }

        if (!is_string($responseBody) || $responseBody === '') {
            return $this->getNote($noteId);
        }

        $decoded = json_decode($responseBody, true);

        return is_array($decoded) ? $decoded : $this->getNote($noteId);
    }

    public function deleteNote(string $noteId): bool
    {
        $url = $this->buildUrl('/notes/' . rawurlencode($noteId));
        [$status] = $this->delete($url);

        return $status === 200 || $status === 204;
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    public function listNotebooks(): array
    {
        $url = $this->buildUrl('/notebooks', ['fields' => 'id,title,parent_id']);
        [$status, $body] = $this->get($url);

        if ($status !== 200 || !is_string($body)) {
            return [];
        }

        $decoded = json_decode($body, true);
        if (!is_array($decoded)) {
            return [];
        }

        $items = $decoded['items'] ?? $decoded;

        return is_array($items) ? array_values(array_filter($items, 'is_array')) : [];
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    public function search(string $query, int $limit = 20): array
    {
        $url = $this->buildUrl('/search', [
            'query'  => $query,
            'type'   => 'note',
            'fields' => 'id,title,body,parent_id',
            'limit'  => $limit,
        ]);

        [$status, $body] = $this->get($url);

        if ($status !== 200 || !is_string($body)) {
            return [];
        }

        $decoded = json_decode($body, true);
        if (!is_array($decoded)) {
            return [];
        }

        $items = $decoded['items'] ?? $decoded;

        return is_array($items) ? array_values(array_filter($items, 'is_array')) : [];
    }

    /**
     * @return string[]
     */
    public function getNoteTags(string $noteId): array
    {
        $url = $this->buildUrl('/notes/' . rawurlencode($noteId) . '/tags');
        [$status, $body] = $this->get($url);

        if ($status !== 200 || !is_string($body)) {
            return [];
        }

        $decoded = json_decode($body, true);
        if (!is_array($decoded)) {
            return [];
        }

        $items = $decoded['items'] ?? $decoded;
        if (!is_array($items)) {
            return [];
        }

        $names = [];
        foreach ($items as $tag) {
            if (is_array($tag) && isset($tag['title']) && is_string($tag['title'])) {
                $names[] = $tag['title'];
            }
        }

        return $names;
    }

    /**
     * @param string[] $tagNames
     */
    public function setNoteTags(string $noteId, array $tagNames): bool
    {
        $allTags = $this->fetchAllTags();
        $success = true;

        foreach ($tagNames as $tagName) {
            $tagName = trim($tagName);
            if ($tagName === '') {
                continue;
            }

            $tagId = $this->findOrCreateTag($tagName, $allTags);
            if ($tagId === null) {
                $success = false;
                continue;
            }

            $url = $this->buildUrl('/tags/' . rawurlencode($tagId) . '/notes');
            [$status] = $this->sendWithBody('POST', $url, ['id' => $noteId]);

            if ($status !== 200 && $status !== 201) {
                $success = false;
            }
        }

        return $success;
    }

    /**
     * @return array<string, string> Map of lowercase tag name => tag ID
     */
    private function fetchAllTags(): array
    {
        $url = $this->buildUrl('/tags', ['fields' => 'id,title']);
        [$status, $body] = $this->get($url);

        if ($status !== 200 || !is_string($body)) {
            return [];
        }

        $decoded = json_decode($body, true);
        if (!is_array($decoded)) {
            return [];
        }

        $items = $decoded['items'] ?? $decoded;
        if (!is_array($items)) {
            return [];
        }

        $map = [];
        foreach ($items as $tag) {
            if (is_array($tag) && isset($tag['id'], $tag['title'])) {
                $map[strtolower((string) $tag['title'])] = (string) $tag['id'];
            }
        }

        return $map;
    }

    /**
     * @param array<string, string> $existingTags
     */
    private function findOrCreateTag(string $tagName, array &$existingTags): ?string
    {
        $key = strtolower($tagName);
        if (isset($existingTags[$key])) {
            return $existingTags[$key];
        }

        $url = $this->buildUrl('/tags');
        [$status, $body] = $this->sendWithBody('POST', $url, ['title' => $tagName]);

        if (($status !== 200 && $status !== 201) || !is_string($body)) {
            return null;
        }

        $decoded = json_decode($body, true);
        if (!is_array($decoded) || !isset($decoded['id'])) {
            return null;
        }

        $tagId = (string) $decoded['id'];
        $existingTags[$key] = $tagId;

        return $tagId;
    }

    /**
     * @param array<string, mixed> $params
     */
    private function buildUrl(string $path, array $params = []): string
    {
        $params['token'] = $this->apiToken;

        return $this->baseUrl . $path . '?' . http_build_query($params);
    }

    /**
     * @return array{int|null, string|false}
     */
    private function get(string $url): array
    {
        $context = stream_context_create([
            'http' => [
                'method'        => 'GET',
                'header'        => "Accept: application/json\r\n",
                'timeout'       => $this->timeoutSeconds,
                'ignore_errors' => true,
            ],
        ]);

        $response = @file_get_contents($url, false, $context);
        $status = $this->extractStatus($http_response_header ?? []);

        return [$status, $response];
    }

    /**
     * @param array<string, mixed> $payload
     * @return array{int|null, string|false}
     */
    private function sendWithBody(string $method, string $url, array $payload): array
    {
        $body = json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if ($body === false) {
            error_log('[JoplinService] Failed to JSON-encode ' . $method . ' payload for ' . $url);

            return [null, false];
        }

        $context = stream_context_create([
            'http' => [
                'method'        => $method,
                'header'        => "Content-Type: application/json\r\nAccept: application/json\r\n",
                'content'       => $body,
                'timeout'       => $this->timeoutSeconds,
                'ignore_errors' => true,
            ],
        ]);

        $response = @file_get_contents($url, false, $context);
        $status = $this->extractStatus($http_response_header ?? []);

        return [$status, $response];
    }

    /**
     * @return array{int|null, string|false}
     */
    private function delete(string $url): array
    {
        $context = stream_context_create([
            'http' => [
                'method'        => 'DELETE',
                'timeout'       => $this->timeoutSeconds,
                'ignore_errors' => true,
            ],
        ]);

        $response = @file_get_contents($url, false, $context);
        $status = $this->extractStatus($http_response_header ?? []);

        return [$status, $response];
    }

    /**
     * @param mixed[] $headers
     */
    private function extractStatus(array $headers): ?int
    {
        if (isset($headers[0]) && preg_match('#\s(\d{3})\s#', (string) $headers[0], $m)) {
            return (int) $m[1];
        }

        return null;
    }
}
