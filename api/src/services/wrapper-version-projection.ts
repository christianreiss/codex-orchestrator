import type { Engine } from '../util/engine.js';
import type { WrapperPlatform } from '../util/wrapper-platform.js';
import type { VersionSnapshot } from './version-snapshot.js';
import type {
  ResolvedWrapperBuild,
  WrapperBinRegistry,
} from './wrapper-bin-registry.js';
import { wrapperBinaryUrl } from './wrapper-bin-registry.js';

export interface WrapperVersionProjectionInput {
  snapshot: VersionSnapshot;
  engine: Engine;
  platform: WrapperPlatform;
  publicBaseUrl: string;
  binaries: WrapperBinRegistry;
}

/**
 * Replaces the boot-time compatibility tuple with one exact artifact for the
 * calling platform. The versions table intentionally remains a release
 * pointer; its Linux URL/hash must never leak into Darwin or arm64 responses.
 */
export async function projectWrapperVersionSnapshot(
  input: WrapperVersionProjectionInput,
): Promise<VersionSnapshot> {
  const targetVersion = input.snapshot.wrapper_version;
  if (!targetVersion) return withoutWrapperTarget(input.snapshot);

  const resolved = await input.binaries.resolveVersion(
    input.engine,
    input.platform.os,
    input.platform.arch,
    targetVersion,
  );
  if (!resolved) return withoutWrapperTarget(input.snapshot);

  return withResolvedBuild(input, resolved);
}

function withResolvedBuild(
  input: WrapperVersionProjectionInput,
  resolved: ResolvedWrapperBuild,
): VersionSnapshot {
  return {
    ...input.snapshot,
    wrapper_version: resolved.version,
    wrapper_sha256: resolved.sha256,
    wrapper_url: wrapperBinaryUrl(
      input.publicBaseUrl,
      resolved.artifact,
      input.platform.os,
      input.platform.arch,
      resolved.version,
    ),
  };
}

function withoutWrapperTarget(snapshot: VersionSnapshot): VersionSnapshot {
  return {
    ...snapshot,
    wrapper_version: null,
    wrapper_sha256: null,
    wrapper_url: null,
  };
}
