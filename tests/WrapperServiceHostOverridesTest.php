<?php

declare(strict_types=1);

use App\Repositories\VersionRepository;
use App\Services\WrapperService;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class InMemoryVersionRepositoryForWrapper extends VersionRepository
{
    public array $values = [];

    public function __construct()
    {
    }

    public function get(string $name): ?string
    {
        return isset($this->values[$name]) ? (string) $this->values[$name] : null;
    }

    public function set(string $name, string $version): void
    {
        $this->values[$name] = $version;
    }

    public function getFlag(string $name, bool $default = false): bool
    {
        $value = $this->get($name);
        if ($value === null) {
            return $default;
        }
        return in_array(strtolower((string) $value), ['1', 'true', 'yes', 'on'], true);
    }
}

final class WrapperServiceHostOverridesTest extends TestCase
{
    private ?string $templatePath = null;

    protected function tearDown(): void
    {
        if ($this->templatePath && is_file($this->templatePath)) {
            @unlink($this->templatePath);
        }
    }

    public function testBakedWrapperIncludesHostModelAndReasoningOverrides(): void
    {
        $path = tempnam(sys_get_temp_dir(), 'cdx-wrapper-');
        $this->assertNotFalse($path);
        $this->templatePath = $path;

        $template = <<<'SH'
#!/usr/bin/env bash
WRAPPER_VERSION="test-1"
CODEX_HOST_MODEL="${CODEX_HOST_MODEL:-__CODEX_HOST_MODEL__}"
CODEX_HOST_REASONING_EFFORT="${CODEX_HOST_REASONING_EFFORT:-__CODEX_HOST_REASONING_EFFORT__}"
CODEX_SYNC_BASE_URL="__CODEX_SYNC_BASE_URL__"
CODEX_SYNC_API_KEY="__CODEX_SYNC_API_KEY__"
CODEX_SYNC_FQDN="__CODEX_SYNC_FQDN__"
CODEX_SYNC_CA_FILE="__CODEX_SYNC_CA_FILE__"
CODEX_HOST_SECURE="__CODEX_HOST_SECURE__"
CODEX_FORCE_IPV4="__CODEX_FORCE_IPV4__"
CODEX_INSTALLATION_ID="__CODEX_INSTALLATION_ID__"
CODEX_SILENT="__CODEX_SILENT__"
SH;

        $written = file_put_contents($path, $template);
        $this->assertNotFalse($written);

        $versions = new InMemoryVersionRepositoryForWrapper();
        $service = new WrapperService($versions, $path, $path . '.seed');

        $host = [
            'fqdn' => 'host.test',
            'api_key_plain' => 'api-key-plain',
            'secure' => 1,
            'force_ipv4' => 0,
            'model_override' => 'gpt-5.2',
            'reasoning_effort_override' => 'high',
        ];

        $meta = $service->bakedForHost($host, 'https://example.test');
        $this->assertSame('test-1', $meta['version']);
        $this->assertNotNull($meta['content']);

        $this->assertStringContainsString(
            'CODEX_HOST_MODEL="${CODEX_HOST_MODEL:-gpt-5.2}"',
            $meta['content']
        );
        $this->assertStringContainsString(
            'CODEX_HOST_REASONING_EFFORT="${CODEX_HOST_REASONING_EFFORT:-high}"',
            $meta['content']
        );
    }
}

