# Workflows und gemeinsame Runs — End-to-End-Umsetzungsplan

Stand: 2026-10-20. Repository-Basis: `74d380bb78e6f5f9e1eb931d238e19a14ac43399`.
Status: Umsetzung seit 2026-10-20 autorisiert und in Arbeit; Abnahme und Deploy
sind Teil des Folgeauftrags. Checklisten werden erst nach geprüftem Nachweis abgehakt.

## 1. Produktauftrag und verbindliche Entscheidungen

**Workflow = wiederverwendbare Anweisung. Run = konkrete Arbeit einschließlich Zustand,
Zusammenarbeit, Ergebnissen und Report.**

Ein Workflow hat genau **ein Ziel**, **1..N Tasks**, **0..N Wissenseinträge/Referenzen** und
**0..N Runs**. Ein Run verwendet eine feste Workflow-Version. Mehrere Agenten können
denselben Run bearbeiten, auch auf unterschiedlichen Hosts und mit unterschiedlichen Engines.
Die Agenten organisieren die Zusammenarbeit innerhalb des erteilten Auftrags selbst:
Sie finden passende Kollegen, laden sich gegenseitig ein und übernehmen Tasks.

Nach jedem beendeten Arbeitsdurchlauf ist eine Evaluation Pflicht. Die AI darf Tasks,
Reihenfolge, Anweisungen und Wissen **vollautomatisch** verbessern. Jede Verbesserung erzeugt
eine begründete neue Workflow-Version. Keine Änderung ist ebenfalls ein gültiges,
begründetes Evaluationsergebnis.

Jeder Run erhält bereits beim Anlegen eine feste UI-Adresse. Diese zeigt zuerst den
Fortschritt und anschließend einen ansprechend gestalteten, nachvollziehbaren Report.
Die abschließende Agentenantwort enthält diesen Link.

### Festgelegte Defaults

- Workflows sind fleetweit und engineunabhängig; keine Pflichtbindung an ein CoCo-Projekt.
- Der Agent führt aus. Der Server speichert, validiert und koordiniert Zuständigkeiten.
  Er interpretiert keine Task-Anweisung als Shell-Code und plant keine Agenten autonom ein.
- Ein Run hat genau einen Koordinator und 1..N angenommene Teilnehmer, sobald er gestartet
  wurde. Vorbereitete Runs dürfen noch keinen Koordinator haben. Der Koordinator darf
  selbst Tasks bearbeiten.
- Jeder aktive Teilnehmer darf passende vorhandene Agenten einladen. Der Nutzer muss
  weder Teilnehmer auswählen noch jede Einladung auslösen. Einladungen starten keine
  neuen Prozesse und reaktivieren keine beendeten nativen Sessions.
- Sobald der zweite Teilnehmer annimmt, entsteht automatisch genau eine Run-Gruppe.
  Sie bleibt bis einschließlich Evaluation offen; danach bleibt sie als Historie lesbar.
- UI-Sprache und Komponenten folgen der vorhandenen englischen Konsole. Dieser Plan und
  die fachlichen Beispiele sind deutsch; gespeicherte Workflows dürfen jede Sprache verwenden.
- Die UI bietet Erstellen/Bearbeiten, Runs vorbereiten, Fortschritt/Reports und
  Wiederherstellung. Ein vorbereiteter Run liefert einen kopierbaren Arbeitsauftrag,
  startet aber keinen Agenten. Die normale Ausführung beginnt im Agentengespräch.
- Das Ziel einschließlich seiner Erfolgskriterien ist die stabile Identität eines
  Workflows. Ein anderes Ziel wird als neuer Workflow angelegt. Automatische Verbesserung
  verändert den Weg zum Ziel, nicht den Erfolgsmaßstab.
- V1 umfasst alle folgenden Funktionen einschließlich Zusammenarbeit und Evaluation.
  Ausgeschlossen sind Cron-Ausführung, automatische Agenten-Spawns, verschachtelte
  Workflows, ein visueller DAG-Editor, ein neuer Wissensdienst, öffentliche Report-Links,
  PDF-Export und ein nativer Android-Editor.
- Das VM-Beispiel ist ein Fachbeispiel. Die Implementierung provisioniert keine reale VM,
  IP oder DNS-Zone und erfindet keine organisationsspezifischen Defaults.

## 2. Geprüfte Integrationspunkte

Vor Beginn die aktuelle Revision und nähere Repository-Anweisungen erneut prüfen.
Die folgende Karte benennt die vorhandenen Anschlüsse; Änderungen bleiben auf die
für das Feature erforderlichen Teile begrenzt.

| Bereich | Vorhandener Anschluss / Konsequenz |
| --- | --- |
| Persistenz | `api/src/db/schema.ts`, handgeschriebene idempotente Migrationen und `api/src/db/README.md`. Auch die generierte `api/src/db/baseline/schema.sql` aktualisieren. |
| Service-Struktur | `roles.ts` mit `roles/` zeigt Fassade, Versionen und authentifizierte Agentenaktionen. Für Workflows eigene Fassade mit kleinen Fachmodulen verwenden. |
| Lesbarer MCP-Katalog | `mcp-tools.ts`, `mcp-resources.ts`, `routes/mcp/index.ts`; bestehende `role_list`/`role://`-Aufteilung als Anschluss verwenden. |
| Agentenaktionen | `routes/agent-messaging/roles.ts`, `AgentMessagingService.authenticateBridge` und `wrappers/cxx/internal/agentbus/roles.go`. Identität aus Session/Bridge ableiten, nicht aus einem vom Aufrufer behaupteten Agenten-UUID-Feld. |
| Zusammenarbeit | `agent-messaging/groups.ts`, `agent-room-chat/index.ts`, `agentRoomEvents`, `agentRoomDeliveries` und die bestehenden Gruppen-/Chat-Werkzeuge. Gruppen sind derzeit immer offen; agentenseitige Antwortanforderungen sind derzeit untersagt. Beide Änderungen nur für Run-Gruppen vornehmen. |
| Anleitung/Discovery | `host-agents.ts`, `managed-agents-features.ts`, `managed-skills.ts`. Feature-Verfügbarkeit, Mindest-Wrapper und Hinweise müssen bei Codex, Claude und Grok übereinstimmen. |
| Rechte | `security/capabilities.ts`, `security/route-capabilities.ts`, `security/authorization-mode.ts`; `requireAdmin` allein genügt nicht. Neue Rechte auch im kompatiblen Autorisierungsmodus durchsetzen. |
| WebUI | Svelte-SPA mit `/admin`-Basis; `nav.ts`, TanStack Query, zentrale `ws/events.ts`-Invalidierung und `DESIGN.md`. |
| Tests | API-Vitest plus echte MySQL-Integration; `npm test` allein lässt DB-Suites aus. Browser-Fixtures beweisen kein echtes Backend-E2E. |
| Lieferung | Wrapper-Version in `wrappers/Makefile`, committed SPA unter `public/admin`, `scripts/deploy.sh` für autorisierten Rollout. |

Kein aktives CoCo-Projekt für dieses Repository wurde in der aktuellen Projektliste
gefunden. Die Umsetzung benötigt keine neue Projektanlage.

## 3. Domänenmodell und Datenverträge

### 3.1 Workflow und unveränderliche Version

Ein Workflow besitzt UUID, unveränderlichen eindeutigen Slug, Erstellungsmetadaten,
`active|archived`, einen aktuellen Versionszeiger und eine Kontrollrevision.
Anlegen veröffentlicht atomar Version 1; halbfertige Formulare bleiben UI-Entwürfe.
Ein archivierter Workflow bleibt samt Runs lesbar, nimmt aber keine neuen Runs an.
V1 bietet Archivieren und Wiederherstellen, kein hartes Löschen.

Der Inhalt einer Version ist ein validiertes JSON-Dokument mit `schema_version: 1`:

| Feld | Verbindlicher Inhalt |
| --- | --- |
| `title`, `summary` | Kurzer Name und Beschreibung für Suche/Katalog. |
| `goal` | Ein Objekt `{statement, success_criteria:[{id, text}]}` mit mindestens einem prüfbaren Kriterium. |
| `inputs` | Benannte Parameter `{key, label, type, required, default?, options?, description?}`; Typen `string`, `number`, `boolean`, `enum`. Keine Ausdrücke oder ausführbare Templates. |
| `tasks` | Geordnete Liste `{id, title, instructions, acceptance_criteria, depends_on, knowledge_ids, execution_hint?}`. Stabile Task-IDs innerhalb der Versionslinie. |
| `knowledge` | Liste mit stabiler ID, Titel und entweder `inline`-Markdown oder einer `reference` mit URI und optionalem Lesehinweis. |

