# deepseek-harness / dsh-llm-compaction#2

## Shard shape

This shard is the **model-call capability family** of the DeepSeek Harness — every package under `packages/llm/**` (229 files, nine published packages plus the group README). It holds one provider-neutral service (`packages/llm/llm`, 26 files) that owns the message/content-block/stream-chunk vocabulary, the adapter registry, the configurable-provider directory and the streaming boundary; two *structurally different* adapters over it — `llm-deepseek` (48 files, a direct Messages-wire implementation with its own serializer, SSE translator, vision-token calculator and Files-API upload store) and `llm-pi-ai` (43 files, a pi-ai-library implementation serving many providers and hand-declared gateways through per-route profiles); the two credential plugins that register the DeepSeek routes (`llm-deepseek-api-key`, `llm-deepseek-account`); the retry executor (`llm-retry`) that re-runs a failed request at a durable agent-step boundary under a *provider-owned* policy; the replay-aware measurement service (`token-meter`) that turns the durable session log into request pressure, occupancy and per-turn billing; and two small satellites — the request-extension registry (`deepseek-llm-api-extensions`) that lets plugins own one top-level field of the official DeepSeek request, and the plugin-package inventory that reports the active Loader package set to the provider. The package-group README names the two related subsystems this shard does *not* hold (`docs/subsystems/llm-streaming.md`, `docs/subsystems/token-meter.md`) and one architecture note that explains the deliberate duplication: the DeepSeek route ships two structurally different adapters so one of them can be a design-verification twin of the other. Everything in the shard is provider-neutral at the seam and provider-specific only below it; the only wire formats present are Anthropic-Messages (DeepSeek route), OpenAI-completions/Responses/Anthropic-Messages (pi-ai route), and the plain HTTP `GET /models` discovery probe.

---

## Per-file notes

### packages/llm/README.md
Group map for the `llm/` capability family: a table of the nine packages with their role and their ctx key (`ctx.llm`, `ctx.deepseekLlmApiExtensions`, `ctx.tokenMeter`, plus the two event-listening plugins), and links to the streaming/token-meter subsystem docs and to the "twin LLM adapters" architecture note.

### packages/llm/README.zh.md
Chinese translation of the package-group README; read the summary and package table to confirm the same nine packages and ctx keys.

### packages/llm/README.i18n.yaml
Per-section EN/ZH content digests (7 sections) for the package-group README; the header names the `pnpm run verify-translation-pairing --write` command that records them.

### packages/llm/deepseek-llm-api-extensions/src/index.ts
- **Purpose:** the registry that lets a plugin own exactly one top-level field of an official DeepSeek request, with the base adapter running one prepare/accept transaction.
- **Key abstractions:** `DeepSeekLlmApiExtensionRegistry` (a Cordis `Service` on `ctx.deepseekLlmApiExtensions`); `ErasedProvider`; `acceptAll()`; `abortable()`.
- **Data flow:** `register(field, provider)` claims a field inside `ctx.effect` (so the claim dies with the registering fiber); `prepare(request)` snapshots the providers, prepares them concurrently, `structuredClone`s + `freezeJson`s each value, and returns `{ fields, accept }`; the adapter calls `accept()` only after HTTP 2xx.
- **Non-obvious design decisions:** a provider whose preparation throws is **omitted** from that request rather than failing the request — the other fields still go out, and only the first failure per field is logged (`index.ts:118-124`). `accept()` is idempotent: concurrent calls join the same settlement promise (`index.ts:139`).
- **Edge cases / failure handling:** cancellation rejects and stops awaiting providers even when one ignores its signal (`abortable`, `index.ts:51-63`); several acceptance failures become one `AggregateError` after every callback has settled (`index.ts:41-48`); a cancellation-caused failure is not logged as a provider failure (`index.ts:119`).
- **Surprising:** the prepared operation keeps the providers it captured even if HMR removes their registrations before HTTP acceptance — the capture, not the registry, is the commit list.

### packages/llm/deepseek-llm-api-extensions/src/types.ts
Type vocabulary for the extension registry: `DeepSeekLlmApiJson` (lossless JSON), the declaration-merge point `DeepSeekLlmApiExtensionMap` (empty here; contributor packages merge their field into it), `DeepSeekLlmApiExtensionRequest` (exact serialized body + optional `sessionId` + `purpose: 'compaction' | 'session-title'` + `signal`), and `PreparedDeepSeekLlmApiExtensions`.

### packages/llm/deepseek-llm-api-extensions/tests/registry.spec.ts
Registry tests: detached and frozen field values (mutating the source after `prepare` does not change the prepared value), the acceptance method keeping its receiver, duplicate-field refusal with release on dispose, every callback settling before one or several failures are reported, and a cancelled preparation rejecting without logging a warning.

### packages/llm/deepseek-llm-api-extensions/README.md
The registry's contract in prose: one provider per field, the field name validated as a non-blank trimmed string, `prepare` cloning/freezing and omitting a failing provider, `accept()` running each captured callback once, and the explicit statement that registry fields are model-hidden provider metadata with **no KV-cache effect** (they do not alter the serialized model-input prefix).

### packages/llm/deepseek-llm-api-extensions/README.zh.md
Chinese translation of the extensions README; read the summary and service sections.

### packages/llm/deepseek-llm-api-extensions/README.i18n.yaml
Per-section EN/ZH content digests (10 sections) for the extensions README; the header names the `pnpm run verify-translation-pairing --write` command that records them.

### packages/llm/deepseek-llm-api-extensions/package.json
Manifest for `@deepseek-ai/dsh-deepseek-llm-api-extensions` v0.2.1-rc.2: exports `.`, `./types`, `./src/*` and `./locale/*.json`; peer dependency on `cordis` only.

### packages/llm/deepseek-llm-api-extensions/tsconfig.json
TypeScript project extending `tsconfig.base.json`, `rootDir: src`, `outDir: lib/types`, referencing only the vendored cosmokit and cordis.

### packages/llm/deepseek-llm-api-extensions/locale/en.json
English locale stub: `meta.title` "deepseek-llm-api-extensions" only.

### packages/llm/deepseek-llm-api-extensions/locale/zh.json
Chinese locale entry: title "DeepSeek API 扩展" plus a one-line description of letting other plugins add extension fields to DeepSeek model requests.

### packages/llm/llm-deepseek-account/src/catalog.ts
- **Purpose:** the credential-scoped `/models` cache for the account route: one listing per (endpoint, credential) pair, with single-flight loads, background refresh and last-known-good retention.
- **Key abstractions:** `AccountModelCatalog`; `CatalogView` (`signedIn` + last listing); `CatalogDependencies` (settings/token/load/now/info/warn injected, so the class is testable without I/O).
- **Data flow:** `view(signal)` re-reads settings, resolves the token, computes `scope = url + "\n" + sha256(token)`, rescopes when it changed (aborting the in-flight load and clearing the listing), then either awaits the first load of the scope or returns the cached view and kicks a background refresh when the listing is older than `maxAgeMs`.
- **Non-obvious design decisions:** the scope is the SHA-256 of the token, not the token itself, so a per-account listing cache never persists a credential; a *signed-out* scope is `undefined` and loads nothing.
- **Edge cases / failure handling:** a failing load keeps the **previous** listing and only warns on the *first* failure of a streak (`catalog.ts:120-128`); a `generation` counter discards a result that settles after a rescope or a dispose; the first wait is bounded by the request deadline (`deadline(request.signal, timeoutMs, LISTING_TIMEOUT)`), while a caller's own abort abandons only the caller's wait and leaves the shared load running (`abandonable`, `catalog.ts:33-43`).
- **Surprising:** a stale result that arrives after `dispose()` is dropped silently — the catalog is closed, not failed.

### packages/llm/llm-deepseek-account/src/config.ts
- **Purpose:** the account route's configuration and the one explicit resolve step from raw settings to validated facts.
- **Key abstractions:** `Config` (extends the Messages protocol config, minus `models`); `ModelOverride`; `ResolvedAccountOptions` (protocol + catalog settings + overrides); `resolveAccountOptions()`; `plainAccountOptions()`.
- **Data flow:** `Config` is a schemastery schema with `modelsTimeoutMs` (default 5 000), `modelsMaxAgeMs` (default 600 000) and `modelOverrides`; `resolveAccountOptions` bounds each value again, derives the listing endpoint from the Messages **origin** (`new URL('/models', new URL(baseURL).origin)`), and validates every override by round-tripping it through `resolveAdapterOptions`.
- **Non-obvious design decisions:** the `models` key is **rejected outright** with a message naming `modelOverrides` as the replacement — the catalog is now the account service's business (`config.ts:114-117`). An unset list in an override materializes as `[]` and is read as *inherited*, so `resolveOverride` strips empty arrays and `undefined` before layering (`config.ts:88-104`).
- **Edge cases / failure handling:** an override that sets `id` is refused (the key *is* the id); an empty model id is refused; an override that declares an image limit without the image modality is caught by the adapter's own cross-field rule and reported with the cause chain.
- **Surprising:** `resolveOverride` validates the override against a synthetic *image-capable* stand-in model, because the real catalog entry may not exist yet when the override is written.

### packages/llm/llm-deepseek-account/src/listing.ts
- **Purpose:** the `GET /models` request and the per-entry decoding of the account listing.
- **Key abstractions:** `ListingEntry`, `ListedCapabilities` (`usable: true` + facts | `usable: false` + reason), `ClientRequirement` (`none` | `min-version` | `invalid`), `ModelListing` (entries + `skipped` count); `LISTING_TIMEOUT` reason code.
- **Data flow:** `requestModelListing(url, headers, signal)` performs one authenticated GET (rejecting redirects) and hands the body to `parseModelListing`; each entry decodes its name, `client_requirements[APP_IDENTITY.product].min_version`, input modalities, context window, output cap and the Messages system-prompt mode.
- **Non-obvious design decisions:** a `capacity()` helper returns `undefined` for absent and `false` for "declared but not a positive safe integer", so an unusable number is distinguishable from an undeclared one; `knownModalities` keeps the *listing's* order rather than the build's.
- **Edge cases / failure handling:** rows without a usable id and repeated ids are **counted** in `skipped`, not hidden; a malformed `client_requirements` value becomes `{kind:'invalid'}` rather than an exception; a timeout is reported as `TIMEOUT` with the elapsed budget, an abort as `ABORTED`, and a transport failure as `TRANSPORT`.
- **Surprising:** an entry whose capabilities are unusable still contributes its id, name and requirement — the gate is decided later, where the version check lives.

### packages/llm/llm-deepseek-account/src/resolve-catalog.ts
- **Purpose:** turning the listing plus this build's model knowledge plus deployment overrides into the offered and resolvable catalog.
- **Key abstractions:** `AccountCatalog` (`offered`, `resolution`, `refusals`, `problems`, `overrideErrors`); `CatalogRefusal` (`upgrade-required` | `unsupported`); `layered()`; `listed()`; `gateOf()`.
- **Data flow:** `resolveAccountCatalog` maps the supported models by id, applies each override (re-validating it and recording a diagnostic if it does not apply), then walks the listing in order: gate → capability check → layer the listing's facts over the bundled entry → offer. `resolution` = offered + supported-not-offered.
- **Non-obvious design decisions:** `layered()` deletes `imagePixelBudget`/`imageMaxBytes` when the merged model does not accept images, so a text-only result cannot inherit image limits it no longer means (`resolve-catalog.ts:43-50`). The listing's `max_output_tokens` bounds the *request default* via `Math.min(routeMaxTokens, capability)` rather than replacing it.
- **Edge cases / failure handling:** an override naming a model neither the listing nor the bundled catalog describes is reported as `overrideErrors`; a semver-invalid `min_version` becomes an "unreadable client requirement" problem and the model is refused as unsupported.
- **Surprising:** `resolution` deliberately keeps the *supported* models the listing does not offer — the listing gates what is *selectable*, not what may be *requested*.

### packages/llm/llm-deepseek-account/src/index.ts
- **Purpose:** the `deepseek-account` provider plugin: credential resolution, the account model listing, model admission and provider registration.
- **Key abstractions:** `AccountConnection` (protocol options + resolved catalog); `refuse()`; `AccountModelCatalog`; `registerDeepSeekProvider`.
- **Data flow:** `resolveAuth` resolves the account token for the connection's base URL and returns `x-dsh-auth-token` plus an `onRequestError` callback; `catalog.view()` provides the listing; `connectionOf(view)` resolves the catalog and publishes override diagnostics on the provider directory; `registerDeepSeekProvider` wires the route with `options`, `connect`, `admit` and `discoverModels`.
- **Non-obvious design decisions:** the account route **never falls back to an API key** — a signed-out request fails `ACCOUNT_SIGN_IN_REQUIRED` before any fetch (`index.ts:57`); the listing endpoint is derived from the Messages origin and is not configurable.
- **Edge cases / failure handling:** a 401 on the account route becomes `ACCOUNT_TOKEN_INVALID` and asks the account service to reject the token, while a failure to remove the credential cannot replace the inference failure (`index.ts:66-69`); the shared transport's `QUOTA` is rewritten to `ACCOUNT_QUOTA` so a top-up prompt does not appear on API-key or third-party failures; the `QUOTA` rewrite applies to both HTTP 402 and in-band SSE errors.
- **Surprising:** `connect` is asynchronous and is awaited by the adapter for exact-model lookups, so the first request of a session can pay the listing latency (bounded by `modelsTimeoutMs`).

### packages/llm/llm-deepseek-account/tests/catalog.spec.ts
Cache behaviour under test: a signed-out view without any load; one shared first load between concurrent callers; the first wait bounded by the request deadline with the bundled catalog as fallback; a caller's abort abandoning only that wait; a stale listing refreshed in the background and *kept* through a failing streak; rescoping on another account discarding the previous account's result; disposal aborting in-flight work and a late success being dropped.

### packages/llm/llm-deepseek-account/tests/resolve-catalog.spec.ts
Catalog resolution under test: the bundled catalog served without a listing; listing capabilities layered over the bundled entry in listing order; the build's values kept for fields the listing omits; a minimally declared but vouched model served with request defaults only; a smaller output capability bounding the request default; overrides applied over the listing; image limits dropped when the override makes the model text-only; and an override that does not apply reported instead of silently skipped.

### packages/llm/llm-deepseek-account/tests/listing.spec.ts
Listing decoding under test: the real 2026-09-24 service listing decoded field by field; rows without a usable id and repeated ids counted as skipped; a non-listing body rejected; every `client_requirements` shape (absent, another product, an empty object, a valid prerelease min_version, a bare string, a numeric version, an empty version) mapped to the right requirement kind; and the request deadline reported as `TIMEOUT` while a caller abort is `ABORTED`.

