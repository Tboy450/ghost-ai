# Ghost implementation checklist

This checklist tracks the recommended implementation order. Each completed item should
include a concrete validation command or recorded result before it is marked complete.

## Roadmap

All ten improvements are pending. Work is only marked complete after its relevant
checks pass, progress notes are updated, the changes are committed and pushed, and
the remote commit is verified.

- [x] **1. Validate the local model**
  - [x] Ollama v0.34.0 and `qwen3:4b-instruct` installed via `scripts/Setup-LocalModel.ps1`.
  - [x] Live answer correctness confirmed ("Local inference is working.").
  - [x] Live streaming confirmed via token events.
  - [x] Live cancellation confirmed (`--check-cancellation` passed after restart).
  - [x] Confirmed working after a full Ollama engine restart (process killed, `scripts/Start-Ghost.ps1` restarted it, revalidated).
  - [x] Automated contract tests: `node --test studio/tests/*.test.mjs` — 8/8 passed.
  - **Warm throughput:** ~31–34 tokens/sec, ~60-330ms first-token latency once the model is resident (RTX 3050 Laptop GPU, 4 GB VRAM, 2.3 GB used).
  - **Cold-start note:** first request after model load took ~10.6s (0.99 tok/s) purely from model-load overhead; this is expected and separate from steady-state performance, which step 2 will benchmark further.
- [x] **2. Measure and tune performance**
  - [x] Benchmarked Eco, Balanced, and Deep profiles (3 runs each) via `validate-local-model.mjs --profiles=eco,balanced,deep --runs=3`.
  - [x] Measured warm tokens/sec, first-token latency, and total latency per profile.
  - [x] Measured GPU layer offload and VRAM usage per profile via Ollama logs and `nvidia-smi`.
  - [x] Tested whether `num_batch` affects GPU layer offload (it does not; `num_ctx` is the governing factor).
  - [x] Documented findings and hardware-tuning guidance in `docs/PERFORMANCE.md`.
  - **Result:** Eco ~38–42 tok/s (30/37 GPU layers), Balanced ~31–35 tok/s (26/37), Deep ~25–31 tok/s (23/37) on a 4 GiB VRAM RTX 3050 Laptop GPU. Existing `PROFILES` defaults already reflect the correct trade-off for this hardware; no profile code change was needed.
- [x] **3. Add project management**
  - [x] New `studio/projects.mjs` module: a project is any folder on disk; its sessions, runs, backups, and activity log live inside `<project>/.ghost/` (portable, self-contained), tracked by a small `projects.json` registry.
  - [x] `studio/server.mjs` refactored: `applyProject()` switches the active project and its data dirs; `ROOTS.workspace` now points at the active project's folder.
  - [x] New API: `GET /api/projects`, `POST /api/projects` (open), `PUT /api/projects/active` (switch), `DELETE /api/projects` (close, with fallback/last-project guard). `/api/bootstrap` now returns `projects` and `activeProject`.
  - [x] UI: topbar now has a project switcher (`select`) plus an "open a folder" button (`＋`) next to the breadcrumb, wired to the same API.
  - [x] Unit tests: `studio/tests/projects.test.mjs` (4/4) — open/register, reuse existing id on reopen, switch, close-with-fallback and refuse-to-close-last-project.
  - [x] Integration test extended in `studio/tests/api.test.mjs`: opening a second project isolates sessions/files (workspace file from project A returns 404 while project B is active), switching back restores project A's session/file, and closing a project falls back correctly.
  - [x] Manual smoke test: started the real server, opened a new project folder via the API, confirmed `bootstrap.activeProject` switched and session count reset to 0, listed both projects, switched back, confirmed original project restored.
  - [x] Full suite re-run after refactor: `node --test studio/tests/*.test.mjs` — 12/12 passed (no regressions to the pre-existing default-workspace bootstrap path).
