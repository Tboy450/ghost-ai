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
- [ ] **5. Make context management adaptive**
- [ ] **6. Upgrade the editor**
- [ ] **7. Add Git integration**
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

Update this file whenever a roadmap item is attempted, completed, or blocked.
