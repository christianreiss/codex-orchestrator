import type { ReadStream } from 'node:fs';
import type { WrapperBinRegistry } from './wrapper-bin-registry.js';
import type { Engine } from '../util/engine.js';

/**
 * Thin facade over the binary registry for HTTP route use. The route is
 * responsible for setting `Content-Disposition`; this service just supplies a
 * read stream + size + sha for the requested artifact.
 */

export interface WrapperDownload {
  stream: ReadStream;
  fileName: string;
  size: number;
  sha256?: string;
}

export interface WrapperDownloadService {
  open(engine: Engine, os: string, arch: string, version: string): Promise<WrapperDownload>;
}

export interface WrapperDownloadDeps {
  binaries: WrapperBinRegistry;
}

export function createWrapperDownloadService(deps: WrapperDownloadDeps): WrapperDownloadService {
  return {
    async open(engine, os, arch, version) {
      const opened = await deps.binaries.openBinary(engine, os, arch, version);
      return {
        stream: opened.stream,
        fileName: opened.fileName,
        size: opened.size,
        sha256: opened.sha256,
      };
    },
  };
}