- [x] **4. Improve memory recall**
  - [x] Added light stemming (`studio/memory.mjs`) so plurals/verb forms ("databases"/"configuring") still match their root term, not just exact keywords.
  - [x] Added a small curated synonym table (database/db, deadline/due, timezone/tz, configuration/config/setting, requirement/spec, delete/remove/erase, password/credential/secret, error/bug/issue/defect) so common paraphrases recall the right memory.
  - [x] Recalled context records now carry a source reference: each item keeps its originating turn number and, when available, the message's original timestamp, and the packed prompt shows `[turn-id; kind; previous user text at <timestamp>]`.
  - [x] Added supersession detection: when a later constraint clearly restates the same topic as an earlier one (overlap-coefficient ≥ 0.55 on stemmed/synonym-expanded terms), the stale earlier constraint is dropped from recall so only the current instruction surfaces.
  - [x] Broadened constraint detection to catch revision phrasing ("instead", "switch", "actually", "from now on", "change to", "update") in addition to the original "must/never/always/..." set.
  - [x] Memory panel UI (`app.js`) now shows the source timestamp alongside each recalled card's turn id and kind.
  - [x] Tests added to `studio/tests/core.test.mjs`: paraphrased-keyword recall, later-instruction supersession, and source-reference (turn + timestamp) presence. Full suite: `node --test studio/tests/*.test.mjs` — 15/15 passed, no regressions.
- [x] **5. Make context management adaptive**
  - [x] Added `packAdaptive()` (`studio/memory.mjs`): automatically tries Eco first, then Balanced, then Deep, and stops at the smallest profile whose budget fully holds the current message, recalled constraints, and every pinned note (no silent omissions) — instead of requiring the user to hand-pick a profile before every message.
  - [x] `studio/server.mjs` `/api/chat` now defaults to `profile:'auto'`; an explicit `eco`/`balanced`/`deep` request still bypasses adaptive selection and uses exactly that profile (unchanged behavior for existing callers/tests).
  - [x] Session persists which mode was requested (`'auto'` vs. an explicit profile) so the composer's memory-profile selector restores correctly; the concrete profile actually used for a turn is reported separately in `stats.profile` plus `stats.adaptive`/`stats.adaptiveReason`.
  - [x] UI: memory profile selector defaults to "Auto · fits the smallest profile that works"; the Memory panel now shows which profile was chosen and, when adaptive, why (e.g. "fits within Eco limits").
  - [x] The full transcript is still retained on disk regardless of the chosen profile — adaptivity only changes how much of it is itemized/recalled into a given request, per step 4's recall layer.
  - [x] Tests added: `packAdaptive` picks Eco for a short conversation, escalates to a larger profile when a large pinned note would otherwise be dropped, and an explicit profile still bypasses adaptive selection (`studio/tests/core.test.mjs`). End-to-end `/api/chat` with `profile:'auto'` verified via the fixture-backed integration test (`studio/tests/api.test.mjs`).
  - **Result:** Full suite `node --test studio/tests/*.test.mjs` — 18/18 passed, no regressions.
- [x] **6. Upgrade the editor**
  - [x] Added syntax highlighting: a new dependency-free `studio/public/highlight.js` tokenizes JS/TS, Python, JSON, and Markdown into comment/string/number/keyword spans, rendered as a `<pre>` overlay behind a transparent-text `<textarea>` (classic overlay technique, scroll-synced), so typing and selection still use the native textarea.
  - [x] Added real multi-file tabs: `state.openFiles` tracks every opened file with its own in-memory draft and dirty flag; a new tab strip (`#editor-tab-strip`) lets you switch between open files without losing unsaved edits in the others, close a tab (with a discard-confirmation if dirty), and automatically evicts the oldest clean tab past 8 open files.
  - [x] Added project-wide search: a new `searchProject()` in `studio/core.mjs` and `GET /api/search?root=&q=` route search file *contents* (not just names) across every file in the selected root; the file panel's search box now has a toggle (`⌕`/`☰`) to switch between filename filtering and content search, showing file/line/snippet results.
  - [x] Added previews of proposed edits: a new dependency-free `studio/public/diff.js` computes a line-based diff (LCS backtrace) with context-collapsing for long unchanged runs; the chat's "Use in editor" action now opens a diff-preview dialog (added/removed lines highlighted) instead of silently overwriting the editor, with explicit Apply/Cancel.
  - [x] Guarded project switching/opening (`switchProject`/`openProjectFolder`, which reload the page) with an unsaved-changes confirmation across all open tabs, not just the active one.
  - [x] Tests added: `studio/tests/editor.test.mjs` (10 tests — diff correctness, context-collapsing, JS/Python tokenization, HTML escaping, unknown-language fallback); `searchProject` unit test in `studio/tests/core.test.mjs`; end-to-end `/api/search` test in `studio/tests/api.test.mjs`.
  - [x] Manual smoke test: started the real server, confirmed `/diff.js` and `/highlight.js` serve as `text/javascript`, and `GET /api/search?root=workspace&q=Ghost` returns a matching line from `Getting started.md`.
  - **Result:** Full suite `node --test studio/tests/*.test.mjs` — 28/28 passed, no regressions.