`depends_on` ist explizit. Die UI legt neue Tasks zunächst sequentiell an, bietet
aber eine zugängliche Auswahl mehrerer Vorgänger. Leere Abhängigkeiten bedeuten
unabhängig ausführbar. IDs müssen eindeutig sein; unbekannte Referenzen, Selbstbezüge
und Zyklen werden abgewiesen. Die Reihenfolge ist Darstellung und Gleichstandsregel,
kein zusätzlicher Scheduler.

`execution_hint` beschreibt benötigten Ort oder Zugang, etwa „auf Hypervisor X“ oder
„Agent mit Zugriff auf Netz Y“. Es erteilt keine Host- oder Credential-Berechtigung.
Der ausführende Agent prüft die tatsächliche Umgebung.

Versionen speichern fortlaufende Nummer, kanonischen Inhalts-SHA-256, Vorgängerversion,
Autor, Zeit, Änderungsgrund und optional `source_run_id`. Vollständige neue Inhalte
werden mit `expected_version` auf den aktuellen Kopf geschrieben. Serverberechneter
Diff und Änderungsgrund werden angezeigt. Eine Wiederherstellung erzeugt eine neue
Version mit dem Inhalt einer älteren; historische Nummern werden nie zurückgedreht.

### 3.2 Wissen und Ergebnisse

- Zulässige Referenzen: `shared://`, `project://…/memory/…`, `project://…/files/…`,
  `skill://` sowie `https://` und `http://` für vorhandene Wissenssysteme.
  Hostlokales `memory://` wird in fleetweiten Vorlagen abgewiesen.
- Referenzen werden beim Bearbeiten syntaktisch geprüft. Externe Links werden vom
  API-Server nicht abgerufen. Interne Inhalte werden vom Agenten durch die existierenden
  Werkzeuge mit deren normalen Zugriffsregeln gelesen.
- Ein Run speichert pro verwendeter Quelle URI, Titel, Lesezeit, Digest/Revision soweit
  verfügbar und eine kurze relevante Zusammenfassung. Externe Änderungen sind damit
  sichtbar, ohne fremde Wissensbestände vollständig zu duplizieren.
- Fehlendes oder unzugängliches Wissen wird als Befund festgehalten. Ein betroffener
  Task wird blockiert, wenn seine sichere Ausführung davon abhängt; optionales Material
  darf mit Begründung entfallen.
- Task-Ergebnisse sind strukturierte, benannte JSON-Werte plus Zusammenfassung und
  Nachweise. Abhängige Tasks lesen sie über `tasks.<task_id>.outputs.<key>` als Daten.
  Kein globales, unkontrolliert überschreibbares Variablenobjekt.
- Nachweise tragen stabile ID, Beschreibung, Typ, Zeit, optional URI/Hash und
  Ausführungshost. Serverpfade oder Pfade auf VM A werden für Agent B nicht automatisch
  zu zugänglichen Dateien. Für Dateien existierende Transfer-/Attachment-/Projekt-
  Schnittstellen verwenden; kurzlebige Downloads mit Ablaufzeit kennzeichnen.
- Geheimnisse bleiben im Secrets Store. Inputs, Ergebnisse, Gruppenchat, Evaluation
  und Report enthalten Referenzen oder bereinigte Nachweise, keine Secret-Werte.
  Der Server darf keine automatische Vollständigkeit einer Secret-Erkennung behaupten.

### 3.3 Run, Teilnehmer und Tasks

Ein Run speichert UUID, Workflow-/Versions-ID samt Digest, Titel, Eingaben,
Ersteller, Zeiten, Koordinator, Koordinator-Generation/-Lease, Kontrollrevision,
Event-Sequenz, Status, Ergebnis und Reportdaten. Run-Titel und Inputs sind im
Status `pending` editierbar; ab `running` fixiert. Eine neue Ausführung erhält
eine neue Run-ID. Ein abgeschlossener Run wird nicht wieder geöffnet.

Teilnehmer sind durch kanonische Agentenadresse identifiziert; Session-ID,
Binding-Generation, Host, Engine und Anzeigename werden als überprüfte Zuordnung
und historische Momentaufnahme mitgeführt. Name oder Host allein sind keine Identität.
Ein Agent darf an mehreren Runs teilnehmen; ein globaler „aktueller Run“ ist nicht
die Quelle der Wahrheit. Schreibende Werkzeuge verlangen immer `run_id`.

Pro Run-Task existieren Status, aktuelle Revision, claimender Teilnehmer, Claim-
Generation/-Lease und eine fortlaufende Folge von Versuchen. Jeder Versuch enthält
Start/Ende, Status, Outputs, Nachweise, Fehler und tatsächlichen Ausführungshost.
Wiederholungen hängen einen Versuch an; frühere Fehlschläge bleiben im Report.

Tasks dürfen unabhängig voneinander parallel bearbeitet werden. Derselbe Task hat
höchstens einen gültigen Ausführungsclaim. Zusammenarbeit an einem Task erfolgt über
einen verantwortlichen Claim-Inhaber und Beiträge anderer Teilnehmer; zwei gleichzeitig
handelnde Task-Owner sind ausgeschlossen.

### 3.4 Persistenz

Neue Tabellen als zusammenhängendes Modell anlegen:

| Tabelle | Zweck / wesentliche Schlüssel |
| --- | --- |
| `workflows` | Identität, Status, aktueller Versionszeiger, Kontrollrevision; eindeutiger Slug. |
| `workflow_versions` | Unveränderliches Dokument, Digest, Herkunft; unique `(workflow_id, version)`. |
| `workflow_runs` | Gepinnte Version, Steuerzustand, Koordinator, Ergebnis, Report; optional eindeutige `communication_group_id`. |
| `workflow_run_members` | Mitgliedschaft und Identität; unique `(run_id, agent_address_id)`, Zustände `active`, `left`, `removed`. |
| `workflow_run_invitations` | Einladender, Zieladresse/-Binding, Grund, vorgeschlagene Task-IDs, Ablauf, Zustellung und Status `pending`, `accepted`, `declined`, `expired`, `revoked`. |
| `workflow_run_tasks` | Materialisierter Task-Zustand, Revision und Claim; unique `(run_id, task_id)`. |
| `workflow_task_attempts` | Unveränderliche abgeschlossene Versuche; unique `(run_id, task_id, attempt_no)`. |
| `workflow_run_events` | Append-only fachliche Historie mit Actor und Sequenz; unique `(run_id, sequence)`. |
| `workflow_run_evaluations` | Ein Evaluationsdatensatz pro Run, Entwurf bis final; Ergebnis, Befunde, Verbesserungsentscheidung und angewandte Version. |
| `workflow_mutations` | Idempotenzbelege: Actor, Operation, Request-UUID, Payload-Hash und bereinigte Antwort. |

Vorlagen-Tasks und Wissen liegen im Versionsdokument, nicht zusätzlich als unabhängig
änderbare Stammdatensätze. Live-Reports sind Projektionen; der Abschluss speichert
einen `report_schema_version: 1`-Snapshot mit Zusammenfassung, Resultaten,
Kriterienbewertung und Referenzen auf nun unveränderliche Tasks/Versuche/Evaluation.
Große Task-Outputs werden dabei nicht ein zweites Mal eingebettet.
Events, Tasks und Versuche sind paginiert.
Admin-/Agenten-/Host-Löschungen dürfen Run-Historie nicht kaskadierend entfernen;
historische Actor-Momentaufnahmen bleiben erhalten.

Indizes für Workflow-Suche/Status, Runs nach Workflow/Zeit/Status, ausstehende
Evaluationen, Mitgliedschaften nach Agent, Einladungen nach Empfänger/Status,
Task-Claims und Event-Cursor hinzufügen. Datumsformat und UUID-Typen entsprechen
den vorhandenen Tabellen. Begrenzungen zentral definieren: 200 Tasks, 100 Wissenseinträge,
64 Inputs, 32 aktive Teilnehmer einschließlich Koordinator, 512 KiB Versionsdokument,
64 KiB pro Ergebnis/Evaluations-Textblock, maximal 100 Einträge pro Listenseite.
Validierungsfehler nennen das betroffene Feld; nichts wird still gekürzt.

## 4. Lebenszyklus, Zuständigkeit und Fehlerfälle

### 4.1 Run-Zustand und fachliches Ergebnis

| Status | Bedeutung und erlaubter Übergang |
| --- | --- |
| `pending` | Angelegt, noch keine Ausführung. Erster Koordinator übernimmt → `running`; beenden ohne Ausführung → `evaluating` mit `canceled`. |
| `running` | Tasks werden bearbeitet. → `paused`, `blocked` oder nach Arbeitsabschluss → `evaluating`. |
| `paused` | Bewusste Pause. Keine neuen Tasks; laufende Versuche dürfen Ergebnisse melden. → `running` oder `evaluating`. |
| `blocked` | Fortsetzung benötigt eine benannte Voraussetzung. → `running` nach dokumentierter Auflösung oder → `evaluating`. |
| `evaluating` | Externe Arbeit beendet; Ergebnis gespeichert; Evaluation/Verbesserung offen. → `completed` erst nach vollständiger Finalisierung. |
| `completed` | Report, Evaluation und Verbesserungsentscheidung gespeichert; Run-Inhalt unveränderlich. |

