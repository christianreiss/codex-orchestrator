# Web design standard

**Status:** binding design contract, adopted 2026-10-18. **Direction:** a calm, understandable working console.

This is the single design authority for every browser surface in this repository, including signed-out screens, setup, operator chat, help, overlays and failure states. It replaces the former admin-only design specification. It governs presentation and interaction; API contracts, permissions, authentication and provider ownership remain defined by their interface documents.

**Adoption is not implementation.** This documentation step changes no UI. The source inventory below records the baseline at `bfa7ed5630e7bdb562349e3b6203339228260368`, including the 2026-10-17 consolidation. Existing pages have not been certified against this standard. Application and automated enforcement are step 2.

## 1. How to use and enforce this document

Before designing, changing or reviewing a browser surface:

1. Identify its primary operator task and its pattern in section 3; locate it in the inventory.
2. Read the applicable rules and reuse the shared primitives. Fix a shared primitive when the same defect affects several pages; do not patch each page with unrelated styles.
3. Verify the affected rules using section 9. Record rule IDs, actual checks and any remaining gaps in the delivery report.
4. Update this document when adding a surface, changing a design decision or accepting an exception.

**MUST** and **MUST NOT** are acceptance requirements. **SHOULD** is a default that may be departed from with a documented reason. Rules apply to new and changed UI immediately; the baseline debt is not an instruction to rebuild unrelated pages in the current task. An affected deviation cannot be silently carried forward as compliant.

Verification labels: **A** = automated assertion; **V** = visual inspection at stated viewport/theme; **M** = manual task, keyboard or assistive-technology check. A label specifies how to prove a rule, not a claim that a test already exists.

**GOV-1 — Exceptions [M].** An exception MUST be entered in section 10 with rule ID, exact surface, user need, alternative, verification, owner, decision date and review/removal condition. An implementation comment or a convenient component default is not an exception. Standards-based accessibility obligations cannot be waived by a visual preference. Amend the standard through the ordinary reviewed change when a rule is wrong.

**GOV-2 — Evidence [A/V/M].** Reviews MUST distinguish implemented behavior, a documented target, source-inspected behavior and browser-proven behavior. A passing screenshot, Axe scan or build alone MUST NOT be described as proof of usability or full WCAG conformance.

## 2. Research basis and decisions

Sources were opened and reviewed on **2026-10-18**. “2026” describes the research cutoff, not a reason to discard durable guidance. This is a synthesis for an operational console, not a ranking of visual trends. No source establishes that a particular font, corner radius or color is universally best.