- [x] **7. Add Git integration** *(expanded scope: also adds AI-driven self-improvement)*
  - [x] New `studio/git.mjs`: a guarded wrapper around the `git` CLI (argv-array `spawnSync`, no shell interpolation), scoped to a project folder — `isRepo`, `currentBranch`, `status`, `diff`, `log`, `commit`, `currentHash`, `push`, `fileAt` (read a file at a past commit, for restore), and `addWorktree`/`removeWorktree` (isolated worktree + branch, used by the self-improvement cycle below so automated changes never touch a live checkout).
  - [x] New API routes in `studio/server.mjs`: `GET /api/git/status`, `GET /api/git/diff`, `GET /api/git/log`, `POST /api/git/commit`, `POST /api/git/push`, `POST /api/git/restore` — all scoped to the active project (`root=workspace`) and returning a clear 409 when the folder isn't a git repository.
  - [x] New "Git" view in the UI: file-status list, a diff viewer (reuses the step-6 `diffLines`/context-collapsing renderer), a commit-message box + Commit/Push buttons, and commit history.
  - [x] `ensureProjectDirs()` (`studio/projects.mjs`) now auto-adds `.ghost/` to the project's `.gitignore` when the project is a git repo, so Ghost's own session/backup data never clutters the Git status view.
  - [x] **Expanded per user request:** Ghost can now consult a public AI provider (OpenAI/GPT, xAI/Grok, DeepSeek, Meta/Llama via Together.ai, or GitHub Models/Copilot) to propose a change toward a configurable focus task, and — only if the full test suite passes inside a disposable, isolated `ghost/self-update` worktree/branch — commit and push it. New `studio/selfimprove.mjs`: `PROVIDERS` table, `listProviders()`, `getFocus`/`setFocus`/`advanceFocus` (a persisted focus + task queue, editable via the API/UI, seeded with the remaining roadmap steps), `callProvider()` (one OpenAI-compatible HTTP client for all five providers), `buildRepoSummary`, `parseProposal`/`applyProposal` (safe whole-file-rewrite proposals; rejects path traversal/absolute paths, caps file count/size), and `runCycle()` (full orchestration + a saved JSON report per cycle).
  - [x] New API routes: `GET /api/self-improve/providers`, `GET`/`PUT /api/self-improve/focus`, `POST /api/self-improve/run` (guarded against concurrent runs), `GET /api/self-improve/history`.
  - [x] New "Self-improve" view in the UI: an editable focus + task queue, a provider picker (shows which providers are configured via env var), a "Run one cycle" button, and a history feed showing each cycle's summary, applied files, test result, and whether it was committed/pushed — this is the concrete "report back to me... each cycle" surface the user asked for.
  - [x] **Safety model adopted** (the user was unavailable to confirm live, so I chose the safest reasonable default and flagged it for override): a cycle only runs when explicitly triggered (no background/cron loop yet); it only activates for a provider whose API key env var (`GHOST_OPENAI_API_KEY`, `GHOST_XAI_API_KEY`, `GHOST_DEEPSEEK_API_KEY`, `GHOST_TOGETHER_API_KEY`, `GHOST_GITHUB_TOKEN`) is set — Ghost never invents/stores keys; all proposed work happens in a disposable `git worktree` on a dedicated `ghost/self-update` branch, never the user's live working directory/branch; a commit only happens after the full test suite passes inside that isolated worktree; a push only happens after a successful commit, and only to that same isolated branch (never `main` or the user's active branch), so a human can review/merge it.
  - [x] Tests added: `studio/tests/git.test.mjs` (4 tests — repo detection, status/diff/commit/log on a temp repo, `fileAt` restore-from-history, isolated worktree add/remove) and `studio/tests/selfimprove.test.mjs` (7 tests — provider config reporting, focus persistence/advance, unsafe-path rejection, missing-API-key error, and three full `runCycle` end-to-end scenarios against a fake OpenAI-compatible HTTP fixture + temp git repo + bare remote: passing-tests commit-and-push, failing-tests discard-without-commit, and malformed-AI-response error handling).
  - [x] Fixed a Node test-runner quirk: `runTests()` now strips `NODE_TEST*` env vars before spawning the nested `node --test` run, so a cycle's test run isn't silently skipped as a "recursive" test-runner invocation when Ghost's own tests (or Ghost itself) are already running under `node --test`.
  - [x] Manual smoke test: started the real server against a temp git-initialized project, verified `GET /api/git/status|log|diff`, `POST /api/git/commit` (confirmed `.gitignore` auto-added and `.ghost/` correctly excluded from status), and `POST /api/self-improve/run` end-to-end validation paths (unsupported provider → 400, unconfigured provider → clear error recorded in the report and in `/api/self-improve/history`).
  - **Result:** Full suite `node --test studio/tests/*.test.mjs` — 39/39 passed, no regressions.