### packages/llm/llm-deepseek-account/tests/provider.spec.ts
Provider-level tests over a real loopback server: discovery and disposal independent across the two credential routes; the version gate refusing a listed model before network I/O; a model without a min_version offered only when the built-in catalog knows its id; the retired `models` setting rejected at load (leaving no providers registered); and disposal aborting an in-flight listing request.

### packages/llm/llm-deepseek-account/tests/config.spec.ts
Config tests: the listing endpoint derived from the Messages origin and the cache defaults; rejection of a non-positive or oversized `modelsTimeoutMs`, a negative or fractional `modelsMaxAgeMs`, the retired `models` key, an empty model id, an override setting `id`, and an override declaring image limits on a text-only model; an override keeping only the fields it declares.

### packages/llm/llm-deepseek-account/tests/account-quota.spec.ts
Quota-classification tests: a 402 `insufficient_balance` becomes `ACCOUNT_QUOTA` on the account route (with or without an API key present) but stays `QUOTA` on `deepseek-official`; an in-band SSE error with the same code also becomes `ACCOUNT_QUOTA`; and a 401 on the account route still expires the stored credential.

### packages/llm/llm-deepseek-account/README.md
The account route's contract: `x-dsh-auth-token` authentication with a failure callback bound to the same token, a credential-scoped `/models` listing with first-use wait / background refresh / last-known-good retention, semver `min_version` gating (including the stated rule that a prerelease orders below its release, so a listing admitting prereleases must declare the earliest), the listing's capabilities overriding the bundled entry while the build's tool-update mode and image budgets survive, `modelOverrides` layering, and the `QUOTA`→`ACCOUNT_QUOTA` rewrite.

### packages/llm/llm-deepseek-account/README.zh.md
Chinese translation of the account README; read the summary, usage, implementation and limitations sections (it also carries the YAML example and the config table).

### packages/llm/llm-deepseek-account/package.json
Manifest for `@deepseek-ai/dsh-llm-deepseek-account` v0.2.1-rc.2: peers on `dsh-llm`, `dsh-llm-deepseek`, `dsh-launch-environment`, `dsh-deepseek-account`, `dsh-timeout` and the loader; `dsh-deepseek-account` and the loader are optional peers; dependency on `semver`.

### packages/llm/llm-deepseek-account/tsconfig.json
TypeScript project with nine references including `../llm`, `../llm-deepseek`, `../../util/launch-environment`, `../../credentials/deepseek-account` and `../../util/timeout`.

### packages/llm/llm-deepseek-account/locale/en.json
English locale stub: `meta.title` "llm-deepseek-account" only.

### packages/llm/llm-deepseek-account/locale/zh.json
Chinese locale entry: title "DeepSeek 账号模型接入" plus a one-line description.

### packages/llm/llm-deepseek-account/README.i18n.yaml
Per-section EN/ZH content digests (13 sections) for the account README.

### packages/llm/llm-deepseek-api-key/src/index.ts
- **Purpose:** the `deepseek-official` provider plugin: API-key authentication, credential-gated model discovery and route registration.
- **Key abstractions:** `resolveApiKey()`; `registerDeepSeekProvider`; `ctx.llm.registerConfigurableProviders`.
- **Data flow:** `options()` resolves the endpoint + credential reference from one configuration generation; `resolveApiKey` asks `ctx.credentials` first (the credentials service takes precedence) and falls back to the launch environment only when no credentials service is mounted; the validated key is sent as `x-api-key`.
- **Non-obvious design decisions:** discovery returns an **empty catalog** when the key is missing — the route disappears from model selectors while keeping its settings entry — but a *malformed* credential propagates as `INVALID_CREDENTIAL` (`index.ts:42-50`).
- **Edge cases / failure handling:** `assertUsableApiKey` refuses a blank or illegal-character key with `INVALID_CREDENTIAL`, a code distinct from `MISSING_CREDENTIAL` because the fix differs; other credential-lookup errors propagate.
- **Surprising:** the account route and this route never fall back to each other — the API-key env var is consulted only by this plugin.

### packages/llm/llm-deepseek-api-key/src/config.ts
API-key configuration: `Config` extends the shared Messages config with a volatile `apiKeyEnv` (default `DEEPSEEK_API_KEY`); `plainOptions` reads the current value behind the reference; `resolveAdapterOptions` binds the endpoint facts **and** the `CredentialRef` from one generation, so an in-flight request cannot end up with one endpoint and another credential.

### packages/llm/llm-deepseek-api-key/tests/discovery.spec.ts
Three discovery cases: no key (undefined or empty) hides the models, a key advertises the configured models, and a malformed credential surfaces as `INVALID_CREDENTIAL` during discovery.

### packages/llm/llm-deepseek-api-key/README.md
The API-key route's contract: `apiKeyEnv` resolved per request through the credentials service when present, `MISSING_CREDENTIAL` vs `INVALID_CREDENTIAL`, discovery returning an empty catalog without a key while keeping the settings entry, one configuration generation for endpoint + credential reference, and the catalog being configuration metadata rather than remote validation.

### packages/llm/llm-deepseek-api-key/README.zh.md
Chinese translation of the api-key README; read the summary, usage, implementation and limitations sections.

### packages/llm/llm-deepseek-api-key/package.json
Manifest for `@deepseek-ai/dsh-llm-deepseek-api-key` v0.2.1-rc.2: peers on `dsh-llm`, `dsh-llm-deepseek`, `dsh-launch-environment`, `dsh-credentials` and the loader; dependency on schemastery.

### packages/llm/llm-deepseek-api-key/tsconfig.json
TypeScript project referencing `llm`, `llm-deepseek`, `launch-environment`, `credentials/credentials`, the loader and schemastery.

### packages/llm/llm-deepseek-api-key/locale/en.json
English locale stub: `meta.title` "llm-deepseek-api-key" only.

### packages/llm/llm-deepseek-api-key/locale/zh.json
Chinese locale entry: title "DeepSeek API 密钥接入" plus a one-line description.

### packages/llm/llm-deepseek-api-key/README.i18n.yaml
Per-section EN/ZH content digests (13 sections) for the api-key README.

### packages/llm/llm-deepseek/src/adapter.ts
- **Purpose:** the direct Messages transport: one cancellable lifecycle per model request.
- **Key abstractions:** `DeepSeekAdapter` (extends `LlmAdapter`); `DeepSeekFileStore`; `RequestFiles`; `prepareRequestExtensions`.
- **Data flow:** `prepareCall`/`stream` resolve the connection (optionally awaiting `connect()`), call `admit()` **before** any I/O, prepare images, serialize the request, merge plugin extension fields, POST to the Messages endpoint, parse SSE, translate to `StreamChunk`s, then call `extensions.accept()` after the 2xx.
- **Non-obvious design decisions:** the whole request body is serialized **before** the extension fields are merged, and the merged payload is re-serialized — so a plugin field can never mutate the base request (`request-extensions.ts`). The stream read is wrapped in an `idleWatchdog`, and a provider failure is routed through `auth.onRequestError` so the account route can classify a 401 and expire its credential.
- **Edge cases / failure handling:** a provider error is classified with `providerError()` and then re-thrown as an `LlmError` carrying the status, the request id and any provider retry delay; a Files-API quota error triggers one bounded cleanup-and-retry (`files.retry(detail)`); an empty body is `EMPTY_RESPONSE`; a credential-update failure cannot replace the original inference failure (`adapter.ts:168-176`).
- **Surprising:** `providerErrorDetail` reads only `error.code`, `error.type` and `error.message` — the Files recovery classification is deliberately blind to any other response field.

### packages/llm/llm-deepseek/src/serialize.ts
- **Purpose:** mapping the harness's system snapshots, tool changes and conversation turns onto the Messages wire.
- **Key abstractions:** `WireRequest`/`WireMessage`/`WireBlock` (from `wire-types.ts`); `toolInput()`; `readReplay()`.
- **Data flow:** for each durable message the serializer emits user/assistant/system roles; assistant reasoning blocks become `thinking` blocks carrying the replay signature when one is available; tool calls become `tool_use`; tool results become `tool_result`; developer messages become system-role updates after the preceding user turn, with `tool_addition`/`tool_removal` references.
- **Non-obvious design decisions:** empty assistant text blocks and empty assistant messages are skipped, but **empty tool results keep their call ids** (`serialize.ts:41-44`) — dropping them would orphan the pairing. Historical tool arguments that are not JSON objects are sent as empty input rather than failing the request.
- **Edge cases / failure handling:** a content kind Messages cannot represent raises `UNSUPPORTED_CONTENT`; `max_tokens` falls back from the request to the model's own cap to the route's cap.
- **Surprising:** the `system` field is a single joined string (`[options.system, historySystem].filter(Boolean).join('\n\n')`) even on the `in-history` route — only the *later* updates become system-role messages.

### packages/llm/llm-deepseek/src/translate.ts
- **Purpose:** translating Messages SSE events into the harness `StreamChunk` protocol while preserving block order and cumulative usage.
- **Key abstractions:** the internal `Block` record (index, content, replay, closed, json); `updateUsage()`; `startBlock()`; `deltaChunk()`.
- **Data flow:** `content_block_start` opens a block, `*_delta` events append to it, `signature_delta` accumulates into the replay block (and emits **no** chunk), `input_json_delta` accumulates raw JSON into the tool call, and `message_delta`/`message_stop` produce the usage and finish chunks.
- **Non-obvious design decisions:** a tool call's arguments are kept as the **raw JSON string** the model produced (`block.json`), and the JSON is only validated at `message_stop` — truncated tool JSON is retained in the stream and pruned by the shared assembler, while a `max-tokens` stop deliberately skips that validation (`translate.ts:150-158`).
- **Edge cases / failure handling:** a non-integer or negative block index, a missing string field, an empty tool identity, an unsupported block type and a usage counter that is not a non-negative safe integer are all `MALFORMED_RESPONSE`; a stream that ends without `message_stop` is `STREAM_CLOSED`.
- **Surprising:** the usage chunk is emitted **before** the finish chunk (the deferred-emit contract the whole harness depends on) and `totalTokens` sums input + output + cacheRead + cacheWrite.

### packages/llm/llm-deepseek/src/sse.ts
SSE framing delegated to `eventsource-parser`: heartbeat comments pulse the idle watchdog, an unterminated tail is not an event, invalid JSON is `MALFORMED_RESPONSE`, an event whose `type` disagrees with the SSE event name is `MALFORMED_RESPONSE`, and an `error` event is turned into a provider error rather than a chunk.

### packages/llm/llm-deepseek/src/transport.ts
The one place provider failures become provider-neutral failures: `providerError(raw, status, headers)` maps 401/403 or `authentication_error`/`permission_error` to `AUTH`, quota wording or 402 to `QUOTA`, 429 or `rate_limit_error` to `RATE_LIMIT`, context-overflow wording to `CONTEXT_WINDOW_EXCEEDED`, 400/413 to `INVALID_REQUEST` and 5xx to `SERVER`; it also parses `Retry-After` (numeric seconds **or** an HTTP date) into `providerRetryAfterMs` and picks a request id out of three header spellings.

### packages/llm/llm-deepseek/src/replay.ts
- **Purpose:** the minimal native thinking metadata that must survive between turns.
- **Key abstractions:** `ReplayBlock` (`type` + optional `signature`); `replayState(model, blocks)`; `readReplay(message, model, onDegrade)`.
- **Data flow:** the stream translator accumulates `signature_delta` into the block's replay entry; the assembler stores the envelope on the assistant message's source; the next request's serializer reads it back and re-attaches the signature to the `thinking` block.
- **Non-obvious design decisions:** the envelope is validated against the *durable* content — kind, version, the assistant's own model, the block count and each block's type must all agree; any mismatch discards the metadata and the request proceeds with provider-neutral content, reporting a diagnostic that carries **no** message content and no signature (`replay.ts:39-63`).
- **Edge cases / failure handling:** a cross-model signature is *not* portable, so replay is only used when the target model equals the recorded one; a failure that is not `INVALID_REPLAY_STATE` is re-thrown rather than degraded.
- **Surprising:** the durable blocks own all the response text — the replay envelope stores only the signature, so a replay bug can never corrupt the visible transcript.

### packages/llm/llm-deepseek/src/request-extensions.ts
`prepareRequestExtensions`: merges the plugin fields under the base body, **refuses** a field that collides with a base Messages field (`REQUEST_EXTENSION`), and on a serialization failure falls back to the base body alone with a no-op `accept()` — so contributors resend their unaccepted state on a later request rather than the request being lost. An acceptance failure after a 2xx is reported and does not fail the request.

### packages/llm/llm-deepseek/src/images.ts
- **Purpose:** deterministic image preparation for Files references and bounded inline fallback.
- **Key abstractions:** `prepareImages()`; `inlineImages()`; `assertImagesFit()`; `prepareFileIds()`.
- **Data flow:** offloaded occurrences are projected to placeholder text first; if any image remains, the model must declare the `image` modality and the attachment service must be mounted; each retained reference is read into a request version at the route's request target; the raw byte budget is then checked, and each occurrence is resolved to a Files id.
- **Non-obvious design decisions:** the route does **not** offload on its own — it fails with `IMAGE_OFFLOAD_REQUIRED` naming the number of *oldest* occurrences that must be offloaded, because the offload decision is a durable surface fact owned elsewhere (`images.ts:78-91`).
- **Edge cases / failure handling:** images are rejected in assistant messages and in roles other than user/tool (`UNSUPPORTED_CONTENT`); a model without the image modality or a missing attachment service is also `UNSUPPORTED_CONTENT`.
- **Surprising:** the byte budget is checked twice — once in raw bytes (the Files representation) and once in base64 length (the inline representation) — because the two representations differ by exactly the 4/3 expansion.

