<?php

declare(strict_types=1);

namespace App\Services;

use App\Exceptions\HttpException;
use App\Exceptions\ValidationException;
use App\Repositories\LogRepository;
use App\Repositories\ProjectEventRepository;
use App\Repositories\ProjectFeedbackRepository;
use App\Repositories\ProjectFileRepository;
use App\Repositories\ProjectNoteRepository;
use App\Repositories\ProjectRepository;
use App\Repositories\ProjectTodoRepository;
use App\Services\Traits\HostServiceTrait;

class ProjectCoordinationService
{
    use HostServiceTrait;
    private readonly ProjectNormalizer $normalizer;

    public function __construct(
        private readonly ProjectRepository $projects,
        private readonly ProjectNoteRepository $notes,
        private readonly ProjectTodoRepository $todos,
        private readonly ProjectFileRepository $files,
        private readonly ProjectFeedbackRepository $feedback,
        private readonly ProjectEventRepository $events,
        private readonly ProjectModuleService $module,
        private readonly LogRepository $logs,
        ?ProjectNormalizer $normalizer = null
    ) {
        $this->normalizer = $normalizer ?? new ProjectNormalizer();
    }

    public function listProjects(?array $host = null): array
    {
        $this->ensureEnabled();
        $rows = $this->projects->all();
        $summaries = [];
        foreach ($rows as $row) {
            $summaries[] = $this->buildSummary($row);
        }

        $this->logs->log($this->hostId($host), 'project.list', ['count' => count($summaries)]);

        return [
            'projects' => $summaries,
        ];
    }

    public function adminState(): array
    {
        return $this->module->adminState();
    }

    public function setEnabled(bool $enabled): array
    {
        return $this->module->setEnabled($enabled);
    }

    public function createProject(array $payload, ?array $host = null): array
    {
        $this->ensureEnabled();
        $slug = $this->normalizer->normalizeSlug($payload['slug'] ?? ($payload['project'] ?? null));
        $about = $this->normalizer->normalizeAbout($payload['about'] ?? null);
        $roster = $this->normalizer->normalizeRoster($payload['roster_markdown'] ?? ($payload['agents_markdown'] ?? ''));

        if ($this->projects->findBySlug($slug, true) !== null) {
            throw new ValidationException(['slug' => ['slug already exists']]);
        }

        $created = $this->projects->create($slug, $about, $roster);
        $this->recordEvent($created, 'project', 'create', 'project', $created['id'] ?? null, [
            'slug' => $created['slug'] ?? $slug,
            'about' => $created['about'] ?? $about,
        ], $this->hostId($host));
        $this->logs->log($this->hostId($host), 'project.create', ['slug' => $slug]);

        return $this->projectDetail($slug, $host);
    }

    public function deleteProject(string $slug, ?array $host = null): array
    {
        $this->ensureEnabled();
        $project = $this->requireProject($slug);
        $deleted = $this->projects->delete((int) $project['id']);
        if (!$deleted) {
            throw new HttpException('Project not found', 404);
        }

        $this->logs->log($this->hostId($host), 'project.delete', ['slug' => $project['slug']]);

        return [
            'deleted' => $project['slug'],
        ];
    }

    public function projectDetail(string $slug, ?array $host = null): array
    {
        $this->ensureEnabled();
        $project = $this->requireProject($slug);

        $notes = $this->notes->allByProjectId((int) $project['id']);
        $todos = array_map([$this, 'hydrateTodo'], $this->todos->allByProjectId((int) $project['id']));
        $files = array_map([$this, 'formatFile'], $this->files->allByProjectId((int) $project['id']));
        $feedback = $this->feedback->all((int) $project['id']);
        $recentChanges = $this->events->recent((int) $project['id'], 20);

        $this->logs->log($this->hostId($host), 'project.detail', ['slug' => $project['slug']]);

        return [
            'project' => [
                'slug' => $project['slug'],
                'about' => $project['about'] ?? null,
                'roster_markdown' => $project['roster_markdown'] ?? '',
                'latest_seq' => $project['latest_event_seq'] ?? 0,
                'created_at' => $project['created_at'] ?? null,
                'updated_at' => $project['updated_at'] ?? null,
                'counts' => [
                    'notes' => count($notes),
                    'open_todos' => count(array_filter($todos, static fn (array $todo): bool => empty($todo['done']))),
                    'done_todos' => count(array_filter($todos, static fn (array $todo): bool => !empty($todo['done']))),
                    'files' => count($files),
                    'feedback' => count($feedback),
                ],
            ],
            'notes' => $notes,
            'todos' => $todos,
            'files' => $files,
            'feedback' => $feedback,
            'recent_changes' => $recentChanges,
        ];
    }

