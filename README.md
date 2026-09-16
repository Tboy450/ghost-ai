# Ghost · Local AI Studio

A local workspace for conversation, code, and structured reasoning. Ghost brings together an editable project explorer, the Semantic Integrity framework, and a context planner built for limited hardware.

## Start Ghost

On this computer, double-click **Start Ghost.cmd**.

Then open **http://127.0.0.1:4317**. The launcher starts the local model engine and application in the background.

To add a **Ghost** desktop shortcut with the Ghost icon, run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Install-DesktopShortcut.ps1
```

The shortcut starts the same launcher from this project folder. Run the installer again after moving the project, removing or renaming an older Ghost shortcut if it points to the previous location.

### Features

- Saved conversations with streaming local AI responses and cancellation.
- Task sidebar, center chat, and a file editor on the right.
- File attachments and suggested code that can be placed in the editor for review.
- File backups and protection against overwriting a newer version on disk.
- An editable Semantic Integrity reasoning framework with an on/off toggle.
- Eighteen paired comparison cases, with raw answers and model details saved locally.
- Memory profiles, pinned requirements, recalled context, and token-budget reporting.
- An optional local reference archive in the file explorer when present.
- In-app Git integration: review changes, commit, and push a project's own repository.
- Optional AI-assisted self-improvement: consult a public AI provider to propose, test, and (only on green tests) commit/push a codebase change to an isolated branch.

## Fresh installation from source

Requirements: Windows, Node.js 24 or newer, PowerShell, and enough free disk space for the local engine and model. The initial download needs internet access. Inference runs locally after setup.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Setup-LocalModel.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Start-Ghost.ps1
```

The default model is Qwen3 4B Instruct. On other systems, run Ollama separately and start `node studio/server.mjs` with `STUDIO_OLLAMA_URL` pointing to a loopback Ollama endpoint. The bundled launcher targets Windows.

## Context management

Ghost keeps the complete transcript on disk, itemizes older user messages, retrieves relevant records, and selects useful file excerpts. It assembles these with recent turns and pinned requirements into a bounded context. Eco, Balanced, and Deep profiles trade memory use for the amount of context available.

Recall matches by stemmed keywords plus a small synonym table (for example "db" recalls "database", "due" recalls "deadline"), not just exact word overlap. Each recalled record keeps a source reference — its originating turn and, when available, its original timestamp — shown in the Memory panel and in the packed prompt. When a later instruction clearly restates the same topic as an earlier one (for example switching a stated requirement to something else), the newer instruction supersedes the stale one so recall doesn't resurface outdated requirements.

By default the memory profile is **Auto**: Ghost tries Eco first and only escalates to Balanced or Deep when the current message, its recalled context, or a pinned note genuinely needs the larger window — so most turns stay fast and light, while nothing pinned is silently dropped. A specific profile can still be chosen manually to force it.

The Memory panel shows what was recalled. This is fast extractive retrieval, not a guarantee of perfect memory. Critical facts can be pinned. See [architecture](docs/GHOST_ARCHITECTURE.md) and [test results](docs/RESULTS.md).

### Depths of recall

Recall is not one lookup. It is a ladder of five layers, cheapest first, borrowed from how a
MUD client actually handles a session — triggers fire instantly, structured state rides
out-of-band, scrollback holds recent text, logs hold everything, and a derived map is
navigated rather than searched.

| Depth | Layer | What it holds | Cost |
|---|---|---|---|
| 0 | Reflex | Standing rules that must never be forgotten | No I/O |
| 1 | Status | Structured current state — project, focus, task | One small file |
| 2 | Chip | Resident spans and addressable digests, kept between turns | Memory-resident |
| 3 | Archive | Keyword search across every pocket ever written | One query + unpack |
| 4 | Links | Associative map: what else mattered whenever this came up | One graph query |

Ghost stops climbing the moment it has enough, so an ordinary follow-up question never opens
the archive at all. Depth 4 exists for the opposite case: a genuinely new topic shares no
keywords with anything on file, which no cache can help with, but it is rarely unrelated to
the decisions already made — and the map can reach those when the words cannot.