### packages/llm/llm-deepseek/src/request-pricing.ts
- **Purpose:** provider-side pricing of every retained image occurrence, at the projection the request actually sends.
- **Key abstractions:** `resolveRequestImageTarget()`; `deepSeekImageRequestPricing()`; `DEFAULT_REQUEST_IMAGE_MAX_BYTES`, `REQUEST_IMAGE_MAX_DIMENSION`, `DEFAULT_LOW_DETAIL_IMAGE_PIXEL_BUDGET`.
- **Data flow:** the target is the published token grid (or the model's pixel budget, or the `low` preset), capped at the provider's 4096 px per side, with an encoded-byte target; the pricing function prices each occurrence as `visualTokens + model-visible text`, where the text is the request-preview handle for a retained image and the offload placeholder for an offloaded one.
- **Non-obvious design decisions:** a route whose adapter declares no image capability prices every occurrence as its **text-only substitution** — the same substitution `LlmRuntime` applies before dispatch — so the meter and the wire agree (`request-pricing.ts:96-98`). A text-only model and an uncatalogued model are priced identically.
- **Edge cases / failure handling:** the function is synchronous and performs no I/O (the token meter resolves it per measurement); the text is built through the same access resolution the serializer uses, so a changed execution-world path only shifts the text price by its own length.
- **Surprising:** the provider's own per-side limit (4096 px, applied to requests carrying 15+ images) is applied to *every* request image, so the image count never changes a projection.

### packages/llm/llm-deepseek/src/image-tokens.ts
A verbatim port of the provider's published `v41` image-token calculator: a 14 px patch grid, a 3:1 per-axis downsample, a 544×544 total-pixel scale-up floor, and a 1024-token cap solved by finding the largest aspect-preserving grid inside the budget. The projection is iterated to a fixpoint because the first pass is not always one (`image-tokens.ts:147-157`); `deepSeekRequestImageDimensions` returns the dimensions the harness should *send* so the provider keeps the whole image.

### packages/llm/llm-deepseek/src/file-store.ts
- **Purpose:** Files-API upload reuse, invalidation and quota recovery.
- **Key abstractions:** `DeepSeekFileStore`; `DeepSeekFilePolicy`; `DeepSeekFileConnection`; `SharedUpload` (a shared in-flight upload with a waiter count).
- **Data flow:** `ensureUploaded` resolves the namespace scope (endpoint + sorted auth headers → SHA-256), looks the variant up in the durable index, uploads through the Files client when needed, and commits the mapping; `invalidate` removes exact generations; `reclaimOldestOwned` deletes the oldest harness-owned files on a quota error.
- **Non-obvious design decisions:** the scope hash includes the **sorted** header names, so reordering the headers does not create a second namespace (`file-store.ts:49-54`); a cancelled caller only aborts the shared upload when it was the **last** waiter (`waitForUpload`, `file-store.ts:69-103`).
- **Edge cases / failure handling:** a non-`Error` abort reason is wrapped so the cancellation still carries a cause; a quota error is detected by a regex over the provider detail and triggers one bounded cleanup + re-upload.
- **Surprising:** `releaseAll` loops `reclaimOldestOwned` in batches of 1000 until it stops finding files, then clears the scoped index — releasing a namespace is a loop, not a call.

### packages/llm/llm-deepseek/src/files-api.ts
The Files API transport: `upload`/`list`/`retrieve`/`delete` against `messagesApiRoot(baseURL)/files`, the `files-api-2025-04-14` beta header, a `DeepSeekFilesError` that keeps the HTTP status and the provider detail for classification, `isFilesQuotaError` matching quota/storage/file-count wording, and strict decoding — a `delete` response must be `{id, type:'file_deleted'}` or the operation is `INVALID_RESPONSE`.

### packages/llm/llm-deepseek/src/upload-index.ts
- **Purpose:** the durable attachment-to-file-id index.
- **Key abstractions:** `DeepSeekUploadIndex`; `DeepSeekUploadRecord` (scope, attachmentId, variantId, fileId, bytes, createdAt, expiresAt); `deepSeekFileScope()`.
- **Data flow:** the scope is a SHA-256 over the normalized endpoint plus the serialized credential (never the credential itself); `commit` adds a record under a file lock and reports whether this process won the race; `get` returns a record only above the refresh margin; `remove`/`clear` remove by scope.
- **Non-obvious design decisions:** a cross-process duplicate keeps the **first** winner and reports `accepted: false`, so two processes never fight over the same variant (`upload-index.ts:57-63`); removal matches on `(variantId, fileId)`, so removing one generation leaves the other intact.
- **Edge cases / failure handling:** every record field is validated on read (a `sha256:`-shaped digest, a non-empty file id, safe integers), and a corrupt index raises rather than silently dropping entries; a non-`ENOENT` filesystem read failure propagates.
- **Surprising:** the index format version is 3 — the record shape has changed twice, and the version is a literal in the type, not a constant.

### packages/llm/llm-deepseek/src/file-id.ts
The branded `DeepSeekFileId` and `DeepSeekFileScope` identifiers and their constructors; the constructors attach the brand but perform no validation, so the wire check lives in the files client.

### packages/llm/llm-deepseek/src/request-files.ts
Per-request Files state: each retained image is resolved under its own deadline, every occurrence is recorded with its position (`message`, `image`) so a rejection can be attributed, a provider error naming a file id invalidates **only** the mappings it names (an exact id mention wins over "the whole set"), and **one** stale-id retry is allowed per request before the request-wide inline fallback.

### packages/llm/llm-deepseek/src/model-info.ts
Model metadata and the reasoning ladder: four efforts (`off`, `low`, `high`, `max`), with `off` the only choice when the deployment disables thinking. An **uncatalogued** endpoint is treated as text-only, with the stated reason: declaring an unverified image capability would let the host persist input the endpoint may reject on every later turn (`model-info.ts:70-73`).

### packages/llm/llm-deepseek/src/models.ts
The advisory default catalog: `deepseek-flash` (text+image, `systemPromptUpdate: 'in-history'`, `toolUpdate: 'addition-only'`) and `deepseek-v4-pro` (text only, described as the stronger agentic-coding tier), both at a 1,000,000-token context window.

### packages/llm/llm-deepseek/src/messages-api.ts
Shared endpoint policy: the two beta feature names and `messagesApiRoot`, which appends `/v1` only when the configured path does not already end in it — so a custom `/anthropic` root is preserved rather than doubled.

### packages/llm/llm-deepseek/src/host.ts
- **Purpose:** the shared Host wiring both DeepSeek credential plugins reuse.
- **Key abstractions:** `registerDeepSeekProvider()`.
- **Data flow:** the adapter is constructed with the plugin's own `options`/`resolveAuth`/`discoverModels`/`connect`/`admit` plus the Host's attachment store, the filesystem host→execution-world path mapping, the anonymous user id and the extension registry; the retry policy is captured at registration and re-resolved on `loader/volatile-update`, replacing the routes in place when it changes.
- **Non-obvious design decisions:** the three warning channels (degraded replay, omitted extension fields, unaccepted extensions) are keyed per route and logged **once per route**, because the conditions repeat on every request of that route (`host.ts:24-47`).
- **Edge cases / failure handling:** the retry-policy re-resolution is wrapped so a bad policy logs and keeps the previous registration rather than throwing out of an event handler.
- **Surprising:** the extension registry is *optional* — with it absent, `prepareExtensions` resolves to an empty contribution, so the adapter works in a composition that never mounts it.

### packages/llm/llm-deepseek/src/config.ts
The Messages configuration schema and the single `resolveAdapterOptions` step: `baseURL` (explicit → `$DEEPSEEK_BASE_URL` → the public root), the `thinking`/`reasoningEffort` policy, `maxTokens`, `defaultContextWindow`, the advisory `models` catalog, `streamIdleTimeoutMs`, the four image budgets and three offload quanta, the file policy (expiry, refresh margin, quota cleanup batch), and the provider retry policy. `deepSeekConfigFields` is the shared field set the two credential plugins extend.

### packages/llm/llm-deepseek/src/defaults.ts
The shipped limits as constants: 300 000 ms stream idle timeout, 1 000 000 context window, 256 000 max tokens, 20 MiB inline image cap, 64 MiB / 10 MiB / 20-item offload quanta, 7-day file expiry, 1-hour refresh margin, 100-file quota cleanup batch, 60 s Files API timeout.

### packages/llm/llm-deepseek/src/types.ts
The adapter's type surface: `DeepSeekCatalogModel` (including `systemPromptUpdate` and `toolUpdate`, the two mid-conversation capabilities), `DeepSeekConnectionOptions` (re-read per operation, which is what lets a settings change reach the next request without re-registration), `DeepSeekRequestAuth` (headers plus an optional failure callback bound to that request's credential), and `DeepSeekAdapterOptions` with its three diagnostic hooks.

### packages/llm/llm-deepseek/src/wire-types.ts
The supported subset of the Messages protocol as types: text, base64 and file-referenced images, `tool_addition`/`tool_removal` references, `thinking` with an optional signature, `tool_use`, `tool_result`, and the `WireRequest` with `thinking`/`output_config.effort` and `defer_loading`.

### packages/llm/llm-deepseek/src/index.ts
The package's barrel: it re-exports the config fields and resolvers, every default constant, the adapter, the catalog and request-pricing helpers, the file store/client/index and the `registerDeepSeekProvider` helper — the only import surface for consumers.

### packages/llm/llm-deepseek/tests/runtime.spec.ts
The shard's largest suite (2383 lines): the adapter under a mock server for Files references, inline fallback, stale-id invalidation scoped to the named id, per-model catalog resolution and the whole config-bounds table, the retry-policy capture, and the provider catalog surface. Read in three passes (1–900, 901–1800, 1801–2383).

### packages/llm/llm-deepseek/tests/adapter.spec.ts
HTTP lifecycle under a real composition: assistant blocks preserved in saved user history, `redirect: 'error'` on every provider request, `x-api-key` versus `x-dsh-auth-token` never both present, `anthropic-version` sent, and the account route's token not leaking into the API-key route.

### packages/llm/llm-deepseek/tests/serialize.spec.ts
Serialization and replay validation: empty saved assistant text dropped without changing tool ids or thinking signatures, a system update flushed at its recorded position (not at an omitted empty assistant message), the replay envelope's block count and types checked against the durable content, and image admission errors.

### packages/llm/llm-deepseek/tests/file-store.spec.ts
File-store behaviour: credential values and header kinds isolated while reordered headers reuse the same record, the refresh margin enforced, a quota error driving a bounded cleanup, and `releaseAll` clearing the scoped index.

### packages/llm/llm-deepseek/tests/files-api.spec.ts
Files client behaviour: malformed JSON reported per operation with the HTTP status, a non-JSON body-read failure preserved as-is, uploads beneath the literal configured root with the files beta header and an `expires_after[anchor]/[seconds]` form, and the raw DSH token used as the auth header.

### packages/llm/llm-deepseek/tests/account-routing.spec.ts
The account route inside the real agent loop: signed-out never falls back to an API key (no fetch at all), a sign-out cancels only the active account route (including while a tool is running) and not the API-key route, and the signed-out failure is recorded on the session and published as sign-in guidance.

### packages/llm/llm-deepseek/tests/extensions.spec.ts
Extension settlement: the contribution is prepared against the native body and accepted before the first content chunk is yielded; a field colliding with the base request is refused; a serialization overflow falls back to the base body with no warning and no accept.

### packages/llm/llm-deepseek/tests/dynamic-config.spec.ts
Live configuration: a settings update reaches the next real request; a catalog the resolver rejects (duplicate ids) fails at resolve so *no* endpoint is contacted; and a retired `protocol:` setting is refused at mount.

### packages/llm/llm-deepseek/tests/loader-composition.spec.ts
Real-Loader composition: a profile patch edit and a credential rotation both reach the next real adapter request, the adapter boots on entry config alone with the environment as the credential plane, and the extension registry composes with the session-log and inventory plugins.

### packages/llm/llm-deepseek/tests/upload-index.spec.ts
Upload-index behaviour: trailing endpoint slashes normalised in the scope, API-key namespaces isolated, the refresh margin honoured, a reusable cross-process winner kept while an exact generation is removed, and non-cache filesystem failures propagated.

### packages/llm/llm-deepseek/tests/files.spec.ts
Files request behaviour: nested tool-result images kept in order, only Files ids on the wire with the beta header, one bounded stale-id recovery, and a request-wide inline fallback when the replacement file cannot be resolved.

### packages/llm/llm-deepseek/tests/stream.spec.ts
Protocol invariants at the JSON/SSE boundary: text already present in the start block is emitted, first-seen block indexes are used, raw tool JSON is preserved, usage is cumulative and disjoint, forward-compatible envelope events are ignored, and the full `providerError` classification table.

### packages/llm/llm-deepseek/tests/request-pricing.spec.ts
Request-image pricing: uncatalogued and text-only routes priced as their text substitution, a retained image priced at its projected dimensions (1920×1080 → 1708×961 → 968 visual tokens), the per-side cap (8192×1 → 4096×1), the numeric pixel budget override and the `low` preset.

### packages/llm/llm-deepseek/tests/image-tokens.spec.ts
Image-token pricing against the provider's published values (100×100 → 184, 640×480 → 206, 1920×1080 → 968, 5000×5000 → 994), the 1024-token cap for every size, the scale-up floor (100×100 costs the same as 544×544), the one-row and one-column solves for extreme aspect ratios, and the two-pass fixpoint cases.

### packages/llm/llm-deepseek/tests/egress.spec.ts
Egress: a Messages request to an unresolvable endpoint is observed through an HTTP proxy installed from the environment, so the adapter's traffic cannot bypass the user's proxy.

### packages/llm/llm-deepseek/tests/adapter.e2e.ts
Key-gated real-API e2e: a system-prompt update mid-conversation with and without the `in-history` capability, a tool round trip, a replay-state recovery (a v2 envelope degrades to provider-neutral content with one warning), and the Files API beta in use.

### packages/llm/llm-deepseek/tests/runtime.e2e.ts
Key-gated real-API e2e for the direct-fetch adapter: V4 Flash across thinking modes, a max-effort tool round trip with reasoning passback, the vision/files smoke behind `DEEPSEEK_VISION_E2E=1`, and a KV-cache reuse check comparing the cached token count before and after.

### packages/llm/llm-deepseek/tests/mock-server.ts
A scripted local Messages stand-in: per-request behaviors (`sse`, `http-error`, `close-early`), a Files API surface recording uploads/lists/deletes separately from model requests, recorded bodies and headers, and a `closeMockServers` teardown.

### packages/llm/llm-deepseek/tests/helpers.ts
The Messages test fixtures: the `textEvents`/`end`/`sse` builders, a loopback server recording every request, an adapter factory over the real `resolveAdapterOptions`, an image-store double that throws on any unexpected storage work, and a stub module loader for the HMR path.

### packages/llm/llm-deepseek/tests/assemble.ts
Test helper driving `ctx.llm.stream()` through a `BlockAssembler` and returning the assembled message, usage and finish reason — the same streaming path production uses.

### packages/llm/llm-deepseek/tests/expected/degraded-replay.json
The expected wire body when the replay metadata is unusable: the assistant `thinking` block is sent without its signature, the tool id is preserved, and the tool result keeps its `tool_use_id`.

### packages/llm/llm-deepseek/tests/fixtures/cordis.yml
The composition fixture: llm, session, session-projection, system-prompt, tools, agent, agent-loop, credentials-local and both DeepSeek routes, with `{{credentials}}` and `{{endpoint}}` placeholders and `thinking: enabled` / `reasoningEffort: high`.

### packages/llm/llm-deepseek/tests/fixtures/history.ts
A fake plugin that intercepts `llm/stream` and throws if the serialized Messages history contains an empty text block — a guard against re-introducing the empty-block bug.

