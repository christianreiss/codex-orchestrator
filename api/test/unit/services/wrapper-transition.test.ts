import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildLegacyWrapperTransitionScript,
  buildWrapperV2InstallerScript,
  isLegacyShellWrapperVersion,
  withLegacyShellWrapperTransition,
} from '../../../src/services/wrapper-transition.js';
import type { VersionSnapshot } from '../../../src/services/version-snapshot.js';

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, body, 'utf8');
  chmodSync(path, 0o755);
}

function runDualInstallerFixture(
  options: {
    failClaude?: boolean;
    emptyClaudeVersion?: boolean;
    brokenNpm?: boolean;
    mismatchedClaudeMetadata?: boolean;
    legacyRegularBinaries?: boolean;
    failBinarySwap?: boolean;
    splitArtifact?: boolean;
  } = {},
): {
  status: number | null;
  stdout: string;
  stderr: string;
  binaryDownloads: number;
  cxxExists: boolean;
  cdxLink: string | null;
  clxLink: string | null;
  cxxBody: string | null;
  installTemps: string[];
  wrapperInvocations: string[];
} {
  const dir = mkdtempSync(join(tmpdir(), 'wrapper-installer-run-'));
  try {
    const fakeBin = join(dir, 'fake-bin');
    const installBin = join(dir, 'install-bin');
    const home = join(dir, 'home');
    mkdirSync(fakeBin);
    mkdirSync(installBin);
    mkdirSync(home);
    if (options.legacyRegularBinaries) {
      writeExecutable(join(installBin, 'cdx'), '#!/bin/sh\necho legacy-cdx\n');
      writeExecutable(join(installBin, 'clx'), '#!/bin/sh\necho legacy-clx\n');
    }
    if (options.failBinarySwap) {
      writeExecutable(join(installBin, 'cxx'), '#!/bin/sh\necho preserved-old-cxx\n');
    }

    const fakeWrapper = join(dir, 'fake-wrapper');
    writeExecutable(
      fakeWrapper,
      `#!/bin/sh
printf '%s\n' "$*" >> "$WRAPPER_LOG"
case "$*" in
  "cron install --minimal") exit 0 ;;
  "cron run --minimal")
    if [ -n "\${CLX_CONFIG_PATH:-}" ] && [ ! -s "$CLX_CONFIG_PATH" ]; then
      echo "custom Claude config path was not populated" >&2
      exit 47
    fi
    codex_path="$HOME/.local/bin/codex"
    codex_cache="$HOME/.config/codex-orchestrator/cdx-codex-bin"
    claude_path="$HOME/.local/share/codex-orchestrator/npm/bin/claude"
    claude_cache="$HOME/.clx/state/claude-bin"
    mkdir -p "$(dirname "$codex_path")" "$(dirname "$codex_cache")" \
      "$(dirname "$claude_path")" "$(dirname "$claude_cache")"
    cp "$FAKE_CLI" "$codex_path"
    cp "$FAKE_CLI" "$claude_path"
    chmod 755 "$codex_path" "$claude_path"
    printf '%s\n' "$codex_path" > "$codex_cache"
    printf '%s\n' "$claude_path" > "$claude_cache"
    if [ "\${FAIL_CLAUDE:-0}" = "1" ]; then
      echo "forced Claude failure" >&2
      exit 44
    fi
    exit 0
    ;;
  *) echo "unexpected wrapper invocation: $name $*" >&2; exit 45 ;;
esac
`,
    );
    const wrapperLog = join(dir, 'wrapper.log');
    const wrapperSha = createHash('sha256').update(readFileSync(fakeWrapper)).digest('hex');
    const binaryUrl = options.splitArtifact
      ? 'https://o.example/wrapper/v2/bin/codex/linux-amd64/v0.6.50/cdx'
      : 'https://o.example/wrapper/v2/bin/cxx/linux-amd64/v0.6.50/cxx';

    const bundle = join(dir, 'bundle.json');
    const claudeBundle = join(dir, 'claude-bundle.json');
    writeFileSync(
      bundle,
      JSON.stringify({
        payload: {
          wrapper: {
            version: '0.6.50',
            binary_url: binaryUrl,
            binary_sha256: wrapperSha,
          },
        },
        signature: { value: 'fixture-signature' },
      }),
      'utf8',
    );
    writeFileSync(
      claudeBundle,
      JSON.stringify({
        payload: {
          wrapper: {
            version: options.mismatchedClaudeMetadata ? '0.6.49' : '0.6.50',
            binary_url: binaryUrl,
            binary_sha256: wrapperSha,
          },
        },
        signature: { value: 'fixture-signature-claude' },
      }),
      'utf8',
    );

    const curlLog = join(dir, 'curl.log');

    writeExecutable(
      join(fakeBin, 'curl'),
      `#!/bin/sh
out=
url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift 2 ;;
    http://*|https://*) url=$1; shift ;;
    *) shift ;;
  esac
done
case "$url" in
  */wrapper/v2/config*engine=codex*) cp "$FAKE_BUNDLE" "$out" ;;
  */wrapper/v2/config*engine=claude*) cp "$FAKE_CLAUDE_BUNDLE" "$out" ;;
  */wrapper/v2/bin/cxx/*/cxx) cp "$FAKE_WRAPPER" "$out" ;;
  *) echo "unexpected curl URL: $url" >&2; exit 46 ;;
esac
printf '%s\n' "$url" >> "$CURL_LOG"
`,
    );
    writeExecutable(join(fakeBin, 'node'), '#!/bin/sh\necho v22.0.0\n');
    writeExecutable(
      join(fakeBin, 'mv'),
      '#!/bin/sh\nlast=\nfor arg do last=$arg; done\nif [ "${FAIL_CXX_SWAP:-0}" = "1" ] && [ "$last" = "$BIN_DIR/cxx" ]; then exit 48; fi\nexec "$REAL_MV" "$@"\n',
    );
    writeExecutable(
      join(fakeBin, 'npm'),
      '#!/bin/sh\nif [ "${BROKEN_NPM:-0}" = "1" ]; then exit 42; fi\necho 10.9.2\n',
    );
    const fakeCli = join(dir, 'fake-cli');
    writeExecutable(
      fakeCli,
      '#!/bin/sh\ncase "$(basename "$0")" in codex) echo "codex-cli 0.144.6" ;; claude) if [ "${EMPTY_CLAUDE_VERSION:-0}" = "1" ]; then exit 0; fi; echo "2.1.215 (Claude Code)" ;; esac\n',
    );

    const installer = join(dir, 'installer.sh');
    writeFileSync(
      installer,
      buildWrapperV2InstallerScript({
        fqdn: 'fixture.example',
        apiKey: 'sk-fixture',
        baseUrl: 'https://o.example',
        engine: 'codex',
        peerEngines: ['claude'],
      }),
      'utf8',
    );
    const result = spawnSync('sh', [installer], {
      encoding: 'utf8',
      env: {
        ...process.env,
        BIN_DIR: installBin,
        HOME: home,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        TERM: 'dumb',
        NO_COLOR: '1',
        FAKE_BUNDLE: bundle,
        FAKE_CLAUDE_BUNDLE: claudeBundle,
        FAKE_WRAPPER: fakeWrapper,
        FAKE_CLI: fakeCli,
        WRAPPER_LOG: wrapperLog,
        CURL_LOG: curlLog,
        CLX_CONFIG_PATH: join(home, 'custom', 'clx.json'),
        FAIL_CLAUDE: options.failClaude ? '1' : '0',
        EMPTY_CLAUDE_VERSION: options.emptyClaudeVersion ? '1' : '0',
        BROKEN_NPM: options.brokenNpm ? '1' : '0',
        FAIL_CXX_SWAP: options.failBinarySwap ? '1' : '0',
        REAL_MV: execFileSync('sh', ['-c', 'command -v mv'], { encoding: 'utf8' }).trim(),
      },
    });
    const curlUrls = existsSync(curlLog)
      ? readFileSync(curlLog, 'utf8').split('\n').filter(Boolean)
      : [];
    const linkTarget = (name: string): string | null => {
      try {
        return readlinkSync(join(installBin, name));
      } catch {
        return null;
      }
    };
    return {
      ...result,
      binaryDownloads: curlUrls.filter((url) => url.includes('/wrapper/v2/bin/cxx/')).length,
      cxxExists: existsSync(join(installBin, 'cxx')),
      cdxLink: linkTarget('cdx'),
      clxLink: linkTarget('clx'),
      cxxBody: existsSync(join(installBin, 'cxx'))
        ? readFileSync(join(installBin, 'cxx'), 'utf8')
        : null,
      installTemps: readdirSync(installBin).filter((entry) => entry.includes('.cxx-install.')),
      wrapperInvocations: existsSync(wrapperLog)
        ? readFileSync(wrapperLog, 'utf8').split('\n').filter(Boolean)
        : [],
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runLegacyTransitionFixture(engine: 'codex' | 'claude'): {
  status: number | null;
  stdout: string;
  stderr: string;
  aliasTarget: string | null;
  cxxExists: boolean;
} {
  const dir = mkdtempSync(join(tmpdir(), 'wrapper-transition-run-'));
  try {
    const fakeBin = join(dir, 'fake-bin');
    const home = join(dir, 'home');
    const dataHome = join(dir, 'data');
    mkdirSync(fakeBin);
    mkdirSync(home);
    mkdirSync(dataHome);
    const fakeWrapper = join(dir, 'fake-wrapper');
    writeExecutable(fakeWrapper, '#!/bin/sh\nprintf "%s|%s\\n" "$(basename "$0")" "$*"\n');
    const wrapperSha = createHash('sha256').update(readFileSync(fakeWrapper)).digest('hex');
    const bundle = join(dir, 'bundle.json');
    writeFileSync(
      bundle,
      JSON.stringify({
        payload: {
          wrapper: {
            version: '0.6.50',
            binary_url: 'https://o.example/wrapper/v2/bin/cxx/linux-amd64/v0.6.50/cxx',
            binary_sha256: wrapperSha,
          },
        },
        signature: { value: 'fixture-signature' },
      }),
      'utf8',
    );
    writeExecutable(
      join(fakeBin, 'curl'),
      `#!/bin/sh
out=
url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift 2 ;;
    http://*|https://*) url=$1; shift ;;
    *) shift ;;
  esac
done
case "$url" in
  */wrapper/v2/config*) cp "$FAKE_BUNDLE" "$out" ;;
  */wrapper/v2/bin/cxx/*/cxx) cp "$FAKE_WRAPPER" "$out" ;;
  *) exit 46 ;;
esac
`,
    );
    // A legacy wrapper installs this launcher over its own resolved cdx/clx
    // path before re-execing it. Keep that exact basename/path in the fixture
    // so the test proves the regular shell is replaced by the managed alias.
    const launcher = join(dir, engine === 'claude' ? 'clx' : 'cdx');
    writeFileSync(
      launcher,
      buildLegacyWrapperTransitionScript({
        fqdn: 'fixture.example',
        apiKey: 'sk-fixture',
        baseUrl: 'https://o.example',
        engine,
      }),
      'utf8',
    );
    const result = spawnSync('sh', [launcher, '--status'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        XDG_DATA_HOME: dataHome,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        TERM: 'dumb',
        NO_COLOR: '1',
        FAKE_BUNDLE: bundle,
        FAKE_WRAPPER: fakeWrapper,
      },
    });
    const binRoot = dir;
    let aliasTarget: string | null = null;
    try {
      aliasTarget = readlinkSync(join(binRoot, engine === 'claude' ? 'clx' : 'cdx'));
    } catch {
      // Assertion below reports a missing/non-link alias clearly.
    }
    return {
      ...result,
      aliasTarget,
      cxxExists: existsSync(join(binRoot, 'cxx')),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function snapshot(): VersionSnapshot {
  return {
    client_version: '0.130.0',
    client_version_override: null,
    client_version_enforce_exact: false,
    wrapper_version: '0.6.0',
    wrapper_sha256: 'a'.repeat(64),
    wrapper_url: 'https://o.example/wrapper/v2/bin/codex/linux-amd64/v0.6.0/cdx',
    runner_state: 'ok',
    api_disabled: false,
    auto_update_enabled: true,
    cdx_silent: false,
    clx_silent: false,
    agent_messaging_enabled: false,
    installation_id: 'inst',
    engine: 'codex',
  };
}

describe('wrapper transition helpers', () => {
  it('detects date-style shell wrapper versions only', () => {
    expect(isLegacyShellWrapperVersion('2026.05.11-01')).toBe(true);
    expect(isLegacyShellWrapperVersion('2026.05.11-01+local')).toBe(true);
    expect(isLegacyShellWrapperVersion('0.6.0')).toBe(false);
    expect(isLegacyShellWrapperVersion(null)).toBe(false);
  });

  it('points legacy wrappers at the transition launcher without a static checksum', () => {
    const out = withLegacyShellWrapperTransition(snapshot(), '2026.05.11-01', 'codex');
    expect(out.wrapper_url).toBe('/wrapper/download?engine=codex');
    expect(out.wrapper_sha256).toBeNull();
  });

  it('leaves Go wrapper summaries on the static binary URL', () => {
    const base = snapshot();
    const out = withLegacyShellWrapperTransition(base, '0.6.0', 'codex');
    expect(out).toBe(base);
  });

  it('builds a transition launcher that fetches signed config before exec', () => {
    const out = buildLegacyWrapperTransitionScript({
      fqdn: 'h.example',
      apiKey: 'sk-codex-test',
      baseUrl: 'https://o.example/',
      engine: 'codex',
      allowInsecure: true,
      peerEngines: ['claude'],
    });
    expect(out).toContain('legacy transition launcher');
    expect(out).toContain("BASE_URL='https://o.example'");
    expect(out).toContain('/wrapper/v2/config?engine=codex');
    expect(out).toContain('/wrapper/v2/config?engine=claude');
    expect(out).toContain('CODEX_CONFIG_PATH=${CDX_CONFIG_PATH:-');
    expect(out).toContain('CODEX_INSTALL_CURL_INSECURE=${CODEX_INSTALL_CURL_INSECURE:-1}');
    expect(out).toContain('INSTALL_CONTEXT=transition');
    expect(out).toContain('TRANSITION_DIR=$(dirname "$TRANSITION_SELF")');
    expect(out).toContain("BIN_ROOT=$(CDPATH='' cd -P -- \"$TRANSITION_DIR\"");
    expect(out).toContain('exec "$TARGET_BIN" "$ENGINE" "$@"');
  });

  it.each(['codex', 'claude'] as const)(
    'date-version transition installs cxx and retains the explicit %s persona',
    (engine) => {
      const result = runLegacyTransitionFixture(engine);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`cxx|${engine} --status`);
      expect(result.cxxExists).toBe(true);
      expect(result.aliasTarget).toBe('cxx');
    },
  );

  it('installer reports a conflicting resolved wrapper path without unconditional shell noise', () => {
    const out = buildWrapperV2InstallerScript({
      fqdn: 'h.example',
      apiKey: 'sk-codex-test',
      baseUrl: 'https://o.example/',
      engine: 'codex',
    });
    expect(out).toContain('command -v cdx');
    expect(out).toContain('ui_warn "cdx" "PATH" "$ORIGINAL_CODEX_BIN" "expected $BIN_ROOT/cdx"');
    expect(out).toContain('Refresh the parent shell: hash -r; or run directly: $BIN_ROOT/cdx run');
    expect(out).not.toContain('If your shell cached an older $NAME');
  });

  it('installer defaults to system-wide /usr/local/bin with sudo support', () => {
    const out = buildWrapperV2InstallerScript({
      fqdn: 'h.example',
      apiKey: 'sk-codex-test',
      baseUrl: 'https://o.example/',
      engine: 'codex',
    });
    expect(out).toContain('BIN_DIR=${BIN_DIR:-/usr/local/bin}');
    expect(out).toContain('PARENT_PATH=${PATH:-}');
    expect(out).toContain('PATH="$BIN_ROOT:${PATH:-}"');
    expect(out).toContain('sudo mkdir -p "$BIN_ROOT"');
    expect(out).toContain('sudo install -m 755 "$src" "$INSTALL_BIN_TMP"');
    expect(out).toContain('sudo mv -f "$INSTALL_BIN_TMP" "$dst"');
    expect(out).toContain('Cannot install $NAME into $BIN_ROOT');
    expect(out).not.toContain('BIN_DIR=${BIN_DIR:-$HOME/.local/bin}');
  });

  it('installer atomically replaces a canonical path symlink without a removal gap', () => {
    const out = buildWrapperV2InstallerScript({
      fqdn: 'h.example',
      apiKey: 'sk-codex-test',
      baseUrl: 'https://o.example/',
      engine: 'codex',
    });
    expect(out).toContain('INSTALL_BIN_TMP="$dst.cxx-install.$$"');
    expect(out).toContain('if [ -x "$TARGET_BIN" ] && [ ! -L "$TARGET_BIN" ]; then');
    expect(out).not.toContain('sudo rm -f "$dst"');
    expect(out).toContain('ln -s cxx "$ALIAS_TMP"');
    expect(out).toContain('mv -f "$ALIAS_TMP" "$ALIAS_PATH"');
    expect(out).not.toContain('rm -f "$ALIAS_PATH"\n    mv -f "$ALIAS_TMP"');
  });

  it('installer skips relic cleanup when standard paths resolve to the same file', () => {
    const out = buildWrapperV2InstallerScript({
      fqdn: 'h.example',
      apiKey: 'sk-codex-test',
      baseUrl: 'https://o.example/',
      engine: 'codex',
    });
    expect(out).toContain('same_path()');
    expect(out).toContain('os.path.samefile(sys.argv[1], sys.argv[2])');
    expect(out).toContain('same_path "$relic" "$TARGET_BIN"');
  });

  it('installer removes known per-user and global stale wrapper relics', () => {
    const out = buildWrapperV2InstallerScript({
      fqdn: 'h.example',
      apiKey: 'sk-codex-test',
      baseUrl: 'https://o.example/',
      engine: 'codex',
    });
    expect(out).toContain('cleanup_known_relics()');
    expect(out).toContain('"$HOME/.local/bin/cdx" "/usr/local/sbin/cdx"');
    expect(out).toContain('Removed $label wrapper relic $relic');
    expect(out).toContain('sudo rm -f "$relic"');
    expect(out).toContain('remove it with: sudo rm -f $relic');
  });

  it('emits POSIX shell syntax that sh can parse', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wrapper-transition-'));
    try {
      const file = join(dir, 'cdx');
      writeFileSync(
        file,
        buildLegacyWrapperTransitionScript({
          fqdn: 'h.example',
          apiKey: 'sk-codex-test',
          baseUrl: 'https://o.example/',
          engine: 'codex',
        }),
        'utf8',
      );
      execFileSync('sh', ['-n', file]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('emits valid POSIX shell for Codex-only, Claude-only, and dual installers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wrapper-installers-'));
    try {
      const cases = [
        { engine: 'codex' as const, peerEngines: [] },
        { engine: 'claude' as const, peerEngines: [] },
        { engine: 'codex' as const, peerEngines: ['claude' as const] },
      ];
      for (const [index, options] of cases.entries()) {
        const file = join(dir, `installer-${index}.sh`);
        writeFileSync(
          file,
          buildWrapperV2InstallerScript({
            fqdn: 'h.example',
            apiKey: 'sk-codex-test',
            baseUrl: 'https://o.example/',
            ...options,
          }),
          'utf8',
        );
        execFileSync('sh', ['-n', file]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preflights Claude for both primary and peer installs without distro npm by default', () => {
    const claude = buildWrapperV2InstallerScript({
      fqdn: 'h.example',
      apiKey: 'sk-claude-test',
      baseUrl: 'https://o.example/',
      engine: 'claude',
    });
    const both = buildWrapperV2InstallerScript({
      fqdn: 'h.example',
      apiKey: 'sk-codex-test',
      baseUrl: 'https://o.example/',
      engine: 'codex',
      peerEngines: ['claude'],
    });
    for (const out of [claude, both]) {
      expect(out).toContain('NEEDS_CLAUDE=1');
      expect(out).toContain('ensure_claude_prerequisites');
      expect(out).toContain('npm@10.9.2');
      expect(out).toContain('install_corepack_npm');
      expect(out).toContain('install_os_component npm');
    }
    expect(
      buildWrapperV2InstallerScript({
        fqdn: 'h.example',
        apiKey: 'sk-codex-test',
        baseUrl: 'https://o.example/',
        engine: 'codex',
      }),
    ).toContain('NEEDS_CLAUDE=0');
  });

  it('uses one host-wide minimal bootstrap and gates the final result', () => {
    const out = buildWrapperV2InstallerScript({
      fqdn: 'h.example',
      apiKey: 'sk-codex-test',
      baseUrl: 'https://o.example/',
      engine: 'codex',
      peerEngines: ['claude'],
    });
    expect(out).toContain('"$TARGET_BIN" cron install --minimal');
    expect(out).toContain('"$TARGET_BIN" cron run --minimal');
    expect(out).not.toContain('CODEX_ORCH_PEER_SPAWN=1');
    expect(out).toContain('ui_result_ok "READY"');
    expect(out).toContain('ui_result_fail "INCOMPLETE"');
    expect(out).toContain('INSTALL_FAILED=1');
    expect(out).toContain('Retry host cron:    $BIN_ROOT/cxx cron install');
    expect(out).toContain('Retry engine CLIs:  $BIN_ROOT/cxx cron run --minimal');
    expect(out).toContain('CLAUDE_CONFIG_PATH=${CLX_CONFIG_PATH:-');
    expect(out).toContain('enabled wrapper configs disagree on cxx version/SHA');
    expect(out).not.toContain('pacman -Sy');
    expect(out).not.toContain('"$TARGET_BIN" status');
    expect(out).not.toContain('Done. Try:');
    expect(out).not.toContain('Re-run the installer');
  });

  it('runs a dual installer once per component and prints READY only after full success', () => {
    const result = runDualInstallerFixture();
    const output = result.stdout + result.stderr;
    expect(result.status).toBe(0);
    expect(output).toContain('READY | Codex + Claude installed successfully');
    expect(output.match(/OK \| cxx \| wrapper/g)).toHaveLength(1);
    expect(output.match(/OK \| cdx \| codex/g)).toHaveLength(1);
    expect(output.match(/OK \| clx \| claude/g)).toHaveLength(1);
    expect(result.binaryDownloads).toBe(1);
    expect(result.cxxExists).toBe(true);
    expect(result.cdxLink).toBe('cxx');
    expect(result.clxLink).toBe('cxx');
    expect(result.wrapperInvocations).toEqual([
      'cron install --minimal',
      'cron run --minimal',
      'agent service install',
    ]);
    expect(output).toContain('WARN | setup | PATH');
    expect(output).toContain('Before running: export PATH=');
    expect(output).not.toContain('ATTENTION');
    expect(output).not.toMatch(/[\u0080-\uffff]/);
    expect(output).not.toContain('\x1b');
  });

  it('returns non-zero and prints INCOMPLETE when one peer engine fails', () => {
    const result = runDualInstallerFixture({ failClaude: true });
    const output = result.stdout + result.stderr;
    expect(result.status).not.toBe(0);
    expect(output).toContain('forced Claude failure');
    expect(output).toContain('INCOMPLETE | One or more requested components failed');
    expect(output).toContain('Before running: export PATH=');
    expect(output).not.toContain('READY |');
    expect(output).not.toContain('Done.');
  });

  it('fails before installing cxx when enabled config version/SHA metadata diverges', () => {
    const result = runDualInstallerFixture({ mismatchedClaudeMetadata: true });
    const output = result.stdout + result.stderr;
    expect(result.status).toBe(1);
    expect(output).toContain('enabled wrapper configs disagree on cxx version/SHA');
    expect(result.binaryDownloads).toBe(0);
    expect(result.cxxExists).toBe(false);
    expect(result.cdxLink).toBeNull();
    expect(result.clxLink).toBeNull();
    expect(output).not.toContain('READY |');
  });

  it('rejects split artifacts before download or alias mutation', () => {
    const result = runDualInstallerFixture({ splitArtifact: true });
    const output = result.stdout + result.stderr;
    expect(result.status).toBe(1);
    expect(output).toContain('does not identify a canonical cxx artifact');
    expect(result.binaryDownloads).toBe(0);
    expect(result.cxxExists).toBe(false);
    expect(result.cdxLink).toBeNull();
    expect(result.clxLink).toBeNull();
  });

  it('migrates legacy regular wrapper binaries to enabled relative aliases', () => {
    const result = runDualInstallerFixture({ legacyRegularBinaries: true });
    expect(result.status).toBe(0);
    expect(result.cxxExists).toBe(true);
    expect(result.cdxLink).toBe('cxx');
    expect(result.clxLink).toBe('cxx');
  });

  it('keeps the previous cxx intact when the staged binary swap fails', () => {
    const result = runDualInstallerFixture({ failBinarySwap: true });
    expect(result.status).not.toBe(0);
    expect(result.cxxBody).toContain('preserved-old-cxx');
    expect(result.installTemps).toEqual([]);
    expect(result.cdxLink).toBeNull();
    expect(result.clxLink).toBeNull();
  });

  it('rejects broken npm and explains that a fresh installer is required', () => {
    const result = runDualInstallerFixture({ brokenNpm: true });
    const output = result.stdout + result.stderr;
    expect(result.status).toBe(1);
    expect(output).toContain('Node.js/npm version check failed');
    expect(output).toContain('This single-use installer was consumed');
    expect(output).not.toContain('READY |');
  });

  it('does not mark a CLI ready when its version probe is empty', () => {
    const result = runDualInstallerFixture({ emptyClaudeVersion: true });
    const output = result.stdout + result.stderr;
    expect(result.status).toBe(1);
    expect(output).toContain('FAIL | clx | claude | version check failed');
    expect(output).toContain('INCOMPLETE | One or more requested components failed');
    expect(output).not.toContain('READY |');
  });
});
