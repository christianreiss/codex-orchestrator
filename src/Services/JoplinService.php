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
    private const TYPE_NOTE = 1;
    private const TYPE_FOLDER = 2;
    private const TYPE_TAG = 5;
    private const TYPE_NOTE_TAG = 6;

    private readonly string $baseUrl;
    private ?string $sessionId = null;

    /**
     * @var array{
     *   items: array<int, array<string, mixed>>,
     *   notes: array<int, array<string, mixed>>,
     *   notebooks: array<int, array<string, mixed>>,
     *   tags_by_id: array<string, string>,
     *   note_tag_links_by_note_id: array<string, array<int, array<string, mixed>>>
     * }|null
     */
    private ?array $snapshotCache = null;

    public function __construct(
        string $baseUrl,
        private readonly string $email,
        private readonly string $password,
        private readonly float $timeoutSeconds = 10.0
    ) {
        $this->baseUrl = rtrim($baseUrl, '/');
    }

    /**
     * @return array{reachable: bool, reason: ?string, version: ?string}
     */
    public function testConnection(): array
    {
        try {
            $this->ensureSession();
            [$status, $body] = $this->request('GET', '/api/items/root/children', ['limit' => '1']);
            if ($status === 200) {
                return ['reachable' => true, 'reason' => null, 'version' => null];
            }

            return [
                'reachable' => false,
                'reason' => $this->formatHttpError('Joplin returned an unexpected response', $status, $body),
                'version' => null,
            ];
        } catch (\Throwable $exception) {
            return ['reachable' => false, 'reason' => $exception->getMessage(), 'version' => null];
        }
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    public function listNotes(int $limit = 100): array
    {
        $notes = $this->snapshot()['notes'];
        if ($limit > 0 && count($notes) > $limit) {
            return array_slice($notes, 0, $limit);
        }

        return $notes;
    }

    /**
     * @return array<string, mixed>|null
     */
    public function getNote(string $noteId): ?array
    {
        $noteId = trim($noteId);
        if ($noteId === '') {
            return null;
        }

        foreach ($this->snapshot()['notes'] as $note) {
            if ((string) ($note['id'] ?? '') === $noteId) {
                return $note;
            }
        }

        return null;
    }

    /**
     * @param string[] $tags
     * @return array<string, mixed>|null
     */
    public function createNote(string $title, string $body, string $notebookId = '', array $tags = []): ?array
    {
        $title = trim($title);
        if ($title === '') {
            return null;
        }

        $snapshot = $this->snapshot();
        $parentPath = $this->folderPathById($snapshot, $notebookId);
        if ($notebookId !== '' && $parentPath === null) {
            return null;
        }

        $noteId = $this->newItemId();
        $pathName = ($parentPath !== null && $parentPath !== '' ? $parentPath . '/' : '') . $noteId . '.md';
        $timestamp = gmdate('Y-m-d\TH:i:s.000\Z');
        $order = (string) round(microtime(true) * 1000);
        $item = [
            'id' => $noteId,
            'parent_id' => $notebookId,
            'created_time' => $timestamp,
            'updated_time' => $timestamp,
            'user_created_time' => $timestamp,
            'user_updated_time' => $timestamp,
            'is_conflict' => '0',
            'latitude' => '0.00000000',
            'longitude' => '0.00000000',
            'altitude' => '0.0000',
            'author' => '',
            'source_url' => '',
            'is_todo' => '0',
            'todo_due' => '0',
            'todo_completed' => '0',
            'source' => 'joplin',
            'source_application' => 'codex-orchestrator',
            'application_data' => '',
            'order' => $order,
            'encryption_cipher_text' => '',
            'encryption_applied' => '0',
            'markup_language' => '1',
            'is_shared' => '0',
            'type_' => self::TYPE_NOTE,
            'title' => $title,
            'body' => $body,
        ];

        $this->putSerializedItem($pathName, $this->serializeItem($item));
        $this->invalidateCache();

        if ($tags !== [] && !$this->setNoteTags($noteId, $tags)) {
            return $this->getNote($noteId);
        }

        return $this->getNote($noteId);
    }

    /**
     * @return array<string, mixed>|null
     */
    public function updateNote(string $noteId, ?string $title = null, ?string $body = null, ?string $notebookId = null): ?array
    {
        $snapshot = $this->snapshot();
        $existing = $this->findSnapshotItem($snapshot, self::TYPE_NOTE, $noteId);
        if ($existing === null) {
            return null;
        }

        $targetNotebookId = $notebookId ?? (string) ($existing['parent_id'] ?? '');
        $parentPath = $this->folderPathById($snapshot, $targetNotebookId);
        if ($targetNotebookId !== '' && $parentPath === null) {
            return null;
        }

        $updated = $existing;
        if ($title !== null) {
            $updated['title'] = $title;
        }
        if ($body !== null) {
            $updated['body'] = $body;
        }
        if ($notebookId !== null) {
            $updated['parent_id'] = $targetNotebookId;
        }

        $timestamp = gmdate('Y-m-d\TH:i:s.000\Z');
        $updated['updated_time'] = $timestamp;
        $updated['user_updated_time'] = $timestamp;
        $updated['path_name'] = ($parentPath !== null && $parentPath !== '' ? $parentPath . '/' : '') . $noteId . '.md';

        $this->putSerializedItem((string) $updated['path_name'], $this->serializeItem($updated));
        $this->invalidateCache();

        return $this->getNote($noteId);
    }

    public function deleteNote(string $noteId): bool
    {
        $snapshot = $this->snapshot();
        $existing = $this->findSnapshotItem($snapshot, self::TYPE_NOTE, $noteId);
        if ($existing === null || !isset($existing['path_name'])) {
            return false;
        }

        [$status] = $this->request('DELETE', '/api/items/root:/' . (string) $existing['path_name'] . ':');
        if ($status !== 200 && $status !== 204) {
            return false;
        }

        $this->invalidateCache();

        return true;
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    public function listNotebooks(): array
    {
        return $this->snapshot()['notebooks'];
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    public function search(string $query, int $limit = 20): array
    {
        $needle = mb_strtolower(trim($query));
        if ($needle === '') {
            return [];
        }

        $matches = [];
        foreach ($this->snapshot()['notes'] as $note) {
            $haystack = mb_strtolower((string) ($note['title'] ?? '') . "\n" . (string) ($note['body'] ?? ''));
            if (!str_contains($haystack, $needle)) {
                continue;
            }

            $matches[] = $note;
            if ($limit > 0 && count($matches) >= $limit) {
                break;
            }
        }

        return $matches;
    }

    /**
     * @return string[]
     */
    public function getNoteTags(string $noteId): array
    {
        $snapshot = $this->snapshot();
        $links = $snapshot['note_tag_links_by_note_id'][$noteId] ?? [];
        $tags = [];
        foreach ($links as $link) {
            $tagId = (string) ($link['tag_id'] ?? '');
            if ($tagId === '' || !isset($snapshot['tags_by_id'][$tagId])) {
                continue;
            }

            $tags[] = $snapshot['tags_by_id'][$tagId];
        }

        return array_values(array_unique(array_filter($tags, static fn($value) => $value !== '')));
    }

    /**
     * @param string[] $tagNames
     */
    public function setNoteTags(string $noteId, array $tagNames): bool
    {
        $snapshot = $this->snapshot();
        $note = $this->findSnapshotItem($snapshot, self::TYPE_NOTE, $noteId);
        if ($note === null) {
            return false;
        }

        $desired = [];
        foreach ($tagNames as $tagName) {
            $tagName = trim((string) $tagName);
            if ($tagName === '') {
                continue;
            }

            $desired[mb_strtolower($tagName)] = $tagName;
        }

        $existingLinks = $snapshot['note_tag_links_by_note_id'][$noteId] ?? [];
        $existingByLowerTitle = [];
        foreach ($existingLinks as $link) {
            $tagId = (string) ($link['tag_id'] ?? '');
            $title = (string) ($snapshot['tags_by_id'][$tagId] ?? '');
            if ($title === '') {
                continue;
            }

            $existingByLowerTitle[mb_strtolower($title)] = $link;
        }

        $changed = false;

        foreach ($desired as $lowerTitle => $originalTitle) {
            if (isset($existingByLowerTitle[$lowerTitle])) {
                continue;
            }

            $tagItem = $this->findTagByTitle($snapshot, $originalTitle);
            if ($tagItem === null) {
                $tagItem = $this->createTagItem($originalTitle);
                $changed = true;
            }

            if (!$this->createNoteTagLink($noteId, (string) $tagItem['id'])) {
                return false;
            }

            $changed = true;
        }

        foreach ($existingByLowerTitle as $lowerTitle => $link) {
            if (isset($desired[$lowerTitle])) {
                continue;
            }

            $pathName = (string) ($link['path_name'] ?? '');
            if ($pathName === '') {
                continue;
            }

            [$status] = $this->request('DELETE', '/api/items/root:/' . $pathName . ':');
            if ($status !== 200 && $status !== 204) {
                return false;
            }

            $changed = true;
        }

        if ($changed) {
            $this->invalidateCache();
        }

        return true;
    }

    private function invalidateCache(): void
    {
        $this->snapshotCache = null;
    }

    private function ensureSession(): string
    {
        if ($this->sessionId !== null && $this->sessionId !== '') {
            return $this->sessionId;
        }

        $email = trim($this->email);
        $password = $this->password;
        if ($this->baseUrl === '' || $email === '' || $password === '') {
            throw new \RuntimeException('Joplin URL, email, and password are required');
        }

        $body = http_build_query([
            'email' => $email,
            'password' => $password,
            'platform' => 'linux',
            'type' => 'codex-orchestrator',
            'version' => '2026-04-03',
        ], '', '&', PHP_QUERY_RFC3986);

        [$status, $response] = $this->request(
            'POST',
            '/api/sessions',
            [],
            $body,
            [
                'Content-Type' => 'application/x-www-form-urlencoded',
                'Accept' => 'application/json',
            ],
            false
        );

        if (($status !== 200 && $status !== 201) || !is_string($response) || trim($response) === '') {
            throw new \RuntimeException($this->formatHttpError('Could not create Joplin Server session', $status, $response));
        }

        $decoded = json_decode($response, true);
        $sessionId = is_array($decoded) ? trim((string) ($decoded['id'] ?? '')) : '';
        if ($sessionId === '') {
            throw new \RuntimeException('Joplin Server did not return a session id');
        }

        $this->sessionId = $sessionId;

        return $sessionId;
    }

    /**
     * @return array{
     *   items: array<int, array<string, mixed>>,
     *   notes: array<int, array<string, mixed>>,
     *   notebooks: array<int, array<string, mixed>>,
     *   tags_by_id: array<string, string>,
     *   note_tag_links_by_note_id: array<string, array<int, array<string, mixed>>>
     * }
     */
    private function snapshot(): array
    {
        if ($this->snapshotCache !== null) {
            return $this->snapshotCache;
        }

        $entries = $this->listAllItemEntries();
        $items = [];
        $tagsById = [];
        $noteTagLinksByNoteId = [];

        foreach ($entries as $entry) {
            $name = (string) ($entry['name'] ?? '');
            if ($name === '' || !str_ends_with($name, '.md')) {
                continue;
            }

            $content = $this->fetchSerializedItem($name);
            $item = $this->parseSerializedItem($content);
            if ($item === null || !isset($item['type_'], $item['id'])) {
                continue;
            }

            $item['path_name'] = $name;
            $items[] = $item;

            if ((int) $item['type_'] === self::TYPE_TAG) {
                $title = trim((string) ($item['title'] ?? ''));
                if ($title !== '') {
                    $tagsById[(string) $item['id']] = $title;
                }
            } elseif ((int) $item['type_'] === self::TYPE_NOTE_TAG) {
                $noteId = trim((string) ($item['note_id'] ?? ''));
                if ($noteId !== '') {
                    $noteTagLinksByNoteId[$noteId] ??= [];
                    $noteTagLinksByNoteId[$noteId][] = $item;
                }
            }
        }

        $notes = [];
        $notebooks = [];
        foreach ($items as $item) {
            $type = (int) ($item['type_'] ?? 0);
            if ($type === self::TYPE_NOTE) {
                $note = $item;
                $note['tags'] = [];
                foreach ($noteTagLinksByNoteId[(string) $item['id']] ?? [] as $link) {
                    $tagId = (string) ($link['tag_id'] ?? '');
                    if ($tagId !== '' && isset($tagsById[$tagId])) {
                        $note['tags'][] = $tagsById[$tagId];
                    }
                }
                $note['tags'] = array_values(array_unique($note['tags']));
                $notes[] = $note;
                continue;
            }

            if ($type === self::TYPE_FOLDER) {
                $notebooks[] = [
                    'id' => (string) ($item['id'] ?? ''),
                    'title' => (string) ($item['title'] ?? ''),
                    'parent_id' => (string) ($item['parent_id'] ?? ''),
                    'updated_time' => (string) ($item['updated_time'] ?? ''),
                    'path_name' => (string) ($item['path_name'] ?? ''),
                ];
            }
        }

        usort($notes, static function (array $left, array $right): int {
            return strcmp((string) ($right['updated_time'] ?? ''), (string) ($left['updated_time'] ?? ''));
        });

        usort($notebooks, static function (array $left, array $right): int {
            return strcasecmp((string) ($left['title'] ?? ''), (string) ($right['title'] ?? ''));
        });

        $this->snapshotCache = [
            'items' => $items,
            'notes' => $notes,
            'notebooks' => $notebooks,
            'tags_by_id' => $tagsById,
            'note_tag_links_by_note_id' => $noteTagLinksByNoteId,
        ];

        return $this->snapshotCache;
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    private function listAllItemEntries(): array
    {
        $entries = [];
        $page = 1;

        while (true) {
            [$status, $body] = $this->request('GET', '/api/items/root/children', [
                'limit' => '200',
                'page' => (string) $page,
            ]);

            if ($status !== 200 || !is_string($body) || trim($body) === '') {
                throw new \RuntimeException($this->formatHttpError('Could not list Joplin Server items', $status, $body));
            }

            $decoded = json_decode($body, true);
            if (!is_array($decoded)) {
                throw new \RuntimeException('Joplin Server returned invalid JSON while listing items');
            }

            $items = $decoded['items'] ?? [];
            if (!is_array($items) || $items === []) {
                break;
            }

            foreach ($items as $item) {
                if (is_array($item) && isset($item['name'])) {
                    $entries[] = $item;
                }
            }

            if (($decoded['has_more'] ?? false) !== true) {
                break;
            }

            $page++;
        }

        return $entries;
    }

    private function fetchSerializedItem(string $pathName): string
    {
        [$status, $body] = $this->request('GET', '/api/items/root:/' . $pathName . ':/content', [], null, [
            'Accept' => 'text/plain, application/json;q=0.9, */*;q=0.8',
        ]);

        if ($status !== 200 || !is_string($body)) {
            throw new \RuntimeException($this->formatHttpError('Could not fetch Joplin item content', $status, $body));
        }

        return $body;
    }

    /**
     * @return array<string, mixed>|null
     */
    private function parseSerializedItem(string $content): ?array
    {
        $lines = preg_split("/\r\n|\n|\r/", $content) ?: [];
        $props = [];
        $bodyLines = [];

        for ($i = count($lines) - 1; $i >= 0; $i--) {
            $line = trim($lines[$i]);
            if ($line === '') {
                $bodyLines = array_slice($lines, 0, $i);
                break;
            }

            $separator = strpos($line, ':');
            if ($separator === false) {
                return null;
            }

            $key = trim(substr($line, 0, $separator));
            $value = trim(substr($line, $separator + 1));
            $props[$key] = $value;
        }

        if (!isset($props['type_'])) {
            return null;
        }

        $props['type_'] = (int) $props['type_'];
        if ($bodyLines !== []) {
            $props['title'] = $bodyLines[0] ?? '';
            if (isset($bodyLines[1]) && $bodyLines[1] === '') {
                $bodyLines = array_slice($bodyLines, 2);
            } else {
                $bodyLines = array_slice($bodyLines, 1);
            }

            if ((int) $props['type_'] === self::TYPE_NOTE) {
                $props['body'] = implode("\n", $bodyLines);
            }
        }

        return $props;
    }

    /**
     * @param array<string, mixed> $item
     */
    private function serializeItem(array $item): string
    {
        $type = (int) ($item['type_'] ?? 0);
        $title = (string) ($item['title'] ?? '');
        $body = (string) ($item['body'] ?? '');

        $lines = [];
        if ($type === self::TYPE_NOTE || $type === self::TYPE_FOLDER || $type === self::TYPE_TAG) {
            $lines[] = $title;
            $lines[] = '';
            if ($type === self::TYPE_NOTE) {
                if ($body !== '') {
                    foreach (preg_split("/\r\n|\n|\r/", $body) ?: [] as $bodyLine) {
                        $lines[] = $bodyLine;
                    }
                }
                $lines[] = '';
            }
        }

        $propertyOrder = match ($type) {
            self::TYPE_NOTE => [
                'id', 'parent_id', 'created_time', 'updated_time', 'is_conflict',
                'latitude', 'longitude', 'altitude', 'author', 'source_url',
                'is_todo', 'todo_due', 'todo_completed', 'source', 'source_application',
                'application_data', 'order', 'user_created_time', 'user_updated_time',
                'encryption_cipher_text', 'encryption_applied', 'markup_language',
                'is_shared', 'type_',
            ],
            self::TYPE_FOLDER, self::TYPE_TAG => [
                'id', 'created_time', 'updated_time', 'user_created_time', 'user_updated_time',
                'encryption_cipher_text', 'encryption_applied', 'parent_id', 'is_shared', 'type_',
            ],
            self::TYPE_NOTE_TAG => [
                'id', 'note_id', 'tag_id', 'created_time', 'updated_time',
                'user_created_time', 'user_updated_time', 'encryption_cipher_text',
                'encryption_applied', 'is_shared', 'type_',
            ],
            default => array_keys($item),
        };

        foreach ($propertyOrder as $key) {
            if ($key === 'title' || $key === 'body' || !array_key_exists($key, $item)) {
                continue;
            }

            $lines[] = $key . ': ' . $this->serializePropertyValue($key, $item[$key]);
        }

        return implode("\n", $lines) . "\n";
    }

    private function serializePropertyValue(string $property, mixed $value): string
    {
        if ($value === null) {
            $stringValue = '';
        } else {
            $stringValue = (string) $value;
        }

        if ($property === 'body') {
            return $stringValue;
        }

        return str_replace(
            ["\\n", "\\r", "\n", "\r"],
            ['\\\\n', '\\\\r', '\\n', '\\r'],
            $stringValue
        );
    }

    private function putSerializedItem(string $pathName, string $serializedContent): void
    {
        $boundary = '--------------------------' . bin2hex(random_bytes(12));
        $filename = basename($pathName);
        $body = '--' . $boundary . "\r\n"
            . 'Content-Disposition: form-data; name="file"; filename="' . $filename . '"' . "\r\n"
            . "Content-Type: application/octet-stream\r\n\r\n"
            . $serializedContent . "\r\n"
            . '--' . $boundary . "--\r\n";

        [$status, $response] = $this->request(
            'PUT',
            '/api/items/root:/' . $pathName . ':/content',
            [],
            $body,
            [
                'Content-Type' => 'multipart/form-data; boundary=' . $boundary,
                'Accept' => 'application/json',
            ]
        );

        if ($status !== 200 && $status !== 201) {
            throw new \RuntimeException($this->formatHttpError('Could not upload Joplin item content', $status, $response));
        }
    }

    /**
     * @param array{
     *   items: array<int, array<string, mixed>>,
     *   notes: array<int, array<string, mixed>>,
     *   notebooks: array<int, array<string, mixed>>,
     *   tags_by_id: array<string, string>,
     *   note_tag_links_by_note_id: array<string, array<int, array<string, mixed>>>
     * } $snapshot
     * @return array<string, mixed>|null
     */
    private function findSnapshotItem(array $snapshot, int $type, string $id): ?array
    {
        foreach ($snapshot['items'] as $item) {
            if ((int) ($item['type_'] ?? 0) === $type && (string) ($item['id'] ?? '') === $id) {
                return $item;
            }
        }

        return null;
    }

    /**
     * @param array{
     *   items: array<int, array<string, mixed>>,
     *   notes: array<int, array<string, mixed>>,
     *   notebooks: array<int, array<string, mixed>>,
     *   tags_by_id: array<string, string>,
     *   note_tag_links_by_note_id: array<string, array<int, array<string, mixed>>>
     * } $snapshot
     */
    private function folderPathById(array $snapshot, string $folderId): ?string
    {
        $folderId = trim($folderId);
        if ($folderId === '') {
            return '';
        }

        $folder = $this->findSnapshotItem($snapshot, self::TYPE_FOLDER, $folderId);
        if ($folder === null) {
            return null;
        }

        return (string) ($folder['path_name'] ?? '');
    }

    /**
     * @param array{
     *   items: array<int, array<string, mixed>>,
     *   notes: array<int, array<string, mixed>>,
     *   notebooks: array<int, array<string, mixed>>,
     *   tags_by_id: array<string, string>,
     *   note_tag_links_by_note_id: array<string, array<int, array<string, mixed>>>
     * } $snapshot
     * @return array<string, mixed>|null
     */
    private function findTagByTitle(array $snapshot, string $title): ?array
    {
        $needle = mb_strtolower(trim($title));
        if ($needle === '') {
            return null;
        }

        foreach ($snapshot['items'] as $item) {
            if ((int) ($item['type_'] ?? 0) !== self::TYPE_TAG) {
                continue;
            }

            if (mb_strtolower(trim((string) ($item['title'] ?? ''))) === $needle) {
                return $item;
            }
        }

        return null;
    }

    /**
     * @return array<string, mixed>
     */
    private function createTagItem(string $title): array
    {
        $tagId = $this->newItemId();
        $timestamp = gmdate('Y-m-d\TH:i:s.000\Z');
        $item = [
            'id' => $tagId,
            'created_time' => $timestamp,
            'updated_time' => $timestamp,
            'user_created_time' => $timestamp,
            'user_updated_time' => $timestamp,
            'encryption_cipher_text' => '',
            'encryption_applied' => '0',
            'parent_id' => '',
            'is_shared' => '0',
            'type_' => self::TYPE_TAG,
            'title' => trim($title),
            'path_name' => $tagId . '.md',
        ];

        $this->putSerializedItem((string) $item['path_name'], $this->serializeItem($item));
        $this->invalidateCache();

        return $item;
    }

    private function createNoteTagLink(string $noteId, string $tagId): bool
    {
        $linkId = $this->newItemId();
        $timestamp = gmdate('Y-m-d\TH:i:s.000\Z');
        $item = [
            'id' => $linkId,
            'note_id' => $noteId,
            'tag_id' => $tagId,
            'created_time' => $timestamp,
            'updated_time' => $timestamp,
            'user_created_time' => $timestamp,
            'user_updated_time' => $timestamp,
            'encryption_cipher_text' => '',
            'encryption_applied' => '0',
            'is_shared' => '0',
            'type_' => self::TYPE_NOTE_TAG,
            'path_name' => $linkId . '.md',
        ];

        try {
            $this->putSerializedItem((string) $item['path_name'], $this->serializeItem($item));
            $this->invalidateCache();
            return true;
        } catch (\Throwable) {
            return false;
        }
    }

    private function newItemId(): string
    {
        return bin2hex(random_bytes(16));
    }

    /**
     * @param array<string, string> $query
     * @param array<string, string> $headers
     * @return array{int|null, string|false}
     */
    private function request(
        string $method,
        string $path,
        array $query = [],
        ?string $body = null,
        array $headers = [],
        bool $allowSessionRetry = true
    ): array {
        $path = '/' . ltrim($path, '/');
        $url = $this->baseUrl . $path;
        if ($query !== []) {
            $url .= '?' . http_build_query($query, '', '&', PHP_QUERY_RFC3986);
        }

        $normalizedHeaders = [
            'Accept' => $headers['Accept'] ?? 'application/json',
            'X-API-MIN-VERSION' => '2.6.0',
        ];
        foreach ($headers as $name => $value) {
            $normalizedHeaders[$name] = $value;
        }

        if ($path !== '/api/sessions') {
            $normalizedHeaders['X-API-AUTH'] = $this->ensureSession();
        }

        $headerLines = [];
        foreach ($normalizedHeaders as $name => $value) {
            $headerLines[] = $name . ': ' . $value;
        }

        $options = [
            'http' => [
                'method' => $method,
                'header' => implode("\r\n", $headerLines) . "\r\n",
                'timeout' => $this->timeoutSeconds,
                'ignore_errors' => true,
            ],
        ];
        if ($body !== null) {
            $options['http']['content'] = $body;
        }

        $context = stream_context_create($options);
        $response = @file_get_contents($url, false, $context);
        $status = $this->extractStatus($http_response_header ?? []);

        if ($path !== '/api/sessions' && $allowSessionRetry && $status === 401) {
            $this->sessionId = null;
            return $this->request($method, $path, $query, $body, $headers, false);
        }

        return [$status, $response];
    }

    /**
     * @param string[] $responseHeaders
     */
    private function extractStatus(array $responseHeaders): ?int
    {
        foreach ($responseHeaders as $header) {
            if (preg_match('#^HTTP/\S+\s+(\d{3})#', $header, $matches) === 1) {
                return (int) $matches[1];
            }
        }

        return null;
    }

    private function formatHttpError(string $prefix, ?int $status, string|false|null $body): string
    {
        $message = null;
        if (is_string($body) && trim($body) !== '') {
            $decoded = json_decode($body, true);
            if (is_array($decoded)) {
                $message = trim((string) ($decoded['message'] ?? ''));
                if ($message === '' && isset($decoded['error']) && is_string($decoded['error'])) {
                    $message = trim($decoded['error']);
                }
            }

            if ($message === null || $message === '') {
                $message = trim($body);
            }
        }

        $statusText = $status !== null ? 'HTTP ' . $status : 'no HTTP response';
        if ($message !== null && $message !== '') {
            return $prefix . ': ' . $statusText . ': ' . $message;
        }

        return $prefix . ': ' . $statusText;
    }
}
