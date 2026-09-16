# Project Summary

## What This Is

This project is a portable AI prompt and evaluation pack called the Semantic Integrity Stress-Test Pack.

Its purpose is to make an AI analyze claims by definitions, evidence, logic, falsifiability, source attribution, and perspective stability before giving an answer.

It is not a normal software app with a UI. It is a structured prompt/program package made of:

- high-priority prompts
- calibration loops
- steelman self-audit prompts
- roleplay/character definitions
- JSONL sample datasets
- adversarial drift tests
- scoring rubrics
- local validation scripts
- recorded benchmark responses

## What Problem It Targets

The pack is designed to catch and dismantle arguments that rely on:

- unstable definitions
- vague or circular terminology
- protected labels
- semantic drift
- motte-and-bailey framing
- unfalsifiable claims
- moral labels used as proof
- academic or social-science terms used as authority instead of evidence
- identity, community, doctrine, safety, harm, or sensitivity language used as a shield
- criticism being reframed as violence, harm, assault, unsafety, or bad faith
- individual-to-group or group-to-individual perspective jumps
- subjective experience being upgraded into objective fact or policy proof
- steelman requests that pull the model into over-endorsing a weak argument
- continuum fallacies, proof-by-disparity moves, and burden-shifting traps

## Required Audit Format

The current output format is:

```text
Central claim:

Source/label attribution:

Obfuscation/label audit:

Free-speech/critique audit:

Individual/group and subjective/objective audit:

Key terms:

Term-stability check:

Hidden premises:

Falsifiability test:

Symmetry check:

Strongest critique:

Strongest repair:

Bottom line:
```

## How To Use It

For a normal AI chat:

1. Paste `prompts/priority_loader_prompt.md`.
2. Paste relevant examples from `datasets/semantic_stress_tests.jsonl`.
3. Ask the model to analyze a specific claim.

For repeated priming:

1. Paste `prompts/calibration_loop_prompt.md`.
2. Use examples from `datasets/fewshot_calibration.jsonl`.
3. Require the model to pass calibration before the real prompt.

For steelman overreach:

1. Ask the model to self-audit with `prompts/steelman_self_audit_prompt.md`.
2. Require it to separate the true premise from the false leap.
3. Require a corrected position after the steelman.

For Janitor AI-style character systems:

1. Use `prompts/janitor_ai_character_card.md`.
2. Use `prompts/janitor_ai_advanced_definition.md`.
3. Add examples from `datasets/roleplay_dialogue_examples.jsonl`.
4. Use `prompts/roleplay_setup_and_correction_script.md` when the model drifts.

## How To Test It

Run the full validation and scoring pass:

```bash
python3 scripts/run_checks.py
```

Append the result to the project log:

```bash
python3 scripts/run_checks.py --log tests/results_log.md
```

On Windows PowerShell:

```powershell
.\scripts\run_checks.ps1 -Log
```

If Python is not on PATH, pass it explicitly:

```powershell
.\scripts\run_checks.ps1 -Python "C:\Path\To\python.exe" -Log
```

If `make` is available, it delegates to the aggregate runner:

```bash
make test
```

The aggregate runner performs Python syntax checks, script regression tests, pack validation, benchmark scoring, and subject-run scoring.

Score the benchmark responses:

```bash
make score
```

Fail a scored response below a minimum threshold:

```bash
python3 scripts/score_response.py tests/reference_responses.md --min-score 16
```

Score the subject test run:

```bash
python3 scripts/score_response.py tests/subject_test_run.md
```

## Main Files

- `README.md`: full project overview and usage notes
- `PROJECT_CONTEXT.md`: conversation-driven design rationale and history
- `SUMMARY.md`: short project summary for quick orientation
- `prompts/priority_loader_prompt.md`: main prompt
- `prompts/calibration_loop_prompt.md`: repeated priming prompt
- `prompts/steelman_self_audit_prompt.md`: recovery prompt for steelman overreach
- `prompts/janitor_ai_character_card.md`: roleplay character card
- `prompts/janitor_ai_advanced_definition.md`: advanced roleplay definition
- `datasets/semantic_stress_tests.jsonl`: main sample dataset
- `datasets/adversarial_drift_tests.jsonl`: prompts designed to break the frame
- `datasets/subject_test_matrix.jsonl`: focused subject tests
- `tests/subject_test_run.md`: recorded test outputs
- `tests/results_log.md`: validation and scoring result log
- `tests/copilot_neutrality_conversation_log.md`: live Copilot neutrality and steelman-overreach test log
- `tests/copilot_self_application_round_log.md`: Copilot-audited self-application round for the improved framework
- `scripts/run_checks.py`: aggregate validation and scoring runner
- `scripts/run_checks.ps1`: Windows PowerShell wrapper
- `scripts/self_test.py`: regression tests for script success and failure paths
- `scripts/validate_pack.py`: structural validator
- `scripts/score_response.py`: heuristic response scorer

## Current Validation Status

At the time this summary was added:

```text
make test: passed
reference responses: 18/18, 18/18, 18/18
subject test run: 18/18 across all 3 subjects
```
