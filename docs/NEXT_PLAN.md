# Ghost — where we are and what's next

## Task list

Tick these off as they land. Each needs a dated row in
`docs/IMPLEMENTATION_CHECKLIST.md` with the real result before it counts as done.

### Step 7 — Git integration (next)

`studio/git.mjs` already does worktrees, branches, commits, pushes and diffing, because
self-update needed them. What is missing is everything the user touches.

- [x] **Named checkpoints.** Save the working tree under a name you choose, list them
      with times, and return to one. Must survive a restart.
- [x] **Readable change review.** What changed, in summary form — files touched, what
      each change does — not a raw diff wall. The diff stays available underneath.
- [ ] **Commit and push from the UI.** Show the branch and the exact file list before
      anything happens. Never stage unrelated edits.
- [x] **Restore.** Return to a checkpoint and confirm the tree matches, with a clear
      warning about what will be discarded. Ghost saves a safety checkpoint of the
      current state first, so any restore can itself be undone.
- [ ] **Failure cases tested live.** No remote configured, rejected push, dirty tree,
      conflict on restore. Each must give a readable message, not raw git output.

### Step 9 — Comparisons

- [ ] **Real scoring.** Matched questions, recorded configuration, actual correctness,
      recall, latency and memory use. Build on `scripts/bench_memory.mjs`.
- [ ] **Separate human review from heuristic scores.** Never present a heuristic as a
      judgement.
- [ ] **Repeatable.** The same inputs give the same numbers, so a change can be shown
      to be an improvement rather than assumed to be one.

### Step 10 — Desktop packaging

- [ ] **Install and first run** on a machine with nothing set up.
- [ ] **Startup diagnostics** — say which part is missing in plain words when Ghost
      cannot start.
- [ ] **Model setup** from inside the app.
- [ ] **Updates that preserve user data** — conversations, memory and projects survive.

### Carried debt

- [ ] **Tune the two `extractSegment` thresholds** — collapse at 0.4, balloon at 3× are
      still guesses. Measure them the way the 900 budget was measured.
- [ ] **Raise the local model's hit rate** — narrower per-segment instructions, or a
      larger model. Currently around half of rewrites are usable.
- [ ] **Top up OpenAI billing** to unblock the API path. No code change can do this.
      The relay path needs no key and is unaffected.

## Where we are

Steps 1–7 of the ten-step roadmap are done. The browser relay — the self-improvement
path that needs no API key — now works from end to end:

1. You paste Ghost's focus into a public chat (ChatGPT, Grok, DeepSeek, Copilot…).
2. The chat answers with a short plan in plain words.
3. Ghost's local model implements that plan one bounded segment at a time.
4. Ghost checks the result and applies it only if it is safe.

That last step used to hang forever. It now finishes in seconds and always produces a
readable report, whether it succeeds or not.

## What the safety chain does

An automated rewrite is guilty until proven innocent. Four gates, each catching
something the one before it cannot see:

| Gate | Catches | Proven by |
| --- | --- | --- |
| Size guards | A segment collapsed to a stub or ballooned | Live run |
| Alphabet guard | Characters the original never had (a real run emitted CJK inside an import path) | Live run, verbatim in a test |
| Syntax check | Files that will not parse, naming the file and the error | Live run |
| Full test suite | Code that parses but is wrong | Live run — caught `registry is not defined` and refused to commit |

Nothing is committed unless every gate passes. A failure leaves your project exactly as
it was and tells you why in plain language.

## What's next

### Step 8 — Git integration
Checkpoints before risky work, a readable review of what changed, then commit and push.
Groundwork is in `studio/git.mjs` (worktrees, branches, diffing). What's missing is the
user-facing part: a checkpoint you can name and return to, and a change review that reads
like a summary rather than a raw diff.

### Step 9 — Comparisons
Repeatable scoring of answer quality, memory retention and coding success, so a change
can be shown to be an improvement instead of assumed to be one. `scripts/bench_memory.mjs`
is the starting point. The comparison UI already exists; it needs real scoring behind it.

### Step 10 — Desktop packaging
One-click install, start, stop, model setup and updates.

### Known gaps
- **The API path needs billing.** The OpenAI key is valid but the account is at zero
  (`insufficient_quota`). No code change can fix that. The relay path needs no key and is
  unaffected.
- **Two `extractSegment` thresholds are still guesses** — collapse at 0.4 and balloon at
  3×. The segment budget (900) was measured against a real file; these two were not.
- **The local 4B model produces working code roughly half the time.** In the last live
  run it rewrote 3 of 6 segments and correctly left 3 alone, but its rewrite of
  `studio/projects.mjs` failed the suite. The gates make that safe, not rare. A larger
  model, or narrower per-segment instructions, would raise the hit rate.

## The rule that keeps being relearned

Every real bug this month passed a green test suite and appeared only under live
execution: the relay scope bug, the stale worktree, the TDZ crash, the fence mismatch,
the oversized budget, the model corruption, the destructive force-remove, the hang.

Unit tests that hand-build their own inputs cannot catch bugs in the code that builds
those inputs for real. So: run the real thing, and after fixing a bug, **revert the fix
and confirm the new test fails**. A test that passes either way is proving nothing.
