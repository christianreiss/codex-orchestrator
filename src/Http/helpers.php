<?php

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 * GitHub: https://github.com/christianreiss/codex-orchestrator
 *
 * Backward-compatibility shim: each function delegates to its static helper class.
 * Callers should migrate to direct static calls over time.
 */

use App\Http\AdminSessionHelper;
use App\Http\CorsHelper;
use App\Http\EnvironmentHelper;
use App\Http\InstallerHelper;
use App\Http\PayloadHelper;
use App\Http\RequestHelper;
use App\Http\SecurityHelper;
use App\Http\VersionHelper;
use App\Repositories\VersionRepository;
use App\Security\RateLimiter;
use App\Services\AdminAuthService;

function enforceGlobalRateLimit(?RateLimiter $rateLimiter, ?string $clientIp, string $method, string $path): void
{
    SecurityHelper::enforceGlobalRateLimit($rateLimiter, $clientIp, $method, $path);
}

function resolveMtls(): array
{
    return SecurityHelper::resolveMtls();
}

function isMtlsRequired(): bool
{
    return SecurityHelper::isMtlsRequired();
}

function isMtlsSatisfied(): bool
{
    return SecurityHelper::isMtlsSatisfied();
}

function isHttpsRequest(): bool
{
    return SecurityHelper::isHttpsRequest();
}

function normalizeOrigin(?string $origin): ?string
{
    return CorsHelper::normalizeOrigin($origin);
}

function allowedOrigins(): array
{
    return CorsHelper::allowedOrigins();
}

function isOriginAllowed(?string $origin): bool
{
    return CorsHelper::isOriginAllowed($origin);
}

function resolveRequestOrigin(): ?string
{
    return CorsHelper::resolveRequestOrigin();
}

function resolveQueryParam(string $key): ?string
{
    return RequestHelper::resolveQueryParam($key);
}

function resolveIntQuery(string $key): ?int
{
    return RequestHelper::resolveIntQuery($key);
}

function resolveStringQuery(string $key): ?string
{
    return RequestHelper::resolveStringQuery($key);
}

function resolveApiKey(): ?string
{
    return RequestHelper::resolveApiKey();
}

function resolveRequestScheme(): string
{
    return RequestHelper::resolveRequestScheme();
}

function resolveRequestHost(): string
{
    return RequestHelper::resolveRequestHost();
}

function resolveBaseUrl(): string
{
    return RequestHelper::resolveBaseUrl();
}

function normalizeBaseUrlCandidate(string $value): string
{
    return RequestHelper::normalizeBaseUrlCandidate($value);
}

function enforcePublicBaseUrlPolicy(string $path): void
{
    RequestHelper::enforcePublicBaseUrlPolicy($path);
}

function publicBaseUrlRequired(): bool
{
    return RequestHelper::publicBaseUrlRequired();
}

function strictHostValidationEnabled(): bool
{
    return RequestHelper::strictHostValidationEnabled();
}

function isHostValidationBypassPath(string $path): bool
{
    return RequestHelper::isHostValidationBypassPath($path);
}

function requestHostMatchesPublicBaseUrl(string $publicBase): bool
{
    return RequestHelper::requestHostMatchesPublicBaseUrl($publicBase);
}

function resolveClientIp(): ?string
{
    return RequestHelper::resolveClientIp();
}

function normalizeVersionValue(mixed $value): ?string
{
    return VersionHelper::normalizeVersionValue($value);
}

function normalizeBoolean(mixed $value): ?bool
{
    return VersionHelper::normalizeBoolean($value);
}

function normalizeReverseDnsModeInput(mixed $value): ?string
{
    return VersionHelper::normalizeReverseDnsModeInput($value);
}

function formatReverseDnsModeOutput(mixed $value): string
{
    return VersionHelper::formatReverseDnsModeOutput($value);
}

function quotaLimitPercent(VersionRepository $versionRepository): int
{
    return VersionHelper::quotaLimitPercent($versionRepository);
}

function quotaWeekPartition(VersionRepository $versionRepository): int
{
    return VersionHelper::quotaWeekPartition($versionRepository);
}

