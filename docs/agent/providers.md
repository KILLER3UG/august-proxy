# Providers, models and wire formats

## Base URL and wire format

Provider **baseUrl** is used exactly as pasted; August only appends the API
format leaf (`chat/completions` / `v1/messages` / `responses` / `models`). It
never invents `/v1` on the base — Anthropic's format already includes `v1` in
the leaf; OpenAI-compatible hosts include `/v1` in the paste when needed.

**OpenCode Zen** lists all models via `GET …/models`, but each family needs a
different wire path (`/chat/completions`, `/v1/messages`, `/responses`). One
provider-level `apiFormat` cannot serve Claude+GPT+DeepSeek from the same Zen
entry, so model entries may carry their **own** `apiFormat` (set in Model
settings → pencil-edit model → Wire format dropdown; the UI suggests
`v1/messages` for `claude-`-prefixed ids). The override wins over the provider
format and is honored by workbench chat, the Test button, Live/BTW, and the
`/v1` proxy adapters (OpenAI→Anthropic body+SSE translation exists for Claude
models reached via `/v1/chat/completions`). See `docs/TROUBLESHOOTING.md` and
`docs/CONFIGURATION.md`.

## Upstream serialization

**The 0.12.21 fix that must not regress.** OpenCode / OpenAI-compatible
gateways rejected chat with:

```
[400] session_id: Invalid input: expected string, received null
```

`ChatCompletionRequest.model_dump()` forwarded `session_id: null` (and other
nulls) upstream. Free DeepSeek Flash often still worked; stricter Console models
failed. The Test button used the same path.

`dump_openai_upstream_body` / `dump_anthropic_upstream_body` now use
`exclude_none` + strip August-only keys before upstream calls. They are used by
workbench chat, the model Test button, and the `/v1/chat/completions` ·
`/v1/messages` proxy adapters. The API format dropdown labels are simplified to
`chat/completions` / `messages` / `responses`.

## Pricing

**Per-model pricing** follows one rule: `priceInPerM` / `priceOutPerM` (and the
pre-existing `free` flag) are set in Model settings, and
`cost_estimator.price_for_model` is the ONLY pricing source — resolve order is
env override → the model's own price → `free` → family table → default, and it
returns `estimated: True` for the last two so a readout can tell a fact from a
guess (`~$0.41`). Do not add a second rate table or a flat-rate computation:
`logger.get_stats` used to bill every token at 3.0/15.0 regardless of model and
disagreed with the composer chip. **0.0 is a price, not an absence** — only
`None` means unset, so nothing on this path may use `value or default`.

The price index is stamped on `(mtime, size)` and busted by `saveProvidersStore`;
`getProvidersStore()` re-reads its file on every call, and the usage endpoint
sums cost across up to 500 events, so an uncached lookup is a per-event file
read. `getProvidersAsModels()` and `_provider_to_dict` rebuild model entries
field by field, so a new per-model field must be named in BOTH or it is
silently dropped on read (write-only).

## Routing evidence

Routing evidence (`routing_evidence`) is written by the Arena/Debate verdict
endpoint (`POST /api/brain/routing/arena`, `source='arena'`) and read back by
`GET /api/brain/routing/arena` (archive) + `GET /api/brain/routing/suggestions`
(per-model win-rate ranking). There is NO automatic turn rerouting — the old
`AUGUST_AUTO_ROUTE` / `routingSuggestion`-SSE / per-turn auto-route claims were
never wired into the loop and have been removed.
