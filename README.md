# Ghost · Local AI Studio

A local workspace for conversation, code, and structured reasoning. Ghost brings together an editable project explorer, the Semantic Integrity framework, and a context planner built for limited hardware.

## Start Ghost

On this computer, double-click **Start Ghost.cmd**.

Then open **http://127.0.0.1:4317**. The launcher starts the local model engine and application in the background.

### Features

- Saved conversations with streaming local AI responses and cancellation.
- Task sidebar, center chat, and a file editor on the right.
- File attachments and suggested code that can be placed in the editor for review.
- File backups and protection against overwriting a newer version on disk.
- An editable Semantic Integrity reasoning framework with an on/off toggle.
- Eighteen paired comparison cases, with raw answers and model details saved locally.
- Memory profiles, pinned requirements, recalled context, and token-budget reporting.
- An optional local reference archive in the file explorer when present.

## Fresh installation from source

Requirements: Windows, Node.js 24 or newer, PowerShell, and enough free disk space for the local engine and model. The initial download needs internet access. Inference runs locally after setup.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Setup-LocalModel.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Start-Ghost.ps1
```

The default model is Qwen3 4B Instruct. On other systems, run Ollama separately and start `node studio/server.mjs` with `STUDIO_OLLAMA_URL` pointing to a loopback Ollama endpoint. The bundled launcher targets Windows.

## Context management

Ghost keeps the complete transcript on disk, itemizes older user messages, retrieves relevant records, and selects useful file excerpts. It assembles these with recent turns and pinned requirements into a bounded context. Eco, Balanced, and Deep profiles trade memory use for the amount of context available.

The Memory panel shows what was recalled. This is fast extractive retrieval, not a guarantee of perfect memory. Critical facts can be pinned. See [architecture](docs/GHOST_ARCHITECTURE.md) and [test results](docs/RESULTS.md).

## Edit the source

- Main backend: `studio/server.mjs`
- Context planner: `studio/memory.mjs`
- Frontend behavior: `studio/public/app.js`
- Layout and styles: `studio/public/`
- Reasoning framework: `ai-bias-and-creation/prompts/priority_loader_prompt.md`

You can open these files in Ghost's project panel or in your usual editor. Backend edits take effect after restarting the server. Reload the browser after frontend edits.

### Improvement roadmap

Follow the [ordered improvement roadmap](docs/ROADMAP.md), including its correction to the progress report. After each completed implementation step, run the relevant checks, commit, push, verify the remote commit, and report the GitHub link and local source path before starting the next step. [Copilot instructions](.github/copilot-instructions.md) record this workflow for repository work.

## Verification

```powershell
node --test studio/tests/*.test.mjs
node scripts/benchmark_context.mjs
```

Framework checks require Python 3.10 or newer:

```powershell
python ai-bias-and-creation/scripts/run_checks.py
python scripts/test_comparison.py
```

To prepare a new static comparison packet after editing the framework:

```powershell
python scripts/prepare_comparison.py --out comparison/revision-2
```

Ghost's live comparison panel reads the current framework file for each new run. [Comparison guidance](comparison/README.md) explains why keyword scores alone do not establish correctness or neutrality.

## Local data

- `.ghost/`: conversations, memory notes, experiments, editor backups, and personal workspace.
- `.runtime/`: downloaded model engine and weights.
- `dist/Ghost-source.zip`: export of the tracked application source.

The data, runtime downloads, and optional Anthropic source archive are excluded from Git and source exports. The downloaded archive remains in the original local workspace for exploration. Ghost runs independently of that incomplete archive. See [provenance](NOTICE.md).
