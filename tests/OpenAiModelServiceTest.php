<?php

declare(strict_types=1);

use App\Repositories\ClientConfigRepository;
use App\Repositories\VersionRepository;
use App\Services\OpenAiModelService;
use PHPUnit\Framework\TestCase;

final class OpenAiModelServiceTest extends TestCase
{
    public function testSupportedModelsMirrorSharedConfigAllowlist(): void
    {
        $service = new OpenAiModelService($this->makeConfigRepo(null), $this->makeVersionRepo([]));

        $this->assertSame([
            'gpt-5.5',
            'gpt-5.4',
            'gpt-5.4-mini',
            'gpt-5.3-codex',
            'gpt-5.2',
        ], $service->supportedModels());
    }

    public function testDefaultModelPrefersSavedMainConfig(): void
    {
        $service = new OpenAiModelService(
            $this->makeConfigRepo(['settings' => ['model' => 'gpt-5.2']]),
            $this->makeVersionRepo(['cdx_model' => 'gpt-5.4'])
        );

        $this->assertSame('gpt-5.2', $service->defaultModel());
    }

    public function testDefaultModelFallsBackToCdxModelMirror(): void
    {
        $service = new OpenAiModelService(
            $this->makeConfigRepo(['settings' => ['model' => 'gpt-4o']]),
            $this->makeVersionRepo(['cdx_model' => 'gpt-5.4-mini'])
        );

        $this->assertSame('gpt-5.4-mini', $service->defaultModel());
    }

    public function testResolveRequestedModelValidatesExplicitValues(): void
    {
        $service = new OpenAiModelService($this->makeConfigRepo(null), $this->makeVersionRepo([]));

        $this->assertSame('gpt-5.3-codex', $service->resolveRequestedModel('  gpt-5.3-codex  '));
    }

    public function testResolveRequestedModelRejectsUnsupportedModels(): void
    {
        $service = new OpenAiModelService($this->makeConfigRepo(null), $this->makeVersionRepo([]));

        $this->expectException(InvalidArgumentException::class);
        $this->expectExceptionMessage('Unsupported model "cdx-lm-1"');

        $service->resolveRequestedModel('cdx-lm-1');
    }

    public function testResolveRequestedModelUsesConfiguredDefaultWhenOmitted(): void
    {
        $service = new OpenAiModelService(
            $this->makeConfigRepo(['settings' => ['model' => 'gpt-5.4']]),
            $this->makeVersionRepo([])
        );

        $this->assertSame('gpt-5.4', $service->resolveRequestedModel(null));
    }

    public function testResolveRequestedModelUsesMirrorWhenConfigMissing(): void
    {
        $service = new OpenAiModelService(
            $this->makeConfigRepo(null),
            $this->makeVersionRepo(['cdx_model' => 'gpt-5.1-codex-max'])
        );

        $this->assertSame('gpt-5.4', $service->resolveRequestedModel(''));
    }

    public function testResolveRequestedModelFallsBackToDefaultModelConstant(): void
    {
        $service = new OpenAiModelService($this->makeConfigRepo(null), $this->makeVersionRepo([]));

        $this->assertSame(OpenAiModelService::DEFAULT_MODEL, $service->resolveRequestedModel(null));
    }

    public function testResolveRequestedModelUpgradesLegacyModel(): void
    {
        $service = new OpenAiModelService($this->makeConfigRepo(null), $this->makeVersionRepo([]));

        $this->assertSame('gpt-5.4', $service->resolveRequestedModel('gpt-5.3-codex-spark'));
        $this->assertSame('gpt-5.4', $service->resolveRequestedModel('gpt-5.2-codex'));
        $this->assertSame('gpt-5.4', $service->resolveRequestedModel('gpt-5.1-codex-max'));
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
