# Quellen und Belegstärke

Stand: 12.11.2026.

## Methode

Die Recherche lief in vier Wellen mit demselben Ablauf. Je Welle wurden 5 Suchwinkel parallel durchsucht, 22, 23, 23 bzw. 22 Quellen abgerufen und daraus 110, 99, 114 bzw. 110 falsifizierbare Aussagen extrahiert. Je 25 davon wurden adversarial verifiziert: drei unabhängige Prüfer, und eine Aussage fällt erst, wenn zwei von drei sie widerlegen.

| Welle | Fokus | Quellen | Aussagen | verifiziert | bestätigt | widerlegt |
|---|---|---|---|---|---|---|
| 1 | Best Practices + AI Slop (Primärquellen) | 22 | 110 | 25 | 21 | 4 |
| 2 | Community-Wissen | 23 | 99 | 25 | 20 | 5 |
| 3 | Design-Systeme, Formular-Forschung, Desktop-HIGs (06.11.2026) | 23 | 114 | 25 | 22 | 3 |
| 4 | GitHub-Repos für bessere UI/UX und gegen Slop (06.11.2026) | 22 | 110 | 25 | 21 | 4 |

In Welle 3 betreffen die 25 geprüften Aussagen nur Material 3, Apple HIG, Fluent 2, Carbon und Cloudscape. Die Aussagen zu GOV.UK, USWDS, Baymard, NN/g, PatternFly, GNOME, KDE und shadcn/ui wurden aus Budgetgründen nicht geprüft und sind in [06](06-design-systeme.md) als [A] markiert. Der erneut abgerufene Anthropic-Artikel lieferte wieder die in Welle 1 widerlegten Angaben (Gewichtspaare 100/200 gegen 800/900, ca. 400 Tokens). Sie wurden nicht übernommen.

