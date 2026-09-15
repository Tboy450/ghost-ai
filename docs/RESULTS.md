# Ghost validation results

## Passed

- Six Node tests: API chat streaming and persistence, paired comparison storage, request-origin protection, file boundaries, exact backups, stale-save rejection, context budgeting, old-requirement recall, deduplication, and bounded file excerpts.
- Two Python comparison-preparation tests: matching questions, isolated framework treatment, round-trip output, and overwrite prevention.
- Framework aggregate checks, script regression tests, and pack validation.
- Eight previously recorded framework responses scored 18/18 on the existing heuristic. This measures format and keyword coverage, not verified truth or neutrality.
- Recovered local archive: 1,902 files matched the downloaded ZIP before editing.
- Browser inspection: Ghost layout, source explorer, local model detection, chat streaming, and cancellation were exercised.

## Context benchmark

A synthetic 402-message conversation was reduced from an estimated 222,461 tokens to 4,098 active input tokens. Planning took 17.93 ms in this run and recovered an early SQLite/UTC requirement. The full transcript was retained. See `context-benchmark.json`.

This is a lexical retrieval and performance check, not evidence of universal recall or improved model accuracy.

## Local model status

Official Ollama v0.34.0 and Qwen3 4B Instruct were downloaded locally. A live test of the earlier Qwen3 4B thinking variant produced excessive reasoning text, so the default was changed to the instruction variant. The replacement model still needs its final end-to-end response check. The application tests use an explicitly labeled mock model endpoint.

## Remaining limits

- No claim that the recovered Claude Code CLI builds or runs; Ghost's distributable runtime is independent.
- No live paired-model result has been certified as a reasoning improvement.
- Context counts are estimates; lexical retrieval can miss paraphrases. Pin important requirements.
- Chat suggests edits for the editor and does not execute terminal commands.
