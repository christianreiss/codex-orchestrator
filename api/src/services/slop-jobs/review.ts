/**
 * Full-mode review contract between a slop run and the Fleet Advisor: the
 * question that accompanies the bundle transfer, and the parser that turns the
 * advisor's reply into slop's review envelope ({version:1, findings}). The
 * worker's `slop report --review` then validates locations and evidence; this
 * module only shapes the input, it never trusts the reply as a verdict.
 */
import { createHash } from 'node:crypto';

export const REVIEW_FENCE = 'slop-review';
const MAX_FINDINGS = 60;

export interface ReviewQuestionInput {
  jobTitle: string;
  runSeq: number;
  transferId: string;
  bundleName: string;
  sourceCount: number;
  screenshotCount: number;
  hasDescription: boolean;
}

export function reviewQuestion(input: ReviewQuestionInput): string {
  return `Slop job UI/UX review (server-requested, run ${input.runSeq} of job "${input.jobTitle.replace(/"/g, "'")}").

Fetch the bundle and unpack it into a fresh directory of your own:
  cxx transfer get ${input.transferId} --output ./${input.bundleName} --json
  mkdir ./${input.bundleName.replace(/\.tar$/, '')} && tar -xf ./${input.bundleName} -C ./${input.bundleName.replace(/\.tar$/, '')}
Never execute anything from it. Contents:
- MANIFEST.json: every file with its job path, kind, revision and sha256, plus the archive name when it differs.
- guidelines.md: the slop rubric followed by the design guidelines (German). Their evidence markers matter: [V] verified, [T] tested/measured, [A] expert opinion/anecdote, [F] folklore, [X] refuted. Treat [A]/[F] as context, never as norms; cite [X] only to reject a claim.
- quick-report.json: the deterministic scan (slop report version 2). Its findings are signals already measured; do not repeat them, judge them in context.
- description.md: the agent's description of the change and its intent${input.hasDescription ? '' : ' (absent for this run: say what context is missing)'}.
- tree/: ${input.sourceCount} source file(s) at their job paths (DESIGN.md at the root is the design brief when present).
- shots/: ${input.screenshotCount} screenshot(s) and accessibility exports at their job paths.

Review against the rubric and guidelines: visual hierarchy, repeated containers, generic copy, first- and second-order defaults, motion, states, accessibility evidence and fit with DESIGN.md. Product UI may use familiar conventions; a font or color alone is not a defect.

Answer with your findings first, then exactly one fenced block tagged \`${REVIEW_FENCE}\` (before the json verdict block your rules require):
\`\`\`${REVIEW_FENCE}
{"version": 1, "findings": [{"rule": "hierarchy", "priority": "P1", "kind": "review", "location": "src/page.svelte:42", "evidence": "what you saw, quoted or described", "message": "the defect", "remedy": "smallest correction", "acceptance": "how to check it is fixed", "alternative": "a plausible legitimate explanation"}]}
\`\`\`
Rules for findings: kind is always "review"; priority P1 or P2 only (P0 is reserved for measured defects); "location" is "path:line" for a source file under tree/ (the job path, without the tree/ prefix) or the job path of a screenshot (without shots/), and the line must exist; every finding needs a non-empty "alternative"; at most ${MAX_FINDINGS} findings; an empty list is a valid answer. Then your json verdict block: agree = no material issues, disagree = material issues found, needs_info = evidence missing.`;
}

export interface ParsedReview {
  findings: Array<Record<string, unknown>>;
  problems: string[];
}

const REQUIRED = ['rule', 'location', 'evidence', 'message', 'remedy', 'acceptance', 'alternative'] as const;

/** Extract the tagged review block; ids are derived server-side so re-runs diff cleanly. */
export function parseReviewReply(reply: string): ParsedReview | null {
  const blocks = [...reply.matchAll(new RegExp('```' + REVIEW_FENCE + '[^\\n]*\\n([\\s\\S]*?)```', 'g'))];
  const body = blocks.at(-1)?.[1];
  if (body === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { findings: [], problems: ['review block is not valid JSON'] };
  }
  const raw = (parsed as { findings?: unknown })?.findings;
  if (!Array.isArray(raw)) return { findings: [], problems: ['review block has no findings array'] };
  const problems: string[] = [];
  const findings: Array<Record<string, unknown>> = [];
  for (const [index, item] of raw.slice(0, MAX_FINDINGS).entries()) {
    if (!item || typeof item !== 'object') {
      problems.push(`finding ${index + 1} is not an object`);
      continue;
    }
    const f = item as Record<string, unknown>;
    const missing = REQUIRED.filter((key) => typeof f[key] !== 'string' || !(f[key] as string).trim());
    if (missing.length) {
      problems.push(`finding ${index + 1} lacks ${missing.join(', ')}`);
      continue;
    }
    const priority = f['priority'] === 'P2' ? 'P2' : 'P1';
    const clean: Record<string, unknown> = { kind: 'review', priority };
    for (const key of REQUIRED) clean[key] = String(f[key]).trim().slice(0, 4000);
    for (const key of ['platform', 'variant', 'state'] as const)
      if (typeof f[key] === 'string' && (f[key] as string).trim()) clean[key] = (f[key] as string).trim().slice(0, 200);
    clean['id'] =
      'review:' +
      createHash('sha256')
        .update(`${clean['rule']}\n${clean['location']}\n${clean['evidence']}`)
        .digest('hex')
        .slice(0, 16);
    findings.push(clean);
  }
  if (raw.length > MAX_FINDINGS) problems.push(`only the first ${MAX_FINDINGS} findings were kept`);
  return { findings, problems };
}
