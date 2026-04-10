<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class SetupScriptBaseUrlDefaultsTest extends TestCase
{
    public function testSetupSeedsPublicBaseUrlFromCodexUrl(): void
    {
        $source = file_get_contents(__DIR__ . '/../bin/setup.sh');
        $this->assertIsString($source);

        $this->assertStringContainsString('existing_public_base_url="$(read_env_value "PUBLIC_BASE_URL" "$env_file" || true)"', $source);
        $this->assertStringContainsString('set_env_value "PUBLIC_BASE_URL" "$codex_url" "$env_file"', $source);
        $this->assertStringContainsString('"$existing_public_base_url" == "$existing_codex_url"', $source);
        $this->assertStringContainsString('"$existing_public_base_url" == "$existing_runner_url"', $source);
    }
}
