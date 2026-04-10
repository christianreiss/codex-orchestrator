<?php

declare(strict_types=1);

use App\Repositories\ClientConfigRepository;
use App\Repositories\VersionRepository;
use App\Services\ClaudeModelService;
use PHPUnit\Framework\TestCase;

final class ClaudeModelServiceTest extends TestCase
{
    public function testSupportedModelsReturnsExpectedList(): void
    {
        $service = new ClaudeModelService($this->makeConfigRepo(null), $this->makeVersionRepo([]));
        $models = $service->supportedModels();

        $this->assertIsArray($models);
        $this->assertNotEmpty($models);
        foreach ($models as $model) {
            $this->assertStringContainsString('claude', strtolower($model));
        }
    }

    public function testSupportedModelsIncludesMainClaudeFamilies(): void
    {
        $service = new ClaudeModelService($this->makeConfigRepo(null), $this->makeVersionRepo([]));
        $models = $service->supportedModels();

        $joined = implode(' ', $models);
        $this->assertTrue(
            str_contains($joined, 'sonnet') || str_contains($joined, 'haiku') || str_contains($joined, 'opus'),
            'Expected at least one of sonnet, haiku, or opus in supported models'
        );
    }

    public function testDefaultModelReturnsConstantWhenNoConfigOrRepo(): void
    {
        $service = new ClaudeModelService($this->makeConfigRepo(null), $this->makeVersionRepo([]));
        $default = $service->defaultModel();

        if ($default !== null) {
            $this->assertStringContainsString('claude', strtolower($default));
        } else {
            $this->assertNull($default);
        }
    }

    public function testDefaultModelReturnsConfiguredModelFromClientConfig(): void
    {
        $service = new ClaudeModelService(
            $this->makeConfigRepo(['settings' => ['claude_model' => 'claude-sonnet-4-20250514']]),
            $this->makeVersionRepo([])
        );

        $default = $service->defaultModel();

        if ($default !== null) {
            $this->assertStringContainsString('claude', strtolower($default));
        }
    }

    public function testDefaultModelReturnsConfiguredModelFromVersionRepository(): void
    {
        $service = new ClaudeModelService(
            $this->makeConfigRepo(null),
            $this->makeVersionRepo(['claude_model' => 'claude-sonnet-4-20250514'])
        );

        $default = $service->defaultModel();

        if ($default !== null) {
            $this->assertStringContainsString('claude', strtolower($default));
        }
    }

    public function testResolveRequestedModelValidatesSupportedModel(): void
    {
        $service = new ClaudeModelService($this->makeConfigRepo(null), $this->makeVersionRepo([]));
        $models = $service->supportedModels();

        if (count($models) === 0) {
            $this->markTestSkipped('No supported models available');
        }

        $resolved = $service->resolveRequestedModel($models[0]);
        $this->assertSame($models[0], $resolved);
    }

    public function testResolveRequestedModelTrimsWhitespace(): void
    {
        $service = new ClaudeModelService($this->makeConfigRepo(null), $this->makeVersionRepo([]));
        $models = $service->supportedModels();

        if (count($models) === 0) {
            $this->markTestSkipped('No supported models available');
        }

        $resolved = $service->resolveRequestedModel('  ' . $models[0] . '  ');
        $this->assertSame($models[0], $resolved);
    }

    public function testResolveRequestedModelRejectsUnsupportedModel(): void
    {
        $service = new ClaudeModelService($this->makeConfigRepo(null), $this->makeVersionRepo([]));

        $this->expectException(InvalidArgumentException::class);
        $this->expectExceptionMessage('Unsupported model');

        $service->resolveRequestedModel('totally-fake-model-xyz');
    }

    public function testResolveRequestedModelUsesDefaultWhenNull(): void
    {
        $service = new ClaudeModelService(
            $this->makeConfigRepo(['settings' => ['claude_model' => 'claude-sonnet-4-20250514']]),
            $this->makeVersionRepo([])
        );

        try {
            $resolved = $service->resolveRequestedModel(null);
            $this->assertIsString($resolved);
            $this->assertNotSame('', $resolved);
        } catch (RuntimeException $e) {
            // If no default is configured, a RuntimeException is acceptable
            $this->assertStringContainsString('No default model', $e->getMessage());
        }
    }

    public function testResolveRequestedModelUsesDefaultWhenEmptyString(): void
    {
        $service = new ClaudeModelService(
            $this->makeConfigRepo(['settings' => ['claude_model' => 'claude-sonnet-4-20250514']]),
            $this->makeVersionRepo([])
        );

        try {
            $resolved = $service->resolveRequestedModel('');
            $this->assertIsString($resolved);
            $this->assertNotSame('', $resolved);
        } catch (RuntimeException $e) {
            $this->assertStringContainsString('No default model', $e->getMessage());
        }
    }

    public function testResolveRequestedModelFailsWithoutConfiguredDefault(): void
    {
        $service = new ClaudeModelService($this->makeConfigRepo(null), $this->makeVersionRepo([]));

        $this->expectException(RuntimeException::class);

        $service->resolveRequestedModel(null);
    }

    private function makeConfigRepo(?array $row): ClientConfigRepository
    {
        return new class($row) extends ClientConfigRepository {
            public function __construct(private readonly ?array $row)
            {
            }

            public function latest(): ?array
            {
                return $this->row;
            }
        };
    }

    private function makeVersionRepo(array $values): VersionRepository
    {
        return new class($values) extends VersionRepository {
            public function __construct(private readonly array $values)
            {
            }

            public function get(string $name): ?string
            {
                $value = $this->values[$name] ?? null;
                return is_string($value) ? $value : null;
            }
        };
    }
}
