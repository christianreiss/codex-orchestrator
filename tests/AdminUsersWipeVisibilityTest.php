<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class AdminUsersWipeVisibilityTest extends TestCase
{
    public function testWipeButtonVisibilityTogglesWithUserCount(): void
    {
        $src = file_get_contents(__DIR__ . '/../frontend/src/routes/users/+page.svelte');
        $this->assertIsString($src);

        // Wipe button is disabled (not hidden) when there are no users.
        $this->assertStringContainsString('disabled={totalCount === 0}', $src);
        // The total count is derived from the loaded user list.
        $this->assertStringContainsString('totalCount', $src);
    }
}
