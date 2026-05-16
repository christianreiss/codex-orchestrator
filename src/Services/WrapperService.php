<?php

declare(strict_types=1);

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 * GitHub: https://github.com/christianreiss/codex-orchestrator
 */

namespace App\Services;

use App\Repositories\VersionRepository;
use App\Security\SecretBox;
use App\Services\Wrapper\V2\BinaryRegistry;
use App\Support\Engine;

/**
 * v2 adapter exposing the legacy WrapperService API. The internals are now a
 * thin view over the v2 BinaryRegistry + bootstrap shim — there is no bash
 * baking, no template files, no placeholder substitution.
 *
 * Callers (AuthService, ClientVersionService, CronController, etc.) keep
 * receiving the same `{engine, version, sha256, size_bytes, updated_at, url}`
 * envelope they did before the cutover, so the over-the-wire API surface
 * stays compatible.
 */
class WrapperService
{
    private ?BinaryRegistry $registry = null;

    public function __construct(
        private readonly VersionRepository $versions,
        private readonly string $storagePath,
        private readonly string $seedPath,
        private readonly ?string $installationId = null,
        private readonly ?SecretBox $secretBox = null,
        ?string $clxStoragePath = null,
        ?string $clxSeedPath = null,
        ?BinaryRegistry $registry = null,
    ) {
        unset($this->storagePath, $this->seedPath); // kept in signature for back-compat
        unset($clxStoragePath, $clxSeedPath);
        $this->registry = $registry;
    }

    /** Inject (or replace) the v2 binary registry — used during request bootstrap. */
    public function setRegistry(BinaryRegistry $registry): void
    {
        $this->registry = $registry;
    }

    public function ensureSeeded(string $engine = Engine::CODEX): void
    {
        // Seeding is now CI's responsibility (binaries are committed under
        // storage/wrapper/v2/bin/). We still keep version-key cache warm so
        // older callers reading versions['wrapper'] / versions['wrapper_claude']
        // get a meaningful value.
        $meta = $this->metadata($engine);
        if (is_string($meta['version'])) {
            $key = $engine === Engine::CLAUDE ? 'wrapper_claude' : 'wrapper';
            $this->versions->set($key, $meta['version']);
        }
    }

    public function ensureAllSeeded(): void
    {
        foreach (Engine::ALL as $engine) {
            $this->ensureSeeded($engine);
        }
    }

    /**
     * @return array{engine:string,version:?string,sha256:?string,size_bytes:?int,updated_at:?string,url:?string}
     */
    public function metadata(string $engine = Engine::CODEX): array
    {
        $engine = Engine::isValid($engine) ? $engine : Engine::CODEX;
        $reg = $this->registry;
        if ($reg === null) {
            return [
                'engine'     => $engine,
                'version'    => null,
                'sha256'     => null,
                'size_bytes' => null,
                'updated_at' => null,
                'url'        => null,
            ];
        }
        $version = $reg->latestVersion($engine, 'linux', 'amd64');
        if ($version === null) {
            return [
                'engine'     => $engine,
                'version'    => null,
                'sha256'     => null,
                'size_bytes' => null,
                'updated_at' => null,
                'url'        => null,
            ];
        }
        $path = $reg->path($engine, 'linux', 'amd64', $version);
        $sha = $path !== null ? (hash_file('sha256', $path) ?: null) : null;
        $size = $path !== null ? (filesize($path) ?: null) : null;
        $mtime = $path !== null ? filemtime($path) : false;
        $updatedAt = $mtime !== false ? gmdate(DATE_ATOM, $mtime) : null;

        return [
            'engine'     => $engine,
            'version'    => $version,
            'sha256'     => $sha,
            'size_bytes' => $size,
            'updated_at' => $updatedAt,
            'url'        => '/wrapper/v2/download?engine=' . $engine,
        ];
    }

    /**
     * v2 has no per-host baked wrapper content — the bootstrap shim is host-
     * agnostic at this level (the host's API key is fetched via the v2 config
     * endpoint, not embedded in the shim). The `content` field is therefore
     * kept null and callers must use `/wrapper/v2/download` to fetch the shim.
     *
     * @param array<string,mixed> $host
     * @return array{engine:string,version:?string,sha256:?string,size_bytes:?int,updated_at:?string,url:?string,content:?string}
     */
    public function bakedForHost(array $host, string $baseUrl, ?string $caFile = null, string $engine = Engine::CODEX): array
    {
        unset($host, $baseUrl, $caFile);
        return array_merge($this->metadata($engine), ['content' => null]);
    }
}
