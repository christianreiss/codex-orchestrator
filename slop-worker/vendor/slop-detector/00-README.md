# Design-Richtlinien für KI-gestütztes Programmieren

Stand: 06.11.2026. Grundlage sind vier Deep-Research-Läufe (90 Quellen, 100 adversarial geprüfte Aussagen) und der aktuelle `frontend-design`-Skill von Anthropic.

Die Sammlung hat zwei Ziele:
1. Gute Web-UI und -UX für Admin, Ops, Endnutzer und Marketing, wenn Code mit Claude Code, Cursor, v0, Lovable, Bolt und ähnlichen Tools entsteht.
2. AI Slop vermeiden, also Oberflächen, deren Gestaltung niemand gewählt hat.

## Inhalt

| Datei | Wofür |
|---|---|
| [01-grundlagen-ui-ux.md](01-grundlagen-ui-ux.md) | Tokens, Typografie, Farbe, WCAG 2.2, Zustände, Formulare, Navigation, Performance, Dark Patterns. Danach je Anwendungsfall: Admin, Ops, Endnutzer, Marketing |
| [02-ai-slop-erkennen-und-vermeiden.md](02-ai-slop-erkennen-und-vermeiden.md) | Ursache, Merkmale erster und zweiter Ordnung, warum Verbote allein nicht reichen, Gegenmaßnahmen in sechs Ebenen, wann Generik in Ordnung ist |
| [03-community-howtos-und-ideen.md](03-community-howtos-und-ideen.md) | Workflows, Regelbausteine, kreative Ansätze und Debatten aus Reddit, HN, Blogs und GitHub |
| [04-checklisten.md](04-checklisten.md) | Zum Abhaken: Richtung, Setup, P0/P1/P2, Review je Anwendungsfall, Viewports, Abnahme-Prompt für den Agenten |
| [05-quellen-und-evidenz.md](05-quellen-und-evidenz.md) | Alle Quellen, Methode, widerlegte Aussagen, offene Fragen |
| [06-design-systeme.md](06-design-systeme.md) | Regeln mit Zahlen aus Material 3, Apple HIG, Fluent 2, Carbon, Cloudscape, GOV.UK, USWDS sowie GNOME- und KDE-HIG: Zielgrößen, Kontrast, Raster, Zustände, Bewegung, Dichte, Leerzustände, Formulare, native Apps. Wo die Systeme sich widersprechen, und wie man sie übernimmt, ohne Slop zu erzeugen |
| [templates/](templates/) | Vorlagen zum Übernehmen (siehe unten) |

## Agent-first Slop Detector

Die ausführbare CLI mit automatischem Agenten-Feedback, Browser-Belegen und prüfbaren Korrekturvorschlägen ist in [README.md](README.md) beschrieben. Die bisherigen Vorlagen bleiben unabhängig nutzbar.

## Schnellstart für ein Projekt

1. `templates/DESIGN.md` ins Projekt kopieren und ausfüllen. Checkliste 1 in [04](04-checklisten.md#1-vor-dem-ersten-prompt-richtung) hilft dabei.
2. `templates/CLAUDE-design-section.md` in `CLAUDE.md` einfügen. Für Cursor stattdessen `templates/cursor-design-rule.mdc` nach `.cursor/rules/`.
3. Tokens im Theme-Layer setzen (z. B. shadcn `globals.css`). `templates/stylelint-tokens.json` erzwingt sie.
4. `templates/slop-grep.sh` nach `scripts/` und `templates/hooks/design-check.sh` nach `.claude/hooks/` kopieren, ausführbar machen, und den Hook aus `templates/claude-settings-hook.json` in `.claude/settings.json` eintragen. Damit sieht Claude Funde noch im selben Turn.
5. `templates/a11y-and-states.spec.ts` anpassen (URL, API, Texte) und `templates/ci-design-gate.yml` als GitHub Action ablegen.
6. Am Ende jeder UI-Aufgabe den Abnahme-Prompt aus [04, Abschnitt 8](04-checklisten.md#8-abnahme-prompt-für-den-agenten) verwenden.

| Vorlage | Zweck | Getestet |
|---|---|---|
| `DESIGN.md` | Einzige Quelle für Designentscheidungen | – |
| `CLAUDE-design-section.md` | Regeln für Claude Code | – |
| `cursor-design-rule.mdc` | Regeln für Cursor | – |
| `slop-grep.sh` | Regex-Detektor ohne Abhängigkeiten, Exit 2 bei Funden, Ausnahme per `slop-ok` | ja, an Beispieldatei |
| `hooks/design-check.sh` + `claude-settings-hook.json` | PostToolUse-Hook für Claude Code (braucht `jq`) | ja, mit simuliertem Hook-Input |
| `stylelint-tokens.json` | Token-Disziplin in CSS | nein |
| `a11y-and-states.spec.ts` | Playwright + axe pro Zustand, Overflow, Zielgrößen, Fokus, visuelle Regression | nein, nicht kompiliert |
| `ci-design-gate.yml` | GitHub Action | nein |

## Legende

| Marke | Bedeutung |
|---|---|
| **[V]** | Verifiziert: in der Recherche von drei Prüfern bestätigt (3-0) oder direkt am Primärtext geprüft |
| **[T]** | Teilbestätigt: 2-1, oder bestätigt mit wesentlicher Einschränkung |
| **[A]** | Anekdotisch: Einzelbericht, Forum oder Blog. Korrekt zitiert, aber nicht gegengeprüft |
| **[F]** | Fachwissen: etabliert, aber in dieser Recherche nicht eigens verifiziert |
| **[X]** | Widerlegt (siehe [05](05-quellen-und-evidenz.md#widerlegt-x)) |

## Was diese Sammlung nicht leistet

- **Wirksamkeit ist nicht belegt.** Keine Quelle misst, ob Skills, Negativlisten, Zufallspaletten oder Linter Slop messbar reduzieren. Belegt ist, was die Werkzeuge tun und dass die Slop-Kataloge übereinstimmen.
- **Ziel in Bewegung.** Jede Verbotsliste erzeugt neue Defaults (siehe [02, Abschnitt 3](02-ai-slop-erkennen-und-vermeiden.md#3-merkmale-zweiter-ordnung)). Die Listen in 02 und 04 sollten etwa halbjährlich gegen den aktuellen `frontend-design`-Skill und die avoid-ai-design- bzw. Impeccable-Kataloge abgeglichen werden.
- **Lücken der Recherche:** Nielsen-Heuristiken, Ladezustände, Core Web Vitals, Dark Mode und Dark Patterns stammen aus Fachwissen [F]. Für Formulare gibt es inzwischen Belege aus Nutzerforschung, die aber nur [A] sind (siehe [06, Abschnitt 8](06-design-systeme.md#8-formulare-und-fehlermeldungen-a)). Von den Design-Systemen sind nur Material 3, Apple HIG, Fluent 2, Carbon und Cloudscape verifiziert, Polaris, Primer, Spectrum und Lightning fehlen. Keine verifizierten Vergleiche gibt es für v0, Lovable, Bolt und Windsurf, und keine Bewertung von Magic UI, Aceternity und 21st.dev.
