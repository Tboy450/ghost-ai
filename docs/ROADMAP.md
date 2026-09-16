# Ghost improvement roadmap

## Where we are — 2026-09-16

Eight of the ten steps are done and pushed. `main` is at `3e516ef`; the suite is 126/126.

**Next up: step 7, Git integration.** Then step 9 (comparisons) and step 10 (packaging).

The numbering below is the original roadmap's. Git integration sits at 7 and assisted
coding at 8, so the work has run 1–6, then 8, and now returns to 7.

Evidence for every step is in `docs/IMPLEMENTATION_CHECKLIST.md`, one dated row per
item with the actual result. `docs/NEXT_PLAN.md` covers the remaining three steps and
the known gaps in more detail.

### Historical note (superseded)

An inspection on 2026-09-15 found only the original application commit
`b32a41cac86210996efcd380cc64f771a0252d58` on `main`, and this document then instructed
that all ten steps be treated as pending. That is no longer the case — the statuses in
the table below are current and each is backed by a checklist row.

## Required checkpoint between every step

1. **Inspect the current state.** Read this roadmap and check the working tree and remote branch. Preserve unrelated work. Confirm which changes are already implemented before starting the next pending step.
2. **Implement one step.** Keep the change focused and record what changed, relevant checks and their actual results, and remaining limitations. Update `docs/RESULTS.md` when validation findings change.
3. **Verify the step.** Run checks appropriate to the change and the acceptance checks below. A mock-model test does not establish that a real local model works. Do not mark a failed or untested step complete.
4. **Commit and push before starting the next step.** Stage the intended source and documentation files explicitly. Use a descriptive commit message. Push to the current authorized branch; for a new feature branch, use `codex/` followed by a descriptive name. Preserve an existing Copilot or PR branch. If branch protection requires a PR, push the branch and use that PR workflow.
5. **Verify publication.** Compare `git rev-parse HEAD` with `git ls-remote origin refs/heads/<branch>`. They must match. If a push fails or the remote commit cannot be verified, report the failure and resolve it before proceeding to another roadmap step. Never report an unverified push as successful.
6. **Report the checkpoint.** Include the step number, summary, checks/results, full commit SHA and GitHub commit link, branch/PR link if applicable, local source path, and any remaining limitations. Distinguish local work, pushed work, and work merged into `main`; a pushed PR branch is not a merged update.

The user's standing instruction is to push updates between steps. A final push after implementing the whole roadmap does not satisfy that instruction. Follow platform approval requirements if they block publication and explain the blocker.

Keep runtime downloads, model weights, private conversations, credentials, and the optional recovered source archive excluded according to `.gitignore`. Ghost's distributed application remains independent of that archive. When delivering an updated source ZIP, regenerate it from the verified committed source and give its local path.

## Implementation order

| Step | Improvement | Acceptance check before the required commit/push checkpoint | Status |
| --- | --- | --- | --- |
| 1 | Finish real-model validation | Qwen3 4B Instruct answers a known prompt, streams, cancels, and answers again after a Ghost/engine restart. Record the actual model and runtime versions. | **Done** — qwen3:4b-instruct on ollama, live answers, streaming, cancellation and restart all verified |
| 2 | Measure and tune performance | Record repeatable response latency, generation speed, RAM/VRAM use, and context-size results on this machine. Choose defaults from measured results and retain a low-memory option. | **Done** — measured figures in `docs/PERFORMANCE.md`; hardware profiles chosen from them, low-memory option kept |
| 3 | Add project management | Open and switch project folders; scope files, conversations, and memories to the selected project. Verify persistence and project boundaries. | **Done** — `studio/projects.mjs`, per-project `.ghost` data dirs, boundaries covered by tests |
| 4 | Improve memory recall | Retrieve paraphrased requirements with source references and handle newer instructions superseding older ones. Test old requirements, unrelated memories, contradictions, and project boundaries. | **Done** — keyword + meaning retrieval with source references; contradiction and boundary cases tested |
| 5 | Make context management adaptive | Select, compact, and reload relevant information within measured resource budgets while preserving the current request and full stored history. Measure recall quality and planning overhead. | **Done** — automatic compaction with recall measured by `scripts/bench_memory.mjs`; full history preserved |
| 6 | Upgrade the editor | Add syntax highlighting, tabs, project search, and edit previews. Verify unsaved changes, save conflicts, backups, and multi-file navigation. | **Done** — tabs, highlighting, search, diffs and backup restore |
| 7 | Add Git integration | Show changes and support checkpoints, commits, pushes, and restoration. Verify the intended branch and files, push results, and protection of unrelated edits. | **Next** — `studio/git.mjs` already does worktrees, branches, commits, pushes and diffing for self-update. Missing: named checkpoints you can return to, and a readable change review in the UI |
| 8 | Add assisted coding and testing | Propose coordinated edits across files and run selected project checks with visible commands, results, cancellation, and a reviewable diff. Exercise success and failure cases. | **Done** — public-chat relay plus local implementation, guarded by size, alphabet, syntax and full-suite gates; proven end to end on a real model, including a failure case that was correctly refused |
| 9 | Strengthen framework comparisons | Run real baseline/framework trials using matched questions and recorded configurations. Compare correctness, recall, latency, and resource use; distinguish human review from heuristic scores. | **Pending** — comparison UI and storage exist; real scoring behind it does not yet |
| 10 | Package Ghost as a desktop application | Provide installation, startup diagnostics, model setup, and updates. Verify a fresh installation and restart, and preserve user data during updates. | **Pending** — a working desktop launcher exists, but not installation, diagnostics or updates |

## Handoff instruction for Copilot

Start by verifying the repository state against the table above: `main` should be at
`3e516ef` or later with the suite green. Steps 1–6 and 8 are done and each has dated
evidence in `docs/IMPLEMENTATION_CHECKLIST.md`; do not redo them. Pick up at **step 7**,
then 9, then 10, using the task list in `docs/NEXT_PLAN.md`.

After each step, run the relevant checks, add a checklist row with the actual result,
commit, push, verify the remote SHA and report the GitHub link and local path before
moving on. Do not claim completion based only on a plan, a PR description, or a local
edit — and do not treat a green suite as proof on its own. Every real bug in this project
so far passed a green suite and appeared only under live execution.