A rule added without a trigger is unconditional and always present. Rules added with a
trigger stay silent until their subject comes up.

You can see and steer all of this from the Memory view. A bar shows which depths carried the
last turn and which stayed quiet — a skipped layer is good news, because it means a cheaper
one already had the answer. Standing rules can be added, removed, or learned from what you
have already settled, and each recalled pocket shows its address, so it is visible what the
model is able to ask for by name on a later turn.

The associative map is a whole-graph rebuild, so it refreshes every tenth turn rather than
every turn, or on demand from **Learn rules from history**. In between, recall simply uses
its other four layers.

### Compression, and why it is shared

Spans of conversation are compressed into pockets. Pockets used to be compressed
independently, which caps the ratio at whatever redundancy exists *inside* one span — a flat
3.9× no matter how much history accumulated. MUD clients solved this decades ago with MCCP:
hold one compression stream open for the whole session so its dictionary accumulates, and a
short repetitive line late in the session costs almost nothing.

Pockets cannot hold one stream open — each must be independently openable, in any order,
years later, or random access is lost. So the accumulated dictionary is made explicit:
trained across the corpus, stored once, versioned, and handed to the codec at both pack and
unpack time. A small pocket can then match phrases that only exist in *other* pockets.

Dictionaries are only ever added, never replaced, so pockets written against an older one
stay readable, and repacking is applied only where the result is strictly smaller. A pocket
whose dictionary is missing degrades to its digest rather than returning corrupt text.

Run `node scripts/bench_memory.mjs 200` to measure storage ratio and per-turn context cost on
your own machine.

## Projects

Ghost can hold multiple projects at once. A project is any folder on disk; its conversations,
memory, comparison runs, and file backups live inside that folder's own `.ghost/` directory, so
the whole project stays portable and self-contained. Use the project switcher next to the "AI
lab" breadcrumb at the top of the window to see the active project, switch to another already-open
project, or open a new folder as a project (`＋`). A small registry of known projects (and which
one is active) is kept in Ghost's own config directory.

## Editor

The workspace editor supports several open files at once: each file you open gets its own tab
in the strip above the code area, and switching tabs keeps any unsaved edits in the files you're
not currently looking at. Code is lightly syntax-highlighted (comments, strings, numbers, and
keywords) for JavaScript/TypeScript, Python, JSON, and Markdown. The file panel's search box can
toggle (`☰`) from filename filtering to full-text search across every file in the current project
root. When a chat response's "Use in editor" action would replace the open file's contents, Ghost
shows a line-by-line diff preview first, so you can review exactly what would change before
applying it.

## Git