### packages/llm/llm-deepseek/tests/fixtures/input-history.ts
A fake plugin that injects persisted user input carrying assistant-only content (a reasoning block and a tool call) and asserts that the serialized request keeps the child's answer but drops the unforwarded blocks.

### packages/llm/llm-deepseek/tests/fixtures/red.png
A 69-byte binary PNG fixture (a 1×1 pixel image). Its 16-byte header (`89 50 4E 47 0D 0A 1A 0A … IHDR`) confirms it is an image asset, not source; it was not read line by line.

### packages/llm/llm-deepseek/tests/model-info.spec.ts
One test: a minimal catalog declaration is advertised as text input with its id as the label.

### packages/llm/llm-deepseek/tests/prepared-call.spec.ts
Prepared calls retain their endpoint and credential generation: the prepared call keeps the first key and cap after the configuration changes, while `resolveModel()` reports the new generation.

### packages/llm/llm-deepseek/tests/provider-hooks.spec.ts
Provider-owned hooks on the shared adapter: `connect()` supplies the connection for both `resolveModelInfo` and `prepareCall`, `admit()` refuses a model before a prepared call exists, and a direct adapter stream refuses it too.

### packages/llm/llm-deepseek/README.md
The Messages transport's contract in prose: endpoint and wire format, account credentials, streaming with thinking and images, dynamic configuration, provider-specific request fields, and failures and recovery — including the `systemPromptUpdate: 'in-history'` rule (the endpoint reads the latest `system` message at any position, so the agent loop appends a changed prompt after the cached history instead of rewriting message 0).

### packages/llm/llm-deepseek/README.zh.md
Chinese translation of the Messages README; read the summary and the minimal-configuration table (lines 1–60).

### packages/llm/llm-deepseek/README.i18n.yaml
Per-section EN/ZH content digests (26 sections) for the Messages README.

### packages/llm/llm-deepseek/package.json
Manifest for `@deepseek-ai/dsh-llm-deepseek` v0.2.1-rc.2: dependency `eventsource-parser`, peers on cordis, the attachment/fs/timeout/home-paths/anonymous-user-id utilities and the extension registry, and a wide devDependency set covering the agent loop, the session log, the inventory plugin and the HTTP proxy.

### packages/llm/llm-deepseek/tsconfig.json
TypeScript project with 18 references (util/atomic-write, util/brand, util/home-paths, attachment, fs, identity/anonymous-user-id, settings, util/http-proxy, deepseek-llm-api-extensions).

### packages/llm/llm-pi-ai/src/adapter.ts
- **Purpose:** the generic pi-ai-backed implementation of the harness LLM seam.
- **Key abstractions:** `PiAiAdapter`; `PiAiSnapshot` (profiles + the `Models` collection built from them); `PiAiAdapterOptions` (`profiles()`, `resolveApiKey()`, `auth`).
- **Data flow:** each resolution builds a **new** `Models` collection holding one `Provider` per route and captures it before the operation's first `await`; the request is converted to a pi-ai `Context`, the credential is resolved through the harness seam and passed as the request's `apiKey` option, and the pi-ai event stream is translated into `StreamChunk`s.
- **Non-obvious design decisions:** the collection is **immutable per snapshot** because `Models.streamSimple()` is lazy — it resolves the provider when the stream is first consumed, which is *after* the credential await, so a mutated collection would let a request that started under one configuration finish under another (`adapter.ts:2-24`). A named credential reference is passed as the SDK's highest-priority auth override, which is what keeps the fail-loud reference semantics.
- **Edge cases / failure handling:** an `idleWatchdog` bounds the provider read; a consumer that stops early aborts the SDK and a detached drain owns the SDK's termination (the abandoned demand would otherwise park the generator's return forever, `adapter.ts:439-444`); an idle timeout becomes `TIMEOUT` and a caller abort becomes `ABORTED`.
- **Surprising:** the credential store and the auth context are **stable across snapshots**, so a configuration change rebuilds the collection without forgetting who is signed in.

### packages/llm/llm-pi-ai/src/context.ts
- **Purpose:** converting the harness request history into pi-ai's `Context` vocabulary.
- **Key abstractions:** `toPiContext()`; `toolResultOf()`; `userContent()`; `assertSupportedHistory()`.
- **Data flow:** system messages become the system prompt and later system messages stay in history order; user and tool content becomes text and image content; tool messages become pi-ai `toolResult` messages with the tool name recovered from the call-id map; developer messages keep their text and tool changes at their recorded position.
- **Non-obvious design decisions:** images are **never** inlined as base64 in the handle path — each retained image is preceded by a text descriptor naming the attachment id and the exact request dimensions, and the bytes follow; offloaded occurrences are projected to placeholder text and their normalized attachment is not read at all (`context.ts:357-360`).
- **Edge cases / failure handling:** tool-change blocks outside a developer role are `UNSUPPORTED_CONTENT`; an image in an in-history assistant message is `UNSUPPORTED_CONTENT`; a non-text system message is `UNSUPPORTED_CONTENT`; a tool message without `isError` is a *successful* result.
- **Surprising:** the request's base64 budget is enforced on the **exact** encoded payload and fails with `IMAGE_OFFLOAD_REQUIRED` naming how many more occurrences must be offloaded, so the compaction layer can log the decision and retry.

### packages/llm/llm-pi-ai/src/replay.ts
- **Purpose:** durable pi-ai replay metadata and assistant-history reconstruction.
- **Key abstractions:** `PiAiReplayBlock` (per-block signatures/namespaces); `PiAiReplayResponse` (version 2 envelope with api/provider/model/stopReason); `toPiReplayState()`; `toPiAssistant()`.
- **Data flow:** the completed native response is projected into a versioned envelope whose per-block half is index-aligned with the streamed blocks (so the assembler prunes an entry with its block); on the next request the envelope is validated and the native assistant message is reconstructed from the durable content plus the metadata.
- **Non-obvious design decisions:** the durable Harness content stays the source of truth for text and tool calls — only the provider-native metadata needed to rebuild the native message is stored; a replay envelope that does not validate degrades to a *foreign* assistant message and reports the reason (`replay.ts:247-258`).
- **Edge cases / failure handling:** tool-call argument JSON that does not parse is tolerated as `{}`; a failure that is not `INVALID_REPLAY_STATE` is re-thrown rather than degraded.
- **Surprising:** the envelope stores the *requested* model (not the provider-reported one) so the signature match stays exact, while `responseModel` is kept alongside it.

### packages/llm/llm-pi-ai/src/stream.ts
- **Purpose:** translating pi-ai assistant events into the harness streaming protocol.
- **Key abstractions:** `mapUsage()`; `mapStopReason()`; `toStreamChunks()`; `classifyPiAiError()`.
- **Data flow:** pi-ai's `start`/`text`/`thinking`/`toolcall`/`done`/`error` events become `block-start`/`text-delta`/`reasoning-delta`/`tool-call-delta`/`usage`/`finish` chunks; tool arguments are re-serialized to the raw JSON string the harness keeps.
- **Non-obvious design decisions:** the usage mapping keeps pi-ai's **exact** `totalTokens` and shows the cache buckets only when non-zero (pi-ai reports zeros, not absence); the error classification is pattern-based because pi-ai flattens the caught error to `error.message`, discarding the `cause` chain that undici would have carried (`stream.ts:34-41`).
- **Edge cases / failure handling:** each pi-ai provider's own "stream ended before a terminal event" wording is recognised as `TRANSPORT` rather than a model-level error; a 413 or an oversized body is `INVALID_REQUEST` (resending cannot succeed); an event stream that ends without done/error is `STREAM_CLOSED`.
- **Surprising:** pi-ai reports failures as *terminal stream events*, so a provider error becomes a harness `finish` chunk with `kind:'error'` rather than a throw.

### packages/llm/llm-pi-ai/src/config.ts
- **Purpose:** the provider-profile schema and its resolution.
- **Key abstractions:** `Config` (a `providers` dict keyed by route); `ResolvedPiAiProviderProfile`; `resolveProfiles()`; `assertServiceable()`.
- **Data flow:** each profile is validated against the installed pi-ai catalog when the route names a catalog provider (the catalog supplies the endpoint, protocol, display name and models as defaults the profile overrides field by field) or treated as a whole provider declaration when it does not; the resolved profile carries the retry policy, the image budgets and the catalog diagnostics.
- **Non-obvious design decisions:** the resolution is **strict or deferred**: strict resolution rejects unserviceable models before a settings write, while deferred resolution keeps their diagnostics so stored catalog drift does not prevent inspection or repair (`config.ts:8-11`).
- **Edge cases / failure handling:** `defaultInput: []` is refused by the namespace validator (the schema alone would accept it); a `reasoningEfforts` value outside the offered set is rejected at the write; a `retryPolicy` that cannot be resolved is rejected with the profile's name in the message.
- **Surprising:** `DEFAULT_MAX_REQUEST_IMAGE_BYTES` (20 MiB) is justified by the fact that **every image in history is re-encoded into every request body**, so an unbounded conversation eventually exceeds a provider cap and the session can never complete another request (`config.ts:50-58`).

### packages/llm/llm-pi-ai/src/catalog.ts
- **Purpose:** materialising one provider route's model catalog.
- **Key abstractions:** `MODALITY_GATE` / `THINKING_LEVEL_GATE` (compile-time drift gates); `declaredInput()`; `resolveModelReasoning()`; `resolveRouteModels()`; `catalogProvider()` / `catalogModels()`.
- **Data flow:** the installed pi-ai catalog supplies defaults keyed by model id; a profile's own entries override them field by field; each materialized model carries its modality list, its reasoning map and its compat block.
- **Non-obvious design decisions:** pi-ai's own defaulting is asymmetric (an absent key means "supported" for the five base levels but "unsupported" for `xhigh`/`max`), so a declared effort dict **pins every level explicitly**, undeclared ones to `null` — with `off` as the single exception that stays absent ("supported, send nothing") (`catalog.ts:701-773`). An absent modality list and an empty one mean the same thing ("no answer"), so an entry that declares nothing keeps the catalog's modalities.
- **Edge cases / failure handling:** a duplicate model id invalidates the id (including an earlier resolved entry); a route default that no model on the route could ever read is refused ("it exists on …"); a model-level switch on a protocol without that field is refused by name.
- **Surprising:** a model on a route whose siblings disagree about the protocol must **name** its protocol — the shared "newest release" default only exists when the route's models agree.

### packages/llm/llm-pi-ai/src/provider.ts
Provider construction: a catalog route that does not override the wire protocol **reuses the catalog provider** with its models replaced, because the catalog provider owns API implementations this package cannot reconstruct (Bedrock loads a Smithy module through a separate entry point) — rebuilding it from parts would silently narrow which providers work (`provider.ts:5-13`). Every other route is built by `createProvider` over a deliberately narrow three-entry protocol table; an unsupported protocol is refused by name with the supported list.

### packages/llm/llm-pi-ai/src/models.ts
Thin helpers over pi-ai's public entry points: `createModels` (clears the builtin providers), `createProvider` (a static single-protocol provider), `getSupportedThinkingLevels` (xhigh/max need an explicit map entry), and `conversationUpdates` (mapping the compat flags to `systemPromptUpdate`/`toolUpdate` per protocol — Anthropic tool changes are `in-history`, OpenAI additions `addition-only`, Responses `addition-only`).

### packages/llm/llm-pi-ai/src/auth.ts
The three adapters between pi-ai's auth model and the harness credential plane: `recordKeyFor` (records stored under the `llm-pi-ai` scope, which is what tells another adapter family that this plugin owns the format), `toPiCredential` (api-key records rebuilt field by field, grants stored **verbatim** as opaque JSON so a library that owns a token format keeps owning it), and `authContextFrom` (ambient `env`/`fileExists` answers). `jsonImage()` strips explicitly-undefined members because pi-ai's credentials idiomatically carry them and the store's strict validator refuses unrepresentable values.

### packages/llm/llm-pi-ai/src/login.ts
The whole of the translation between the harness's neutral notice/prompt vocabulary and pi-ai's `AuthInteraction`: `loginMethods()` offers a method only when pi-ai can actually run it (`openai` is excluded from OAuth because it needs an installation id the harness does not keep), and `relay()` restates `info`, `auth_url`, `device_code` and `progress` events — a device-code grant carries a `code` beside its `url` because the human needs both at once.

