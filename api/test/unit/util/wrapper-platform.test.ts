import { describe, expect, it } from 'vitest';
import { resolveWrapperPlatform } from '../../../src/util/wrapper-platform.js';

describe('resolveWrapperPlatform', () => {
  it('prefers a well-formed header over a contradicting user agent', () => {
    expect(
      resolveWrapperPlatform({
        'x-wrapper-platform': 'darwin-arm64',
        'user-agent': 'cdx/0.6.55 (linux; amd64)',
      }),
    ).toEqual({ os: 'darwin', arch: 'arm64' });
    expect(
      resolveWrapperPlatform({
        'x-wrapper-platform': 'linux-amd64',
        'user-agent': 'clx/0.6.55 (darwin; aarch64)',
      }),
    ).toEqual({ os: 'linux', arch: 'amd64' });
  });

  it.each([
    ['empty', ''],
    ['uppercase', 'Darwin-ARM64'],
    ['one segment', 'darwin'],
    ['three segments', 'darwin-arm64-v8'],
    ['punctuation', 'darwin_arm64'],
    ['trailing space', 'darwin-arm64 '],
  ])('falls through to the user agent for a %s header value', (_label, xPlat) => {
    expect(
      resolveWrapperPlatform({ 'x-wrapper-platform': xPlat, 'user-agent': 'cdx (Darwin aarch64)' }),
    ).toEqual({ os: 'darwin', arch: 'arm64' });
    expect(resolveWrapperPlatform({ 'x-wrapper-platform': xPlat })).toEqual({
      os: 'linux',
      arch: 'amd64',
    });
  });

  it.each([
    ['darwin', 'cdx/1.0 darwin amd64', { os: 'darwin', arch: 'amd64' }],
    ['mac', 'Mozilla/5.0 (Macintosh; Intel Mac OS X)', { os: 'darwin', arch: 'amd64' }],
    ['DARWIN uppercase', 'CDX/1.0 DARWIN AMD64', { os: 'darwin', arch: 'amd64' }],
    ['arm64', 'cdx/1.0 linux arm64', { os: 'linux', arch: 'arm64' }],
    ['aarch64', 'cdx/1.0 linux aarch64', { os: 'linux', arch: 'arm64' }],
    ['AArch64 mixed case', 'cdx/1.0 Linux AArch64', { os: 'linux', arch: 'arm64' }],
    ['darwin + arm64', 'clx/1.0 darwin arm64', { os: 'darwin', arch: 'arm64' }],
  ])('sniffs %s out of the user agent', (_label, ua, expected) => {
    expect(resolveWrapperPlatform({ 'user-agent': ua })).toEqual(expected);
  });

  it('defaults to linux-amd64 when neither header is present', () => {
    expect(resolveWrapperPlatform({})).toEqual({ os: 'linux', arch: 'amd64' });
  });

  it('takes the first element of an array-valued header', () => {
    expect(
      resolveWrapperPlatform({ 'x-wrapper-platform': ['darwin-arm64', 'linux-amd64'] }),
    ).toEqual({ os: 'darwin', arch: 'arm64' });
    expect(
      resolveWrapperPlatform({
        'x-wrapper-platform': ['bogus', 'linux-amd64'],
        'user-agent': 'cdx darwin arm64',
      }),
    ).toEqual({ os: 'darwin', arch: 'arm64' });
    expect(resolveWrapperPlatform({ 'x-wrapper-platform': [] })).toEqual({
      os: 'linux',
      arch: 'amd64',
    });
  });
});
