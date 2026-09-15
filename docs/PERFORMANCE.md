# Ghost performance baseline and profile tuning

Recorded on a laptop with an NVIDIA GeForce RTX 3050 Laptop GPU (4 GiB VRAM, CUDA 13,
driver 13.0) using Ollama v0.34.0 and `qwen3:4b-instruct`. Reproduce with:

```powershell
node scripts/validate-local-model.mjs --profiles=eco,balanced,deep --runs=3
```

## Warm steady-state results (excludes one-time model-load spike)

| Profile  | Context | Output reserve | GPU layers offloaded (of 37) | Tokens/sec | First-token latency |
|----------|---------|-----------------|-------------------------------|------------|----------------------|
| Eco      | 4,096   | 768             | 30/37                         | ~38–42     | ~50ms                |
| Balanced | 8,192   | 1,400           | 26/37                         | ~31–35     | ~50–150ms            |
| Deep     | 12,288  | 2,000           | 23/37                         | ~25–31     | ~60–330ms            |

The very first request after a model or context-size change pays a one-time reload cost
(observed 5–6 seconds here) while Ollama loads tensors and recomputes GPU layer
placement. This is expected and separate from steady-state throughput above.

## Key finding: GPU layer offload is governed by context size, not batch size

On this 4 GiB card, only 23–30 of the model's 37 layers fit in VRAM at once, and the
number that fit **shrinks as the requested context grows** (a larger `num_ctx` reserves
more VRAM for the KV cache, leaving less room for model layers). Throughput drops
accordingly: Deep is roughly 24–30% slower than Eco on this hardware.

We tested whether reducing `num_batch` (the prompt-processing batch size) could free
enough VRAM to offload more layers. It did not: forcing a fresh model load with
`num_batch=32` vs the default `num_batch=128` produced the same 26/37 layers offloaded
at `num_ctx=8192`. Ollama's layer-placement decision depends on `num_ctx`, not
`num_batch`, so `num_batch` is not a useful lever for this constraint.

## Tuning decision

The existing `PROFILES` in `studio/memory.mjs` (Eco/Balanced/Deep) already encode the
correct trade-off for this hardware class: smaller context reserves more VRAM for model
layers and yields higher throughput, while larger context sacrifices throughput for more
retained conversation and file context. No code change to the profile definitions was
needed as a result of this measurement.

Recommendation for GPUs with roughly 4 GiB VRAM or less: default to **Balanced** (already
Ghost's default) for typical use, and prefer **Eco** when working through many short,
latency-sensitive turns. **Deep** remains appropriate when a task genuinely needs the
extra retained context and the ~25–30% slower generation is acceptable.

## Limits

- Single-machine measurement; token counts are estimates from Ollama's own accounting.
- The reload spike duration depends on disk speed and is not separately isolated here.
- VRAM headroom was observed at ~510 MiB free with the Deep profile loaded and no other
  GPU load; a heavier concurrent workload could reduce headroom further.
