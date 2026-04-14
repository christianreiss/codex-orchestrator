<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class AdminClaudePanelUiTest extends TestCase
{
    public function testExactlyOneClaudeSettingsPanel(): void
    {
        $html = file_get_contents(__DIR__ . '/../public/admin/index.html');
        self::assertIsString($html);

        self::assertSame(
            1,
            substr_count($html, 'data-settings-panel="claude"'),
            'Exactly one Claude settings panel may exist (duplicate panels collide on DOM IDs and break the toggle).'
        );
    }

    public function testClaudeDomIdsAreUnique(): void
    {
        $html = file_get_contents(__DIR__ . '/../public/admin/index.html');
        self::assertIsString($html);

        foreach (['claudeDefaultModel', 'claudeMaxTokens', 'claudeSpendLimit', 'claudeApiToggle', 'claudeSettingsSaveBtn', 'claudeRunnerChip'] as $id) {
            self::assertSame(
                1,
                substr_count($html, 'id="' . $id . '"'),
                "DOM id {$id} must be unique."
            );
        }
    }

    public function testClaudeRailNavEntryIsSingleAndWiredWithShortcut(): void
    {
        $html = file_get_contents(__DIR__ . '/../public/admin/index.html');
        self::assertIsString($html);

        // One rail link (with [s][l] shortcut) + one mobile tab + one sidebar link = 3 references
        // to /admin/settings/claude. Any extras indicate drift.
        $count = substr_count($html, 'href="/admin/settings/claude"');
        self::assertSame(3, $count, 'Expected exactly 3 /admin/settings/claude nav references (rail + mobile + sidebar).');

        self::assertStringContainsString('[s][l]', $html);
    }

    public function testClaudeSettingsPageRouteExists(): void
    {
        $router = file_get_contents(__DIR__ . '/../public/index.php');
        self::assertIsString($router);

        // The settings section regex must include `claude` or the page 404s.
        self::assertMatchesRegularExpression(
            '/settings\/\(general\|users\|agents\|memories\|projects\|profiles\|skills\|config\|claude\|apikeys\|joplin\)/',
            $router
        );
    }

    public function testClaudeApiToggleLivesInApiKeysPanelHeader(): void
    {
        $html = file_get_contents(__DIR__ . '/../public/admin/index.html');
        self::assertIsString($html);

        // Both toggles appear side-by-side in the API Keys panel so operators manage
        // OpenAI/Claude compat-API on/off in a single place.
        $apikeysPanelStart = strpos($html, 'data-settings-panel="apikeys"');
        self::assertNotFalse($apikeysPanelStart);
        $panelEnd = strpos($html, '</section>', $apikeysPanelStart);
        self::assertNotFalse($panelEnd);
        $panel = substr($html, $apikeysPanelStart, $panelEnd - $apikeysPanelStart);

        self::assertStringContainsString('id="openaiApiToggle"', $panel);
        self::assertStringContainsString('id="claudeApiToggle"', $panel);
    }
}