In Welle 4 wurden Sternzahlen, Lizenzen und Aktivität über die GitHub-API geprüft (Stand 06.11.2026). Ohne geprüfte Aussage blieben: Leonxlnx/taste-skill, die Systemprompt-Sammlung x1xhlol/system-prompts-and-models-of-ai-tools (v0, Lovable, Bolt, Emergent), awesome-cursorrules, awesome-claude-code, awesome-claude-skills und superdesign-skill. Die Sternzahl von ui-ux-pro-max-skill wurde nicht erfasst. Die GitHub-Codesuche war gedrosselt, der Schriftvergleich in [03, B6](03-community-howtos-und-ideen.md#b6-was-die-repos-gemeinsam-haben-und-wo-sie-sich-widersprechen) kann deshalb unvollständig sein.

Ergänzend wurde Anthropics `frontend-design`-Skill direkt von GitHub gelesen (Stand nach PR #1713, gemergt am 03.09.2026, Merge-Commit `41bbe19`), zusätzlich zur Verifikation in Welle 2.

**Was das bedeutet:** Mit [V]/[T] markierte Aussagen haben die Prüfung überstanden. [A] markiert Aussagen, die aus abgerufenen Quellen extrahiert, aber aus Budgetgründen nicht adversarial geprüft wurden. Sie sind korrekt zitiert, inhaltlich aber Einzelberichte. [F] ist Fachwissen, das in dieser Recherche nicht eigens geprüft wurde.

**Review der Leitfäden (ZK-Arbitration, 06.11.2026):** Agnes (Codex, gpt-6-astra) und Eva-Marie (Claude Opus 5.5) haben die Dateien 00–06 und die Templates auf Basis von Commit `31f4e28` zuerst getrennt begutachtet und ihre Befunde danach abgeglichen. Das war eine Text- und Strukturanalyse mit Stichproben an Primärquellen (in der Tabelle „Primärquellen“ als „live geprüft 06.11.2026“ markiert), keine Prüfung mit Nutzern und kein Review des Toolings. Die Befunde sind redaktionelle Korrekturen. Sie sind keine weitere Verifikationswelle im Sinne der Tabelle oben und kein Beleg für die Wirksamkeit der Regeln.

## Hinweis zur Version des frontend-design-Skills

Es gibt mindestens drei Fassungen, und die Community zitiert oft die älteste:

| Fassung | Inhalt zu Slop |
|---|---|
| Anthropic-Artikel/Cookbook, Nov. 2025 | Nennt Inter, lila Verläufe auf Weiß, minimale Animation. Detailangaben zum Prompt (ca. 400 Tokens, Gewichtspaare 100/200 gegen 800/900, genaue Verbotsliste) wurden mit **0-3 widerlegt**: Sie stehen so nicht in der Quelle. |
| Lokale Plugin-Kopie (`claude-plugins-official`, Version unbekannt, gelesen am 05.11.2026) | 3 Cluster (Creme/Terrakotta, Fast-Schwarz/Acid, Broadsheet) |
| GitHub `anthropics/skills`, PR #1713 (Merge-Commit `41bbe19`), 03.09.2026 | 5 Cluster (zusätzlich SaaS-Card-Kit und Template-Chrome), typografische Tells, Bewegungsregeln. **Diese Fassung zitiert die Dokumentation.** |

## Primärquellen

| Quelle | Thema | Qualität |
|---|---|---|
| [W3C: WCAG 2.2, SC 2.5.8 Target Size (Minimum)](https://www.w3.org/TR/WCAG22/#target-size-minimum) | Zielgrößen, AA, 24×24 CSS-px mit Ausnahmen | normativ (W3C Recommendation), live geprüft 06.11.2026 |
| [W3C: WCAG 2.2, SC 1.4.10 Reflow](https://www.w3.org/TR/WCAG22/#reflow) | Reflow, AA | normativ (W3C Recommendation), live geprüft 06.11.2026 |
| [W3C: What's new in WCAG 2.2](https://w3.org/WAI/standards-guidelines/wcag/new-in-22/) | Neue Kriterien | informativ (Übersicht) |
| [W3C: Understanding 2.5.8 Target Size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html) | Zielgrößen | informativ (Erläuterung), live geprüft 06.11.2026 |
| [W3C: Understanding 1.4.10 Reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html) | 320 CSS-px, 400 % bei 1280 px, erforderliche zweidimensionale Bereiche | informativ (Erläuterung), live geprüft 06.11.2026 |
| [W3C: Understanding 2.4.11 Focus Not Obscured](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html) | Fokus | informativ (Erläuterung) |
| [W3C ARIA APG: Dialog (Modal)](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/) | Fokusführung und Fokus-Rückgabe bei Modals | informativ (Praxisleitfaden), live geprüft 06.11.2026 |
| [USWDS: Disabled states for components in forms](https://designsystem.digital.gov/components/form/#disabled-states-for-components-in-forms) | `aria-disabled` nur mit Skript, das die Aktivierung unterbindet | Designsystem, live geprüft 06.11.2026 |
| [W3C Design Tokens Format 2025.10](https://www.w3.org/community/reports/design-tokens/CG-FINAL-format-20251028/) | Token-Format | CG Final Report, kein Standard |
| [Atlassian: Design tokens](https://atlassian.design/foundations/tokens/design-tokens/) | Tokens | Designsystem |
| [IBM Carbon: Themes](https://www.carbondesignsystem.com/building-blocks/foundations/themes) | Tokens, Themes | Designsystem |
| [Grafana: Dashboard best practices](https://grafana.com/docs/grafana/latest/visualizations/dashboards/build-dashboards/best-practices/) | Ops-Dashboards | Hersteller |
| [PatternFly: Alert guidelines](https://www.patternfly.org/components/alert/design-guidelines) ([v5-Archiv](https://v5-archive.patternfly.org/components/alert/design-guidelines)) | Toasts, Alerts | Designsystem |
| [PatternFly: Empty state guidelines](https://www.patternfly.org/components/empty-state/design-guidelines) | Leerzustände | Designsystem |
| [Playwright: Accessibility testing](https://playwright.dev/docs/accessibility-testing) | axe | Hersteller |
| [Anthropic: Improving frontend design through skills](https://claude.com/blog/improving-frontend-design-through-skills) (auch [/resources/articles/…](https://claude.com/resources/articles/improving-frontend-design-through-skills)) | Ursache von Slop | Hersteller in eigener Sache |
| [anthropics/skills: frontend-design](https://github.com/anthropics/skills/tree/main/skills/frontend-design) | Skill-Text | Hersteller |
| [pbakaus/impeccable](https://github.com/pbakaus/impeccable), [README v2.3.2](https://cdn.jsdelivr.net/npm/impeccable@2.3.2/README.md) | Detektor, Skill | Selbstbeschreibung |

## Design-Systeme und Formular-Forschung (Welle 3)

Alle abgerufen am 06.11.2026. Die Seiten sind nicht versioniert und können sich ändern.

| Quelle | Thema | Belegstärke in 06 |
|---|---|---|
| [Material 3: State layers](https://m3.material.io/foundations/interaction/states/state-layers) | Zustände, 48-dp-Ziel | [V], gegen Token-Repos von material-web und Flutter geprüft |
| [Material 3: Easing and duration](https://m3.material.io/styles/motion/easing-and-duration/tokens-specs) | Bewegung | [V], von Google als „no longer maintained“ markiert |
| [Material 3: Density](https://m3.material.io/foundations/layout/grids-spacing/density) | Dichte | [V]/[T] |
| [Android Codelab: M3 Design Theming](https://developer.android.com/codelabs/m3-design-theming) | Farbrollen, Typo- und Formskala | [A] |
| [Apple HIG: Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility) | Zielgrößen, Kontrast, Textgrößen | [V] für Zahlen, [A] für Farbe und Bewegung |
| [Apple HIG: Buttons](https://developer.apple.com/design/human-interface-guidelines/buttons) | Button-Hierarchie, macOS | [A] |
| [Fluent 2: Layout](https://fluent2.microsoft.design/layout) | 4-px-Skala, Zielgrößen | [V] |
| [IBM Carbon: 2x Grid](https://carbondesignsystem.com/elements/2x-grid/overview/) | Raster, Breakpoints | [V] |
| [IBM Carbon: Empty states](https://carbondesignsystem.com/patterns/empty-states-pattern/) | Leerzustände | [V], eine Aussage widerlegt |
| [Cloudscape: Content density](https://cloudscape.design/foundation/visual-foundation/content-density/) | Dichte | [V] |
| [Cloudscape: Empty states](https://cloudscape.design/patterns/general/empty-states/) | Leerzustände | [V], eine Aussage widerlegt |
| [PatternFly: Empty state guidelines](https://www.patternfly.org/components/empty-state/design-guidelines) | Leerzustände | [A] in 06, [V] in 01 |
| [GOV.UK Design System: Error message](https://design-system.service.gov.uk/components/error-message) | Fehlermeldungen | [A] |
| [GOV.UK Service Manual: Form structure](https://www.gov.uk/service-manual/design/form-structure) | One thing per page, Question Protocol | [A], nennt selbst keine Studien |
| [USWDS: Form](https://designsystem.digital.gov/components/form/) | Formular-Layout, Pflichtfelder, Disabled | [A] |
| [Baymard: Avoid multi-column forms](https://baymard.com/research-articles/avoid-multi-column-forms) | Einspaltigkeit | [A], Usability-Tests |
| [Baymard: Inline form validation](https://baymard.com/blog/inline-form-validation) | Validierung | [A], Usability-Tests, Prozentangabe in der Quelle uneinheitlich |
| [NN/g: Placeholders in form fields](https://www.nngroup.com/articles/form-design-placeholders/) | Labels, Platzhalter | [A], Stand 2014, geprüft 2018 |
| [GNOME HIG: Header bars](https://developer.gnome.org/hig/patterns/containers/header-bars.html) | Header Bars | [A] |
| [KDE HIG: Layout and navigation](https://develop.kde.org/hig/layout_and_nav/) | Abstände, Navigation | [A] |
| [Kirigami: Platform units](https://api.kde.org/qml-org-kde-kirigami-platform-units.html) | Einheiten, Dauern, humanMoment | [A] |
| [shadcn/ui: Introduction](https://ui.shadcn.com/docs) | Selbstverständnis, Defaults | [A], Hersteller in eigener Sache |

## GitHub-Repos (Welle 4)

Metadaten über die GitHub-API am 06.11.2026. Details und Einordnung in [03, B5–B7](03-community-howtos-und-ideen.md#b5-die-repo-landschaft-auf-github-stand-06112026).

| Repo | Thema | Sterne | Interessenkonflikt |
|---|---|---|---|
| [anthropics/skills: frontend-design SKILL.md](https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md) | Slop-Cluster, Plan-Prüfung-Code-Kritik | ca. 188k (ganzes Repo) | Hersteller |
| [pbakaus/impeccable](https://github.com/pbakaus/impeccable), [SKILL.md](https://raw.githubusercontent.com/pbakaus/impeccable/main/plugin/skills/impeccable/SKILL.md) | Detektor, Befehle, Modi | ca. 104k | eigenes Tool, schnelles Wachstum |
| [VoltAgent/awesome-design-md](https://github.com/VoltAgent/awesome-design-md) | 84 Marken-DESIGN.md | ca. 126k | **bezahlte Aufträge, Sponsor**, schnelles Wachstum |
| [google-labs-code/design.md](https://github.com/google-labs-code/design.md) | Format-Spezifikation, Lint-CLI | nicht bestätigt | Hersteller, Alpha |
| [nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill/blob/main/skill.json) | Stil-, Paletten- und Schriftkatalog | nicht erfasst | eigenes Tool, Stilzahl geschönt |
| [21st-dev/magic-mcp](https://github.com/21st-dev/magic-mcp) | Komponentenregister, 21st MCP | ca. 6,4k | Anbieter |
| [superdesigndev/superdesign](https://github.com/superdesigndev/superdesign) | Design-Agent, nicht mehr gepflegt | ca. 7,6k | **Anbieter, bittet um HN-Upvotes** |
| [funboy322/avoid-ai-design](https://github.com/funboy322/avoid-ai-design) | Tells, Second-Order, `detect.mjs` | 145 | eigenes Tool |
| [gabelul/pixelslop](https://github.com/gabelul/pixelslop) | Playwright-Audit | 9 | eigenes Tool |
| [x1xhlol/system-prompts-and-models-of-ai-tools](https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools) | Systemprompts von v0, Lovable u. a. | – | **Echtheit nicht prüfbar**, nicht verifiziert |
| [hesreallyhim/awesome-claude-code](https://github.com/hesreallyhim/awesome-claude-code) | Linkliste | – | nicht verifiziert |

Sekundärquellen dieser Welle, nicht als Beleg verwendet: open-design.ai (Impeccable-Profil, eine Zahl widerlegt), awesome.ecosyste.ms (taste-skill), bitdoze.com, claudeskills.info, gitcode.csdn.net, viblo.asia (Vergleichsartikel), claude-tips.pages.dev (Playwright-MCP), Tways-study/Meticulous.

## Skill-Repos und Praxisblogs

| Quelle | Thema | Interessenkonflikt |
|---|---|---|
| [funboy322/avoid-ai-design](https://github.com/funboy322/avoid-ai-design) | Tells (Anzahl 67 in Welle 4 nicht bestätigt), Second-Order-Tells, Linter | eigenes Tool |
| [Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill) | Zufallspaletten, Browser-Checks | eigenes Tool |
| [madebyaris/…/anti-slop-design](https://github.com/madebyaris/advance-minimax-m2-cursor-rules) ([skillsmp](https://skillsmp.com/skills/madebyaris-advance-minimax-m2-cursor-rules-cursor-skills-anti-slop-design-skill-md)) | Register, Category-Reflex | eigenes Tool |
| [gabelul/pixelslop](https://github.com/gabelul/pixelslop), [Pattern-Katalog](https://cdn.jsdelivr.net/npm/pixelslop@0.3.8/dist/skill/resources/ai-slop-patterns.md) | Messung, Schwellwerte | eigenes Tool |
| [claudskills: audit-ai-frontend](https://claudskills.com/skills/audit-ai-frontend/SKILL.md) | P0/P1-Priorisierung | — |
| [alinaqi/claude-bootstrap ui-testing](https://playbooks.com/skills/alinaqi/claude-bootstrap/ui-testing) | Pre-flight-Checkliste | — |
| [superdesign.dev](https://www.superdesign.dev/blog/claude-code-ui-design) | Prompt-Muster, Design-Agent | **Anbieter, bewirbt Produkt** |
| [capitalandcompute.net](https://capitalandcompute.net/blog/fix-ai-slop-design/) | Second-Order, Richtung vs. Filter | — |
| [13labs.au](https://www.13labs.au/guides/ai-ui-that-doesnt-look-ai-generated) | Theme committen, Lovable-Tokens | Agentur |
| [925studios.co](https://www.925studios.co/blog/ai-slop-design-tells) | Tells, Rückkopplung | Agentur |
| [prg.sh](https://prg.sh/ramblings/Why-Your-AI-Keeps-Building-the-Same-Purple-Gradient-Website) | Ursache, Referenz-Prompting | — |
| [dev.to/alanwest: indigo-500](https://dev.to/alanwest/why-every-ai-built-website-looks-the-same-blame-tailwinds-indigo-500-3h2p) | Tailwind-Herkunft | — |
| [dev.to/alanwest: fix the AI look](https://dev.to/alanwest/how-to-fix-the-ai-generated-look-in-your-frontend-1ahh) | Defaults entfernen, ESLint, Texte | — |
| [dev.to/kent-tokyo](https://dev.to/kent-tokyo/what-i-do-before-letting-claude-code-touch-web-app-design-53n0) | DESIGN.md, Screenshot-Schleife | — |
| [besthub.dev](https://www.besthub.dev/articles/why-ai-generated-frontends-need-more-than-screenshots-a-playwright-acceptance-checklist-6326cd9f1bb3) | Playwright-Abnahme | — |
| [pencilandpaper.io](https://www.pencilandpaper.io/articles/ux-pattern-analysis-enterprise-data-tables) | Datentabellen | UX-Beratung |
| [annaarteeva.substack](https://annaarteeva.substack.com/p/design-systems-lovable-bolt-v0-and) | Lovable/Bolt/v0 Knowledge | — |
| [robotsonpayroll.substack](https://robotsonpayroll.substack.com/p/how-to-avoid-that-vibe-coded-look) | Screenshot → design.md, Drift | — |
| [adriankrebs.ch](https://adriankrebs.ch/blog/design-slop/) | slopcop, 1.590 Show-HN-Seiten | eigenes Tool |
| [seunghyeonlab.blogspot](https://seunghyeonlab.blogspot.com/2026/05/impeccable-design-linter-that-catches.html) | Impeccable in CI | — |
| [designsystemscollective.com](https://www.designsystemscollective.com/is-anyone-else-tired-of-every-tailwind-shadcn-app-looking-the-same-69c545e73114) | shadcn-Gleichförmigkeit | nur Anfang lesbar (Paywall) |

## Foren

| Quelle | Inhalt | Gewicht |
|---|---|---|
| [r/webdesign: 10 websites in 4 months](https://reddit.com/r/webdesign/comments/1tab7tz/built_10_websites_for_clients_in_4_months_heres/) | Interview-Workflow, Komponentensystem | Werbeverdacht (uicraft), Top-Kommentar +32 kritisch |
| [r/ProductManagement: All vibecoded apps look the same](https://reddit.com/r/ProductManagement/comments/1qccb1g/all_vibecoded_apps_look_the_same/) | Ursache, tweakcn, 21st.dev, frontend-design-Skill | Top-Kommentar 40 Punkte |
| [r/ClaudeAI: being creative](https://reddit.com/r/ClaudeAI/comments/1sh5ztp/my_claude_has_a_question_about_being_creative_and/) | Negativliste, enge Vorgaben, Temperatur | Kommentare mit 1 Punkt |
| [r/ChatGPTCoding: Community Showcase](https://reddit.com/r/ChatGPTCoding/comments/1srf1k0/community_showcase_i_stopped_letting_claude/) | Framer-Template-Workflow | Eigenwerbung, 17 Punkte |
| [r/ClaudeAI über Mirror](https://reddit.sentinel-team.org/posts/1qsxdn7/snapshots/2026-02-02T00%3A51%3A05.492676Z) | Playwright-MCP-Schleife, Screenshot statt Regeldatei | Einzelberichte |
| [Hacker News 49290499](https://news.ycombinator.com/item?id=49290499) | Tells, Debatte „neues Bootstrap“ | kleiner Thread |

Nicht auswertbar: recapio.com (YouTube-Zusammenfassung, Inhalt wird per JavaScript nachgeladen) sowie zwei Reddit-Mirrors (libreddit, redlib).

## Widerlegt [X]

| Aussage | Stimmen | Quelle |
|---|---|---|
| Der frontend-design-Prompt enthält eine konkrete Verbotsliste (Inter, Roboto, Arial, Systemschriften, lila Verläufe …) | 0-3 | Anthropic-Artikel 11/2025 |
| Der Prompt steuert genau vier Dimensionen in der genannten Ausformulierung | 0-3 | Anthropic-Artikel 11/2025 |
| Der Anti-Slop-Prompt (ca. 400 Tokens) verlangt Gewichtspaare 100/200 gegen 800/900 | 0-3 | Anthropic-Artikel 11/2025 |
| Das W3C-Token-Format ist ausdrücklich als maschinenlesbare Regelquelle für KI-Tools gedacht | 1-2 | W3C DTCG |
| Impeccable: „25k Sterne, 23 Befehle, 27 Checks“ | 0-3 | theaileverage.beehiiv.com |
| UI/UX Pro Max: „161 Regeln, 67 Stile …“ | 0-3 | theaileverage.beehiiv.com |
| Taste Skill: „15.4k Sterne, Stil-Varianten im Repo“ | 0-3 | theaileverage.beehiiv.com, Varianten liegen inzwischen in `taste-skill-classics` |
| Der shadcn-Look entsteht allein durch nicht angepasste Defaults | 0-3 | annaarteeva.substack |
| Tailwind: `colors` ersetzen statt erweitern zwingt auf die eigene Palette | 1-2 (umstritten, nicht klar falsch) | dev.to/alanwest |
| Material 3 verlangt 48×48 dp auch unter Density-Skalierung (so formuliert) | 0-3 | m3.material.io, Density |
| Cloudscape: Leerzustände dürfen nie Fehler ersetzen, jeder braucht eine Aktion, die Beschreibung darf nichts wiederholen | 0-3 | cloudscape.design, Empty states |
| Carbon: Leerzustand hat drei Pflichtteile, Überschrift möglichst positiv | 0-3 | carbondesignsystem.com, Empty states |
| google-labs-code/design.md: 28,8k Sterne, 2,3k Forks, letzter Commit 16.10.2026 | 0-3 | github.com/google-labs-code/design.md |
| superdesign arbeitet im Kern mit parallelen Varianten, Forks und Low-Fi-Wireframes | 0-3 | github.com/superdesigndev/superdesign |
| avoid-ai-design: Katalog mit 67 Tells, jeweils mit Signal, Fix für HTML/CSS und React und Quellen | 1-2 | github.com/funboy322/avoid-ai-design |
| Impeccable hatte am 14.09.2026 67.876 Sterne | 1-2 | open-design.ai |

## Offene Fragen

1. Gibt es unabhängige Vorher-Nachher-Vergleiche oder Blindtests, die zeigen, dass Skills, Negativlisten oder Linter Slop messbar reduzieren?
2. Wie stark wirkt der Pink-Elephant-Effekt von Negativlisten in der Praxis, und helfen rotierende Stilvorgaben oder Referenz-Screenshots dauerhaft gegen Second-Order-Defaults?
3. Wo zieht die Community die Grenze, ab der Generik akzeptabel ist, und wie trennen die Skills zwischen Brand- und Product-Register?
4. Wie gut decken Linter und Screenshot-Kontrollen die funktionalen Probleme ab: tote Buttons, fehlende Zustände, inkonsistente Abstände?
5. Wie zuverlässig sind die Detektoren? slopcop nennt 5–10 % Falsch-Positive, für die anderen fehlen Angaben.
6. Was schreiben Polaris, Primer, Spectrum und Lightning konkret vor, und halten die [A]-Regeln von GOV.UK, USWDS, Baymard und NN/g einer adversarialen Prüfung stand?
7. Wo widersprechen sich macOS-HIG, GNOME-HIG/libadwaita und KDE-HIG/Kirigami, etwa bei der Reihenfolge von Dialog-Buttons, Standardhöhen von Bedienelementen und Toolbars?
8. Welche Federparameter von Material 3 Expressive ersetzen die alten Easing- und Dauer-Tokens? Veröffentlichen Fluent, Carbon und Apple vergleichbare Bewegungswerte?
9. Gibt es empirische Belege, dass übernommene System-Defaults (Material, shadcn) als generisch wahrgenommen werden, und welche Abweichungen machen eine Oberfläche unterscheidbar, ohne die Mindestwerte zu verletzen?
10. Reduzieren Impeccable, frontend-design oder avoid-ai-design Slop messbar, etwa im Blindvergleich auf denselben Prompts oder per Detektor-Score gegen einen Lauf ohne Skill?
11. Sind die Sternverläufe von awesome-design-md und Impeccable organisch? Dafür fehlt eine Auswertung von Sternverlauf und Stargazer-Konten.
12. Was schreiben die Systemprompts von v0, Lovable und Bolt zur UI vor, und was enthalten taste-skill und die awesome-Listen konkret?
13. Wird DESIGN.md nach Googles Spezifikation zum gemeinsamen Briefing-Format, auf dem Verbots-Skills aufsetzen, oder laufen Katalog-Ansätze und Anti-Default-Regeln weiter auseinander?

## Zahlen mit Verfallsdatum (Stand 06.11.2026)

anthropics/skills: ca. 188k Sterne (ganzes Repo) · Impeccable: ca. 104k Sterne, v4.8.0, 62 Regeln, 23 Befehle plus Alias `craft` · awesome-design-md: ca. 126k Sterne, 84 Dateien · superdesign: ca. 7,6k · 21st MCP: ca. 6,4k · Taste Skill: ca. 110k Sterne, v2.5.0 (Stand 05.11.) · avoid-ai-design: 145 Sterne · anti-slop-design: 126 Sterne (Stand 05.11.) · pixelslop: 9 Sterne · Lovable Knowledge: 10.000 Zeichen · v0: Funktionsname „Knowledge“ vermutlich überholt.


## Kuratierte Brand-Review-Ergänzung (12.11.2026)

[A] Quelle: [dtransla-maker/Anti-AI-Design-Slop](https://github.com/dtransla-maker/Anti-AI-Design-Slop/tree/473b78ba257b8b07e3c98892b7ce2a35e55e2285), Revision `473b78ba257b8b07e3c98892b7ce2a35e55e2285`, abgerufen am 12.11.2026. Lizenz: [MIT, Copyright (c) 2026 Daniel Translateur](https://github.com/dtransla-maker/Anti-AI-Design-Slop/blob/473b78ba257b8b07e3c98892b7ce2a35e55e2285/LICENSE).

Ausgewertet: `README.md`, `checklists/website-hero-checklist.md` und `scoring/dimension-rubric.md`. Die Quelle liefert redaktionelle Heuristiken für Marketingvisuals, keine empirisch validierte Qualitätsmetrik. Dies ist keine zusätzliche adversariale Verifikationswelle.

Übernommen als eigenständig formulierte Fragen in `src/core.ts`: Erkennbarkeit von Zielgruppe, Problem, belegtem Vertrauensgrund und nächster Aktion; Aussagefunktion des Motivs; Passung zur dokumentierten Marke über das Logo hinaus; mobile Darstellung. Die Anwendung ist auf `profile=brand` begrenzt und verlangt konkrete Evidenz sowie eine plausible alternative Erklärung. Fehlendes Briefing oder fehlende Ansichten bleiben offene Prüfabdeckung.

Nicht übernommen: 0–5-Originalitätsscores, L4-Publikationsschwelle, pauschale Ablehnung vertrauter Gestaltung und eine behauptete Fünf-Sekunden-Messung. Product-UIs dürfen bewusst konventionell sein. Subjektive Befunde bleiben `kind=review` und blockieren CI nicht. Es gibt keine neue Abhängigkeit, kein Submodule und keinen automatischen Upstream-Import.

Die [Kalibrierungsbeispiele](templates/brand-review-examples.md) sind eigene hypothetische Lehrbeispiele, keine kopierten Upstream-Beispiele oder geprüften Nutzerergebnisse. Künftige Updates werden gegen diese Revision verglichen und einzeln auf Nutzen, Evidenz und Konflikte mit unseren Vorrangregeln geprüft.
