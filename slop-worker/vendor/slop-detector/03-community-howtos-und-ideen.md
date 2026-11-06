# Community: Anleitungen, Workflows und Ideen gegen AI Slop

Stand: 06.11.2026. Markierungen siehe [00-README.md](00-README.md#legende).

Diese Sammlung stammt aus Reddit, Hacker News, Substack, dev.to, Blogs und GitHub-Skills. Die meisten Einträge sind Erfahrungsberichte einzelner Personen. Wo eine Quelle ein eigenes Produkt bewirbt, steht das dabei.

---

## A. Workflows: wie Leute konkret vorgehen

### A1. Erst ein Interview, dann der Plan, dann der Code
**Quelle:** r/webdesign, Freelancer, „Built 10 websites for clients in 4 months“ (Mai 2026). **Beleg:** [A], in den Kommentaren breit bestätigt, aber der Post steht unter Werbeverdacht (uicraft).

1. Referenzen recherchieren: Wettbewerber, Pinterest, Mobbin, Framer-Templates, Designsysteme, Typografie, Vertrauenssignale.
2. Mit Skizzen in Figma oder auf Papier die Richtung festlegen, bevor gebaut wird.
3. Ein Projektdokument mit 11 festen Abschnitten anlegen, darunter Zielgruppe, Persona, visuelle Richtung, Markenregeln, Komponentenregeln, „what to avoid“ und Referenzen. Die KI befragt dich dazu („ask me all the questions you need“), das dauert 30–40 Minuten.
4. Daraus eine schrittweise `Implementation.md` erstellen und nach jedem Schritt prüfen.
5. Vor der ersten Seite ein Komponentensystem pro Kunde anlegen (Basis: Untitled UI, shadcn oder uicraft).
6. Texte nicht mit KI schreiben.

Aus den Kommentaren: Vorab skizzieren machte die Designs „sofort besser“. Ein Nutzer verwendet statt manueller Befragung einen `/grill-me`-Interviewbefehl. Der meistbewertete Kommentar (+32) hält dagegen, das sei „einfach der klassische Designprozess“. Das stimmt, und genau darin liegt der Punkt.

### A2. Eine Referenzseite per Screenshot in eine design.md übersetzen
**Quelle:** robotsonpayroll.substack.com, „How to avoid that vibe-coded look“ (Juli 2026). **Beleg:** [A]

1. Eine Referenz aus Galerien wie Recent, Land-book, Mobbin oder SaaS Landing Page wählen.
2. Einen Screenshot in Desktopbreite und voller Auflösung machen.
3. Den Screenshot mit einem Reverse-Engineering-Prompt in eine `design.md` übersetzen lassen: benannte Farben mit Hex-Codes, Schriften, Formen, Abstände, Do/Don't-Regeln, jeweils so formuliert, dass man sie am Bildschirm prüfen kann.
4. Die Datei dort ablegen, wo das Tool dauerhafte Anweisungen liest (Tabelle in [02](02-ai-slop-erkennen-und-vermeiden.md#ebene-2-die-richtung-dauerhaft-im-repo-verankern)).
5. **Drift-Kontrolle:** In langen Sessions den Agenten die `design.md` neu lesen lassen und den letzten Screen gegen die Farbliste und die Don'ts prüfen. Wer dieselbe Korrektur zweimal braucht, schreibt sie in die `design.md`, statt sie im Chat zu wiederholen.
6. **Squint-Test:** Erkennt jemand die kopierte Vorlage, hast du zu viel übernommen. Hex-Codes, Raster und Typo-Skala sind erlaubt, Logos, Illustrationen und Texte nicht.
7. **Reverse-Squint-Test:** Einen frischen Chat fragen, welcher AI-Builder den eigenen Screenshot erzeugt hat.

Als Werkzeug empfiehlt der Autor tweakcn, einen kostenlosen visuellen Editor für die Farbthemes von shadcn bzw. den AI-Buildern.

### A3. Ein Template übernehmen, dann nur Funktionen ergänzen lassen
**Quelle:** r/ChatGPTCoding, Community Showcase (April 2026). **Beleg:** [A], der Autor bewirbt ein eigenes Framer-Export-Tool.

Eine Framer-Vorlage oder Framer-Seite nach HTML/CSS/JS exportieren, in ein neues Repo legen und Claude Code anweisen, das Designsystem beizubehalten und nur Funktionen zu ergänzen: Auth, Postgres-Schema, Dashboard, Stripe. Die Begründung: Das Modell kann gut bestehende Strukturen ändern, aber schlecht eigenen visuellen Geschmack entwickeln. Mehrere Kommentatoren stimmen zu.

Einschränkungen des Autors: Das ersetzt keinen Designer für ein ernsthaftes Produkt, und eine fremde Live-Seite zu kopieren ist nicht in Ordnung. Geeignet für MVPs, interne Tools, Landingpages und Side Projects.

### A4. Screenshot-Schleife mit Playwright-MCP
**Quellen:** r/ClaudeAI (u/walpoles93), dev.to/kent-tokyo, YouTube Patrick Ellis („Playwright MCP subagents“, nur als Zusammenfassung erreichbar). **Beleg:** [A], von mehreren Quellen bestätigt, dazu [V] als Empfehlung im Anthropic Skill.

- Claude macht Screenshots der laufenden App und bessert iterativ nach, statt HTML und CSS blind zu schreiben.
- Pro Runde nur 2–3 Änderungen, die man visuell prüfen kann. Den responsiven Umbruch bei 375 px prüfen.
- Komponente für Komponente bauen. Wer alles in einem Durchgang generiert, findet strukturelle Probleme erst spät.
- Den Umfang im Prompt begrenzen, damit die KI keine unbeteiligten Teile umbaut.
- Alle Interaktionszustände angeben (default, hover, disabled, loading, error) und die Dark-Mode-Frage am Anfang entscheiden.

Gegenstimme: Ein Nutzer berichtet, dass Claude bei responsiven Layouts auch nach über 30 CSS-Iterationen an einem Tag schwach bleibt und Komponenten nicht von selbst wiederverwendet. Man muss Inkonsistenzen ausdrücklich benennen und ein Refactoring anfordern. [A]

### A5. Ein Screenshot sagt mehr als eine Regeldatei
**Quelle:** r/ClaudeAI (u/MxTide). **Beleg:** [A], Einzelmeinung.

Ein Screenshot der Ziel-UI ist laut Nutzer zuverlässiger als eine `claude.md` oder `frontend.md`, weil das Modell Abstände, Schatten und Farben aus dem Bild besser abliest, als Text sie beschreiben kann. Der Fragesteller hatte Regeldateien bereits ohne Erfolg genutzt.

Einordnung [T]: 13labs.au zitiert die Design2Code-Studie, nach der nur 49 % der GPT-4V-Ausgaben als Ersatz für die Referenz taugten. Ein Bild hilft also, garantiert aber nichts. Am besten kombinierst du Bild und `design.md`.

### A6. Figma als Quelle
**Quellen:** r/ClaudeAI (u/diphthing), r/ProductManagement, annaarteeva.substack. **Beleg:** [A]

- Figma-Variablen zusammen mit dem Figma MCP nutzen, damit die Tokens aus Figma direkt im Code landen.
- Mit Figma Make entwerfen und dann per Figma MCP an Cursor übergeben.
- In Lovable, Bolt oder v0 die KI `tailwind.config.ts` aus Figma-Token-Exporten aktualisieren lassen oder einen Screenshot der Figma-Styles einfügen.

### A7. Ein separater Design-Agent erzeugt Varianten
**Quelle:** superdesign.dev, Anbieterblog (Juli 2026). **Beleg:** [A], bewirbt das eigene Produkt.

Designentscheidungen an einen eigenen Design-Agenten auslagern. Er erzeugt mehrere verzweigte HTML-Varianten, die du verfeinerst. Danach baut Claude Code die gewählte Variante ein. Laut Quelle lohnt sich das nur bei Oberflächen für Endnutzer, nicht bei internen Admin-Tools.

Verwandt [A] (prg.sh): Mehrere Designrichtungen anfordern, um nicht beim ersten und generischsten Ergebnis zu landen. Dazu 3–5 Referenzen aus Dribbble, Mobbin oder Awwwards in Worten beschreiben.

---

## B. Regel- und Skill-Bausteine aus der Community

### B1. Negativliste in der Design-System-Datei
**Quelle:** r/ClaudeAI (April 2026). **Beleg:** [A], Kommentar mit 1 Punkt.

Eine Liste in der Design-System-Datei, die die Klischees beim Namen nennt (lila-blaue Verläufe, `rounded-2xl`-Karten mit Schatten, generische Hero-Sektionen, Karten-Raster), hat laut Bericht gewirkt. Vage Anweisungen wie „mach es kreativ“ wirkten nicht.

Derselbe Autor hat einen eigenen Skill, der bei jeder Frontend-Arbeit automatisch Tokens lädt und die Anti-Muster markiert. So sind die Defaults von vornherein richtig, statt dass man in jedem Prompt nachbessern muss.

### B2. Pixelwerte und Hex pro Komponente festlegen
**Quelle:** r/ProductManagement, „All vibecoded apps look the same“ (Januar 2026). **Beleg:** [A], von mehreren Nutzern genannt, aber nur mit 1–2 Punkten.

Konkrete Stilvorgaben formulieren (eckige Kanten, Monospace, hoher Kontrast, keine Verläufe, nur Vollfarben), dazu Pixelbreiten und Hex pro Komponente festlegen. Das Ganze als wiederverwendbaren Prompt speichern.

### B3. Den frontend-design-Skill als Prompt für andere Modelle verwenden
**Quelle:** r/ProductManagement. **Beleg:** [A]

Laut Nutzern bewirkt der Skill einen deutlichen Unterschied und funktioniert auch als Prompt für andere Modelle. Er braucht eine Beschreibung der App, damit er ein passendes Theme wählt. Ein zweiter Nutzer nennt ihn „nicht perfekt“ und passt danach selbst nach.

Gegenposition (u/jmdl04, r/ClaudeAI): Er baut bewusst auf shadcn/ui und bekannten App-Mustern auf, statt mit dem frontend-design-Skill gewagte Designs zu erzeugen. Das passt zu Produkt-UIs, bei denen Vertrautheit mehr zählt als Eigenständigkeit.

### B4. Ein festes Designsystem beendet die Detaildiskussion
**Quelle:** r/ChatGPTCoding (Designer_Reaction551). **Beleg:** [A]

Tailwind und shadcn als Basis, dazu eine feste Typo-Skala und feste Abstände. Damit war das Hin und Her um Details wie `rounded-xl` gegen `rounded-2xl` beendet. Seine These: Bei einem einzigen System zu bleiben ist wichtiger als die Qualität dieses Systems.

### B5. Die Repo-Landschaft auf GitHub (Stand 06.11.2026)
**Beleg:** [V] für Funktion und Metadaten, geprüft an Repo, README und GitHub-API (Welle 4, siehe [05](05-quellen-und-evidenz.md#methode)). Die Wirkung ist bei keinem Repo unabhängig gemessen. Alle Aussagen dazu sind Selbstauskünfte.

Die Repos lassen sich in vier Gruppen teilen:

**1. Regel- und Skill-Sätze: Verbotsliste plus Plan vor dem Code**

| Repo | Kernidee | Sterne, Lizenz |
|---|---|---|
| [anthropics/skills: frontend-design](https://github.com/anthropics/skills/tree/main/skills/frontend-design) | Die Referenz. Ablauf: Plan → Prüfung gegen das Briefing → Code → Kritik. Der erste Durchgang ist ein kompakter Token-Plan mit 4–6 benannten Hex-Farben, Schriften und ihren Rollen, einem Layoutkonzept, ASCII-Wireframes und Prinzipien. Danach prüft der Agent den Plan gegen das Briefing, ersetzt alles, was nach Default aussieht, und begründet das. Erst dann schreibt er Code. Nennt 5 Slop-Cluster und typografische Tells (siehe [02, Abschnitt 3](02-ai-slop-erkennen-und-vermeiden.md#3-merkmale-zweiter-ordnung)). Zuletzt geändert am 03.09.2026 (PR #1713) [V] | ca. 188k für das ganze Repo, nicht für den Skill; Skill unter Apache-2.0 |
| [pbakaus/impeccable](https://github.com/pbakaus/impeccable) | Laut README aus frontend-design hervorgegangen. Detektor mit 62 deterministischen Regeln ohne LLM, als Hook für Claude Code, Cursor, Codex, Copilot und weitere, als CLI (`npx impeccable detect src/` oder URL, `--json`, `--github`) und als Chrome-Erweiterung. Kontrast und kleine Schrift nur auf gerenderten Seiten. Befehle in Gruppen: Steuern (`bolder`, `quieter`, `distill`, `colorize`, `typeset`, `layout`, `animate`, `delight`, `overdrive`), Prüfen (`critique` mit Punktwert, `audit` nach P0–P3), Abschließen (`polish`, `harden`, `clarify`, `adapt`, `optimize`, `onboard`), Live (`live`, `generate`), Planen (`shape`, `init`, `document`, `extract`). `init` schreibt PRODUCT.md, `document` schreibt DESIGN.md. Vier Modi: Persuade (Landing, Marketing), Operate (App-UI, Dashboards), Read (Doku), Experience (Portfolio, Galerie) [V] | ca. 104k, Apache-2.0, aktiv (05.11.2026) |
| [Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill) | Teilt Paletten, Schriften und Hero-Layouts per Zufall zu, prüft im Browser. In Welle 4 nicht erneut geprüft | ca. 110k (Stand 05.11.2026), v2.5.0 |
| [madebyaris/…/anti-slop-design](https://github.com/madebyaris/advance-minimax-m2-cursor-rules) | Cursor-Skill: Register, Tonalität, Nutzungsszene, Category-Reflex-Check, „Slop Second Pass“ | 126 (Stand 05.11.2026) |

Impeccables README nennt 24 Befehle. Der 24., `craft`, ist ein veralteter Alias, es funktionieren also 23. [V]

**2. Design-Briefing als Datei (DESIGN.md)**

| Repo | Kernidee | Sterne, Lizenz |
|---|---|---|
| [VoltAgent/awesome-design-md](https://github.com/VoltAgent/awesome-design-md) | 84 DESIGN.md-Dateien nach dem Vorbild bekannter Marken (z. B. airbnb mit 545 Zeilen YAML-Tokens und Regeln). Anleitung: Datei ins Projekt legen und den Agenten bitten, „eine Seite, die so aussieht“ zu bauen. Kein eigenes Werkzeug nötig [V] | ca. 126k, MIT, erstellt 31.03.2026 |
| [google-labs-code/design.md](https://github.com/google-labs-code/design.md) | Spezifikation des Formats aus Google Stitch (Alpha). Zwei Ebenen: maschinenlesbare YAML-Tokens (Farbe, Maß, Token-Verweis, Typografie) und Markdown-Prosa mit dem Warum. Abschnitte optional, aber in fester Reihenfolge: Overview, Colors, Typography, Layout, Elevation & Depth, Shapes, Components, Do's and Don'ts. Die CLI `@google/design.md` (0.4.0, 27.07.2026) hat `lint` (11 Regeln, u. a. `broken-ref` als Fehler, `contrast-ratio` warnt unter 4,5:1, `missing-primary`, `orphaned-tokens`, `section-order`), `diff` (Exit 1 bei Verschlechterung), `export` (Tailwind v3/v4 oder W3C-DTCG-Tokens) und `spec` [V] | Apache-2.0; Sterne nicht bestätigt (Angabe 0-3 widerlegt) |

Die Vorlage [templates/DESIGN.md](templates/DESIGN.md) dieser Sammlung folgt dem Google-Format nicht. Wer `lint` und `export` nutzen will, überführt die Tokens in den YAML-Kopf und behält die Prosa. [F]

**3. Detektoren ohne LLM**

| Repo | Kernidee | Sterne, Lizenz |
|---|---|---|
| Impeccable-Detektor | siehe oben | – |
| [funboy322/avoid-ai-design](https://github.com/funboy322/avoid-ai-design) | SKILL.md plus `scripts/detect.mjs`: Node 18+, ohne Abhängigkeiten, kein Modellaufruf. Exit 2 bei P0/P1, sonst 0, also als CI-Gate nutzbar. Warnt vor Second-Order-Defaults (siehe B6) [V]. Die Katalog-Größe „67 Tells“ wurde in Welle 4 mit 1-2 nicht bestätigt | 145, MIT, letzter Push 24.09.2026 |
| [gabelul/pixelslop](https://github.com/gabelul/pixelslop) | Prüft gerenderte Seiten statt Quelltext: Playwright, Screenshots in 3 Viewports, berechnete Styles, gemessener Kontrast. 5 Säulen (Hierarchie, Typografie, Farbe, Responsiveness, Barrierefreiheit), Fix-Schleife mit Git-Checkpoints. Der Katalog hat 26 visuelle und 16 Quelltext-Muster, das README nennt noch 25 [V] | 9, Apache-2.0, kaum verbreitet |

**4. Generatoren und Komponentenquellen (kein Anti-Slop im engeren Sinn)**

| Repo | Kernidee | Sterne, Lizenz |
|---|---|---|
| [nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) | Gegenansatz zur Verbotsliste: durchsuchbare Wissensbasis, aus der der Agent wählt. Laut Manifest (v2.15.0) 192 Paletten, 74 Schriftpaare, 119 UX-Richtlinien und 25 Diagrammtypen, nachgezählt bestätigt. Die Angabe „80 Stile“ ist geschönt: Das README nennt selbst nur 51 aktive, `styles.csv` hat 89 Zeilen [V] | MIT; Sterne nicht erfasst |
| [21st-dev/magic-mcp](https://github.com/21st-dev/magic-mcp) | Heißt jetzt „21st MCP“. Komponentenregister plus Generator („wie v0, aber in Cursor/Claude Code“): über 10.000 React/Tailwind-Komponenten, shadcn-kompatibel. Ablauf: suchen, holen, installieren, an die Projekt-Tokens anpassen. Keine Verbotslisten, keine Aussagen zur Designqualität [V] | ca. 6,4k, ISC |
| [superdesigndev/superdesign](https://github.com/superdesigndev/superdesign) | Design-Agent als IDE-Erweiterung von 2025, erzeugte Mockups und Wireframes aus Prompts. **Nicht mehr gepflegt**: Das Produkt ist jetzt die Web-App superdesign.dev, für Coding-Agenten verweist das README auf `superdesign-skill` [V] | ca. 7,6k, Lizenz ohne SPDX-Zuordnung |

Widerlegt [X]: Die Listicle-Angaben auf theaileverage.beehiiv.com (Impeccable „25k Sterne, 23 Befehle“, Taste Skill „15.4k“, Angaben zu UI/UX Pro Max) sind veraltet oder falsch. Ebenso widerlegt: superdesign arbeite im Kern mit parallelen Varianten und Forks (0-3) und ein Impeccable-Stand von 67.876 Sternen am 14.09.2026 (1-2, Sekundärquelle). Zahlen aus Sekundärlisten immer am Repo prüfen.

Erfahrung aus der Praxis (r/webdesign): Solche Repos sind „nice to have, kein Game Changer“. Den Unterschied macht der Prozess (A1). [A]

### B6. Was die Repos gemeinsam haben und wo sie sich widersprechen
**Beleg:** [T]. Die Einzelaussagen sind [V], der Vergleich ist eine eigene Ableitung aus Welle 4.

**Was immer wieder vorkommt**
1. **Tell-Listen.** Anthropic, Impeccable, avoid-ai-design und pixelslop teilen einen Kern: Inter für alles, Lila-Blau-Verläufe und Verlaufstext, gleiche abgerundete Karten mit gleichem weichem Schatten, Versal-Eyebrows, dekorative 01/02/03, grauer Text auf Farbe bzw. zu wenig Kontrast. Das deckt sich mit [02, Abschnitt 2](02-ai-slop-erkennen-und-vermeiden.md#2-merkmale-erster-ordnung-die-klassischen-tells).
2. **Briefing vor dem Code.** Anthropics Ablauf aus Plan, Prüfung, Code und Kritik, die DESIGN.md-Dateien von VoltAgent und Google, Impeccables `init`/`document`. Das entspricht A1 und A2.
3. **Deterministische Prüfung ohne LLM**, als Hook oder CI-Gate: `impeccable detect`, `detect.mjs`, `design.md lint`. Dasselbe Prinzip nutzt der Slop Detector dieser Sammlung ([README.md](README.md)).
4. **Rückmeldung von der gerenderten Seite:** Impeccables URL-Modus und Chrome-Erweiterung, pixelslop mit Playwright. Siehe A4.
5. **Kritik-Befehle:** Impeccables `critique` und `audit`, Anthropics Kritikschritt.

**Wo sie sich widersprechen**
- **Auswählen oder verbieten.** ui-ux-pro-max, das 21st-Register und die Marken-DESIGN.md-Dateien geben dem Agenten einen Katalog, aus dem er wählt. Anthropic und avoid-ai-design verbieten Defaults und verlangen eine Wahl, die aus dem Briefing folgt. Ein Katalog erzeugt neue gemeinsame Defaults, sobald viele Projekte ihn nutzen. [F]
- **Second-Order-Defaults.** avoid-ai-design warnt: Wer Lila-Verläufe verbietet, bekommt Creme mit Terrakotta (den Claude-Look), Fast-Schwarz mit Säuregrün, Broadsheet-Optik und „geschmackvolle Gratisschriften“ wie Space Grotesk, Geist, Instrument Serif und Fraunces. Die Farb- und Chrome-Cluster stammen nachweislich aus Anthropics Skill, der aber keine dieser Schriften nennt. ui-ux-pro-max *empfiehlt* Space Grotesk in mehreren Paarungen (Tech-Startup, minimalistisches Portfolio, Neo-Brutalismus, Web3). Was das eine Repo empfiehlt, markiert das andere als Tell. [V]

**Übertragbar:** Eine Schrift oder Farbe ist nie an sich Slop. Entscheidend ist, ob sie aus dem Briefing begründet ist (siehe [02, Abschnitt 4](02-ai-slop-erkennen-und-vermeiden.md#4-warum-verbotslisten-allein-nicht-reichen)). Kataloge eignen sich als Ausgangspunkt, nicht als Ergebnis.

### B7. Sterne mit Vorsicht lesen
**Beleg:** [V] für die Zahlen, Hinweise ohne Beweis für Manipulation.

- **awesome-design-md** kam in etwa 7 Monaten auf rund 126k Sterne, für eine Sammlung von Markdown-Dateien. Das README wirbt mit „Ranked #150 globally on GitHub“, verkauft über getdesign.md bezahlte Aufträge und hat ein Sponsorenbanner.
- **Impeccable** kam in etwa 12 Monaten auf rund 104k Sterne.
- **superdesign** bittet im README um Upvotes auf Hacker News.
- **anthropics/skills** hat rund 188k Sterne, aber für das ganze Repo, nicht für frontend-design.

Eine Auswertung der Sternverläufe war nicht möglich, weil der Stargazers-Endpunkt 404 lieferte. Die Punkte oben sind also Warnzeichen, kein Nachweis gekaufter Sterne. Für die Auswahl zählt, was ein Repo technisch tut. Die Sternzahl misst Aufmerksamkeit, nicht Wirksamkeit.

---

## C. Ungewöhnliche und kreative Ansätze

### C1. Zufall statt Geschmack
**Quelle:** Taste Skill. **Beleg:** [V] für den Mechanismus (im Code bestätigt), [A] für die Wirkung.

`scripts/start.mjs` teilt per gewichtetem Zufall drei Paletten und drei Google-Fonts-Paarungen zu. Sie passen zur Seitenart und unterscheiden sich bewusst vom zuletzt genutzten Set. Der Agent wählt daraus und schreibt das Ergebnis als `:root`-Tokens, bevor Markup entsteht. `deal.mjs` teilt eines von 11 geprüften Hero-Layouts zu (split, centred, product, photo, place, collage, editorial, word, film, statement, triptych). Violett ist verboten: „never violet: deal again“.

Effekte hängen von der Branche ab. Shader, WebGL und Scroll-Szenen sind nur bei Software, Tech und Gaming erlaubt, mit höchstens 4 WebGL-Kontexten und statischen Fallbacks. Cafés, Hotels, Läden und Dienstleister bekommen keine Effekte.

**Übertragbar:** Du kannst das ohne den Skill nachbauen. Lege eine kuratierte Liste von 10–20 geprüften Paletten und Schriftpaaren an, lass ein Skript eine Kombination ziehen und schreib das Ergebnis vor dem ersten Prompt in `DESIGN.md`. So kommt die Variation aus deiner Liste und nicht aus dem Modell.

### C2. Persona- und Rollen-Prompts
**Beleg:** [V] als Vorgehen im Anthropic Skill, [A] für die Wirkung.

Der Anthropic Skill beginnt mit einer Rolle: Design Lead eines Studios, dessen Kunde templatehafte Entwürfe bereits abgelehnt hat und für einen eigenen Standpunkt bezahlt. In der Community kursieren ähnliche Rollen wie „Art Director“ oder ein strenger „Design-Kritiker“ als separater Subagent.

### C3. Eng gefasste Themen statt offener Freiheit
**Quelle:** r/ClaudeAI. **Beleg:** [A]

„70er-Sci-Fi-Kontrollraum, Monospace, Bernstein auf Schwarz, keine abgerundeten Ecken“ liefert ein eigenständigeres Dashboard als „design a dashboard“. Kombinierte Referenzen wie „Bloomberg-Dichte plus skandinavischer Magazin-Weißraum“ funktionieren besser als Adjektive.

Vorsicht [F]: Gerade „Terminal-Ästhetik“ und „Fast-Schwarz mit einem Akzent“ gehören inzwischen selbst zu den Second-Order-Defaults (siehe [02, Abschnitt 3](02-ai-slop-erkennen-und-vermeiden.md#3-merkmale-zweiter-ordnung)). Ein Thema hilft nur, wenn es aus dem Fachgebiet kommt.

### C4. Temperatur pro Subagent
**Quelle:** r/ClaudeAI. **Beleg:** [A], Einzelmeinung und nicht an UI-Ergebnissen geprüft.

Höhere Temperatur für einen Ideen-Subagenten, niedrige für die Umsetzung. Laut Kommentator geht das in OpenCode, in Claude Code nicht.

### C5. Notizen über frühere Entwürfe
**Quelle:** Anthropic Skill. **Beleg:** [V] als Empfehlung.

„Human creatives have memory and always try to do something new.“ Ein Notizbereich darüber, was in früheren Durchgängen probiert wurde, hilft, nicht in dieselben Lösungen zurückzufallen. Praktisch heißt das: In `DESIGN.md` einen Abschnitt „Bereits verworfen“ führen.

### C6. Slop messen statt bewerten
**Quelle:** adriankrebs.ch, „Design slop“ (April 2026). **Beleg:** [A], eigene Datenerhebung des Autors.

Der Autor hat mit seinem Tool slopcop rund 1.590 aktuelle Show-HN-Landingpages gegen 16 Muster geprüft: 22 % hatten 4 oder mehr Muster, 32 % hatten 2–3, 46 % hatten 0–1. Die Checkliste stammt von Designern. Sie nennt unter anderem ein Badge über der H1, farbige obere oder linke Kartenrahmen, nummerierte 1-2-3-Schritte, Stats-Banner und permanenten Dark Mode mit wenig Kontrast.

**Übertragbar:** Eigene Seiten regelmäßig mit einem Detektor scannen und die Zahl der Muster als Kennzahl verfolgen. pixelslop schlägt eine Skala vor: 0–1 CLEAN, 2–3 MILD, 4–6 SLOPPY, ab 7 TERMINAL.

---

## D. Debatten

| These | Wer | Beleg |
|---|---|---|
| Generik ist das neue Bootstrap und bei B2B-Dashboards in Ordnung. | HN-Nutzer | [A] |
| „Zählt es überhaupt, wenn man es nicht erkennt?“ | HN-Nutzer | [A] |
| Das Problem sind die Defaults, nicht die Tools. Tailwind und shadcn beschleunigen und sorgen für Konsistenz. | designsystemscollective.com (Medium) | [A] |
| Der shadcn-Look entsteht allein durch nicht angepasste Defaults. | annaarteeva.substack | [X] 0-3 widerlegt, weil zu absolut. Geometrie, Komponentenmuster und Layoutreflexe spielen mit. |
| Für Demos und Prototypen ist generisches Design unproblematisch („nobody cares“). | r/ProductManagement | [A] |
| Inter ist nicht schlecht. Der Tell ist, dass niemand die Schrift gewählt hat. | 925studios | [A], deckt sich mit [V] avoid-ai-design und pixelslop |
| Das Drei-Karten-Muster aufzubrechen ist der wirksamste Einzelschritt. | 925studios, anti-slop-design | [A] |

---

## E. Lücken in dieser Sammlung

Diese Punkte ließen sich nicht verifizieren oder nicht abrufen:

- Vergleiche, ob v0, Lovable, Bolt oder Windsurf weniger Slop erzeugen. Reddit-Threads dazu waren nur über Mirrors erreichbar und lieferten keine prüfbaren Aussagen.
- Eine Bewertung von Magic UI und Aceternity. Einzige Spur: „Standard-Effekte von Aceternity/Magic UI“ gelten als Tell, tweakcn wurde als Hilfsmittel empfohlen. [A] Zu 21st.dev siehe B5, Gruppe 4.
- Die UI-Vorgaben in den veröffentlichten bzw. geleakten Systemprompts von v0, Lovable, Bolt und Emergent (Sammlung [x1xhlol/system-prompts-and-models-of-ai-tools](https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools)) sowie die Design-Einträge in awesome-cursorrules, awesome-claude-code und awesome-claude-skills. Abgerufen, aber in Welle 4 nicht verifiziert. Ob die Prompts echt und aktuell sind, lässt sich nicht prüfen.
- Vorher-Nachher-Blindtests. Es gibt nur Selbstauskünfte, etwa avoid-ai-design: „vorher 23 Tells, danach 0“ auf einer einzigen Demo-Seite.
