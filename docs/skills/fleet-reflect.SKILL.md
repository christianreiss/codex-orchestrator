---
name: fleet-reflect
description: "Before a final work result, briefly review Codex Orchestrator and fleet-tool experience and submit actionable, deduplicated feedback when warranted. Also use on explicit #fleet-reflect requests."
---

# Fleet Work Reflection

Run once per completed work item, including failed or blocked work, before its final
response or managed work-result delivery. An explicit request may run it sooner.
Progress messages, acknowledgements and retries of the same result need no new review;
after resume, retain any review outcome and report IDs already recorded for this item.

## Review

Make one brief pass over the task's observed experience with Codex Orchestrator:
tool discovery and contracts, fleet coordination, documentation, usability,
reliability, errors, workarounds and missing capabilities. Use evidence already
collected; reflection does not start an infrastructure audit or delay the original
work to investigate speculative issues. With no fleet experience, finish quietly.

Keep findings that would help a maintainer act: an observed bug, concrete usability
friction, or a feature proposal tied to an actual task need. Distinguish observations
from suspected causes and intentional configuration or policy restrictions. Ordinary
project defects belong in the authorized project feedback workflow, outside this
orchestrator inbox. If no actionable finding remains, finish without tool calls or
a reflection paragraph.

## Report when warranted

Use the available orchestrator feedback tools within existing authority. If disabled,
unavailable or denied, preserve a concise pending finding in the final work result
and finish the original task. Respect the capability setting rather than switching
to credentials, direct database writes or another reporting channel.

For each distinct finding:

1. Search `feedback_list` using concise symptom/component terms, across statuses
   (omit `status`). Read plausible matches with `feedback_get`; follow a duplicate's
   canonical report. Check relevant further pages using `next_offset` as needed.
2. If a report already covers the finding, compare its original report and history.
   With no materially new evidence, retain its ID and make no write. With new
   evidence, call `feedback_update` with only `id`, the current `expected_version`
   and `note`. Include recurrence evidence even for closed reports; leave status,
   claims, priority and deployment unchanged. A note needs no work claim. On a
   version conflict, reread and append only evidence still missing. After an
   ambiguous update, read history before retrying so the note is not duplicated.
3. If no report covers it, call `feedback_submit`. Use `bug` for observed incorrect
   behavior, `feature` for a missing capability, and `feedback` for usability or
   documentation improvements. Default to `normal` priority; higher priority needs
   observed impact. Keep separate problems in separate reports.
4. Include a concrete title, component, description and task impact; known versions,
   expected and actual behavior, reproduction steps when available, and sanitized
   evidence. Label missing versions, untested reproduction or uncertain causes
   explicitly. Describe the useful outcome for a proposal. Include only necessary
   excerpts; exclude credentials, customer data and private reasoning.
5. Generate one UUID `client_request_id` for each new report and retain it with the
   exact submitted body. Retry an ambiguous submission with that same UUID/body;
   a successful replay is the same report. A deliberately changed report needs a
   new UUID after reconciling the earlier outcome. Record confirmed report IDs;
   a failed or uncertain response is not submission proof.

Keep recovery bounded: at most one reconciliation/retry per failed write during
this closing review. If it still fails, report the finding as pending or uncertain
and finish the original work. Reflection authorizes reporting only; fixes, claims,
agent launches, merges, deployments and recovery require their existing authority.

## Finish

Keep the user's task result first. Briefly include IDs of created or updated reports,
or an existing report that explains an unresolved task problem. Mention actionable
findings that could not be submitted and their delivery state. Otherwise stay quiet;
store no standalone reflection log or memory and do not invent findings to fill one.
