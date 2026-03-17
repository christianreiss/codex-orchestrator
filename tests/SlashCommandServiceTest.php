<?php

declare(strict_types=1);

use App\Exceptions\ValidationException;
use App\Repositories\LogRepository;
use App\Repositories\SlashCommandRepository;
use App\Services\SlashCommandService;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class InMemorySlashCommandRepository extends SlashCommandRepository
{
    /** @var array<string, array> */
    public array $store = [];

    public function __construct()
    {
    }

    public function all(bool $includeDeleted = false): array
    {
        $rows = array_values($this->store);
        if (!$includeDeleted) {
            $rows = array_filter($rows, static fn($row) => empty($row['deleted_at']));
        }
        usort($rows, static fn($a, $b) => strcmp((string) $a['filename'], (string) $b['filename']));
        return array_values($rows);
    }

    public function findByFilename(string $filename): ?array
    {
        return $this->store[$filename] ?? null;
    }

    public function upsert(
        string $filename,
        string $sha256,
        ?string $description,
        ?string $argumentHint,
        string $prompt,
        ?int $sourceHostId
    ): array {
        $now = gmdate(DATE_ATOM);
        $createdAt = $this->store[$filename]['created_at'] ?? $now;
        $row = [
            'id' => count($this->store) + 1,
            'filename' => $filename,
            'sha256' => $sha256,
            'description' => $description,
            'argument_hint' => $argumentHint,
            'prompt' => $prompt,
            'source_host_id' => $sourceHostId,
            'created_at' => $createdAt,
            'updated_at' => $now,
            'deleted_at' => null,
        ];
        $this->store[$filename] = $row;
        return $row;
    }

    public function delete(string $filename): bool
    {
        if (!isset($this->store[$filename])) {
            return false;
        }
        $this->store[$filename]['deleted_at'] = gmdate(DATE_ATOM);
        return true;
    }
}

final class NullLogRepositorySlashCmd extends LogRepository
{
    public array $records = [];

    public function __construct()
    {
    }

    public function log(?int $hostId, string $action, array $details = []): void
    {
        $this->records[] = compact('hostId', 'action', 'details');
    }
}

final class SlashCommandServiceTest extends TestCase
{
    private InMemorySlashCommandRepository $repository;
    private NullLogRepositorySlashCmd $logs;
    private SlashCommandService $service;

    protected function setUp(): void
    {
        $this->repository = new InMemorySlashCommandRepository();
        $this->logs = new NullLogRepositorySlashCmd();
        $this->service = new SlashCommandService($this->repository, $this->logs);
    }

    public function testStoreCreatesCommand(): void
    {
        $result = $this->service->store([
            'filename' => 'deploy.md',
            'prompt' => 'Deploy the application to production.',
        ], ['id' => 1]);

        $this->assertSame('created', $result['status']);
        $this->assertSame('deploy.md', $result['filename']);
        $this->assertArrayHasKey('sha256', $result);
        $this->assertNotNull($this->repository->findByFilename('deploy.md'));
        $this->assertSame('slash.store', $this->logs->records[0]['action']);
    }

    public function testStoreDetectsUnchanged(): void
    {
        $payload = ['filename' => 'lint.md', 'prompt' => 'Run the linter.'];
        $first = $this->service->store($payload);
        $this->assertSame('created', $first['status']);

        $second = $this->service->store($payload);
        $this->assertSame('unchanged', $second['status']);
    }

    public function testStoreDetectsUpdated(): void
    {
        $this->service->store(['filename' => 'build.md', 'prompt' => 'Build v1']);
        $result = $this->service->store(['filename' => 'build.md', 'prompt' => 'Build v2']);
        $this->assertSame('updated', $result['status']);
    }

    public function testStoreRejectsEmptyPrompt(): void
    {
        $this->expectException(ValidationException::class);
        $this->service->store(['filename' => 'empty.md', 'prompt' => '']);
    }

    public function testStoreRejectsInvalidSha(): void
    {
        $this->expectException(ValidationException::class);
        $this->service->store([
            'filename' => 'test.md',
            'prompt' => 'hello',
            'sha256' => 'not-a-sha',
        ]);
    }

    public function testStoreRejectsMismatchedSha(): void
    {
        $this->expectException(ValidationException::class);
        $this->service->store([
            'filename' => 'test.md',
            'prompt' => 'hello world',
            'sha256' => str_repeat('a', 64),
        ]);
    }

    public function testStoreAcceptsMatchingSha(): void
    {
        $prompt = 'Deploy now';
        $sha = hash('sha256', $prompt);
        $result = $this->service->store([
            'filename' => 'deploy.md',
            'prompt' => $prompt,
            'sha256' => $sha,
        ]);
        $this->assertSame('created', $result['status']);
        $this->assertSame($sha, $result['sha256']);
    }

