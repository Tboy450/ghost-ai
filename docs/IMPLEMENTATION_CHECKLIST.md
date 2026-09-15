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
- [ ] **3. Add project management**
- [ ] **4. Improve memory recall**
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

Update this file whenever a roadmap item is attempted, completed, or blocked.
