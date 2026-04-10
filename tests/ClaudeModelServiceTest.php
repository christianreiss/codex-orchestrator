<?php

declare(strict_types=1);

use App\Repositories\ClientConfigRepository;
use App\Repositories\VersionRepository;
use App\Services\ClaudeModelService;
use PHPUnit\Framework\TestCase;

final class ClaudeModelServiceTest extends TestCase
{
    public function testDefaultModelReturnsHardcodedFallbackWhenNoConfig(): void
    {
        $service = new ClaudeModelService($this->makeConfigRepo(null), $this->makeVersionRepo([]));

        $this->assertSame(ClaudeModelService::DEFAULT_MODEL, $service->defaultModel());
    }

    public function testDefaultModelReadsFromClientConfig(): void
    {
        $service = new ClaudeModelService(
            $this->makeConfigRepo(['settings' => ['claude_model' => 'claude-opus-4-6']]),
            $this->makeVersionRepo([])
        );

        $this->assertSame('claude-opus-4-6', $service->defaultModel());
    }

    public function testDefaultModelReadsFromVersionRepository(): void
    {
        $service = new ClaudeModelService(
            $this->makeConfigRepo(null),
            $this->makeVersionRepo(['claude_default_model' => 'claude-haiku-4-5'])
        );

        $this->assertSame('claude-haiku-4-5', $service->defaultModel());
    }

    public function testDefaultModelPrefersClientConfigOverVersionRepo(): void
    {
        $service = new ClaudeModelService(
            $this->makeConfigRepo(['settings' => ['claude_model' => 'claude-opus-4-6']]),
            $this->makeVersionRepo(['claude_default_model' => 'claude-haiku-4-5'])
        );

        $this->assertSame('claude-opus-4-6', $service->defaultModel());
    }

    public function testResolveRequestedModelUsesHardcodedDefaultWhenNoConfig(): void
    {
        $service = new ClaudeModelService($this->makeConfigRepo(null), $this->makeVersionRepo([]));

        $resolved = $service->resolveRequestedModel(null);
        $this->assertSame(ClaudeModelService::DEFAULT_MODEL, $resolved);
    }

    public function testResolveRequestedModelUsesDefaultWhenEmptyString(): void
    {
        $service = new ClaudeModelService($this->makeConfigRepo(null), $this->makeVersionRepo([]));

        $resolved = $service->resolveRequestedModel('');
        $this->assertSame(ClaudeModelService::DEFAULT_MODEL, $resolved);
    }

    public function testResolveRequestedModelUpgradesLegacyModels(): void
    {
        $service = new ClaudeModelService($this->makeConfigRepo(null), $this->makeVersionRepo([]));

        foreach (ClaudeModelService::LEGACY_MODEL_UPGRADES as $legacy => $upgraded) {
            $resolved = $service->resolveRequestedModel($legacy);
            $this->assertSame($upgraded, $resolved, "Legacy model '{$legacy}' should upgrade to '{$upgraded}'");
        }
    }

    public function testResolveRequestedModelAcceptsExplicitSupportedModel(): void
    {
        $service = new ClaudeModelService($this->makeConfigRepo(null), $this->makeVersionRepo([]));

        foreach (ClaudeModelService::SUPPORTED_MODELS as $model) {
            $resolved = $service->resolveRequestedModel($model);
            $this->assertSame($model, $resolved, "Supported model '{$model}' should resolve to itself");
        }
    }

    public function testResolveRequestedModelTrimsWhitespace(): void
    {
        $service = new ClaudeModelService($this->makeConfigRepo(null), $this->makeVersionRepo([]));
        $model = ClaudeModelService::SUPPORTED_MODELS[0];

        $resolved = $service->resolveRequestedModel("  {$model}  ");
        $this->assertSame($model, $resolved);
    }

    public function testResolveRequestedModelRejectsUnsupportedModel(): void
    {
        $service = new ClaudeModelService($this->makeConfigRepo(null), $this->makeVersionRepo([]));

        $this->expectException(InvalidArgumentException::class);
        $this->expectExceptionMessage('Unsupported model');

        $service->resolveRequestedModel('not-a-real-model');
    }

    public function testResolveRequestedModelUsesConfiguredDefault(): void
    {
        $service = new ClaudeModelService(
            $this->makeConfigRepo(['settings' => ['claude_model' => 'claude-opus-4-6']]),
            $this->makeVersionRepo([])
        );

        $this->assertSame('claude-opus-4-6', $service->resolveRequestedModel(null));
    }

    public function testSupportedModelsReturnsNonEmptyList(): void
    {
        $service = new ClaudeModelService($this->makeConfigRepo(null), $this->makeVersionRepo([]));

        $models = $service->supportedModels();
        $this->assertNotEmpty($models);
        $this->assertSame(ClaudeModelService::SUPPORTED_MODELS, $models);
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