    public function bootstrap(string $slug, ?array $host = null): array
    {
        $this->ensureEnabled();
        $project = $this->requireProject($slug);
        $detail = $this->projectDetail($slug, $host);
        $encodedSlug = rawurlencode($project['slug']);
        $detailRoute = '/projects/' . $encodedSlug;
        $bootstrapRoute = $detailRoute . '/bootstrap';
        $changesRoute = $detailRoute . '/changes';

        return [
            'project' => $project['slug'],
            'about' => $detail['project']['about'],
            'roster_markdown' => $detail['project']['roster_markdown'],
            'latest_seq' => $detail['project']['latest_seq'],
            'counts' => $detail['project']['counts'],
            'recent_notes' => array_slice($detail['notes'], 0, 3),
            'recent_todos' => array_slice($detail['todos'], 0, 6),
            'recent_files' => array_slice($detail['files'], 0, 5),
            'recent_changes' => array_slice($detail['recent_changes'], -10),
            'skill' => $this->module->bootstrapSkill(),
            'instructions' => $this->module->bootstrapInstructions((string) $project['slug']),
            'quickstart' => $this->module->bootstrapQuickstart((string) $project['slug']),
            'routes' => [
                'detail' => $detailRoute,
                'bootstrap' => $bootstrapRoute,
                'notes' => $detailRoute . '/notes',
                'todos' => $detailRoute . '/todos',
                'files' => $detailRoute . '/files',
                'feedback' => $detailRoute . '/feedback',
                'changes' => $changesRoute,
            ],
        ];
    }

    public function updateAbout(string $slug, array $payload, ?array $host = null): array
    {
        $this->ensureEnabled();
        $project = $this->requireProject($slug);
        $about = $this->normalizer->normalizeAbout($payload['about'] ?? $payload);
        $updated = $this->projects->updateAbout((int) $project['id'], $about);
        $this->recordEvent($updated, 'about', 'update', 'project', $updated['id'] ?? null, [
            'about' => $updated['about'] ?? $about,
        ], $this->hostId($host));
        $this->logs->log($this->hostId($host), 'project.about.update', ['slug' => $updated['slug'] ?? $slug]);

        return [
            'project' => $this->buildSummary($updated),
            'about' => $updated['about'] ?? null,
        ];
    }

    public function updateRoster(string $slug, array $payload, ?array $host = null): array
    {
        $this->ensureEnabled();
        $project = $this->requireProject($slug);
        $roster = $this->normalizer->normalizeRoster($payload['roster_markdown'] ?? ($payload['markdown'] ?? ''));
        $updated = $this->projects->updateRoster((int) $project['id'], $roster);
        $this->recordEvent($updated, 'roster', 'update', 'project', $updated['id'] ?? null, [
            'roster_markdown' => $updated['roster_markdown'] ?? $roster,
        ], $this->hostId($host));
        $this->logs->log($this->hostId($host), 'project.roster.update', ['slug' => $updated['slug'] ?? $slug]);

        return [
            'project' => $this->buildSummary($updated),
            'roster_markdown' => $updated['roster_markdown'] ?? $roster,
        ];
    }

    public function listChanges(string $slug, int $since = 0, ?array $host = null): array
    {
        $this->ensureEnabled();
        $project = $this->requireProject($slug);
        $changes = $this->events->listSince((int) $project['id'], max(0, $since));
        $this->logs->log($this->hostId($host), 'project.changes', [
            'slug' => $project['slug'],
            'since' => $since,
            'count' => count($changes),
        ]);

        return [
            'project' => $project['slug'],
            'since' => max(0, $since),
            'latest_seq' => $project['latest_event_seq'] ?? 0,
            'changes' => $changes,
        ];
    }

    public function listNotes(string $slug, ?array $host = null): array
    {
        $this->ensureEnabled();
        $project = $this->requireProject($slug);
        $notes = $this->notes->allByProjectId((int) $project['id']);
        $this->logs->log($this->hostId($host), 'project.notes.list', ['slug' => $project['slug'], 'count' => count($notes)]);

        return [
            'project' => $project['slug'],
            'notes' => $notes,
        ];
    }

