<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';
require_once __DIR__ . '/ContractSchemaValidator.php';

final class ContractSchemasTest extends TestCase
{
    public function testSchemaFilesAreValidJson(): void
    {
        foreach ($this->schemaPaths() as $schemaPath) {
            $schema = $this->loadJson($schemaPath);
            $this->assertIsArray($schema, 'Expected schema to decode as object: ' . $schemaPath);
            $this->assertSame('object', $schema['type'] ?? null, 'Expected top-level schema type to be object: ' . $schemaPath);
        }
    }

    /**
     * @dataProvider validFixtureProvider
     */
    public function testValidFixtureMatchesSchema(string $schemaPath, string $fixturePath): void
    {
        $schema = $this->loadJson($schemaPath);
        $fixture = $this->loadJson($fixturePath);

        $errors = ContractSchemaValidator::validate($fixture, $schema);
        $this->assertSame([], $errors, "Expected fixture to match schema:\n" . implode("\n", $errors));
    }

    /**
     * @dataProvider invalidFixtureProvider
     */
    public function testInvalidFixtureFailsSchema(string $schemaPath, string $fixturePath): void
    {
        $schema = $this->loadJson($schemaPath);
        $fixture = $this->loadJson($fixturePath);

        $errors = ContractSchemaValidator::validate($fixture, $schema);
        $this->assertNotSame([], $errors, 'Expected fixture to fail schema validation');
    }

    /**
     * @return array<string, array{0:string, 1:string}>
     */
    public static function validFixtureProvider(): array
    {
        return [
            'auth retrieve upload_required' => [
                __DIR__ . '/../docs/contracts/auth-retrieve.schema.json',
                __DIR__ . '/contracts/fixtures/auth-retrieve/valid-upload-required.json',
            ],
            'auth retrieve outdated' => [
                __DIR__ . '/../docs/contracts/auth-retrieve.schema.json',
                __DIR__ . '/contracts/fixtures/auth-retrieve/valid-outdated.json',
            ],
            'auth store updated' => [
                __DIR__ . '/../docs/contracts/auth-store.schema.json',
                __DIR__ . '/contracts/fixtures/auth-store/valid-updated.json',
            ],
            'auth store unchanged' => [
                __DIR__ . '/../docs/contracts/auth-store.schema.json',
                __DIR__ . '/contracts/fixtures/auth-store/valid-unchanged.json',
            ],
            'versions' => [
                __DIR__ . '/../docs/contracts/versions.schema.json',
                __DIR__ . '/contracts/fixtures/versions/valid.json',
            ],
            'usage success' => [
                __DIR__ . '/../docs/contracts/usage-ingest.schema.json',
                __DIR__ . '/contracts/fixtures/usage-ingest/valid-success.json',
            ],
            'usage degraded' => [
                __DIR__ . '/../docs/contracts/usage-ingest.schema.json',
                __DIR__ . '/contracts/fixtures/usage-ingest/valid-degraded.json',
            ],
            'sync status unchanged' => [
                __DIR__ . '/../docs/contracts/sync-status.schema.json',
                __DIR__ . '/contracts/fixtures/sync-status/valid-unchanged.json',
            ],
            'sync bootstrap updated' => [
                __DIR__ . '/../docs/contracts/sync-bootstrap.schema.json',
                __DIR__ . '/contracts/fixtures/sync-bootstrap/valid-updated.json',
            ],
        ];
    }

    /**
     * @return array<string, array{0:string, 1:string}>
     */
    public static function invalidFixtureProvider(): array
    {
        return [
            'auth retrieve upload_required missing action' => [
                __DIR__ . '/../docs/contracts/auth-retrieve.schema.json',
                __DIR__ . '/contracts/fixtures/auth-retrieve/invalid-upload-required-missing-action.json',
            ],
            'auth store updated missing auth' => [
                __DIR__ . '/../docs/contracts/auth-store.schema.json',
                __DIR__ . '/contracts/fixtures/auth-store/invalid-updated-missing-auth.json',
            ],
            'versions missing runner_state' => [
                __DIR__ . '/../docs/contracts/versions.schema.json',
                __DIR__ . '/contracts/fixtures/versions/invalid-missing-runner-state.json',
            ],
            'usage success missing usages' => [
                __DIR__ . '/../docs/contracts/usage-ingest.schema.json',
                __DIR__ . '/contracts/fixtures/usage-ingest/invalid-success-missing-usages.json',
            ],
            'sync status missing components' => [
                __DIR__ . '/../docs/contracts/sync-status.schema.json',
                __DIR__ . '/contracts/fixtures/sync-status/invalid-missing-components.json',
            ],
            'sync bootstrap missing host users' => [
                __DIR__ . '/../docs/contracts/sync-bootstrap.schema.json',
                __DIR__ . '/contracts/fixtures/sync-bootstrap/invalid-missing-host-users.json',
            ],
        ];
    }

    /**
     * @return list<string>
     */
    private function schemaPaths(): array
    {
        return [
            __DIR__ . '/../docs/contracts/auth-retrieve.schema.json',
            __DIR__ . '/../docs/contracts/auth-store.schema.json',
            __DIR__ . '/../docs/contracts/versions.schema.json',
            __DIR__ . '/../docs/contracts/usage-ingest.schema.json',
            __DIR__ . '/../docs/contracts/sync-status.schema.json',
            __DIR__ . '/../docs/contracts/sync-bootstrap.schema.json',
        ];
    }

    private function loadJson(string $path): array
    {
        $json = @file_get_contents($path);
        $this->assertIsString($json, 'Expected to read JSON file: ' . $path);

        $decoded = json_decode($json, true);
        $this->assertIsArray($decoded, 'Expected valid JSON object in: ' . $path);

        return $decoded;
    }
}
