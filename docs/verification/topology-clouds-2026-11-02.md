# Topology clouds and route evidence — 2026-11-02

## Reproduction and cause

The old envelope function returned a visible scalloped hull for one member and
accepted no foreign-node or label geometry. It could therefore enclose unrelated
objects. A singleton regression was observed failing before the implementation
changed. The replacement is pure over member coordinates and measured obstacles;
it does not change node positions or infer membership from proximity.

The header/list/inspector described `association.state=unattributed` as Direct.
`api/src/services/topology/build.ts` actually uses that state when there is no
session-traffic evidence on a current communicator, and includes unended offline
records. The route cannot be inferred from that state.

An authenticated production snapshot on 2026-11-02 after the cxx rollout showed
Janine, Frederike, Lea, Hiltrud, Victoria and Michaela offline with `basis=none`.
These are the six dotted nodes in the operator screenshot, not six observed active
direct transports. Christl on twingo was independently idle/active and unattributed:
its host had a connected 0.9.148 communicator reporting four leases but no attributed
agent requests. That is an attribution gap, not proof of a bypass. No remote session
was ended or assigned to a parent merely to make the diagram look connected.

## Implementation and limits

Cloud membership requires the same project room and exact reported working
directory on the same host. Host identity disambiguates local filesystem paths;
it never creates a cloud by itself. Distinct worktrees are separate even when they
share one project. The selector offers None or Same project + directory, and old
Host/Project + Host preferences migrate to the latter. Project chat chips retain
full room membership independently of the narrower outline membership.

Contours connect members with a deterministic minimum spanning tree and route
obstructed edges through padded obstacle corners. Signed-distance clipping reserves
space around foreign bodies and actual SVG text bounds. Independent groups partition
their overlapping fields with a clearance gap; groups sharing real members can
overlap. Marching squares uses a fixed four-unit grid and interpolated vertices.
Even-odd fill preserves holes. The stroke uses world units like the clearance.
Final validation checks member containment, foreign filled-region containment and
every rendered segment against expanded obstacle rectangles.

Contours wait until node motion and font metrics settle, and stable geometry is
cached across clock ticks. A routing graph is bounded to 64 obstacle rectangles;
larger sets use clipped connectors. A contour grid exceeding 100,000 cells, or an
outline that would lose a member or violate clearance, is omitted with visible
status. Narrow/interleaved geometry may have separate contour pieces. Group chips
and the equivalent list retain access in every case.

## Verification

- `npm run check`: zero errors, 1,020 unit tests passed. One existing accessibility
  warning in the unchanged `CommunicatorApiSection.svelte` remains.
- `npm run test:e2e`: 411 browser tests passed before the final routing and directory
  refinements; all 24 affected topology browser tests passed against the final
  production build. The build copied the deployable SPA to `public/admin`.
- Geometry tests cover singleton/duplicate/missing members, coincidence,
  deterministic permutations, node immutability, an intervening foreign body and
  protruding label, connected routing, independent cloud clearance, shared
  membership, and infeasible/oversized suppression.
- Membership tests require the same project and exact local directory and exclude
  separate worktrees, different projects, other hosts and unknown directories.
  Browser tests migrate both saved host modes, keep project chats available and
  remove every outline when all project members are in different directories.
- The topology browser regression samples the actual SVG fill and stroke against
  foreign node halos and text at 1920/1440/768/390/320 px in light/dark/system modes,
  plus zoom in/out. Singleton chats remain accessible. Keyboard selection, reduced
  motion, offline explanation and an Axe scan are included.
- Desktop light and phone dark screenshots were visually inspected. Manual screen
  reader, independent usability review and the optional cross-browser suite were
  not run. No API implementation, database schema or wrapper source changed.

Build, live deployment identity and final topology-suite results are recorded at
delivery; generated SPA assets are included in the source commit.

## Host-chat extension

Host rooms with more than one member get a separate chat shortcut. Its recipient
scope and count come from the complete room snapshot, independent of graph search,
filters and cloud setting. Single-member hosts have no group shortcut. The existing
scope conversation and host-room send endpoint are reused; no messages are sent
automatically by displaying the shortcut, and no host outline is generated.

The browser regression opens the host chat with clouds set to None and a search
showing only one agent, then verifies that the full three-member host scope is
sent rather than a filtered recipient list. It also covers singleton exclusion,
project mode without project rooms, 390px layout and Axe on the open conversation.
Only mocked browser sends are performed; no test message is broadcast to real
fleet agents.

Final extension checks: `npm run check` passed 1,020 unit tests with the one
unchanged accessibility warning in `CommunicatorApiSection.svelte`; the complete
`npm run test:e2e` suite passed 414 tests and rebuilt the committed SPA. The host
case also checks a long hostname at 320px. Axe initially exposed the existing
scope conversation's skipped heading level; its title now uses h2 and the scan
passes. The 390px host-chat screenshot was inspected. Manual screen-reader and
real fleet delivery acceptance were not performed.