| ID / evidence class | Primary source | Finding and consequence for this product |
| --- | --- | --- |
| S1 — normative standard | [W3C WCAG 2.2](https://www.w3.org/TR/WCAG22/) (Recommendation, 2024-12-12) | Use level AA as the accessibility target across complete tasks, including authentication and failures. Component reuse does not establish conformance. |
| S2 — explanatory guidance | [W3C: text contrast](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) | Text contrast must survive actual surface combinations. Verify rendered states as well as token pairs. |
| S3 — explanatory guidance | [W3C: non-text contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html) | Essential control boundaries and graphical state need contrast. Pale separators cannot be the only way to identify an input. |
| S4 — explanatory guidance | [W3C: target size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html) | AA minimum is 24 CSS px with defined exceptions. Our touch default is deliberately larger; icon size is not hit-area size. |
| S5 — explanatory guidance | [W3C: reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html) | Ordinary content must reflow at 320 CSS px. A genuinely two-dimensional table/graph can scroll locally; the entire page cannot inherit that exception. |
| S6 — explanatory guidance | [W3C: focus not obscured](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html) | Sticky headers and composers must not hide keyboard focus. Check overlays, mobile navigation and zoom together. |
| S7 — explanatory guidance | [W3C: accessible authentication](https://www.w3.org/WAI/WCAG22/Understanding/accessible-authentication-minimum.html) | Support assistive authentication, paste and password managers; authentication must not rely solely on memorization or puzzles. |
| S8 — explanatory guidance | [W3C: status messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html) | Announce meaningful asynchronous results without moving focus. Streaming output needs restrained announcements. |
| S9 — implementation guidance | [WAI APG: modal dialogs](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/) and [tabs](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/) | Modal focus and tab keyboard behavior require deliberate implementation. Route links styled as tabs remain navigation links. |
| S10 — established design-system guidance | [GOV.UK: validation](https://design-system.service.gov.uk/patterns/validation/) and [error summary](https://design-system.service.gov.uk/components/error-summary/) | Preserve entered values and explain correction at the field and form. Use submission-time validation by default; do not punish unfinished typing. |
| S11 — established design-system guidance | [GOV.UK: details](https://design-system.service.gov.uk/components/details/) and [multiple tasks](https://design-system.service.gov.uk/patterns/complete-multiple-tasks/) | Disclose infrequent detail; keep commonly needed information visible. Use staged flows only when the task benefits from them. |
| S12 — established design-system guidance | [Carbon: data tables](https://www.carbondesignsystem.com/building-blocks/core/components/data-table/guidelines) | Tables support comparison, filtering and scoped actions. Give data sufficient width and keep density consistent. Adopt the reasoning, not Carbon's entire scale or component implementation. |
| S13 — empirical evaluation, limited context | [NN/g: AI prototyping in real design contexts](https://www.nngroup.com/articles/ai-prototyping/) (2025-10-24; reviewed 2026-08-19) | Generated layouts can follow a brief while missing contextual tradeoffs. This evaluation is not evidence that every AI-made UI fails. Require real operator tasks and edge states, not plausibility at first glance. |
| S14 — expert synthesis | [NN/g: State of UX 2026](https://www.nngroup.com/articles/state-of-ux-2026/) (2026-01-16) | Consistency and contextual understanding matter beyond surface polish. Use this as direction, not a quantitative study or a universal style prescription. |
| S15 — measurement guidance | [web.dev: Web Vitals](https://web.dev/articles/vitals) | Use LCP, INP and CLS with explicit measurement context. Field distributions and laboratory checks answer different questions. |
| P — repository product decisions | Current route registry, tokens, shared components, tests and operator brief | Neutral palette, Inter, compact density, restrained motion and task-specific templates are our chosen defaults. The numerical values below are product decisions, informed by the sources above. |

### Tradeoffs resolved

- **Density versus readability:** desktop operators need comparison without excessive scrolling. Use 14 px body text and compact controls, but let content grow and enlarge touch targets. Do not solve overflow by shrinking text.
- **Consistency versus identical layouts:** hosts, editors and conversations share typography, controls and states. A conversation is not a table; a dashboard is not a stack of settings forms.
- **Disclosure versus discoverability:** secondary implementation detail may collapse. Required steps, current failures, save status and the normal next action stay visible.
- **Borrowing patterns versus copying systems:** use GOV.UK's error-recovery reasoning and Carbon's data-workspace reasoning. Neither mandates our visual appearance. Do not copy GOV.UK-specific HTML validation suppression without an accessible replacement.
- **AI assistance versus generic output:** authoring tools are irrelevant to acceptance. Task clarity, truthful data, complete states and coherent composition determine quality.

## 3. Tasks, navigation and page patterns

**NAV-1 — One location model [A/M; P].** The registry in [nav.ts](frontend/src/lib/nav.ts) owns global labels, destinations, active state, command-palette entries and location context. Each setting MUST have one editable home; overview and related pages link there. Canonical browser routes MUST remain distinct from API paths. Renaming a browser page does not rename its API.

**NAV-2 — Orientation [A/V/M; S1/P].** Each rendered page MUST have one meaningful `h1`, a matching document title, a visible current location and a clear main task. Child project views use the project heading plus a subordinate view heading. Descriptions explain purpose or consequences; omit sentences that merely repeat the title. Long names must be obtainable without hover alone and must not hide the task.

**NAV-3 — Actions and disclosure [V/M; S11/P].** Give one action visual priority per task region. Put list-wide actions in the toolbar or page header, row actions beside the row, and selection actions beside the selection count. Do not duplicate the same primary action in header and toolbar. Frequent actions and active problems MUST NOT be hidden under “Advanced”. Collapsed sections use descriptive names such as “Network and access overrides”. Destructive settings sit last, separated from routine controls.

**NAV-4 — Navigation depth [A/M; S9/P].** Preserve the current nine hubs and footer utilities as the starting structure. Use at most one local peer-navigation row; nested tab bars are prohibited. In-page panels use proper tab semantics and keyboard behavior; route destinations use links with current-location semantics. Filters, selection and pagination SHOULD survive back/forward navigation and use URL state where safe; credentials and message bodies MUST NOT enter URLs.

| Pattern | Composition and acceptance rule | Existing building blocks | Verification |
| --- | --- | --- | --- |
| Overview | Exceptions needing action, concise health/usage context, links to owners. Each metric must answer an operator question and disclose its time/scope. | `PageShell`, `Section`, `StatStrip`, attention/usage components | V/M |
| List | Title/action, search and filters, result count, comparable rows, scoped actions and pagination when needed. | `Toolbar`, `DataTable`, `SortableHead`, `RowActions` | A/V/M |
| Detail | Identity and problems, task sections, infrequent options, destructive section last. | `PageShell`, `Section`, domain sections | V/M |
| Settings | Named groups, persistent labels, effective scope and save status; one vertical task sequence. Related fields stay together. | `Section`, `FormField`, domain settings | A/M |
| Editor | Named document, editable content, optional preview, explicit save state; metadata/history separate. Two columns only if both remain usable. | `DocumentEditor`, domain editors | A/V/M |
| Event history | Time, actor, action, object and result; expandable diagnostics. Filters distinguish event kinds. | `EventFeed`, event rows, scoped tables | A/M |
| Conversation | Directory, selected conversation, timeline, composer and attention/recovery state; preserve draft and reading position. | `ClientsWorkspace`, `Timeline`, `Composer`, `AttentionCard` | A/V/M |
| Board / graph | Spatial workspace with an equivalent list or non-drag action path. Selection, status and navigation remain available without color or precision gestures. | board components, `GraphView`, `AgentInspector` | A/V/M |
| Authentication | One focused task, visible labels, recovery and clear outcome. Avoid ornamental content competing with sign-in. | `AuthShell`, `FormField` | A/V/M |
| Setup | Named steps, current progress, prerequisites, save/skip consequences and resume behavior. Completion must match actual setup state. | `WizardShell`, step components, `SeedAuthPanel` | A/M |
| Help / article | Search/browse entry, bounded reading column, headings, code and links to the relevant task. | `ManualSidebar`, `ArticleView` | V/M |
| Failure / unavailable | Explain what failed, what was retained and a safe next action; use the surrounding frame when available. | `StateBlock`, `AuthShell`, error boundary | A/M |

### Current editable homes

These are browser locations, not renamed API namespaces. Recheck the registry and
owning components when moving a setting; update this table in the same change.

| Setting family | Editable home |
| --- | --- |
| API master/surface controls and gateway keys | `/admin/api-keys` |
| People (admin users) | `/admin/people` |
| Shared secrets | `/admin/secrets` |
| Engine switches, model/effort/version defaults and native engine configuration | `/admin/engines` |
| Quota enforcement, quota warnings and usage-based scaling | `/admin/limits` |
| Host-specific access, engine assignments and overrides | `/admin/hosts/[id]` |
| Fleet host policy, host-agent rollout, agent-session controls, Chatty and retention | `/admin/settings` |
| Agent messaging service and coordination data | `/admin/agent-messaging` |
| Workflow module switch and reusable instructions | `/admin/workflows` and selected definition |
| Schedule configuration, Git coordination settings and transfer limits | Their respective Coordination pages |
| Project/module controls and project content | `/admin/projects` and selected project views |
| Fleet instruction content and managed instruction modules | `/admin/library/agent-rules` |
| Personal profile, password, passkeys, appearance and paired devices | `/admin/account` |

## 4. Visual foundations

**VIS-1 — Shared implementation [A/V; P].** Reuse [page primitives](frontend/src/lib/components/page/index.ts), shared `ui/` controls and [semantic tokens](frontend/src/lib/styles/tokens.css). [Tailwind configuration](frontend/tailwind.config.ts) maps implementation utilities. Do not introduce page-local colors, radii, type scales or shadow systems. A missing shared capability belongs in the shared layer during step 2.

### Typography (target scale)

Values are rem-based; pixel equivalents assume the default 16 px root. Browser text sizing MUST remain available. Inter is UI/prose; JetBrains Mono is for identifiers, commands and code, not whole forms.

| Role | Size / line height / weight | Use |
| --- | --- | --- |
| Page title | 1.25rem / 1.3 / 600 (20 px) | All ordinary and authentication page headings |
| Section heading | 1rem / 1.3 / 600 (16 px) | Task boundaries |
| Subsection / label | 0.875rem / 1.5 / 600 (14 px) | Field labels and small group headings |
| Body / table | 0.875rem / 1.5 / 400 (14 px) | Normal working text |
| Secondary | 0.8125rem / 1.5 / 400 (13 px) | Supporting descriptions, not essential instructions |
| Caption | 0.75rem / 1.4 / 500 (12 px) | Timestamps and secondary metadata |
| Reading / composer / touch input | 1rem / 1.6 / 400 (16 px) | Long articles, message text and touch text entry |

**VIS-2 — Readable hierarchy [V/M; P].** These roles MUST replace arbitrary sizes when a surface is migrated. Essential content MUST NOT use the existing 11 px overline. Avoid all-caps prose; sentence case is the default. Keep primary titles visible through wrapping or a keyboard/touch-accessible full-name view. Technical strings may break or scroll within their own region. Use tabular numerals for aligned measurements; right-align comparable numbers, left-align text.

The current `PageShell` already uses a 20 px title, while `text-h1` is 30 px and `text-h2` is 22 px. The table above is the target, not a claim that those aliases already match it. Consolidate their consumers in step 2 instead of adding another title convention.

### Geometry and density

| Property | Binding default (P) | Application |
| --- | --- | --- |
| Spacing scale | 4, 8, 12, 16, 24, 32 px, expressed in rem | 4–8 within a control; 12 between related fields; 16 between blocks; 24–32 between task sections |
| Page inset | 16 px narrow; 24 px from 768 px viewport width | One owner for outer padding; avoid doubled shell/page gutters |
| Data workspace | Available width (`PageShell` wide) | Tables, boards, graphs, comparison and editor-with-preview |
| Standard workspace | 72rem maximum (`PageShell` default) | Mixed task pages |
| Settings / detail form | 48rem maximum (`PageShell` narrow) | Reading labels and completing related fields |
| Article / long prose | 65ch maximum text measure | A code block/table may be wider within a bounded region |
| Auth form / setup | 24rem / 56rem maximum | Narrow sign-in and wider staged setup respectively |
| Desktop controls | 36 px normal; 32 px compact table/toolbar | Minimum heights; multiline content may grow |
| Touch targets | At least 44 × 44 CSS px for standalone controls on coarse pointers | Expand hit areas without overlapping adjacent targets; applies on hybrid devices too |
| Table rows | 40 px minimum normal; 36 px compact; 48 px or more for multiline/touch rows | One density per table; never clip wrapping content to force a height |
| Corners | 4 px controls; 6 px containers/overlays | Existing `--radius-sm` and `--radius`; circles only for genuine circular affordances/avatars |
| Icons | 16 px inline; 20 px navigation/touch control glyph | One Lucide family; accessible hit area independent of glyph |
| Borders / elevation | 1 px semantic border; ordinary surfaces no shadow; overlay uses `--shadow-pop` | Group primarily through alignment, headings and spacing |
| Motion | 120 ms color/focus feedback via `--dur`; at most 200 ms functional opening/closing | No entry choreography; reduced motion removes travel and decorative animation |

**VIS-3 — Geometry [A/V/M; P].** Use the table above without fixed-height clipping. At narrow widths, stack toolbars and collapse multi-pane workspaces into a reachable list/detail flow. Preserve access to data and actions. A small viewport is not permission to remove functionality.

**VIS-4 — Color semantics [A/V; S2/S3/P].** Use `background/foreground` for the canvas; `card` for a bounded independent surface; `muted` for supporting content; `primary` for selected/primary interaction; `destructive`, `warning`, `success`, `info` for actual outcomes or urgency. Use their matched foreground/muted pairs. Engine persona colors identify engines, not health. Every meaningful status MUST also have text or another non-color cue. Light, dark and system modes retain the same meaning, information and hierarchy.

**VIS-5 — Composition [V/M; S13/S14/P].** Each visual emphasis MUST have a task reason. Prohibited: decorative gradients/glass, oversized hero headings in working pages, ornamental sparkles, decorative charts, metric tiles without an actionable question, nested cards and repetitive explanatory banners. Use a flat section for related fields, a table for comparison and a card only for an independent object or bounded interaction. Typography and alignment establish hierarchy before color or borders.

## 5. Interaction and truthful state

**INT-1 — Lists [A/M; S12/P].** Name columns and units; expose sort direction semantically. State active filters, visible count and selection scope. “Select all” must say whether it means this page or all filtered results. Preserve filters through opening/closing a detail. Provide “Clear filters” for no matches. Avoid hover-only row actions. A row link and its buttons must be separately operable; do not make a whole row an unlabeled button. Never nest tables inside table cells to simulate a detail page.

**INT-2 — Forms [A/M; S10/P].** Every field MUST have a persistent label and associated help/error text. Mark required/optional consistently within the form. Use submission-time validation by default; earlier validation requires a concrete benefit such as a length limit. Server validation remains authoritative. On failure retain safe inputs, show specific correction beside each field, and provide a linked summary for multi-field errors. Do not echo secrets in summaries or logs.

**INT-3 — Saving [A/M; P].** State whether changes save immediately or need an explicit save action. Show pending, saved and failed states near the affected controls. “Saved” requires confirmed acceptance; a transport timeout is not success. Preserve the attempted value or draft for recovery, distinguish it from effective state, and reconcile authoritative state before further dependent changes. Do not silently overwrite unsaved edits after a refresh. Warn before navigation that would discard a meaningful draft; keep ordinary navigation free of unnecessary confirmations.

**INT-4 — Dialogs [A/M; S9/P].** Use a dialog for a short bounded task, a sheet for contextual detail and a page for sustained work. Modal overlays MUST have a title, sensible initial focus, contained Tab navigation, Escape/close behavior and focus restoration. Background content is inert only for real modals. Confirmation names the affected object, consequence and action (“Delete host”), not “Yes”. Irreversible actions default focus to the safe choice. Do not stack routine dialogs.

**INT-5 — Feedback [A/M; S8/P].** Put errors and durable results beside the affected task. Toasts may supplement but MUST NOT be the only record of a failed save or required action. Use polite live announcements for ordinary updates and assertive alerts only for urgent interruption. Do not announce each streamed token or steal focus on background refresh.

**INT-6 — Time and measurements [A/M; P].** Show units, scope and observation age for operational data. Relative time MUST offer an exact timestamp with timezone via accessible detail. Zero is a value; unavailable is not zero. Stale is not current, queued is not delivered, and reachable is not working. Do not infer success from connection status or request dispatch.

| State | Required presentation and recovery | Verification |
| --- | --- | --- |
| Initial loading | Stable skeleton or progress label for the requested region; no fake counts or empty-state flash | A/V |
| Background refresh | Keep useful prior content and focus; mark refresh/staleness where relevant | A/M |
| Empty collection | Explain the actual absence (“No hosts registered”) and offer the permitted first action | A/M |
| No matches | Explain filter scope and provide clear/reset; do not suggest creating duplicate data | A/M |
| Permission denied | Explain the restriction and available route forward without exposing restricted content | A/M |
| Module disabled | Explain disabled scope and link to its editable owner when permitted; not an empty collection | A/M |
| Load failure | Name the failed resource, show a safe retry and retain prior data explicitly as stale if available | A/M |
| Mutation failure / uncertain outcome | Preserve safe input; show failure or unconfirmed outcome; reconcile before repeating a potentially completed action | A/M |
| Offline / reconnecting | Show connection state, retained content and available actions; no false success | A/M |
| Success | Show the confirmed result and next useful action without interrupting unrelated work | A/M |

**INT-7 — State completeness [A/V/M; P].** Every data-bearing region MUST implement the applicable rows above. `StateBlock` currently covers only loading/error/empty; reuse it where sufficient and extend shared behavior in step 2. Do not collapse every failure into “Nothing here yet”.

**INT-8 — Conversations [A/M; P].** Keep drafts and attachments attached to their conversation. Background events MUST NOT move a reader to the bottom unless they were already following the latest output; offer a new-message indicator instead. Preserve distinction between native activity, receiver readiness, attention and task outcome. An ambiguous send retry must follow the existing idempotency contract. Current questions remain actionable; historical choices must not answer a newer question.

## 6. Accessibility, responsive behavior and performance

**ACC-1 — Semantic access [A/M; S1/S9].** Target WCAG 2.2 AA across the complete task. Use native headings, landmarks, links, buttons, labels and table relationships before custom ARIA. Declare the page language and meaningful language changes. All actions need keyboard access and meaningful accessible names. Provide a skip link and logical focus order. Board dragging needs a non-drag action. Do not rely on a tooltip for an essential instruction.

**ACC-2 — Contrast [A/V; S2/S3].** Normal text requires 4.5:1; large text may use 3:1 (at least 24 CSS px regular or approximately 18.67 CSS px bold). Required graphical/control cues need 3:1 against adjacent colors. Test hover, selected, error, focus and overlay combinations in both themes. A decorative separator is different from a required input boundary. Disabled-control exceptions must not make the reason for disabling unreadable.

**ACC-3 — Focus and targets [A/M; S4/S6/P].** Meet the 24 × 24 CSS px AA target-size requirement or its documented spacing/inline exceptions. Our 44 px standalone touch default is stricter. Keep a visible focus indicator; product target is a 2 px contrasting outline with separation from the control. Sticky content MUST NOT cover the focused control; this product deliberately aims beyond AA's “not entirely hidden” minimum.

**ACC-4 — Reflow and text [A/V/M; S5/P].** Verify 320 CSS px and 400% zoom from a 1280 px viewport, plus 200% text enlargement. Essential content/actions must remain available without page-wide horizontal scrolling. Tables and graphs may use a named, keyboard-accessible local scroll region; cells and surrounding text must still be readable. Check text-spacing overrides, long labels and virtual-keyboard opening. Reduced motion and increased contrast must not remove meaning.

**ACC-5 — Authentication [A/M; S7].** Permit paste, password managers and applicable autocomplete. Preserve passkey and recovery paths. Errors must be understandable without revealing account information beyond the existing security contract. Code approval must identify the session/action being authorized; a successful code submission is not a generic login success.

**PERF-1 — Responsiveness [A/M; S15/P].** Field targets are LCP ≤2.5 s, INP ≤200 ms and CLS ≤0.1 at the 75th percentile, assessed separately for mobile and desktop where enough observations exist. Record sample size, period and device context. No field data means “not measured”, not “passed”. Private console usage may not appear in CrUX. Laboratory runs need a recorded device/network profile and repeatable data; Lighthouse TBT is not measured INP. Reserve layout space, keep input responsive during filtering/streaming, and avoid whole-page reloads for local changes. No analytics deployment is authorized by this document.

## 7. Concrete examples

| Surface | Reject | Required alternative | Rules |
| --- | --- | --- | --- |
| Hosts | Three decorative fleet cards, repeated “Manage”, status only as colored dots | Comparable host rows, labeled state, one “Add host”, inline problem and repair path on detail | NAV-3, VIS-5, INT-1 |
| Providers | Missing quota shown as 0% and green; “Optimize” without a defined effect | “Usage unavailable” with observation/error context; account-specific “Refresh usage” where supported | VIS-4, INT-6/7 |
| Library | Separate styling for every content type; save failure only in a disappearing toast | Shared type filter/editor grammar, visible unsaved/failed state, retained draft and retry | VIS-1, INT-3/5 |
| Agent rules | A wall of settings above the actual document | Module selection linked to effective preview; history and infrequent metadata separate | NAV-3, editor pattern |
| Portal inside Agents | Online avatar interpreted as task completion; refresh jumps away from the message being read | Independent activity/delivery/outcome labels, stable reading position and conversation-scoped drafts | INT-6/8 |
| Empty list | “Unlock your fleet's potential” above an oversized illustration | “No hosts registered” and the permitted “Add host” action | VIS-5, INT-7 |
| Failed filtered list | “No matches” when the API request failed | “Could not load hosts”, retained filters and Retry; previous rows labeled stale if retained | INT-7 |
| Destructive action | “Are you sure?” with a highlighted “Yes” | Object name, irreversible consequence, “Cancel” and “Delete project”; safe initial focus | INT-4 |

## 8. Baseline inventory and migration debt

This is a source audit, not a live visual acceptance report. All 39 `+page.svelte` entrypoints are represented below, including redirects and the legacy catch-all. The five workflow routes were added on 2026-10-20 with automated interaction and responsive coverage; manual screen-reader and independent usability acceptance remain separate. Route groups such as `(providers)` do not appear in browser URLs. Paths in this table include the `/admin` base. Child project pages inherit `PageShell` from their layout. “Step-2 check” is an unverified risk to exercise, not a confirmed defect.

| Current entry / view | Primary task and pattern | Existing composition | Step-2 check |
| --- | --- | --- | --- |
| `/admin` | Entry redirect | Load redirects to dashboard; layout gates auth/setup | Signed-out, new fleet and unreachable paths |
| `/admin/dashboard` | Prioritize attention; overview | `PageShell`, `Section`, `StatStrip`, attention/usage tables | Unknown/stale usage versus healthy zero |
| `/admin/hosts` | Find/register hosts; list | `PageShell`, `Toolbar`, `HostsTable`, add/seed sheets | Filter retention, loading and no matches |
| `/admin/hosts/[id]` | Diagnose/manage one host; detail | `PageShell`, attention, engine/access/advanced/delete sections | Long identity, accessible repair, disabled engine |
| `/admin/agents` | Operate agents; conversation / graph | `PageShell`, `ClientsWorkspace`, `GraphView`, inspector | Both views, reconnect, focus and non-graph access |
| `/admin/projects` | Browse/create projects; list | `PageShell`, `Toolbar`, `DataTable`, settings sheet | Selection scope and bulk destructive action |
| `/admin/projects/[slug]` | Project entry redirect | Redirect to board | Encoded slugs and back navigation |
| `/admin/projects/[slug]/board` | Manage work; board | Project shell, `Section`, columns, card sheet | Non-drag move, narrow layout, empty columns |
| `/admin/projects/[slug]/documents` | Edit notes/files; list + editor | Project shell, `DataTable`, `ListDetail`, `Toolbar` | Both kinds, unsaved input, long content |
| `/admin/projects/[slug]/reports` | Triage project reports; list/detail | Project shell, `Toolbar`, `ReportInbox`, `ListDetail` | Status vocabulary, mutation recovery |
| `/admin/projects/[slug]/activity` | Inspect project events; history | Project shell, `EventFeed`, `DataTable`, diagnostics | Pagination, timestamp context, long JSON |
| `/admin/agent-messaging` | Inspect coordination; list/history | `PageShell`, domain toolbar, address/conversation/delivery/group/conference views | Every subview, unreadable raw payloads, action scope |
| `/admin/workflows` | Find reusable instructions; list | `PageShell`, `Toolbar`, `DataTable`, module switch | Disabled versus empty, search, pagination, stale/denied |
| `/admin/workflows/new` | Author one reusable goal; editor | Structured `WorkflowEditor`, `FormField`, `SaveState`, `DraftGuard` | Validation, retained drafts, typed inputs, accessible task ordering/dependencies; opt-in required source receipts and applicability validation |
| `/admin/workflows/definitions/[slug]` | Inspect/edit versioned instructions; detail/editor | Goal/tasks/knowledge, version comparison, run preparation | CAS conflict retains draft; historical pinning; revert publishes a new version |
| `/admin/workflows/runs` | Find active work and evaluation; list | `PageShell`, filters, `DataTable`, pagination | Pending/evaluating/unknown outcomes; server filters and back navigation |
| `/admin/workflows/runs/[id]` | Understand progress and final evidence; detail/history | Result, open work and unmet checks before readable handover fields/lists; section links, copyable report, disclosed raw values, passed checks, task evidence, participants, evaluation/diff and events | Direct link/reload, stale data, claim uncertainty, chat reveal permission, closed-group history; incomplete answer drafts, linked validation, versioned summary confirmation and correction before execution; attributable required-source checks and missing/unavailable/mismatch states; nested handovers, visible partial outcomes and keyboard disclosures |
| `/admin/schedules` | Schedule/review prompts; list/detail | `PageShell`, `DataTable`, `ListDetail`, schedule form | Timezone, recurrence, failure and recovery meaning |
| `/admin/git-director` | Inspect merge coordination; list/detail | `PageShell`, `Toolbar`, `DataTable`, `ListDetail`, settings | Pending versus granted/denied; stale evidence |
| `/admin/transfers` | Inspect shared files; list | `PageShell`, `DataTable`, `Toolbar`, audit sheet | Expiry, unavailable download, limits and deletion |
| `/admin/activity` | Inspect changes/tool calls; history | `PageShell`, type selector, filters, event panels | Both types, empty/error, details and deep links |
| `/admin/reports` | Triage fleet reports; list/detail | `PageShell`, `Toolbar`, `ReportInbox`, `ListDetail` | Create/detail, long evidence, status transitions; feedback destination/configuration, opt-in, old-version/retest and uncertain publication evidence |
| `/admin/accounts` | Manage provider accounts and quota overrides (PayG, warnings, reset recovery); list | `PageShell`, `Toolbar`, `DataTable`, account dialogs | Codex/Claude/Grok, missing quota, expired auth |
| `/admin/engines` | Configure providers; settings, one engine per tab (`?engine=`) | `PageShell`, `Tabs`, `Section`, engine master switches, `EngineSection`, `EngineDangerZone` | Per-engine deltas, tab and hash deep links, save failure, suspended/destroy states |
| `/admin/limits` | Configure usage limits; settings | `PageShell`, `Section`, quota and scaling components, per-engine quota policy tabs | Hard/soft enforcement, per-engine warning policy, scaling tiers, save failure |
| `/admin/library` | Find shared knowledge; list | `PageShell`, type switch, `LibraryList`, `MemoriesPanel`, `RolesPanel` (roles module switch in the `PageShell` toggle) | All types, memory alternate views, search and permissions; roles off versus empty |
| `/admin/library/[type]/[name]` | Edit shared artifact; editor | Skill/artifact editors, `RoleEditor` (draft, publish, policy, `history` slot with versions/proposals/holders); invalid-type `PageShell`/`StateBlock` | Valid types, unknown type/name, unsaved changes; role draft versus published, proposal sheet focus |
| `/admin/library/agent-rules` | Edit effective instructions; editor | `PageShell`, module picker, live preview, advanced/history/manual modes | Preview failure and stored versus effective content |
| `/admin/people` | Manage admin users; list | `PageShell`, people section, wipe-all danger zone | Role/permission denial, last-owner protection, wipe confirmation |
| `/admin/api-keys` | Issue and revoke gateway keys; list + configuration | `PageShell`, API-key section, Configure panel | Reveal/copy, revoke, disabled surface/backend, legacy anchors |
| `/admin/secrets` | Manage agent-readable credentials; list | `PageShell`, secrets section, secret dialog | Reveal/copy, store switch off/empty, permission denial |
| `/admin/settings` | Set fleet behavior; settings | Narrow `PageShell`, `Section`, policy/session/retention controls | Immediate-save truth and scope clarity |
| `/admin/account` | Manage own identity/security; settings | `PageShell`, `Section`, profile/password/passkey/theme/device components | Device pairing, recovery, all theme modes |
| `/admin/manual` | Find help; help index | `PageShell`, `Section`, `StateBlock`, `ManualSidebar` | Findability and missing content |
| `/admin/manual/[slug]` | Read help; article | `PageShell`, `ManualSidebar`, `ArticleView` | Heading structure, code, long links, unknown slug |
| `/admin/login` | Sign in; authentication | `AuthShell`, `FormField`, passkey/password steps | Keyboard, password manager, failure/recovery |
| `/admin/password/reset` | Recover account; authentication | `AuthShell`, `FormField` | Request, valid/expired token and confirmation |
| `/admin/cli-auth/verify` | Authorize CLI session; authentication | `AuthShell`, `CodeInput`, `SessionDetails` | Invalid/expired code, session identity and result |
| `/admin/setup` | Provision fleet; setup | `WizardShell`; `AuthShell` for exceptional entry state | All nine steps, skip/resume, failed prerequisites |
| `/admin/[...legacy]` | Redirect old route or show 404 | `legacyTarget`, framework error handling | Mapping/query/hash preservation; unknown route recovery |

### Non-page and conditional surfaces

| Entry / trigger | Pattern and existing owner | Required migration coverage |
| --- | --- | --- |
| Initial auth / setup probe | Layout loading/redirecting state or `AuthShell` “API unreachable” | No setup/login redirect loop on transient failure; retry keeps intended location |
| Unknown route / unexpected page error | Catch-all throws 404; no custom `+error.svelte` at baseline | Assess framework fallback; make title, recovery and keyboard path match failure pattern |
| Sidebar, top bar (incl. live-updates, temporary-access and unhandled-reports indicators), mobile menu, hub/project navigation | App shell, registry, `HubTabs`, `ProjectTabsNav` | All destinations reachable at touch widths; no contradictory active locations; indicators hidden at zero and without the read capability |
| Cmd/Ctrl-K, global search, shortcuts help | Command palette, search modal, shortcuts components | Focus entry/exit, no results, accessible selection; shortcuts do not intercept typing |
| Chatty assistant | Shared shell assistant and chatty components | Availability/role gates, drafts, errors and confirmation of concrete changes |
| Client/session detail and attachments | Portal components inside Agents | Directory, retained chats, attention, timeline, composer, uploads, remote sessions, close/reconnect states |
| Host creation, quick VM, seed auth and insecure approval popup | Host sheets/dialogs and shared `SeedAuthPanel` | One auth upload UI; focus return, pending/error, safety consequences |
| Project About/settings, card editor, report creation/detail | Project and report sheets/dialogs | Preserve originating selection and draft; destructive scope clear |
| Account add/login/seed/reveal/revoke; People/API keys/Secrets dialogs | Domain components plus shared dialog/sheet primitives | No credential exposure in status text or URLs; copy result and permissions clear |
| Workflow run preparation, coordinator recovery and managed run group | Typed inputs, explicit controls, retained mutation receipt, existing `RoomConversation` | No implicit agent spawn; pause is no external process stop; run-owned membership; closed history |
| Editor history/version/preview/manual mode; memory alternate views and shared-memory restore from Activity; role proposal sheet, revert/withdraw/publish dialogs | Library components | Read-only versus editable state, failed preview, long documents; agent-authored proposal text shown as data |
| Schedule form/result, Git detail, transfer audit | `ListDetail` / domain sheets | Correct action and event scope; explicit uncertainty |
| Toasts, banners, inline alerts and confirmation dialogs | Shared feedback/UI components | Durable errors inline; focus, live announcements and both themes |
| Setup steps | Infrastructure, Owner, Engines, Credentials, Fleet defaults, Agent policy, Modules, Collaboration, First host | Test each step plus skip/resume; preserve shared `SeedAuthPanel`; first owner created is not wizard finished |
| `/cli/auth/verify` server entry | Session-gated redirect to admin CLI-approval page; may return 401 | Preserve the existing authentication contract; avoid duplicating UI |
| Retired `/go`, `/go/u/...`, `/admin/agent-portal` browser surface | No separate current portal page | Do not resurrect old portal login/theme scaffolding; current chat lives in Agents |

API endpoints, downloaded user-authored files, generated provider payloads and the native Android app are not browser page designs. A future product-owned browser surface MUST join this inventory and follow this standard.

### Confirmed source drift / decisions for step 2

| Baseline finding | Required disposition |
| --- | --- |
| Old spec listed direct Monitor/Fleet/Knowledge routes and called Settings retired; current registry has hubs, Library, Access and live Settings | Old spec replaced by a pointer. Follow current registry; do not recreate old navigation. |
| Portal comments in `tokens.css` still describe two browser apps; portal route registration and its security test show the separate `/go` endpoints retired | Keep shared tokens; clean obsolete explanatory comments when touching implementation. Do not infer a live portal from component names. |
| `PageShell`/`AuthShell` use 20 px titles while `h1`/`h2` tokens describe larger headings | Align shared typography to section 4; audit consumers before replacing aliases. |
| `PageShell` truncates its title; default descriptions use 13 px | Verify long identities and essential instructions; implement accessible full text/wrapping as required. |
| `StateBlock` exposes loading/error/empty only; `DataTable` substitutes no-match copy but no clear-filter action | Extend shared state composition for the applicable section-5 states. Preserve stale content deliberately. |
| Desktop control sizing exists, but universal coarse-pointer target compliance is not established | Audit actual hit areas; do not infer touch compliance from a 390 px screenshot. |
| Current route sweep covers registered destinations, not every dynamic route, wizard state or overlay | Expand acceptance matrix; record actual coverage rather than calling the existing sweep exhaustive. |

### Compatibility and architecture retained

The Svelte SPA is built from `frontend/` into committed `public/admin/`. Browser requests under `/admin` receive the SPA; API clients keep their JSON contracts. The route registry and [legacy mapper](frontend/src/lib/legacy-admin-routes.ts) remain authoritative implementation sources. Current aliases map clients/topology to Agents, logs to Activity, feedback to Reports, authoring/knowledge to Library, users/keys/secrets and the former `/access` page to People/API keys/Secrets, policies to Settings and old project sections to Board/Documents/Reports. Preserve supported query/hash behavior using mapper tests; do not invent blanket preservation for aliases that intentionally drop it.

Legacy pink theme preferences continue to normalize to the neutral light/dark/system family; this design standard does not remove compatibility inputs. Server state remains in TanStack Query and shared WebSocket invalidation. Pages must not establish competing listeners or duplicated settings ownership to achieve a new appearance.

## 9. Acceptance and step-2 checklist

### Existing checks (source-inspected; not executed for documentation adoption)

| Coverage | Existing location | What it does not establish |
| --- | --- | --- |
| Registry and compatibility | `frontend/src/lib/nav.test.ts`, `legacy-admin-routes.test.ts` | All rendered states or task comprehension |
| Theme normalization and token contrast | `frontend/src/lib/stores/theme.test.ts`, `styles/tokens.contrast.test.ts` | Every composed surface, focus or high-contrast state |
| Desktop destinations, shell, mobile, selected Axe and settings flows | `frontend/e2e/admin-console.spec.ts` | All dynamic details, overlays or WCAG AA conformance |
| Auth flows | `frontend/e2e/admin-auth-screens.spec.ts` | Entire setup, assistive authentication and all recovery failures |
| Conversation retention, reconnect, drafts, attention and mobile | `frontend/e2e/admin-clients.spec.ts` | Manual screen-reader reading of a long live conversation |
| Domain flows | `frontend/e2e/admin-host-detail.spec.ts`, `admin-accounts.spec.ts`, `admin-agent-messaging.spec.ts`, `admin-schedules.spec.ts`, `admin-git-director.spec.ts`, `admin-chatty.spec.ts`, `admin-companion.spec.ts` | Compliance of every page/variant just because the feature suite passes |

For UI implementation, run `npm run check` and `npm run test:e2e` from `frontend/`; the former includes unit tests. The latter rebuilds the committed SPA and starts its own preview on port 4173, refusing to reuse another checkout's server. Run these in the implementation worktree and review generated changes. `npm run build` is the standalone artifact build. **None of these commands is required merely to adopt this documentation; no SPA rebuild belongs in step 1.**

### Required evidence per migration slice

- [ ] Every changed route/view is linked to pattern and rule IDs. Include applicable loading, empty, filtered-empty, denied, disabled, error, stale and successful states.
- [ ] Test light/dark/system at 1440×900 and 1920×1080, 768×1024 tablet, 390×844 phone and 320 px reflow width. Record representative captures, plus long-label/data-heavy cases. Check 400% zoom and 200% text resizing manually.
- [ ] Complete the task using keyboard only; inspect focus after navigation, dialogs, errors, filtering and updates. Exercise a coarse pointer and virtual keyboard where relevant.
- [ ] Run Axe on changed views and overlays; investigate every finding against AA rather than treating only serious/critical findings as the complete bar. Record a manual screen-reader pass with browser/reader versions for representative list, form, auth and conversation flows.
- [ ] Verify both-theme rendered contrast, non-color status, local overflow, reduced motion, increased contrast and safe-area behavior. Capture actual hit areas for compact controls.
- [ ] Use deterministic fixtures for zero/missing/stale data, long identities, multiple engines, denied actions and ambiguous network outcomes. Check direct link, reload, back/forward and failed save recovery.
- [ ] Perform operator tasks: find a failed host and its repair; distinguish unavailable quota from zero; edit Library content and recover a failed save; answer a current agent question after reconnect without losing draft or position; finish/resume setup with a failed prerequisite.
- [ ] Have a reviewer other than the author complete those tasks without implementation hints. Record wrong turns, unclear labels and blocked actions; fix them before claiming the interface is understandable. If this review has not happened, mark usability acceptance pending.
- [ ] Record performance methodology and actual results when changing rendering/data volume. Keep field targets separate from laboratory evidence; no invented percentile from one run.
- [ ] Run canonical frontend checks, inspect the source/build diff, list remaining baseline debt and document any accepted exception. A rollout requires its own authorization and live evidence.

**Missing acceptance work:** full inventory/state screenshots, all nine setup steps, universal touch-target checks, complete zoom/text-spacing checks, screen-reader task review, cross-browser manual checks (Chromium, Firefox and Safari/WebKit), and representative field-performance measurements are not established by this source audit. Existing tests may cover subsets; inspect their assertions before reusing them as evidence.

For step 1, verify documentation links/anchors, route inventory coverage, source citations, rule/check mappings and a documentation-only diff. Do not report unrun browser or production checks as passing.

## 10. Exception register

No design exceptions were approved at adoption; EX-1 was added 2026-10-19. The baseline debt in section 8 is pending migration, not a permanent exemption. Use this format for subsequent reviewed decisions:

| Exception ID | Rule | Exact surface | User need / alternative | Verification | Owner / decision date | Review or removal condition |
| --- | --- | --- | --- | --- | --- | --- |
| EX-1 | VIS-5 | Overview (`/admin/dashboard`) host and stored-account count tiles (`StatStrip variant="tiles"`) | Operators open the console to see fleet size first; each tile links to its owner page (Hosts, Accounts) and the per-engine split is shown inline. Alternative: the inline strip. | Visual check in both themes; `admin-design.spec.ts` sweep | Christian Reiß / 2026-10-19 | Remove (back to the inline strip) if the counts stop answering an operator question or no longer link to their owning page |