`outcome` ist getrennt und beim Arbeitsabschluss eines von
`succeeded|partial|failed|canceled|unknown`. Ein `completed` Run kann fehlgeschlagen sein.
Offline, Lease-Ablauf oder ein erfolgreicher HTTP-Aufruf sind kein Arbeitsergebnis.

Jedes Zielkriterium erhält beim Abschluss `met|not_met|unverified` mit Begründung und
Nachweisreferenzen. `succeeded` erfordert alle Kriterien `met`, keine ungeklärten
Versuche und nur erfolgreiche oder begründet nicht anwendbare Tasks. `partial`
benötigt mindestens ein erreichtes, aber nicht alle erreichten Kriterien.
Ungewisse externe Auswirkungen werden als `unknown` dokumentiert. Der Server
prüft diese strukturelle Konsistenz, nicht die Wahrheit einer entfernten VM.

### 4.2 Task-Zustand und Claims

Task-Status: `pending|running|blocked|succeeded|failed|skipped|uncertain`.
Ein Claim auf einen ausführbaren Task startet atomar einen Versuch. Vorbedingungen:
Run läuft, Teilnehmer aktiv, kein anderer gültiger Claim, alle Abhängigkeiten
`succeeded` oder `skipped` mit Grund `not_applicable`.
`skipped` wegen vorzeitigem Run-Ende erfüllt keine Abhängigkeit.

- Claims sind 30 Minuten gültig; der Agent erneuert spätestens nach 10 Minuten und
  vor weiteren externen Änderungen. Serverzeit ist maßgeblich.
- Claim-Inhaber, Session-Binding und Generation werden bei jedem Write geprüft.
  Lease-Ablauf macht laufende Arbeit `uncertain`; kein automatischer Retry und kein
  automatisches „fehlgeschlagen“. UI und Leseantwort zeigen den Ablauf sofort;
  der nächste Zustands-Write materialisiert ihn transaktional.
- `reconcile` mit `stage: begin` erwirbt atomar einen Recovery-Claim auf einen
  ungewissen Task, ohne einen neuen Ausführungsversuch zu starten. `stage: resolve`
  verlangt dessen gültiges Token und die Untersuchungsergebnisse.
  Alter Prozess, Zielsystem und vorhandenes Ergebnis werden
  geprüft. Erst nach Nachweis, dass keine alte Ausführung mehr läuft, darf ein
  verifizierter Erfolg übernommen oder ein neuer Versuch freigegeben werden.
  Wenn das nicht feststellbar ist, bleibt der Task `uncertain`.
  `verified_success` schließt den bisherigen Versuch mit Nachweisen,
  `safe_to_retry` beendet ihn als fehlgeschlagen und erlaubt einen expliziten Retry;
  `still_uncertain` erhält die Ungewissheit. Der Recovery-Claim wird dabei freigegeben.
- Wiederaufnahme derselben authentifizierten Kontinuität ist möglich. Eine andere
  Binding-Generation erhält weder Mitgliedschaft noch Claim stillschweigend.
- Erfolgreiche Tasks werden innerhalb desselben Runs nicht neu ausgeführt.
  Veränderte Inputs oder eine vollständige Wiederholung ergeben einen neuen Run.
- `retry` ist für aktive Teilnehmer bei einem fehlgeschlagenen, claimfreien Task
  mit Begründung und Task-CAS erlaubt; es setzt ihn auf `pending`. Erst das nächste
  `acquire` eröffnet einen neuen Versuch. `release` eines laufenden Claims muss
  einen beendeten Versuch nachweisen oder ihn `uncertain` setzen, niemals still
  zu `pending` zurückkehren.
- Task-Ergebnis-Write und Event werden atomar gespeichert. Getrennte Tasks verwenden
  getrennte `expected_task_version`-Werte und verursachen keine künstlichen
  Versionskonflikte durch parallelen Fortschritt anderer Tasks.

Task-Claims ersetzen weder externe Idempotenz noch Ressourcenclaims der Fleet.
Vor einem Zielsystem-Write muss der Agent weiterhin dessen Zustand und seine
Berechtigung prüfen. Die UI sagt ausdrücklich, dass Pause/Abbruch keinen bereits
laufenden externen Prozess beendet.

### 4.3 Koordination und Übernahme

Der Ersteller wird beim Agenten-Start Koordinator; ein UI-Run bleibt bis zur ersten
Übernahme unbesetzt. Koordination besitzt ebenfalls eine 30-Minuten-Lease mit
Generation. Der Koordinator steuert Pause/Fortsetzung, Arbeitsabschluss, Evaluation
und Teilnehmerentfernung. Seine eigenen Task-Claims sind davon getrennt.

Eine Übergabe an einen aktiven Teilnehmer ist atomar möglich. Nach Ablauf der
Koordinator-Lease kann ein aktiver Teilnehmer per Compare-and-swap die Koordination
übernehmen; diese Übernahme startet keine fremden Tasks neu. Der frühere Koordinator
kann anschließend mit seiner alten Generation weder beenden noch evaluieren.
Ohne erreichbaren Teilnehmer bleibt der Run offen und in der UI auffindbar.
Ein Operator kann einen existierenden Agenten als Ersatz zulassen; das ist eine
Wiederherstellungsfunktion, kein normaler Einladungsschritt.

Bei `pause` werden neue Claims gesperrt, Ergebnisse laufender Tasks bleiben zulässig.
`cancel_requested` stoppt weitere Claims und sendet gezielte Koordinationsnachrichten
an aktive Bearbeiter. `finish` mit `canceled` erfolgt erst, wenn Versuche beendet
oder ausdrücklich als ungewiss dokumentiert sind. Ein verschwundener Teilnehmer
wird nicht durch einen erfolgreichen Abbruch ersetzt.

Bei vorzeitigem `finish` werden noch nicht gestartete Tasks atomar als `skipped`
mit Grund `run_ended` markiert. Ein bekanntermaßen laufender Versuch verhindert
`finish`. Nicht mehr aufklärbare, abgelaufene Versuche dürfen nur mit ausdrücklich
genannten Task-IDs und `outcome: unknown` in den Abschluss übernommen werden;
der Report benennt verbleibende externe Risiken. Fencing verhindert spätere
Statusänderungen, ist aber kein Beleg für das Ende eines entfernten Prozesses.

## 5. Selbstständige Agentenzusammenarbeit und Run-Gruppe

### 5.1 Einladung und Beitritt

1. Ein aktiver Teilnehmer erkennt anhand eines Tasks, welcher Zugriff oder welche
   Fähigkeit fehlt. Er sucht vorhandene Agenten über `agent_list` und löst einen
   Namen über `agent_translate` eindeutig auf. Bei Mehrdeutigkeit wählt er nicht
   anhand eines ähnlich klingenden Namens.
2. `agent_workflow_invite` speichert eine Einladung mit Run-ID, Zieladresse,
   Ziel-Binding, Grund und optional vorgeschlagenen Tasks. Andere aktive Teilnehmer
   dürfen ebenfalls einladen; der Koordinator ist kein obligatorischer Vermittler.
3. Eine gezielte Nachricht `WORKFLOW-INVITE/1` enthält Einladung-ID, Run-ID, Ziel,
   begrenzten Aufgabenbereich und Report-Link. Zustellung erfolgt als
   `delivery_class: coordination`, `kind: message`, mit stabiler Idempotenz-UUID.
   Sie erzeugt keinen zweiten angenommenen Bus-Arbeitsauftrag neben dem Task-Claim.
4. Nur der adressierte Agent kann annehmen oder ablehnen. Er liest Run und Vorlage,
   prüft Zugriff und eigene laufende Verpflichtungen und entscheidet innerhalb
   seines vorhandenen Auftrags. Annahme ist keine Bestätigung erledigter Arbeit.
5. Annahme legt die Mitgliedschaft an. Vorgeschlagene Tasks bleiben unbeansprucht,
   bis der Teilnehmer sie ausdrücklich claimt. Einladungen laufen nach 24 Stunden ab;
   abgelehnte/abgelaufene Einladungen werden nicht automatisch erneut versendet.

