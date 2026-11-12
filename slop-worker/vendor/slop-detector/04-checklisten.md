# Checklisten

Stand: 06.11.2026. Zum Abhaken im Review, im PR-Template oder als Abnahme durch den Agenten. Die Belege stehen in den Dateien 01–03.

Reihenfolge der Prüfung: **P0 zuerst.** Objektive Mängel wiegen schwerer als Geschmacksfragen. P0 ist Pass/Fail: Barrierefreiheit, Zustände, Funktion und Wahrhaftigkeit. P1 und P2 sind visuelle Urteile, jeder Fund braucht eine Begründung. Weder ein Tell-Zähler noch ein Detektor-Score ersetzt die Abnahme.

**Vorrang bei Widersprüchen** (überall gleich anwenden):
1. Zugänglichkeit, Wahrhaftigkeit, Aufgabenerfolg
2. Plattformkonventionen und Nutzerpräferenzen
3. bestehendes Produkt- und Design-System
4. dokumentierter, bewusster Ausdruck
5. heuristische Hinweise wie Tells und Squint-Tests

Kein Check gilt als bestanden, nur weil „bewusst gewählt“ dabeisteht. Eine Stilbegründung ist nie eine Ausnahme für Täuschung oder für anwendbare A11y-Anforderungen.

---

## 1. Vor dem ersten Prompt (Richtung)

- [ ] Gegenstand, Zielgruppe und die eine Aufgabe der Seite sind in einem Satz benannt.
- [ ] Register gewählt: Brand oder Product.
- [ ] Die Tonalität ist benannt, und zwar nicht mit „modern and clean“.
- [ ] Der Theme-Default (hell oder dunkel) folgt aus einem Satz zur Nutzungssituation, nicht aus der Kategorie. Das Theme selbst folgt der Nutzerwahl bzw. der Systempräferenz.
- [ ] Category-Reflex-Check als Frage, keine automatische Neuwahl: Lässt sich die Palette allein aus der Branche erraten? Wenn ja, begründen, warum sie hier passt, oder überarbeiten. Eine vorhandene Identität und Markenfarben sind oft richtig.
- [ ] Mindestens eine konkrete Referenz (Produkt, Seite, Screenshot) statt Adjektiven.
- [ ] Farben: semantische Rollen festgelegt. Aus dem bestehenden System übernommen oder, bei Neubau, begründet gewählt. Keine feste Anzahl.
- [ ] Schriften: in der Regel höchstens zwei Familien, mehr nur mit Begründung. Rollen dürfen dieselbe Familie teilen. Übernommen oder begründet gewählt.
- [ ] Layoutkonzept als ASCII-Wireframe, Ausrichtung festgelegt.
- [ ] Signatur-Element optional, auch im Brand-Register. Gibt es eines, bleibt alles andere ruhig.
- [ ] Gegenprobe als Frage, keine automatische Neuwahl: Würde ein ähnlicher Prompt zu demselben Plan führen? Wenn ja, prüfen, ob die betroffenen Teile dem Briefing dienen, und nur überarbeiten, was es nicht tut.
- [ ] Der Plan steht in `DESIGN.md`, `CLAUDE.md` bzw. die Tool-Regel verweist darauf.

## 2. Repo-Setup (einmalig)

- [ ] Semantische Tokens definiert (`--background`, `--foreground`, `--primary`, `--muted`, `--border`, `--radius`, Statusfarben) und im Theme-Layer überschrieben, nicht in Komponenten.
- [ ] Typo-Skala und Abstandsskala als Tokens.
- [ ] Linting: keine rohen Hex-Werte, keine beliebigen Tailwind-Werte, keine einmaligen Abstände.
- [ ] Anti-Slop-Detektor eingebunden: Impeccable, avoid-ai-design oder `templates/slop-grep.sh`.
- [ ] PostToolUse-Hook, der nach jedem Edit den Detektor laufen lässt.
- [ ] Playwright mit axe für die wichtigsten Abläufe, über alle Zustände.
- [ ] Screenshot-Tool für den Agenten verfügbar (Playwright-MCP oder Browser-MCP).