    public function upsertNote(string $slug, ?int $id, array $payload, ?array $host = null): array
    {
        $this->ensureEnabled();
        $project = $this->requireProject($slug);
        [$header, $body] = $this->normalizer->normalizeNotePayload($payload);
        $hostId = $this->hostId($host);

        if ($id === null) {
            $saved = $this->notes->create((int) $project['id'], $header, $body, $hostId);
            $eventAction = 'create';
        } else {
            if ($this->notes->find((int) $project['id'], $id) === null) {
                throw new HttpException('Note not found', 404);
            }
            $saved = $this->notes->update((int) $project['id'], $id, $header, $body, $hostId);
            $eventAction = 'update';
        }

        $this->recordEvent($project, 'note', $eventAction, 'note', $saved['id'] ?? $id, [
            'header' => $saved['header'] ?? $header,
            'body' => $saved['body'] ?? $body,
        ], $hostId);
        $this->logs->log($hostId, 'project.note.' . $eventAction, ['slug' => $project['slug'], 'note_id' => $saved['id'] ?? $id]);

        return [
            'project' => $project['slug'],
            'note' => $saved,
        ];
    }

    public function deleteNote(string $slug, int $id, ?array $host = null): array
    {
        $this->ensureEnabled();
        $project = $this->requireProject($slug);
        if ($this->notes->find((int) $project['id'], $id) === null) {
            throw new HttpException('Note not found', 404);
        }
        $deleted = $this->notes->delete((int) $project['id'], $id);
        if (!$deleted) {
            throw new HttpException('Note not found', 404);
        }

        $this->recordEvent($project, 'note', 'delete', 'note', $id, ['id' => $id], $this->hostId($host));
        $this->logs->log($this->hostId($host), 'project.note.delete', ['slug' => $project['slug'], 'note_id' => $id]);

        return [
            'project' => $project['slug'],
            'deleted' => $id,
        ];
    }

    public function listTodos(string $slug, ?array $host = null): array
    {
        $this->ensureEnabled();
        $project = $this->requireProject($slug);
        $todos = array_map([$this, 'hydrateTodo'], $this->todos->allByProjectId((int) $project['id']));
        $this->logs->log($this->hostId($host), 'project.todos.list', ['slug' => $project['slug'], 'count' => count($todos)]);

        return [
            'project' => $project['slug'],
            'todos' => $todos,
        ];
    }

    public function createTodo(string $slug, array $payload, ?array $host = null): array
    {
        $this->ensureEnabled();
        $project = $this->requireProject($slug);
        [$title, $detail] = $this->normalizer->normalizeTodoPayload($payload);
        $saved = $this->hydrateTodo($this->todos->create((int) $project['id'], $title, $detail, $this->hostId($host)));
        $this->recordEvent($project, 'todo', 'create', 'todo', $saved['id'] ?? null, $saved, $this->hostId($host));
        $this->logs->log($this->hostId($host), 'project.todo.create', ['slug' => $project['slug'], 'todo_id' => $saved['id'] ?? null]);

        return [
            'project' => $project['slug'],
            'todo' => $saved,
        ];
    }

    public function updateTodo(string $slug, int $id, array $payload, ?array $host = null): array
    {
        $this->ensureEnabled();
        $project = $this->requireProject($slug);
        if ($this->todos->find((int) $project['id'], $id) === null) {
            throw new HttpException('Todo not found', 404);
        }

        [$title, $detail] = $this->normalizer->normalizeTodoPayload($payload);
        $saved = $this->hydrateTodo($this->todos->update((int) $project['id'], $id, $title, $detail, $this->hostId($host)));
        $this->recordEvent($project, 'todo', 'update', 'todo', $saved['id'] ?? $id, $saved, $this->hostId($host));
        $this->logs->log($this->hostId($host), 'project.todo.update', ['slug' => $project['slug'], 'todo_id' => $saved['id'] ?? $id]);

        return [
            'project' => $project['slug'],
            'todo' => $saved,
        ];
    }