Pro Run/Ziel-Binding darf höchstens eine offene Einladung existieren. Wiederholte
Einladungen liefern dieselbe offene Einladung, aktive Mitgliedschaft einen No-op.
Einladungen an sich selbst, nicht mehr gültige Bindings oder in abgeschlossene Runs
werden abgewiesen. Nichtmitglieder können weder einladen noch Tasks claimen.
Die Einladungsnachricht enthält nur die für die Entscheidung erforderlichen Run-Daten.
Vorlagen und bereinigte Run-Reports folgen den normalen fleetweiten Leserechten;
Teilnahme begrenzt die Ausführung und den Gruppenzugang, nicht den lesbaren Katalog.

Einladung und Bus-Nachricht werden in derselben Datenbanktransaktion angelegt.
Dazu den bestehenden validierenden Messaging-Enqueue-Pfad für eine übergebene
Transaktion nutzbar machen; keine zweite, ungesicherte Queue-Implementierung und
keine Speicherung eines Bridge-Tokens für spätere Serverjobs. Nach Commit darf
WS-Benachrichtigung scheitern, ohne dass Einladung oder Nachricht verloren gehen.
Tests sichern die einheitliche Sperrreihenfolge Messaging → Run → Task.

`#invite` ist ein agentenseitiger Einstieg in diesen Ablauf, kein vom Nutzer
auszufüllendes Formular. Es existiert aktuell kein Fleet-Skill dieses Namens.
Die Umsetzung liefert einen kleinen code-managed Skill `invite`, der auf die
Zusammenarbeitsanleitung des Skills `workflows` verweist. Seine Beschreibung erlaubt
auch implizite Verwendung, wenn ein Teilnehmer für seinen aktiven Run Unterstützung
benötigt. Außerhalb eines eindeutigen Run-Kontexts wird keine Einladung erzeugt.

### 5.2 Automatische Gruppe

- Beim zweiten angenommenen Teilnehmer atomar eine Gruppe mit deterministischem Slug
  `workflow-run-<run-uuid>` und eindeutigem Bezug zum Run anlegen. Alle aktiven
  Teilnehmer werden eingeschrieben; spätere Beitritte werden automatisch ergänzt.
  Zwei gleichzeitige Annahmen erzeugen genau eine Gruppe.
- Der automatische Beitritt ist Teil der angenommenen Run-Einladung. Die bestehenden
  Opt-in-Regeln gewöhnlicher Gruppen bleiben erhalten. Bestehende Teilnehmer-/
  Subscription-Limits gelten; bei Erreichen rollt die Annahme vollständig zurück.
- Run-Mitgliedschaft ist die Quelle der Wahrheit. Generische Subscribe/Delete/
  Gruppenverwaltungswege dürfen Run-Zutritt, Entfernung oder Gruppenabschluss nicht
  umgehen. Solche Operationen verweisen auf die entsprechenden Run-Aktionen.
- Einen kleinen gemeinsamen Resolver für verwaltete Run-Gruppen verwenden, den
  Gruppenservice, Room-Chat und Attachments aufrufen. Keine gegenseitige
  Konstruktion von WorkflowService und MessagingService.
- `agent_chat_read/send` und vorhandene Attachments wiederverwenden. Zur Run-Gruppe
  gibt es einen stabilen `room_id`, `group_topic` und `communication_url` im Run.
- In **offenen Run-Gruppen** dürfen aktive Agenten mit `recipients` gezielt andere
  aktive Teilnehmer um eine Antwort bitten. `ask_all` bleibt operatorseitig;
  agentenseitige gezielte Fragen höchstens 10 Empfänger, ohne Selbstzustellung.
  Gewöhnliche Gruppen, Conferences sowie Host-/Projekt-Räume behalten ihre Regeln.
- Gezielte Fragen nutzen bestehende Room-Events und Delivery-Receipts mit
  Koordinationsklasse. Jede Antwort referenziert `reply_to`. Antworten und normale
  Fortschrittsnachrichten wecken ohne explizite Empfänger keine Kollegen.
  Empfangsbestätigungen lösen keine Bestätigungsschleifen aus.
- Neue Run-Fragen tragen `WORKFLOW-QUESTION/1`, Run-/Room-/Event-ID und die
  authentifizierte Absenderadresse. Der bestehende Nachrichtentext „The operator
  requests one answer“ darf dafür nicht wiederverwendet werden. Verwaltete
  Shared-Chat-Anleitung und Tool-Beschreibungen nennen die enge Ausnahme für
  explizite Teilnehmerfragen in Run-Gruppen; allgemeine Agentenantworten bleiben
  ohne automatische Rückfrage.
- Fachliche Task-Ergebnisse werden zuerst im Run gespeichert. Chat ist Abstimmung
  und Diskussion; Chattext allein verändert keinen Task-Status.
- Ein Austritt entfernt die aktive Subscription, erhält aber Teilnehmerhistorie
  und Leserecht auf die eigene Run-Gruppe. Mit aktivem Task muss zuerst dessen
  Zustand geklärt werden; Entfernen eines ausgefallenen Bearbeiters markiert seinen
  laufenden Versuch `uncertain`.
- Bei Run-Abschluss werden Gruppe und Schreibrecht atomar geschlossen und aktive
  Subscriptions entfernt. Gruppenrow, Chat-Events und gültige Attachments bleiben
  lesbar. Normales Gruppenlöschen darf diesen Report-Anschluss nicht zerstören.
  Historische Run-Gruppen zählen nicht gegen aktive Gruppen-/Subscription-Limits.
- Die bestehende Retention darf referenzierte Run-Gruppen/Events/Attachments nicht
  als verwaist entsorgen. Leserechte geschlossener Gruppen folgen der gespeicherten
  Run-Teilnehmerhistorie, nicht den beim Abschluss entfernten Subscriptions.
  Eine allgemeine Retention für abgeschlossene Runs gehört nicht zu V1.
- Gruppenlisten/Chat-Listen unterstützen diese geschlossenen Gruppen unter „History“.
  Ein Run, der wieder nur einen Teilnehmer hat, behält seine bereits angelegte Gruppe.

Für Reports gelten die normalen Run-Leserechte. Das Öffnen vollständiger
Kommunikationsinhalte bleibt zusätzlich an `agent_messaging.reveal_content` gebunden;
Run-Leserecht schaltet keine fremden Chat- oder Transcript-Rechte frei.

## 6. Evaluation und automatische Verbesserung

Der Koordinator beendet zunächst die Arbeit mit `agent_workflow_run_finish`.
Diese atomare Operation prüft Tasks und Kriterien, speichert Outcome, Zusammenfassung,
Ergebnisse/offene Punkte und setzt `status=evaluating`, Evaluation `pending`.
Alle Teilnehmer können davor Befunde und Verbesserungshinweise als Run-Beiträge speichern.

Der Koordinator liest für die Evaluation die gepinnte **und** die aktuelle
Workflow-Version, alle Task-Versuche, relevante Beiträge und Nachweise. Er beurteilt:

1. Zielerreichung und Verlässlichkeit der Nachweise.
2. Fehlende, unklare oder unnötige Arbeitsschritte und Abhängigkeiten.
3. Qualität und Aktualität der Wissensreferenzen.
4. Zusammenarbeit, sinnvolle Parallelität und vermeidbare Übergabeverluste.
5. Ob die Beobachtung allgemein für diese Vorlage gilt oder nur diesen Run betrifft.

Ein Evaluationsentwurf speichert `findings`, `lessons`, `decision: no_change|revise`,
Begründung und gegebenenfalls das vollständige neue Versionsdokument plus erwartete
Kopfversion. Befunde verweisen auf Task-/Event-/Evidence-IDs. Es gibt keinen
zusätzlichen Judge-Dienst, keine Pflicht zu einem anderen Modell und keine
menschliche Freigabeschleife. Die fachliche Bewertung erfolgt durch den Agenten.

Die Finalisierung ist eine Transaktion:

- `no_change`: vollständige begründete Evaluation festschreiben.
- `revise`: Schema, unverändertes Ziel/Kriterien, Abhängigkeiten und
  `expected_workflow_version` prüfen; genau eine neue Workflow-Version mit
  Herkunft aus diesem Run veröffentlichen.
- Anschließend Evaluation finalisieren, Report-Snapshot erzeugen, Run `completed`
  setzen, Einladungen schließen und Run-Gruppe schreibschützen.
- Eine identische Dokumentversion erzeugt keinen künstlichen Versionssprung:
  Finalisierung mit `no_change` und begründetem Ergebnis „bereits enthalten“.

Ist inzwischen eine andere Version veröffentlicht, bleibt der Entwurf erhalten;
die Finalisierung liefert einen Konflikt mit aktuellem Kopf. Der Koordinator liest
neu, überträgt nur weiterhin sinnvolle Änderungen und finalisiert mit neuer
Request-UUID. Kein Last-writer-wins und kein automatisches textuelles Überschreiben.
Auch ein inzwischen archivierter Workflow darf eine Evaluation/Version erhalten,
bleibt aber archiviert.

