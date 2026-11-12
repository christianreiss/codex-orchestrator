# AI Slop in UI und UX erkennen und vermeiden

Stand: 06.11.2026. Markierungen siehe [00-README.md](00-README.md#legende).

„AI Slop“ meint hier eine Oberfläche, deren Gestaltung niemand gewählt hat. Das Modell hat Defaults übernommen, und genau das sieht man. Ein einzelnes Merkmal beweist nicht, dass KI im Spiel war. Inter oder ein dunkles Theme sind für sich genommen legitim. Zum Problem wird es erst, wenn mehrere unbewusst übernommene Defaults zusammenkommen. [V] (avoid-ai-design, pixelslop-Katalog)

Wichtigste Einschränkung vorab: Keine der gefundenen Quellen hat gemessen, ob Negativlisten, Skills, Zufallspaletten oder Linter Slop tatsächlich reduzieren. Belegt ist, was die Werkzeuge tun. Dass sie wirken, beruht auf Selbstauskünften und Einzelberichten.

---

## 1. Ursache

### 1.1 Distributionale Konvergenz [V], Mechanismus nicht empirisch belegt

Anthropic erklärt den Effekt so: Ohne Vorgaben zieht das Modell aus der wahrscheinlichsten Mitte seiner Trainingsdaten. Dort dominieren „sichere“ Designentscheidungen. Zitat: *„Safe design choices – those that work universally and offend no one – dominate web training data. Without direction, Claude samples from this high-probability center.“* (claude.com, 12.11.2025)

Bestätigt ist, dass Anthropic das sagt. Den Mechanismus selbst belegt diese Quelle nicht: Es ist ein Produktartikel, keine Studie.

### 1.2 Die Tailwind-Indigo-Linie [T]

Mehrere Blogs führen das Lila/Indigo auf Tailwind UI zurück, wo jeder Button `bg-indigo-500` hatte. Tailwind-Erfinder Adam Wathan soll sich dafür im August 2025 öffentlich entschuldigt haben. Diesen Tweet haben die Quellen zitiert, aber nicht unabhängig geprüft. (dev.to/alanwest, prg.sh, 925studios)

### 1.3 Rückkopplung [A], Hypothese ohne Daten

Veröffentlichte KI-Seiten wandern zurück in spätere Trainingsdaten und verstärken den Default weiter. Nach dieser Hypothese verbessern bessere Modelle die Ausführung, machen sie aber nicht eigenständiger. (925studios, dev.to/alanwest)

### 1.4 Statischer Code statt Verhalten [A]

Modelle lernen aus Quelltext, nicht aus der Bedienung. Validierung, Fehlerzustände und Barrierefreiheit fehlen deshalb häufig und müssen nach der Generierung gezielt geprüft werden. (prg.sh) Das passt zum Bericht, dass „mach es anders“ nicht reicht: Das Modell begründet überzeugend, warum es bei denselben sicheren Entscheidungen bleibt. (HN, Nutzer Wpnx330)

### 1.5 Der Code im Repo wiegt schwerer als der Prompt [A]

Ein unverändertes shadcn/ui-Setup erzeugt den Einheitslook. Ein committetes Theme aus CSS-Variablen in einer Datei, die das Tool liest, wirkt stärker als jede Prompt-Anweisung. (13labs.au) Ein Reddit-Kommentator verallgemeinert: KI-Coding funktioniert besser, wenn ein von Menschen gemachtes Artefakt die Konventionen vorgibt, weil das Modell strukturell schwach darin ist, selbst Vorannahmen zu setzen. (r/ChatGPTCoding)

---

## 2. Merkmale erster Ordnung (die klassischen Tells)

Diese Liste ist breit bestätigt: Vier unabhängige Kataloge nennen weitgehend dieselben Muster. Übereinstimmend belegt ist die Liste, nicht ihre Wirkung. [V]

### Typografie
- Inter, Roboto, Arial oder `system-ui` für alles, ohne dass jemand die Schrift gewählt hat. [V]
- Flache Hierarchie, also kaum Unterschied zwischen Größen und Gewichten. [V] (Impeccable)
- Fließtext zu klein, Zeilen zu lang. [V] (Impeccable)

### Farbe
- Lila-Blau- bzw. Indigo-Violett-Verläufe, typischer Bereich `#7c3aed` → `#3b82f6`. [V]
- Verlaufstext in Überschriften (`bg-clip-text text-transparent`). [V]
- Cyan auf Dunkel, Dark Mode mit leuchtenden Akzenten und Glows. [V] (Impeccable, pixelslop)
- Grauer Text auf farbigem Grund, reines `#000`/`#fff`. [V] (Impeccable)
- Eine zaghafte, gleichmäßig verteilte Palette ohne dominante Farbe. [V] (Anthropic)

### Layout und Komponenten
- Hero, dann drei gleich breite, abgerundete Feature-Karten mit Icon oben. Mehrere Quellen nennen das das häufigste Einzelmuster. [V]
- Karten in Karten. [V]
- Eine Icon-Kachel (abgerundetes Quadrat) über jeder Überschrift. [V] (Impeccable)
- Seitlicher Akzentstreifen an Karten (`border-left: 4px`). [V]
- Alles zentriert. Der pixelslop-Schwellwert: mehr als 70 % von mehr als 4 Überschriften und Absätzen zentriert. [A]
- Jeder Button sieht aus wie ein Primary-Button. [A] (pixelslop)
- „Hero Metric“: große Zahl, kleines Label, Stats-Zeile, Verlaufsakzent. [V] (Anthropic Skill, pixelslop)
- Standard-Abfolge Hero, Feature-Grid, Social Proof, Pricing, FAQ, Footer. [A] (dev.to/alanwest)
- Reflexhaftes `rounded-2xl shadow-lg p-6` überall. [A]
- Glassmorphism mit Glow-Schatten, 1px-Rahmen mit 40px Schatten-Blur. [A] (pixelslop, HN)

### Bewegung
- Fade-and-slide-up auf jeder Sektion, Hover-Transitions auf jeder Karte. [V] (Anthropic Skill, GitHub-Stand #1713)
- Bounce- oder Elastic-Easing, Transitions auf Layout-Eigenschaften. [V] (Impeccable)

### Icons und Texte
- Emojis als UI-Icons, auch in Navigation und Überschriften. [V]
- Austauschbare Hero-Sätze („Ship faster than ever“, „Build faster. Ship smarter.“), ein blauer „Get Started“-Button. [V]
- Sätze, die mit „Empower“, „Unlock“ oder „Transform“ beginnen; abstrakte Feature-Titel aus zwei Substantiven. [A] (dev.to/alanwest)
- Überflüssige Beschreibungstexte zu offensichtlichen UI-Elementen, Gedankenstriche im Fließtext. [A] (HN)
- Lorem ipsum, erfundene Testimonials und Hausnummern. [V] (anti-slop-design, Taste Skill)

### Funktionale Tells, die oft übersehen werden
- Fehlende Lade-, Leer- und Fehlerzustände. [V] als Prüfpunkt in mehreren Skills
- Buttons ohne Wirkung, Formulare ohne Validierung. [A]
- Zu kleine Klickziele, fehlender Fokusring. [V] (WCAG 2.2, siehe 01-grundlagen)
- Interaktionen, die nur per Hover erreichbar sind; horizontaler Overflow auf Mobilgeräten. [A] (besthub.dev)

---

## 3. Merkmale zweiter Ordnung

Das ist die wichtigste Erkenntnis dieser Recherche. Wer nur verbietet oder „mach es weniger KI-artig“ sagt, bekommt das nächste Klischee. [V] (Anthropic Skill #1713, avoid-ai-design, capitalandcompute.net)

Anthropics `frontend-design`-Skill (GitHub-Stand nach PR #1713, gemergt am 03.09.2026) nennt Inter und Lila nicht mehr namentlich. Er beschreibt stattdessen diese fünf Cluster:

1. Warmer Creme-Hintergrund (um `#F4F1EA`) mit kontrastreicher Serifen-Display-Schrift und einem Terrakotta- oder Tonakzent (oft um `#D97757`). Laut Skill ist das Anthropics eigener Claude-Akzent, der auf einem fremden Briefing deshalb als Tell gilt.
2. Fast-Schwarz mit einem einzigen grellen Akzent in Acid-Grün oder Zinnober.
3. Broadsheet-Layout: Haarlinien, Radius 0, dichte Zeitungsspalten.
4. Das SaaS-Card-Kit: identische abgerundete Karten, ein Radius für alles, derselbe Schatten `rgba(0,0,0,.1)`, Verläufe als Deko.
5. Template-Chrome: Versal-Eyebrow über jeder Überschrift, Metazeilen „A · B · C“, Labels als „WORT — Fragment“, getöntes Fast-Schwarz (`#0B0B0B`, `#111`), Monospace für kleine Datenlabels, „→“ an Links und Buttons.

Dazu kommen drei typografische Tells: ein einzelnes hervorgehobenes Wort in der Headline, Versal-Labels und überflüssige Labels über dem Inhalt. Außerdem die Nummerierung 01/02/03, wenn der Inhalt gar keine Abfolge ist.

Auch „geschmackvolle“ Gratisschriften gelten inzwischen als Tell: Space Grotesk, Geist, Instrument Serif, Fraunces. [T] (avoid-ai-design, adriankrebs.ch) Anthropic berichtete schon im November 2025, dass das Modell auch mit Anti-Slop-Anweisungen über mehrere Generierungen auf dieselben Ersatzschriften zurückfällt, etwa Space Grotesk. [V]

Für die Praxis heißt das: Eine Verbotsliste veraltet von selbst. Sie muss eine Richtung ergänzen, sie kann sie nicht ersetzen.

---

## 4. Warum Verbotslisten allein nicht reichen

| Problem | Beleg |
|---|---|
| Eine Verbotsliste verschiebt den Default nur, sie erzeugt keinen Look. Regeln entfernen Defaults, eine Richtung schaffen sie nicht. Beides sind getrennte Aufgaben. | [V] capitalandcompute.net |
| „Pink-Elephant“-Effekt: Ein Verbot macht das verbotene Muster erst präsent. Anthropic rät allgemein zu positiven Anweisungen. | [T] |
| Verbote werden trotzdem verletzt, etwa Sternebewertungs-Widgets mit fünf gelben Sternen trotz Verbot. | [A] anti-slop-design (Autor) |
| Tokens allein reichen nicht. Agenten kennen die Tokens und hartcodieren trotzdem Werte. | [A] 13labs.au |
| In langen Sessions driftet der Agent von den Regeln ab. | [A] robotsonpayroll |

---

## 5. Gegenmaßnahmen, nach Wirkungsebene sortiert

Die Reihenfolge ist wichtig. Jede Ebene fängt ab, was die vorherige durchlässt.

### Ebene 1: Richtung festlegen, bevor Code entsteht

**Fachbezug statt Stilliste.** [V] Anthropic Skill: Die Gestaltung kommt aus der Welt des Produkts, also aus seinen Materialien, Werkzeugen, Artefakten und seiner Fachsprache. Beispiel aus dem Skill: Ein Spielzeug für Mädchen von 8 bis 11 Jahren sieht anders aus als ein Dashboard für Finanzanalysten.

**Zwei Durchgänge.** [V] Anthropic Skill:
1. Ein kompakter Plan: 4–6 benannte Hex-Farben, Schriften mit Rollen, Layoutkonzept mit ASCII-Wireframe und Ausrichtung, Prinzipien.
2. Den Plan gegen das Briefing prüfen. Die Testfrage: Würde ich bei einem ähnlichen Prompt genauso landen? Wenn ja, diesen Teil überarbeiten und begründen. Erst danach Code schreiben.

**Richtung vor Code, nach der anti-slop-design-Skill.** [V]
- Register festlegen: Brand (Marketing) oder Product (Werkzeug).
- Eine benannte Tonalität wählen, nie „modern and clean“.
- Hell oder Dunkel aus einem Satz zur Nutzungsszene ableiten, nicht aus der Produktkategorie. „SRE schaut um 2 Uhr nachts im dunklen Raum auf Incident-Schwere“ erzwingt laut Skill Dark Mode. „Kategorie Observability“ erzwingt nichts. Diese Sammlung liest das enger: Das Theme folgt der Wahl der Nutzer bzw. der Systempräferenz, die Szene bestimmt höchstens den Default.
- Ein einziges einprägsames Element. Diese Sammlung behandelt es als optional, auch im Brand-Register.
- **Category-Reflex-Check**: Lässt sich die Palette allein aus dem Kategorienamen erraten (Healthcare: Teal auf Weiß, Fintech: Navy und Gold), ist das Ergebnis laut Skill polierter Slop. Der Check bleibt eine Frage, keine automatische Neuwahl: Eine vorhandene Identität und Markenfarben sind oft richtig.

**Konkrete Referenz statt Adjektiv.** [A], vielfach genannt. Prompts wie „modern and clean“ oder „make it look nice“ erzeugen uneinheitliche, generische Ergebnisse. Besser sind:
- Ein reales Produkt als Referenz, etwa „Stripe-Dashboard“, „eher Linear oder Vercel als ein Template“.
- Kombinierte Referenzen, etwa „Layoutdichte des Bloomberg-Terminals plus Weißraum eines skandinavischen Magazins“.
- Eng gefasste Vorgaben statt offener Freiheit: „70er-Sci-Fi-Kontrollraum, Monospace, Bernstein auf Schwarz, keine runden Ecken“ statt „design a dashboard“.
- Vorsicht: Auch „Apple-like“ erzeugt gleichförmige Apps. (r/ClaudeAI)

**Prompt-Muster „Default, dann Constraint“.** [V] als Muster, Reihenfolge nur aus einer Quelle. Zuerst die zu vermeidenden Defaults benennen, dann eine konkrete positive Referenz geben. Ohne positive Referenz kommen die Second-Order-Defaults aus Abschnitt 3.

### Ebene 2: Die Richtung dauerhaft im Repo verankern

**DESIGN.md als einzige Quelle.** [A], mehrfach unabhängig empfohlen. Farben mit Hex und Rolle, Schriften, Typo-Skala, Abstände, Radien, Schatten, Komponentenregeln, Do- und Don't-Regeln. Wo die Datei hingehört:

| Tool | Ort für dauerhafte Anweisungen |
|---|---|
| Claude Code | Verweis in `CLAUDE.md` mit der Anweisung, die Datei für alle UI-Arbeiten zu befolgen; alternativ als Skill |
| Cursor | Always-on Rule (`.cursor/rules/*.mdc`) |
| Lovable | Project Settings > Knowledge, max. 10.000 Zeichen (Stand Nov. 2026) [T] |
| Bolt | Project Knowledge [T] |
| Replit | `replit.md` |
| v0 | heißt 2026 eher „Instructions“ bzw. „Design Systems“; die Bezeichnung „Knowledge“ ist dort vermutlich veraltet [T] |

Quelle: robotsonpayroll.substack.com, annaarteeva.substack.com, kent-tokyo (dev.to). Der Inhalt sollte direkt in der Datei stehen. Ob verlinkte Brand-Dokumente tatsächlich gelesen werden, ist ungetestet. [T]

Lovable liest Tokens nur aus Dateien auf oberster Ebene, nicht aus komponentenlokalen Stylesheets. [A] (13labs.au)

**Defaults an der Quelle ersetzen.** [V]/[T]
- shadcn/ui, Radix, MUI: Die Richtung auf semantische Tokens abbilden (`--primary`, `--background`, `--muted`, `--radius`) und zuerst im Theme- bzw. CSS-Variablen-Layer überschreiben. Komponenten nur forken, wenn das Layout es erfordert. [V] (anti-slop-design)
- Tailwind v4: `@theme` bzw. Token-Dateien passend zu `globals.css`, keine parallele Palette. [V]
- Strittig: In Tailwind v3 den `colors`-Key ersetzen statt erweitern, sodass `bg-indigo-600` gar nicht mehr gebaut wird (1-2 Stimmen). Das Prinzip ist nachvollziehbar, aber umstritten. [T]/[X] Wenn du es nutzt, achte darauf, dass dann auch neutrale Grautöne und Statusfarben fehlen, die du selbst definieren musst.
- Geometrie und Dichte (Radius, Datendichte, Typo-Skala) prägen den generischen Eindruck stärker als die Farbe. Nur die Farbe zu tauschen reicht nicht. [A] (13labs.au)
- Ausdrückliche Verbote in den Regeln: keine rohen Hex-Werte, kein `text-white`/`bg-black`, keine einmaligen Abstandswerte, Imports nur aus dem eigenen Komponentenverzeichnis. [A] (13labs.au)

**Komponentensystem vor der ersten Seite.** [A] Typografie, Farben, Abstände, Schatten, Rahmen, Buttons, Inputs, Karten. Ohne dieses System „verhunzt die KI Komponenten irgendwann“. Ein Reddit-Freelancer berichtet das aus 10 Kundenseiten in 4 Monaten. Kommentatoren werfen dem Post Werbung für uicraft vor. (r/webdesign) Ein anderer Kommentator meint, die Festlegung auf ein einziges Designsystem sei wichtiger als dessen Qualität. (r/ChatGPTCoding)

### Ebene 3: Deterministische Prüfung (Linter, Hooks, CI)

Werkzeuge, deren Funktion am README bzw. Quellcode geprüft ist [V] (Wirksamkeit nicht unabhängig gemessen):

| Werkzeug | Was es tut | Einbindung |
|---|---|---|
| **Impeccable** (`npx impeccable detect`) | 62 deterministische Regeln (v4.8.0, Stand 26.10.2026), kein LLM. JSX/TSX bekommen nur Musterregeln, Kontrast und kleine Schrift nur beim URL-Scan. | CLI, `--json`, Exit-Code 2 bei Funden, Hook, CI |
| **avoid-ai-design** (`scripts/detect.mjs`) | Tells nach P0/P1/P2, ohne Abhängigkeiten, Node 18+, kein Modellaufruf (laut README 67 Tells, in Welle 4 nicht bestätigt) | Exit-Code 2 bei P0/P1; PostToolUse-Hook in Claude Code (Matcher `Edit\|Write\|MultiEdit`) |
| **Taste Skill** (`consistency.mjs`) | Rendert bei 1440/1024/768/390 px, über 100 Browser-Checks: leere Visuals, Kontrasteinbrüche, Platzhaltertext, erfundene Hausnummern | Vor der Übergabe durch den Agenten |
| **pixelslop** | Playwright bei 3 Viewports, berechnete Styles statt CSS-Lesen, 5 Säulen, Score CLEAN/MILD/SLOPPY/TERMINAL; 26 visuelle und 16 Quelltext-Muster | Skill mit Fix-Schleife und Rollback |
| **slopcop** (Adrian Krebs) | 16 Muster per Playwright-DOM-Check; laut Autor 5–10 % Falsch-Positive | Analyse von 1.590 Show-HN-Seiten: 22 % mit 4 oder mehr Mustern [A] |
| **design.md lint** (Google, `@google/design.md`) | Prüft die DESIGN.md selbst: 11 Regeln, u. a. Kontrast unter 4,5:1, kaputte Token-Verweise, fehlende Primärfarbe, Abschnittsreihenfolge; `diff` erkennt Verschlechterungen | CLI, Exit 1 bei Verschlechterung; siehe [03, B5](03-community-howtos-und-ideen.md#b5-die-repo-landschaft-auf-github-stand-06112026) |
| **Eigene ESLint- bzw. grep-Regel** | Verbotene Klassen (Indigo/Violett-Buttons, `rounded-2xl`/`3xl`, Lila-Blau-Verläufe) | CI schlägt fehl. Ein Team berichtet, danach die eigenen Tokens genutzt zu haben, weil Defaults nicht mehr kompilierten [A] |

Der Hook ist der wichtigste Hebel, denn „ohne Hook läuft der Detektor nur, wenn jemand daran denkt“. (Impeccable-Autor) [A] Vorlagen dazu: [templates/claude-settings-hook.json](templates/claude-settings-hook.json), [templates/slop-grep.sh](templates/slop-grep.sh).

Linter erkennen nur Muster, die im Code oder gerendert sicher erkennbar sind. Geschmack, Hierarchie und Passung zum Briefing erkennen sie nicht. Bewusst gewählte Ausnahmen, etwa ein Markenverlauf, bekommen einen Ignore-Kommentar. [V]

### Ebene 4: Visuelle Selbstkontrolle

- **Screenshot-Schleife.** Der Agent rendert die Seite, macht Screenshots (Playwright-MCP oder Browser-MCP), vergleicht sie mit Referenz oder Plan, listet die Unterschiede auf und behebt sie erst dann. [V] Anthropic Skill: „a picture is worth 1000 tokens“. Mehrere Erfahrungsberichte bestätigen das. [A]
- **Pro Runde nur 2–3 visuell prüfbare Änderungen.** Komponente für Komponente bauen und bestätigen statt alles in einem Durchgang. [A] (kent-tokyo)
- **Viewports.** 1440, 1024, 768, 390 px; bei 320 px kein horizontales Scrollen. [A]/[F]
- **Reverse-Squint-Test.** Einen frischen Chat fragen, welcher AI-Builder den Screenshot erzeugt hat. Fällt die Antwort leicht, gilt die Seite in der Quelle als Slop. [A] Hier ist das ein Experiment zur Diagnose, nie ein Abnahmetest: Die geratene Herkunft sagt nichts über die Qualität.
- **Schwarz-Weiß-Silhouette.** Den Screenshot entsättigen und prüfen, ob die Hierarchie ohne Farbe trägt. [A] (avoid-ai-design)
- **Chanel-Regel.** Vor dem Abschluss ein Accessoire entfernen. [V] (Anthropic Skill) Als Prüffrage gelesen: Dient jedes Element dem Briefing? Entfernt wird nur, was die Oberfläche dadurch besser macht. Ein Pflicht-Entfernen ist keine Abnahme.

Ein statischer Screenshot prüft keine Zustände (Login, fehlende Rechte, Netzwerkfehler). Kritische Abläufe müssen in einem echten Browser durchgespielt werden. [A] (besthub.dev)

### Ebene 5: Funktion und Barrierefreiheit testen

- axe-core über Playwright, für **jeden Zustand** einzeln: Menü offen, Dialog offen, Formular mit Fehlern. `AxeBuilder.analyze()` prüft nur den Zustand zum Aufrufzeitpunkt. [V]
- Ein grüner axe-Lauf belegt keine Barrierefreiheit. Deque schätzt, dass automatisierte Tests etwa 57 % der Probleme nach Anzahl finden. [V]
- Zustandsmatrix testen: Daten vorhanden, keine Daten, lädt, keine Suchtreffer, Paginierung, fehlende Rechte, leeres Absenden, Inline-Fehler, Doppelklick auf „Speichern“ während des Speicherns. [A] (besthub.dev)
- Vorlage: [templates/a11y-and-states.spec.ts](templates/a11y-and-states.spec.ts).

### Ebene 6: Texte

[V] Anthropic Skill (#1713), [A] dev.to/alanwest:
- Aus Sicht der Nutzer formulieren: „Benachrichtigungen verwalten“ statt „Webhook-Konfiguration“.
- Aktiv formulieren und die Handlung benennen: „Änderungen speichern“ statt „Absenden“.
- Eine Aktion heißt im ganzen Ablauf gleich: Button „Veröffentlichen“, Toast „Veröffentlicht“.
- Fehlermeldungen entschuldigen sich nicht und sind nie vage. Sie sagen, was passiert ist und wie man es behebt.
- Ein leerer Bildschirm ist eine Einladung zum Handeln.
- Satzanfänge mit „Empower/Unlock/Transform“ vermeiden, mindestens eine konkrete Zahl nennen, den Text vor dem Ausliefern laut vorlesen.
- Ein Freelancer schreibt Texte grundsätzlich nicht mit KI. [A]

---

## 6. Gegenkorrektur: nicht übersteuern

- Gegen Slop hilft nicht, zufällige Ornamente, Novelty-Schriften oder einmaliges visuelles Chaos einzubauen. [A] (claudskills audit-ai-frontend)
- Kühnheit an genau einer Stelle einsetzen, alles andere ruhig und diszipliniert halten. [V] (Anthropic Skill)
- Erst die Fehler beheben, dann den Look. P0 sind objektive Mängel: Tastaturbedienung, Labels, Kontrast, Klickziele, mobiler Overflow, fehlende Zustände. P1 sind die Generik-Tells. [A] (claudskills audit-ai-frontend)
- Jeder Fund sollte eine mögliche Nicht-KI-Erklärung, den kleinsten Fix und ein Abnahmekriterium nennen. „Wirkt KI-artig“ ist ein Qualitätsgeruch, keine Aussage über die Herkunft. [A]

---

## 7. Wann ist generisches Design in Ordnung?

Es gibt keine verifizierte Grenze, aber eine erkennbare Tendenz in der Community [A]:

| Kontext | Haltung |
|---|---|
| Interne Admin-Tools, Backoffice | Weitgehend akzeptiert. „Für interne Admin-Tools reicht Claude Code ohne Zusatz“ (superdesign.dev, Anbieterblog). Konsistenz und Bedienbarkeit wichtiger als Eigenständigkeit. |
| B2B-SaaS-Dashboards | Gespalten. Ein HN-Nutzer vergleicht den Einheitslook mit einem „neuen Bootstrap“ und findet ihn akzeptabel. |
| MVPs, Prototypen, Side Projects, Demos | Akzeptiert (prg.sh, r/ProductManagement, r/ChatGPTCoding). |
| Produkte, die sich abheben müssen; Landingpages; Marketing | Hier ist Slop ein Markenproblem. |
| Generell | „Uninspiriert, nicht schädlich“. Generische Seiten vor der KI sahen aus wie Bootstrap-Templates. Der Unterschied liegt zwischen gestaltetem Design und ausgelieferten LLM-Defaults. (adriankrebs.ch) |

Ein Vorschlag zur Abgrenzung [F]: Bei Produkt-UIs sind die **funktionalen** Tells (fehlende Zustände, Kontrast, Klickziele, tote Buttons, inkonsistente Abstände) nie in Ordnung. Die **visuellen** Tells (Inter, shadcn-Standardlook) sind bei internen Werkzeugen tolerierbar, solange sie konsistent sind und durch Tokens gesteuert werden.
