import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// A switched-off engine is not part of the fleet: every operational surface
// lists engines from `useFleetEngines()` (`$fleet.enabled`, `$fleet.isEnabled`),
// which follows the server's `GET /admin/engines/active`. This guard fails when
// a view enumerates the fixed four-engine universe instead, which is how
// disabled engines kept reappearing after each surface had been fixed once.
describe("engine list guard", () => {
  const srcDir = fileURLToPath(new URL("../..", import.meta.url));

  /** Files allowed to name the whole universe, each with its reason. */
  const ALLOWLIST: Record<string, string> = {
    "lib/constants/engines.ts": "defines the universe",
    "lib/engines/fleet-state.ts": "the store's display order",
    "lib/api/rtk.ts": "validates the full policy response; the view filters rows",
    "lib/components/chatty/actions.ts": "validates action payloads, not a list shown to the operator",
    "lib/components/accounts/account-state.ts": "sort order only",
    "lib/components/hosts/HostRegisterForm.svelte": "zod enum validating the submitted value; the cards are filtered",
    "lib/components/setup/SeedAuthPanel.svelte": "default universe intersected with switched-on engines",
    "lib/components/settings/EngineMasterSwitches.svelte": "the switches that turn engines on again",
    "routes/(providers)/engines/+page.svelte": "the Engines management page, where switched-off engines are re-enabled or destroyed",
  };

  const RULES: { name: string; pattern: RegExp }[] = [
    { name: "imports ENGINES", pattern: /import\s*\{[^}]*\bENGINES\b[^}]*\}\s*from\s*["']\$lib\/constants\/engines["']/ },
    {
      name: "literal four-engine list",
      pattern: /\[\s*["']codex["']\s*,\s*["']claude["']\s*,\s*["']grok["']\s*,\s*["']kimi["']\s*\]/,
    },
    { name: "hard-coded engine option", pattern: /value=["'](codex|claude|grok|kimi)["']/ },
  ];

  function walk(dir: string, out: string[]): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, out);
      else if (/\.(svelte|ts)$/.test(entry.name) && !entry.name.endsWith(".test.ts")) out.push(path);
    }
  }

  const files: string[] = [];
  walk(join(srcDir, "lib"), files);
  walk(join(srcDir, "routes"), files);

  it("finds the sources it guards", () => {
    assert.ok(files.length > 100, `only ${files.length} files scanned`);
    for (const allowed of Object.keys(ALLOWLIST)) {
      assert.ok(files.some((file) => relative(srcDir, file) === allowed), `allowlisted ${allowed} no longer exists`);
    }
  });

  it("lists engines only from the fleet store outside the allowlist", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(srcDir, file);
      if (rel in ALLOWLIST) continue;
      const text = readFileSync(file, "utf8");
      for (const rule of RULES) {
        if (rule.pattern.test(text)) offenders.push(`${rel}: ${rule.name}`);
      }
    }
    assert.deepEqual(offenders, [], "list engines with useFleetEngines() ($fleet.enabled) instead");
  });
});
