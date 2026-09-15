# Ghost repository instructions

Read `docs/ROADMAP.md` before working on roadmap improvements. It contains the ordered steps, acceptance checks, and correction to the previous progress assumptions.

- Implement the next pending step within the user's requested scope. Do not treat roadmap documentation as completed application work or as an instruction to start every step automatically.
- After each implemented step: run the relevant checks, document actual results, commit the intended files, and push before starting the next step. The user has explicitly requested this publication cadence.
- Verify that the pushed branch's remote SHA matches the local commit. If publication fails, report and resolve the blocker before proceeding. Do not bypass platform approval requirements.
- Report the step, checks/results, commit SHA and GitHub link, branch/PR status, local source path, and remaining limitations. Pushed and merged are separate states; do not merge a PR solely to satisfy the push checkpoint.
- Preserve existing work and the current authorized branch. For a new feature branch, use the `codex/` prefix; retain an existing Copilot/PR branch.
- Keep the exclusions in `.gitignore`. Publish Ghost's original application source and documentation, with runtime data, model weights, private conversations, credentials, and the optional recovered source archive excluded.
- Do not use the built-in imagegen/image_gen service for generation or editing. This is the user's standing preference.
