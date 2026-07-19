import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  } = {},
): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 'wrapper-installer-run-'));
  try {
    const fakeBin = join(dir, 'fake-bin');
    const installBin = join(dir, 'install-bin');
    const home = join(dir, 'home');
    mkdirSync(fakeBin);
    mkdirSync(home);

    const fakeWrapper = join(dir, 'fake-wrapper');
    writeExecutable(
      fakeWrapper,
      `#!/bin/sh
name=$(basename "$0")
case "$*" in
  "--minimal --cron install") exit 0 ;;
  "--minimal --cron run")
    if [ "$name" = "clx" ] && [ "\${FAIL_CLAUDE:-0}" = "1" ]; then
      echo "forced Claude failure" >&2
      exit 44
    fi
    if [ "$name" = "clx" ] && [ -n "\${CLX_CONFIG_PATH:-}" ] && [ ! -s "$CLX_CONFIG_PATH" ]; then
      echo "custom Claude config path was not populated" >&2
      exit 47
    fi
    if [ "$name" = "clx" ]; then
      cli=claude
      cli_path="$HOME/.local/share/codex-orchestrator/npm/bin/$cli"
      cli_cache="$HOME/.clx/state/claude-bin"
    else
      cli=codex
      cli_path="$HOME/.local/bin/$cli"
      cli_cache="$HOME/.config/codex-orchestrator/cdx-codex-bin"
    fi
    mkdir -p "$(dirname "$cli_path")" "$(dirname "$cli_cache")"
    cp "$FAKE_CLI" "$cli_path"
    chmod 755 "$cli_path"
    printf '%s\n' "$cli_path" > "$cli_cache"
    exit 0
    ;;
  *) echo "unexpected wrapper invocation: $name $*" >&2; exit 45 ;;
esac
`,
    );
    const wrapperSha = createHash('sha256').update(readFileSync(fakeWrapper)).digest('hex');

    const bundle = join(dir, 'bundle.json');
    writeFileSync(
      bundle,
      JSON.stringify({
        payload: {
          wrapper: {
            version: '0.6.50',
            binary_url: 'https://o.example/fake-wrapper',
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
  */fake-wrapper) cp "$FAKE_WRAPPER" "$out" ;;
  *) echo "unexpected curl URL: $url" >&2; exit 46 ;;
esac
`,
    );
    writeExecutable(join(fakeBin, 'node'), '#!/bin/sh\necho v22.0.0\n');
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
    return spawnSync('sh', [installer], {
      encoding: 'utf8',
      env: {
        ...process.env,
        BIN_DIR: installBin,
        HOME: home,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        TERM: 'dumb',
        NO_COLOR: '1',
        FAKE_BUNDLE: bundle,
        FAKE_WRAPPER: fakeWrapper,
        FAKE_CLI: fakeCli,
        CLX_CONFIG_PATH: join(home, 'custom', 'clx.json'),
        FAIL_CLAUDE: options.failClaude ? '1' : '0',
        EMPTY_CLAUDE_VERSION: options.emptyClaudeVersion ? '1' : '0',
        BROKEN_NPM: options.brokenNpm ? '1' : '0',
      },
    });
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
    });
    expect(out).toContain('legacy transition launcher');
    expect(out).toContain("BASE_URL='https://o.example'");
    expect(out).toContain('/wrapper/v2/config?engine=$ENGINE');
    expect(out).toContain("CONFIG_FILE='cdx.json'");
    expect(out).toContain('INSTALL_CONTEXT=transition');
    expect(out).toContain('exec "$TARGET_BIN" "$@"');
  });

  it('installer reports a conflicting resolved wrapper path without unconditional shell noise', () => {
    const out = buildWrapperV2InstallerScript({
      fqdn: 'h.example',
      apiKey: 'sk-codex-test',
      baseUrl: 'https://o.example/',
      engine: 'codex',
    });
    expect(out).toContain('command -v "$NAME"');
    expect(out).toContain('ui_warn "$NAME" "PATH" "$ORIGINAL_RESOLVED_BIN" "expected $TARGET_BIN"');
    expect(out).toContain('Refresh the parent shell: hash -r; or run directly: $TARGET_BIN run');
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
    expect(out).toContain('sudo install -m 755 "$src" "$dst"');
    expect(out).toContain('Cannot install $NAME into $BIN_ROOT');
    expect(out).not.toContain('BIN_DIR=${BIN_DIR:-$HOME/.local/bin}');
  });

  it('installer replaces a canonical path symlink before cleanup', () => {
    const out = buildWrapperV2InstallerScript({
      fqdn: 'h.example',
      apiKey: 'sk-codex-test',
      baseUrl: 'https://o.example/',
      engine: 'codex',
    });
    expect(out).toContain('if [ -L "$dst" ]; then');
    expect(out).toContain('sudo rm -f "$dst"');
    expect(out).toContain('if [ -x "$TARGET_BIN" ] && [ ! -L "$TARGET_BIN" ]; then');
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
    expect(out).toContain('"$HOME/.local/bin/$NAME" "/usr/local/sbin/$NAME"');
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

  it('uses one explicit minimal bootstrap per engine and gates the final result', () => {
    const out = buildWrapperV2InstallerScript({
      fqdn: 'h.example',
      apiKey: 'sk-codex-test',
      baseUrl: 'https://o.example/',
      engine: 'codex',
      peerEngines: ['claude'],
    });
    expect(out).toContain('CODEX_ORCH_PEER_SPAWN=1 "$BOOT_BIN" --minimal --cron install');
    expect(out).toContain('CODEX_ORCH_PEER_SPAWN=1 "$BOOT_BIN" --minimal --cron run');
    expect(out).toContain('ui_result_ok "READY"');
    expect(out).toContain('ui_result_fail "INCOMPLETE"');
    expect(out).toContain('INSTALL_FAILED=1');
    expect(out).toContain('Retry Codex cron: cdx --minimal --cron install');
    expect(out).toContain('Retry Codex CLI:  cdx --minimal --cron run');
    expect(out).toContain('PEER_CONFIG_PATH=$CLX_CONFIG_PATH');
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
    expect(output.match(/OK \| cdx \| wrapper/g)).toHaveLength(1);
    expect(output.match(/OK \| clx \| wrapper/g)).toHaveLength(1);
    expect(output.match(/OK \| cdx \| codex/g)).toHaveLength(1);
    expect(output.match(/OK \| clx \| claude/g)).toHaveLength(1);
    expect(output).toContain('WARN | setup | PATH');
    expect(output).toContain('Before running: export PATH=');
    expect(output).not.toContain('ATTENTION');
    expect(output).not.toMatch(/[\u0080-\uffff]/);
    expect(output).not.toContain('\x1b');
  });

  it('returns non-zero and prints INCOMPLETE when one peer engine fails', () => {
    const result = runDualInstallerFixture({ failClaude: true });
    const output = result.stdout + result.stderr;
    expect(result.status).toBe(1);
    expect(output).toContain('forced Claude failure');
    expect(output).toContain('INCOMPLETE | One or more requested components failed');
    expect(output).toContain('Before running: export PATH=');
    expect(output).not.toContain('READY |');
    expect(output).not.toContain('Done.');
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
