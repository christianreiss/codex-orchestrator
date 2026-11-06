# Design-Systeme: was man übernehmen kann und was nicht

Stand: 06.11.2026. Markierungen siehe [00-README.md](00-README.md#legende). Grundlage ist Welle 3 der Recherche (siehe [05](05-quellen-und-evidenz.md#methode)).

Etablierte Design-Systeme wie Material 3, Apple HIG, Fluent 2, IBM Carbon, AWS Cloudscape oder GOV.UK haben viele Entscheidungen bereits getroffen, getestet und dokumentiert. Diese Datei sammelt Regeln mit konkreten Zahlen, die sich zitieren und prüfen lassen.

Zwei Grundsätze vorweg:

1. **Regeln übernehmen, nicht die Optik.** Wer ein System vollständig mit seinen Defaults übernimmt, bekommt dessen Standard-Look. Das ist in Product-UIs oft in Ordnung (siehe [02, Abschnitt 7](02-ai-slop-erkennen-und-vermeiden.md#7-wann-ist-generisches-design-in-ordnung) und das Register-Konzept in [01, Abschnitt 5](01-grundlagen-ui-ux.md#5-nach-anwendungsfall)). In Brand-UIs ist es Slop. Abschnitt 10 beschreibt das.
2. **Jede Regel bekommt ihr System dazu.** Die Systeme widersprechen sich in Details, etwa bei der Zielgröße im Web (44 gegen 48) oder bei Leerzuständen (zentriert oder linksbündig, primärer oder sekundärer Button). Wer schreibt „Material 3 verlangt …“, liegt richtig. Wer schreibt „Buttons müssen …“, erfindet eine Universalregel.

Verifiziert ([V]/[T]) sind nur Aussagen zu Material 3, Apple HIG, Fluent 2, Carbon und Cloudscape. Alles zu GOV.UK, USWDS, Baymard, NN/g, PatternFly, GNOME, KDE und shadcn/ui wurde aus der Primärquelle extrahiert und korrekt zitiert, aber nicht adversarial geprüft ([A]).

---

## 1. Zielgrößen nach System und Plattform [V]

| System | Wert | Bemerkung |
|---|---|---|
| WCAG 2.2, SC 2.5.8 (AA) | 24×24 CSS-px | rechtliche Untergrenze im Web, mit Ausnahmen (siehe [01, Abschnitt 3](01-grundlagen-ui-ux.md#3-barrierefreiheit-wcag-22)) |
| WCAG 2.2, SC 2.5.5 (AAA) | 44×44 CSS-px | |
| Material 3 | 48×48 dp interaktives Ziel | auch wenn das sichtbare Element kleiner ist, z. B. ein 40-dp-State-Layer bei Icon-Buttons |
| Fluent 2 | 44×44 auf iOS und im Web, 48×48 auf Android | Angabe steht im Abschnitt zu Abständen, mit Blick auf Mobilgeräte |
| Apple HIG, iOS/iPadOS | 44×44 pt Standard, 28×28 pt Minimum | Apple spricht von „control size“, nicht von Trefferfläche |
| Apple HIG, macOS | 28×28 pt Standard, 20×20 pt Minimum | |
| Apple HIG, visionOS / tvOS / watchOS | 60/28 · 66/56 · 44/28 pt | Standard/Minimum |

- Um Bedienelemente mit Rahmen (Bezel) empfiehlt Apple etwa 12 pt Abstand, um rahmenlose etwa 24 pt. [V]
- 44 und 48 sind Entscheidungen der Systeme, keine gesetzlichen Mindestwerte. Für eine Web-App heißt das: 24 px ist Pflicht (AA). 44 bzw. 48 px sind sinnvoll, sobald Touch eine Rolle spielt. Welchen der beiden Werte man nimmt, legt man in `DESIGN.md` fest und nennt das Bezugssystem dazu.
- Fluents Desktop-Wert für Windows (40×40 effektive px) ist nur aus zweiter Hand belegt und hier nicht geprüft.
- Widerlegt (0-3): „Material 3 verlangt 48 dp auch unter Density-Skalierung“. Material sagt nur, dass Dichte nicht *standardmäßig* aktiv sein darf, wenn Ziele dadurch unter 48×48 fallen (Abschnitt 6).

## 2. Kontrast und Textgröße (Apple HIG) [V]

Apple übernimmt die WCAG-AA-Werte als Richtlinie, der Accessibility Inspector prüft danach:

| Textgröße | Mindestkontrast |
|---|---|
| bis 17 pt | 4,5:1 |
| ab 18 pt | 3:1 |
| fett, jede Größe | 3:1 |

- Der Wert für fetten Text ist großzügiger als WCAG, dort zählt fetter Text erst ab 14 pt als groß. Fürs Web gilt deshalb weiter WCAG (siehe [01, Farbe](01-grundlagen-ui-ux.md#farbe)).
- Kontrast im hellen und im dunklen Erscheinungsbild prüfen. Reichen die Standardwerte nicht, muss die App bei aktivem „Kontrast erhöhen“ ein kontrastreicheres Schema anbieten. APCA nennt Apple als alternatives Maß.
- Textgrößen, Standard/Minimum: iOS und iPadOS 17/11 pt, macOS 13/10 pt, tvOS 29/23 pt, visionOS 17/12 pt, watchOS 16/12 pt. Das sind Empfehlungen für eigene Textstile, keine harten Grenzen.
- Text sollte sich *idealerweise* um mindestens 200 % vergrößern lassen (watchOS 140 %), etwa über Dynamic Type.
- Ergänzend [A]: Farbe nie als einziges Signal. Apple nennt Rot-Grün und Blau-Orange als schwierige Paare. Systemfarben bevorzugen, weil sie sich an hellen und dunklen Modus und an erhöhten Kontrast anpassen.
- Material 3 [A]: keine Schrift unter 10 sp, Text in sp setzen, damit Nutzer skalieren können. Auf dunklem Grund einen kräftigeren Schnitt wählen, weil dünne Schrift dort schlecht lesbar ist.

## 3. Raster und Abstände [V]

- **Fluent 2:** Basiseinheit 4 px. Skala: 0, 2, 4, 6, 8, 10, 12, 16, 20, 24, 28, 32, 36, 40, 48, 52, 56. Die Werte 2, 6 und 10 dienen nur dem Ausrichten von Icons. Einheit ist pt auf iOS, dp auf Android und px im Web.
- **Carbon 2x Grid:** Die Geometrie baut auf einer 8-px-Einheit auf („mini unit“). Die Spacing-Tokens von Carbon enthalten zusätzlich 2 und 4 px. Die 8 gilt also für das Raster, nicht für jeden Abstand.
- **Carbon-Breakpoints:**

| Breakpoint | Breite | Spalten | Rand |
|---|---|---|---|
| Small | 320 px | 4 | 0 |
| Medium | 672 px | 8 | 16 px |
| Large | 1056 px | 16 | 16 px |
| X-Large | 1312 px | 16 | 16 px |
| Max | 1584 px | 16 | 24 px |

- Carbon: Innenabstand der Rasterboxen immer 16 px, daraus ergibt sich ein Gutter von 32 px. Für eng verwandte Inhalte gibt es ein Raster ohne Gutter.
- 4 und 8 vertragen sich. Die Regel in [01, Abstände und Layout](01-grundlagen-ui-ux.md#abstände-und-layout) ist damit durch zwei Systeme belegt.
- **KDE/Kirigami** [A]: semantische Abstände statt fester Zahlen. `smallSpacing` innerhalb einer Gruppe, `mediumSpacing` zwischen Toolbar-Elementen, `largeSpacing` zwischen Gruppen und als Rand zu Fenster und Seite, 0 zwischen Titel und Untertitel. Feste Größen, auch Fenstergrößen, als Vielfache von `gridUnit` (laut HIG 18 px). Die Werte liefert die Plattform, deshalb gehören in QML keine hartcodierten Pixel.

## 4. Interaktionszustände (Material 3) [V]

Material 3 legt über jedes interaktive Element einen State-Layer mit fester Deckkraft in der Inhaltsfarbe:

| Zustand | Deckkraft |
|---|---|
| Hover | 8 % |
| Fokus | 10 % |
| Gedrückt | 10 % |
| Gezogen | 16 % |
| Deaktiviert | Inhalt 38 %, Container 12 % |

- Die Farbe des Layers ist die Farbe des Inhalts. Ein Text-Button bekommt einen Layer in `primary`, eine Fläche in `secondary-container` einen in `on-secondary-container`.
- Material 2 nutzte 12 % für Fokus und Gedrückt. Bei Quellen prüfen, welche Version gemeint ist.
- Übertragbar ist das Prinzip: Zustände entstehen aus *einer* Regel statt aus einzeln gewählten Hover-Farben. Das verhindert, dass der Agent pro Komponente eigene Hover-Töne erfindet.
- Apple [A]: Eigene Buttons brauchen immer einen gedrückten Zustand, sonst wirken sie träge.

## 5. Bewegung [V]/[A]

**Material 3, Easing und Dauer** [V], von Google inzwischen als Altlast markiert:

| Token | Wert | Einsatz |
|---|---|---|
| Standard | `cubic-bezier(0.2, 0, 0, 1)` | kleine, einfache Übergänge |
| Standard decelerate / accelerate | `(0, 0, 0, 1)` / `(0.3, 0, 1, 1)` | Eintreten / Verlassen |
| Emphasized decelerate / accelerate | `(0.05, 0.7, 0.1, 1)` / `(0.3, 0, 0.8, 0.15)` | häufigste Gruppe; das volle Emphasized hat keine einzelne CSS-Kurve, in CSS greift man auf Standard zurück |
| short1–4 | 50–200 ms | kleine Hilfsübergänge |
| medium1–4 | 250–400 ms | mittelgroße Bildschirmbereiche |
| long1–4 | 450–600 ms | große, ausdrucksstarke Übergänge |
| extra-long1–4 | 700–1000 ms | selten, ohne Nutzereingabe |

- Die Dauer wächst mit der bewegten Fläche. Verlassen ist kürzer als Eintreten (etwa 200 gegen 500 ms).
- **Achtung:** Seit dem Expressive-Update nutzt Material 3 Federphysik (Springs). Google schreibt, das Easing-und-Dauer-System werde „no longer maintained“. Die Tabelle ist trotzdem zitierfähig, gehört aber als Altlast bzw. Fallback gekennzeichnet. Die Federparameter wurden nicht geprüft.
- Mit [01, Bewegung](01-grundlagen-ui-ux.md#bewegung) (150–300 ms für UI-Übergänge) vereinbar: Das sind Materials short- und medium-Stufen.

**Apple, Bewegung reduzieren** [A]: Wenn „Bewegung reduzieren“ aktiv ist, automatische und wiederholte Animationen zurücknehmen, also Zoomen, Skalieren und Bewegung am Rand. Konkrete Mittel: Federn straffen, Übergänge auf x-, y- und z-Achse durch Überblendungen ersetzen, keine Unschärfe animieren. Elemente, die sich nach einer Zeit selbst ausblenden, sparsam einsetzen. Letzteres steht in Spannung zur 8-Sekunden-Regel für Toasts von PatternFly ([01, Abschnitt 4.3](01-grundlagen-ui-ux.md#43-feedback-toasts-alerts-v-patternfly)). Beide verlangen deshalb, dass der Toast nicht der einzige Weg zur Information ist.

**KDE/Kirigami** [A]: semantische Dauern (`veryShortDuration` bis `veryLongDuration`), die mit den Animationseinstellungen des Nutzers skalieren. Kurz für Hover und kleine Akzente, lang für bildschirmfüllende Übergänge und Dialoge. `humanMoment` (2 s) ist die Wartezeit, bevor ein Spinner erscheint oder eine Suche beim Tippen auslöst, und ausdrücklich *keine* Animationsdauer. Die Begründung für 2 s ist schwach belegt (ein Blogartikel).

## 6. Dichte [V]/[T]

Material 3 und Cloudscape sind sich einig:
- Der Standard ist komfortabel. Dichtere Layouts sind ein Zusatz, den der Nutzer wählt. [V]
- Dichte darf Ziele nicht still verkleinern und sich nicht von selbst einschalten. [V]

| | Material 3 | Cloudscape |
|---|---|---|
| Stufen | 0 (Standard), −1, −2, −3; je Stufe meist 4 dp weniger Höhe bzw. vertikales Padding, Schriftgröße bleibt [T] | genau zwei: comfortable und compact [V] |
| Wer entscheidet | Designer pro Komponente | Nutzer per Umschalter, gilt für die ganze Anwendung [V] |
| Grenzen | nicht standardmäßig, wenn Ziele unter 48×48 fallen; nicht automatisch bei Breakpoint- oder Ausrichtungswechsel; Menüs, Snackbars und Dialoge nie dicht [V] | compact ersetzt comfortable nie; gedacht für datenlastige Vollseiten wie Dashboards und Ressourcenlisten; Alerts, Hilfe-Panels, Flashbars, Validierungsmeldungen und Dropdowns werden nicht voll verdichtet [V] |

Das ergänzt die Dichte-Regel für Datentabellen in [01, Abschnitt 5.1](01-grundlagen-ui-ux.md#51-admin-panels-und-interne-tools-register-product).

## 7. Leerzustände: Systeme widersprechen sich [V]

| | Cloudscape | Carbon | PatternFly [A] |
|---|---|---|---|
| Arten | „empty state“ (noch nichts angelegt) und „zero results state“ (Filter ohne Treffer) | – | Einstieg, keine Ergebnisse, Konfiguration nötig, kein Zugriff, Backend-Fehler, Erfolg, Anlegen, jeweils mit eigenem Icon |
| Aufbau | Überschrift, die den Zustand benennt (fett, ohne Satzzeichen am Ende); Beschreibung nur, wenn sie erklärt, warum nichts da ist; Aktion | – | Icon, kurze Überschrift, Text mit Grund und nächstem Schritt, primäre Aktion, optional sekundäre |
| Button | **immer sekundär**; ohne mögliche Aktion ein Link im Text | – | **primär** |
| Ausrichtung | – | Elemente **als Block linksbündig**; nur in kleinen Kacheln wird das Bild zentriert, Text und Aktion bleiben linksbündig; in großen Flächen darf der Block selbst zentriert stehen | als Vollseite horizontal **zentriert** |
| Feste Texte | Aktion bei null Treffern heißt genau „Clear filter“ | – | Satzschreibung, kein Punkt in Überschriften und Buttons, kein „bitte“, keine Schuldzuweisung, kein „success“ |

Folgerung: „Leerzustand = zentriertes Icon, Überschrift, primärer Button“ ist *eine* von mehreren belegten Varianten, keine Norm. Wer sie überall einsetzt, produziert genau das gleichförmige Muster aus [02](02-ai-slop-erkennen-und-vermeiden.md). Die Wahl gehört in `DESIGN.md`. Die Unterscheidung „leer“ gegen „keine Treffer“ teilen alle drei Systeme und [01, Abschnitt 4.2](01-grundlagen-ui-ux.md#42-zustände-jeder-screen-hat-mehr-als-einen-vf).

Widerlegt (0-3), nicht zitieren: „Carbon schreibt drei Pflichtteile und eine positive Überschrift vor“. Ebenso „Cloudscape: Leerzustände dürfen nie Fehler ersetzen, jeder braucht eine Aktion, die Beschreibung darf nichts wiederholen“.

## 8. Formulare und Fehlermeldungen [A]

Diese Quellen stützen sich auf Nutzerforschung. Sie wurden abgerufen und korrekt zitiert, aber nicht gegengeprüft. Sie untermauern die bisher nur als Fachwissen markierten Regeln in [01, Abschnitt 4.4](01-grundlagen-ui-ux.md#44-formulare-f).

**Layout**
- Einspaltig. In Baymards Usability-Tests führten einspaltige Formulare zu weniger übersprungenen und missverstandenen Feldern und zu weniger Fehlern. Ausnahme: 2–3 eng zusammengehörige Felder in einer Zeile (Datum, PLZ und Ort, Ablaufdatum und CVC). Etwa 16 % der Shops im Baymard-Benchmark nutzen mehrspaltige Formulare. (Baymard)
- USWDS: einfache vertikale Anordnung, Reihenfolge im HTML wie auf dem Bildschirm, keine Umsortierung per CSS. Thematisch verwandte Felder in `fieldset`. Bekannte Einschränkung: VoiceOver auf iOS unterstützt `fieldset` und `legend` nicht.
- GOV.UK: mit „one thing per page“ beginnen, also eine Information, eine Entscheidung oder eine Frage pro Seite. Seiten nur zusammenlegen, wenn Nutzerforschung das stützt. Vorher eine „Question Protocol“-Liste anlegen: Was wird gefragt, warum, wofür. Was sich nicht begründen lässt, fliegt raus. Ausschlussfragen zuerst, danach verzweigen, sodass jeder nur seine Fragen sieht. Die Seite selbst nennt keine formalen Studien, nur Praxiserfahrung und zwei Fallstudien.

**Labels und Platzhalter**
- Ein Platzhalter ersetzt kein sichtbares Label. Hinweise stehen dauerhaft außerhalb des Felds. Nutzer halten Platzhalter für vorausgefüllte Werte und überspringen das Feld. Hellgrauer Platzhaltertext fällt oft beim Kontrast durch, und nicht alle Screenreader lesen ihn vor. (NN/g)
- Floating Labels, der Standard bei Material-Textfeldern, lösen das nur zum Teil. Wo Platz ist, sind Label und Hinweis außerhalb des Felds besser. (NN/g)
- Pflicht und optional (USWDS): Pflichtfelder mit rotem Sternchen und einer Erklärung oben im Formular, optionale Felder mit „(optional)“. Formulare mit nur einem Feld brauchen keine Markierung.

**Validierung**
- Prüfen, wenn der Nutzer das Feld verlässt. Bei Feldern fester Länge, sobald die Länge erreicht ist. Nie schon während des Tippens. (Baymard)
- Wird ein Fehler angezeigt, aktualisiert sich die Meldung bei jedem Tastendruck und verschwindet, sobald die Eingabe gültig ist. Das ist besonders bei voneinander abhängigen Feldern wichtig, etwa bei der Passwort-Bestätigung. (Baymard)
- Fehler, die erst nach dem Absenden erscheinen, trugen in Baymards Tests oft zum Abbruch bei. Etwa 31 % der getesteten Shops haben keinerlei Inline-Validierung. Die Quelle nennt an anderer Stelle 32 %.

**Fehlermeldungen (GOV.UK)**
- An zwei Stellen anzeigen: am Feld und in einer Fehlerzusammenfassung oben, beide Male mit demselben Text.
- Position: nach Frage und Hinweistext, in Rot, mit rotem Rand, der Meldung und Feld verbindet. Für Screenreader steht davor ein unsichtbares „Error:“. USWDS ergänzt: Meldung bündig am Feld ausrichten (für Bildschirmlupen) und den Fehler auch im `<title>` melden.
- Wortwahl: konkret und schlicht. Keine generischen Meldungen („Ein Fehler ist aufgetreten“, „Pflichtfeld“), kein „bitte“, weil es eine Wahl suggeriert, kein „Entschuldigung“, weil es nicht beim Beheben hilft, kein „gültig“/„ungültig“, kein Fachjargon, keine Schuldzuweisung, kein Humor wie „Hoppla“.
- Bei einem Fehler nie Felder leeren, weder die richtigen noch die falschen.
- Fehlermeldungen sind nicht für fehlende Berechtigung, fehlende Voraussetzungen oder Fehler im System gedacht, die der Nutzer nicht beheben kann. Dafür gibt es eigene Seiten bzw. die Zustände aus [01, Abschnitt 4.2](01-grundlagen-ui-ux.md#42-zustände-jeder-screen-hat-mehr-als-einen-vf).
- GOV.UK berichtet, die Regeln seien in Live-Diensten mit allen Nutzergruppen getestet worden, etwa bei den Steuergutschriften.

**Deaktivierte Elemente (USWDS)**: möglichst vermeiden, besonders bei Textfeldern. Wo nötig, `aria-disabled="true"` statt des `disabled`-Attributs, damit Screenreader- und Tastaturnutzer das Element weiter erreichen. USWDS verweist dafür auf eine eigene Literaturauswertung von 2023. Das stützt die Regel „Absenden-Button nicht kommentarlos deaktivieren“ in [01, Abschnitt 4.4](01-grundlagen-ui-ux.md#44-formulare-f).

## 9. Native Apps: macOS, GNOME, KDE [A]

Relevant für die Swift-, QML- und Qt-Prüfung des Slop Detectors (siehe [README.md](README.md)). Alle Punkte sind aus der Primärquelle extrahiert, aber nicht gegengeprüft. Für macOS sind nur die Zahlen aus den Abschnitten 1 und 2 verifiziert.

**Apple: Buttons und Hierarchie**
- Höchstens ein bis zwei hervorgehobene Buttons (Akzentfarbe) pro Ansicht. Die bevorzugte Option unterscheidet sich durch den Stil, nicht durch die Größe.
- Die primäre Rolle (Akzentfarbe, Return-Taste) nie auf eine destruktive Aktion legen, auch wenn sie die wahrscheinlichste Wahl ist. Menschen drücken den primären Button oft, ohne ihn zu lesen. Destruktive Buttons in System-Rot.
- macOS: Ein Button, der ein weiteres Fenster, eine Ansicht oder eine App öffnet, bekommt im Titel ein Auslassungszeichen („Exportieren…“). Beschriftungen sind kurz und beginnen mit einem Verb.
- Allgemeine Trefferfläche mindestens 44×44 pt (visionOS 60×60 pt), für jede Eingabeart. Bild-Buttons auf macOS brauchen etwa 10 px Abstand zwischen Bild und Klickrand.

**GNOME HIG: Header Bars**
- Feste Aufteilung: Hauptaktionen (Neu, Hinzufügen, Öffnen, Zurück) am Anfang, Fenstertitel in der Mitte, Menüs am Ende.
- Wenige Bedienelemente, damit sich das Fenster schmal ziehen lässt. Immer etwas freie Fläche zum Verschieben lassen.
- Buttons ohne sichtbaren Hintergrund und Rahmen. Reine Text-Buttons, hervorgehobene und destruktive Buttons sowie verbundene Button-Gruppen in Hauptfenstern meiden (Dialoge sind ausgenommen). Verwandte Buttons über Abstand gruppieren.
- Jedes Bedienelement in der Header Bar eines Hauptfensters hat einen Tooltip.

**KDE HIG / Kirigami**
- Abstände und Größen über Kirigami-Einheiten, siehe Abschnitt 3. Icongrößen aus der semantischen, DPI-normalisierten Gruppe (`small` bis `enormous`, `sizeForLabels`), nicht als feste Pixel. Ab Kirigami 6.2 ein gemeinsamer `cornerRadius` für alle Buttons und Rechtecke.
- Navigation: bis fünf Ziele `NavigationTabBar`, darüber `GlobalDrawer`. Ein Hamburger-Menü nur, wenn es etwa 15 Einträge oder weniger hat, sonst eine echte Menüleiste.
- Desktop und Mobil anpassen statt verkleinern: Toolbar auf dem Desktop über dem Inhalt, auf dem Handy darunter, keine Statusleiste auf dem Handy. Kürzel immer mit Modifikator, nie eine nackte Funktionstaste.
- Nähe ordnet: kleiner Abstand innerhalb einer Gruppe, großer zwischen Gruppen, und nur logisch Zusammengehöriges sieht gruppiert aus. Das ist dieselbe Regel wie in [01, Abstände und Layout](01-grundlagen-ui-ux.md#abstände-und-layout).

Konflikte zwischen den Plattformen, etwa bei der Reihenfolge von Dialog-Buttons oder bei Standardhöhen von Bedienelementen, wurden nicht recherchiert (siehe [05, Offene Fragen](05-quellen-und-evidenz.md#offene-fragen)). Ein natives Programm folgt der HIG *seiner* Plattform, nicht einem Web-System.

## 10. Ein System übernehmen, ohne Slop zu erzeugen [A]

Dass eine vollständig übernommene Default-Optik generisch wirkt, ist in dieser Welle **nicht** verifiziert. Belegt ist nur, was die Hersteller selbst sagen:

- **shadcn/ui** bezeichnet sich ausdrücklich nicht als Komponentenbibliothek oder Design-System mit festen Regeln, sondern als offenen Code, aus dem man die *eigene* Bibliothek baut. Die Komponenten haben „sorgfältig gewählte Standardstile“ für einen „klaren, minimalen Look ohne Zusatzaufwand“ und sind aufeinander abgestimmt. Angepasst wird durch direktes Ändern des kopierten Codes. Und: shadcn/ui ist darauf ausgelegt, dass KI-Modelle den Code lesen und neue Komponenten erzeugen können. Wer shadcn übernimmt, übernimmt also keine geprüften UX-Regeln. Die Abgrenzung ist Aufgabe des Projekts, und genau dieser Schritt fällt weg, wenn man die Defaults stehen lässt. (Dass der shadcn-Look *allein* durch nicht angepasste Defaults entsteht, wurde in Welle 1 mit 0-3 widerlegt, siehe [05](05-quellen-und-evidenz.md#widerlegt-x).)
- **Material 3, Farbe:** Der Farbalgorithmus erzeugt aus einer Leitfarbe ein vollständiges, barrierearmes Schema. Standardmäßig entsteht dabei die Variante „Tonal Spot“, die sich von den Markenfarben entfernt. Nah an der Marke bleibt man nur mit der Option „Color match“. Die Rollen sind paarweise gedacht: `on-X` nur auf `X`. Wer sie mischt, verliert Barrierefreiheit.
- **Material 3, Form:** Die Formskala hat sieben Stufen (none bis full), alle standardmäßig abgerundet. Die Typo-Skala hat 15 Stile in fünf Rollen. Beides sind Stellschrauben, an denen ein Projekt eigene Entscheidungen treffen kann, ohne die Zugänglichkeitsregeln aus Abschnitt 1 bis 4 zu verletzen.

**Praktische Folgerung** [F]
1. Übernehmen, was messbar ist und Nutzern hilft: Zielgrößen, Kontrast, Rasterbasis, Zustandsregeln, Dichte-Grundsätze, Formular- und Fehlerregeln.
2. Selbst entscheiden, was die Identität trägt: Schrift, Leitfarbe und Farbrollen, Radien, Leerzustand-Layout, Bewegungscharakter. Zuerst in `DESIGN.md` festhalten, dann in Tokens umsetzen ([01, Abschnitt 1](01-grundlagen-ui-ux.md#1-fundament-design-tokens)).
3. In `DESIGN.md` das Bezugssystem nennen („Zielgrößen nach Fluent 2, Fehlermeldungen nach GOV.UK“). So weiß der Agent, welche Regel gilt, und erfindet keine Mischform.
4. Native Apps folgen der HIG ihrer Plattform. Das ist dort kein Slop, sondern die erwartete Konsistenz.

---

## Lücken dieser Welle

Nicht verifiziert oder gar nicht abgedeckt: Polaris, Primer, Spectrum, Atlassian (über [01](01-grundlagen-ui-ux.md) hinaus), Salesforce Lightning. Außerdem Materials Typo-Skala, Farbrollen, dynamische Farbe und Elevation als geprüfte Zahlen, Apples SF-Schriften, semantische Farben und Dynamic-Type-Stile, Carbons Datentabellen und Benachrichtigungen, Materials Federparameter sowie empirische Belege dafür, dass übernommene System-Defaults als generisch wahrgenommen werden. Die Seiten der Design-Systeme ändern sich ohne versionierte URLs. Alle wurden am 06.11.2026 abgerufen.
