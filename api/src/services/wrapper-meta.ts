import type { WrapperBinRegistry, BinaryBuild } from './wrapper-bin-registry.js';
import type { Engine } from '../util/engine.js';

/**
 * Resolves the "current wrapper binary" snapshot for a (engine, platform) pair.
 * Used by `/wrapper/v2/meta` to tell the calling host what version + sha256 it
 * should be running and where to fetch the matching binary.
 */

export interface WrapperMetaService {
  forPlatform(
    engine: Engine,
    os: string,
    arch: string,
    publicBaseUrl: string,
  ): Promise<WrapperMetaPayload | null>;
  forEngine(engine: Engine, publicBaseUrl: string): Promise<EngineMetaPayload>;
}

export interface WrapperMetaPayload {
  engine: Engine;
  platform: string;
  version: string;
  sha256: string;
  size_bytes: number;
  binary_url: string;
}

export interface EngineMetaPayload {
  engine: Engine;
  schema_version: number;
  platforms: Record<
    string,
    { version: string; sha256: string; size_bytes: number; url_path: string }
  >;
}

export interface WrapperMetaDeps {
  binaries: WrapperBinRegistry;
  schemaVersion: number;
}

export function createWrapperMetaService(deps: WrapperMetaDeps): WrapperMetaService {
  function binaryName(engine: Engine): string {
    return engine === 'claude' ? 'clx' : 'cdx';
  }

  return {
    async forPlatform(engine, os, arch, publicBaseUrl) {
      const build: BinaryBuild | null = await deps.binaries.currentBuild(engine, os, arch);
      if (!build) return null;
      const base = publicBaseUrl.replace(/\/+$/, '');
      return {
        engine,
        platform: `${os}-${arch}`,
        version: build.version,
        sha256: build.sha256,
        size_bytes: build.size_bytes,
        binary_url: `${base}/wrapper/v2/bin/${engine}/${os}-${arch}/v${build.version}/${binaryName(engine)}`,
      };
    },

    async forEngine(engine, publicBaseUrl) {
      const manifest = await deps.binaries.engineManifest(engine, publicBaseUrl);
      return {
        engine,
        schema_version: deps.schemaVersion,
        platforms: manifest.platforms,
      };
    },
  };
}
