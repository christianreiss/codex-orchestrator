import type { Engine } from '../util/engine.js';
import type { WrapperPlatform } from '../util/wrapper-platform.js';
import type { VersionSnapshot } from './version-snapshot.js';
import type {
  ResolvedWrapperBuild,
  WrapperBinRegistry,
} from './wrapper-bin-registry.js';
import { CXX_ARTIFACT, wrapperBinaryUrl } from './wrapper-bin-registry.js';
import {
  isLegacyShellWrapperVersion,
  withLegacyShellWrapperTransition,
} from './wrapper-transition.js';

export interface WrapperVersionProjectionInput {
  snapshot: VersionSnapshot;
  engine: Engine;
  submittedWrapperVersion: unknown;
  platform: WrapperPlatform;
  publicBaseUrl: string;
  binaries: WrapperBinRegistry;
}

/**
 * Replaces the boot-time compatibility tuple with one exact artifact for the
 * calling platform. The versions table intentionally remains a release
 * pointer; its Linux URL/hash must never leak into Darwin or arm64 responses.
 *
 * Date-style shell wrappers are the sole exception: they need the transition
 * launcher rather than a binary artifact and therefore retain the configured
 * target version with a null checksum.
 */
export async function projectWrapperVersionSnapshot(
  input: WrapperVersionProjectionInput,
): Promise<VersionSnapshot> {
  if (isLegacyShellWrapperVersion(input.submittedWrapperVersion)) {
    const resolved = await input.binaries.resolveCurrentBuild(
      input.engine,
      input.platform.os,
      input.platform.arch,
    );
    if (!resolved) return withoutWrapperTarget(input.snapshot);
    if (resolved.artifact !== CXX_ARTIFACT) {
      // During a rollback (or before cxx publication), date-style wrappers
      // may still upgrade directly to the immutable split Go artifact. Never
      // send them through the cxx transition launcher with split bytes.
      return withResolvedBuild(input, resolved);
    }
    return withLegacyShellWrapperTransition(
      { ...input.snapshot, wrapper_version: resolved.version },
      input.submittedWrapperVersion,
      input.engine,
    );
  }

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
