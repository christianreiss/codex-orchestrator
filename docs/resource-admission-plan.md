# Plan: Ressourcensteuerung pro Host

Status: geplant, noch nicht implementiert. Operator-Anforderung vom 2026-10-26:
erst die vorhandenen Maintenance-Arbeiten integrieren oder verwerfen und die
Worktrees aufräumen; danach diesen Plan erstellen. Deployment ist für die
Umsetzung autorisiert. Meilensteine gehen über das bestehende Operator-Portal.

## Schalter und wirksame Einstellung

Ein globaler Schalter aktiviert oder deaktiviert das Ressourcenlimit. Sein
Initialwert ist `off`, damit die neue Funktion bestehende Hosts nicht
ungefragt begrenzt. Jeder Host erhält genau drei Zustände:

| Host-Einstellung | Global off | Global on |
| --- | --- | --- |
| `fleet` (Standard) | aus | ein |
| `on` | ein | ein |
| `off` | aus | aus |

API und UI zeigen gespeicherten Override, wirksamen Zustand und dessen Quelle.
Der Host-Override hat Vorrang. `off` schaltet ausschließlich das neue
Ressourcenlimit aus; Authentifizierung, Engine-Schalter, Quoten, Native-Proof
und bestehende Ownership-Prüfungen gelten weiter.

## Umsetzung in drei Schritten

1. Einstellungen und Anzeige: globaler Schalter in Fleet Settings, Tri-State
   im Host-Detail, versionierte API-Verträge und idempotente Migration. Der
   Host-Standard ist `fleet`. Dieselbe zentrale Auflösung liefert den Zustand
   an UI, Wrapper und Communicator für Codex, Claude und Grok.
2. Hostweite Zulassung: ein gemeinsames Budget für neue verwaltete Starts über
   alle Engines und Benutzer des Hosts. Frische CPU-/RAM-/temporäre
   Speicher-Messwerte und bestehende Startreservierungen bestimmen, ob ein
   weiterer Start zugelassen wird. Messwertalter und nicht verfügbare Daten
   werden sichtbar; Grenzwerte werden explizit konfiguriert. Ein wartender
   Start bleibt dauerhaft und idempotent zugeordnet. Bereits akzeptierte
   Aufträge, Wiederaufnahme und ungewisse Ergebnisse behalten ihre bisherigen
   Schutzregeln. Laufende Agenten werden durch Schalterwechsel nicht beendet.
   Das ist kein Versprechen, beliebige außerhalb von cxx gestartete Shell-
   Befehle zu begrenzen; harte Prozessgrenzen wären eine eigene cgroup-Stufe.
3. Tests und Rollout: alle sechs Schalterkombinationen, parallele Starts
   verschiedener Benutzer/Engines, überholte Messwerte, Verbindungsabbruch,
   Wiederaufnahme, Queue-Freigabe bei `off` und sichere Ressourcenfreigabe
   prüfen. Mit global `off` deployen, einen Host ausdrücklich `on` testen,
   tatsächliche Zulassung/Wartezustände nachweisen und erst dann den globalen
   Schalter nach Operator-Wunsch aktivieren.

## Abnahme

Es bleibt genau eine maßgebliche Budgetentscheidung je Host. Mehrere
Communicator-Prozesse können das Limit nicht durch gleichzeitige lokale
Entscheidungen überschreiten. UI, API und native Starts melden denselben
wirksamen Zustand. Ausschalten hebt ausschließlich ressourcenbedingtes Warten
auf; es startet keine doppelte Arbeit und umgeht keine andere Zulassungsregel.
Konkrete Budgetwerte und Verhalten bei fehlenden Messwerten werden vor dem
Implementierungscommit anhand der tatsächlichen Host-Messung festgelegt und
im Vertrag dokumentiert; dafür werden keine Fähigkeiten erfunden.
