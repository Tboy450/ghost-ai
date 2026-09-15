# Ghost improvement roadmap

## Correction to the progress report — 2026-09-15

The repository check found no new Copilot changes: GitHub contained only the original application commit, `b32a41cac86210996efcd380cc64f771a0252d58`, on `main`, with no pull requests or additional branches. The local checkout matched that commit and had no uncommitted changes. Existing Copilot conversation logs belong to earlier framework research; they do not demonstrate completion of this roadmap.

Treat all ten steps below as pending until implementation and verification evidence is available. This document and the accompanying Copilot instructions update the development process; they do not complete any application improvements.

Already implemented in the original application: streaming chat, saved conversations, an editor with backups, bounded context selection, pinned memory, and comparison preparation/storage. The final live check of the replacement Qwen3 4B Instruct model remains pending.

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
| 1 | Finish real-model validation | Qwen3 4B Instruct answers a known prompt, streams, cancels, and answers again after a Ghost/engine restart. Record the actual model and runtime versions. | Pending |
| 2 | Measure and tune performance | Record repeatable response latency, generation speed, RAM/VRAM use, and context-size results on this machine. Choose defaults from measured results and retain a low-memory option. | Pending |
| 3 | Add project management | Open and switch project folders; scope files, conversations, and memories to the selected project. Verify persistence and project boundaries. | Pending |
| 4 | Improve memory recall | Retrieve paraphrased requirements with source references and handle newer instructions superseding older ones. Test old requirements, unrelated memories, contradictions, and project boundaries. | Pending |
| 5 | Make context management adaptive | Select, compact, and reload relevant information within measured resource budgets while preserving the current request and full stored history. Measure recall quality and planning overhead. | Pending |
| 6 | Upgrade the editor | Add syntax highlighting, tabs, project search, and edit previews. Verify unsaved changes, save conflicts, backups, and multi-file navigation. | Pending |
| 7 | Add Git integration | Show changes and support checkpoints, commits, pushes, and restoration. Verify the intended branch and files, push results, and protection of unrelated edits. | Pending |
| 8 | Add assisted coding and testing | Propose coordinated edits across files and run selected project checks with visible commands, results, cancellation, and a reviewable diff. Exercise success and failure cases. | Pending |
| 9 | Strengthen framework comparisons | Run real baseline/framework trials using matched questions and recorded configurations. Compare correctness, recall, latency, and resource use; distinguish human review from heuristic scores. | Pending |
| 10 | Package Ghost as a desktop application | Provide installation, startup diagnostics, model setup, and updates. Verify a fresh installation and restart, and preserve user data during updates. | Pending |

## Handoff instruction for Copilot

Start by verifying the repository state. The last inspection found only the original Ghost application commit; earlier Copilot research logs are not evidence that these improvements are complete. Work through the pending steps above in order. After each step, run the relevant checks, update the evidence, commit, push, verify the remote SHA, and report the GitHub link and local path before moving to the next step. If a step is already implemented, verify its code and results and update its status instead of duplicating it. Do not claim completion based only on a plan, a PR description, or a local edit.
