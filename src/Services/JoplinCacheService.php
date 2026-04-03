<?php

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 * GitHub: https://github.com/christianreiss/codex-orchestrator
 */

declare(strict_types=1);

namespace App\Services;

use App\Repositories\JoplinNoteRepository;
use App\Repositories\VersionRepository;

class JoplinCacheService
{
    public function __construct(
        private readonly JoplinService $joplin,
        private readonly JoplinNoteRepository $notes,
        private readonly VersionRepository $versions,
        private readonly int $defaultSyncIntervalMinutes = 15
    ) {
    }

    public function search(string $query, int $limit = 20): array
    {
        return $this->notes->search($query, $limit);
    }

    /**
     * @return array<string, mixed>|null
     */
    public function getNote(string $joplinId): ?array
    {
        $cached = $this->notes->findByJoplinId($joplinId);
        if ($cached !== null) {
            return $cached;
        }

        $note = $this->joplin->getNote($joplinId);
        if ($note === null) {
            return null;
        }

        $tags = $this->joplin->getNoteTags($joplinId);

        return $this->notes->upsert(
            $note['id'],
            $note['title'],
            $note['body'],
            $note['parent_id'],
            $tags,
            $note['parent_id'],
            gmdate(DATE_ATOM)
        );
    }

    /**
     * @param string[] $tags
     * @return array<string, mixed>|null
     */
    public function createNote(string $title, string $body, string $notebookId = '', array $tags = []): ?array
    {
        $note = $this->joplin->createNote($title, $body, $notebookId, $tags);
        if ($note === null) {
            return null;
        }

        return $this->notes->upsert(
            $note['id'],
            $note['title'],
            $note['body'],
            $note['parent_id'],
            $tags,
            $note['parent_id'],
            gmdate(DATE_ATOM)
        );
    }

    /**
     * @param string[]|null $tags
     * @return array<string, mixed>|null
     */
    public function updateNote(string $joplinId, ?string $title = null, ?string $body = null, ?string $notebookId = null, ?array $tags = null): ?array
    {
        $note = $this->joplin->updateNote($joplinId, $title, $body, $notebookId);
        if ($note === null) {
            return null;
        }

        if ($tags !== null) {
            $this->joplin->setNoteTags($joplinId, $tags);
        } else {
            $tags = $this->joplin->getNoteTags($joplinId);
        }

        return $this->notes->upsert(
            $note['id'],
            $note['title'],
            $note['body'],
            $note['parent_id'],
            $tags,
            $note['parent_id'],
            gmdate(DATE_ATOM)
        );
    }

    public function deleteNote(string $joplinId): bool
    {
        if (!$this->joplin->deleteNote($joplinId)) {
            return false;
        }

        $this->notes->deleteByJoplinId($joplinId);

        return true;
    }

    public function listNotebooks(): array
    {
        return $this->joplin->listNotebooks();
    }

    /**
     * @return array{synced: int, errors: int}
     */
    public function syncAll(): array
    {
        $notes = $this->joplin->listNotes(1000);
        $synced = 0;
        $errors = 0;
        $syncedAt = gmdate(DATE_ATOM);

        foreach ($notes as $note) {
            try {
                $tags = $this->joplin->getNoteTags($note['id']);
                $this->notes->upsert(
                    $note['id'],
                    $note['title'],
                    $note['body'],
                    $note['parent_id'],
                    $tags,
                    $note['parent_id'],
                    $syncedAt
                );
                $synced++;
            } catch (\Throwable) {
                $errors++;
            }
        }

        return ['synced' => $synced, 'errors' => $errors];
    }

    public function needsSync(): bool
    {
        $oldestSyncedAt = $this->notes->oldestSyncedAt();
        if ($oldestSyncedAt === null) {
            return true;
        }

        $oldest = strtotime($oldestSyncedAt);
        if ($oldest === false) {
            return true;
        }

        $intervalSeconds = $this->getSyncIntervalMinutes() * 60;

        return (time() - $oldest) >= $intervalSeconds;
    }

    public function syncIfNeeded(): void
    {
        if ($this->needsSync()) {
            $this->syncAll();
        }
    }

    public function getSyncIntervalMinutes(): int
    {
        $value = $this->versions->get('joplin_sync_interval_minutes');
        if ($value !== null && is_numeric($value) && (int) $value > 0) {
            return (int) $value;
        }

        return $this->defaultSyncIntervalMinutes;
    }
}