    public function setTodoDone(string $slug, int $id, bool $done, ?array $host = null): array
    {
        $this->ensureEnabled();
        $project = $this->requireProject($slug);
        if ($this->todos->find((int) $project['id'], $id) === null) {
            throw new HttpException('Todo not found', 404);
        }

        $saved = $this->hydrateTodo($this->todos->setDone((int) $project['id'], $id, $done, $this->hostId($host)));
        $this->recordEvent($project, 'todo', $done ? 'mark_done' : 'mark_undone', 'todo', $saved['id'] ?? $id, $saved, $this->hostId($host));
        $this->logs->log($this->hostId($host), 'project.todo.done', ['slug' => $project['slug'], 'todo_id' => $saved['id'] ?? $id, 'done' => $done]);

        return [
            'project' => $project['slug'],
            'todo' => $saved,
        ];
    }

    public function deleteTodo(string $slug, int $id, ?array $host = null): array
    {
        $this->ensureEnabled();
        $project = $this->requireProject($slug);
        if ($this->todos->find((int) $project['id'], $id) === null) {
            throw new HttpException('Todo not found', 404);
        }
        $deleted = $this->todos->delete((int) $project['id'], $id);
        if (!$deleted) {
            throw new HttpException('Todo not found', 404);
        }

        $this->recordEvent($project, 'todo', 'delete', 'todo', $id, ['id' => $id], $this->hostId($host));
        $this->logs->log($this->hostId($host), 'project.todo.delete', ['slug' => $project['slug'], 'todo_id' => $id]);

        return [
            'project' => $project['slug'],
            'deleted' => $id,
        ];
    }

    public function listFiles(string $slug, ?array $host = null): array
    {
        $this->ensureEnabled();
        $project = $this->requireProject($slug);
        $files = array_map([$this, 'formatFile'], $this->files->allByProjectId((int) $project['id']));
        $this->logs->log($this->hostId($host), 'project.files.list', ['slug' => $project['slug'], 'count' => count($files)]);

        return [
            'project' => $project['slug'],
            'files' => $files,
        ];
    }

    public function upsertFile(string $slug, array $payload, ?array $host = null): array
    {
        $this->ensureEnabled();
        $project = $this->requireProject($slug);
        [$storedName, $description, $content, $mimeType] = $this->normalizer->normalizeFilePayload($payload);
        $saved = $this->files->upsert(
            (int) $project['id'],
            $storedName,
            $description,
            $content,
            hash('sha256', $content),
            $mimeType,
            $this->hostId($host)
        );

        $formatted = $this->formatFile($saved);
        $action = ($saved['created_at'] ?? null) === ($saved['updated_at'] ?? null) ? 'create' : 'update';
        $this->recordEvent($project, 'file', $action, 'file', $formatted['id'] ?? null, $this->formatFileSummary($saved), $this->hostId($host));
        $this->logs->log($this->hostId($host), 'project.file.' . $action, ['slug' => $project['slug'], 'file_id' => $formatted['id'] ?? null, 'stored_name' => $storedName]);

        return [
            'project' => $project['slug'],
            'file' => $formatted,
        ];
    }

    public function deleteFile(string $slug, int $id, ?array $host = null): array
    {
        $this->ensureEnabled();
        $project = $this->requireProject($slug);
        $existing = $this->files->find((int) $project['id'], $id);
        if ($existing === null) {
            throw new HttpException('Project file not found', 404);
        }
        $deleted = $this->files->delete((int) $project['id'], $id);
        if (!$deleted) {
            throw new HttpException('Project file not found', 404);
        }

        $this->recordEvent($project, 'file', 'delete', 'file', $id, [
            'id' => $id,
            'stored_name' => $existing['stored_name'] ?? null,
        ], $this->hostId($host));
        $this->logs->log($this->hostId($host), 'project.file.delete', ['slug' => $project['slug'], 'file_id' => $id]);

        return [
            'project' => $project['slug'],
            'deleted' => $id,
        ];
    }

    public function listFeedback(?string $slug = null, ?array $host = null): array
    {
        $this->ensureEnabled();
        $projectId = null;
        $projectSlug = null;
        if ($slug !== null) {
            $project = $this->requireProject($slug);
            $projectId = (int) $project['id'];
            $projectSlug = $project['slug'];
        }

        $items = $this->feedback->all($projectId);
        $this->logs->log($this->hostId($host), 'project.feedback.list', [
            'project' => $projectSlug,
            'count' => count($items),
        ]);

        return [
            'project' => $projectSlug,
            'feedback' => $items,
        ];
    }