Nach Crash, Validierungsfehler oder verlorenem ACK bleibt Evaluation sichtbar
ausstehend beziehungsweise über denselben Request erneut abrufbar. Ein neuer
Koordinator kann übernehmen. Der Server erfindet keine Evaluation und startet dafür
keine Session. „Jeder Run wird evaluiert“ wird als Abschlussinvariante umgesetzt,
nicht als unbelegte Garantie, dass ein ausgefallener Agent von selbst zurückkommt.

Weder Evaluation noch automatische Revision schreiben beiläufig referenzierte Memories
oder Skills um. Sie verbessern den Workflow und seine Referenzen; Änderungen an
Wissensquellen unterliegen deren eigenem Auftrag und Vertrag.

## 7. API, MCP und Wrapper

### 7.1 Gemeinsame Regeln

Zod-Verträge und Fachlogik liegen in `api/src/services/workflows/` hinter einer
`WorkflowsService`-Fassade. Fachmodule: Vertrag/Validierung, Vorlagen/Versionen,
Runs/Tasks/Claims, Mitglieder/Einladungen, Evaluation und Reports.
Admin- und Bridge-Routen sind dünne Adapter derselben Operationen.

Jede Mutation benötigt eine stabile `client_request_id`. Uniqueness gilt für
authentifizierten Actor + Operation + UUID. Derselbe Request mit gleichem Inhalt
liefert denselben Beleg; anderer Inhalt unter derselben UUID ist ein Konflikt.
Authentifizierung wird auch beim Replay geprüft; der Beleg wird vor veralteten
CAS-/Lease-Prüfungen geprüft, damit ein verlorenes Erfolgs-ACK wiederholbar bleibt.
Antworten enthalten keine Claim-Tokens in Events/Listen/Logs.

Schreiboperationen auf Steuerzustand erwarten `expected_run_version`, Task-Operationen
`expected_task_version`, Versionsänderungen `expected_workflow_version`. Zu jeder
Run-Antwort gehören `run_id`, Status/Outcome, relevante Revisionen und `report_url`.
Claim-Tokens werden nur an den authentifizierten Inhaber ausgegeben, gehasht geprüft
und für idempotente Wiederholung verschlüsselt gespeichert.

Zeitkritische Zustände werden innerhalb kurzer DB-Transaktionen gesperrt. Kein
Netzwerkaufruf und keine AI-Inferenz innerhalb einer Transaktion. WS-Ereignisse erst
nach Commit. Fehler liefern maschinenlesbaren Code und sichere Konfliktdetails:
`workflow_version_conflict`, `workflow_run_version_conflict`, `workflow_task_claimed`,
`workflow_claim_lost`, `workflow_task_uncertain`, `workflow_dependency_unmet`,
`workflow_member_required`, `workflow_invitation_expired`, `workflow_evaluation_pending`.

### 7.2 Werkzeuge

Lesende Werkzeuge auf dem zentralen `cdx`/`clx`/`cgx`-MCP:

| Werkzeug | Vertrag |
| --- | --- |
| `workflow_list` | Suche/Status, paginierte Metadaten; Verfügbarkeit separat von leerer Liste. |
| `workflow_get` | Slug/UUID, optional Version; vollständige validierte Anweisung und Versionsmetadaten. |
| `workflow_run_list` | Filter Workflow, Status, Outcome, Agent, Evaluation; paginierte Zusammenfassungen. |
| `workflow_run_get` | Run-ID; standardmäßig kompakter Snapshot mit Task-Zusammenfassungen, Teilnehmern und Report-Link. Task-ID/Cursor laden Outputs, Versuche oder Events gezielt; keine Secrets/Claims oder vollständigen Chats. |

Ressourcen: `workflow://<slug>` und `workflow://<slug>@<version>`.
Beide sind read-only; generische `resource_update/delete` bleiben dafür unzulässig.
Kein automatisches rekursives Laden aller referenzierten Quellen.

Identitätsgebundene Werkzeuge auf `cxx-agent`:

| Werkzeug | Operation / besondere Eingaben |
| --- | --- |
| `agent_workflow_create` | Vollständige Vorlage, Slug, Änderungsgrund. |
| `agent_workflow_revise` | Vollständiges Dokument, erwarteter Kopf, Begründung; optional Quelle Run. |
| `agent_workflow_archive` | `archive` oder `restore`, Workflow-ID, Kontrollrevision, Grund. |
| `agent_workflow_run_create` | Workflow-ID, konkrete Version oder `latest`, Titel, Inputs; legt Mitgliedschaft/Koordination an. |
| `agent_workflow_run_control` | `configure`, `start`, `pause`, `resume`, `block`, `request_cancel`, `coordinator_acquire`, `coordinator_renew`, `coordinator_transfer`; `configure` nur bei `pending`, Übergänge aus Abschnitt 4. |
| `agent_workflow_run_current` | Eigene offene Mitgliedschaften, Einladungen, Claims und ausstehende Evaluationen; nach Resume aufrufen. |
| `agent_workflow_invite` | Run-ID, Zieladresse, Grund, optionale Task-IDs. |
| `agent_workflow_membership` | `accept`, `decline`, `leave`, `remove`, `revoke_invitation`; Einladung/Teilnehmer und Grund; Actor-Regeln serverseitig. |
| `agent_workflow_task_claim` | `acquire`, `renew`, `release`, `reconcile`, Task-ID; Reconcile hat `stage: begin` oder `resolve`, bei Resolve Token, Belege und `verified_success`, `safe_to_retry` oder `still_uncertain`. |
| `agent_workflow_task_update` | Task-ID, Claim-Token/-Generation, Task-Revision, Status, Outputs, Nachweise, Fehler; gesonderte, begründete `retry`-Operation. |
| `agent_workflow_run_note` | Append-only Beitrag: Notiz, Wissensnutzung oder Verbesserungshinweis; optional Task-/Evidence-Bezug. |
| `agent_workflow_run_finish` | Koordinator-Generation, fachliches Outcome, alle Zielkriterien, Zusammenfassung, Resultate und offene Punkte. |
| `agent_workflow_run_evaluate` | `save_draft` oder `finalize`, Evaluationsrevision; strukturierte Bewertung, bei Änderung erwarteter Workflow-Kopf und Dokument. |

Für Steuer- und Claim-Werkzeuge `oneOf`/diskriminierte Schemas je Aktion verwenden;
keine beliebigen JSON-Patches. Berechtigung und notwendige Felder jeder Aktion
in HTTP-/MCP-Dokumentation und Schema-Tests festhalten.

Bridge-Routen liegen unter
`/host/agent-sessions/:id/agent-messaging/workflows/<operation>`.
`authenticateBridge` plus aktuelle Address-/Binding-Prüfung wiederverwenden.
Ein vom Client geliefertes `host_id`, `engine` oder `agent_uuid` ersetzt diese Prüfung nie.
Nachfolgende Ergebnisreads verwenden die im Claim gespeicherten historischen IDs.

### 7.3 Admin-Schnittstellen

API-Pfade bewusst von Browserpfaden trennen:

- `GET/POST /admin/workflow-definitions/state` für Zustand/Modulschalter.
- `GET/POST /admin/workflow-definitions` für Liste/Erstellung.
- `GET /admin/workflow-definitions/:id`, `GET …/:id/versions`,
  `GET …/:id/versions/:version`; `POST …/:id/revise`, `…/archive`,
  `…/restore`, `…/revert` für explizite Änderungen.
- `GET/POST /admin/workflow-runs` für Listen und vorbereitete Runs.
- `GET /admin/workflow-runs/:id`, `GET …/:id/events`, `GET …/:id/report`.
- `GET …/:id/tasks/:taskId` für gezielte Outputs und paginierte Versuche.
- `POST …/:id/control` für Pause, Wiederaufnahme, Abbruchanforderung und
  Koordinator-Recovery sowie Konfiguration eines `pending` Runs;
  UI-Steuerung verwendet dieselben Zustandsregeln.
- `POST …/:id/prepare-cancel` nur für einen ungestarteten, unbesetzten Run:
  setzt Outcome `canceled` und Evaluation `pending`, ohne AI-Bewertung vorzutäuschen.

Kein Admin-Button markiert einen Run unter Umgehung von Nachweisen/Evaluation
erfolgreich. UI-Recovery weist einen existierenden Agenten zu und liefert den
Fortsetzungsauftrag, startet aber keine Session.

Neue Fähigkeiten `workflows.read`, `workflows.manage`, `workflows.run`:
Lesen entsprechend bestehenden lesenden Rollen; Verwalten entsprechend
Content-Verwaltung; Run-Steuerung für Trusted/Fleet/Admin/Owner. In der zentralen
Matrix eintragen und für neue Rechte unter `compatible` ebenfalls erzwingen.
UI und API beziehen Berechtigung aus dieser Matrix. Chat-Reveal bleibt separat.