## 3. P0: objektive Mängel (blockieren die Abnahme)

**Barrierefreiheit**
- [ ] Textkontrast mindestens 4,5:1, großer Text sowie UI-Komponenten und Icons mindestens 3:1.
- [ ] Farbe ist nie das einzige Signal.
- [ ] Alles ist per Tastatur erreichbar, in logischer Tab-Reihenfolge.
- [ ] Fokus ist sichtbar (`:focus-visible`) und wird nicht von Sticky-Elementen verdeckt (2.4.11).
- [ ] Klickziele mindestens 24×24 CSS-px oder ausreichender Abstand (WCAG 2.2 SC 2.5.8, AA, mit Ausnahmen). Bei Touch der in `DESIGN.md` gewählte Systemwert mit Bezugssystem: 44×44 (Apple iOS in pt, Fluent im Web) oder 48×48 (Material in dp), siehe [06, Abschnitt 1](06-design-systeme.md#1-zielgrößen-nach-system-und-plattform-v).
- [ ] Jedes Feld hat ein sichtbares Label. Fehlermeldungen sind mit dem Feld verknüpft.
- [ ] Icon-Buttons haben einen zugänglichen Namen.
- [ ] Ziehen hat immer eine Alternative ohne Ziehen (2.5.7).
- [ ] `prefers-reduced-motion` wird respektiert.
- [ ] axe meldet keine Verstöße, und zwar in jedem geprüften Zustand.

**Zustände**
- [ ] Lädt, mit Skeleton bzw. Indikator je nach Dauer.
- [ ] Leer bei erster Nutzung, wo anwendbar: Erklärung, was hierher gehört. Eine Aktion nur, wenn sie berechtigt ist; ein read-only-Leerzustand ohne Aktion ist gültig. Aufbau und Ausrichtung folgen dem gewählten System ([06, Abschnitt 7](06-design-systeme.md#7-leerzustände-systeme-widersprechen-sich-v)).
- [ ] Keine Treffer, mit Filter zurücksetzen.
- [ ] Fehler, mit Ursache, nächstem Schritt und Retry.
- [ ] Kein Zugriff, mit Hinweis, wer Zugriff gewähren kann.
- [ ] Erfolg, mit derselben Bezeichnung wie die Aktion.
- [ ] Speichern läuft: Button gesperrt, keine Duplikate bei Doppelklick.
- [ ] Hover, aktiv, Fokus und deaktiviert sind für jede interaktive Komponente gestaltet.

**Funktion**
- [ ] Jeder Button und jeder Link tut etwas. Kein `href="#"`, kein leerer `onClick`.
- [ ] Formulare validieren und behalten Eingaben bei Fehlern.
- [ ] Kein horizontaler Overflow bei 390 px und 320 px.
- [ ] Nichts hängt ausschließlich an Hover.
- [ ] Zustand in der URL, wo sinnvoll: Filter, Tab, Zeitraum.
- [ ] Keine Platzhalter: kein Lorem ipsum, keine erfundenen Testimonials, Logos, Zahlen oder Adressen.

## 4. P1: Generik-Tells (AI Slop)

Ein einzelner Tell ist kein Problem. Mehrere zusammen sind ein Anlass zur Diagnose, kein Urteil. Die Skala nach pixelslop (0–1 ok, 2–3 leicht, 4–6 deutlich, ab 7 neu ansetzen) dient nur der Orientierung, nie als Schwelle für die Abnahme. Jeder Fund wird gegen das Briefing beurteilt.

**Erste Ordnung**
- [ ] Inter, Roboto oder `system-ui` nur, wenn übernommen oder begründet gewählt.
- [ ] Kein unbegründeter Lila-, Indigo- oder Violett-Blau-Verlauf.
- [ ] Kein Verlaufstext in Überschriften.
- [ ] Kein Cyan auf Dunkel und keine Glows ohne Anlass.
- [ ] Nicht automatisch Hero plus drei identische Icon-Karten.
- [ ] Keine Karten in Karten.
- [ ] Keine Icon-Kachel über jeder Überschrift.
- [ ] Kein seitlicher Akzentstreifen (`border-left: 4px`) als Deko.
- [ ] Nicht alles zentriert.
- [ ] Nicht jeder Button ist primär. Pro Bereich höchstens eine primäre Aktion, die nicht mit anderen konkurriert. Ein Bereich ohne primäre Aktion ist zulässig.
- [ ] Kein Glassmorphism oder Backdrop-Blur ohne Funktion.
- [ ] Keine Emojis als UI-Icons.
- [ ] Nicht dieselbe Fade-and-slide-Animation auf jeder Sektion und kein Hover-Lift auf jeder Karte.
- [ ] Kein Bounce- oder Elastic-Easing.

**Zweite Ordnung** (das, was nach dem Verbot der ersten Ordnung kommt)
- [ ] Nicht Creme (`#F4F1EA`) mit Serife und Terrakotta (`#D97757`), wenn das Briefing es nicht verlangt.
- [ ] Nicht Fast-Schwarz mit einem einzigen Acid-Grün- oder Zinnober-Akzent.
- [ ] Nicht Broadsheet mit Haarlinien und Radius 0 als Ausweichlösung.
- [ ] Nicht ein Radius und ein Schatten (`rgba(0,0,0,.1)`) für alles.
- [ ] Keine Versal-Eyebrow über jeder Überschrift.
- [ ] Keine Metazeilen „A · B · C“ und keine Labels „WORT — Fragment“ als Dekor.
- [ ] Kein Monospace für kleine Labels ohne Datenbezug.
- [ ] Kein „→“ an jedem Link oder Button.
- [ ] Kein einzelnes hervorgehobenes Wort in der Headline.
- [ ] 01/02/03 nur, wenn der Inhalt wirklich eine Abfolge ist.
- [ ] Space Grotesk, Geist, Instrument Serif oder Fraunces nur, wenn übernommen oder begründet gewählt.

**Texte**
- [ ] Buttons benennen die Handlung („Änderungen speichern“, nicht „Absenden“).
- [ ] Eine Aktion heißt im ganzen Ablauf gleich.
- [ ] Fehler entschuldigen sich nicht und sind nie vage.
- [ ] Keine Sätze, die mit „Empower“, „Unlock“, „Transform“, „Revolutionize“ beginnen.
- [ ] Keine Überschrift, die so auch beim Wettbewerber stehen könnte.
- [ ] Mindestens eine konkrete Zahl oder ein konkretes Detail pro Abschnitt (bei Marketing).
- [ ] Keine Beschreibungstexte zu offensichtlichen UI-Elementen.
- [ ] Einmal laut vorgelesen.

## 5. P2: Feinschliff

- [ ] Typo-Skala konsequent, keine Zwischengrößen.
- [ ] Abstände nur aus der Skala.
- [ ] Zeilenlänge unter 80 Zeichen.
- [ ] Zahlen in Tabellenziffern.
- [ ] Radien und Schatten haben eine Bedeutung (Elevation, Interaktivität).
- [ ] Schwarz-Weiß-Test: Die Hierarchie trägt auch ohne Farbe.
- [ ] Squint-Test: Mit zusammengekniffenen Augen ist die wichtigste Stelle sofort klar.
- [ ] Reverse-Squint-Test als Experiment, kein Abnahmekriterium: Ordnet ein frischer Chat den Screenshot leicht einem AI-Builder zu, ist das ein Hinweis auf übernommene Defaults. Die geratene Herkunft entscheidet nichts.
- [ ] Chanel-Frage: Dient jedes Element dem Briefing? Entfernt wird nur, was die Oberfläche dadurch besser macht.

## 6. Review-Kriterien nach Anwendungsfall

### Admin und interne Tools
- [ ] Tabellen: Dichte wählbar und gespeichert, Header sticky, Zahlen rechtsbündig, Bulk-Aktionen erst nach Auswahl.
- [ ] Filter sichtbar, zurücksetzbar, in der URL.
- [ ] Destruktive Aktionen: Rückgängig oder Bestätigung mit Objektname, Konsequenz benannt.
- [ ] Ungespeicherte Änderungen werden erkannt.
- [ ] Audit-Trail vorhanden, wo Daten geändert werden.
- [ ] Visuelle Generik ist toleriert, Inkonsistenz nicht.

### Infrastruktur und Ops
- [ ] Jedes Dashboard beantwortet eine benannte Frage.
- [ ] RED für Services, USE für Ressourcen.
- [ ] Farben über Schwellenwerte mit Bedeutung, nicht nur Rot und Grün.
- [ ] Zeitzone sichtbar, Zeitraum in der URL, Datenaktualität angezeigt.
- [ ] IDs und Hosts in Monospace und kopierbar.
- [ ] Alerts bleiben, bis sie behoben oder quittiert sind. Toasts sind nie der einzige Kanal.
- [ ] Zielumgebung bei gefährlichen Aktionen unübersehbar.
- [ ] Keine gestapelten Graphen, wo sie Werte verschleiern.

### Frontend für Endnutzer
- [ ] Standardabläufe (Login, Checkout, Einstellungen) folgen bekannten Mustern.
- [ ] Mobil vollständig bedienbar.
- [ ] Onboarding über leere Zustände.
- [ ] Core Web Vitals: LCP ≤ 2,5 s, INP ≤ 200 ms, CLS ≤ 0,1.
- [ ] Keine Dark Patterns: Kündigen so leicht wie Abschließen, keine Vorauswahl von Zusatzoptionen, keine falsche Verknappung.

### Marketing und Landingpage
- [ ] Der Hero zeigt das Charakteristische aus der Welt des Produkts, nicht „große Zahl plus Stats“.
- [ ] Echte Produktbilder und echte Belege.
- [ ] Eine primäre Handlungsaufforderung.
- [ ] Die Standard-Abfolge der Sektionen ist übernommen oder begründet gewählt, oder sie ist aufgebrochen.
- [ ] Höchstens drei konkurrierende Akzent-Elemente pro Viewport.
- [ ] Detektor-Funde gesichtet und jeweils behoben oder begründet. Der Score ist Diagnose, keine Abnahme.

## 7. Viewports und Testmatrix

| Breite | Zweck |
|---|---|
| 1440 px | Desktop-Standard |
| 1024 px | Tablet quer, kleiner Laptop |
| 768 px | Tablet hoch |
| 390 px | aktuelles Smartphone |
| 320 px | Untergrenze, kein horizontaler Overflow |

Zusätzlich: Zoom auf 200 %, Textabstände nach WCAG 1.4.12, Dark Mode, `prefers-reduced-motion`, nur Tastatur.

## 8. Abnahme-Prompt für den Agenten

Zum Kopieren ans Ende einer UI-Aufgabe:

```
Bevor du fertig meldest:
1. Lies DESIGN.md erneut.
2. Rendere die geänderten Seiten bei 1440, 768 und 390 px und mache Screenshots.
3. Prüfe gegen 04-checklisten.md, Abschnitte 3 (P0) und 4 (P1).
   Nenne jeden Fund mit Datei/Zeile oder Screenshot-Bereich.
4. Führe den Slop-Detektor und die Playwright/axe-Tests aus.
5. Behebe alle P0-Funde. Bei P1-Funden: beheben oder mit Bezug auf Briefing
   bzw. DESIGN.md begründen. „Bewusst gewählt“ allein reicht nicht.
6. Prüfe bei jedem dekorativen Element, ob es dem Briefing dient.
   Entferne es nur, wenn die Seite dadurch besser wird.
7. Berichte: was geprüft, was gefunden, was behoben, was offen.
```
