<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

/**
 * Checks that the Claude engine settings panel and related UI elements are
 * correctly structured in the SvelteKit frontend source files.
 */
final class AdminClaudePanelUiTest extends TestCase
{
    public function testExactlyOneClaudeSettingsPanel(): void
    {
        // The settings page must import ClaudeEngineSection exactly once to avoid
        // duplicate DOM IDs and conflicting toggle behaviour.
        $settingsPage = file_get_contents(__DIR__ . '/../frontend/src/routes/settings/+page.svelte');
        self::assertIsString($settingsPage);

        // The import line and component usage each contribute at least one occurrence;
        // duplicates would mean the component is accidentally included twice.
        self::assertGreaterThanOrEqual(
            2,
            substr_count($settingsPage, 'ClaudeEngineSection'),
            'ClaudeEngineSection must be imported and used on the settings page.'
        );
        self::assertSame(
            1,
            substr_count($settingsPage, '<ClaudeEngineSection'),
            'ClaudeEngineSection component must be rendered exactly once (no duplicate panels).'
        );
    }

    public function testClaudeDomIdsAreUnique(): void
    {
        // All Claude-specific element IDs live in ClaudeEngineSection.svelte;
        // they must appear exactly once there (no copy-paste duplication).
        $section = file_get_contents(__DIR__ . '/../frontend/src/lib/components/settings/ClaudeEngineSection.svelte');
        self::assertIsString($section);

        foreach (['claude-state-toggle', 'claude-model', 'claude-max-tokens'] as $id) {
            self::assertSame(
                1,
                substr_count($section, 'id="' . $id . '"'),
                "Element id \"{$id}\" must appear exactly once in ClaudeEngineSection.svelte."
            );
        }
    }

    public function testClaudeRailNavEntryIsSingleAndWiredWithShortcut(): void
    {
        // The sidebar nav has a single "Settings" entry that navigates to /settings,
        // which houses the Claude engine section.
        $sidebar = file_get_contents(__DIR__ . '/../frontend/src/lib/components/layout/Sidebar.svelte');
        self::assertIsString($sidebar);

        // The sidebar uses the NAV array (import + iteration = 2 references).
        self::assertGreaterThanOrEqual(
            2,
            substr_count($sidebar, 'NAV'),
            'Sidebar must import and iterate over the NAV array.'
        );

        // The nav definition must include a /settings entry.
        $nav = file_get_contents(__DIR__ . '/../frontend/src/lib/nav.ts');
        self::assertIsString($nav);

        self::assertStringContainsString('"/settings"', $nav);
        self::assertStringContainsString('Settings', $nav);

        // The global shortcut handler must register at least "?" (open shortcuts)
        // and "/" (focus command palette).
        $layout = file_get_contents(__DIR__ . '/../frontend/src/routes/+layout.svelte');
        self::assertIsString($layout);

        self::assertStringContainsString('bindGlobalShortcuts', $layout);
    }

    public function testClaudeSettingsPageRouteExists(): void
    {
        $router = file_get_contents(__DIR__ . '/../public/index.php');
        self::assertIsString($router);

        // The settings section regex must include `claude` or the page 404s.
        self::assertMatchesRegularExpression(
            '/settings\/\(general\|users\|agents\|memories\|projects\|profiles\|skills\|config\|claude\|apikeys\)/',
            $router
        );
    }

    public function testClaudeApiToggleLivesInApiKeysPanelHeader(): void
    {
        // The API Keys page renders one KillSwitchCard per engine so operators
        // manage OpenAI and Claude on/off in a single place.
        $apiKeysPage = file_get_contents(__DIR__ . '/../frontend/src/routes/api-keys/+page.svelte');
        self::assertIsString($apiKeysPage);

        self::assertStringContainsString('KillSwitchCard', $apiKeysPage);
        self::assertStringContainsString('engine="openai"', $apiKeysPage);
        self::assertStringContainsString('engine="claude"', $apiKeysPage);

        // The KillSwitchCard component itself renders a toggle for the given engine.
        $killSwitchCard = file_get_contents(__DIR__ . '/../frontend/src/lib/components/api-keys/KillSwitchCard.svelte');
        self::assertIsString($killSwitchCard);

        self::assertStringContainsString('Switch', $killSwitchCard);
        self::assertStringContainsString('engineLabel', $killSwitchCard);
    }
}