- [x] **7a. Remove the comparison testing surface from the studio** *(user correction)*
  - [x] The Compare tab was a framework-*testing* harness, not a studio feature. Removed the nav item and view from `index.html`, all compare state/functions/listeners from `app.js`, and `comparisonCases()`/`compare()` plus the `/api/cases` and `/api/compare` routes from `server.mjs`. Kept `/api/runs` so previously recorded results stay readable.
  - [x] Removed the politically charged bias-test content (firearms, abortion, and economic/political argument prompts) that came with that harness: dropped cases `drift_010`, `subject_anti_gun_001`, `subject_abortion_001` from four JSONL datasets, corrected the expected-subjects set in `validate_pack.py`, stripped and renumbered the matching sections/rows in the three test logs, and fixed every count reference in the surrounding docs. A repo-wide re-grep returns zero matches.
  - [x] Testing lives in its own project from now on, as the user asked — not as a built-in studio tab.
- [x] **7b. Make the public AI providers actually connectable** *(user's stated top priority)*
  - [x] **Root cause of "none are functional":** a key could only come from an environment variable, and there was no way to check a key short of running a whole improvement cycle. So every provider showed up in the UI but nothing could reach one.
  - [x] Added a per-project key store in `selfimprove.mjs`: `setProviderKey`/`clearProviderKey`/`resolveKey`, writing `<project>/.ghost/providers.json` with owner-only permissions. `.ghost/` is already gitignored, so keys can never be committed, and the server never sends a stored key back to the browser — only `configured` and a human-readable `source`.
  - [x] Precedence is explicit argument → environment variable → saved key, so an existing env-var setup keeps working unchanged.
  - [x] Added `testProvider()`: a minimal "reply with exactly OK" round-trip that verifies a key in about a second, and surfaces the provider's own rejection instead of silently reporting success.
  - [x] Added **OpenRouter** as a sixth provider. It is the fastest route to "as many AI working as possible" — a single key reaches GPT, Grok, DeepSeek and Llama, because every provider is driven through the same OpenAI-compatible `/chat/completions` shape.
  - [x] New API routes: `PUT`/`DELETE /api/self-improve/key` and `POST /api/self-improve/test`.
  - [x] New "Connect a public AI" panel in the Self-improve view: a key field with Save key / Test connection / Remove key, plus a per-provider status list with connection dots and a "Get a key ↗" link to each provider's key page.
  - [x] Tests added (42/42 total): saved keys configure a provider, environment variables outrank saved keys, stored keys never appear in the provider listing, a successful connection test, and a rejected key surfacing the provider's error.
  - [x] Live smoke test on a running server: provider listing, 409 with an actionable message for an unconfigured provider, key save/remove round-trip, no key leakage to the client, and `git check-ignore` confirming `.ghost/providers.json` is ignored.
  - [x] Connection status is tracked in `docs/AI_PROVIDERS.md` — update it as each provider is verified with a real key.
  - **Remaining:** no provider has been exercised against a real endpoint yet; that needs one real API key. Combining several providers' context into one cycle, and Janitor AI, are still to come.
- [x] **7c. Polish the self-update cycle** *(user: "we have to polish that process")*
  - [x] **The AI was working blind.** A cycle sent only a list of file *paths* — never any file contents — so the model could only guess and rewrite whole files from scratch. Added `gatherContext()`, which ranks files by overlap with the focus task, then sends their real contents inside a byte budget (default 60 KB, 12 files) so the prompt cannot grow unbounded. The system prompt now tells the model it is looking at real current content and must return complete files.
  - [x] **An already-red repository was blamed on the AI.** The cycle now runs the test suite *before* proposing anything. If the repo is already failing it stops with a clear message and does not spend an API call, instead of reporting "the AI broke the tests".
  - [x] **A single failed attempt was thrown away silently.** The cycle now feeds the actual test failure output back to the provider for one repair attempt (`repairAttempts`, default 1), resetting the worktree in between so a failed attempt cannot contaminate the retry. A cycle that fails, then fixes itself, now commits.
  - [x] **Nothing was reviewable.** The report now records the committed `diff`, the files read for context, the number of attempts, and whether the baseline was green. The Self-improve history shows a collapsible "Review the change" diff for every cycle.
  - [x] **The AI could disable its own safety rails.** Added `PROTECTED_PATHS`/`isProtectedPath`: a proposal touching `.git/`, `.ghost/`, `.github/workflows/` or `node_modules/` is rejected. This also stops the key store from ever being read into a prompt or rewritten.
  - [x] New git helpers: `resetWorktree()` (clean slate between attempts) and `stageIntentToAdd()` (so newly added files actually appear in the recorded diff instead of producing an empty one).
  - [x] Tests: the old "tests fail" test was conflating an already-red repo with an AI-broken change; split into a baseline-guard test and a genuine broken-proposal test, plus new tests for the repair-then-commit path (asserting the repair prompt really carries the failure output), protected-path rejection, and context gathering (focus ranking, budget enforcement, and never leaking `.ghost/` secrets).
  - **Result:** Full suite — 46/46 passed. Live end-to-end run confirmed: baseline green → AI sees real source → first attempt breaks tests → repair attempt sees the failure → tests pass → committed and pushed to the isolated `ghost/self-update` branch, with an 8-line diff recorded in history.
- [x] **7d. Algorithm pockets — a separate long-term recall level** *(user: "client nodes that are basically compression and decompression pockets themselves", "algorithm pockets")*
  - [x] **The gap this closes.** `memory.mjs` re-reads the *current* conversation every turn and selects from it. That can only recall what is already in the transcript in front of it, so a decision made in another conversation was simply unreachable, and the cost of recall grew with the transcript.
  - [x] Added `studio/archive.mjs` as its own integration level. The dependency runs one way — `archive → memory` — and `memory.mjs` is behaviourally untouched. If long-term recall is unavailable, every function degrades to "no recall" and the turn still works.
  - [x] **A pocket** is a self-contained span of a conversation carrying three things: a *digest* (the statements that settle something — what search matches and what is normally read), a *body* (the full span, packed), and *the name of the algorithm that packed it*.
  - [x] **Why the algorithm lives inside the pocket.** Each pocket is packed by whichever codec is genuinely smallest for that span — `raw`, `gzip`, or `brotli` — so a one-line pocket does not pay gzip framing while a long one still gets real compression. Unpacking dispatches on the stored name, so pockets written today stay readable when new codecs are added, and a pocket packed by an unknown codec falls back to its digest instead of corrupting a prompt.
  - [x] **The prompt stays small as the archive grows.** Searching reads digests only; nothing is decompressed to find a match. `renderRecall` then unpacks only the strongest matches, within a token budget, and leaves the rest compressed. Context cost is bounded by the budget, not by the size of the archive.
  - [x] Storage is SQLite with an FTS5 index — built into Node 24, so Ghost stays dependency-free. Queries are rebuilt from the same stemmed terms `memory.mjs` uses, so a paraphrase ("db") reaches the wording actually used, and FTS5 operators in user text cannot throw or inject.
  - [x] **Fixed a real bug found by the suite:** holding the archive file open for the life of the server locked the project folder, so Windows refused to delete or move a project Ghost had indexed (the API test failed with `EPERM`). The archive is now opened per operation and closed again — recall is an indexed lookup costing milliseconds. A test now asserts the project folder can always be removed.
  - [x] Wired into the chat turn additively: recall is prepended to the system block before packing, and the finished exchange is indexed afterwards. Both are wrapped so a recall failure can never cost the user a turn. New routes: `GET /api/recall` (stats, search, and single-pocket expansion) and `DELETE /api/recall`.
  - [x] The Memory view now shows a "From earlier conversations" group listing the pockets that were recalled for the last answer.
  - **Result:** Full suite — **61/61 passed** (15 new archive tests), including cross-conversation recall, selective unpacking under budget, codec round-trips, unknown-codec fallback, hostile queries, a corrupted database file, and the project-folder lock regression.
- [ ] **8. Add assisted coding and testing**
- [ ] **9. Strengthen framework comparisons**
- [ ] **10. Package Ghost as a desktop application**

## Validation signature

| Date | Area | Result | Evidence |
|---|---|---|---|
| 2026-09-15 | Roadmap correction | Recorded | No improvement is marked complete; all ten remain pending |
| 2026-09-15 | Step 1 contract checks | Passed | `node --test studio/tests/*.test.mjs` — 8/8 passed |
| 2026-09-15 | Step 1 live Qwen3 check | Complete | `validate-local-model.mjs --check-cancellation` — answer, streaming, and cancellation confirmed |
| 2026-09-15 | Step 1 restart check | Complete | Ollama engine process killed and restarted via `Start-Ghost.ps1`; revalidated successfully |
| 2026-09-15 | Step 2 profile benchmark | Complete | `validate-local-model.mjs --profiles=eco,balanced,deep --runs=3` — see `docs/PERFORMANCE.md` |
| 2026-09-15 | Step 2 hardware tuning | Complete | Confirmed `num_ctx` (not `num_batch`) governs GPU layer offload; existing profile defaults validated as appropriate |
| 2026-09-15 | Step 3 unit tests | Passed | `node --test studio/tests/projects.test.mjs` — 4/4 passed |
| 2026-09-15 | Step 3 full suite | Passed | `node --test studio/tests/*.test.mjs` — 12/12 passed (no regressions after server.mjs refactor) |
| 2026-09-15 | Step 3 manual verification | Complete | Live server: opened a second project, confirmed session/file isolation, switched back, confirmed restoration |
| 2026-09-15 | Step 4 recall tests | Passed | `node --test studio/tests/*.test.mjs` — 15/15 passed (paraphrase recall, supersession, source references) |
| 2026-09-15 | Step 5 adaptive context tests | Passed | `node --test studio/tests/*.test.mjs` — 18/18 passed (adaptive profile escalation + end-to-end `/api/chat` with `profile:'auto'`) |
| 2026-09-15 | Step 6 editor upgrade tests | Passed | `node --test studio/tests/*.test.mjs` — 28/28 passed (diff/highlight unit tests, `searchProject` unit test, end-to-end `/api/search`) |
| 2026-09-15 | Step 6 manual verification | Complete | Live server: `/diff.js` and `/highlight.js` served correctly; `/api/search?root=workspace&q=Ghost` returned the expected match |
| 2026-09-15 | Step 7 git.mjs tests | Passed | `node --test studio/tests/git.test.mjs` — 4/4 passed |
| 2026-09-15 | Step 7 selfimprove.mjs tests | Passed | `node --test studio/tests/selfimprove.test.mjs` — 7/7 passed (fake-provider fixture + temp git repo/remote) |
| 2026-09-15 | Step 7 full suite | Passed | `node --test studio/tests/*.test.mjs` — 39/39 passed (no regressions) |
| 2026-09-15 | Step 7 manual verification | Complete | Live server against a temp git project: git status/diff/log/commit/push routes verified; `.gitignore` auto-added for `.ghost/`; self-improve run validation (bad provider → 400, unconfigured provider → recorded error) and history persistence verified |
| 2026-09-15 | Step 7a compare removal | Complete | Compare tab/routes removed; bias-test content purged (repo-wide re-grep returns zero matches); `node --test studio/tests/*.test.mjs` — 39/39 passed |
| 2026-09-15 | Step 7b provider key store tests | Passed | `node --test studio/tests/*.test.mjs` — 42/42 passed (key round-trip, env-var precedence, no key leakage, connection test success and rejection) |
| 2026-09-15 | Step 7b provider live smoke test | Complete | Live server on port 4519: provider listing, 409 with actionable message when unconfigured, key save/remove round-trip, no key leaked to client, `git check-ignore` confirms `.ghost/providers.json` ignored |
| 2026-09-15 | Step 7c self-update cycle hardening | Passed | `node --test studio/tests/*.test.mjs` — 46/46 passed (baseline guard, broken-proposal discard, repair-then-commit, protected paths, context gathering) |
| 2026-09-15 | Step 7c cycle live verification | Complete | End-to-end run on a throwaway repo + bare remote: baseline green, AI received real file contents, first attempt failed, repair prompt carried the failure output, tests passed, committed and pushed to `ghost/self-update`, diff recorded in history |

Update this file whenever a roadmap item is attempted, completed, or blocked.
| 2026-09-15 | Step 7d algorithm pockets | Passed | `node --test studio/tests/*.test.mjs` � 61/61 passed (15 new archive tests) |
| 2026-09-15 | Step 7d project-lock regression | Fixed | Per-operation open/close; API test project-switch `EPERM` resolved and covered by a dedicated test |
| 2026-09-15 | Step 7d live cross-conversation recall | Passed | Running server: a decision made in one conversation reached the model in a second, unrelated conversation; `/api/recall` search, expansion, and per-conversation forget verified � 62/62 |
| 2026-09-15 | Step 7e browser relay | Passed | `node --test studio/tests/relay.test.mjs` - 18/18; FILES: scoping bug found and fixed (a rewrite could otherwise have edited its own test) |
| 2026-09-15 | Memory: shared dictionary | Passed | MCCP-style trained dictionary in `archive.mjs`; brotli+dictionary probed by round-trip at load, deflate fallback; 411/480 pockets repacked, 3.89x -> 4.12x |
| 2026-09-15 | Memory: RAM chip | Passed | `node --test studio/tests/ram.test.mjs` - 16/16; tiered resident/digest/packed chip with addresses, faults, and eviction |
| 2026-09-15 | Memory: thrash fix | Fixed | Chip capacity was smaller than one pocket, so hits were impossible by construction; profiles raised to 900/2200/4800 and lines paged in this turn are pinned. Hit rate on topic 0/5/21% -> 64/60/75% |
| 2026-09-15 | Memory: depths of recall | Passed | `node --test studio/tests/recall.test.mjs` - 12/12; five-layer ladder (reflex, status, chip, archive, links) that stops climbing once satisfied |
| 2026-09-15 | Memory: two bugs caught by tests | Fixed | Standing rules were given triggers from their own text, so they only fired when the question already repeated them; link rarity ceiling scaled with archive size and excluded the cluster terms on a small archive |
| 2026-09-15 | Full suite | Passed | `node --test studio/tests/*.test.mjs` - 109/109 passed |
| 2026-09-16 | Memory: layers wired into the app | Passed | Chat path now calls `recallLayered` instead of flat recall; addresses the model asked for last turn are honoured on the next one. Five `/api/layers*` routes added |
| 2026-09-16 | Memory: link graph refresh | Fixed | `buildLinks` only ever ran on a manual trigger, so the map went stale; it now rebuilds every 10 turns and recall degrades to its other four layers in between |
| 2026-09-16 | Memory: layer API tests | Passed | `node --test studio/tests/layers.test.mjs` - 3/3 against a live server; proves an unconditional rule reaches the prompt on a question that shares no words with it |
| 2026-09-16 | Memory: two wiring bugs caught by the new tests | Fixed | `memoryState` never reported the ladder, so the UI could not show quiet layers; `/api/layers/learn` returned the whole `buildLinks` object where the caller expected a count |
| 2026-09-16 | Memory view UI | Passed | Depth bar shows which layer carried the turn and which were skipped; standing rules can be added, removed, and learned; recalled pockets now show their address |
| 2026-09-16 | Full suite | Passed | `node --test studio/tests/*.test.mjs` - 112/112 passed |
| 2026-09-16 | Relay view UI | Passed | The browser relay had six server routes and zero frontend references, so it was unreachable from the app; a four-step Relay view now drives start, copy brief, paste plan, and run, with steps locked until the previous one is satisfied |
| 2026-09-16 | Relay: segment progress streams | Passed | `/api/relay/implement` NDJSON is consumed line by line so the segment list fills in as the local model works; a run takes minutes and silence was indistinguishable from a hang |
| 2026-09-16 | Relay: FILES scope ignored | Fixed | `scopeFiles` filtered the already-ranked six-file shortlist, so a file the plan named but relevance never reached was dropped and the relay fell back to editing every other file; a plan saying `FILES: studio/public/app.js` queued the test suite instead. Named files are now resolved against the whole repo before ranking truncates it |
| 2026-09-16 | Relay: reported scope was stale | Fixed | `relayState.files` always returned the brief's candidate list, so the view showed a scope that did not match the segments actually queued |
| 2026-09-16 | Relay: live API check | Passed | Against a running server: assets serve, eight chats listed, short guidance rejected 400, a real plan scoped to one file into 20 segments, apply with nothing rewritten refused 409, clear returns to closed |
| 2026-09-16 | Full suite | Passed | `node --test studio/tests/*.test.mjs` - 114/114 passed |
| 2026-09-16 | Memory: chip size never followed the profile | Fixed | The chat path read `session.chipProfile`, which nothing ever set, so every turn silently used the medium chip; chip size now maps from the context profile (eco/balanced/deep to small/medium/large) and on `auto` uses the previous turn's resolved profile, since recall runs before packing |
| 2026-09-16 | Full suite | Passed | `node --test studio/tests/*.test.mjs` - 115/115 passed |
| 2026-09-16 | Desktop icon opened nothing | Fixed | The launcher ended with `Start-Process '<url>' -WindowStyle Hidden`; a URL goes through ShellExecute, which passes the style to the browser it launches, so the browser started with its window hidden. Ghost was running and healthy the whole time and the screen stayed empty |
| 2026-09-16 | Launcher: node discovery | Fixed | The only fallback path was a sandbox-specific one; a shortcut does not always inherit a terminal's PATH, so the usual install locations are now checked before declaring Node missing |
| 2026-09-16 | Launcher: unreadable failures | Fixed | Startup failures printed a PowerShell stack trace and told the person to go read a log file; a trap now prints the reason plainly, and a server that will not start has the tail of its own stderr shown inline |
| 2026-09-16 | Launcher: cold start | Passed | With port 4317 free, the launcher exits 0 with 'Ghost is ready', the server survives it, and the app serves the Relay view; the missing-Node path exits 1 with a plain, actionable message |
