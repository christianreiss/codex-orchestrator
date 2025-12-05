Ja, total. Dein Output ist gerade eher **Logbuch** (jede Kleinigkeit eine Zeile) statt **Dashboard** (wenige Zeilen, dafür aussagekräftig). Ich würde das so “hübsch + kurz” machen:

## Was du wegkürzen kannst (ohne dass Info verloren geht)

* **Alles, was „Current / synced / ok“ ist**, in **eine Sammelzeile** packen.
* **Nur Abweichungen schreien lassen**: Update verfügbar, Quota-Projektion >100%, Auth nicht valide, API down.
* **Zahlen-Kram bündeln**: Usage in eine Zeile, Quotas in eine Zeile.

## Beispiel: kompakt (4 Zeilen statt 12)

```text
Core: API ✅ | Auth ✅ (synced) | Prompts ✅ (4/4) | Runner ✅ (3m) | Policy: Deny ≥100%
Versions: codex 0.65.0 ✅ | wrapper 2025.12.05-01 ✅ | AGENTS ✅
Usage: calls 211 | tokens 20.84M (in 17.75M / out 1.67M / cache 261.28M) | reason 709,824
Quota: 5h 5% (reset 3h38m) | week 35% (reset 4d17h) | proj ~108% ⚠
```

## Wenn du den Output nicht direkt ändern willst: “Pretty-Filter” (stdin → kompakt)

Speicher das als `codex_pretty.py`:

```python
#!/usr/bin/env python3
import sys, re, argparse

VERSION_RE = re.compile(r'(\d+\.\d+\.\d+(?:[-+._A-Za-z0-9]+)?)')

def parse(stdin):
    d = {}
    for line in stdin:
        if "»" not in line:
            continue
        rest = line.split("»", 1)[1].strip()
        parts = [p.strip() for p in rest.split("|")]
        if not parts:
            continue
        key, vals = parts[0], parts[1:]
        d[key] = vals
    return d

def first_int(s):
    m = re.search(r'(\d+)', s)
    return int(m.group(1)) if m else None

def extract_versions(vals):
    text = " | ".join(vals)
    vs = VERSION_RE.findall(text)
    inst = vs[0] if len(vs) > 0 else None
    avail = vs[1] if len(vs) > 1 else None
    return inst, avail

def short_policy(s):
    s = s.replace("launches at", "").replace("usage", "").strip()
    s = re.sub(r'\s+', ' ', s)
    return s

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["compact", "warn", "full"], default="compact")
    args = ap.parse_args()

    d = parse(sys.stdin)

    if args.mode == "full":
        w = max((len(k) for k in d), default=0)
        for k, vals in d.items():
            print(f"{k:<{w}}  " + " | ".join(vals))
        return

    # Core line
    core = []
    if "api" in d: core.append("API ✅")
    if "auth" in d:
        auth = " ".join(d["auth"])
        core.append("Auth ✅ (synced)" if "synced" in auth else "Auth ✅")
    if "prompts" in d:
        p = " ".join(d["prompts"])
        l = re.search(r'local\s+(\d+)', p)
        r = re.search(r'remote\s+(\d+)', p)
        core.append(f"Prompts ✅ ({l.group(1)}/{r.group(1)})" if l and r else "Prompts ✅")
    if "runner" in d:
        runner = " ".join(d["runner"])
        core.append(f"Runner ✅ ({runner})" if runner else "Runner ✅")
    if "Policy" in d:
        core.append("Policy: " + short_policy(" ".join(d["Policy"])))

    # Versions line (only show update arrow if mismatch)
    versions = []
    for k in ("codex", "wrapper"):
        if k in d:
            inst, avail = extract_versions(d[k])
            if inst and avail and inst != avail:
                versions.append(f"{k} {inst}→{avail} ⬆️")
            elif inst:
                versions.append(f"{k} {inst} ✅")
            else:
                versions.append(f"{k} ✅")
    if "AGENTS.md" in d:
        versions.append("AGENTS ✅")

    # Usage line
    usage = None
    if "host usage" in d:
        usage = "Usage: " + " | ".join(d["host usage"])

    # Quota line + warn flag
    quota_bits = []
    warn = False
    for k in ("5h quota", "week quota"):
        if k in d:
            txt = " | ".join(d[k])
            quota_bits.append(f"{k.replace(' quota','')}: {txt}")
            m = re.search(r'proj\s*~?\s*(\d+)%', txt, re.I)
            if m and int(m.group(1)) >= 100:
                warn = True
    quota = ("Quota: " + " | ".join(quota_bits) + (" ⚠" if warn else "")) if quota_bits else None

    any_update = any("⬆️" in v for v in versions)
    if args.mode == "warn":
        if warn or any_update:
            if core: print("Core: " + " | ".join(core))
            if versions: print("Versions: " + " | ".join(versions))
            if quota: print(quota)
        return

    if core: print("Core: " + " | ".join(core))
    if versions: print("Versions: " + " | ".join(versions))
    if usage: print(usage)
    if quota: print(quota)

if __name__ == "__main__":
    main()
```

Nutzung:

```bash
your_command_producing_that_output | ./codex_pretty.py --mode compact
your_command_producing_that_output | ./codex_pretty.py --mode warn
```

Wenn du mir sagst, **wo** der Output herkommt (welches Script/Command), kann ich dir auch eine “native” Version skizzieren mit `--compact/--verbose/--json` direkt im Tool, statt nachträglich zu filtern.