### packages/llm/llm-pi-ai/src/discovery.ts
Model discovery for the configuration surface: a route the installed catalog ships is answered **from that catalog** with no network call (pi-ai's registry is authoritative for its own providers and carries capacities a listing endpoint would not disclose), while only an uncatalogued route is interrogated over the wire. Nothing is stored — the request carries a draft the user is still editing. The reply is bounded to 4 MiB **read**, not claimed, because a truncated model listing is not parseable.

### packages/llm/llm-pi-ai/src/index.ts
The plugin entry: one plugin instance owns a dict of provider routes; a route naming an installed pi-ai provider inherits that provider's endpoint, protocol and catalog as defaults, and a route pi-ai has never heard of is declared outright. A dormant mount (no routes) is legal; a changed route set re-registers the **same adapter instance** in place, and the configurable-provider directory is replaced atomically.

### packages/llm/llm-pi-ai/src/provider-data.ts
`providerDefaultsOf` returns the generated display metadata (the env names a provider's resolver reads, its fixed endpoint, and whether a stored OAuth sign-in can authenticate it) **without executing authentication**; an unrecorded provider (a consumer may install a newer pi-ai) keeps only a fixed public endpoint and is not given guessed auth metadata.

### packages/llm/llm-pi-ai/src/provider-data.generated.ts
The generated table of 42 catalog providers with their environment variable lists and default base URLs. Generated from the installed catalog by `pnpm gen-provider-data`; the header says "do not edit", and a test asserts it still matches the installed catalog.

### packages/llm/llm-pi-ai/scripts/gen-provider-data.ts
The generator: it probes each provider's resolver with **synthetic** environment and file answers (never a real credential), iterating to a fixed point so short-circuit credential pairs and federation fields are found, under a 2 s timeout and a 128-read limit. `--check` and `--cached` compare the working and staged files so CI can prove the metadata is not stale.

### packages/llm/llm-pi-ai/tests/catalog.spec.ts
The largest pi-ai suite (1319 lines, 79 cases): hand-declared routes served from their own declaration, catalog routes with per-model configuration, reasoning-effort narrowing and inheritance, `modelOverrides` that reshape one model while the rest keeps serving, compat switches applied per field and refused when no model on the route could take them, resolution snapshots (an in-flight request finishes under the configuration it started with), and the configurable-provider directory replacing its entries atomically.

### packages/llm/llm-pi-ai/tests/adapter.spec.ts
Adapter behaviour (1121 lines, 46 cases): provider routing and a private endpoint, prepared model metadata and dispatch bound to one profile snapshot, profile headers merged with the harness attribution winning, an unsupported effort refused before network I/O, exactly one SDK attempt for an SDK-retryable failure, the idle watchdog expiring the request, and the abort-wiring block (a pre-aborted signal, an abort during streaming, and a consumer stopping early).

### packages/llm/llm-pi-ai/tests/convert.spec.ts
Conversion and translation tests (1023 lines): `toPiContext` mapping the system prompt, user text and tools; image handle text; and `toStreamChunks` producing the harness chunk sequence from pi-ai events.

### packages/llm/llm-pi-ai/tests/context.spec.ts
Context-conversion tests (28 cases): request-only input after durable tool history, tool-result images with explicit fallbacks, the shared normalized-path description for a retained image, offloaded occurrences projected to placeholders, the exact base64 payload bound, and the system-prompt source rules (a leading system message mapped to `systemPrompt`, later updates preserved in history order, repeated updates kept distinct).

### packages/llm/llm-pi-ai/tests/discovery.spec.ts
Discovery tests: the installed registry answering with no network call and with the capacities a listing endpoint would not disclose; a route the catalog does not describe requiring a baseURL; and the OpenAI-compatible listing parser accepting `data` arrays and the enriched `models` map some gateways expose, keeping the capacities each spelling discloses.

### packages/llm/llm-pi-ai/tests/conversation-updates.spec.ts
Capability-driven transcript updates through the real pi-ai serializers: the `systemPromptUpdate`/`toolUpdate` mapping per protocol, developer-role tool additions and removals, and the fallback to current declarations when the request prefix omits the recorded updates (so a truncated prefix never sends a broken declaration series).

### packages/llm/llm-pi-ai/tests/native-auth.spec.ts
Provider-metadata tests: the generated table equals the installed catalog, `--check --cached` detects a stale staged snapshot without touching either file, the probe finds credential pairs `findEnvKeys` misses, and `providerDefaultsOf` returns metadata **without executing authentication**.

### packages/llm/llm-pi-ai/tests/auth.spec.ts
Credential-store tests: an api-key credential round-trips field by field, a grant is stored verbatim with its refresh fields, the JSON image drops explicitly-undefined members but a genuinely unstorable value still fails loud at the store, a mutation that declines leaves the credential alone, only this adapter family's records are listed, and the ambient `env` answer prefers the seam over every launch layer.

### packages/llm/llm-pi-ai/tests/login.spec.ts
Login-flow tests: one flow per installed provider carrying the methods that provider ships, the pi-ai auth type chosen by the selected method, every pi-ai event restated in the neutral vocabulary (including an unrecognised event member, which still shows the human that something is happening), every prompt restated with its withdrawal signal, and the attempt-wide cancellation signal handed to the flow.

### packages/llm/llm-pi-ai/tests/dynamic-config.spec.ts
Live-configuration tests: a sign-in offered for a provider no route names (signing in is what makes a route worth adding), a headless composition mounting without the authorization seam, and stored catalog failures staying editable while changed providers are validated before they are written.

### packages/llm/llm-pi-ai/tests/protocol-roundtrip.spec.ts
Cross-protocol safety: a request to one provider must not overwrite the history its original provider needs — the foreign assistant message keeps its durable content, its encrypted reasoning never travels to the target route, and the original provider's next request still sees its own prefix.

### packages/llm/llm-pi-ai/tests/provider-apis.e2e.ts
Key-gated real-API e2e against `openai-responses` and `anthropic-messages` (with an Azure `api-key` header variant), an attachment-store fixture for the image case, and a replay envelope inspected after the round trip.

### packages/llm/llm-pi-ai/tests/loader-composition.spec.ts
Real-Loader composition: a dormant `llm-pi-ai` row with no config at all that activates when the settings supply routes, profile patch edits and credential updates reaching the next request, and a tool call truncated by the output-token ceiling left uncommitted.

### packages/llm/llm-pi-ai/tests/tool-argument-streaming.spec.ts
Streamed tool arguments across all three protocols: every provider parses arguments **once, at the end of the call** (the partials stay `{}` while the deltas arrive), and an empty Responses message after parallel tool calls keeps its replay metadata.

### packages/llm/llm-pi-ai/tests/adapter.e2e.ts
Key-gated real-API e2e for the pi-ai adapter: V4 Flash with the provider-default reasoning, `off`/`high`/`max` efforts, and a replayed tool follow-up mirroring the native adapter's chunk contract.

### packages/llm/llm-pi-ai/tests/sdk-options.spec.ts
The SDK boundary: the lazy `openai-completions` api module is mocked to assert exactly **one** SDK attempt (`maxRetries: 0`) carrying the resolved `apiKey`, and that a hand-declared route dispatches to the endpoint and model its configuration describes. A pi-ai setup failure arrives as a terminal in-stream error, which the converter turns into the harness error finish.

### packages/llm/llm-pi-ai/tests/compat-upgrade.spec.ts
The compat-surface contract: every thinking-budget field preserved, invalid values rejected, catalog-owned switches withheld with "which is not configurable here", and a valueless compat key refused rather than written as `null` over the catalog.

### packages/llm/llm-pi-ai/tests/config.spec.ts
The schema boundary: an unknown reasoning level or modality rejected at either level, `false` kept distinguishable from an absent declaration, an empty `defaultInput` refused by the namespace validator (the schema alone would report the route as writable), and the request-image policy bounds.

### packages/llm/llm-pi-ai/tests/catalog-provider-ids.spec.ts
The three provider postures the configurable-provider directory distinguishes, mocked at the pi-ai boundary: a provider shipping only non-chat models is dropped, one shipping no model of any type is kept.

### packages/llm/llm-pi-ai/tests/egress.spec.ts
Egress: both the discovery request and the provider inference request are observed through an environment-installed HTTP proxy.

### packages/llm/llm-pi-ai/tests/mock-server.ts
The local provider stand-in: scripted events as bare `data:` lines or named Anthropic frames, zstd-compressed Codex request bodies decompressed, a `holdOpen` mode that keeps the response open until the client disconnects, and a `closedResponses` counter for the abort tests.

### packages/llm/llm-pi-ai/tests/auth-double.ts
The auth double for tests that exercise streaming rather than authentication: an in-process credential store over a `Map` and an ambient context that finds nothing.

### packages/llm/llm-pi-ai/tests/assemble.ts
The test helper driving `ctx.llm.stream()` through a `BlockAssembler`, defaulting the provider to `deepseek`.

### packages/llm/llm-pi-ai/tests/fixtures/model-listings/openrouter-2026-09-02.json
An OpenRouter listing fixture: per-entry `architecture`, `pricing`, `supported_parameters`, and a `top_provider` block carrying the per-route `context_length` and `max_completion_tokens` that the discovery parser must read.

### packages/llm/llm-pi-ai/tests/fixtures/model-listings/models-dev-anthropic-2026-09-02.json
A models.dev-style Anthropic provider record: `env`, `npm`, `name`, `doc` and per-model `reasoning_options` (the selectable effort values), `tool_call`, `structured_output` and `modalities` — the shape a capability directory publishes.

### packages/llm/llm-pi-ai/tests/fixtures/model-listings/anthropic-reference-example.json
An Anthropic-style listing fixture with a `capabilities` object (effort levels, `image_input`, `thinking` types, `context_management` sub-flags) and `first_id`/`last_id`/`has_more` pagination.

### packages/llm/llm-pi-ai/tests/fixtures/model-listings/deepseek-2026-09-02.json
A three-entry DeepSeek model listing fixture used as the endpoint answer in the discovery tests.

### packages/llm/llm-pi-ai/tests/fixtures/qr-code.png
A 30,477-byte binary PNG used as the real image attachment in the e2e suite. Its 16-byte header (`89 50 4E 47 0D 0A 1A 0A … IHDR`) confirms it is an image asset, not source; it was not read line by line.

### packages/llm/llm-pi-ai/README.md
The pi-ai adapter's contract: the `providers` dictionary is the whole configuration surface; a route naming a catalog provider inherits that provider's defaults; a hand-declared gateway declares everything; `apiKeyEnv` is a credential *reference* resolved per request; sign-in uses stored OAuth or an interactive key; and the "KV Cache effect" section spells out that conversion preserves logical order while image handles and offload placeholders add model-visible text, and that an offload decision ends reuse at that message but never reverts.

### packages/llm/llm-pi-ai/README.zh.md
Chinese translation of the pi-ai README; read the summary and the first usage section (lines 1–30).

### packages/llm/llm-pi-ai/package.json
Manifest for `@deepseek-ai/dsh-llm-pi-ai` v0.2.1-rc.2: dependency `@earendil-works/pi-ai ^1.1.0`; peers on `dsh-llm`, `dsh-credentials`, `dsh-authorization`, `dsh-attachment`, `dsh-launch-environment` and `dsh-timeout`.

### packages/llm/llm-pi-ai/tsconfig.json
TypeScript project with 15 references (util/launch-environment, util/brand, util/values, credentials, authorization, attachment, fs, settings, util/http-proxy, the loader, cosmokit, cordis, schemastery).

### packages/llm/llm-pi-ai/README.i18n.yaml
Per-section EN/ZH content digests for the pi-ai README.

### packages/llm/llm-pi-ai/locale/en.json
English locale stub: `meta.title` "llm-pi-ai" only.

### packages/llm/llm-pi-ai/locale/zh.json
Chinese locale entry: title "pi-ai 模型适配" plus a description naming it the design-verification twin of `dsh-llm-deepseek`.

### packages/llm/llm-retry/src/index.ts
- **Purpose:** the retry executor: provider-routed request recovery on the agent loop's `agent/request-error` extension point.
- **Key abstractions:** `localDelay()`; `retryPolicyKey()`; `retryStateKey()`; `cancellableDelay()`; `settleDownstream()`; `RetryInternals` (a `random` seam for deterministic tests).
- **Data flow:** the failing request's provider selects a policy (captured at registration); the failure code is checked against the eligible set; the delay is the provider's `Retry-After` when it fits the policy bounds, otherwise local exponential backoff with symmetric jitter; a durable `llm/retry` event is appended **before** the wait, then `llm/retry-started` immediately before the next attempt; the wait is cancellable and the loop re-runs the failed step inside the same open turn.
- **Non-obvious design decisions:** the retry is *durable before it is cancellable* — a crash during the backoff leaves a log that says a retry was scheduled (`index.ts:243-258`); a callback captured by a waterfall before its registration was removed fails closed after disposal (`index.ts:250`).
- **Edge cases / failure handling:** disposal aborts the backoff and drains the active delegated recovery before completing; a failure before any final adapter has no provider policy and delegates unchanged; an over-cap provider `Retry-After` is delegated rather than absorbed.
- **Surprising:** the retry state is keyed by `(provider, policyKey)`, so a finite retry budget is scoped to the *failed provider* — one provider exhausting its budget does not consume another's.

### packages/llm/llm-retry/src/types.ts
The durable event payloads: `LlmRetryEventData` (two variants — normal carries `maxRetries`, always does not) and `LlmRetryStartedEventData`, both declared into the session's `SessionEventMap` so they are persisted but are not surface.

### packages/llm/llm-retry/src/brand.ts
The branded `RetryId` and its constructor: the identity shared by every attempt in one request-step retry chain.

### packages/llm/llm-retry/tests/retry.spec.ts
The largest retry suite (28 cases): the scheduled delay recorded before the request is retried; an `EMPTY_RESPONSE` error finish retried under the default codes; partial failed chunks left on their step without committing a message or a tool side effect; bounded exponential jitter and the budget; a bounded provider `Retry-After` honoured verbatim and an over-cap one delegated; policy selection by the failed request's provider; finite budgets scoped per provider; always mode unbounded with cancellable jittered backoff; failed error text and partial output kept out of every retried model context; and the disposal / turn-cancellation drains.

### packages/llm/llm-retry/tests/transport-recovery.spec.ts
Wire-level recovery: a genuinely refused connection recovers once the endpoint starts during the backoff (the mock server is started *from* the `llm/retry` event), and a `stream_disconnect` or `partial_disconnect` retries without committing the failed chunks; the same step number appears once, so the retry is inside the same open turn.

### packages/llm/llm-retry/tests/loader-composition.spec.ts
A real-Loader composition where a provider supplies its own `retryPolicy`: the transient `SERVER` failure is recovered inside the shipping agent loop, one `llm/retry` event is recorded, and the assistant message carries the recovered text.

### packages/llm/llm-retry/tests/persistence.spec.ts
JSONL persistence: the `llm/retry` event round-trips losslessly through the session persistence backend and contributes **no** model message (the derived messages stay empty).

### packages/llm/llm-retry/README.md
The retry executor's contract: normal mode (five retries over `EMPTY_RESPONSE`, `RATE_LIMIT`, `SERVER`, `TIMEOUT`, `TRANSPORT`, 500 ms → 10 s, 10 % jitter) and always mode; the scheduled attempt reaching the session log before the backoff; a valid `Retry-After` replacing local backoff when it fits the policy bounds; the retried step re-running inside the same open turn over the same durable history; and the explicit statement that a direct `ctx.llm.stream()` call stays **single-attempt**, because a raw stream cannot separate already-emitted chunks durably.

### packages/llm/llm-retry/README.zh.md
Chinese translation of the retry README; read the summary section (lines 1–15).

### packages/llm/llm-retry/package.json
Manifest for `@deepseek-ai/dsh-llm-retry` v0.2.1-rc.2: peers on `dsh-agent`, `dsh-llm`, `dsh-session`, `dsh-timeout`, `dsh-brand` and `dsh-session-projection`; dependency zod 4.4.3.

### packages/llm/llm-retry/tsconfig.json
TypeScript project referencing util/brand, llm, core/session, core/agent, util/timeout and the three vendored packages.

### packages/llm/llm-retry/tsdown.config.ts
The tsdown build: bundles `lib/types/index.js` into `lib` as ESM for node, target es2024, declarations and cleaning disabled.

### packages/llm/llm-retry/locale/en.json
English locale stub: `meta.title` "llm-retry" only.

### packages/llm/llm-retry/locale/zh.json
Chinese locale entry: title "模型请求重试" plus a one-line description.

### packages/llm/llm-retry/README.i18n.yaml
Per-section EN/ZH content digests for the retry README.

### packages/llm/llm/src/index.ts
- **Purpose:** the provider-neutral LLM service: the adapter registry, the configurable-provider directory, model discovery, call preparation and the streaming boundary.
- **Key abstractions:** `LlmRuntime` (a `TypertRemoteService`); `LlmAdapter` (the abstract provider contract); `AdapterRegistrationHandle` / `DirectoryRegistrationHandle`; `PreparedLlmCall`; the `llm/stream` waterfall; `llm/adapters-updated` emit.
- **Data flow:** `ctx.llm.stream(options)` runs the `llm/stream` waterfall; the final `adapterStream` resolves the model, materializes the adapter's defaults, projects files to handle text and images to placeholders for a text-only route, applies the tool-update projection, then dispatches. `prepareCall(config, signal, configure?)` binds the resolved config, the model metadata and the dispatch to **one** adapter generation and returns a one-shot stream entry point.
- **Non-obvious design decisions:** a loop-built request arrives **deep-frozen** — listeners read it, never rewrite it — because the model-visible input must be reconstructable from the session log (`index.ts:62-77`). Registry mutations validate the whole candidate set before anything moves, so a refused change leaves the previous state serving (`index.ts:505-525`, `index.ts:437-458`). Replay state is stripped when the historical route is owned by a *different adapter instance* (`forAdapter`, `index.ts:1023-1037`).
- **Edge cases / failure handling:** every adapter throw becomes exactly one terminal `{kind:'error'|'aborted', failure}` chunk, while middleware, nested-call and consumer failures stay thrown (`index.ts:1064-1153`); a prepared call may be dispatched exactly once and its config must not have drifted; an unregistered provider is `NO_ADAPTER`; a malformed adapter result is rejected by `normalizeModelInfo` with a specific code.
- **Surprising:** `emitAdaptersUpdated` contains each listener individually, including an async listener's rejection — one broken observer can neither veto the registry mutation nor starve the later listeners.

### packages/llm/llm/src/types.ts
- **Purpose:** the canonical provider-neutral vocabulary.
- **Key abstractions:** `ContentBlockMap` (declaration-mergeable), `FinishReasonMap`, `TokenUsage`, `LlmImageRequestPrice` / `LlmImageRequestPricing`, `LlmConfigurableProvider`, `LlmResolvedModelInfo`, `ReplayEnvelope`, `StreamChunk`, `ToolSchema`, `GenerateOptions`, `ToolHistory`.
- **Data flow:** adapters translate their wire into `StreamChunk`s; the loop and the session log speak only these types.
- **Non-obvious design decisions:** the usage buckets are **disjoint** — `inputTokens` is uncached input only, cached input is reported separately, and adapters whose provider folds cache hits into a total prompt count subtract them out (`types.ts:167-189`). `SystemPromptUpdate` and `ToolUpdate` are model-declared capabilities, not harness guesses: a route that declares `'in-history'` lets the loop append a changed prompt after the cached history instead of rewriting message 0.
- **Edge cases / failure handling:** `GenerateOptions.purpose` marks an auxiliary call (`compaction` / `session-title`) so an adapter can map it to model-hidden transport metadata; `sessionId` is a locally-declared brand because importing dsh-session would create a dependency cycle.
- **Surprising:** `LlmConfigurableProvider.declared` exists because a stored profile is how a *user-added* route and a *corrected shipped* one look identical from outside — only the adapter can tell them apart.

### packages/llm/llm/src/content.ts
- **Purpose:** the shared file and image projection, and the tool-update projection.
- **Key abstractions:** `fileHandleText()`; `requestImageHandleText()`; `offloadedImageText()`; `textOnlyImageText()`; `projectFilesToText()`; `projectImagesForTextModel()`; `projectOffloadedImages()`; `requiredImageOffload()`; `projectToolUpdates()`; `resolveImageAttachmentAccess()`.
- **Data flow:** `projectFilesToText` replaces every `FileBlock` with one deterministic handle line; `projectOffloadedImages` replaces the surface's offloaded occurrences; `projectImagesForTextModel` replaces images for a text-only route; `projectToolUpdates` reconstructs the declaration set from the folded history and selects what the route receives.
- **Non-obvious design decisions:** **files never reach a provider natively** — the projection is unconditional, unlike images, which are route-dependent (`content.ts:180-183`). The file handle names the file, its byte size, its digest and the read-only saved path, and tells the model to copy it before modifying it and to include the path in a delegation prompt. `requiredImageOffload` counts in whole quanta so every route names the same count the same way.
- **Edge cases / failure handling:** a durable file reference the current environment cannot resolve degrades to an explicit "do not claim to have read it" message rather than a silent omission; a malformed durable reference degrades to the no-path handle instead of failing every later request.
- **Surprising:** the tool-update projection falls back to the *current* declarations whenever the request prefix omits a recorded update — a truncated prefix must never send a broken declaration series (`content.ts:439-447`).

### packages/llm/llm/src/assistant-stream.ts
- **Purpose:** the lossless compact representation of one model-stream attempt.
- **Key abstractions:** `AssistantStreamRecord` (packed `text-chunks` / `reasoning-chunks` / `tool-call-chunks` runs plus raw `chunk` records); `AssistantStreamAccumulator`; `expandAssistantStream()`; the record-level readers (`assistantStreamFirstTokenTime`, `assistantStreamHasVisibleContent`, `assistantStreamHasVisibleText`, `lastAssistantStreamChunk`, `assistantStreamChunks`, `joinAssistantStreamText`).
- **Data flow:** the accumulator packs consecutive deltas of the same kind/index into a run with a `time0` and per-member `dt` gaps; `snapshot()` returns a detached frozen list; `expandAssistantStream` reconstructs the exact timed chunk sequence.
- **Non-obvious design decisions:** the readers answer their questions from the compact records with an **early exit**, because a retained expansion costs roughly ten times the compact stream for as long as the event lives (`assistant-stream.ts` doc; `README.md:89`). The compaction is validated against the original: `expandAssistantStream(snapshot())` must equal the input chunks.
- **Edge cases / failure handling:** a non-safe-integer timestamp, a negative or `-0` index, a chunk that is not losslessly JSON-serializable and a non-integer time gap are all `TypeError`s — the durable boundary is where a malformed record must fail.
- **Surprising:** a tool-call run with a `name` starts at its first member for first-token timing even though its arguments are empty.

### packages/llm/llm/src/assembler.ts
- **Purpose:** the single canonical chunk-to-message assembly algorithm.
- **Key abstractions:** `BlockAssembler`; the internal `PartialBlock` (text, tool id/name, raw arguments, and the authoritative block from `block-end`).
- **Data flow:** `push(chunk)` folds each chunk into a per-index partial; `blocks()` returns the assembled blocks in first-seen order; `message(source)` wraps them in a frozen assistant message; `usage`, `finish` and `replayState` expose the terminal facts.
- **Non-obvious design decisions:** the **first** `block-end` wins and later deltas for a closed index are ignored, so a misbehaving adapter cannot grow memory or corrupt a completed block (`assembler.ts:65`, `assembler.ts:81`); the assembler tolerates delta-only protocols with no `block-start`/`block-end` at all.
- **Edge cases / failure handling:** a plugin-added block type whose stream is never closed by `block-end` makes `blocks()` throw ("cannot assemble incomplete block of type …"); an unknown chunk type hits `assertNever`.
- **Surprising:** the replay envelope's per-block entries are pruned **in step with** the emitted blocks, so a dropped block drops its metadata too.

### packages/llm/llm/src/error.ts
The error taxonomy: `HarnessError` (a stable machine-routable `code` plus a chained `cause`), the canonical provider-neutral codes (`CONTEXT_WINDOW_EXCEEDED`, `QUOTA`, `ACCOUNT_QUOTA`, `EMPTY_RESPONSE`, `INVALID_CREDENTIAL`, `IMAGE_OFFLOAD_REQUIRED`), and the two regex classifiers that recognise context-overflow and quota wording. `INVALID_CREDENTIAL` is deliberately **outside** the default retryable set, because a malformed credential fails identically on every attempt.

### packages/llm/llm/src/call-config.ts
The call-config vocabulary: `LlmCallControls`, `LlmCallConfig`, the pure `ConfigureCall` callback, `callConfigEquals` (field-wise, element-wise on `stop`) as the real-change detector behind the logged changed headers, and the `WeakSet` that marks the exact request object the agent loop built.

### packages/llm/llm/src/adapter-failure.ts
Failure normalization into terminal chunks: `normalizeLlmFailure` detaches serializable provider facts from a thrown value, reading only **own data descriptors** so a hostile SDK accessor cannot replace the failure, and trusting a carried snapshot only when the carried code and the error's own code agree. Only Harness-owned codes are trusted; a third-party SDK code becomes `UNKNOWN`.

### packages/llm/llm/src/api-key.ts
The one definition of a well-formed provider key: printable ASCII (`\x21-\x7E`), space excluded, Latin-1 excluded on purpose — a key outside this set cannot reach any provider because `fetch` refuses to build the header, so the check is a transport invariant rather than one provider's policy. Whitespace is trimmed silently (a padded key has one unambiguous reading); every other defect is reported.

### packages/llm/llm/src/attribution.ts
The central attribution vocabulary: `APP_IDENTITY` reads its version from the package manifest so the `User-Agent` cannot drift from what is published; `userAgent()` renders the RFC 9110 product + comment form; `attributionHeaders()` returns **only** `user-agent`, and omission of a custom identity falls back to the default — nothing can suppress attribution entirely.

### packages/llm/llm/src/brand.ts
The branded identifiers dsh-llm owns: `MessageId`, `ToolCallId`, `ProviderRequestId`, `LlmAttemptId` and `ReasoningEffortId`, each with a nominal constructor over the shared `brandString` primitive.

### packages/llm/llm/src/message.ts
The message value types: immutable constructors that detach and deep-freeze their input, the semantic `ContextForm` vocabulary (instructions / catalog / snapshot / notice / relay / recall — deliberately *not* visual), the 120-character `notice` summary bound, and the merge-extensible `MessageSourceMap`.

### packages/llm/llm/src/retry-policy.ts
Provider-owned retry policy: `normal` (bounded, with an explicit eligible code set) and `always` (unbounded), the shipped defaults (5 retries, 500 ms → 10 s, 10 % jitter, five retryable codes), strict unknown-key rejection with the owning path in the message, and a frozen, detached result.

### packages/llm/llm/tests/service.spec.ts
The service suite (60 cases): routing to the registered adapter, the file projection through every host-path availability outcome, the retry policy captured at registration, an unregistered provider becoming a terminal failure, structured `LlmError` facts preserved in the terminal chunk, middleware and consumer failures staying thrown, adapter cleanup awaited on a downstream close, model-context and reasoning metadata detached, unsupported efforts rejected without clamping, the prepared call bound to one adapter generation and refusing config drift, replay state stripped across adapters, and the registry's atomicity.

### packages/llm/llm/tests/topology.spec.ts
Topology tests: `llm/adapters-updated` fires at both adapter-registration commit points with the registry already readable; a throwing listener cannot veto the registration or starve the later listeners; an async listener's rejection is contained rather than becoming an unhandled rejection; and a route replacement publishes one event and never exposes an empty registry between the two.

### packages/llm/llm/tests/assistant-stream.spec.ts
Accumulator tests: delta boundaries and timestamps preserved through compaction, `expandAssistantStream` reproducing the exact input chunk sequence, snapshots detached from later pushes, and the record-level readers answering without expanding.

### packages/llm/llm/tests/content.spec.ts
Content-projection tests: `requiredImageOffload` visiting image occurrences in message order across user and tool messages, the offloaded and text-only projections keeping request-only inputs identity-free, and `projectToolUpdates` selecting the per-route declaration series.

### packages/llm/llm/tests/assembler.spec.ts
Assembler tests: interleaved reasoning/text/tool deltas assembled in order, delta-only tolerance, the completed block taken from `block-end`, the unhandled `blockType` failure and the invariant-violation throw.

### packages/llm/llm/tests/adapter-failure.spec.ts
Failure-normalization tests: a hostile `Symbol.toPrimitive`, accessor-backed `code`/`failure` properties, a `Proxy` that throws from `getOwnPropertyDescriptor`, and a throwing `message` accessor all degrade to `{message:'LLM adapter failed', code:'UNKNOWN'}` rather than escaping.

### packages/llm/llm/tests/api-key.spec.ts
API-key tests: printable ASCII accepted, whitespace trimmed, emoji/CJK/full-width punctuation/interior space/C0 control/Latin-1 rejected as illegal characters, the printable boundary (`!~`) accepted, and `assertUsableApiKey` refusing a blank or malformed credential with a message that names the reference and **never echoes the key**.

### packages/llm/llm/tests/attribution.spec.ts
Attribution tests: the version equals the package manifest's, `APP_IDENTITY` carries only public product facts, and the header is exactly `user-agent` in the RFC 9110 product + comment form (with a white-label override).

### packages/llm/llm/tests/call-config.spec.ts
Call-config tests: field-wise equality including the element-wise `stop` comparison, and `deepFreeze` behaviour — nested structures freeze in place, an `AbortSignal` is never frozen (the live cancellation channel keeps working), primitives pass through, cycles terminate, and 5000-deep nesting is handled without a stack overflow.

### packages/llm/llm/tests/message.spec.ts
Message-construction tests: a detached deep-frozen message with an identity minted at creation, the notice-summary bound, system-prompt attribution preserved, the assistant role and `kind:'model'` fixed at creation, and the tool-result content coupled to its cited call id.

### packages/llm/llm/tests/properties.spec.ts
Property-based (fast-check) tests for the assembler over arbitrary chunk interleavings — valid and malformed: the block count never exceeds the number of distinct indices, re-assembly is idempotent, `blocks()` never throws and yields only known block tags, and the finish reason is the last one seen (defaulting to `stop`).

### packages/llm/llm/tests/retry-policy.spec.ts
Retry-policy tests: the immutable defaults, a detached configured policy, `always` mode ignoring normal-only fields, and a rejection table covering the bounds, duplicates, empty code strings, unknown keys and a bad mode.

### packages/llm/llm/README.md
The service's contract and invariants: model-visible ⟺ logged, replay state travels only within one adapter, prepared calls are one-shot, image projection follows the captured route, file projection is unconditional, protocol ordering (`usage` before `finish`, nothing after the terminal `finish`), and registry mutations are atomic. It also states plainly that this service ships **no** retry execution, caching or rate limiting — a stream remains a single provider attempt.

### packages/llm/llm/README.zh.md
Chinese translation of the LLM service README; read the summary section (lines 1–15).

### packages/llm/llm/package.json
Manifest for `@deepseek-ai/dsh-llm` v0.2.1-rc.2: exports `.`, `./types`, `./brand`, `./message`, `./assistant-stream`, `./typert`, `./remote` and `./src/*`; dependency zod 4.4.3 plus dsh-typert-protocol, dsh-brand, dsh-util-values, dsh-util-crypto and dsh-timeout.

### packages/llm/llm/tsconfig.json
TypeScript project referencing util/brand, attachment, util/timeout, util/crypto, util/values, typert/protocol and the three vendored packages.

### packages/llm/llm/locale/en.json
English locale stub: `meta.title` "llm" only.

### packages/llm/llm/locale/zh.json
Chinese locale entry: title "模型调用服务" plus a one-line description.

### packages/llm/llm/README.i18n.yaml
Per-section EN/ZH content digests for the LLM service README.

### packages/llm/token-meter/src/index.ts
- **Purpose:** the replay-aware token meter: current request pressure and surface, measured from the durable session log.
- **Key abstractions:** `TokenMeter` (a Cordis `Service` on `ctx.tokenMeter`); `MeasurementAnchor`; `ReplayState`; `priceSurface`.
- **Data flow:** `measure(session, requestHeader?)` synchronises the session's replay state to the current durable tail (folding `request/header`, `step/start`/`step/end`, surface events and `assistant/message`), prices the surface under the routed image pricing and the exact file handle text, and returns a detached deeply immutable snapshot.
- **Non-obvious design decisions:** provider usage is reused **only** when the latest successful call's canonical envelope matches the measured envelope *and* the provider total is not below that call's full route-priced anchor; otherwise the complete envelope and surface are repriced (`index.ts:158-181`). The anchor includes the priced surface immediately before the assistant message — including inputs admitted after `step/start` — so a completed call has zero surface delta.
- **Edge cases / failure handling:** every fallible step runs before any mutation, so a malformed event stays unread and fails identically on every retry (`_foldEvent`, `index.ts:247-329`); a `step/end` without a matching `step/start` and an `assistant/message` outside a step are errors.
- **Surprising:** the anchor's provider output is reassembled from the message's **exact embedded stream**, independently of listener rewrites to the durable content.

### packages/llm/token-meter/src/surface-projection.ts
- **Purpose:** the O(1) surface-token fold used by the projection units.
- **Key abstractions:** `ShadowPriceClaim` (`start`, `end`, `tokens`); `SurfaceTokensFold`; `foldSurfaceProjection()`.
- **Data flow:** a `compaction/summary` or `compaction/prune` event arms a claim naming the range and its heuristic price; the immediately following surface `replace` consumes it and applies `tokens - claim.tokens` as the delta; any other event expires the claim.
- **Non-obvious design decisions:** the shadow price is **adjacent by contract** — the producer appends the metering event and the replacement synchronously together, so a surviving claim always prices the very next event (`surface-projection.ts:47-56`). This is what lets the projection keep a running total plus at most one pending claim and never retain per-node prices.
- **Edge cases / failure handling:** a replace with **no** claim folds with a zero delta (bounded state cannot reconstruct the replaced range — historical replay degrades to drift rather than failing); a replace whose range differs from an armed claim **throws**, because the adjacency proves a live producer violated the contract.
- **Surprising:** the same protocol is what lets a compaction shrink the occupancy figure the moment it happens — `pressureTokens` alone cannot see a compaction, because compaction reports no usage of its own.

### packages/llm/token-meter/src/breakdown-projection.ts
- **Purpose:** the `contextBreakdown` projection — the heuristic composition (system / tools / messages) of the current retained surface.
- **Key abstractions:** `contextBreakdownProjectionDefinition` (state version 6); `ContextBreakdownState` (`systems`, `surfaceTokens`, `claim`, `breakdown`); `placeSurfaceEvent()`.
- **Data flow:** appends add their price; a metered replacement subtracts the adjacent shadow-price claim (whose `shadowedSeqs` also name the system prompts it removes); a system-prompt rewrite subtracts the retained price of the system node it replaces; the tools price follows the latest `request/header`.
- **Non-obvious design decisions:** the state keeps only the **surviving system prompts** plus one running total, so its size follows the number of system prompts, not the number of messages (`breakdown-projection.ts:141-148`). The last nonempty surviving system prompt is the `systemTokens` figure; every other visible node (including superseded prompts) is `messageTokens`.
- **Edge cases / failure handling:** a metered replacement that puts a *system* message in place of a metered range is refused, because its order among the surviving system prompts would be unknown; an unmetered replacement of a non-system range folds at zero delta.
- **Surprising:** the `breakdown` object is kept by identity when its figures do not change, so a projection consumer is not woken for a no-op.

### packages/llm/token-meter/src/usage-projection.ts
- **Purpose:** the `tokenUsage` and `contextPressure` projection units.
- **Key abstractions:** `tokenUsageProjectionDefinition` (state version 2); `contextPressureProjectionDefinition` (state version 5); `usageOf()`; `pressureFrom()`.
- **Data flow:** each assistant settlement contributes the **last** usage sample embedded in its stream; the final assistant message replaces the streaming usage of the same attempt; `llm/retry-started` closes that replacement scope so a retried attempt bills again. `contextPressure` rides `foldSurfaceProjection` for its running surface total and publishes `projectedTokens` = the sample plus the surface's movement since it was taken.
- **Non-obvious design decisions:** `contextPressure` keeps **independent last-wins slots** — the numerator comes from the newest usage sample and the denominator from the newest `request/context` record — and the projection type says so explicitly: the pair is *not* one atomic request observation, a deliberate trade for a user-facing reference (`projection.ts:19-29`).
- **Edge cases / failure handling:** a usage sample is stamped **before** the same event joins the surface, so an `assistant/message` anchors against the surface its own request saw; a `request/context` with no window removes the field rather than storing a zero.
- **Surprising:** `pressureTokens` is prompt-side only, so it holds still while a turn streams and steps forward once the next request reports its usage.

### packages/llm/token-meter/src/surface-fold.ts
- **Purpose:** the positional surface fold shared with `measure()`.
- **Key abstractions:** `MeterSurfaceNode` (heuristic price, image/file structural prices, the durable occurrences); `SurfaceTokenPlan`; `planSurfaceTokens()`; `commitSurfaceTokens()`.
- **Data flow:** each surface event's derived message is priced and placed — an append adds a node, a replace splices the replaced range out — and the plan carries the signed delta.
- **Non-obvious design decisions:** the fold is a **plan/commit pair**: `planSurfaceTokens` runs every fallible step read-only and `commitSurfaceTokens` mutates in place, so a throw leaves the caller's state untouched and the same malformed event fails identically on every retry (`surface-fold.ts:5-10`).
- **Edge cases / failure handling:** a replace naming a range absent from the nodes is log corruption and fails loud rather than skipping the event.
- **Surprising:** every node also carries the durable image and file occurrences, so `measure()` can price the *request representation* that the model actually receives, not the durable form.

### packages/llm/token-meter/src/route-pricing.ts
`priceSurface`: the surface's structural image and file prices are replaced by the route's real request representation — the provider's visual tokens plus the model-visible handle text for a retained image, the placeholder text for an offloaded one, and the exact file handle text for a file. If the pricing answers a different occurrence count than it was asked, the function **throws**: a silent misalignment would misprice every node after it.

### packages/llm/token-meter/src/estimate.ts
The fixed heuristic shared by the meter and the pure breakdown projection: four characters per token plus a per-block structural overhead and a per-message role overhead. An image block is priced *structurally* (its request price is route-owned, not fixed) and the offload mark is excluded so an offload decision does not change the reference heuristic; a system message is priced as rendered text because adapters serialize the prompt as a plain string; the tool schemas are priced from the request envelope, the envelope's only priced field.

### packages/llm/token-meter/src/turn-usage.ts
- **Purpose:** `deriveTurnTokenUsage` — exact per-attempt and whole-turn token accounting for browser consumers.
- **Key abstractions:** `TurnTokenUsage`; `TurnTokenUsageRoute`; `AttemptState` (`idle` | `open` | `finishClosed` | `settled`); `normalizeUsage()`; `aggregateAttempts()`.
- **Data flow:** the fold walks the turn's durable events (`turn/start`, `step/start`, `assistant/attempt`, `assistant/message`, `llm/retry`, `llm/retry-started`, `step/end`, `turn/end`), closing an attempt when its usage is complete and re-opening it on a retry, then aggregating the normalized attempts.
- **Non-obvious design decisions:** **no attempt is inferred from a usage sample** — a missing lifecycle boundary, an incomplete usage, an unsafe count or a contradictory exact total makes the whole disclosure unavailable rather than an approximation (`turn-usage.ts:170-177`). Each optional aggregate (cache read/write, reasoning, routes) appears only when *every* attempt reported it.
- **Edge cases / failure handling:** a `totalTokens` below the known prompt is rejected; a total that disagrees with the known prompt when both cache buckets are present is rejected; reasoning above the output count is rejected; a route attribution missing on any attempt drops the routes list entirely.
- **Surprising:** a retry is a **separate billed attempt** — the `llm/retry` event closes the attempt and `llm/retry-started` re-opens it, so a retried step contributes twice.

### packages/llm/token-meter/src/projection.ts
The client-safe projection vocabulary: `TokenUsageProjection` (four disjoint buckets, with the explicit note that reasoning is already inside `outputTokens`), `ContextPressureProjection` (documented as *not* an atomic request observation) and `ContextBreakdownProjection` (documented as a heuristic composition that will not sum to `projectedTokens`), declared into the session projection map.

### packages/llm/token-meter/src/types.ts
The public measurement vocabulary: `TokenMeasurement` (`logRevision`, `baseline`, `surfaceDeltaTokens`, `totalTokens`, `surfaceTokens`, `nodes`), the three baseline kinds (`none` / `estimated` / `usage`), and `TokenSurfaceNode` carrying **both** the route price and the route-independent `heuristicTokens` that the shadow-price protocol prices replacements with.

### packages/llm/token-meter/src/client.ts
The browser-safe client surface: it re-exports the projection types and `deriveTurnTokenUsage` so a web client can read the same contracts without importing the service.

### packages/llm/token-meter/tests/token-meter.spec.ts
The meter suite: measuring a replayed session, the usage-anchor rules (a matching envelope reusing the provider total, a mismatched one repricing everything), a system node replaced in place the way the loop does it, and defensive replay over malformed persisted history injected past the live append boundary.

### packages/llm/token-meter/tests/token-usage-projection.spec.ts
Projection tests: the cumulative usage buckets over a durable log, the final assistant-message sample replacing the streaming usage of the same attempt, `llm/retry-started` letting a retry bill again, and `contextPressure`'s independent last-wins slots (a fresh capacity paired with the previous route's pressure is the documented trade).

### packages/llm/token-meter/tests/context-breakdown-projection.spec.ts
The `contextBreakdown` tests: the system/tools/message composition, the surviving-system classification, a metered compaction replacement subtracting its shadow price and dropping the system prompts it shadowed, a system-prompt rewrite, and the shared estimator's pricing branches.

### packages/llm/token-meter/tests/route-pricing.spec.ts
Route pricing tests: an adapter double declaring fixed per-occurrence image prices, a retained image priced as visual tokens plus handle text, an offloaded occurrence priced as its placeholder text, and a file occurrence priced as the exact handle text the LLM service resolves.

### packages/llm/token-meter/tests/turn-usage.spec.ts
Turn-usage tests: the exact per-attempt fold, a retry counted as a separate attempt, and the refusal to report a total when any attempt is incomplete or when an exact total contradicts the known prompt.

### packages/llm/token-meter/README.md
The meter's contract: measurements replay the durable log (deterministic, no model calls), the usage-anchor rule, the three projection units and what each carries, the image-offload repricing, and the "Reading the numbers" section stating that occupancy is a **reference figure, not a billing record** — nothing in the harness makes decisions from it — while the heuristic underprices CJK text and JSON schemas badly, which is exactly the error the provider anchor keeps out of the occupancy figure.

### packages/llm/token-meter/README.zh.md
Chinese translation of the token-meter README; read the summary section (lines 1–14).

### packages/llm/token-meter/package.json
Manifest for `@deepseek-ai/dsh-token-meter` v0.2.1-rc.2: exports `.`, `./client` and `./estimate`; peers on dsh-compaction, dsh-llm, dsh-llm-retry, dsh-session, dsh-session-projection and dsh-compaction-image-offload.

### packages/llm/token-meter/tsconfig.json
TypeScript project referencing llm/llm, llm/llm-retry, core/session, compaction/compaction, session/session-projection and compaction/compaction-image-offload.

### packages/llm/token-meter/locale/en.json
English locale stub: `meta.title` "token-meter" only.

### packages/llm/token-meter/locale/zh.json
Chinese locale entry: title "Token 计量" plus a description naming it an estimate for compaction budgeting.

### packages/llm/token-meter/README.i18n.yaml
Per-section EN/ZH content digests for the token-meter README.

### packages/llm/plugin-package-inventory-deepseek/src/index.ts
- **Purpose:** the active Loader-backed plugin package inventory contributed to official DeepSeek requests.
- **Key abstractions:** `PackageIdentityResolver` (with a per-process manifest cache); `activeEntries()`; `collectActivePluginPackages()`; `compareWireText()`.
- **Data flow:** every request re-reads the host Loader tree's active, non-group, enabled entries; when `ctx.agentPresets` is present and the `sessionId` resolves to a live Agent with a standing preset, that preset's separate tree joins the collection; each entry's owning package is resolved (bare package through `ctx.pluginPackages`, relative/absolute module through its nearest manifest) and the identities are deduplicated and sorted.
- **Non-obvious design decisions:** the sort uses a **locale-independent** comparison rather than `localeCompare`, so the wire bytes do not depend on the host's ICU data (`index.ts:148-151`); a manifest with a non-blank `name` but no `version` yields a name-only entry regardless of `private`.
- **Edge cases / failure handling:** a resolution, manifest-reading or JSON-parsing failure omits only that entry and logs one warning per module; the inventory never blocks a model request.
- **Surprising:** the `PluginPackages` service is sampled **at activation** — if it is absent the plugin keeps the native Node package-search lookup for its lifetime and does not switch an existing inventory when a resolver mounts later, so an embedder wanting runtime resolution identities must mount it first.

### packages/llm/plugin-package-inventory-deepseek/src/types.ts
The wire types: `DeepSeekPluginPackageIdentity` (name plus optional version), the version-1 `DeepSeekPluginPackageInventoryExtension`, and the declaration-merge of `dsh_plugin_packages` into the extension map.

### packages/llm/plugin-package-inventory-deepseek/tests/inventory.spec.ts
Inventory behaviour: the contribution present by default and absent when disabled; active package versions reported once with parallel versions kept separate; disabled entries and loose files without an owning package excluded.

### packages/llm/plugin-package-inventory-deepseek/tests/private-package-composition.spec.ts
A Loader-composed request with an unversioned (and optionally `private`) package beside a versioned sibling: the unversioned one is reported by name only, the versioned one with its version, and neither blocks the request.

### packages/llm/plugin-package-inventory-deepseek/README.md
The inventory's contract: the collection rules (host tree plus a standing preset's tree, only while the root fiber is `ACTIVE`), the resolution order and the `PluginPackages` sampling rule, the per-entry failure policy (omit that entry, one warning per module), the deduplication and locale-independent sort, and the stated limits (no programmatic child fibers, no in-memory dynamic plugins, partial inventories, and no in-place package replacement).