    public function testRetrieveUnchangedWhenShaMatches(): void
    {
        $store = $this->service->store(['filename' => 'check.md', 'prompt' => 'Run checks.']);
        $sha = $store['sha256'];

        $result = $this->service->retrieve('check.md', $sha);
        $this->assertSame('unchanged', $result['status']);
        $this->assertArrayNotHasKey('prompt', $result);
    }

    public function testRetrieveUpdatedWhenShaDiffers(): void
    {
        $this->service->store(['filename' => 'check.md', 'prompt' => 'Run checks.']);

        $result = $this->service->retrieve('check.md', null);
        $this->assertSame('updated', $result['status']);
        $this->assertSame('Run checks.', $result['prompt']);
    }

    public function testRetrieveMissing(): void
    {
        $result = $this->service->retrieve('nonexistent.md', null);
        $this->assertSame('missing', $result['status']);
    }

    public function testRetrieveDeletedCommand(): void
    {
        $this->service->store(['filename' => 'old.md', 'prompt' => 'Old command.']);
        $this->service->delete('old.md');

        $result = $this->service->retrieve('old.md', null);
        $this->assertSame('deleted', $result['status']);
        $this->assertArrayHasKey('deleted_at', $result);
    }

    public function testFindExisting(): void
    {
        $this->service->store(['filename' => 'find-me.md', 'prompt' => 'Content here.']);

        $result = $this->service->find('find-me.md');
        $this->assertNotNull($result);
        $this->assertSame('find-me.md', $result['filename']);
        $this->assertSame('Content here.', $result['prompt']);
    }

    public function testFindMissing(): void
    {
        $this->assertNull($this->service->find('ghost.md'));
    }

    public function testDeleteMarksCommand(): void
    {
        $this->service->store(['filename' => 'remove.md', 'prompt' => 'Remove me.']);
        $deleted = $this->service->delete('remove.md');
        $this->assertTrue($deleted);

        $row = $this->repository->findByFilename('remove.md');
        $this->assertNotNull($row['deleted_at']);
    }

    public function testDeleteNonexistentReturnsFalse(): void
    {
        $this->assertFalse($this->service->delete('nope.md'));
    }

    public function testListCommands(): void
    {
        $this->service->store(['filename' => 'a.md', 'prompt' => 'A']);
        $this->service->store(['filename' => 'b.md', 'prompt' => 'B']);

        $list = $this->service->listCommands();
        $this->assertCount(2, $list);
    }

    public function testListCommandsExcludesDeletedByDefault(): void
    {
        $this->service->store(['filename' => 'keep.md', 'prompt' => 'Keep']);
        $this->service->store(['filename' => 'gone.md', 'prompt' => 'Gone']);
        $this->service->delete('gone.md');

        $list = $this->service->listCommands();
        $this->assertCount(1, $list);
    }

    public function testListCommandsIncludesDeletedWhenRequested(): void
    {
        $this->service->store(['filename' => 'keep.md', 'prompt' => 'Keep']);
        $this->service->store(['filename' => 'gone.md', 'prompt' => 'Gone']);
        $this->service->delete('gone.md');

        $list = $this->service->listCommands(null, true);
        $this->assertCount(2, $list);
    }

    public function testFilenameValidation(): void
    {
        $this->expectException(ValidationException::class);
        $this->service->store(['filename' => '../evil.md', 'prompt' => 'bad']);
    }

    public function testEmptyFilenameRejected(): void
    {
        $this->expectException(ValidationException::class);
        $this->service->store(['filename' => '', 'prompt' => 'content']);
    }

    public function testFilenameWithSlashRejected(): void
    {
        $this->expectException(ValidationException::class);
        $this->service->store(['filename' => 'dir/file.md', 'prompt' => 'content']);
    }

    public function testFrontMatterParsing(): void
    {
        $prompt = "---\ndescription: Deploy service\nargument-hint: <env>\n---\nDeploy to the given environment.";
        $result = $this->service->store(['filename' => 'deploy.md', 'prompt' => $prompt]);
        $this->assertSame('created', $result['status']);

        $found = $this->service->find('deploy.md');
        $this->assertSame('Deploy service', $found['description']);
        $this->assertSame('<env>', $found['argument_hint']);
    }

    public function testMetadataChangeDetectedAsUpdated(): void
    {
        $this->service->store([
            'filename' => 'meta.md',
            'prompt' => 'content',
            'description' => 'v1 desc',
        ]);
        $result = $this->service->store([
            'filename' => 'meta.md',
            'prompt' => 'content',
            'description' => 'v2 desc',
        ]);
        $this->assertSame('updated', $result['status']);
    }
}