### 7.4 Modul, Agentenanleitung und Parität

`workflows_enabled` ist ein eigenständiger Modulschalter, initial aus. Die einzige
editierbare Heimat ist die Workflows-Seite. Einschalten startet keine Runs.
Ausschalten sperrt neue Runs, Einladungen und freie Agenten-Vorlagenänderungen.
Bereits angelegte Runs dürfen weiter dokumentiert, übernommen, beendet und evaluiert
werden, einschließlich der zugehörigen Evaluationsrevision. Die UI erklärt dieses
Auslaufen ausdrücklich. Ein harter Stopp erfolgt durch Run-Steuerung beziehungsweise
die bestehenden Host-/Engine-Schalter, nicht durch verdecktes Prozessmanagement.

Lesende Katalog-/Run-Werkzeuge bleiben mit explizitem `enabled`-Status und Historie
verfügbar. Bridge-Werkzeuge bleiben discoverbar wie bestehende Rollenwerkzeuge;
jede Operation prüft ihren tatsächlichen Zustand. Verwaltete Anleitungen sind
bei aktivem Modul oder eigenen offenen Runs verfügbar, abhängig von MCP,
Agent-Messaging und tatsächlichem Wrapper-Protokoll.

Neues `workflow_protocol_version: 1` in den Agenten-Adapter-Capabilities.
Server akzeptiert Teilnehmer nur mit unterstütztem Protokoll; ältere Wrapper
bekommen verständliche Upgrade-Hinweise und keine Arbeitszuweisung. Die Mindestversion
ist die bei Umsetzung tatsächlich veröffentlichte Wrapper-Version, nicht die
in diesem Plan beobachtete `0.9.110`.

Code-managed Skills `workflows` und `invite` liefern die Ausführungs-/Einladungsanleitung.
Die kurze verwaltete AGENTS-/CLAUDE-/Grok-Sektion verweist auf sie und enthält:
Workflow finden → Run anlegen/übernehmen → Quellen lesen → bei Bedarf Kollegen
einladen → Tasks claimen → Ergebnisse speichern → Arbeit abschließen → evaluieren
und verbessern → Report-Link ausgeben. Nach Resume zuerst `agent_self` und
`agent_workflow_run_current`, danach offene Claims/Einladungen abgleichen.

Der allgemeine Work-outcome-Vertrag bleibt bestehen: Kam der ursprüngliche Auftrag
über `agent_request`, Conference oder Wake, muss dessen Ergebnis zusätzlich mit
`agent_task_result` gemeldet werden. Workflow-Task-Erfolg quittiert keine fremde
Bus-Delivery. Anleitung und Tests müssen diese Unterscheidung erklären.

## 8. UI und Report

Workflows werden eine Seite im bestehenden **Coordination**-Hub, registriert in
`frontend/src/lib/nav.ts`; kein zehnter Hub. Pfade:

| Browserroute | Aufgabe |
| --- | --- |
| `/admin/workflows` | Suchbarer Workflow-Katalog, Modulschalter, „New workflow“, Link zu Runs mit offenem Handlungsbedarf. |
| `/admin/workflows/new` | Strukturierter Editor für Ziel, Inputs, Tasks und Wissen. |
| `/admin/workflows/definitions/[slug]` | Vorlage, Versionen/Diff, Bearbeitung und zugehörige Runs; „New run“. |
| `/admin/workflows/runs` | Fleetweite Run-Liste mit Workflow-/Status-/Ergebnis-/Teilnehmer-/Evaluationsfilter. |
| `/admin/workflows/runs/[id]` | Live-Fortschritt und endgültiger Report unter derselben URL. |

Vorlageneditor: benannte Felder, Task-Reihenfolge mit Buttons statt Drag-only,
Abhängigkeitsauswahl, Wissensreferenzen und explizites Speichern mit sichtbarem
Zustand. Versionskonflikte behalten den Entwurf und zeigen den aktuellen Kopf.
Veröffentlichen eines geänderten Ziels wird mit Verweis auf „Create as new workflow“
abgewiesen. Lange Bearbeitung auf einer Seite statt in einem überfüllten Dialog.

### Report-Komposition

1. **Kopf:** Run-Titel, Ergebnis in Text und Farbe, Workflow/Version, Beginn/Ende,
   Dauer, Koordinator, aktueller Stand und „Copy link“.
2. **Resultat:** lesbare Zusammenfassung und die tatsächlich erzeugten Dinge —
   etwa Hostname, IP, DNS, VM-Ressourcen — als geordnete Fakten mit Copy-Aktionen
   und geeigneten Links. Dieses Resultat steht vor technischen Verlaufsdaten.
3. **Offene Punkte:** Blockaden, ungewisse Arbeit, fehlende Evaluation und nächste
   sinnvolle Aktion. Ein ausstehender Abschluss erhält keine grüne Fertigmeldung.
4. **Tasks:** zugängliche Liste mit Status, Bearbeiter/Host, Abhängigkeiten und
   Ergebnissen; Versuche/Fehler/Nachweise aufklappbar.
5. **Zusammenarbeit:** Teilnehmer, Einladungsstatus, Zuständigkeiten und Link zur
   automatischen Run-Gruppe. Online-Status und Arbeitsstatus getrennt darstellen.
6. **Evaluation:** Zielkriterien, Erkenntnisse und entweder „No changes needed“
   oder nachvollziehbarer Versionsdiff mit Begründung und Link zur neuen Vorlage.
7. **Historie:** zeitlich sortierte fachliche Events; technische IDs und Details
   nachgeordnet. Keine Rohtranskripte als Ersatz für einen Report.

Reportdaten kommen aus strukturiert gespeicherten Zuständen und dem Abschluss-Snapshot;
es gibt keine frei erzeugte HTML-Seite und keinen zweiten Report-Generator mit eigener
AI-Inferenz. Markdown über vorhandene sanitizende Komponenten rendern; Links auf sichere
Protokolle begrenzen. Alle URLs sind authentifizierte Admin-Links ohne Zugangstoken.
`report_url` serverseitig aus konfiguriertem öffentlichem Basis-URL und Run-ID erzeugen.

Run-Gruppen über den vorhandenen Room-Deep-Link
`/admin/agents?view=live&room=<uuid>` in `ClientsWorkspace`/`RoomConversation` öffnen.
Report und Gruppenansicht zeigen gegenseitige Links, ohne Reportdaten als Chat zu kopieren.
Die generischen Invite-/Remove-/Close-Steuerungen der Gruppenansicht werden bei
verwalteten Run-Gruppen durch einen Link zur zuständigen Run-Steuerung ersetzt;
die automatische Agenteneinladung verlangt kein zusätzliches Operator-Formular.

TanStack-Query-Roots `workflows` und `workflow-runs`; veröffentlichte Ereignisse
`workflow.changed`, `workflow.run.changed`, `workflow.state.changed` in die zentrale
Invalidierung aufnehmen. Mitgliedschaft/Gruppe invalidiert auch vorhandene
Messaging-/Chat-Keys. Wiederverbindung lädt die aktiven Workflow-/Run-Abfragen neu;
keine seitenlokalen Socket-Listener. Live-Updates erhalten Fokus, Scrollposition und
ungespeicherte Editorwerte. Listen/History serverseitig paginieren.

`DESIGN.md` ist bindend: insbesondere NAV-1..4, VIS-1..5, INT-1..7, ACC-1..4 und
GOV-2. PageShell/Section/Toolbar/DataTable/FormField/StateBlock und semantische Tokens
verwenden. Alle neuen Routen samt Bearbeitungs-/Fehlerzuständen in das Inventar und
`frontend/e2e/design-routes.json` aufnehmen. Kein Design-Ausnahmeantrag ist für dieses
Konzept erforderlich.

## 9. Umsetzung in ausführbarer Reihenfolge

Jede Stufe endet mit ihrem genannten Nachweis. Unfertige Stufen werden nicht als
abgeschlossen markiert; im Implementierungslauf hier Commit/Checks/Evidenz ergänzen.

### A — Vertrag, Schema und Kerninvarianten

- [ ] Gemeinsame Typen/Zod-Schemas, IDs, Limits, Statusübergänge, DAG-Prüfung,
  Inputs/Outputs, Actor- und Idempotenzverträge implementieren.
- [ ] Nächste freie Migration verwenden, sämtliche Tabellen/Indizes hinzufügen,
  `schema.ts` und generierte Baseline aktualisieren. Nur additive Migrationen.
- [ ] Vorlagen/Versionen und Run-Erstellung mit gepinnter Version implementieren.
- [ ] Echte MySQL-Tests für leere Installation, Upgrade, erneutes Anwenden,
  Eindeutigkeit, Rollback und historische Versionen bestehen.