### packages/llm/plugin-package-inventory-deepseek/README.zh.md
Chinese translation of the inventory README; read the summary section (lines 1–15).

### packages/llm/plugin-package-inventory-deepseek/package.json
Manifest for `@deepseek-ai/dsh-plugin-package-inventory-deepseek` v0.2.1-rc.2: peers on the loader, dsh-agent, dsh-agent-preset-registry (optional), the extension registry and dsh-session.

### packages/llm/plugin-package-inventory-deepseek/tsconfig.json
TypeScript project referencing boot/app-boot, vendor/cosmokit, vendor/cordis, vendor/schemastery, vendor/loader, core/agent, core/session, preset/agent-preset-registry and deepseek-llm-api-extensions.

### packages/llm/plugin-package-inventory-deepseek/locale/en.json
English locale stub: `meta.title` "plugin-package-inventory-deepseek" only.

### packages/llm/plugin-package-inventory-deepseek/locale/zh.json
Chinese locale entry: title "DeepSeek 插件清单上报" plus a one-line description.

### packages/llm/plugin-package-inventory-deepseek/README.i18n.yaml
Per-section EN/ZH content digests for the inventory README.

---

## Ideas worth stealing

- **A "shadow price" event that lets a bounded counter shrink without retaining per-node prices** — `packages/llm/token-meter/src/surface-projection.ts:68-78` — a `compaction/summary` or `compaction/prune` event carries the *exact* heuristic price of the range the immediately following surface `replace` removes; the projection keeps a running total plus at most one pending claim and never stores per-node prices, yet stays exact. For August this is the missing half of compaction: a compaction that removes 40 000 tokens should be visible to the usage and occupancy counters immediately, without August having to re-read or re-price the pruned span. The same protocol is what lets "pressure" move the moment a compaction happens (`packages/llm/token-meter/src/usage-projection.ts:209-216`).
- **Reuse provider usage only for an identical request envelope, and only when it is not below your own anchor** — `packages/llm/token-meter/src/index.ts:158-181` — the meter reuses the provider's reported total only when the canonical request envelope matches *and* the provider total is at least the route-priced cost of the same call; otherwise it reprices the whole envelope and surface. This is exactly the rule that would have prevented August's `logger.get_stats` disagreeing with the composer chip (AGENTS.md: "cost_estimator.price_for_model is the ONLY pricing source"): a provider fact is admissible only for a request shape it actually described.
- **Fail with a count, not a silent trim, and log the offload decision durably** — `packages/llm/llm/src/content.ts:318-332` and `packages/llm/llm/src/error.ts:167-175` — a route whose retained images exceed its budget fails with `IMAGE_OFFLOAD_REQUIRED` carrying *how many more of the oldest occurrences* must be offloaded; the surface then logs an `image/offload` event and the step is retried. August's image-budget work currently trims silently; this pattern makes the decision durable and re-derivable.
- **Bind a prepared call to ONE adapter generation and make it one-shot** — `packages/llm/llm/src/index.ts:956-1014` — `prepareCall` captures the model metadata, the resolved config and the dispatch together, refuses a second dispatch, and refuses a config that drifted before dispatch. August has been bitten by exactly this class of bug (a serializer built from one settings generation sending to another's endpoint); the general fix is "capture a generation, not a value".
- **Strip replay/signature metadata when the historical route belongs to a different adapter** — `packages/llm/llm/src/index.ts:1023-1037` — `forAdapter` removes assistant replay state whose historical provider is owned by another adapter instance, preserving provider and model. Anthropic `thinking` signatures and OpenAI reasoning items are not portable; August's cross-provider transcript history needs this door.
- **Make the system-prompt update mode a MODEL capability, and then append instead of rewrite** — `packages/llm/llm/src/types.ts:408-425` and `packages/llm/llm-deepseek/src/serialize.ts:64` — a route that declares `systemPromptUpdate: 'in-history'` reads the latest `system` message at any position as the complete effective prompt, so a changed system prompt can follow the cached history instead of rewriting message 0. This is the KV-cache-stability primitive August lacks: today a system-prompt change rewrites the prefix and invalidates the provider cache.
- **Schedule a retry durably BEFORE the cancellable wait** — `packages/llm/llm-retry/src/types.ts:16-41` and `packages/llm/llm-retry/src/index.ts:243-258` — a non-surface `llm/retry` event carries the retry id, provider, policy key, failure and the scheduled delay, and is appended before the backoff; `llm/retry-started` follows immediately before the next attempt. A crash mid-backoff therefore leaves a log that says a retry was scheduled, and the token meter uses `llm/retry-started` to close the replacement scope so a retry bills as a separate attempt. August's `_retryWaitRefusalMs` and budget ladder need this ordering.
- **Let the provider own the retry policy and the loop own the execution** — `packages/llm/llm/src/retry-policy.ts:37-57` and `packages/llm/llm/src/index.ts:450-456` — the policy is resolved and frozen **per registered route** at registration time; the executor listens on `agent/request-error` and looks the policy up by the failed request's provider. A single global retry table cannot express "this gateway's 429 means something different from that one's"; the per-route key is the whole point.
- **Price an image occurrence as "visual tokens + the model-visible text", resolved synchronously by the adapter** — `packages/llm/llm/src/types.ts:199-220` and `packages/llm/llm-deepseek/src/request-pricing.ts:90-110` — the adapter answers per occurrence with the provider's visual-token price and the exact text that travels with it, and the caller prices that text with its own estimator, so provider pricing never fixes a text tokenizer. This is the mechanism that would let August's composer chip and usage page agree without a second rate table.
- **Port the provider's own image-token calculator instead of approximating it** — `packages/llm/llm-deepseek/src/image-tokens.ts:39-96` — the published `v41` calculator (14 px patch grid, 3:1 downsample, 544×544 scale-up floor, 1024-token cap solved aspect-preserving) is ported verbatim, and the projection is iterated to a fixpoint because the first pass is not one. If August ever resizes images for a provider, this is the difference between a real number and a guess.
- **A credential-scoped model catalog with a bounded first-use wait and last-known-good retention** — `packages/llm/llm-deepseek-account/src/catalog.ts:75-135` — the scope is `url + sha256(token)`, the first access of a scope awaits the listing under the *request's own* deadline, later accesses refresh in the background, and a failing streak keeps the previous listing. This is the shape any per-account model list needs; August's provider models are static today.
- **Decode a provider listing defensively and count what you skip** — `packages/llm/llm-deepseek-account/src/listing.ts:46-52` and `packages/llm/llm-deepseek-account/src/listing.ts:60-72` — rows without a usable id and repeated ids are **counted** (`skipped`), not silently dropped, and "absent" capacity is distinguished from "declared but not a positive safe integer" so the two can be told apart downstream.
- **Gate a model on the client's semver version with the prerelease rule written down** — `packages/llm/llm-deepseek-account/src/resolve-catalog.ts:64-82` — a listed model declaring `min_version` is offered only when the client version is at least it in semver order, and the README states that a prerelease orders below its release (so a listing that admits prereleases must declare the earliest one it admits). August gates tools and models by harness version in ad-hoc ways; this is the explicit rule.
- **Turn every adapter throw into exactly one terminal chunk, and leave middleware/consumer failures thrown** — `packages/llm/llm/src/index.ts:1064-1153` and `packages/llm/llm/src/index.ts:1184-1192` — adapter selection, dispatch, iterator construction and iteration failures become `{kind:'error'|'aborted', failure}`; everything else stays a thrown plugin error. This is the boundary that stops a provider error from being misread as a plugin error (and the reverse) — the same distinction August keeps having to re-establish.
- **Validate a whole candidate registry before anything moves, then swap in one synchronous section** — `packages/llm/llm/src/index.ts:495-548` and `packages/llm/llm/src/index.ts:437-458` — a refused candidate leaves the previous entries serving, and no observer can see the registry between the release and the re-registration. August's settings writes and provider registration would benefit from the same "validate fully, then commit" shape.
- **One plugin owns one top-level request field, with a prepare/accept transaction** — `packages/llm/deepseek-llm-api-extensions/src/index.ts:111-141` — the contributor prepares against the exact serialized body, the value is cloned and frozen (the provider keeps no mutable alias to the outgoing request), a failing contributor is omitted from that request with one warning, and the post-2xx commit runs exactly once even under concurrent calls. A clean template for "plugins may add provider metadata without touching the adapter".
- **Distinguish "absent credential" from "malformed credential", and keep the malformed one out of the retryable set** — `packages/llm/llm/src/error.ts:43-51` and `packages/llm/llm/src/api-key.ts:36-41` — `MISSING_CREDENTIAL` means "supply one", `INVALID_CREDENTIAL` means "correct the stored value", and a malformed key fails identically on every attempt so retrying it is pointless.
- **Read provider errors through one classifier that also extracts the retry delay and the request id** — `packages/llm/llm-deepseek/src/transport.ts:22-43` — status plus provider `type`/`code` maps to a stable code, `Retry-After` is parsed in both its numeric-seconds and HTTP-date spellings, and the request id is looked up under three header spellings. Every consumer (retry, the receipt, the classifier) then reads the same string.
- **Compact the assistant stream instead of expanding it** — `packages/llm/llm/src/assistant-stream.ts:100-194` — consecutive deltas are packed into runs with time deltas, so the durable record is roughly ten times smaller than the expansion; the record-level readers answer "first token time" and "is there visible content" with an early exit and never expand at all. August's per-turn transcript storage would shrink the same way.
- **Normalize a failure without trusting a foreign error object's accessors** — `packages/llm/llm/src/adapter-failure.ts:16-28` — the carried `failure` snapshot is accepted only when it is an own data property and its `code` agrees with the error's own `code`; a hostile `Proxy` or a throwing getter degrades to `{message:'LLM adapter failed', code:'UNKNOWN'}` instead of escaping.
- **Refuse an image-capability claim for an endpoint you cannot verify** — `packages/llm/llm-deepseek/src/model-info.ts:70-75` — an uncatalogued model is treated as text-only, because declaring an unverified image capability would let the host persist input the endpoint may reject on every later turn. Under-claiming fails early and names the model; over-claiming fails late and repeatedly.

---

## Files skipped (with reasons)

- `packages/llm/llm-deepseek/tests/fixtures/red.png` — a 69-byte binary PNG fixture (a 1×1 pixel image used by the image tests). I read its first 16 bytes (`89 50 4E 47 0D 0A 1A 0A 00 00 00 0D 49 48 44 52`, i.e. the PNG signature followed by the `IHDR` chunk header), which is enough to establish that it is an image asset and not source; there is no line structure to read.
- `packages/llm/llm-pi-ai/tests/fixtures/qr-code.png` — a 30,477-byte binary PNG fixture (the real image attachment used by the pi-ai e2e suite). Same reasoning: its first 16 bytes confirm the PNG signature and `IHDR` chunk, so it is an image asset; its pixels are not source text and were not read line by line.

No other file was skipped. Every source, test, config, doc and fixture in the shard was opened.

---

## Uncertainties

- **Bounded reads of the four largest test files.** `packages/llm/llm-deepseek/tests/runtime.spec.ts` (2383 lines) I read in three full passes (1–900, 901–1800, 1801–2383) but the middle of each pass was elided by the reader's truncation, so I saw roughly 60 % of its lines directly; I compensated by reading the surrounding sections and the remaining files' imports. `packages/llm/llm-pi-ai/tests/catalog.spec.ts` (1319 lines) I read the first 110 lines plus the complete list of its 79 case titles via grep — every case's *name* is known but the body of roughly 80 % of them was not read line by line. `packages/llm/llm-pi-ai/tests/adapter.spec.ts` (1121 lines) I read the first 110 lines plus the 46 case titles. `packages/llm/llm-pi-ai/tests/convert.spec.ts` (1023 lines) I read the first 90 lines only. `packages/llm/llm/tests/service.spec.ts` (~1700 lines) I read the head plus the 60 case titles. `packages/llm/llm-retry/tests/retry.spec.ts` (42 KB) I read the 28 case titles only. All of these are marked `read` in the ledger because I did open them and understood their role; the caveat is the *depth*, not the fact of the read.
- **`packages/llm/llm-deepseek/src/adapter.ts` and `packages/llm/llm/src/index.ts` were read in overlapping ranges rather than one pass**, because the reader elides the middle of a large response. For `llm/src/index.ts` I read 1–200, 200–439, 440–684, 685–884 (via 790–1029), 1029–1199 and 1200–1218, which covers the file; for `llm-deepseek/src/adapter.ts` I read the head (1–64) and the tail (158–178) and the mid-section was elided — the elided part is the `generate()` body's image preparation and serialization, which I reconstructed from `images.ts`, `serialize.ts` and `request-files.ts` (all read in full) and from the adapter's own call sites. I did not verify that reconstruction line by line.
- **`packages/llm/llm-deepseek/README.md` (218 lines) and `packages/llm/llm-pi-ai/README.md` (273 lines) were read with truncation** in the middle; the elided sections are the "Understand the implementation" prose, whose content I cross-checked against the source files I read in full.
- **The `dsh-compaction` package itself is not in this shard.** The token meter's shadow-price protocol, the `compaction/summary` and `compaction/prune` event payloads and the `image/offload` event are *consumed* here but *produced* elsewhere; I could not verify from this shard that every producer emits the adjacent metering event the protocol assumes, only that the consumer refuses a mismatched claim (`surface-projection.ts:89-94`).
- **The pi-ai dependency's internals are out of scope.** `packages/llm/llm-pi-ai` calls `@earendil-works/pi-ai` for its wire protocols, its catalog and its `Models` collection; I read the harness side (what this package asks of pi-ai) but the library itself is not in the clone path I inspected, so statements about pi-ai's internals (lazy provider resolution, its asymmetric `thinkingLevelMap` defaulting, its error flattening) are taken from the harness's own comments and tests, which assert them.
- **`packages/llm/llm/src/assistant-stream.ts` was read to line 410 of 534**; the remaining ~120 lines hold the remaining record-level readers and `assembleAssistantStream`. Their names and contracts are listed in the package README (`README.md:89`), which I read, but I did not read those specific function bodies.
- **`packages/llm/llm-deepseek/src/config.ts` was read in full but its middle was elided** by the reader (the schema's per-field validators). The field names and defaults are confirmed by `defaults.ts` (read in full) and by `runtime.spec.ts`'s config-bounds table.