function modelUsesSparkQuotaLane(?string $model): ?bool
{
    return VersionHelper::modelUsesSparkQuotaLane($model);
}

function resolveActiveQuotaLaneForHost(array $host, VersionRepository $versionRepository, mixed $fallback = null): string
{
    return VersionHelper::resolveActiveQuotaLaneForHost($host, $versionRepository, $fallback);
}

function inactivityWindowDays(VersionRepository $versionRepository): int
{
    return VersionHelper::inactivityWindowDays($versionRepository);
}

function extractClientVersion(mixed $payload): ?string
{
    return VersionHelper::extractClientVersion($payload);
}

function extractWrapperVersion(mixed $payload): ?string
{
    return VersionHelper::extractWrapperVersion($payload);
}

function adminAccessMode(): string
{
    return AdminSessionHelper::adminAccessMode();
}

function resolveAdminSessionToken(AdminAuthService $adminAuthService): ?string
{
    return AdminSessionHelper::resolveAdminSessionToken($adminAuthService);
}

function resolveAdminSession(AdminAuthService $adminAuthService): ?array
{
    return AdminSessionHelper::resolveAdminSession($adminAuthService);
}

function requireAdminAccess(): void
{
    AdminSessionHelper::requireAdminAccess();
}

function requireAdminCapability(string $capability): void
{
    AdminSessionHelper::requireAdminCapability($capability);
}

function adminWebAuthnRpId(): string
{
    return AdminSessionHelper::adminWebAuthnRpId();
}

function adminWebAuthnRpName(): string
{
    return AdminSessionHelper::adminWebAuthnRpName();
}

function adminWebAuthnOrigin(): string
{
    return AdminSessionHelper::adminWebAuthnOrigin();
}

/**
 * @return array{command:string,last_refresh:string,digest:string,installation_id?:string}
 */
function extractSyncAuthFingerprint(mixed $payload): array
{
    return PayloadHelper::extractSyncAuthFingerprint($payload);
}

function extractSyncAuthCandidate(mixed $payload): ?array
{
    return PayloadHelper::extractSyncAuthCandidate($payload);
}

/**
 * @return array{username:?string,hostname:?string}
 */
function extractSyncHostUserInput(mixed $payload): array
{
    return PayloadHelper::extractSyncHostUserInput($payload);
}

function resolveInstallerBaseUrl(?array $tokenRow = null): string
{
    return InstallerHelper::resolveInstallerBaseUrl($tokenRow);
}

function resolveSeedBaseUrl(?array $tokenRow = null): string
{
    return InstallerHelper::resolveSeedBaseUrl($tokenRow);
}

function installerCommand(string $baseUrl, string $token): string
{
    return InstallerHelper::installerCommand($baseUrl, $token);
}

function seedAuthCommand(string $baseUrl, string $token): string
{
    return InstallerHelper::seedAuthCommand($baseUrl, $token);
}

function installerTokenExpired(array $tokenRow): bool
{
    return InstallerHelper::installerTokenExpired($tokenRow);
}

function seedAuthTokenExpired(array $tokenRow): bool
{
    return InstallerHelper::seedAuthTokenExpired($tokenRow);
}

function emitInstaller(string $body, int $status = 200, ?string $expiresAt = null): void
{
    InstallerHelper::emitInstaller($body, $status, $expiresAt);
}

function emitSeedScript(string $body, int $status = 200, ?string $expiresAt = null): void
{
    InstallerHelper::emitSeedScript($body, $status, $expiresAt);
}

function installerError(string $message, int $status = 400, ?string $expiresAt = null): void
{
    InstallerHelper::installerError($message, $status, $expiresAt);
}

function seedAuthError(string $message, int $status = 400, ?string $expiresAt = null): void
{
    InstallerHelper::seedAuthError($message, $status, $expiresAt);
}

function runtimeEnvironment(): string
{
    return EnvironmentHelper::runtimeEnvironment();
}

function isProductionEnvironment(): bool
{
    return EnvironmentHelper::isProductionEnvironment();
}

function generateUuid(): string
{
    return EnvironmentHelper::generateUuid();
}