**Abnahme:** Ein Workflow ohne Runs und zwei unabhängige Runs derselben Version
sind persistierbar; spätere Revision verändert keinen der beiden Runs.

### B — Tasks, parallele Claims und Wiederaufnahme

- [ ] Task-Versuche, Claims/Fencing, unabhängige Revisionen, Event-Historie,
  Koordinator-Lease und Kontrolloperationen implementieren.
- [ ] Pause, Blockade, Abbruchanforderung, Lease-Ablauf, Reconcile und Übergabe
  mit konkreten Konfliktcodes implementieren.
- [ ] Tests mit echten konkurrierenden DB-Verbindungen für denselben und
  unterschiedliche Tasks; verlorene ACKs, abgelaufene Claims und späte Writes.

**Abnahme:** Zwei Agenten bearbeiten zwei unabhängige Tasks parallel. Um denselben
Task gewinnt genau einer. Nach unbekanntem externem Ergebnis findet kein zweiter
Ausführungsversuch ohne Reconciliation statt.

### C — Einladungen und automatische Kommunikation

- [ ] Run-Mitgliedschaft, Einladung/Annahme/Ablehnung/Austritt/Entfernung und
  transaktionale Messaging-Anbindung implementieren.
- [ ] Genau eine verwaltete Run-Gruppe ab dem zweiten Teilnehmer; synchronisierte
  Mitgliedschaft, zulässige gezielte Agentenfragen und dauerhafte Historie.
- [ ] Generische Gruppen-/Subscribe-/Chat-/Attachment-Wege gegen Umgehungen
  der Run-Mitgliedschaft und des Gruppenabschlusses absichern.
- [ ] Bestehende normale Gruppen/Conferences/Host-/Projekt-Chats unverändert testen.

**Abnahme:** Agent A auf Host A lädt B auf Host B ein; B nimmt an und lädt C ein.
Einladungen benötigen keinen Nutzerdialog. Alle angenommenen Teilnehmer sehen
denselben Run und dieselbe Gruppe; ein nicht eingeladener Agent erhält keinen Schreibzugriff.

### D — Abschluss, Evaluation, Revision und Report-Projektion

- [ ] Arbeitsabschluss von Evaluation trennen; Kriterienprüfung und Outcome-
  Konsistenz umsetzen.
- [ ] Evaluationsentwürfe, atomare Verbesserung/Finalisierung, Konfliktbehandlung
  und unveränderlichen Report-Snapshot implementieren.
- [ ] Abschluss schließt ausstehende Einladungen und Run-Gruppe atomar.
- [ ] Report-Projektion bereits ab Run-Erstellung mit stabiler URL bereitstellen.

**Abnahme:** Erfolgreicher, fehlgeschlagener, partieller und abgebrochener Run
besitzen jeweils Report und Evaluation; ein Crash während der Evaluation bleibt
sichtbar offen. Zwei gleichzeitige Verbesserungen verlieren keine Version.

### E — Schnittstellen, Wrapper und Agentenanleitung

- [ ] Zentrale MCP-Reads/Ressourcen, Bridge-Mutationen und Admin-Routen verbinden;
  Rechteinventar, Service-Aufbau und Test-App-Aufbau synchronisieren.
- [ ] Gemeinsame Go-MCP-Werkzeuge samt Protokollfähigkeit und Fehlerweitergabe
  implementieren; keine Persona-spezifische Kopie.
- [ ] Managed Skills `workflows`/`invite`, Featurekontext und Anleitung für alle
  drei Engines einschließlich Resume und finalem Report-Link ergänzen.
- [ ] Aktuelle Wrapper-Version einmal erhöhen; Mindestversion/Discovery/Capabilities
  gegen tatsächlich laufende Wrapper testen.

**Abnahme:** Codex, Claude und Grok erreichen dieselben fachlichen Operationen.
Gefälschte Actor-Felder, veraltete Bindings, deaktivierte Engines und alte Wrapper
werden serverseitig korrekt abgewiesen; ein verlorenes Mutationsergebnis ist replaybar.

### F — UI, Kommunikation und vollständige Zustände

- [ ] Katalog, Editor, Versionsvergleich, Run-Listen, Run-Vorbereitung und Report
  mit den festgelegten Routen implementieren.
- [ ] Teilnehmer/Claims/Einladungen und Gruppen-Deep-Link integrieren; offene
  Evaluationen und ungewisse Tasks auffindbar machen.
- [ ] Queries/WS/Navigation/Breadcrumbs/Rechte, leere/fehlerhafte/veraltete/
  deaktivierte Zustände und erhaltene Formulardrafts umsetzen.
- [ ] Designinventar, Fixtures und Browserprüfungen erweitern; SPA erzeugen.

**Abnahme:** Ein Operator findet einen Run, versteht Ergebnis und offene Arbeit,
öffnet Nachweise/Gruppe und erkennt die automatische Verbesserung ohne Kenntnis
der internen Implementierung. Der Report funktioniert per Direktlink und Reload.

### G — Dokumentation, vollständige Prüfung und Lieferung

- [ ] `docs/OVERVIEW.md`, `docs/interface-api.md`, `docs/interface-db.md`,
  `docs/MCP.md`, `docs/interface-cdx.md`, `docs/interface-clx.md`,
  `docs/interface-cgx.md` und betroffene Messaging-Dokumentation aktualisieren.
- [ ] In-App-Manual mit Workflows/Runs, Zusammenarbeit, Evaluation, Fehlern und
  Wiederaufnahme ergänzen; Manifest aktualisieren. CLI-/MCP-Katalogtests anpassen.
- [ ] `CHANGELOG.md` unter tatsächlichem Implementierungsdatum ergänzen;
  generierte Capability-Dokumentation und SPA mitführen.
- [ ] Alle Checks aus Abschnitt 10 ausführen und Ergebnisse/Restlücken festhalten.
- [ ] Task-eigene Änderungen nach gültigem Git-Director-Verfahren integrieren.
  Push und Produktionsrollout nur, wenn der spätere Ausführungsauftrag sie enthält.

**Abnahme:** Quellcode, Migrationen, Wrapper, Anleitung und gebaute UI sind dieselbe
geprüfte Lieferung; Backend-E2E und Browser-E2E sind getrennt nachgewiesen.

## 10. Testplan und echte End-to-End-Abnahme

### Verpflichtende Szenarien

| Bereich | Nachweis |
| --- | --- |
| Vorlage | 0 Tasks/mehrere Ziele/zyklische oder unbekannte Abhängigkeiten ungültig; 0 Wissen und 0 Runs gültig; Inputs korrekt typisiert. |
| Versionierung | Pinning, alte Version lesbar, CAS-Konflikt, Archivieren ohne Datenverlust, Revert als neue Version. |
| Parallelität | Zwei DB-Verbindungen claimen denselben Task → ein Gewinner; verschiedene Tasks → beide erfolgreich; kein Verlust paralleler Outputs. |
| Einladungen | A→B→C über verschiedene Hosts/Engines; doppelte Einladung/Annahme; falscher Empfänger; abgelaufenes Binding; Ablehnung; keine automatische Neu-Einladung. |
| Gruppe | Gleichzeitige zweite/dritte Annahme → eine Gruppe; Teilnehmerlimits; generische Subscribe-/Delete-Umgehung abgewiesen; Historie nach Abschluss erhalten. |
| Gruppenfragen | Nur aktive Run-Mitglieder dürfen gezielt fragen; Antwort mit `reply_to`; Antworten lösen keine automatische Ping-Pong-Kette aus; normale Räume behalten alte Regeln. |
| Task-Sicherheit | Nichtmitglied, falsche Session, alter Claim, suspendierte Engine; Abhängigkeiten und Host-Nachweise; unbekanntes Ergebnis verhindert blinden Retry. |
| Wiederaufnahme | API-Neustart, Session-Rebind, abgelaufener Koordinator, Host-Verlust, späte Ergebnisantwort; keine implizite native Fresh-start-Recovery. |
| Idempotenz | Verlorenes ACK für Erstellung, Beitritt, Claim, Ergebnis und Finalisierung; Replay nach Commit trotz alter CAS-Version; anderer Body unter gleicher UUID abgewiesen. |
| Abschluss | Erfolg/Teil-Erfolg/Fehler/Abbruch/Ungewiss korrekt getrennt; offene Arbeit oder fehlende Kriterien verhindern unbelegten Erfolg. |
| Evaluation | Fehlend verhindert `completed`; begründetes `no_change`; automatische Revision; konkurrierende Revision; gespeicherter Entwurf nach Fehler; Zieländerung abgewiesen. |
| Autorisierung | Alle neuen Routen registriert; Viewer darf nicht schreiben; `compatible` und `strict`; Chat-Inhalte zusätzlich geschützt; keine Secrets in Belegen. |
| Modul/Parität | Initial aus, aktiv, auslaufende Runs nach Ausschalten; Codex/Claude/Grok; fehlendes MCP/Messaging und veralteter Wrapper verständlich dargestellt. |
| UI | Null/leer/laden/Fehler/stale/disabled/denied; direkte URL, Reload, Back; retained Draft; Konflikte; WS-Reconnect; lange Inhalte und viele Runs. |
| Rendern | Markdown-XSS/gefährliche URLs, Status ohne Farbe, Tastatur, Fokus, Touch, beide Themes/System und responsive Darstellung. |

