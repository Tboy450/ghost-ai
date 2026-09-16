# Public AI provider connection status

Running notes on which public AI providers Ghost can actually reach. Update the
table after each `Test connection` attempt in the studio's **Self-improve** view.

Status meanings:

- **Verified** — a real `Test connection` call returned a reply from the provider.
- **Ready** — code path proven against a local fixture; needs a real API key to verify.
- **Blocked** — tried with a key and it failed; see notes.

| Provider | Studio id | Env var | Default model | Status | Verified on | Notes |
|---|---|---|---|---|---|---|
| OpenRouter (many models, one key) | `openrouter` | `GHOST_OPENROUTER_API_KEY` | `deepseek/deepseek-chat` | Ready | — | Recommended first: one key reaches GPT, Grok, DeepSeek and Llama. |
| GitHub Models (Copilot) | `copilot` | `GHOST_GITHUB_TOKEN` | `openai/gpt-4o-mini` | Ready | — | Uses a GitHub token, so no new account or card is needed. |
| DeepSeek | `deepseek` | `GHOST_DEEPSEEK_API_KEY` | `deepseek-chat` | Ready | — | Cheapest direct option. |
| OpenAI (GPT) | `openai` | `GHOST_OPENAI_API_KEY` | `gpt-4o-mini` | Ready | — | Requires billing enabled on the account. |
| xAI (Grok) | `grok` | `GHOST_XAI_API_KEY` | `grok-2-latest` | Ready | — | Requires an xAI console key. |
| Meta (Llama, via Together) | `meta` | `GHOST_TOGETHER_API_KEY` | `meta-llama/Llama-3.3-70B-Instruct-Turbo` | Ready | — | Meta publishes no first-party key API; Together hosts the Llama models. |
| Janitor AI | — | — | — | Not added | — | Deferred. No documented OpenAI-compatible public API found yet. |

## How a key is supplied

Two options, in priority order:

1. **Environment variable** — set the provider's env var before launching Ghost. Always wins.
2. **Saved in the project** — paste the key into the Self-improve view and press
   **Save key**. It is written to `<project>/.ghost/providers.json` with owner-only
   permissions. That folder is gitignored, so keys are never committed, and the
   server never sends a stored key back to the browser.

## Verification evidence

- `studio/tests/selfimprove.test.mjs` covers: saved keys configure a provider,
  environment variables outrank saved keys, stored keys never appear in the
  provider listing, a successful `Test connection`, and a rejected key surfacing
  the provider's error rather than reporting success.
- Live smoke test against a running server confirmed the provider list, the 409
  for an unconfigured provider, the key save/remove round-trip, no key leakage to
  the client, and that `.ghost/providers.json` is gitignored.
