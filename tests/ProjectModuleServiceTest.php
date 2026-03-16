<?php

declare(strict_types=1);

use App\Repositories\VersionRepository;
use App\Services\ProjectModuleService;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class ProjectModuleFakeVersionRepository extends VersionRepository
{
    /** @var array<string, string> */
    public array $values = [];

    /** @var array<string, array{version:string,updated_at:?string}> */
    public array $meta = [];

    public function __construct()
    {
    }

    public function get(string $name): ?string
    {
        return $this->values[$name] ?? null;
    }

    public function getWithMetadata(string $name): ?array
    {
        return $this->meta[$name] ?? null;
    }

    public function set(string $name, string $version): void
    {
        $this->values[$name] = $version;
        $this->meta[$name] = [
            'version' => $version,
            'updated_at' => '2026-03-12T12:00:00Z',
        ];
    }
}

final class ProjectModuleServiceTest extends TestCase
{
    public function testManagedSkillEmbedsToolkitAndOnlyExistsWhileEnabled(): void
    {
        $versions = new ProjectModuleFakeVersionRepository();
        $versions->values[ProjectModuleService::ENABLED_FLAG] = '1';
        $versions->meta[ProjectModuleService::ENABLED_FLAG] = [
            'version' => '1',
            'updated_at' => '2026-03-12T12:00:00Z',
        ];

        $service = new ProjectModuleService($versions);
        $skill = $service->managedSkill();

        $this->assertNotNull($skill);
        $this->assertSame('coco', $skill['slug']);
        $this->assertTrue($skill['managed']);
        $this->assertStringContainsString('# CoCo Toolkit (Codex Orchestrator Projects)', $skill['manifest']);
        $this->assertStringContainsString('`~/.agents/skills/coco/SKILL.md`', $skill['manifest']);
        $this->assertStringContainsString('`skill://coco`', $skill['manifest']);
        $this->assertStringContainsString('Cross-server CoCo is project-only.', $skill['manifest']);
        $this->assertStringContainsString('Do not use `memory://...` resources', $skill['manifest']);
        $this->assertStringContainsString('`project_bootstrap`', $skill['manifest']);
        $this->assertStringContainsString('`project_create`', $skill['manifest']);
        $this->assertStringContainsString('`project_changes`', $skill['manifest']);
        $this->assertStringNotContainsString('GET /help', $skill['manifest']);
        $this->assertStringNotContainsString('`project_help`', $skill['manifest']);

        $versions->values[ProjectModuleService::ENABLED_FLAG] = '0';
        $versions->meta[ProjectModuleService::ENABLED_FLAG] = [
            'version' => '0',
            'updated_at' => '2026-03-12T12:05:00Z',
        ];

        $this->assertNull($service->managedSkill());
    }

    public function testBootstrapInstructionsPointToManagedSkillInsteadOfHelpRoute(): void
    {
        $versions = new ProjectModuleFakeVersionRepository();
        $service = new ProjectModuleService($versions);

        $instructions = $service->bootstrapInstructions('apollo');
        $quickstart = $service->bootstrapQuickstart('apollo');
        $skill = $service->bootstrapSkill();

        $this->assertNotEmpty($instructions);
        $this->assertStringContainsString('skill://coco', $instructions[0]);
        $this->assertStringContainsString('~/.agents/skills/coco/SKILL.md', $instructions[0]);
        $this->assertStringContainsString('project_create', implode("\n", $instructions));
        $this->assertStringContainsString('project-only', implode("\n", $instructions));
        $this->assertStringContainsString('memory://', implode("\n", $instructions));
        $this->assertStringNotContainsString('/help', $instructions[0]);
        $this->assertSame('coco', $skill['slug']);
        $this->assertSame('~/.agents/skills/coco/SKILL.md', $skill['path']);
        $this->assertContains('project_list', $quickstart);
        $this->assertContains('project_create {"slug":"apollo"}', $quickstart);
        $this->assertContains('project_bootstrap {"slug":"apollo"}', $quickstart);
        $this->assertNotContains('project_help', $quickstart);
    }
}