### Kanonische Checks

Die Befehle im isolierten Implementierungscheckout ausführen. DB-Umgebungsvariablen
müssen explizit auf eine wegwerfbare Test-MySQL-8.4-Instanz zeigen, nicht auf die
Repository-`.env` oder Produktion. Exakte aktuelle Konfiguration aus
`.github/workflows/api.yml` und `api/test/helpers/test-db.ts` übernehmen.

```sh
# api/
npm ci --no-audit --no-fund
npm run typecheck
npm run lint
npm test
npm run build

# api/, ausschließlich mit expliziter Testdatenbank
npm run test:db:setup
npm run migrate
npm run test:coverage
npm run migrate:check

# wrappers/cxx/
go build ./...
go vet ./...
go test -race ./...

# wrappers/
make test
make test-terminal
make test-traced

# frontend/
npm ci --no-audit --no-fund
npm run check
npm run build
npx playwright install chromium firefox webkit
npm run test:e2e
npm run test:e2e:cross-browser
```

`test:db:setup` nur einmal auf leerer Testdatenbank ausführen. Zusätzliche DB-Tests
beweisen Upgrade einer vor dem Feature erzeugten Baseline und erneute Anwendung
der neuen Migration; die neue Baseline allein ist kein Upgrade-Nachweis.
`test:coverage` enthält die echten Integrationssuites; ihre Skips gelten nicht als Erfolg.

Browserprüfungen in `admin-workflows.spec.ts`, Run-Gruppenfälle in der vorhandenen
Messaging-/Chat-Suite. Den Cross-Browser-Test-Matcher um diese neuen fachlichen
Fälle erweitern; er prüft derzeit ausschließlich `admin-design.spec.ts`.
Keine ganzen Suites wegen einer neuen Assertion abschalten.

### E2E ohne gemockte Fach-API

Zusätzlich eine isolierte MySQL/API/SPA-Instanz und zwei authentifizierte Bridge-Clients
mit verschiedenen Host-IDs und Engines verwenden. Einen dritten Client für B→C-
Einladung und ein nicht berechtigtes Gegenbeispiel hinzufügen. Browser-Fixtures
dürfen diesen Test nicht abfangen.

Ein deterministischer Test-Workflow hat zwei unabhängige Tasks, die in getrennten
temporären Arbeitsverzeichnissen ein kleines Artefakt erzeugen und Hash/Host als
Ergebnis melden. Ein dritter Task verifiziert beide Ergebnisse. Keine realen
VM-/DNS-Änderungen. Über den vollständigen HTTP/MCP-Weg:

1. Workflow anlegen, Run erstellen, Report-URL bereits im Browser öffnen.
2. A lädt B ein, B nimmt an und lädt C ein; genau eine Gruppe entsteht.
3. A/B arbeiten parallel, C liest die gemeinsamen Ergebnisse; konkurrierender
   Claim auf denselben Task scheitert.
4. Eine gezielte Gruppenfrage zustellen und beantworten; Zustellbeleg prüfen.
5. Ein Ergebnis-ACK verlieren und identisch wiederholen; nur ein Versuch/Ergebnis.
6. API neu starten; Run, Teilnehmer, Claims und Report bleiben konsistent.
7. Arbeit abschließen; UI zeigt die noch offene Evaluation.
8. Evaluation verbessert eine unklare Anweisung; genau eine neue Version entsteht,
   derselbe Report-Link zeigt Abschluss/Diff, Gruppe ist lesbar und geschlossen.
9. Neuer Run nutzt neue Version; erster Run zeigt weiter die alte.
10. Zweiter Fall bricht einen laufenden Versuch kontrolliert ab; Ungewissheit,
    Reconciliation und verpflichtende Evaluation werden sichtbar nachgewiesen.

Für die native Agentenabnahme anschließend zwei laufende managed Sessions auf
unterschiedlichen Hosts verwenden. Der Agentenauftrag erlaubt ihnen gegenseitige
Einladungen; keiner muss durch den Nutzer einzeln zugewiesen werden. Tatsächliche
MCP-Aufrufe, gemeinsame Run-ID, Host-Zuordnung, Report und Gruppenhistorie belegen
den Ablauf. Codex/Claude/Grok sind im automatisierten Vertragstest alle abzudecken;
nicht verfügbare native Engines als verbleibende Abnahmelücke nennen.

Visuelle Abnahme nach `DESIGN.md`: 320 px, 390×844, 768×1024, 1440×900 und 1920×1080,
hell/dunkel/system, Tastatur, grober Pointer, 400 % Zoom, 200 % Text, Axe und eine
manuelle Screenreader-Prüfung. Ein anderer Reviewer bearbeitet die Report-Aufgabe
ohne Implementierungshinweise; fehlt dieser Check, bleibt Usability-Abnahme offen.
Screenshots/Traces und konkrete Grenzen dokumentieren, keine pauschale WCAG-Behauptung.

## 11. Rollout, Rückweg und Definition of Done

Der Folgeauftrag vom 2026-10-20 autorisiert Umsetzung mit Astra-/Sol-Subagents,
Abnahme und Deploy. Der folgende Ablauf bleibt verbindlich:

1. Aktuellen Deployment-Runbook über `shared://deploy.crane` und den tatsächlichen
   Produktionscheckout prüfen; der Slug ist historisch und kein Hostname.
2. Geprüften, sauberen Commit auf dem Ziel bereitstellen; gültige Claims/Leases,
   aktuelle Host-/Compose-Konfiguration und DB-Backup prüfen.
3. `scripts/deploy.sh --backup --no-cleanup` mit den tatsächlich benötigten
   bestehenden Compose-Profilen ausführen. Wrapper nicht überspringen:
   neue MCP-Werkzeuge benötigen den neuen gebauten/veröffentlichten `cxx`.
4. Migrationstatus, API-Gesundheit, servierte SPA, Wrapper-Manifest und laufende
   Wrapper-Version nachweisen. Das Feature bleibt bis zu diesen Prüfungen aus.
5. Workflows einschalten; einen kleinen, ungefährlichen Mehragenten-Smoke-Run
   mit Ergebnisnachweisen, Evaluation, Verbesserung und Report-Link durchführen.
6. Fehlerlogs, ausstehende Evaluationen, Claim-Konflikte und offene Einladungen
   prüfen. Fachliche Fehler sind kein Anlass, Runs oder Historie zu löschen.

Rückweg: neue Runs über Modulschalter stoppen, laufende Arbeit gezielt pausieren
und externe Prozesse klären. Bei fehlerhafter Workflow-Verbesserung eine ältere
Version als neue Revision wiederherstellen. Bei Software-Rollback vorher aktive
Teilnehmer stoppen/auslaufen lassen und die bekannte API-/SPA-/Wrapper-Lieferung
wiederherstellen; additive Tabellen und Reportdaten behalten. Keine Down-Migration
mit Datenverlust. Eine DB-Backup-Rücksicherung ist nur bei nachgewiesenem
Datenbankproblem nötig und muss zwischenzeitliche Runs berücksichtigen.

**Fertig ist die Funktion erst, wenn:**

- [ ] Workflow/Run-Trennung und alle Kardinalitäten serverseitig gelten.
- [ ] Agenten sich innerhalb eines Runs selbstständig über Host-/Engine-Grenzen
  einladen und unterschiedliche Tasks sicher parallel bearbeiten.
- [ ] Jeder Mehragenten-Run genau eine automatisch verwaltete, später lesbare
  Kommunikationsgruppe besitzt.
- [ ] Ergebnisse/Claims/Versionen nach Neustart erhalten sind und verlorene ACKs
  keine doppelte Arbeit auslösen.
- [ ] Kein Run ohne Evaluation abgeschlossen wird; Verbesserungen automatisch,
  versioniert und ohne Zielveränderung erfolgen.
- [ ] Jeder Run ab Erstellung einen funktionierenden, authentifizierten Report-Link
  hat und Agenten diesen am Ende ausgeben.
- [ ] Tests, Dokumentation, gebaute UI und Wrapper dieselbe Lieferung abdecken.
- [ ] Lokal integriert, remote veröffentlicht und live verifiziert im Abschlussbericht
  getrennt ausgewiesen sind; nicht durchgeführte Schritte explizit genannt werden.