The **Git** view lets you review, commit, and push changes to your active project without
leaving Ghost: a status list of changed files, a diff viewer, a commit-message box, a Push
button, and commit history. It works on any project folder that is already a git repository
(`git init` it first if it isn't). Ghost automatically keeps its own `.ghost/` data folder out
of your changes by adding it to that project's `.gitignore`.

## Self-improvement

The **Self-improve** view lets Ghost consult a public AI provider — OpenAI (GPT), xAI (Grok),
DeepSeek, Meta (Llama, via Together.ai), or GitHub Models (Copilot) — to propose a change to
Ghost's own codebase toward a focus task you set (with a queue of follow-up tasks), and reports
back after every cycle with what it proposed, whether the tests passed, and whether it was
committed/pushed.

- A provider only activates once you set its API key as an environment variable before starting
  Ghost: `GHOST_OPENAI_API_KEY`, `GHOST_XAI_API_KEY`, `GHOST_DEEPSEEK_API_KEY`,
  `GHOST_TOGETHER_API_KEY` (for Meta/Llama), or `GHOST_GITHUB_TOKEN` (for GitHub Models/Copilot).
  Ghost never stores or invents these keys.
- Every cycle runs in a disposable git worktree on an isolated `ghost/self-update` branch — your
  live working directory and branch are never touched, even mid-cycle.
- A change is only committed if Ghost's full test suite passes inside that isolated worktree; a
  commit is only pushed (to that same isolated branch) after it succeeds. A failing or unsafe
  proposal is discarded and recorded in the cycle's report, nothing is committed.
- Set the focus/queue and pick a provider in the Self-improve view, then "Run one cycle." Review
  the report, and merge the `ghost/self-update` branch yourself once you're happy with it.

## Browser relay — self-improvement without an API key

The **Relay** view does the same job as Self-improve, but the public AI is reached by *you*, in
a browser tab you are already signed into. No API key, no billing, no account wiring.

It is four steps, and each one unlocks only when the previous is satisfied:

1. **Start** — pick a chat (ChatGPT, Grok, DeepSeek, Gemini, Claude, Copilot, Meta, or LMArena)
   and optionally type a focus. Ghost writes a prompt containing the project's file list.
2. **Copy and paste** — copy that prompt, open the chat, and paste it. The prompt deliberately
   asks for a **short plan in plain words, never code**: a browser chat handles a plan where it
   cannot handle a large diff, and its judgement is the thing worth borrowing.
3. **Paste the plan back** — Ghost cuts it into small segments. If the plan begins with a
   `FILES:` line, only those files are in scope, so the public AI cannot quietly aim the run at
   the test suite.
4. **Run and apply** — Ghost's own local model rewrites the code **one bounded segment at a
   time**, because a 4B model asked to rewrite a large module will truncate and invent. Progress
   streams in as each segment finishes.

Every rule here exists to stop a local model from getting *stuck*, which is its real failure
mode rather than slowness: there is a hard per-segment deadline, one attempt and one retry and
never more, and the output is checked for the known stuck shapes (empty, no code block, collapsed
below 40% of the original, ballooned past 3×, one line repeating). A segment that fails any of
these is **skipped and recorded with the reason**, and falls back to its original text so the
file still assembles intact.

Applying uses the same safety path as an API cycle: a disposable worktree, the full test suite,
and a commit only on green. Nothing that came out of a browser or a small local model touches
your real checkout untested.

## Edit the source

- Main backend: `studio/server.mjs`
- Context planner: `studio/memory.mjs`
- Frontend behavior: `studio/public/app.js`
- Layout and styles: `studio/public/`
- Reasoning framework: `ai-bias-and-creation/prompts/priority_loader_prompt.md`
- Implementation progress: `docs/IMPLEMENTATION_CHECKLIST.md`
- Performance baseline and hardware tuning notes: `docs/PERFORMANCE.md`

You can open these files in Ghost's project panel or in your usual editor. Backend edits take effect after restarting the server. Reload the browser after frontend edits.

### Improvement roadmap

Follow the [ordered improvement roadmap](docs/ROADMAP.md), including its correction to the progress report. After each completed implementation step, run the relevant checks, commit, push, verify the remote commit, and report the GitHub link and local source path before starting the next step. [Copilot instructions](.github/copilot-instructions.md) record this workflow for repository work.

## Verification

```powershell
node --test studio/tests/*.test.mjs
node scripts/benchmark_context.mjs
```

Run a live Qwen3 4B Instruct validation after the engine and model are installed. It checks model discovery, non-empty answers, streaming latency, terminal token metrics, and measured generation speed:

```powershell
node scripts/validate-local-model.mjs
node scripts/validate-local-model.mjs --check-cancellation
node scripts/validate-local-model.mjs --runs=3
node scripts/validate-local-model.mjs --profiles=eco,balanced,deep --runs=3
```

The validator requires `qwen3:4b-instruct` by default. Set `GHOST_MODEL` only when
deliberately validating another installed model.

`--runs` repeats the same prompt per selected profile (capped at 20). `--profiles` accepts
any comma-separated combination of `eco`, `balanced`, and `deep`. The report compares
average/minimum/maximum latency and throughput, plus the model's loaded memory residency
when Ollama exposes it through `/api/ps`.

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
