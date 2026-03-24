<?php

declare(strict_types=1);

use App\Services\TomlRenderer;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class TomlRendererTest extends TestCase
{
    private TomlRenderer $renderer;

    protected function setUp(): void
    {
        $this->renderer = new TomlRenderer();
    }

    // -------------------------------------------------------------------------
    // buildToml – root keys
    // -------------------------------------------------------------------------

    public function testBuildTomlEmptySettingsProducesEmptyNotifyLine(): void
    {
        // An empty notify array is still emitted as notify = []
        $result = $this->renderer->buildToml([]);
        $this->assertStringContainsString('notify = []', $result);
        $this->assertStringEndsWith("\n", $result);
    }

    public function testBuildTomlRootStringKey(): void
    {
        $result = $this->renderer->buildToml(['model' => 'gpt-5.4']);
        $this->assertStringContainsString('model = "gpt-5.4"', $result);
    }

    public function testBuildTomlRootBooleanKey(): void
    {
        $result = $this->renderer->buildToml(['web_search' => true]);
        $this->assertStringContainsString('web_search = true', $result);
    }

    public function testBuildTomlRootIntKey(): void
    {
        $result = $this->renderer->buildToml(['model_context_window' => 128000]);
        $this->assertStringContainsString('model_context_window = 128000', $result);
    }

    public function testBuildTomlRootFloatKey(): void
    {
        $result = $this->renderer->buildToml(['model_max_output_tokens' => 16384]);
        $this->assertStringContainsString('model_max_output_tokens = 16384', $result);
    }

    public function testBuildTomlNullAndEmptyRootKeysOmitted(): void
    {
        $result = $this->renderer->buildToml(['model' => null, 'profile' => '']);
        $this->assertStringNotContainsString('model', $result);
        $this->assertStringNotContainsString('profile', $result);
    }

    // -------------------------------------------------------------------------
    // buildToml – notify
    // -------------------------------------------------------------------------

    public function testBuildTomlNotifyIndexedArray(): void
    {
        $result = $this->renderer->buildToml(['notify' => ['slack', 'email']]);
        $this->assertStringContainsString('notify = ["slack", "email"]', $result);
    }

    public function testBuildTomlNotifyAssocConvertedToIndexed(): void
    {
        // Assoc notify arrays must be re-indexed before rendering.
        $result = $this->renderer->buildToml(['notify' => ['a' => 'slack', 'b' => 'email']]);
        $this->assertStringContainsString('notify = ["slack", "email"]', $result);
    }

    public function testBuildTomlNotifyEmptyRendersEmptyArray(): void
    {
        // An empty notify array is rendered as notify = [] (not omitted).
        $result = $this->renderer->buildToml(['notify' => []]);
        $this->assertStringContainsString('notify = []', $result);
    }

    // -------------------------------------------------------------------------
    // buildToml – [features] section
    // -------------------------------------------------------------------------

    public function testBuildTomlFeaturesSection(): void
    {
        $result = $this->renderer->buildToml(['features' => ['apply_patch_freeform' => true]]);
        $this->assertStringContainsString('[features]', $result);
        $this->assertStringContainsString('apply_patch_freeform = true', $result);
    }

    public function testBuildTomlFeaturesDropsWebSearch(): void
    {
        $result = $this->renderer->buildToml([
            'features' => [
                'web_search' => true,
                'web_search_request' => true,
                'web_search_cached' => true,
                'apply_patch_freeform' => true,
            ],
        ]);
        $this->assertStringNotContainsString('web_search =', $result);
        $this->assertStringNotContainsString('web_search_request', $result);
        $this->assertStringNotContainsString('web_search_cached', $result);
        $this->assertStringContainsString('apply_patch_freeform = true', $result);
    }

    public function testBuildTomlFeaturesDropsObsoleteKeys(): void
    {
        $result = $this->renderer->buildToml([
            'features' => [
                'steer' => true,
                'remote_models' => true,
                'request_rule' => true,
            ],
        ]);
        $this->assertStringNotContainsString('[features]', $result);
        $this->assertStringNotContainsString('steer', $result);
    }

    public function testBuildTomlFeaturesEmptyOmitsSection(): void
    {
        $result = $this->renderer->buildToml(['features' => []]);
        $this->assertStringNotContainsString('[features]', $result);
    }

    // -------------------------------------------------------------------------
    // buildToml – [notice] and [security] sections
    // -------------------------------------------------------------------------

    public function testBuildTomlNoticeSection(): void
    {
        $result = $this->renderer->buildToml(['notice' => ['message' => 'Hello fleet']]);
        $this->assertStringContainsString('[notice]', $result);
        $this->assertStringContainsString('message = "Hello fleet"', $result);
    }

    public function testBuildTomlSecuritySection(): void
    {
        $result = $this->renderer->buildToml([
            'security' => ['dangerously_bypass_approvals_and_sandbox' => false],
        ]);
        $this->assertStringContainsString('[security]', $result);
        $this->assertStringContainsString('dangerously_bypass_approvals_and_sandbox = false', $result);
    }

    // -------------------------------------------------------------------------
    // buildToml – [sandbox_workspace_write] section
    // -------------------------------------------------------------------------

    public function testBuildTomlSandboxWorkspaceWriteSection(): void
    {
        $result = $this->renderer->buildToml([
            'sandbox_workspace_write' => [
                'network_access' => true,
                'exclude_slash_tmp' => false,
                'writable_roots' => ['/tmp', '/home/user'],
            ],
        ]);
        $this->assertStringContainsString('[sandbox_workspace_write]', $result);
        $this->assertStringContainsString('network_access = true', $result);
        $this->assertStringContainsString('exclude_slash_tmp = false', $result);
        $this->assertStringContainsString('writable_roots = ["/tmp", "/home/user"]', $result);
    }

    // -------------------------------------------------------------------------
    // buildToml – [shell_environment_policy] section
    // -------------------------------------------------------------------------

    public function testBuildTomlShellEnvironmentPolicySection(): void
    {
        $result = $this->renderer->buildToml([
            'shell_environment_policy' => [
                'inherit' => 'all',
                'set' => ['FOO' => 'bar'],
            ],
        ]);
        $this->assertStringContainsString('[shell_environment_policy]', $result);
        $this->assertStringContainsString('inherit = "all"', $result);
        $this->assertStringContainsString('set = { FOO = "bar" }', $result);
    }

    // -------------------------------------------------------------------------
    // buildToml – [profiles.*] sections
    // -------------------------------------------------------------------------

    public function testBuildTomlProfileSection(): void
    {
        $result = $this->renderer->buildToml([
            'profiles' => [
                ['name' => 'fast', 'model' => 'gpt-5.4-mini', 'approval_policy' => 'auto'],
            ],
        ]);
        $this->assertStringContainsString('[profiles.fast]', $result);
        $this->assertStringContainsString('model = "gpt-5.4-mini"', $result);
        $this->assertStringContainsString('approval_policy = "auto"', $result);
    }

    public function testBuildTomlProfilesSortedByName(): void
    {
        $result = $this->renderer->buildToml([
            'profiles' => [
                ['name' => 'zebra', 'model' => 'gpt-5.4'],
                ['name' => 'alpha', 'model' => 'gpt-5.4-mini'],
            ],
        ]);
        $posAlpha = strpos($result, '[profiles.alpha]');
        $posZebra = strpos($result, '[profiles.zebra]');
        $this->assertNotFalse($posAlpha);
        $this->assertNotFalse($posZebra);
        $this->assertLessThan($posZebra, $posAlpha);
    }

    public function testBuildTomlProfileWithNameRequiringQuotes(): void
    {
        $result = $this->renderer->buildToml([
            'profiles' => [
                ['name' => 'my profile', 'model' => 'gpt-5.4'],
            ],
        ]);
        $this->assertStringContainsString('[profiles."my profile"]', $result);
    }

    public function testBuildTomlProfileEmptyNameSkipped(): void
    {
        $result = $this->renderer->buildToml([
            'profiles' => [
                ['name' => '', 'model' => 'gpt-5.4'],
            ],
        ]);
        $this->assertStringNotContainsString('[profiles.', $result);
    }

    public function testBuildTomlProfileWithFeaturesSubsection(): void
    {
        $result = $this->renderer->buildToml([
            'profiles' => [
                [
                    'name' => 'dev',
                    'features' => ['apply_patch_freeform' => true],
                ],
            ],
        ]);
        $this->assertStringContainsString('[profiles.dev.features]', $result);
        $this->assertStringContainsString('apply_patch_freeform = true', $result);
    }

    public function testBuildTomlProfileWithSandboxSubsection(): void
    {
        $result = $this->renderer->buildToml([
            'profiles' => [
                [
                    'name' => 'sandboxed',
                    'sandbox_workspace_write' => ['network_access' => false],
                ],
            ],
        ]);
        $this->assertStringContainsString('[profiles.sandboxed.sandbox_workspace_write]', $result);
        $this->assertStringContainsString('network_access = false', $result);
    }

    // -------------------------------------------------------------------------
    // buildToml – [mcp_servers.*] sections
    // -------------------------------------------------------------------------

    public function testBuildTomlMcpServerSection(): void
    {
        $result = $this->renderer->buildToml([
            'mcp_servers' => [
                ['name' => 'orchestrator', 'command' => 'cdx', 'args' => ['--mcp'], 'enabled' => true],
            ],
        ]);
        $this->assertStringContainsString('[mcp_servers.orchestrator]', $result);
        $this->assertStringContainsString('command = "cdx"', $result);
        $this->assertStringContainsString('args = ["--mcp"]', $result);
        $this->assertStringContainsString('enabled = true', $result);
    }

    public function testBuildTomlMcpServerEmptyNameSkipped(): void
    {
        $result = $this->renderer->buildToml([
            'mcp_servers' => [
                ['name' => null, 'command' => 'cdx'],
            ],
        ]);
        $this->assertStringNotContainsString('[mcp_servers.', $result);
    }

    public function testBuildTomlMcpServerWithHttpHeaders(): void
    {
        $result = $this->renderer->buildToml([
            'mcp_servers' => [
                [
                    'name' => 'remote',
                    'url' => 'https://example.com/mcp',
                    'http_headers' => ['Authorization' => 'Bearer tok'],
                ],
            ],
        ]);
        $this->assertStringContainsString('http_headers = { Authorization = "Bearer tok" }', $result);
    }

    // -------------------------------------------------------------------------
    // buildToml – [otel] section
    // -------------------------------------------------------------------------

    public function testBuildTomlOtelOtlpHttp(): void
    {
        $result = $this->renderer->buildToml([
            'otel' => [
                'exporter' => 'otlp-http',
                'endpoint' => 'https://otel.example.com',
                'protocol' => 'http/protobuf',
            ],
        ]);
        $this->assertStringContainsString('[otel]', $result);
        // otlp-http matches [A-Za-z0-9_-]+ so it is not quoted as a TOML key
        $this->assertStringContainsString('otlp-http', $result);
        $this->assertStringContainsString('endpoint = "https://otel.example.com"', $result);
    }

    public function testBuildTomlOtelOtlpGrpc(): void
    {
        $result = $this->renderer->buildToml([
            'otel' => [
                'exporter' => 'otlp-grpc',
                'endpoint' => 'grpc://otel.example.com:4317',
            ],
        ]);
        $this->assertStringContainsString('[otel]', $result);
        // otlp-grpc matches [A-Za-z0-9_-]+ so it is not quoted as a TOML key
        $this->assertStringContainsString('otlp-grpc', $result);
    }

    public function testBuildTomlOtelFallbackExporter(): void
    {
        $result = $this->renderer->buildToml([
            'otel' => ['exporter' => 'none', 'environment' => 'prod'],
        ]);
        $this->assertStringContainsString('[otel]', $result);
        $this->assertStringContainsString('exporter = "none"', $result);
        $this->assertStringContainsString('environment = "prod"', $result);
    }

    // -------------------------------------------------------------------------
    // buildToml – custom_toml
    // -------------------------------------------------------------------------

    public function testBuildTomlCustomTomlAppended(): void
    {
        $result = $this->renderer->buildToml([
            'model' => 'gpt-5.4',
            'custom_toml' => "[extra]\nkey = \"value\"",
        ]);
        $this->assertStringContainsString('[extra]', $result);
        $this->assertStringContainsString('key = "value"', $result);
    }

    public function testBuildTomlCustomTomlBlankOmitted(): void
    {
        $result = $this->renderer->buildToml([
            'model' => 'gpt-5.4',
            'custom_toml' => "   \n",
        ]);
        $this->assertStringNotContainsString('[extra]', $result);
    }

    // -------------------------------------------------------------------------
    // buildToml – output always ends with a newline
    // -------------------------------------------------------------------------

    public function testBuildTomlAlwaysEndsWithNewline(): void
    {
        $result = $this->renderer->buildToml(['model' => 'gpt-5.4']);
        $this->assertStringEndsWith("\n", $result);
    }

    // -------------------------------------------------------------------------
    // escapeString
    // -------------------------------------------------------------------------

    public function testEscapeStringLeavesPlainStringUntouched(): void
    {
        $this->assertSame('hello world', $this->renderer->escapeString('hello world'));
    }

    public function testEscapeStringEscapesBackslash(): void
    {
        $this->assertSame('C:\\\\Users', $this->renderer->escapeString('C:\\Users'));
    }

    public function testEscapeStringEscapesDoubleQuote(): void
    {
        $this->assertSame('say \\"hi\\"', $this->renderer->escapeString('say "hi"'));
    }

    public function testEscapeStringEscapesNewlineAndTab(): void
    {
        $this->assertSame("line1\\nline2\\t", $this->renderer->escapeString("line1\nline2\t"));
    }

    // -------------------------------------------------------------------------
    // tomlString
    // -------------------------------------------------------------------------

    public function testTomlStringWrapsInDoubleQuotes(): void
    {
        $this->assertSame('"hello"', $this->renderer->tomlString('hello'));
    }

    public function testTomlStringEscapesBackslashAndQuote(): void
    {
        $this->assertSame('"C:\\\\path\\"name"', $this->renderer->tomlString('C:\\path"name'));
    }

    // -------------------------------------------------------------------------
    // normalizeHomePath
    // -------------------------------------------------------------------------

    public function testNormalizeHomePathReturnsExplicitPath(): void
    {
        $result = $this->renderer->normalizeHomePath('/home/alice', null);
        $this->assertSame('/home/alice', $result);
    }

    public function testNormalizeHomePathTrimsWhitespace(): void
    {
        $result = $this->renderer->normalizeHomePath('  /home/bob  ', null);
        $this->assertSame('/home/bob', $result);
    }

    public function testNormalizeHomePathFallsBackToUsername(): void
    {
        $result = $this->renderer->normalizeHomePath(null, 'charlie');
        $this->assertSame('/home/charlie', $result);
    }

    public function testNormalizeHomePathRejectsRelativePath(): void
    {
        $result = $this->renderer->normalizeHomePath('home/relative', null);
        $this->assertNull($result);
    }

    public function testNormalizeHomePathRejectsControlChars(): void
    {
        $result = $this->renderer->normalizeHomePath("/home/bad\x00path", null);
        $this->assertNull($result);
    }

    public function testNormalizeHomePathRejectsInvalidUsername(): void
    {
        $result = $this->renderer->normalizeHomePath(null, 'user name with spaces');
        $this->assertNull($result);
    }

    public function testNormalizeHomePathNullBothReturnsNull(): void
    {
        $result = $this->renderer->normalizeHomePath(null, null);
        $this->assertNull($result);
    }

    public function testNormalizeHomePathEmptyStringsReturnNull(): void
    {
        $result = $this->renderer->normalizeHomePath('', '');
        $this->assertNull($result);
    }

    // -------------------------------------------------------------------------
    // injectTrustedProjectToml
    // -------------------------------------------------------------------------

    public function testInjectTrustedProjectTomlAppendsSection(): void
    {
        $base = "model = \"gpt-5.4\"\n";
        $result = $this->renderer->injectTrustedProjectToml($base, '/home/alice/projects/foo');
        $this->assertStringContainsString('[projects."/home/alice/projects/foo"]', $result);
        $this->assertStringContainsString('trust_level = "trusted"', $result);
    }

    public function testInjectTrustedProjectTomlIdempotent(): void
    {
        $base = "model = \"gpt-5.4\"\n";
        $once = $this->renderer->injectTrustedProjectToml($base, '/home/alice/proj');
        $twice = $this->renderer->injectTrustedProjectToml($once, '/home/alice/proj');
        $this->assertSame($once, $twice);
    }

    public function testInjectTrustedProjectTomlNoPathReturnsUnchanged(): void
    {
        $base = "model = \"gpt-5.4\"\n";
        $result = $this->renderer->injectTrustedProjectToml($base, null);
        $this->assertSame($base, $result);
    }

    public function testInjectTrustedProjectTomlEmptyContentGetsSection(): void
    {
        $result = $this->renderer->injectTrustedProjectToml('', '/home/alice');
        $this->assertStringContainsString('[projects."/home/alice"]', $result);
        // Should not add a leading blank separator when content is empty.
        $this->assertStringStartsWith('[projects.', $result);
    }
}
