# Ghost implementation checklist

This checklist tracks the recommended implementation order. Each completed item should
include a concrete validation command or recorded result before it is marked complete.

## Roadmap

All ten improvements are pending. Work is only marked complete after its relevant
checks pass, progress notes are updated, the changes are committed and pushed, and
the remote commit is verified.

- [ ] **1. Validate the local model**
- [ ] **2. Measure and tune performance**
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
| 2026-09-15 | Step 1 live Qwen3 check | Blocked | Ollama was unavailable at `127.0.0.1:11435`; restart validation remains pending |

Update this file whenever a roadmap item is attempted, completed, or blocked.
