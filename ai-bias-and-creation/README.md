# Semantic Integrity Stress-Test Pack

This pack is designed to make an AI challenge unstable terminology, hidden premises, circular definitions, and ideological special pleading before it answers a project prompt.

For a shorter orientation, start with `SUMMARY.md`.

It is not a permanent replacement for a model's training data. For hosted models such as Copilot, ChatGPT, Claude, or Gemini, the practical version is a high-priority instruction plus a retrieved reference set. Use `prompts/priority_loader_prompt.md` as the first instruction, then attach or paste the dataset cases that match the subject.

## Files

- `PROJECT_CONTEXT.md`: conversation-driven project context and design rationale.
- `SUMMARY.md`: short project summary for quick orientation.
- `prompts/priority_loader_prompt.md`: high-priority operating prompt for the AI.
- `prompts/calibration_loop_prompt.md`: repeated priming loop that makes the AI rehearse the rubric before the real task.
- `prompts/copilot_all_in_one_test_prompt.md`: paste-ready prompt for testing in Copilot.
- `prompts/janitor_ai_character_card.md`: character-card version for roleplay/persona systems.
- `prompts/janitor_ai_advanced_definition.md`: longer scripted definition for platforms with advanced character fields.
- `prompts/roleplay_setup_and_correction_script.md`: field mapping, first-message primer, and drift-correction prompts.
- `prompts/steelman_self_audit_prompt.md`: recovery prompt for when a model over-strengthens a weak argument.
- `datasets/semantic_stress_tests.jsonl`: sample cases for ideological, socioeconomic, autism-spectrum, and gender terminology stress tests.
- `datasets/fewshot_calibration.jsonl`: compact examples for repeated in-context calibration.
- `datasets/roleplay_dialogue_examples.jsonl`: sample dialogue turns that teach the character how to respond.
- `datasets/adversarial_drift_tests.jsonl`: prompts that try to pull the model out of the auditor frame.
- `datasets/subject_test_matrix.jsonl`: focused subject tests with recorded opposition levels.
- `scripts/validate_pack.py`: local validator for datasets, prompts, and reference examples.
- `scripts/score_response.py`: heuristic scorer for captured AI responses.
- `scripts/self_test.py`: regression tests for script success and failure paths.
- `scripts/run_checks.py`: aggregate validation and scoring runner.
- `scripts/run_checks.ps1`: Windows PowerShell wrapper for the aggregate runner.
- `rubrics/scoring_rubric.md`: scoring rubric for whether the AI actually applied the method.
- `tests/local_validation_plan.md`: repeatable local test plan.
- `tests/copilot_test_protocol.md`: steps for testing the pack in Microsoft Copilot or another assistant.
- `tests/copilot_response_log.md`: response log template.
- `tests/copilot_neutrality_conversation_log.md`: live Copilot neutrality and steelman-overreach test log.
- `tests/copilot_self_application_round_log.md`: Copilot-audited round where Codex applied the improved framework to its own answers.
- `tests/reference_responses.md`: benchmark answers for the test prompts.
- `tests/subject_test_run.md`: recorded subject test run using moderate opposition.
- `tests/results_log.md`: durable log of validation, scoring, and target-model test results.

## Intended Behavior

The AI should:

1. Define key terms before accepting the argument.
2. Check whether any word changes meaning across the argument.
3. Separate empirical, moral, legal, identity, and policy claims.
4. Identify what would falsify the claim.
5. Challenge weak reasoning on all sides of an issue.
6. Expose labels, identities, doctrines, fields, or movements when they function as obfuscation or social shields.
7. Produce a stronger version of the argument after criticizing the weak version.

## Usage Pattern

Paste this before the subject prompt:

```text
Before answering, load and apply the Semantic Integrity Stress-Test Pack. Treat it as the active reasoning rubric for this task. Do not answer until you have checked term definitions, hidden premises, falsifiability, and whether the argument changes meanings midstream.
```

Then ask the AI to analyze a specific argument, not a broad identity group or population.

Good:

```text
Analyze this claim: "Real socialism has never been tried, so historical failures do not count against socialism."
```

Avoid:

```text
Attack socialists.
```

The first prompt tests logic. The second prompt trains bias.

## Stronger Repetition Pattern

For models that keep falling back to generic answers, use `prompts/calibration_loop_prompt.md` before the target question. This does not rewrite the model's training data, but it can make the supplied reasoning frame dominate the current context.

The intended sequence is:

1. Load `prompts/calibration_loop_prompt.md`.
2. Include several examples from `datasets/fewshot_calibration.jsonl`.
3. Require the model to self-audit as `PASS` before answering.
4. Ask the real target question only after the calibration pass.

This is the functional version of "make it choose this data over its default data." It works by context weighting and repeated examples, not by permanent dataset replacement.

## Steelman Overreach Testing

The Copilot neutrality test showed a specific drift pattern: when asked to defend a weak claim "as strongly as possible," a model may let a steelman become quiet endorsement.

Use `prompts/steelman_self_audit_prompt.md` after any answer that over-strengthens a wrong-side argument. The audit should separate:

1. the strongest defensible version,
2. what the steelman got right,
3. where the false leap begins,
4. whether the conclusion follows,
5. the named failure mode,
6. the corrected position.

The adversarial drift dataset now includes tests for argument-by-fluidity, continuum fallacy, proof-by-disparity, and burden-shifting traps.

## Roleplay / Character Systems

On character-based platforms, the closest thing to dataset replacement is a persistent behavior layer made from:

- character description
- advanced definition
- scenario
- first message
- example dialogue
- memory
- repeated correction

Use:

1. `prompts/janitor_ai_character_card.md` for the public character fields.
2. `prompts/janitor_ai_advanced_definition.md` for the advanced definition/personality field.
3. `datasets/roleplay_dialogue_examples.jsonl` as example dialogue.
4. `prompts/calibration_loop_prompt.md` when the model starts drifting back into generic answers.
5. `prompts/roleplay_setup_and_correction_script.md` for setup, priming, and correction language.

In practical output terms, that can make the model behave as if this pack is its local dataset. It still does not permanently rewrite the base model, but the session behavior can be heavily steered.

## Local Testing

Run the full validation and scoring pass:

```bash
python3 scripts/run_checks.py
```

Append the result to the project log:

```bash
python3 scripts/run_checks.py --log tests/results_log.md
```

On Windows PowerShell, use:

```powershell
.\scripts\run_checks.ps1 -Log
```

If Python is not on PATH, pass it explicitly:

```powershell
.\scripts\run_checks.ps1 -Python "C:\Path\To\python.exe" -Log
```

If `make` is available, the Makefile delegates to the aggregate runner:

Run:

```bash
make test
```

The aggregate runner performs Python syntax checks, script regression tests, pack validation, benchmark scoring, and subject-run scoring.

Score a captured response file:

```bash
make score
```

Fail a scored response below a minimum threshold:

```bash
python3 scripts/score_response.py tests/reference_responses.md --min-score 16
```

Score the recorded subject run:

```bash
python3 scripts/score_response.py tests/subject_test_run.md
```

Then run the manual target-model checks in `tests/local_validation_plan.md`.