    public function createFeedback(string $slug, array $payload, ?array $host = null): array
    {
        $this->ensureEnabled();
        $project = $this->requireProject($slug);
        [$type, $title, $body] = $this->normalizer->normalizeFeedbackPayload($payload);
        $saved = $this->feedback->create((int) $project['id'], $type, $title, $body, $this->hostId($host));
        $this->recordEvent($project, 'feedback', 'create', 'feedback', $saved['id'] ?? null, $saved, $this->hostId($host));
        $this->logs->log($this->hostId($host), 'project.feedback.create', ['slug' => $project['slug'], 'feedback_id' => $saved['id'] ?? null]);

        return [
            'project' => $project['slug'],
            'feedback' => $saved,
        ];
    }

    public function projectResourceList(?array $host = null): array
    {
        $this->ensureEnabled();
        $rows = $this->projects->all();
        $resources = [];
        foreach ($rows as $row) {
            $summary = $this->buildSummary($row);
            $resources[] = [
                'uri' => 'project://' . rawurlencode((string) $summary['slug']),
                'name' => (string) ($summary['title'] ?? $summary['slug']),
                'description' => (string) ($summary['description'] ?? ''),
                'mimeType' => 'application/json',
            ];
        }

        $this->logs->log($this->hostId($host), 'project.resource.list', ['count' => count($resources)]);

        return $resources;
    }

    public function projectResourceRead(string $slug, ?array $host = null): array
    {
        $bootstrap = $this->bootstrap($slug, $host);

        return [
            'contents' => [
                [
                    'uri' => 'project://' . rawurlencode($slug),
                    'name' => $slug,
                    'mimeType' => 'application/json',
                    'text' => json_encode($bootstrap, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) ?: '{}',
                ],
            ],
        ];
    }

    private function buildSummary(array $project): array
    {
        $about = is_array($project['about'] ?? null) ? $project['about'] : [];
        $slug = (string) ($project['slug'] ?? '');

        return [
            'slug' => $slug,
            'title' => $this->normalizer->normalizeOptionalString($about['title'] ?? null) ?? $slug,
            'name' => $this->normalizer->normalizeOptionalString($about['name'] ?? null) ?? $slug,
            'description' => $this->normalizer->normalizeOptionalString($about['description'] ?? null) ?? '',
            'about' => $project['about'] ?? null,
            'latest_seq' => isset($project['latest_event_seq']) ? (int) $project['latest_event_seq'] : 0,
            'created_at' => $project['created_at'] ?? null,
            'updated_at' => $project['updated_at'] ?? null,
        ];
    }

    private function recordEvent(
        array $project,
        string $eventType,
        string $action,
        ?string $entityType,
        null|int|string $entityId,
        ?array $payload,
        ?int $sourceHostId
    ): array {
        $projectId = isset($project['id']) && is_numeric($project['id']) ? (int) $project['id'] : 0;
        if ($projectId <= 0) {
            throw new HttpException('Project event requires a stored project', 500);
        }

        $seq = $this->projects->nextEventSeq($projectId);
        return $this->events->create($projectId, $seq, $eventType, $action, $entityType, $entityId, $payload, $sourceHostId);
    }

    private function requireProject(string $slug): array
    {
        $normalizedSlug = $this->normalizer->normalizeSlug($slug);
        $project = $this->projects->findBySlug($normalizedSlug);
        if ($project === null) {
            throw new HttpException('Project not found', 404);
        }

        return $project;
    }

    private function ensureEnabled(): void
    {
        if (!$this->module->isEnabled()) {
            throw new HttpException('Project coordination disabled', 404);
        }
    }

    private function hydrateTodo(array $todo): array
    {
        $todo['done'] = !empty($todo['done']);
        return $todo;
    }

    private function formatFileSummary(array $file): array
    {
        return [
            'id' => isset($file['id']) ? (int) $file['id'] : null,
            'stored_name' => (string) ($file['stored_name'] ?? ''),
            'description' => $file['description'] ?? null,
            'content_sha256' => $file['content_sha256'] ?? null,
            'mime_type' => $file['mime_type'] ?? null,
            'size_bytes' => strlen((string) ($file['content'] ?? '')),
            'updated_at' => $file['updated_at'] ?? null,
            'created_at' => $file['created_at'] ?? null,
        ];
    }

    private function formatFile(array $file): array
    {
        $summary = $this->formatFileSummary($file);
        $summary['content'] = (string) ($file['content'] ?? '');

        return $summary;
    }

}
