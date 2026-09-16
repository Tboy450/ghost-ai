# Ghost — where we are and what's next

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
