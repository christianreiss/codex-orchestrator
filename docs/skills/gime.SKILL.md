---
name: gime
description: "Use #gime (no arguments) to merge the current worktree's branch back into its target, committing pending work first, then delete the branch and remove the worktree once the merge is confirmed landed. Use when an agent working in a git worktree is done and needs to land its branch and clean up after itself."
---

# What this skill does

Lands a worktree's finished branch back into its target branch and tears down
the worktree — commit, merge, verify, cleanup — in one invocation, with no
arguments needed. Built for the fleet's shared-clone-with-worktrees model,
where the Git Director (`git_*` MCP tools) arbitrates merges into branches
other agents may also be touching.

## When to use this skill

Use `#gime` when you are finished with work done in a git worktree and want it
merged back into whatever branch it came from, then want the worktree and
branch gone. No arguments — everything needed is derived from the current
worktree.

Do not use it mid-task, on a dirty worktree you don't intend to finish, or
when the branch isn't actually ready to land (unresolved review comments,
failing checks the user hasn't waived).

## Step 0 — orient

- `git status --short --branch`
- `git rev-parse --show-toplevel --git-common-dir --abbrev-ref HEAD HEAD`
- `git remote get-url origin` (if a remote exists)
- Determine the **target branch**: the upstream tracking branch
  (`git rev-parse --abbrev-ref --symbolic-full-name @{u}` stripped of
  `origin/`) if set; otherwise the branch this one forked from
  (`git merge-base --fork-point <candidate> HEAD` against likely candidates,
  or ask `git_list`/`git_join` records what this worktree declared as its
  merge target); otherwise fall back to the repo's default branch
  (`main`/`master`).
- If you cannot confidently determine a target, stop and say so — do not
  guess a destructive default.

## Step 1 — register with the Git Director

- `git_list` first, so you know who else is in this clone.
- If this worktree isn't registered yet, `git_register` with the facts from
  Step 0, then `git_join` declaring the task and the target branch you found.

## Step 2 — commit pending work

- If `git status --short` shows changes, stage only task-owned paths
  (never `git add -A` / `git add .`) and commit with a message explaining
  *why*, not just what. Do not commit files that look like secrets without
  checking their contents first.
- If the tree is clean, skip straight to Step 3.

## Step 3 — request the merge lease

- Compute `changed_paths` from `git diff --name-only <target>...HEAD`.
- Call `git_merge_request` with the target branch and `changed_paths`.
- **allow** → proceed to Step 4.
- **wait** → do not merge anyway. Report who/what you're waiting on (from
  the verdict) and stop; this is not a Hard Stop Line to argue around, it's
  another agent's in-flight work. Poll once with `git_merge_status` if asked
  to retry, otherwise leave it for a later `#gime` call.

## Step 4 — merge into the target

- Find where the target branch is actually checked out:
  `git worktree list --porcelain`.
  - **Target has its own worktree** → run the merge there:
    `git -C <target-worktree-path> merge --no-ff <feature-branch> -m "Merge branch '<feature-branch>'"`.
  - **Target has no worktree of its own** (and isn't the branch you're
    currently on) → update it directly:
    `git fetch . <feature-branch>:<target>` (fast-forward only; if it's not
    a fast-forward, create/borrow a worktree for the target and merge there
    instead so you get a real merge commit).
- If the merge conflicts: stop. Do not force-resolve blindly, do not
  discard either side. Report the conflicting files and leave the worktree
  and branch intact for manual resolution — skip Step 6 entirely.
- Do not push. Landing is a local merge, and invoking `#gime` grants no push,
  including on the repo's default branch: commit-and-merge never grants a
  push. Push the target (`git -C <target-worktree-path-or-repo> push origin <target>`)
  only when the operator's request explicitly asked for a push, and name that
  request in your final report.

## Step 5 — verify the merge actually landed

- `git merge-base --is-ancestor <feature-branch> <target>` must succeed.
- If you pushed in Step 4, confirm `git ls-remote origin <target>` matches the
  local target SHA.
- If verification fails for any reason, stop before cleanup and report the
  discrepancy — never delete a branch or worktree you haven't confirmed is
  fully merged.

## Step 6 — release the lease

- `git_release` immediately once the merge is confirmed landed. A forgotten
  lease blocks the branch for every other agent until it expires.

## Step 7 — cleanup (only after Step 5 verified clean)

- Delete the local feature branch with a **safe** delete, never forced:
  `git branch -d <feature-branch>`.
- If the feature branch exists on the remote, deleting it there is a push
  too: run `git push origin --delete <feature-branch>` only under the same
  explicit push request as Step 4; otherwise leave it and list it in the report.
- Remove the worktree from outside it (you can't remove the one you're
  standing in): `git worktree remove <worktree-path>`, then
  `git worktree prune`.
- Deregister from the Director for that worktree: `git_release` with
  `deregister: true`.
- Never touch another agent's branch, worktree, or unmerged work while doing
  this — cleanup is scoped strictly to the branch/worktree `#gime` just
  landed.

## Step 8 — report

State: target branch, merge commit SHA, whether it was pushed (and which
operator request asked for it) or left local, the worktree path removed, and
the branch(es) deleted (local/remote). If anything stopped early (wait
verdict, conflict, failed verification), say exactly what's blocking and that
no cleanup happened.
