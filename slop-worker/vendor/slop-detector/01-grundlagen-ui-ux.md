# Grundlagen: Web-UI und -UX für alle Anwendungsfälle

Stand: 06.11.2026. Markierungen siehe [00-README.md](00-README.md#legende).

Diese Datei trennt zwei Arten von Inhalten. Ein Teil wurde in der Recherche gegen Primärquellen geprüft ([V]/[T]). Der Rest ist etabliertes Fachwissen, das die Recherche nicht eigens verifiziert hat ([F]). [F] heißt nicht unsicher, sondern nur: in dieser Recherche nicht gegengeprüft. Konkrete Zahlen aus Material 3, Apple HIG, Fluent 2, Carbon, Cloudscape, GOV.UK und den Desktop-HIGs stehen in [06](06-design-systeme.md).

---

## 1. Fundament: Design-Tokens

### 1.1 Was Tokens sind [V]
Design-Tokens sind benannte Name/Wert-Paare für kleine, wiederkehrende Designentscheidungen: Farbe, Typografie, Abstände, Bewegung, Elevation. Sie ersetzen hartcodierte Werte und sind die einzige Quelle für die visuellen Grundlagen. Eine Änderung an einer Stelle wirkt im ganzen System. (Atlassian, IBM Carbon)

### 1.2 Nach Bedeutung wählen, nicht nach Aussehen [V]
- *„Choose tokens based on meaning where applicable, not specific values.“* (Atlassian)
- *„Don't use a token just because the colors appear to match. This can break the experience in other themes.“* (Atlassian)
- Rollenbasierte Token-Namen bleiben in allen Themes gleich, nur die Werte wechseln. (Carbon)
- Atlassian benennt Tokens in drei Teilen: Fundament (`color`, `space`, `elevation`), Eigenschaft (`background`, `border`, `text`, `icon`) und Modifikator (Rolle, Betonung, Zustand). Beispiel: `color.icon.success`. [V]
- Themes sind Sätze von Token-Werten: hell, dunkel, hoher Kontrast, aber auch Dichte (kompakt) oder reduzierte Bewegung. [V]
- Tokens können auf andere Tokens verweisen. Ein semantischer Token wie `$interactive` zeigt auf einen Palettenwert wie `$blue-60`. [V] (Carbon)

### 1.3 Ebenen [F]
```
Primitiv      blue-600 = #2457d6         nur im Theme verwenden, nie in Komponenten
Semantisch    color.bg.accent = {blue-600}    das nutzen Komponenten
Komponente    button.primary.bg = {color.bg.accent}   optional, bei großen Systemen
```

### 1.4 Austauschformat [V]
Das W3C-Design-Tokens-Format 2025.10 ist die erste stabile Version (Community Group Final Report, kein W3C-Standard). Token-Dateien sind JSON, die Endung ist `.tokens.json`. Der Typ muss explizit über `$type` angegeben werden, Aliase schreibt man als `{group.token}`. Dass das Format ausdrücklich als Regelquelle für KI-Tools gedacht sei, wurde widerlegt [X]. Nutzbar ist es dafür trotzdem.

### 1.5 Tokens wirken nur, wenn sie erzwungen werden [V]/[A]
Hartcodierte Werte umgehen Tokens, und KI-Agenten hartcodieren nachweislich trotz vorhandener Tokens. Deshalb braucht es Linting: keine rohen Hex-Werte, keine einmaligen px-Werte, keine beliebigen Tailwind-Werte (`bg-[#…]`). Vorlage: [templates/stylelint-tokens.json](templates/stylelint-tokens.json).

---

## 2. Visuelle Grundlagen [F]

### Typografie
- Fließtext mindestens 16 px im Web, in dichten Admin- und Ops-Ansichten sind 13–14 px vertretbar, wenn Kontrast und Zeilenhöhe stimmen.
- Zeilenlänge 45–75 Zeichen. Anthropics Skill nennt „unter 80 Zeichen“. [V] Serifenschrift im Fließtext bekommt etwas mehr Zeilenhöhe als eine Groteske. [V]
- Typo-Skala mit festem Verhältnis (etwa 1,2 bis 1,333) und begrenzter Zahl an Stufen (5–7).
- Hierarchie über Größe, Gewicht und Abstand, nicht über Farbe allein.
- Zahlen in Tabellen und Metriken in Tabellenziffern (`font-variant-numeric: tabular-nums`).
- Höchstens zwei Schriftfamilien. Wenn es zwei sind, müssen sie sich deutlich unterscheiden. [V] (Anthropic Skill)

### Farbe
- Kontrast nach WCAG: Text mindestens 4,5:1, großer Text (ab 24 px bzw. 18,66 px fett) mindestens 3:1. UI-Komponenten und Grafiken mindestens 3:1 (SC 1.4.11).
- Farbe nie als einziges Signal (SC 1.4.1). Status zusätzlich mit Icon, Text oder Form kennzeichnen.
- Beispielwerte für Tailwind [A] (claude-bootstrap): Auf Weiß ist `gray-500` grenzwertig (ca. 4,6:1) und `gray-400` fällt durch (ca. 2,6:1). Auf `gray-900` ist `gray-400` grenzwertig (ca. 5:1) und `gray-500` fällt durch (ca. 3:1).
- Eine dominante Farbe mit klaren Akzenten statt einer gleichmäßig verteilten Palette. [V] (Anthropic, als Meinung)
- Statusfarben (Erfolg, Warnung, Fehler, Info) sind semantische Tokens und keine Dekoration.

### Abstände und Layout
- 4- oder 8-px-Raster mit fester Skala (etwa 4, 8, 12, 16, 24, 32, 48, 64). [V] Fluent 2 nutzt eine 4-px-Basis, Carbon eine 8-px-Rastereinheit, siehe [06, Abschnitt 3](06-design-systeme.md#3-raster-und-abstände-v).
- Nähe ordnet Zusammengehöriges. Der Abstand innerhalb einer Gruppe ist kleiner als der zwischen Gruppen.
- Linksbündig ist der Normalfall für Lesetext und Formulare. Zentrieren nur für kurze, einzelne Elemente.
- Radien und Schatten haben eine Bedeutung, etwa Elevation oder Interaktivität. Sie gehören nicht pauschal auf jede Fläche.

### Dark Mode
- Kein reines `#000` als Fläche. Elevation über hellere Flächen statt über Schatten.
- Farben für dunkle Flächen entsättigen. Kontrast separat prüfen, er ist nicht automatisch gleich dem im hellen Theme.
- Dark Mode als eigenes Theme über dieselben semantischen Tokens umsetzen [V], nicht über Einzelüberschreibungen.
- Die Entscheidung früh treffen. [A] (kent-tokyo) Sie folgt aus der Nutzungssituation, nicht aus der Kategorie. [V] (anti-slop-design)

### Bewegung
- Bewegung erklärt Zustandswechsel: öffnen, erweitern, bestätigen. [V] (Anthropic Skill)
- Dauer etwa 150–300 ms für UI-Übergänge, kein Bounce- oder Elastic-Easing in Produkt-UIs. [F]/[V] (Impeccable) Das entspricht den short- und medium-Stufen von Material 3. Größere Flächen bewegen sich länger, Verlassen ist kürzer als Eintreten. [V] Werte und Kurven in [06, Abschnitt 5](06-design-systeme.md#5-bewegung-va).
- `prefers-reduced-motion` respektieren. [V] (Anthropic Skill, als Qualitätsuntergrenze)
- Nur `transform` und `opacity` animieren, keine Layout-Eigenschaften. [V] (Impeccable)

---

## 3. Barrierefreiheit: WCAG 2.2

WCAG 2.2 ist seit dem 05.10.2023 W3C-Recommendation und bringt 9 neue Kriterien; 4.1.1 Parsing ist entfallen. [V]

| Kriterium | Stufe | Inhalt | Typischer Verstoß in KI-UIs |
|---|---|---|---|
| 2.5.8 Target Size (Minimum) | AA | Zeigerziele mindestens 24×24 CSS-px, Ausnahmen: Spacing, Equivalent, Inline, User Agent, Essential | Icon-Buttons in Tabellen-Aktionsspalten und Toolbars [V] |
| 2.4.11 Focus Not Obscured (Minimum) | AA | Ein fokussiertes Element darf nicht vollständig verdeckt sein | Sticky Header oder Footer, Cookie-Banner [V] |
| 2.4.12 Focus Not Obscured (Enhanced) | AAA | Ein fokussiertes Element darf gar nicht verdeckt sein | [V] |
| 2.5.7 Dragging Movements | AA | Jede Ziehen-Funktion braucht eine Alternative ohne Ziehen | Kanban, sortierbare Tabellen [V] |
| 3.3.7 Redundant Entry | A | Bereits eingegebene Daten nicht erneut abfragen | Mehrstufige Formulare [V] |
| 3.2.6 Consistent Help | A | Hilfe-Elemente stehen auf allen Seiten in derselben Reihenfolge | [V] |
| 3.3.8 Accessible Authentication (Minimum) | AA | Keine kognitiven Tests beim Login; Einfügen und Passwortmanager zulassen | Felder, die Einfügen blockieren [F] |

Ergänzend [F]:
- Ein sichtbarer Fokusring (`:focus-visible`), nie `outline: none` ohne Ersatz.
- Für Touch sind 44×44 bzw. 48×48 die praktische Untergrenze: Apple HIG 44×44 pt (iOS), Fluent 2 44×44 px (Web), Material 3 48×48 dp, WCAG 2.5.5 (AAA) 44×44 CSS-px. [V] Die Systeme widersprechen sich im Web, macOS erlaubt kleinere Werte. Tabelle in [06, Abschnitt 1](06-design-systeme.md#1-zielgrößen-nach-system-und-plattform-v).
- Semantisches HTML zuerst (`button`, `a`, `label`, `nav`, `main`), ARIA nur zur Ergänzung.
- Jedes Formularfeld hat ein sichtbares `label`. Ein Platzhalter ist kein Label.
- Fehlermeldungen sind programmatisch mit dem Feld verknüpft (`aria-describedby`), Statusmeldungen werden per `role="status"` bzw. `aria-live` angesagt.

Automatisierte Tests mit axe finden nur einen Teil der Probleme. Deque schätzt etwa 57 % nach Anzahl. [V] Siehe [02, Ebene 5](02-ai-slop-erkennen-und-vermeiden.md#ebene-5-funktion-und-barrierefreiheit-testen).

---

## 4. Usability-Grundlagen

### 4.1 Nielsens 10 Heuristiken als Review-Raster [F]
1. Sichtbarer Systemstatus: Laden, Speichern, Synchronisieren immer anzeigen.
2. Übereinstimmung mit der realen Welt: Begriffe der Nutzer statt Systembegriffe („Benachrichtigungen“ statt „Webhook-Config“; deckt sich mit [V] Anthropic Skill).
3. Kontrolle und Freiheit: Rückgängig vor Bestätigungsdialog, Abbrechen überall.
4. Konsistenz und Standards: dieselbe Aktion trägt überall denselben Namen ([V] Anthropic Skill: „Publish“ → „Published“).
5. Fehler vermeiden: Constraints, sinnvolle Defaults, Bestätigung nur bei destruktiven Aktionen.
6. Wiedererkennen statt Erinnern: zuletzt genutzte Werte, sichtbare Optionen.
7. Flexibilität und Effizienz: Tastaturkürzel, Bulk-Aktionen, gespeicherte Filter.
8. Ästhetik und Minimalismus: Jedes Element hat genau eine Aufgabe ([V] Anthropic Skill).
9. Fehler erkennen, verstehen, beheben: sagen, was passiert ist und was zu tun ist.
10. Hilfe und Dokumentation: kontextbezogen, an derselben Stelle (WCAG 3.2.6).

### 4.2 Zustände: jeder Screen hat mehr als einen [V]/[F]
Für jede Ansicht mit Daten diese Zustände gestalten und testen:

| Zustand | Regel |
|---|---|
| Lädt (< 1 s) | Nichts oder ein dezenter Indikator, um Flackern zu vermeiden [F] |
| Lädt (1–10 s) | Skeleton in der Form des späteren Inhalts [F] |
| Lädt (> 10 s) | Fortschritt, Abbrechen, Hintergrundverarbeitung [F] |
| Leer, erste Nutzung | Erklären, was hierher gehört, und eine primäre Aktion anbieten [V] (PatternFly) |
| Keine Ergebnisse | Filter oder Suche benennen, „Filter zurücksetzen“ anbieten [V] |
| Konfiguration nötig | Was fehlt und wo man es einrichtet [V] |
| Kein Zugriff | Wer Zugriff gewähren kann [V] |
| Backend-Fehler | Was passiert ist, Retry, ggf. Status- oder Incident-Link [V] |
| Teilweise geladen oder veraltet | Zeitstempel „Stand: …“, Hinweis auf Teilausfall [F] |
| Erfolg | Kurz bestätigen, mit derselben Bezeichnung wie die Aktion [V] |

PatternFly-Schreibregel für Leerzustände [V]: *„State what isn't there, and then give the user a next step.“* Genau eine primäre Handlungsaufforderung, sekundäre optional darunter. Die Größe richtet sich nach dem Kontext (Karte, Tabelle, ganze Seite), das Icon nach dem Typ. [T]

PatternFly-Textregeln für Alerts und Leerzustände [A]: kein „success/successfully“, keine Ausrufezeichen, kein „bitte“, nie dem Nutzer die Schuld geben, Satzschreibung.

### 4.3 Feedback, Toasts, Alerts [V] (PatternFly)
- Jeder Toast hat einen Schließen-Button.
- Beim automatischen Ausblenden werden 8 Sekunden empfohlen. Solange der Mauszeiger auf dem Toast liegt, verschwindet er nicht.
- Warnungen und kritische Alerts bleiben sichtbar, bis das Problem behoben ist. Ist es auf der aktuellen Seite nicht lösbar, kommt ein Modal zum Einsatz.
- Ein Toast ist nie der einzige Weg, auf ein Ereignis zu reagieren.
- Alert-Gruppen: die neuesten oben, ab mehr als 3 Alerts ein Überlauf-Footer mit Link zur vollständigen Liste. Mehrere Fehler sortiert man von schwer nach leicht. [A]

### 4.4 Formulare [F]
Belege aus Nutzerforschung (Baymard, NN/g, GOV.UK, USWDS) und Regeln für die Wortwahl von Fehlermeldungen stehen in [06, Abschnitt 8](06-design-systeme.md#8-formulare-und-fehlermeldungen-a). [A]

- Labels über dem Feld, linksbündig, einspaltig. Mehrspaltig nur bei logisch zusammengehörigen Kurzfeldern (PLZ und Ort).
- Pflicht oder optional kennzeichnen, und zwar das Seltenere.
- Validierung inline beim Verlassen des Felds, nicht bei jedem Tastendruck. Beim Absenden alle Fehler zusammenfassen und zum ersten springen.
- Den Absenden-Button nicht kommentarlos deaktivieren. Lieber erlauben und die Fehler zeigen.
- Während des Speicherns den Button sperren und den Zustand anzeigen, um Doppelklick-Duplikate zu verhindern. [A] (besthub.dev)
- Passende `type`, `inputmode` und `autocomplete`-Attribute setzen, Einfügen nicht blockieren.
- Eingaben bei Fehlern nie verwerfen, auch nicht nach Serverfehlern.

### 4.5 Navigation und Informationsarchitektur [F]
- Die Struktur folgt den Aufgaben der Nutzer, nicht dem Organigramm oder Datenmodell.
- Die aktuelle Position ist immer sichtbar (aktiver Navigationspunkt, Breadcrumbs ab drei Ebenen).
- Zustand in der URL: Filter, Sortierung, Tab, Zeitraum und ausgewählte Objekte sind verlinkbar und teilbar. Für Admin und Ops ist das Pflicht.
- Die Zurück-Taste des Browsers funktioniert erwartungsgemäß.

### 4.6 Performance als UX [F]
Core Web Vitals, gute Schwelle am 75. Perzentil: LCP ≤ 2,5 s, INP ≤ 200 ms, CLS ≤ 0,1.
- Layout-Sprünge vermeiden: Bildgrößen festlegen, Skeletons in Endgröße, Schriften mit `font-display` und passendem Fallback.
- Optimistische UI für schnelle, umkehrbare Aktionen. Bei Fehlern sichtbar zurückrollen.
- Große Tabellen virtualisieren oder serverseitig paginieren.

### 4.7 Dark Patterns vermeiden [F]
Verboten bzw. tabu sind unter anderem: Confirmshaming („Nein, ich will kein Geld sparen“), versteckte Kosten, vorausgewählte Zusatzoptionen, „Roach Motel“ (leicht hinein, schwer hinaus, etwa beim Kündigen), falsche Verknappung und Countdowns, verschleierte Werbung und Nagging.

Rechtlich verbietet Art. 25 des Digital Services Act Online-Plattformen in der EU, Oberflächen täuschend oder manipulativ zu gestalten. Für Cookie-Banner verlangen die Datenschutzbehörden, dass „Ablehnen“ gleichwertig neben „Akzeptieren“ steht. Bei KI-generierten Landingpages und Pricing-Seiten tauchen falsche Verknappung, erfundene Testimonials und Fake-Logos als Platzhalter auf. Vor dem Livegang entfernen.

---

## 5. Nach Anwendungsfall

Der Begriff „Register“ stammt aus der anti-slop-design-Skill [V]. **Brand** heißt Ausdruck und Wiedererkennung, **Product** heißt Werkzeug und Effizienz. Die folgenden Abschnitte sortieren danach.

### 5.1 Admin-Panels und interne Tools (Register: Product)

Ziel: schnell, dicht, vorhersehbar. Eigenständige Optik ist hier zweitrangig, aber Konsistenz ist Pflicht. [A] (Community-Konsens, siehe [02, Abschnitt 7](02-ai-slop-erkennen-und-vermeiden.md#7-wann-ist-generisches-design-in-ordnung))

**Datentabellen**
- Zeilendichte wählbar, zum Beispiel kompakt, normal und luftig. Der Umschalter sitzt außerhalb der Tabelle, die Wahl wird gespeichert, es gibt einen Reset. [T] Die Pixelwerte variieren je nach System: pencilandpaper 40/48/56, Carbon 24/32/40/48/64, MUI X 52 Standard, Cloudscape zwei Stufen.
- Komfortabel ist der Standard, kompakt wählt der Nutzer. Dichte schaltet sich nicht automatisch ein und verkleinert keine Ziele. [V] (Material 3, Cloudscape; Details in [06, Abschnitt 6](06-design-systeme.md#6-dichte-vt))
- Zahlen rechtsbündig in Tabellenziffern, Text linksbündig, nichts zentriert. [A] (pencilandpaper)
- Sticky Header. Bei horizontalem Scrollen bleibt die erste Spalte fixiert. [A]
- Bulk-Aktionen erst anzeigen, wenn Zeilen ausgewählt sind. [A]
- Keine Zebrastreifen in stark interaktiven Tabellen, denn sie kollidieren mit Hover-, Fokus- und Auswahlzuständen. Stattdessen Trennlinien von höchstens 1 px. [A]
- Spalten ein- und ausblenden, sortieren, filtern. Filter als sichtbare Chips mit „Alle zurücksetzen“. [F]
- Leere und gefilterte Zustände unterscheiden: „Keine Einträge“ ist etwas anderes als „Keine Treffer für Filter X“. [V]
- Icon-Aktionen in Zeilen: mindestens 24×24 px oder genügend Abstand (WCAG 2.5.8), dazu Tooltip und `aria-label`. [V]

**Destruktive Aktionen** [F]
- Wenn möglich Rückgängig statt Bestätigungsdialog („Gelöscht. Rückgängig machen“).
- Bei Unumkehrbarem den Objektnamen eintippen lassen, die Konsequenz konkret nennen und den Button als destruktiv kennzeichnen. Er ist nicht der Default-Fokus.
- Audit-Log: wer, was, wann, vorher und nachher.

**Formulare im Admin** [F]
- Ungespeicherte Änderungen markieren und beim Verlassen warnen.
- Lange Formulare in Abschnitte mit Ankern gliedern statt in Assistenten, wenn Nutzer gezielt einzelne Felder ändern.

### 5.2 Infrastruktur- und Ops-Dashboards (Register: Product)

**Dashboard-Design nach Grafana** [V], Einzelquelle eines Herstellers, aber etablierte SRE-Methoden:
- Jedes Dashboard beantwortet eine bestimmte Frage. *„Dashboards should reduce cognitive load, not add to it.“*
- Farbe trägt Bedeutung (Grafana-Beispiel: Blau gut, Rot schlecht), umgesetzt über Schwellenwerte. Blau/Rot ist für Farbfehlsichtige sicherer als Rot/Grün. [V]
- Metrik-Framework nach Ziel:
  - **RED** (Rate, Errors, Duration) für Services. Steht für das Nutzererlebnis und eignet sich für Alerting und SLAs, denn man alarmiert auf Symptome.
  - **USE** (Utilization, Saturation, Errors) für Ressourcen wie CPU, Speicher und Netz. Zeigt Ursachen.
  - **Four Golden Signals** sind RED plus Saturation.
- Gestapelte Graphen können täuschen. Für Vergleiche normierte Werte (Prozent) statt Rohzahlen verwenden. [A]
- Keinen Dashboard-Wildwuchs. Auf höchster Reifestufe sind Dashboards per Skript erzeugt und als JSON versioniert. Ansichten wechselt man über Template-Variablen. [A]
- Dashboards und Panels dokumentieren, unnötige Refreshes vermeiden. [A]

**Ergänzend für Ops-UIs** [F]
- Zeit: Zeitzone immer sichtbar (UTC oder lokal umschaltbar). Relative Zeiten („vor 3 min“) mit absoluter Zeit im Tooltip. Der Zeitraum gehört in die URL.
- IDs, Hostnamen und Hashes in Monospace, mit einem Klick kopierbar und nie abgeschnitten, ohne dass der volle Wert erreichbar ist.
- Schweregrade konsistent und nicht nur über Farbe: Icon, Text und Sortierung.
- Alarmzustände bleiben, bis sie behoben oder quittiert sind (siehe PatternFly, 4.3).
- Datenaktualität anzeigen: „Stand: 14:02:31 UTC“, Auto-Refresh pausierbar.
- Konsolen und Logs: Suchen, Filtern, Pausieren, Zeilen umbrechen, Download. Tastaturbedienung vollständig.
- Dark Mode, wenn die Nutzungssituation es verlangt (Leitstand, Nachtschicht). [V] (anti-slop-design, Beispiel „SRE um 2 Uhr nachts“)
- Gefährliche Aktionen (Deploy, Restart, Failover) zeigen Zielumgebung und Host deutlich an, etwa als Produktions-Banner.

### 5.3 Frontends für Endnutzer (Register: Product, mit Brand-Anteil)
- Wiedererkennbarkeit vor Originalität bei Standardmustern wie Login, Checkout und Einstellungen. [F] u/jmdl04 (r/ClaudeAI) baut bewusst auf bekannten App-Mustern auf. [A]
- Onboarding über leere Zustände, nicht über Tour-Overlays. [F]
- Mobile zuerst prüfen: kein horizontaler Overflow, Aktionen unten erreichbar, nichts hängt an Hover. [A] (besthub.dev)
- Texte aus Nutzersicht, konkret und aktiv. [V] (Anthropic Skill)
- Fehler und Wartezeiten ehrlich und mit nächstem Schritt kommunizieren. [V]

### 5.4 Marketing- und Landingpages (Register: Brand)
Hier ist AI Slop am sichtbarsten und am teuersten. Siehe [02](02-ai-slop-erkennen-und-vermeiden.md) und [03](03-community-howtos-und-ideen.md).
- Der Hero zeigt das Charakteristischste aus der Welt des Produkts: ein echtes Produktbild, eine Live-Demo oder eine konkrete Aussage. „Große Zahl, kleines Label, Stats, Verlaufsakzent“ ist der Default. [V] (Anthropic Skill)
- Echte Inhalte: echte Screenshots, echte Kundennamen, echte Zahlen. Keine Platzhalter-Logos, keine erfundenen Testimonials. [V]/[F]
- Die Abfolge Hero, drei Karten, Social Proof, Pricing, FAQ bewusst aufbrechen, wo der Inhalt es zulässt. [A]
- Eine einzige auffällige Stelle, der Rest ist ruhig. [V]
- Atmosphärische Hintergründe (Verläufe in Ebenen, Muster) passen eher hierher als in Produkt-UIs. [V] (Anthropic-Artikel 11/2025)
- Pro Seite ein H1 und eine primäre Handlungsaufforderung. [F]
- Performance: Hero-Bild optimiert und als LCP-Element priorisiert, keine Layout-Sprünge durch nachladende Schriften. [F]
