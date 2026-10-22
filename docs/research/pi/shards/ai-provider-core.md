# pi / ai-provider-core

## Shard shape

This shard is the entire `packages/ai` package of the pi repo: the provider-neutral LLM client
library that everything else in pi is built on. It is *not* the agent loop — there is no tool
executor, no session store, no TUI here. It is the layer underneath: a canonical message and
stream vocabulary (`types.ts`), one adapter per wire protocol under `src/api/` (OpenAI
Completions, OpenAI Responses, Azure Responses, Anthropic Messages, Bedrock Converse, Google
Gemini, Google Vertex, Mistral, Codex, pi-messages, plus three classifier protocols and one image
protocol), a provider/model registry (`models.ts` + ~40 generated provider definitions under
`src/providers/`), an OAuth + API-key credential subsystem (`src/auth/`), and a set of shared
primitives under `src/utils/` (retry, overflow detection, JSON repair, tool-argument validation,
transcript algebra, token estimation, client identity, error-body normalization). The generated
catalog is the spine: `scripts/generate-models.ts` fetches models.dev / OpenRouter / Vercel AI
Gateway / Radius, and emits `src/providers/data/*.json` plus one `.models.ts` shard per provider.
The through-line is **capability negotiation**: every provider quirk (does it accept
`reasoning_effort`? does it allow a system message mid-conversation? does it want `max_tokens` or
`max_completion_tokens`?) is a named boolean in a per-API *compat* schema, auto-detected from the
provider name and URL and overridable per model. Everything else — the transcript algebra, the
thinking-level map, the cache-control placement, the tool-id normalizers — hangs off that.

## Per-file notes

### packages/ai/scripts/ai-gateway-pricing.ts
- Purpose: convert Vercel AI Gateway pricing into pi's `ModelCost` shape.
- Key abstractions: `AiGatewayPricing` with per-rate prompt-length brackets (`input_tiers`,
  `output_tiers`, `input_cache_read_tiers`, `input_cache_write_tiers`).
- Data flow: `getAiGatewayCost(pricing)` → base $/1M rates → the union of all bracket starts becomes one `ModelCostTier` per start, each tier carrying the rates in effect at that prompt length.
- Non-obvious design decisions: each *rate* has its own brackets, but pi's `ModelCostTier` is a whole rate-set, so the bracket starts are unioned across rates and each tier re-reads every rate's bracket. Tiers are request-wide (`inputTokensAbove`), not marginal.
- Edge cases / failure handling: `perMillion` returns 0 for a missing/unparseable price rather than NaN.
- Surprising: a bracket start of 0 is dropped (only starts > 0 become tiers), so the base rate covers the first bracket.

### packages/ai/scripts/check-model-data.ts
- Purpose: CLI gate that fails CI when the generated model catalog is stale.
- Key abstractions: none — a 16-line wrapper.
- Data flow: `validateGeneratedModelData(packageRoot)` → on throw, print the message plus "Run `npm run hydrate:model-data`" and set `process.exitCode = 1`.
- Non-obvious design decisions: it uses `process.exitCode` rather than `process.exit()`, so the process finishes flushing.
- Edge cases / failure handling: any validation error becomes exit code 1 with the raw message.
- Surprising: it is the only script in this shard that is a *gate* rather than a generator.

### packages/ai/scripts/generate-models.ts
- Purpose: the catalog generator — turns upstream model metadata into the checked-in `src/providers/data/*.json` and the `.models.ts` shards.
- Key abstractions: `ModelsDevModel` / `ModelsDevCatalog` (the models.dev schema), `AiGatewayModel`, `OpenRouterModelListItem`, and ~50 `apply*Metadata` functions that stamp compat flags onto models.
- Data flow: fetch models.dev `api.json` → per-provider `process*Models` → merge with the OpenRouter, AI Gateway and Radius catalogs → apply compat/thinking-level/prompt-cache metadata → `groupProviderModelData` → write per-provider JSON + manifest → emit `models.generated.ts` → `validateGeneratedModelData`.
- Non-obvious design decisions: the compat flags are *baked into the catalog* per model rather than detected at request time, so a specific model's capabilities are a reviewable fact; `recordModelsDevReasoningOptions` collects upstream reasoning options and `applyModelsDevReasoningOptionMetadata` turns them into a `thinkingLevelMap` with `null` for unsupported levels.
- Edge cases / failure handling: `--strict`, `--data-only`, `--json-only` and `--json-output` flags; the generator throws on a model id appearing in two API groups, and the manual overrides section (`:2839+`) documents every temporary correction ("OpenCode variants list Claude Sonnet 4/4.5 with 1M context, actual limit is 200K").
- Surprising: the file is 3632 lines and most of it is per-provider compat tables and temporary overrides — the knowledge is in the tables, not in the algorithm.
- Coverage caveat: I read lines 1–260 (options, compat tables), 1814–1943 (the models.dev loader) and 2774–2893 (the `generateModels()` entry and the override block), plus a full function index. The per-provider model tables in the middle were **not** read line by line.

### packages/ai/scripts/generate-test-image.ts
- Purpose: writes a 200×200 white PNG with a red circle into `test/data/red-circle.png`.
- Key abstractions: none.
- Data flow: node-canvas → `canvas.toBuffer("image/png")` → `writeFileSync`.
- Non-obvious design decisions: the fixture is generated rather than committed, so it never bloats the repo.
- Edge cases / failure handling: none; `mkdirSync(..., { recursive: true })` creates the target directory.
- Surprising: it is the only file in this shard that depends on the native `canvas` package.

### packages/ai/scripts/hydrate-model-catalog.ts
- Purpose: rehydrate `src/providers/data/` from a published `models.all.json` **without network access**.
- Key abstractions: `CatalogEntry` = `ModelCatalogEntry` plus arbitrary fields.
- Data flow: read the catalog → for each provider id read from `models.generated.ts`, group entries by API → build the manifest with a **fixed epoch stamp** → stage into a temp dir → `validateModelDataDirectory(staged)` → `rmSync` + `renameSync` the staged dir into place.
- Non-obvious design decisions: the manifest timestamp is the literal `"1970-01-01T00:00:00.000Z"` so identical input produces byte-identical output regardless of build time — the catalog is reproducible. The swap is a directory rename, not a per-file copy, so a partially-written data dir is impossible.
- Edge cases / failure handling: the staged directory is validated *before* the swap; the staging root is removed in a `finally`. `--validateOnly` stops after validation.
- Surprising: `rmSync(dataDir, { recursive: true, force: true })` before the rename is a destructive step in a repo that otherwise only reads — worth noting for anyone auditing.

### packages/ai/scripts/model-data.ts
- Purpose: the validator and shared helpers for the generated catalog.
- Key abstractions: `ModelDataStructure` (`providerId → modelKey → api`), `ModelDataManifest` (schema version, generatedAt, structureHash, per-file sha256).
- Data flow: `readModelDataProviderIds` parses `models.generated.ts` with a **regex** over the import lines → the provider list must exactly match the `.models.ts` shards on disk → each provider's JSON is grouped by API → each model is validated field by field → the manifest's schema version, structure hash and per-file hashes are checked.
- Non-obvious design decisions: the provider list is derived from a *generated file* rather than a hand-written list, so adding a provider without regenerating fails the gate; the structure hash is over the sorted `provider → model → api` map, so it changes when a model's API group changes but not when a cost changes.
- Edge cases / failure handling: errors are collected and thrown together, first 30 shown with a "+N more" suffix; a model key must equal `${type}:${id}` exactly.
- Surprising: `assertExactModelIds` reports missing *and* extra ids in one message — the extra direction is what catches a model that was silently dropped from a shard.

### packages/ai/scripts/models-dev-reasoning-options.ts
- Purpose: convert models.dev `reasoning_options` into pi's `ThinkingLevelMap`.
- Key abstractions: `ModelsDevReasoningOption` = `toggle | effort | budget_tokens`.
- Data flow: collect the `effort` option's values → if none of them is a pi level and there is no "none", return `undefined` (the model has no mappable reasoning) → otherwise build a map with `off` set to `"none"` or `null` and every pi level mapped to itself or `null`.
- Non-obvious design decisions: `default` and JSON `null` upstream values are **intentionally omitted** — a level the provider does not enumerate is `null`, which pi reads as "unsupported", not "default".
- Edge cases / failure handling: a model with only a `toggle` option yields `undefined`, so the caller falls back to the provider default.
- Surprising: `null` in a `ThinkingLevelMap` is load-bearing — it is how a provider says "this level does not exist here", and `getSupportedThinkingLevels` filters on it.

### packages/ai/scripts/openrouter-catalog.ts
- Purpose: build the OpenRouter chat / image / classifier catalogs from three separate listings.
- Key abstractions: `OpenRouterCatalog` with the three lists.
- Data flow: default listing → chat models (only those whose `supported_parameters` include `tools`); `output_modalities=image` listing → image models; `output_modalities=decisions` listing → classifiers.
- Non-obvious design decisions: `anthropic/*` models are routed to the `anthropic-messages` API and a **different base URL** (`https://openrouter.ai/api` vs `/api/v1`); a model present in several listings gets one entry *per operation* rather than being deduplicated across types.
- Edge cases / failure handling: a batch model id (`…:batch`) is deliberately kept on the OpenAI-completions API even when it is an anthropic/* id.
- Surprising: OpenRouter "drops assets silently" for classifiers, so every classifier entry is created with `compat: { imageInput: "state-image-urls", sendImageOptInHeader: false }`.

### packages/ai/scripts/openrouter-reasoning-options.ts
- Purpose: map OpenRouter's `reasoning` metadata to a `ThinkingLevelMap`.
- Key abstractions: `OpenRouterReasoningMetadata` (`mandatory`, `default_enabled`, `supported_efforts`, `default_effort`).
- Data flow: no metadata → `undefined`; `supported_efforts` empty → `{ off: null }` if reasoning is mandatory, else `undefined`; otherwise reuse the models.dev effort conversion and force `off: null` when reasoning is mandatory.
- Non-obvious design decisions: OpenRouter's effort vocabulary is identical to models.dev's, so both sources share one conversion function — a deliberate single source of truth.
- Edge cases / failure handling: mandatory reasoning means the model cannot be asked to think *off*, which is exactly what `off: null` encodes.
- Surprising: `default_effort` and `default_enabled` are read from the type but not used by the conversion.

### packages/ai/src/api/anthropic-messages.lazy.ts
Generated-adapter wrapper: `anthropicMessagesApi()` returns `lazyApi(() => import("./anthropic-messages.ts"))`, deferring the Anthropic SDK to the first stream call.

### packages/ai/src/api/anthropic-messages.ts
- Purpose: the Anthropic Messages adapter — pi's richest one, and the reference for how a provider-specific wire protocol is reconciled with the canonical transcript.
- Key abstractions: `AnthropicOptions` (thinking mode, effort, display, interleaved thinking, tool choice, an injectable `client` for AnthropicVertex); `PiAnthropic` (an `Anthropic` subclass that disables the SDK's own credential chain); `DEFERRED_TOOL_PLACEHOLDER`; the beta-flag constants.
- Data flow: `stream()` → resolve the transcript → build an `Anthropic` client (OAuth "Claude Code" impersonation / Copilot bearer / API key / federation) → `buildParams` → `retryProviderRequest` → a hand-written SSE reader → per-event accumulation into `output.content` → `done` / `error`.
- Non-obvious design decisions:
  - **Stealth mode**: an OAuth token switches the client to `user-agent: claude-cli/2.1.280`, `x-app: cli`, the `claude-code-20250219` beta, and the tool-name canonicalization table (`:101-124`), and the system prompt gains "You are Claude Code, Anthropic's official CLI for Claude." (`:1229`).
  - **Cache-prefix stability**: `DEFERRED_TOOL_PLACEHOLDER` (`:208`) is declared from the first request so Anthropic's hidden prompt scaffolding for mid-conversation tool changes stays in the cached prefix — the comment says "measured: full miss without it".
  - **Strict-tool downgrade**: a 400 with "The compiled grammar is too large" / "Too many strict tools" / "Schemas contains too many parameters with union types" retries the request once with strict tools off, recorded as an `anthropic_strict_tools_fallback` diagnostic — but *only* if the stream has not started (`:664-688`).
  - **Mid-conversation effort**: `insertThinkingLevelMessages` (`:1564`) replays the effort recorded on each past reply as a system message, so an effort change never rewrites earlier input.
- Edge cases / failure handling: a missing `message_stop` after a `message_start` is an error ("Anthropic stream ended before message_stop"); a mid-output model fallback is rejected outright; `redacted_thinking` is replayed as the opaque `redacted_thinking` block rather than downgraded to text; an empty thinking signature is converted to plain text unless `allowEmptySignature` is set.
- Surprising: `mapStopReason` throws on an **unhandled** stop reason (`:1688`) rather than defaulting — a new provider stop reason must be handled explicitly.

### packages/ai/src/api/azure-openai-config.ts
- Purpose: resolve the Azure endpoint, API version and deployment name per request.
- Key abstractions: `AzureEndpointOptions` (`azureApiVersion`, `azureResourceName`, `azureBaseUrl`, `azureDeploymentName`).
- Data flow: `resolveAzureBaseUrl` (option → `AZURE_OPENAI_BASE_URL` → `AZURE_OPENAI_RESOURCE_NAME` → the model's own baseUrl) → `normalizeAzureBaseUrl` forces Azure hosts to `/openai/v1` and clears the query string → `resolveDeploymentName` maps the model id through `AZURE_OPENAI_DEPLOYMENT_NAME_MAP`.
- Non-obvious design decisions: normalization only fires for the three known Azure host suffixes and only for the specific path shapes that need it, so a custom proxy path is left alone.
- Edge cases / failure handling: an unresolvable base URL throws a message naming all four ways to supply one; an invalid URL throws "Invalid Azure OpenAI base URL".
- Surprising: the deployment map is a comma-separated `modelId=deploymentName` string in an env var — a config surface that exists only because Azure requires it.

### packages/ai/src/api/azure-openai-responses.lazy.ts
Generated-adapter wrapper: `azureOpenAIResponsesApi()` lazily imports `azure-openai-responses.ts`.

### packages/ai/src/api/azure-openai-responses.ts
- Purpose: Azure OpenAI Responses adapter.
- Key abstractions: `AzureOpenAIResponsesOptions` extends `AzureEndpointOptions` with reasoning effort / summary and tool choice.
- Data flow: `stream()` → resolve the deployment name → build the client with `AzureOpenAI` → `buildParams` (shared `convertResponsesMessages` + `processResponsesStream`) → stream.
- Non-obvious design decisions: the deployment name, not the model id, is sent as `model` (`:211`); `prompt_cache_key` is always sent from the session id, but `prompt_cache_retention` is not — the Azure Responses path has no long-retention support.
- Edge cases / failure handling: `max_output_tokens` is floored at 16 because OpenAI rejects anything smaller; errors are formatted with the "Azure OpenAI API error" prefix.
- Surprising: it reuses the OpenAI Responses message conversion wholesale, including `additional_tools` / tool-search support — the only Azure-specific change is the model name.

### packages/ai/src/api/bedrock-converse-stream.lazy.ts
- Purpose: lazily load the Node-only Bedrock adapter.
- Key abstractions: `setBedrockProviderModule` (a registration override).
- Data flow: `bedrockConverseStreamApi()` → `lazyApi(() => bedrockModuleOverride ?? importNodeOnlyApi("./bedrock-converse-stream.ts"))`.
- Non-obvious design decisions: the import goes through a **variable specifier** so bundlers (browser smoke, Bun compile) cannot follow it into the AWS SDK, and the `.ts`→`.js` rewrite keeps the trick working from both source and built output.
- Edge cases / failure handling: the Bun binary build cannot bundle a variable-specifier import, so it registers the module statically instead — the two paths are explicitly reconciled here.
- Surprising: the file also has to rewrite the extension at runtime based on `import.meta.url`, which is a fragile-but-documented hack.

### packages/ai/src/api/bedrock-converse-stream.ts
- Purpose: the Amazon Bedrock ConverseStream adapter.
- Key abstractions: `BedrockOptions` (region, profile, reasoning, thinking budgets, interleaved thinking, thinking display, `requestMetadata` cost-allocation tags, `bearerToken`); `Block` (content block + scratch buffers).
- Data flow: resolve region/credentials/profile → build the `BedrockRuntimeClient` config → `ConverseStreamCommand` → iterate the SDK event stream → accumulate blocks → `done`/`error`.
- Non-obvious design decisions:
  - **Caller headers go through a Smithy `build`-step middleware** (`:492`) so they are injected *after* serialization but *before* SigV4 signing, and reserved headers (`x-amz-*`, `authorization`, `host`) are silently dropped so they cannot break the signature.
  - **Region resolution order** (`:195-207`): ARN-embedded region beats an explicit option, which beats the endpoint's region, which beats `us-east-1` — and the default is suppressed entirely when an ambient `AWS_PROFILE` exists.
  - **`AWS_BEDROCK_SKIP_AUTH=1`** substitutes dummy credentials so an unauthenticated proxy works.
  - **Error prefixes are frozen** (`:373`): "Internal server error", "Throttling error" etc., because the downstream retry logic matches those strings.
- Edge cases / failure handling: a proxy forces `NodeHttpHandler` (the default `NodeHttp2Handler` has no HTTP-agent support); `AWS_BEDROCK_FORCE_HTTP1=1` handles endpoints that reject HTTP/2; a data-retention-mode error gets a docs URL appended.
- Surprising: `addResponseHeadersMiddleware` (`:525`) captures the raw Smithy response at the *deserialize* step because Bedrock's modeled `$metadata` preserves only selected headers — without it, gateway headers are lost before `onResponse` ever sees them.
- Coverage caveat: I read lines 1–610 and 900–1139 in full; the content-block delta handlers (611–899) and the tail (1140–1428) were sampled, not read line by line.

### packages/ai/src/api/classifier-shared.ts
- Purpose: shared plumbing for the three classifier APIs.
- Key abstractions: `ClassifierHttpError` (an Error carrying `status`, `headers`, `body` so the shared retry helper can see them).
- Data flow: `postClassifierRequest` → optional `onPayload` transform → a per-attempt `AbortSignal.timeout` combined with the caller's signal → `retryProviderRequest` → `onResponse` → the parsed JSON body.
- Non-obvious design decisions: the timeout is re-created per attempt (a retry gets a fresh deadline), and a timeout is distinguished from a caller abort by checking which signal fired.
- Edge cases / failure handling: `parseClassifierUsage` returns `undefined` for a missing or malformed usage object rather than failing the classification — a billed request with unusable usage still returns its answers.
- Surprising: `requiredNumber` throws on a non-finite number, so a provider returning `"0.5"` as a string fails the whole classification rather than being coerced.

### packages/ai/src/api/cloudflare-ai-binding.ts
- Purpose: let a Cloudflare Worker reach the AI Gateway without an API token.
- Key abstractions: `AiBinding` (structurally typed, `aiGatewayLogId` pins it to the AI binding); `CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL`.
- Data flow: `createAiBindingFetch(env.AI)` → a `FetchFunction` that passes the request through untouched.
- Non-obvious design decisions: the binding route is pre-authenticated, but the API adapters insist on a key or a recognized auth header, so the caller passes `cf-aig-authorization: Bearer cloudflare-gateway-binding` **and** nulls `Authorization` / `x-api-key` — a request-supplied auth header would otherwise be read by the gateway as a BYOK key that overrides the stored ones.
- Edge cases / failure handling: the binding's `fetch` is checked once at construction and bound eagerly, because `fetch` is a mutable property and the narrowing would not survive into the closure.
- Surprising: the module documents exactly why `aiGatewayLogId` is in the interface — without it the type would also accept any `{ fetch }` object, which is the mistake the runtime check reports late.

### packages/ai/src/api/cloudflare-workers-ai-system-one.lazy.ts
Generated-adapter wrapper: exposes `classify()` for the `cloudflare-workers-ai-system-one` classifier API through a dynamic import.

### packages/ai/src/api/cloudflare-workers-ai-system-one.ts
- Purpose: run System One classifier models on Cloudflare Workers AI.
- Key abstractions: a `SystemOneTransport` object (api, label, `detectCompat`, `url`, `payload`, `output`).
- Data flow: `classify()` → `classifySystemOne(transport, …)` → `POST { baseUrl }/run` with `{ model, input }` → unwrap either the third-party run record (`{ success, result: { state: "Completed", result: { answers, usage } } }`) or the direct Cloudflare envelope (`{ success, result: { model, answers, usage } }`).
- Non-obvious design decisions: `detectCompat` picks the image encoding by model id (`@cf/cloudflare/clef` → `images`, everything else → `assets`) and never sends the TypeSafe opt-in header.
- Edge cases / failure handling: `success === false` becomes an error listing the Cloudflare error messages; a run that did not reach state "Completed" is an error naming the state.
- Surprising: one transport abstraction serves three different services (TypeSafe, OpenRouter, Workers AI) that speak the same protocol with different envelopes.

### packages/ai/src/api/cloudflare.ts
Five Cloudflare endpoint templates (Workers AI direct + REST, AI Gateway compat / openai / anthropic passthrough), each carrying `{CLOUDFLARE_ACCOUNT_ID}` and `{CLOUDFLARE_GATEWAY_ID}` placeholders that the provider layer fills from the resolved env.

### packages/ai/src/api/constrained-sampling.ts
- Purpose: decide how a tool's arguments are constrained, and make a schema strict enough for providers that demand it.
- Key abstractions: `ConstrainedSamplingConfig` (`json_schema` with `strict: prefer|require`, or `grammar` with lark/regex variants); `UnsupportedStrictJsonSchemaError`.
- Data flow: `resolveJsonSchemaStrictSampling(tool, supportsStrictMode, isUnsupportedKeyword?)` → try `makeStrictJsonSchema` → on success return `true`; on `UnsupportedStrictJsonSchemaError` return `undefined` for a `prefer` tool and **throw** for a `require` tool.
- Non-obvious design decisions: `makeStrictJsonSchema` rewrites the schema — every property becomes required, and a property that does not allow null is wrapped as `anyOf: [property, { type: "null" }]`, because strict providers require the full property set in `required`; `additionalProperties` is forced to `false`. The provider-specific `isUnsupportedKeyword` hook is how Anthropic rejects `minimum`/`format: "date-time"`/etc.
- Edge cases / failure handling: `$ref`, `$defs`, `allOf`, `oneOf`, tuple `items`, object/array unions and boolean schemas are all explicitly unsupported and throw a named error.
- Surprising: `resolveGrammarConstrainedSampling` *infers* the grammar input property from the tool schema — it must be the single required string property — and throws a specific message naming the tool when the schema does not fit.

### packages/ai/src/api/github-copilot-headers.ts
Three small functions: `inferCopilotInitiator` (last message role → `X-Initiator: user|agent`), `hasCopilotVisionInput` (any image in a user message or a tool result), and `buildCopilotDynamicHeaders` (adds `Copilot-Vision-Request: true` when images are present).

### packages/ai/src/api/google-generative-ai.lazy.ts
Generated-adapter wrapper: `googleGenerativeAIApi()` lazily imports `google-generative-ai.ts`.

### packages/ai/src/api/google-generative-ai.ts
- Purpose: the Gemini adapter via the `@google/genai` SDK.
- Key abstractions: `GoogleOptions` (tool choice, a `thinking` config with `enabled` / `budgetTokens` / `level`).
- Data flow: `stream()` → collapse the transcript → `buildParams` (`contents` + `systemInstruction` + `tools` + `toolConfig` + `thinkingConfig`) → `retryGoogleRequest` → iterate chunks → split parts into thinking/text/tool blocks → usage from `usageMetadata` → `done`/`error`.
- Non-obvious design decisions: the thinking block is detected by `part.thought === true` and **not** by the presence of a `thoughtSignature` (a signature can sit on any part type); a tool call is emitted as start → one delta carrying the whole JSON → end, because Gemini sends complete arguments; a tool-call id that is missing or duplicated is regenerated as `name_<timestamp>_<counter>`.
- Edge cases / failure handling: usage subtracts `cachedContentTokenCount` from `promptTokenCount` and *adds* `thoughtsTokenCount` to `candidatesTokenCount`; a stream with no finish reason is an error.
- Surprising: `getGoogleBudget` (`:432`) hard-codes the 2.5 model families' token budgets and returns `-1` (dynamic) for everything else — a per-model table living in the adapter rather than in the catalog.

### packages/ai/src/api/google-shared.ts
- Purpose: everything the Gemini and Vertex adapters share.
- Key abstractions: `GoogleApiThinkingLevel` (mirrors Google's enum); `resolveGoogleThinkingLevel`; `usesGoogleThinkingLevel`.
- Data flow: `convertMessages(model, context)` → Gemini `Content[]`; `convertTools(tools, useParameters, supportsStrictMode)` → function declarations; `mapStopReason` → pi's `StopReason`.
- Non-obvious design decisions:
  - **Thought signatures are validated before replay** (`:151-162`): only a base64 signature from the *same provider and model* is kept. A text block whose text is empty but which carries a signature is **not** dropped — the comment says dropping it "breaks the reasoning chain and the model intermittently ends mid-task turns with a thought-only STOP".
  - **Tool-call ids are required for Gemini 3+**, Claude and gpt-oss models (`:167`).
  - **All function responses go in one user turn** for Cloud Code Assist (`:322`), and Gemini < 3 additionally gets a separate image message.
  - `retryGoogleRequest` (`:496`) patches the SDK's `ApiError` to carry a `headers` property, because the shared retry helper only retries errors that have both `status` and `headers`.
- Edge cases / failure handling: an unsupported thinking-level mapping throws naming the provider, model and the bad mapping; `mapStopReason` throws on an unhandled finish reason.
- Surprising: `usesGoogleThinkingLevel` decides between the discrete `thinkingLevel` control and the token `thinkingBudget` control with **regexes over the model id** (Gemini 3/4+, `gemini-flash-latest`, `gemma-4`) — a heuristic that a newer model name would silently miss.

### packages/ai/src/api/google-vertex.lazy.ts
Generated-adapter wrapper: `googleVertexApi()` lazily imports `google-vertex.ts`.

### packages/ai/src/api/google-vertex.ts
- Purpose: the Vertex AI adapter.
- Key abstractions: `GoogleVertexOptions` (adds `project` and `location`).
- Data flow: resolve the API key (a placeholder key is rejected) → either a key-based or an ADC-based `GoogleGenAI` client → the same `buildParams` and content conversion as the Gemini adapter.
- Non-obvious design decisions: a `{location}` base-URL template means "use the SDK's regional endpoint" and is replaced by `undefined`; a custom base URL is checked for an embedded api-version so the SDK does not append a second one.
- Edge cases / failure handling: a missing project or location throws a message naming the env vars that would fix it; `GOOGLE_APPLICATION_CREDENTIALS` is passed as `googleAuthOptions.keyFilename`.
- Surprising: `resolveApiKey` explicitly rejects the literal marker `"gcp-vertex-credentials"` and anything shaped `<…>` — a placeholder credential must not be sent as a real key.

### packages/ai/src/api/lazy.ts
- Purpose: make an asynchronous setup invisible to a synchronous stream API.
- Key abstractions: `lazyStream(model, setup, observer?)`; `lazyApi(load, capabilities?)`; `LazyStreamObserver` (`onEvent`, `onResult`).
- Data flow: `lazyStream` returns an `AssistantMessageEventStream` immediately, runs `setup()` in the background, forwards every event into the outer stream, and on a setup failure pushes a synthesized `error` event carrying a zero-usage `AssistantMessage`.
- Non-obvious design decisions: the outer stream is the *only* channel — a caller never has to handle "the promise rejected" separately from "the stream errored"; the observer hooks are described as "synchronous, read-only observation of the stream's existing forwarding path" so telemetry cannot perturb the stream.
- Edge cases / failure handling: `createSetupErrorMessage` builds a complete, well-formed assistant message so downstream code that reads `usage` on an error path does not crash.
- Surprising: `lazyApi` accepts a `capabilities` object rather than reflecting on the loaded module, so `fetchDeferred` / `cancelDeferred` are only attached when the API actually supports them.

### packages/ai/src/api/llama-cpp-classify.lazy.ts
Generated-adapter wrapper: exposes `classify()` for the `llama-cpp-classify` API through a dynamic import.

### packages/ai/src/api/llama-cpp-classify.ts
- Purpose: turn a local llama.cpp server into a classifier **without the model generating an answer**.
- Key abstractions: `LabeledQuestion` (the rendered prompt plus the labels and the keys they stand for); `labelTokenCache`.
- Data flow: per question → render the prompt → `POST /apply-template` for the model's own chat template → `POST /tokenize` to find the label token ids → `POST /completion` with `n_predict: 1` and pre-sampling `n_probs` → softmax over the label log-probabilities → the answer.
- Non-obvious design decisions:
  - The prompt is `state, overview-of-all-questions, state again, this question with labels` — the state is repeated so a causal model reads the first copy before it knows what is asked, and everything before the final question is identical for every question of a request so the server's prompt cache evaluates it once (`:160-170`).
  - Pre-sampling log-probabilities are a softmax over the full vocabulary, so the softmax over the *label* log-probabilities equals the softmax over the label logits (`:25-31`).
  - The label token is found by tokenizing `"\n<label>"` and comparing against tokenizing `"\n"`, because a tokenizer that adds a leading-space marker at the start of a text would otherwise return a different token than the model actually emits.
  - Confidence uses TypeSafe's documented `(n·peak − 1)/(n − 1)`, clamped to [0,1].
- Edge cases / failure handling: a label that is not a single token is an error; two labels sharing a token is an error; a label missing from the top-`n_probs` list triggers a deeper readout (`READOUT_ESCALATION = [4096, 32768]`) and then an error.
- Surprising: the system prompt explicitly tells the model that the state is data to judge and that instructions inside it must not be followed — a prompt-injection guard on the classifier path.
- Coverage caveat: I read lines 1–360 of 461; the readout/escalation tail was sampled.

### packages/ai/src/api/mistral-conversations.lazy.ts
Generated-adapter wrapper: `mistralConversationsApi()` lazily imports `mistral-conversations.ts`.

### packages/ai/src/api/mistral-conversations.ts
- Purpose: the native Mistral Chat Completions adapter.
- Key abstractions: `MistralOptions` (tool choice, `promptMode: "reasoning"`, `reasoningEffort`); the local `MistralChatPayload` / `MistralChatMessage` wire types.
- Data flow: `stream()` → `transformMessages` → `buildChatPayload` → `toMistralWirePayload` (camelCase → snake_case remap) → `requestMistralStream` → a hand-written SSE reader → `consumeChatStream`.
- Non-obvious design decisions:
  - **Tool-call ids are normalized to exactly 9 alphanumeric characters** (`:238-268`); if the sanitized id is not already 9 characters it is replaced by a hash, and a collision with another id is resolved by incrementing an attempt counter.
  - **The timeout covers only the response headers** (`:308-311`) — a long thinking stream must not be cut off by a fixed deadline; body stalls are left to the HTTP client.
  - **Prompt-cache affinity** is the `x-affinity` header carrying the session id, and an explicit caller override wins.
  - Reasoning models use `reasoning_effort` when the model has a thinking-level map, and `prompt_mode: "reasoning"` otherwise.
- Edge cases / failure handling: errors are formatted from the SDK's `statusCode` + `body`, truncated to 4000 chars.
- Surprising: the wire payload is produced by an explicit property remap table rather than a serialiser, because the same payload type is also the in-memory shape.
- Coverage caveat: I read lines 1–479 of 952; the event consumer and the payload builder tail were sampled.

### packages/ai/src/api/openai-codex-responses.lazy.ts
Generated-adapter wrapper: `openAICodexResponsesApi()` lazily imports `openai-codex-responses.ts`.

### packages/ai/src/api/openai-codex-responses.ts
- Purpose: the Codex (ChatGPT backend) adapter — the only one with a **WebSocket** transport.
- Key abstractions: `OpenAICodexResponsesOptions`; `CodexApiError` / `CodexProtocolError` / `ProviderStreamEventCallbackError` (three error classes that mean different things to the fallback logic); `CachedWebSocketConnection`; `OpenAICodexWebSocketDebugStats`.
- Data flow: `stream()` → build the request body → try the WebSocket transport → on a transport failure before the stream started, fall back to SSE → SSE path zstd-compresses the body → `mapCodexEvents` normalizes Codex's event names into OpenAI Responses events → the shared `processResponsesStream`.
- Non-obvious design decisions:
  - **The SSE fallback is remembered per session** (`:311-315`, `recordWebSocketSseFallback` at `:993`) so a broken WebSocket path is not retried on every turn.
  - **The body is zstd-compressed for SSE** (`:394-398`) but not for the WebSocket frame, matching the official Codex client.
  - **A callback failure is not a transport failure** (`:728-734`): `ProviderStreamEventCallbackError` keeps a user callback's exception out of the WebSocket retry path.
  - Two specific Codex errors get exactly one retry: `previous_response_not_found` and `websocket_connection_limit_reached`.
  - `RetryDelayExceededError` is never retried — a server-requested delay above the cap fails immediately.
- Edge cases / failure handling: a `response.failed` event becomes a `CodexApiError` with the provider's code; the account id is extracted from the access-token JWT at the `https://api.openai.com/auth` claim path.
- Surprising: `registerSessionResourceCleanup(closeOpenAICodexWebSocketSessions)` — the WebSocket connection cache is a *session resource* that the host must clean up, and the cleanup aggregates failures into an `AggregateError`.
- Coverage caveat: I read lines 1–999 of 1724; the WebSocket send/receive path and the header builders (1000–1724) were sampled.

### packages/ai/src/api/openai-completions.lazy.ts
Generated-adapter wrapper: `openAICompletionsApi()` lazily imports `openai-completions.ts`.

### packages/ai/src/api/openai-completions.ts
- Purpose: the OpenAI Chat Completions adapter — and the **reference implementation of pi's compat-flag engine**.
- Key abstractions: `OpenAICompletionsOptions`; `ResolvedOpenAICompletionsCompat`; the `OpenAIReasoningDetail` union (summary / encrypted / text) used to replay OpenAI's structured reasoning.
- Data flow: `stream()` → `resolveTranscript` → `buildParams` (messages, tools, cache control, thinking format, sampling params) → the OpenAI SDK → per-chunk accumulation → `done`/`error`.
- Non-obvious design decisions:
  - **`detectCompat` (`:1603`) infers ~20 capabilities from the provider id and base URL** (is this z.ai? Together? Moonshot? NVIDIA? Cerebras? DeepSeek?), and `getCompat` (`:1706`) layers the model's explicit `compat` block over it field by field. Every quirk is a named boolean, never an inline `if`.
  - **The thinking wire format is a single enum** (`thinkingFormat`: openai / openrouter / deepseek / together / baseten / zai / qwen / qwen-chat-template / chat-template / string-thinking / ant-ling) and the whole `if/else` chain at `:886-983` is one switch on it.
  - **A thinking token budget is applied independently of the format** (`:989-991`), because the same server can serve z.ai, qwen and chat-template models and reasoning + answer share `max_tokens` there — an uncapped reasoning phase would consume the whole response and leave no answer and no tool call.
  - **Anthropic-style cache control is emulated** on an OpenAI-compatible server (`:1095`): `cache_control` goes on the system prompt, the last tool, and the last user/assistant/tool text content.
  - **Tool-call ids from the Responses API are pipe-separated** `{call_id}|{item_id}`; the normalizer sanitizes both halves, joins them with `_`, and truncates to 40 chars with a hash suffix.
  - **Assistant content is always sent as a plain string**, not an array of content blocks — the comment explains that DeepSeek V3.2 via NVIDIA NIM mirrors the block structure literally and produces recursive nesting.
- Edge cases / failure handling: `parseChunkUsage` follows the documented OpenAI/OpenRouter semantics (cached tokens are cache *reads*; writes are subtracted separately and never deducted from the cached count); a missing `finish_reason` on a provider that does not support one is inferred from whether a tool call was seen; a stream that ends with `finish_reason` pending is an error.
- Surprising: the reasoning-field detection takes the **first non-empty** of `reasoning_content`, `reasoning`, `reasoning_text` — chutes.ai returns both `reasoning_content` and `reasoning` with the same content and would otherwise be duplicated.

### packages/ai/src/api/openai-decisions.lazy.ts
Generated-adapter wrapper: exposes `classify()` for the `openai-decisions` classifier API through a dynamic import.

### packages/ai/src/api/openai-decisions.ts
- Purpose: OpenAI's Decisions API — structured choice/score/bool questions over a state blob.
- Key abstractions: `DecisionQuestion` (`predicate | choice | score`).
- Data flow: `classify()` → `wireInput` (the state as JSON text, or a user message with the state plus image parts) → `wireQuestion` per question → `POST /v1/decisions` → `parseAnswers`.
- Non-obvious design decisions: **a bool question becomes a `predicate`, and because predicates have no criteria field the true/false meanings are appended to the instructions** (`:43-49`); the usage is recorded *before* the answers are parsed, because a request whose answers were malformed was still billed.
- Edge cases / failure handling: a refusal is an explicit error; the image cap is 128; **504 is excluded from retries** because the Cloudflare front door answers 504 with an HTML page for requests over roughly five seconds, and retrying the same input hits it again.
- Surprising: only real OpenAI API keys work — a Sign-in-with-ChatGPT token is rejected on this route, which is why `providers/openai.ts` filters classifiers out for OAuth credentials.

### packages/ai/src/api/openai-prompt-cache.ts
`clampOpenAIPromptCacheKey` truncates a session id to OpenAI's 64-character `prompt_cache_key` limit, counted in **code points** (`Array.from`) rather than UTF-16 units.

### packages/ai/src/api/openai-responses-shared.ts
- Purpose: the shared OpenAI Responses conversion and stream processor, used by the OpenAI, Azure and Codex adapters.
- Key abstractions: `TranscriptToolSupport` (re-exported from the transcript module); `ResponsesOutputSlot` (the output-index → content-block map); `OpenAIResponsesStreamOptions`.
- Data flow: `convertResponsesMessages(model, context, allowedToolCallProviders, options)` → `ResponseInput[]`; `processResponsesStream(stream, output, stream, model, options)` → normalized `AssistantMessageEvent`s.
- Non-obvious design decisions:
  - **Tool changes are expressed three ways** (`getResponsesToolSupport`, `:166`): `"changes"` (every tool declared in `additional_tools` items, so a later item replaces an earlier one), `"additions"` (synthetic `tool_search_call` / `tool_search_output` items) or `"none"` (a flat top-level list). Removals are **announced as text** (`renderToolRemovalNotice`) because the wire format cannot express them.
  - **An incremental-tools notice precedes every `additional_tools` item after the first** (`:181`), restating the still-unavailable tools, because models otherwise re-call a tool they announced as removed.
  - **Effort changes become `configuration_update` items** (`:266`, documented at `:134-142`) instead of changing `reasoning.effort`, so the earlier input never changes and the prompt cache survives. One item goes before every earlier reply with the level recorded on it, and one with the current effort goes at the end.
  - **A foreign tool-call item id is rebuilt** as `fc_<hash>` so it cannot be confused with a local item.
  - **Reasoning signatures are backfilled** from the terminal response (`:616`) because Azure can omit `reasoning.encrypted_content` from `response.output_item.done` and only send it in `response.completed`.
- Edge cases / failure handling: a tool call whose `output_item.done` never arrived is **refused** — the stream throws "unfinished tool call" rather than handing the agent a call with truncated arguments; `response.failed` becomes an error with the provider's code; a stream with no terminal event is an error.
- Surprising: `mapStopReason` (`:857`) throws on an unhandled status with an exhaustive `never` check.

### packages/ai/src/api/openai-responses.lazy.ts
Generated-adapter wrapper: `openAIResponsesApi()` lazily imports `openai-responses.ts`.

### packages/ai/src/api/openai-responses.ts
- Purpose: the OpenAI Responses adapter.
- Key abstractions: `OpenAIResponsesOptions` (reasoning effort/summary, service tier, tool choice).
- Data flow: `stream()` → `getCompat` → `buildParams` → the OpenAI SDK → `processResponsesStream` → `done`/`error`.
- Non-obvious design decisions: **Sign-in with ChatGPT is detected** as "provider is openai, baseUrl is api.openai.com/v1, and the key does not start with `sk-`" (`:49`); that credential then omits `prompt_cache_retention`, `prompt_cache_options`, `max_output_tokens` and `temperature`, and the `configuration_update` path is disabled because ChatGPT rejects those items. Service tier pricing multiplies the cost (flex 0.5×, priority/fast 2×, 2.5× for gpt-5.5).
- Edge cases / failure handling: the ChatGPT usage-limit errors get a usage-URL or workspace-admin hint appended to the message, because the raw provider text does not tell the user what to do.
- Surprising: `reasoning.encrypted_content` is always requested when reasoning is on, so multi-turn replay is stateless (`store: false`).

### packages/ai/src/api/openrouter-images.lazy.ts
Generated-adapter wrapper: exposes `generateImages()` for the `openrouter-images` API through a dynamic import.

### packages/ai/src/api/openrouter-images.ts
- Purpose: image generation over OpenRouter's chat completions endpoint.
- Key abstractions: `OpenRouterImageGenerationResponse` (the chat-completions shape plus `message.images`).
- Data flow: `generateImages()` → build a single user message → `modalities: ["image", "text"]` → the OpenAI SDK → parse `message.images[].image_url` data URLs into base64 `ImageContent` blocks.
- Non-obvious design decisions: only `data:` URLs are accepted (a remote URL would be a fetch pi does not perform); `modalities` includes `"text"` only when the model declares it.
- Edge cases / failure handling: the image usage parser subtracts cache-write tokens from the reported cached count only when writes > 0 — a different convention from the chat adapter.
- Surprising: image generation is modelled as a **chat completion**, not an images endpoint, because that is what OpenRouter exposes.

### packages/ai/src/api/pi-messages.lazy.ts
Generated-adapter wrapper: `piMessagesApi()` lazily imports `pi-messages.ts`.

### packages/ai/src/api/pi-messages.ts
- Purpose: pi's **own** wire protocol — the contract between pi and a pi-messages backend (the Radius gateway).
- Key abstractions: `PiMessagesEvent` (the serialized event union); `PiMessagesRewriteImpact` (a server-side rewrite summary); `PiMessagesResponseError`.
- Data flow: `stream()` → one `POST { model, context, options }` to `<baseUrl>/messages` → an SSE stream of `data:` lines carrying serialized events → `createEventConverter` rebuilds the internal event objects → `done`/`error`.
- Non-obvious design decisions:
  - The whole `TranscriptContext` is sent as the request body, so a backend can rewrite the transcript; the backend reports what it did in a `rewrite` field (`policyId`, `policyVersion`, `tokenCountChange`, `messageCountChange`, `systemPromptChanged`), which pi records as a diagnostic.
  - `resolveCacheRetention` returns `undefined` when unset, so the **backend's** default applies — the legacy env opt-in is the only thing pi maps.
  - The error body is parsed for `{ error: { message, code, details } }` and the diagnostic carries the URL, status and the truncated raw body.
- Edge cases / failure handling: a stream that ends without a terminal event is an error; the diagnostic string is truncated at 8192 chars.
- Surprising: the tool-call arguments are re-parsed from the accumulated JSON deltas with `parseStreamingJson`, so the backend's own serialization is trusted only for the text.

### packages/ai/src/api/simple-options.ts
- Purpose: turn the provider-neutral `SimpleStreamOptions` into the common `StreamOptions` every adapter consumes.
- Key abstractions: `DEFAULT_THINKING_BUDGETS` (minimal 1024 / low 2048 / medium 8192 / high 16384); `MIN_ANSWER_TOKENS = 1024`.
- Data flow: `buildBaseOptions` → `clampMaxTokensToContext` → `resolveSamplingParams`; `adjustMaxTokensForThinking` → a `(maxTokens, thinkingBudget)` pair.
- Non-obvious design decisions:
  - **`clampMaxTokensToContext` reserves 4096 tokens** (`CONTEXT_SAFETY_TOKENS`) on top of the estimated context, so a request cannot fill the window.
  - **A thinking budget is capped so at least 1024 tokens remain for the answer** (`clampThinkingBudgetToAnswerRoom`) — reasoning and the answer share one ceiling.
  - `resolveSamplingParams` merges model defaults → per-thinking-level overrides → request overrides, in that order.
- Edge cases / failure handling: a model with `contextWindow <= 0` is treated as "unknown size" and the caller's max is kept.
- Surprising: `clampReasoning` maps `xhigh` and `max` **down** to `high` — the extended levels are not universally supported.

### packages/ai/src/api/system-one-shared.ts
- Purpose: the shared implementation of the System One classifier protocol, parameterized by a transport.
- Key abstractions: `SystemOneTransport` (api, label, `detectCompat`, `url`, `payload`, `output`); `SystemOneImageInput` (`assets | images | state-image-urls`).
- Data flow: `classifySystemOne` → build the wire request → `addImages` in the service's encoding → `postClassifierRequest` → `parseAnswers`.
- Non-obvious design decisions: the three image encodings are genuinely different protocols (TypeSafe's `assets` map with `<image-N>` names referenced from the state, Clef's `images` list of data URLs, OpenRouter's `image_url` parts placed before the state); the public `bool` question type is renamed to `noul` on the wire; a **bool question with images** is not answered at all by OpenRouter (it drops `assets` silently), which is why the compat flag exists.
- Edge cases / failure handling: a missing answer for any question is an error naming the question id; usage is recorded before the answers are parsed (a billed request still reports its usage).
- Surprising: every asset must be referenced from the request, so the asset names are prepended to the state array.

### packages/ai/src/api/transform-messages.ts
- Purpose: the one normalization pass every adapter runs before building a request body.
- Key abstractions: `SplitErrorToolResult` (a text-only result plus the images to send after the tool results).
- Data flow: `transformMessages(messages, model, normalizeToolCallId?)` → image downgrade → thinking/tool-call rewriting → orphan repair → the outgoing message list.
- Non-obvious design decisions:
  - **Thinking from another model is dropped** (`:132`): "Signatures and encrypted reasoning are only valid for the model that produced them, and sending readable thinking as plain text makes the new model treat it as part of the visible reply." Redacted and signed blocks survive even with empty text.
  - **Orphaned tool calls get a synthetic error result** (`:188-207`): any assistant tool call without a matching tool result is closed with `{ text: "No result provided", isError: true }`, so the request never carries an unanswered `tool_use_id`.
  - **A system message between a tool call and its results is held back** and emitted after them (`:184-186`), because some providers reject a `tool_result` that is not immediately preceded by its `tool_use`.
  - **Error tool results are split** (`:31-40`) for APIs that reject images in an error result — the images move after all tool results, in the same user message.
- Edge cases / failure handling: `stopReason === "error" | "aborted"` assistant messages are dropped entirely (`:222`), because replaying a partial turn causes provider errors such as OpenAI's "reasoning without following item".
- Surprising: `transformMessages` is where a malformed-history bug is prevented rather than repaired later — the repair is at the serialization door, not at the provider's error handler.

### packages/ai/src/api/typesafe-system-one.lazy.ts
Generated-adapter wrapper: exposes `classify()` for the `typesafe-system-one` classifier API through a dynamic import.

### packages/ai/src/api/typesafe-system-one.ts
- Purpose: TypeSafe's native System One protocol (also served by OpenRouter).
- Key abstractions: one `SystemOneTransport` object.
- Data flow: `classify()` → `classifySystemOne` → `POST <baseUrl>/systemone` with `{ model, ...request }` → the body is the answer map directly.
- Non-obvious design decisions: `detectCompat` keys on the provider id **or** the host, because a proxy that hides both must set `compat.imageInput` explicitly.
- Edge cases / failure handling: a non-object response throws "System One API returned an unexpected response".
- Surprising: the file's doc comment is the clearest statement of the image-encoding contract: TypeSafe needs the opt-in header or answers 400; OpenRouter drops `assets` silently.

### packages/ai/src/auth/context.ts
- Purpose: the default `AuthContext` — where env vars and file existence come from.
- Key abstractions: `NodeFsModule` / `NodeOsModule` (structural types so the module does not depend on `@types/node`).
- Data flow: `env(name)` → `process.env` (empty string is treated as unset); `fileExists(path)` → `node:fs/promises` `access`, with `~` expanded via `node:os` `homedir()`.
- Non-obvious design decisions: the node builtins are imported through a **variable specifier** (`importNodeModule`) so browser bundlers do not try to resolve them.
- Edge cases / failure handling: `fileExists` returns false in a browser and for any error, including a permission failure.
- Surprising: an empty-string env var is normalized to `undefined`, so a blank `OPENAI_API_KEY` does not count as configured.

### packages/ai/src/auth/credential-store.ts
- Purpose: the default in-memory credential store.
- Key abstractions: `InMemoryCredentialStore` with a per-provider promise chain.
- Data flow: `modify(providerId, fn)` → enqueued behind the provider's previous write → `fn(current)` → store the result.
- Non-obvious design decisions: the chain is **not** released until the active work settles (`tail.catch(() => {})` then delete only if the map still holds that tail), so a failing write cannot break the chain for the next writer.
- Edge cases / failure handling: `fn` returning `undefined` leaves the entry unchanged; the abort signal is checked before the task runs and after `fn` returns.
- Surprising: `modify` returns the *post-write* credential, so a caller that cancels mid-write can still learn whether the mutation landed.

### packages/ai/src/auth/helpers.ts
- Purpose: the standard api-key auth and the lazy-OAuth wrapper.
- Key abstractions: `envApiKeyAuth(name, envVars)`; `lazyOAuth({ name, isSubscription, loginLabel, load })`.
- Data flow: `envApiKeyAuth.resolve` → stored key, else the first set env var, else `undefined`; `lazyOAuth` memoizes the module load and delegates `login`/`refresh`/`toAuth`.
- Non-obvious design decisions: `lazyOAuth` exists so a provider definition can advertise OAuth **without importing Node-only flow code** — the same bundler trick as the Bedrock lazy wrapper.
- Edge cases / failure handling: the source label distinguishes "stored credential" from the env var name, which the status UI shows.
- Surprising: `lazyOAuth` memoizes the *promise*, so a failed load is cached as a rejected promise for the process lifetime.

### packages/ai/src/auth/oauth/anthropic.ts
- Purpose: the Anthropic Claude Pro/Max OAuth flow.
- Key abstractions: `anthropicOAuth: OAuthAuth`; `parseAuthorizationInput` (accepts a raw code, a URL, a fragment or a query string).
- Data flow: prompt for the method → PKCE → `startOAuthCallbackServer` on port 53692 (falling back to a free port) → notify the auth URL → `waitForCallbackOrManualInput` → exchange the code for tokens.
- Non-obvious design decisions: the loopback port is preferred so it can be forwarded into a container or over SSH, and Anthropic accepts any loopback port, so the fallback is safe; the copy-code mode uses Anthropic's own `https://platform.claude.com/oauth/code/callback` redirect instead of a loopback server; the credential's expiry is shortened by five minutes so a token never dies mid-request.
- Edge cases / failure handling: `formatErrorDetails` folds the error code, errno, cause chain and stack into the message so a failed exchange is diagnosable.
- Surprising: the client id is stored **base64-encoded** (`decode("OWQ…")`), presumably to avoid a plain-text secret scanner matching it.

### packages/ai/src/auth/oauth/callback-server.ts
- Purpose: the shared loopback OAuth redirect handler.
- Key abstractions: `OAuthCallbackServer` (`redirectUri`, `wait()`, `cancel()`, `close()`); `OAuthCallbackServerOptions`.
- Data flow: `startOAuthCallbackServer(options)` → bind → the browser hits the path → validate the state → `complete(code)` → serve the success/failure page → resolve or reject `wait()`.
- Non-obvious design decisions: the code exchange happens **before** the page is served (`:26-28`), so the page can show an exchange failure rather than a false success; `claimed` makes a second callback a 409; `waitForCallbackOrManualInput` races the loopback server against a pasted redirect URL and aborts the manual prompt when the callback wins.
- Edge cases / failure handling: 404 for the wrong route, 400 for a state mismatch or a missing code, 409 for a duplicate callback, 502 for a failed exchange; an optional timeout rejects with "sign-in timed out"; the wait promise has a no-op catch attached because a cancelled wait may never be observed.
- Surprising: `cancel()` resolves with `undefined` (a clean "the user chose manual entry") while `close()` rejects — the two are deliberately different.

### packages/ai/src/auth/oauth/device-code.ts
- Purpose: the RFC 8628 device-authorization poller.
- Key abstractions: `OAuthDeviceCodePollResult` (`pending | slow_down | failed | complete`); `OAuthDeviceCodePollOptions`.
- Data flow: `pollOAuthDeviceCodeFlow` → loop until the deadline → `poll()` → interpret the status → `abortableSleep` for the interval.
- Non-obvious design decisions: **the server's interval wins over the client-tracked one** (`:78-86`), because trusting only a client-side counter risks polling early forever under WSL/VM clock drift; otherwise RFC 8628 §3.5 applies (+5 s); the default interval is 5 s when the server omits it, and the floor is 1 s.
- Edge cases / failure handling: a timeout after one or more `slow_down` responses gets a *different* message that names clock drift as the likely cause.
- Surprising: `waitBeforeFirstPoll` exists because several providers expect the client not to poll before the interval has elapsed.

### packages/ai/src/auth/oauth/github-copilot.ts
- Purpose: the GitHub Copilot device-code flow, plus the second-stage Copilot token exchange and account model catalog.
- Key abstractions: `parseGitHubCopilotModelCatalog` → `{ availableModelIds, policyModelIds }`; `getBaseUrlFromToken`.
- Data flow: device code → GitHub access token → exchange for a Copilot token (`proxy-ep` → `api.` host) → `GET /models` → optionally enable unconfigured models via `POST /models/{id}/policy` → the credential carries `availableModelIds`.
- Non-obvious design decisions: **the base URL is derived from the token itself** (`proxy-ep=proxy.individual.githubcopilot.com` → `https://api.individual.githubcopilot.com`), with the enterprise domain as a fallback; the picker-flag fallback to the policy list is limited to the individual endpoint because other account types keep strict picker semantics; the Copilot headers impersonate the VS Code chat extension.
- Edge cases / failure handling: the verification URI is parsed and required to be http(s) so a hostile response cannot make the client open something else; a 429 during model enablement aborts the batch rather than continuing.
- Surprising: `toAuth` returns a **per-credential base URL**, so the same provider entry talks to a different endpoint depending on which account is signed in — a credential can change the endpoint, not just the key.

### packages/ai/src/auth/oauth/kimi-coding.ts
- Purpose: the Kimi Code (subscription) device-code OAuth flow.
- Key abstractions: `DeviceAuthorization` (the parsed device-code response); `TokenResponse`.
- Data flow: `POST /api/oauth/device_authorization` → notify the code → poll the token endpoint → return the credential.
- Non-obvious design decisions: the OAuth host is overridable via `KIMI_CODE_OAUTH_HOST` / `KIMI_OAUTH_HOST` (which is how the flow is pointed at a test server); the verification URI is validated as http(s) before it is shown to the user.
- Edge cases / failure handling: the token response is validated field by field; refresh has three retries.
- Coverage caveat: I read lines 1–120 of 296; the token/refresh tail was sampled.

### packages/ai/src/auth/oauth/load.ts
- Purpose: load every OAuth flow module without dragging Node-only code into a browser bundle.
- Key abstractions: `OAuthFlowLoaders`; `registerBundledOAuthFlowLoaders`.
- Data flow: `loadAnthropicOAuth()` → the registered loader if present, else `importOAuthModule("./anthropic.ts")` → the exported `OAuthAuth`.
- Non-obvious design decisions: the same variable-specifier + `.ts`/`.js` rewrite trick as the Bedrock lazy wrapper; the Bundled-loaders registry exists purely for the standalone Bun binary.
- Edge cases / failure handling: `import.meta.url` decides the extension, so the same source works in dev and in the built output.
- Surprising: nine separate exported loaders instead of one map, so each provider's chunk can be tree-shaken independently.

### packages/ai/src/auth/oauth/meta.ts
- Purpose: the Meta Model API OAuth flow — where the identity token and the inference credential are **different things**.
- Key abstractions: `DeviceAuthorization`.
- Data flow: device authorization → poll for an **identity token** → exchange it at the Muse Code key-mint endpoint for an API key → store the identity token as `refresh` and the minted key as `access`.
- Non-obvious design decisions: **the identity token is not renewable** — auth.meta.com answers `grant_type=refresh_token` with 404 and issues no new refresh token — so the identity token is stored in the `refresh` slot and the standard OAuth scheduler re-mints the key when it expires. A 401/403 from the mint means the session is dead and the user must sign in again.
- Edge cases / failure handling: the verification URI is trusted only as http(s); the request timeout is 30 s combined with the caller's signal.
- Surprising: the credential shape is deliberately abused so that no bespoke renewal machinery is needed.
- Coverage caveat: I read lines 1–120 of 208; the mint tail was sampled.

### packages/ai/src/auth/oauth/openai-chatgpt.ts
- Purpose: the "Sign in with ChatGPT" OAuth flow.
- Key abstractions: `AuthorizationResult` (`code` + the **issued** `clientId`); `CallbackServer`.
- Data flow: register a dynamic client → the browser callback carries the issued client id → exchange the code → store the credential.
- Non-obvious design decisions: **every login registers a new client** — the client id is the literal `"dynamic_agent_client"` and the real id comes back in the callback; the expiry margin is three minutes so a request never starts with a token about to expire; the pasted manual input must be the *full* callback URL with a matching origin and path.
- Edge cases / failure handling: a missing or mismatched state, a missing code or a missing issued client id are each rejected with their own message; the callback server binds port 1455.
- Surprising: the flow ships an `agentName` hint ("Pi") and a `getDeviceId` option so OpenAI can attribute the agent.
- Coverage caveat: I read lines 1–140 of 309; the token-exchange tail was sampled.

### packages/ai/src/auth/oauth/openai-codex.ts
- Purpose: the Codex ChatGPT OAuth flow, with two login methods.
- Key abstractions: `DeviceAuthInfo`; `DeviceTokenSuccess` (an authorization code **plus** a code verifier, exchanged afterwards).
- Data flow: prompt for the method → either a browser PKCE flow on port 1455 or a headless device-code flow → exchange the code → `credentialsFromToken` extracts the account id from the access-token JWT.
- Non-obvious design decisions: the device flow returns an authorization code and a code verifier from the *device* endpoint, which are then exchanged through the normal token endpoint, so both paths converge on one exchange function; the callback port is shared with the Codex CLI, so a bind failure falls back to the pasted redirect URL; the state is the hex of 16 random bytes from `node:crypto`.
- Edge cases / failure handling: `createState` throws "only available in Node.js environments" when `node:crypto` has not loaded; a 403/404 from the device token endpoint is treated as "pending".
- Surprising: `isOAuthToken(apiKey)` elsewhere checks for the `sk-ant-oat` prefix, so the Anthropic adapter can detect an OAuth credential from the key alone.

### packages/ai/src/auth/oauth/openrouter.ts
- Purpose: the OpenRouter OAuth flow — which yields a **permanent key**, not a token pair.
- Key abstractions: none beyond `openRouterOAuth`.
- Data flow: PKCE → a one-shot loopback server on an **ephemeral** port with a random path → exchange the code at `POST /api/v1/auth/keys` → store the key.
- Non-obvious design decisions: OpenRouter sends no `state`, so the **random callback path** is what keeps a stray request from completing the sign-in; the credential carries `expires: Number.MAX_SAFE_INTEGER` and `refresh: ""` because `refresh()` is a no-op — a permanent key has no expiry to model.
- Edge cases / failure handling: a missing `key` in the response throws 'OpenRouter OAuth response carries no "key"'; the token exchange has a 30 s timeout separate from the 5-minute login timeout.
- Surprising: the login path is `/oauth/callback/<uuid>` — a per-login random path, not a fixed route.

### packages/ai/src/auth/oauth/pkce.ts
Web Crypto PKCE: 32 random bytes as the verifier, SHA-256 as the S256 challenge, base64url-encoded without padding; works identically in Node 20+ and browsers.

### packages/ai/src/auth/oauth/radius.ts
- Purpose: the Radius gateway OAuth flow, with the authorization endpoint **discovered** rather than hard-coded.
- Key abstractions: `RadiusOAuthDiscovery`; `OAuthResponseError` (carrying the OAuth `error` code so the poller can classify it).
- Data flow: prompt for the method → browser: `GET /v1/oauth` for `authorizationEndpoint` → PKCE → loopback on 1456 → token; device: `POST /v1/oauth/device` → poll `/v1/oauth/token`.
- Non-obvious design decisions: the scope is `"gateway offline_access"`; the browser flow uses `handoff: "url"`; the device flow maps `authorization_pending` / `slow_down` / `expired_token` / `access_denied` onto the shared poller's statuses.
- Edge cases / failure handling: the token expiry carries a 60 s skew; an error body that is not JSON is used as the description verbatim.
- Surprising: only the *interactive* endpoint is discovered — the client APIs live on the configured gateway and are not negotiated.
- Coverage caveat: I read lines 1–140 of 321 and then 140–321; the whole file was covered.

### packages/ai/src/auth/oauth/xai.ts
- Purpose: the xAI device-code OAuth flow.
- Key abstractions: `XaiDeviceCode`; `OAuthHttpResponse`.
- Data flow: device code → poll the token endpoint → refresh.
- Non-obvious design decisions: **the verification URI must be https** (`:51-61`) so a malicious response cannot make the client open something else; RFC 8628 allows `interval: 0`, so a non-positive or malformed interval falls back to the poller's default instead of failing.
- Edge cases / failure handling: the refresh skew is five minutes so a token never dies mid-request.
- Surprising: xAI's device flow is the simplest of the nine and still validates the URI protocol — the check was applied everywhere.
- Coverage caveat: I read lines 1–120 of 239; the token tail was sampled.

### packages/ai/src/auth/resolve.ts
- Purpose: auth resolution for every operation in a `Models` collection.
- Key abstractions: `AuthResolutionOverrides` (`apiKey`, `env`, `minOAuthValidityMs`, `signal`).
- Data flow: `resolveProviderAuth` → an explicit override wins → else the stored credential owns the provider → else ambient env → `resolveStoredOAuth` → `refreshStoredOAuthCredential` → `oauth.toAuth`.
- Non-obvious design decisions:
  - **A stored credential owns the provider** (`:27-31`): ambient env is consulted only when nothing is stored, and there is no silent env fallback after a failed refresh or for a credential type with no matching handler.
  - **A refresh that has started survives cancellation** (`:110-114`): the signal cancels only the wait for the lock; once the provider may have rotated the refresh token, the refresh and its persistence are bounded only by a 15 s timeout, because a cancelled caller could otherwise discard the only valid refresh token.
  - **Double-checked locking**: the optimistic expiry check is re-checked under the store lock, so concurrent callers and processes refresh only once.
  - The default validity window is five minutes; a caller that *requires* a minimum validity (bearer-token export) gets a hard error if the refreshed token still expires too soon.
- Edge cases / failure handling: every failure is wrapped in a `ModelsError` with a code — `"oauth"` for a refresh/derivation failure, `"auth"` for a key or store failure — and the cause detail is folded into the message.
- Surprising: `overlayEnvAuthContext` (`:95`) layers a provider-scoped env over the base context rather than mutating it, so a per-request env cannot leak into another provider.

### packages/ai/src/auth/types.ts
- Purpose: the auth contract that apps implement.
- Key abstractions: `CredentialStore` (`read` / `list` / `modify` / `delete`), `ApiKeyAuth`, `OAuthAuth`, `ProviderAuth`, `AuthContext`, `AuthPrompt`, `AuthEvent`, `AuthInteraction`.
- Data flow: the app provides a `CredentialStore` and an `AuthContext`; `Models` drives `login` / `logout` / `refresh` / `resolve` through the provider's `ProviderAuth`.
- Non-obvious design decisions: **`modify` is the only write path**, so every mutation is a serialized read-modify-write and `Models.getAuth()` runs the OAuth refresh inside it — concurrent requests cannot double-refresh a rotated token. `list` must not execute configured API-key commands. `delete` must serialize against `modify`. The `refresh` / `toAuth` split lets `Models` own the locked refresh pattern while the provider owns the derivation (which is why a credential can change the endpoint, as Copilot does).
- Edge cases / failure handling: `AuthPrompt` carries its own `signal` so a pending prompt can be cancelled when an out-of-band event wins the race.
- Surprising: `ApiKeyAuth.check` exists only for providers whose `resolve()` would run a command — otherwise availability is determined by resolving.

### packages/ai/src/bedrock-provider.ts
Six-line static re-export of the bedrock `stream` / `streamSimple` functions, for the Bun build that cannot follow the variable-specifier dynamic import.

### packages/ai/src/bun-oauth.ts
Registers the nine OAuth flows statically embedded in the standalone Bun binary via `registerBundledOAuthFlowLoaders`.

### packages/ai/src/cli.ts
- Purpose: a dev CLI (`npx pi-ai login|list`) that runs one OAuth login and writes the credential to `auth.json`.
- Key abstractions: `answerPrompt` (maps the `AuthPrompt` union onto readline).
- Data flow: `builtinProviders()` → filter to the providers that have `auth.oauth` → prompt → `provider.auth.oauth.login(interaction, { getDeviceId: randomUUID })` → write `auth.json`.
- Non-obvious design decisions: the CLI's `notify` handler prints the auth URL / device code / progress messages; a `select` prompt is rendered as a numbered list.
- Edge cases / failure handling: `loadAuth` swallows a malformed `auth.json` and starts empty; an unknown provider or command throws.
- Surprising: it is a shipped binary entrypoint (`#!/usr/bin/env node`) inside a library package.

### packages/ai/src/compat.ts
- Purpose: the temporary compatibility entrypoint preserving the old global pi-ai API.
- Key abstractions: `ApiProvider`; an internal api-registry (`apiProviderRegistry`).
- Data flow: `stream(api, model, context, options)` → look up the registered provider → assert `model.api === api` → dispatch.
- Non-obvious design decisions: the file's own doc comment says it "is deleted with the coding-agent ModelManager migration" — it is a scheduled removal, not an accident.
- Edge cases / failure handling: a mismatched api throws immediately rather than sending a malformed request.
- Surprising: it re-exports `index.ts` wholesale, so the compat surface is a superset of the new one.

### packages/ai/src/compat/extension-oauth-types.ts
The legacy extension OAuth callback surface (`onAuth` / `onDeviceCode` / `onPrompt` / `onSelect` / `onManualCodeInput`), kept only for coding-agent extension compatibility.

### packages/ai/src/env-api-keys.ts
- Purpose: map a provider id to the env vars that can hold its API key, for discovery and status.
- Key abstractions: `ANTHROPIC_*_ENV` constants.
- Data flow: `getApiKeyEnvVars(provider)` → the provider's env var(s) → `findEnvKeys` → the ones that are actually set; `getEnvApiKey` additionally returns the `"<authenticated>"` sentinel for Vertex ADC and for any of six Bedrock ambient credential sources.
- Non-obvious design decisions: `ANTHROPIC_AUTH_TOKEN` participates in discovery but is **skipped** by `getEnvApiKey`, because that credential must be sent as `Authorization: Bearer`, not as an api key; ambient sources (AWS profiles, IAM, ADC) are deliberately excluded from `findEnvKeys`.
- Edge cases / failure handling: the Vertex ADC existence check is cached, but **only a browser result is cached permanently** — an unresolved node import race returns false without caching so the next call retries.
- Surprising: the `"<authenticated>"` sentinel is a *string* returned where an API key would be, and every consumer must special-case it.

### packages/ai/src/image-models.ts
Compat reads of the generated image catalog (`getImageModel` / `getImageProviders` / `getImageModels`), each marked deprecated in favour of `Models.getModelOfType("image", …)`.

### packages/ai/src/images-api-registry.ts
A registry mapping an image API id to its `generateImages` implementation; the wrapper asserts `model.api` matches the registered api before dispatch.

### packages/ai/src/images.ts
Global `generateImages()` that dispatches on `model.api` through the images registry; the doc comment says auth must be passed explicitly and that `Models.generateImages()` is the preferred route.

### packages/ai/src/index.ts
The side-effect-free public entrypoint: types, the event stream, transcript / validation / retry / overflow helpers, the auth contract and the `Models` collection — and deliberately **no** generated catalogs, provider factories, api-registry or OAuth implementations.

### packages/ai/src/legacy-api-aliases.ts
Deprecated flat aliases (`streamAnthropic`, `streamSimpleOpenAICompletions`, …), each pointing at the current lazy wrapper with a deprecation notice naming the replacement.

### packages/ai/src/model-catalog.ts
- Purpose: type the generated catalog.
- Key abstractions: `ChatModelCatalog` / `ImageModelCatalog` / `ClassifierModelCatalog`, keyed by model id with the api inferred from the JSON group.
- Data flow: `flattenChatModelCatalog(provider, groups)` → filter the groups by `type` → key by `id`.
- Non-obvious design decisions: the api type is derived from the *group key* in the JSON, so a model's wire protocol is a property of where it was filed, not of a separate field.
- Edge cases / failure handling: the flattening is a cast — the real validation lives in `scripts/model-data.ts`.
- Surprising: three parallel catalog types exist purely so a chat model and an image model with the same id cannot collide.

### packages/ai/src/models-store.ts
The `ModelsStore` contract for persisted dynamic catalogs (`models` / `lastModified` / `checkedAt` / `etag`) plus an in-memory implementation that `structuredClone`s on read and write.

### packages/ai/src/models.generated.ts
Auto-generated aggregator re-exporting every provider's `MODELS` / `IMAGE_MODELS` / `CLASSIFIER_MODELS` from the per-provider `.models.ts` shards; I read the import block, and the export block is the same pattern repeated for 40 providers.

### packages/ai/src/models.ts
- Purpose: the core abstraction — the `Provider` and `Models` interfaces and their implementation.
- Key abstractions: `Provider` (id, name, baseUrl, headers, `auth`, `getModels`, `getAllModels`, `refreshModels`, `filterModels`, `filterAllModels`, `stream`, `streamSimple`, `generateImages`, `classify`); `Models` (read accessors, `refresh`, `checkAuth`, `getAvailable`, `getAuth`, `login`, `logout`, `stream`/`complete`/`streamSimple`/`completeSimple`, deferred fetch/cancel); `MutableModels`; `ProviderStreams` / `ProviderImages` / `ProviderClassifier`.
- Data flow: `Models.stream(model, context, options)` → `normalizeContext` → `lazyStream` → `applyAuth` → provider dispatch. `Models.refresh()` → per provider: restore the stored catalog → resolve the credential → fetch and publish.
- Non-obvious design decisions:
  - **Generation-guarded refresh** (`:498-543`): each provider has a generation counter; a refresh that has been superseded must not publish. The check runs *before* the store write and *again* before the in-memory update, so a superseded refresh cannot overwrite a newer catalog with an older one. Publications are serialized through a per-provider promise chain.
  - **The restore phase runs before auth resolution and before the network** (`:590`), so the cached catalog is usable offline.
  - **Header merge order** (`:882-886`): session-affinity → auth headers → request headers → the caller's `transformHeaders` last. `mergeHeaders` deletes any same-named (case-insensitively) earlier key, so a later source wins rather than both being sent.
  - **`applyAuth` prefers explicit request options per field**, and the `Models`-only transform runs last.
  - **`createProvider` dispatches on `model.api`** (`:1106`), so one provider can serve several wire protocols; a model whose api has no entry produces a stream error rather than a crash.
  - **`filterAllModels` vs `filterModels`** (`:737-752`): the all-types filter falls back to filtering chat models by id and keeping every other type, so a provider that only implements `filterModels` still gets sensible behaviour for image and classifier models.
  - **Cost calculation is request-wide, not marginal** (`:1236-1256`): the highest matching pricing tier applies to the whole request, and Anthropic's 1-hour cache write is charged at 2× the input rate.
  - **`clampThinkingLevel` searches upward first, then downward** (`:1271-1290`), so an unsupported requested level prefers *more* thinking, not less.
- Edge cases / failure handling: `getModels` treats a throwing provider as having no models; `generateImages` and `classify` **never reject** — they return an error-shaped result; `login` refuses to be cancelled after the credential-store mutation has started; `refresh()` returns `{ aborted, errors }` instead of throwing.
- Surprising: `getAuth(model)` merges the model's own static headers into the resolved auth headers — a model entry can carry headers that the provider's auth does not.

### packages/ai/src/oauth.ts
Ten-line type-only compatibility entrypoint re-exporting the legacy extension OAuth types.

### packages/ai/src/providers/all.ts
- Purpose: register every built-in provider and expose typed reads of the generated catalog.
- Key abstractions: `BuiltinProvider` (= `keyof typeof MODELS`); the `getBuiltinModel` / `getBuiltinImageModel` / `getBuiltinClassifierModel` family.
- Data flow: `builtinProviders()` → construct every provider factory → `builtinModels(options)` → `createModels(options)` → `setProvider` for each.
- Non-obvious design decisions: the api map's type parameter is derived from the *catalog* (`CatalogApi<(typeof MODELS)[TProvider][TModelId]>`), so a model's api is a compile-time fact; `getBuiltinModelDataGeneratedAt()` reads the timestamp from `providers/data/.manifest.json` so the UI can show how fresh the catalog is.
- Edge cases / failure handling: `KnownProvider` additionally includes purely dynamic providers (radius) that have no static catalog entry.
- Surprising: `radiusProvider` is re-exported from here even though it is not one of the built-ins in the sense of having a catalog.

### packages/ai/src/providers/amazon-bedrock.models.ts
Generated shard: imports `src/providers/data/amazon-bedrock.json` and flattens it into the chat / image / classifier catalogs for the `amazon-bedrock` provider.

### packages/ai/src/providers/amazon-bedrock.ts
- Purpose: the Bedrock provider.
- Key abstractions: `bedrockAuth: ApiKeyAuth`.
- Data flow: `resolve` → a stored bearer token, else `AWS_BEARER_TOKEN_BEDROCK`, else a stored or ambient `AWS_PROFILE`, else AWS access keys, else an ECS task role (relative or full URI), else a web-identity token file.
- Non-obvious design decisions: the login offers three methods (bearer token / AWS profile / existing credential chain) and the credential-chain option stores **no key at all** — just an acknowledgement, so pi never copies ambient AWS credentials into its own store.
- Edge cases / failure handling: each ambient source is reported as a distinct `source` label ("AWS access keys", "ECS task role", "web identity token") so the status UI can say *why* the provider is configured.
- Surprising: a bare `{ type: "api_key" }` credential with no key is a valid stored credential meaning "use the ambient chain".

### packages/ai/src/providers/ant-ling.models.ts
Generated shard flattening `data/ant-ling.json` into the ant-ling catalogs.

### packages/ai/src/providers/ant-ling.ts
Ant Ling provider: an OpenAI-completions endpoint at `api.ant-ling.com/v1` with the `ANT_LING_API_KEY` env key.

### packages/ai/src/providers/anthropic.models.ts
Generated shard flattening `data/anthropic.json` into the anthropic catalogs.

### packages/ai/src/providers/anthropic.ts
- Purpose: the Anthropic provider.
- Key abstractions: `anthropicApiKeyAuth()`.
- Data flow: `resolve` → a stored key → `ANTHROPIC_AUTH_TOKEN` (returned as `Authorization: Bearer`) → `ANTHROPIC_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` → workload-identity federation ids.
- Non-obvious design decisions: the federation ids are returned as **provider env, not as auth**, because the doc comment says "The ids are provider config rather than auth"; federation is checked **last** so keys and `ANTHROPIC_AUTH_TOKEN` keep winning, matching the Anthropic SDK's own precedence.
- Edge cases / failure handling: all three federation env vars must be present — a partial set returns `undefined` (not configured) rather than a half-configured federation.
- Surprising: `ANTHROPIC_AUTH_TOKEN` yields *headers*, not an api key, and the Anthropic adapter has a `PiAnthropic` subclass to stop the SDK from resolving its own credentials behind pi's back.

### packages/ai/src/providers/azure.models.ts
Generated shard flattening `data/azure.json` into the azure catalogs.

### packages/ai/src/providers/azure.ts
- Purpose: the Azure provider.
- Key abstractions: `azureStreams(streams)` (a wrapper), `withDeploymentName`, `resolveAzureModel`.
- Data flow: `stream()` → `azureStreams` → `lazyStream` → resolve the endpoint → rewrite the payload's `model` field to the deployment name → dispatch.
- Non-obvious design decisions: **the deployment substitution happens in an `onPayload` hook**, so the adapter's own body-building is untouched; the whole resolution is inside `lazyStream`, so an unconfigured endpoint produces a stream error rather than a synchronous throw out of `stream()`.
- Edge cases / failure handling: `resolveDeploymentName` returns the model id unchanged when there is no mapping, so no rewrite happens at all.
- Surprising: Azure serves both the Responses API and plain completions, and the completions path gets the same deployment rewrite through a different mechanism.

### packages/ai/src/providers/baseten.models.ts
Generated shard flattening `data/baseten.json` into the baseten catalogs.

### packages/ai/src/providers/baseten.ts
Baseten provider: an OpenAI-completions endpoint at `inference.baseten.co/v1` with the `BASETEN_API_KEY` env key.

### packages/ai/src/providers/cerebras.models.ts
Generated shard flattening `data/cerebras.json` into the cerebras catalogs.

### packages/ai/src/providers/cerebras.ts
Cerebras provider: an OpenAI-completions endpoint at `api.cerebras.ai/v1` with the `CEREBRAS_API_KEY` env key. (Cerebras is also special-cased in the overflow detector for its bodyless 400/413.)

### packages/ai/src/providers/cloudflare-ai-gateway.models.ts
Generated shard flattening `data/cloudflare-ai-gateway.json` into the cloudflare-ai-gateway catalogs.

### packages/ai/src/providers/cloudflare-ai-gateway.ts
- Purpose: the Cloudflare AI Gateway provider.
- Key abstractions: `CloudflareAIGatewayApi` (three wire APIs).
- Data flow: `createProvider` with an api map of three entries, each wrapped by `cloudflareStreams`.
- Non-obvious design decisions: **the api map is pinned to all three APIs even when the generated catalog contains no `openai-completions` entry**, because the upstream gateway catalog drops and restores `workers-ai/*` entries over time and inference from `models` alone would reject the entry whenever the catalog happened to contain none.
- Edge cases / failure handling: the account/gateway placeholders are resolved by the wrapper, not here.
- Surprising: a comment that pins a whole provider shape to a *transient upstream catalog* bug — a good example of a decision recorded with its reason.

### packages/ai/src/providers/cloudflare-auth.ts
- Purpose: Cloudflare api-key auth for Workers AI and the AI Gateway.
- Key abstractions: `CloudflareAuthKind` (`workers-ai | ai-gateway`).
- Data flow: `resolveCloudflareEnv(kind, ctx, credential, signal)` → the key, the account id and (for the gateway) the gateway id, each merged **per field** from the credential then the env.
- Non-obvious design decisions: the per-field merge means a credential carrying only the API key still picks up the account and gateway ids from the environment; the gateway variant sends the key in `cf-aig-authorization` and sets `Authorization: null` and `x-api-key: null` so the SDKs' placeholder headers never reach the gateway, where a request-supplied auth header would be treated as a BYOK key that overrides the stored ones.
- Edge cases / failure handling: a missing account id (or gateway id) means "not configured" — `undefined`, not an error.
- Surprising: the same env vars serve two different transports, and the difference is only which headers are set.

### packages/ai/src/providers/cloudflare-stream.ts
Wraps an API implementation so `{CLOUDFLARE_ACCOUNT_ID}` and `{CLOUDFLARE_GATEWAY_ID}` placeholders in the base URL materialize from the resolved provider env before dispatch; the same wrapper exists for classifiers.

### packages/ai/src/providers/cloudflare-workers-ai.models.ts
Generated shard flattening `data/cloudflare-workers-ai.json` into the Workers AI chat and classifier catalogs.

### packages/ai/src/providers/cloudflare-workers-ai.ts
Cloudflare Workers AI provider: OpenAI-completions chat plus the System One classifier, both through the placeholder-resolving wrapper.

### packages/ai/src/providers/compat-schema.ts
- Purpose: the compat-flag vocabulary, as TypeBox schemas.
- Key abstractions: `OpenAICompletionsCompatSchema`, `OpenAIResponsesCompatSchema`, `AnthropicMessagesCompatSchema`, `BedrockCompatSchema`, `MistralConversationsCompatSchema`, `SystemOneCompatSchema`; `OpenRouterRoutingSchema`; `VercelGatewayRoutingSchema`; `CompatSchemasByApi`.
- Data flow: `mergeCompatProperties` unions every API's properties into the provider-level superset, and `CompatSchemasByApi` maps each API to its schema.
- Non-obvious design decisions: **every duplicate property requires an explicit generic override** — `mergeCompatProperties` throws "Duplicate compatibility schema property requires an override" if a name appears in two API schemas without a shared generic, and the reverse check throws if an override does not resolve a duplicate. That is a schema-level gate against drift between the API-specific descriptions.
- Edge cases / failure handling: every flag has a documented default, and the description states what auto-detection does when the flag is unset.
- Surprising: the descriptions are written as *sentences that state the consequence* ("Some Anthropic-compatible providers, such as Fireworks, do not support this field on tools and may reject or ignore it") — the schema is the documentation.

### packages/ai/src/providers/data-json.d.ts
Ambient declaration for `import … with { type: "json" }` so the generated catalog JSON files typecheck.

### packages/ai/src/providers/deepseek.models.ts
Generated shard flattening `data/deepseek.json` into the deepseek catalogs.

### packages/ai/src/providers/deepseek.ts
DeepSeek provider: an OpenAI-completions endpoint at `api.deepseek.com` with the `DEEPSEEK_API_KEY` env key.

### packages/ai/src/providers/faux.ts
- Purpose: a scriptable fake provider, used by tests and by the CLI's own harness.
- Key abstractions: `FauxResponseFactory` / `FauxResponseStep` (a message or a function of the context); `FauxProviderRegistration`; `FauxProviderState`.
- Data flow: `setResponses` / `appendResponses` queue the replies → `stream()` takes the next step → `streamWithDeltas` re-emits it as a realistic delta stream → `withUsageEstimate` attaches a computed usage.
- Non-obvious design decisions:
  - **The prompt cache is modelled by measuring the common prompt prefix** (`:228` `commonPromptPrefixLength`): the cached characters are the shared prefix of the previous and current prompts, so cache-read / cache-write / input split the way a real provider would bill it. A cache-aware harness can therefore be tested against a fake that behaves like a cache.
  - The delta stream splits text into random token-sized chunks and can simulate a `tokensPerSecond` rate, so a UI can be tested against realistic timing.
  - Tool-call arguments are streamed as JSON text and only assigned on `toolcall_end`, matching the real adapters.
- Edge cases / failure handling: an abort at any point produces an `aborted` error event with the partial content; a response with no stop reason throws.
- Surprising: the faux provider computes a *realistic* prompt-cache split — a small but genuinely valuable idea for testing cache accounting.
- Coverage caveat: I read lines 1–499 of 727; the registration tail was sampled.

### packages/ai/src/providers/fireworks.models.ts
Generated shard flattening `data/fireworks.json` into the fireworks catalogs.

### packages/ai/src/providers/fireworks.ts
Fireworks provider: serves both `anthropic-messages` and `openai-completions` from `api.fireworks.ai/inference` — the clearest example of one provider entry serving two wire protocols.

### packages/ai/src/providers/github-copilot.models.ts
Generated shard flattening `data/github-copilot.json` into the github-copilot catalogs.

### packages/ai/src/providers/github-copilot.ts
- Purpose: the GitHub Copilot provider.
- Key abstractions: `filterModels` (a credential-specific availability filter).
- Data flow: `createProvider` with three wire APIs and a `filterModels` hook that reads `credential.availableModelIds`.
- Non-obvious design decisions: the filter applies **only** to OAuth credentials; an api-key credential sees the full catalog. A malformed `availableModelIds` (not an array of strings) falls back to the full catalog rather than filtering everything away.
- Edge cases / failure handling: the set membership test is exact — a model absent from the account's list is hidden.
- Surprising: the model list comes from the OAuth credential, refreshed with the token — so availability is a property of the login, not of the catalog.

### packages/ai/src/providers/google-vertex.models.ts
Generated shard flattening `data/google-vertex.json` into the google-vertex catalogs.

### packages/ai/src/providers/google-vertex.ts
- Purpose: the Google Vertex AI provider.
- Key abstractions: `vertexAuth: ApiKeyAuth`.
- Data flow: `resolve` → a stored or ambient API key → else the ADC file must exist **and** a project and a location must be known → the result carries the project/location in provider env.
- Non-obvious design decisions: the ADC check uses `ctx.fileExists` (which expands `~`) so the default `~/.config/gcloud/application_default_credentials.json` path is honoured; the location is required even for ADC, because the SDK needs it.
- Edge cases / failure handling: a missing piece yields `undefined` (not configured) rather than a partial configuration.
- Surprising: the credential stores the project and location as **provider env**, so a single credential can serve several Vertex deployments.

### packages/ai/src/providers/google.models.ts
Generated shard flattening `data/google.json` into the google catalogs.

### packages/ai/src/providers/google.ts
Google provider: the Gemini API at `generativelanguage.googleapis.com/v1beta` with the `GEMINI_API_KEY` env key.

### packages/ai/src/providers/groq.models.ts
Generated shard flattening `data/groq.json` into the groq catalogs.

### packages/ai/src/providers/groq.ts
Groq provider: an OpenAI-completions endpoint at `api.groq.com/openai/v1` with the `GROQ_API_KEY` env key.

### packages/ai/src/providers/huggingface.models.ts
Generated shard flattening `data/huggingface.json` into the huggingface catalogs.

### packages/ai/src/providers/huggingface.ts
Hugging Face provider: the router endpoint at `router.huggingface.co/v1` with `HF_TOKEN` as the key.

### packages/ai/src/providers/images/register-builtins.ts
Registers the built-in image APIs (currently only `openrouter-images`) into the images registry; the OpenRouter implementation is loaded lazily and a load failure becomes an error image result rather than a rejection.

### packages/ai/src/providers/kimi-coding.models.ts
Generated shard flattening `data/kimi-coding.json` into the kimi-coding catalogs.

### packages/ai/src/providers/kimi-coding.ts
Kimi For Coding provider: both an API key and the Kimi Code subscription OAuth, served by the OpenAI-completions adapter.

### packages/ai/src/providers/meta.models.ts
Generated shard flattening `data/meta.json` into the meta catalogs.

### packages/ai/src/providers/meta.ts
Meta provider: OpenAI Responses at `api.meta.ai/v1` with an API key or the Meta (Muse subscription) OAuth.

### packages/ai/src/providers/minimax-cn.models.ts
Generated shard flattening `data/minimax-cn.json` into the minimax-cn catalogs.

### packages/ai/src/providers/minimax-cn.ts
MiniMax CN provider: the Anthropic-compatible endpoint at `api.minimaxi.com/anthropic`.

### packages/ai/src/providers/minimax.models.ts
Generated shard flattening `data/minimax.json` into the minimax catalogs.

### packages/ai/src/providers/minimax.ts
MiniMax provider: the Anthropic-compatible endpoint at `api.minimax.io/anthropic`.

### packages/ai/src/providers/mistral.models.ts
Generated shard flattening `data/mistral.json` into the mistral catalogs.

### packages/ai/src/providers/mistral.ts
Mistral provider: the native `mistral-conversations` API at `api.mistral.ai` — the only provider that uses a bespoke wire adapter rather than an OpenAI-compatible one.

### packages/ai/src/providers/model-schema.ts
- Purpose: the catalog field schemas.
- Key abstractions: `ModelCostSchema` (rates plus request-wide tiers), `ModelPromptCacheSchema` (the short/long retention lifetimes in seconds), `ModelInputLimitsSchema` (max request bytes and the image limits).
- Data flow: `TypeBox` schemas → the JSON-schema validators → the generator's per-model metadata.
- Non-obvious design decisions: the prompt-cache schema stores a **lifetime in seconds**, because pi warms only tiers with a known lifetime; the image input limits carry a "cache-safe resize profile", i.e. the resize that must happen *before* the image enters the conversation history so the prefix stays cacheable.
- Edge cases / failure handling: `exclusiveMinimum: 0` on the cache lifetimes; the resize options are all optional and bounded (`jpegQuality` 1–100).
- Surprising: `THINKING_LEVELS` and `MODEL_THINKING_LEVELS` differ by exactly one member — `off` — and the distinction is that `off` is a *model* thinking level while `minimal`…`max` are the request levels.

### packages/ai/src/providers/moonshotai-cn.models.ts
Generated shard flattening `data/moonshotai-cn.json` into the moonshotai-cn catalogs.

### packages/ai/src/providers/moonshotai-cn.ts
Moonshot AI CN provider: an OpenAI-completions endpoint at `api.moonshot.cn/v1` that shares the `MOONSHOT_API_KEY` env var name with the international one.

### packages/ai/src/providers/moonshotai.models.ts
Generated shard flattening `data/moonshotai.json` into the moonshotai catalogs.

### packages/ai/src/providers/moonshotai.ts
Moonshot AI provider: an OpenAI-completions endpoint at `api.moonshot.ai/v1`.

### packages/ai/src/providers/nvidia.models.ts
Generated shard flattening `data/nvidia.json` into the nvidia catalogs.

### packages/ai/src/providers/nvidia.ts
NVIDIA provider: the NIM endpoint at `integrate.api.nvidia.com/v1` with the `NVIDIA_API_KEY` env key (NIM is also given a dedicated attribution header, `X-BILLING-INVOKE-ORIGIN`).

### packages/ai/src/providers/openai-codex.models.ts
Generated shard flattening `data/openai-codex.json` into the openai-codex catalogs.

### packages/ai/src/providers/openai-codex.ts
OpenAI Codex (legacy) provider: OAuth only, baseUrl `chatgpt.com/backend-api`, served by the `openai-codex-responses` adapter — the only provider with **no** api-key path.

### packages/ai/src/providers/openai.models.ts
Generated shard flattening `data/openai.json` into the openai chat, image and classifier catalogs.

### packages/ai/src/providers/openai.ts
- Purpose: the OpenAI provider.
- Key abstractions: `filterAllModels`.
- Data flow: `createProvider` with the Responses API, the Decisions classifier and the catalog.
- Non-obvious design decisions: **a ChatGPT subscription credential hides the classifier models**, because "Sign in with ChatGPT tokens only reach the Responses API; the Decisions API rejects them" — the filter is a capability statement about the credential, not about the catalog.
- Edge cases / failure handling: an api-key credential sees every model.
- Surprising: the filter lives on the *provider*, so a models.json override inherits it.

### packages/ai/src/providers/opencode-go.models.ts
Generated shard flattening `data/opencode-go.json` into the opencode-go catalogs.

### packages/ai/src/providers/opencode-go.ts
OpenCode Go provider: four wire APIs, all wrapped with the OpenCode per-conversation session header.

### packages/ai/src/providers/opencode-headers.ts
Adds OpenCode's required `x-opencode-session` routing header from `options.sessionId` before dispatch, without overwriting a caller-supplied one (the check is case-insensitive).

### packages/ai/src/providers/opencode.models.ts
Generated shard flattening `data/opencode.json` into the opencode catalogs.

### packages/ai/src/providers/opencode.ts
OpenCode Zen provider: four wire APIs, all wrapped with the session header, plus the System One classifier at `/zen/v1/systemone`.

### packages/ai/src/providers/openrouter-api.ts
- Purpose: convert OpenRouter's pricing into pi's `ModelCost`.
- Key abstractions: `OpenRouterPricing` (with `overrides`); `OpenRouterPricingOverride` (`min_prompt_tokens`, `utc_start`, `utc_end`, `utc_days`).
- Data flow: `openRouterCost(pricing)` → base $/1M rates → the prompt-length overrides become `ModelCostTier`s; the time-of-day overrides are skipped.
- Non-obvious design decisions: **a negative price is the fallback, not a discount** — OpenRouter reports `-1` for router models such as `openrouter/auto` whose price depends on the model they pick, so `perMillion` treats anything below zero as "unknown" and uses the fallback; a tier that does not list a rate keeps the base rate for that rate.
- Edge cases / failure handling: a missing or unparseable price is 0 (free), not NaN.
- Surprising: the time-of-day overrides are dropped with an explicit reason — `ModelCost` cannot express them — rather than approximated.

### packages/ai/src/providers/openrouter.models.ts
Generated shard flattening `data/openrouter.json` into the openrouter chat, image and classifier catalogs.

### packages/ai/src/providers/openrouter.ts
- Purpose: the OpenRouter provider, plus the per-account catalog personalization.
- Key abstractions: `personalizeOpenRouterCatalog(catalog, context)`.
- Data flow: `GET /models/user` with the key → the allowed ids, context window and pricing → the catalog is rewritten with the account's limits.
- Non-obvious design decisions: **image and classifier models are returned unchanged** — the endpoint only reports chat models; a 401/403/404 from the endpoint returns the catalog unchanged rather than failing, because a proxy in models.json may not implement it; the request uses the provider's *configured* base URL so a regional endpoint filters by its own region.
- Edge cases / failure handling: a chat model absent from the allowed list is **dropped**; `||` is used deliberately so a missing limit (absent, null or 0) keeps the catalog value.
- Surprising: the endpoint is `/models/user`, not `/models` — the personal list is a different resource.

### packages/ai/src/providers/qwen-token-plan-cn.models.ts
Generated shard flattening `data/qwen-token-plan-cn.json` into the qwen-token-plan-cn catalogs.

### packages/ai/src/providers/qwen-token-plan-cn.ts
Qwen Token Plan CN provider: the Aliyun compatible-mode endpoint in `cn-beijing`.

### packages/ai/src/providers/qwen-token-plan-individual.models.ts
Generated shard flattening `data/qwen-token-plan-individual.json` into the qwen-token-plan-individual catalogs.

### packages/ai/src/providers/qwen-token-plan-individual.ts
Qwen Token Plan Individual provider: the same `ap-southeast-1` compatible-mode endpoint as the plan provider, but with a separate model list and its own env var name.

### packages/ai/src/providers/qwen-token-plan.models.ts
Generated shard flattening `data/qwen-token-plan.json` into the qwen-token-plan catalogs.

### packages/ai/src/providers/qwen-token-plan.ts
Qwen Token Plan provider: the Aliyun compatible-mode endpoint in `ap-southeast-1`.

### packages/ai/src/providers/radius-config.ts
- Purpose: the Radius gateway's configuration and catalog shape.
- Key abstractions: `RadiusGatewayConfig`; `RadiusGatewayModel`; `RadiusOAuthCredential` (the credential with an embedded gateway config).
- Data flow: `loadRadiusGatewayConfig(gateway, apiKey, signal)` → `GET /v1/config` → `sanitizeRadiusGatewayConfig` → `getRadiusModelsFromConfig` → `Model<"pi-messages">[]` with the gateway's baseUrl.
- Non-obvious design decisions: the payload is validated **entry by entry** (`isRadiusGatewayModel`), and an invalid entry is dropped rather than failing the whole config; the credential can carry the gateway config inline, which is how the pre-`ModelsStore` catalog survives a migration.
- Edge cases / failure handling: an HTTP failure truncates the body to 512 chars; a structurally invalid config throws "Invalid Radius config".
- Surprising: the provider id is stamped onto the models at read time, so the same gateway config serves a differently-named provider.

### packages/ai/src/providers/radius.models.ts
Generated shard flattening `data/radius.json` into the radius catalogs.

### packages/ai/src/providers/radius.ts
- Purpose: the Radius provider — a **hand-written** `Provider` rather than a `createProvider` product.
- Key abstractions: `RadiusProviderOptions` (id, name, gateway).
- Data flow: `refreshModels(context)` → restore the stored catalog → (if no store entry) import the legacy credential-embedded catalog → fetch `/v1/config` → publish `{ persist, update }`.
- Non-obvious design decisions: **the dynamic catalog replaces the shipped baseline rather than overlaying it**, because a Radius org owner can disable models — the baseline only covers the time before any catalog exists; the publish goes through `context.publish()`, so it is generation-checked like every other provider.
- Edge cases / failure handling: a non-default gateway starts with **no** baseline models at all; the legacy import path only runs when there is no stored entry and the credential is OAuth.
- Surprising: this is the one provider that has to implement the publish protocol by hand, and doing so shows why the protocol exists.

### packages/ai/src/providers/together.models.ts
Generated shard flattening `data/together.json` into the together catalogs.

### packages/ai/src/providers/together.ts
Together provider: an OpenAI-completions endpoint at `api.together.ai/v1`.

### packages/ai/src/providers/typesafe.models.ts
Generated shard flattening `data/typesafe.json` into the typesafe catalogs.

### packages/ai/src/providers/typesafe.ts
TypeSafe provider: classifier-only — it exposes the `typesafe-system-one` API and no chat implementation at all.

### packages/ai/src/providers/vercel-ai-gateway.models.ts
Generated shard flattening `data/vercel-ai-gateway.json` into the vercel-ai-gateway catalogs.

### packages/ai/src/providers/vercel-ai-gateway.ts
Vercel AI Gateway provider: `anthropic-messages` chat plus the TypeSafe System One classifier at `/typesafe/v1/systemone`.

### packages/ai/src/providers/xai.models.ts
Generated shard flattening `data/xai.json` into the xai catalogs.

### packages/ai/src/providers/xai.ts
xAI provider: OpenAI Responses at `api.x.ai/v1` with an API key or the SuperGrok / X Premium subscription OAuth.

### packages/ai/src/providers/xiaomi-token-plan-ams.models.ts
Generated shard flattening `data/xiaomi-token-plan-ams.json` into the xiaomi-token-plan-ams catalogs.

### packages/ai/src/providers/xiaomi-token-plan-ams.ts
Xiaomi Token Plan AMS provider: the `token-plan-ams.xiaomimimo.com` compatible-mode endpoint.

### packages/ai/src/providers/xiaomi-token-plan-cn.models.ts
Generated shard flattening `data/xiaomi-token-plan-cn.json` into the xiaomi-token-plan-cn catalogs.

### packages/ai/src/providers/xiaomi-token-plan-cn.ts
Xiaomi Token Plan CN provider: the `token-plan-cn.xiaomimimo.com` compatible-mode endpoint.

### packages/ai/src/providers/xiaomi-token-plan-sgp.models.ts
Generated shard flattening `data/xiaomi-token-plan-sgp.json` into the xiaomi-token-plan-sgp catalogs.

### packages/ai/src/providers/xiaomi-token-plan-sgp.ts
Xiaomi Token Plan SGP provider: the `token-plan-sgp.xiaomimimo.com` compatible-mode endpoint.

### packages/ai/src/providers/xiaomi.models.ts
Generated shard flattening `data/xiaomi.json` into the xiaomi catalogs.

### packages/ai/src/providers/xiaomi.ts
Xiaomi provider: the MiMo compatible-mode endpoint at `api.xiaomimimo.com/v1`.

### packages/ai/src/providers/zai-coding-cn.models.ts
Generated shard flattening `data/zai-coding-cn.json` into the zai-coding-cn catalogs.

### packages/ai/src/providers/zai-coding-cn.ts
Z.AI Coding CN provider: the `open.bigmodel.cn` coding paas endpoint.

### packages/ai/src/providers/zai.models.ts
Generated shard flattening `data/zai.json` into the zai catalogs.

### packages/ai/src/providers/zai.ts
Z.AI provider: the `api.z.ai` coding paas endpoint.

### packages/ai/src/session-resources.ts
A registry of per-session cleanup callbacks (used by the Codex WebSocket cache) that runs every callback and aggregates the failures into one `AggregateError`.

### packages/ai/src/telemetry.ts
- Purpose: the observability schema and the request observer.
- Key abstractions: `AI_TELEMETRY_SCHEMA` (spans `pi.ai.request` / `pi.ai.poll`; histograms for request duration and first-chunk latency; counters for tokens and cost); `observeModelRequest`.
- Data flow: `Models.stream` passes `observeModelRequest(model, options, poll)` as the `lazyStream` observer → `onEvent` records the first chunk, per-block events and the tool-call character count → `onResult` sets the span attributes (stop reason, usage, cost, response id), sets an error status for a `stopReason: "error"` (bounded to 500 characters) and records the metrics.
- Non-obvious design decisions: **content is never recorded** — a block event carries only the type, the index and a UTF-16 character count (plus the tool name for tool calls). The tool-call character count is accumulated from the deltas so the number is the streamed size, not the serialized size. Pending and deferred-poll results are excluded from the token and cost counters.
- Edge cases / failure handling: an aborted request stays status "ok" (aborting is not an error); the error message is truncated to 500 chars so a provider's HTML error page cannot blow up the span.
- Surprising: the instrumentation instruments are cached in a `WeakMap` keyed by the metrics adapter, so creating them per request would be wasteful but leaking them would be a leak.

### packages/ai/src/types.ts
- Purpose: the canonical type vocabulary — the contract every adapter and every consumer agrees on.
- Key abstractions: `SystemMessage` (with `sections` and tool deltas), `UserMessage`, `AssistantMessage` (content, usage, stop reason, `providerThinkingLevel`, `thinkingLevel`, diagnostics, `durationMs`), `ToolResultMessage`, `Message`; `AssistantMessageEvent` (the stream protocol); `Model` / `ImageModel` / `ClassifierModel` / `ModelTypeMap`; `ProviderRequestOptions` / `StreamOptions` / `SimpleStreamOptions`.
- Data flow: not a runtime module — it is the type-level spine.
- Non-obvious design decisions:
  - **`TranscriptContext` is branded** (`:785-796`): a `unique symbol` brand means only `normalizeContext()` can produce one, so a raw `Context` cannot reach a provider by accident.
  - **The system message carries the prompt *and* the tool set *and* named sections** (`:554-570`): replaying every system message in order yields the current prompt and tools. Later system messages change the prompt, replace or remove a named section, and add or remove tools.
  - **`ToolCall.argumentsError`** (`:452-457`): a field that exists precisely so malformed arguments are *reported* rather than silently executed as `{}`.
  - **`StopReason` includes `"deferred"`** — a response can be a durable handle rather than an answer.
  - `Api = KnownApi | (string & {})` — a known union that still accepts any string, so a custom API id type-checks without losing autocomplete.
  - `JsonRepresentation<T>` computes the JSON shape of a typed value and is used to constrain `ToolResultMessage`'s `details`.
- Edge cases / failure handling: `AssistantMessage.durationMs` is measured with a monotonic clock and set by the stream, not the provider.
- Surprising: `ProviderHeaders` uses `null` to mean "suppress this default header" — a three-valued header type.

### packages/ai/src/utils/abort-signals.ts
`combineAbortSignals()` merges several signals into one and returns a `cleanup()` that removes every listener it added.

### packages/ai/src/utils/abort.ts
- Purpose: the two abort primitives every public API uses.
- Key abstractions: `operationSignal(signal?)`; `raceWithAbortSignal(operation, signal)`.
- Data flow: `operationSignal` gives an optional public signal a non-aborted default; `raceWithAbortSignal` rejects with the signal's reason when the signal aborts, while still observing the abandoned promise.
- Non-obvious design decisions: **the abandoned promise is still observed** (`void operation.catch(() => {})`) so a later rejection is always handled — otherwise an aborted request would produce an unhandled rejection.
- Edge cases / failure handling: an already-aborted signal rejects immediately; `abortReason` falls back to a synthetic `AbortError` when the signal has no reason.
- Surprising: `raceWithAbortSignal` is used by `Models` for *every* auth and refresh operation, so abort semantics are uniform across the package.

### packages/ai/src/utils/diagnostics.ts
Small helpers for the redacted diagnostics array carried on `AssistantMessage`: `formatThrownValue`, `extractDiagnosticError` (name, message, stack, code) and `appendAssistantMessageDiagnostic`.

### packages/ai/src/utils/error-body.ts
- Purpose: one place that turns an SDK's error object into a status, a body and a display string.
- Key abstractions: `NormalizedProviderError` (`status`, `body`, `message`, `messageCarriesBody`).
- Data flow: `normalizeProviderError(error)` → `extractStatus` (Mistral `statusCode` → openai/`@google/genai` `status` → Bedrock `$metadata.httpStatusCode` → `$response.statusCode`) → `extractBody` (Mistral `body` string → openai `error` object → Bedrock `$response.body`) → `formatProviderError(norm, prefix?)`.
- Non-obvious design decisions: **only a plain object counts as an HTTP body** (`:112`): AWS SDK v3's `$response.body` is a stream/response wrapper, and stringifying one produced garbage like `{"_events":…}` as the "body", which then **replaced** `error.message` — the one useful string — so the class-instance check exists to keep the real message. The `messageCarriesBody` flag preserves the Anthropic / `@google/genai` happy path where the SDK already folded the body into the message, so it is not printed twice.
- Edge cases / failure handling: the body is truncated at 4000 chars with the truncation count appended; a non-`Error` throw is `safeJsonStringify`d.
- Surprising: the file's header comment states the problem in the provider's own words ("403 status code (no body)", "Unknown: UnknownError") — the two symptoms this module exists to remove.

### packages/ai/src/utils/estimate.ts
- Purpose: estimate the context size without asking the provider.
- Key abstractions: `ContextUsageEstimate` (`tokens`, `usageTokens`, `trailingTokens`, `lastUsageIndex`).
- Data flow: `estimateContextTokens(context)` → find the last usable assistant usage → add the estimated tokens of every message after it; with no usage, estimate everything.
- Non-obvious design decisions: **the anchor is invalidated by a newer prefix message** (`:79-81`): "A newer prefix message was inserted after this response (for example, a compaction summary), so its usage cannot describe the current prefix." A compaction therefore resets the estimate to a full estimate rather than trusting a stale usage block. Aborted and errored assistant messages are never anchors.
- Edge cases / failure handling: `usage.totalTokens` is preferred over the component sum; the character-to-token ratio is a flat 3.5 and an image counts as 4800 characters.
- Surprising: the estimator deliberately prefers a *provider-reported* number for the prefix and only estimates the tail — the estimate is therefore only as good as the tail.

### packages/ai/src/utils/event-stream.ts
- Purpose: the event stream every adapter returns.
- Key abstractions: `EventStream<T, R>` (a FIFO queue + async iterator + a final-result promise); `AssistantMessageEventStream`; `createAssistantMessageEventStream`.
- Data flow: the adapter pushes `start` / `*_start` / `*_delta` / `*_end` / `done` / `error`; the consumer iterates or awaits `result()`.
- Non-obvious design decisions: the queue is a **two-ended FIFO** (an incoming stack and an outgoing stack) so enqueue and dequeue are both O(1); `push` after `done` is ignored; the terminal event resolves the result promise; `AssistantMessageEventStream` stamps `durationMs` from `performance.now()` — a monotonic clock — on the terminal message, but only if the message has no duration and its `timestamp` is not older than the stream's creation.
- Edge cases / failure handling: `end(result?)` resolves an explicit result when the adapter wants to end without a terminal event.
- Surprising: the monotonic-clock rule means a deferred result fetched later is deliberately left untimed ("a stream that forwards a response which started elsewhere leaves it untimed").

### packages/ai/src/utils/hash.ts
`shortHash` — a two-lane FNV-style hash producing a short base36 string, used to shorten tool-call and item ids that exceed a provider's length limit.

### packages/ai/src/utils/headers.ts
`headersToRecord` and `providerHeadersToRecord`; the latter merges header sources case-insensitively and treats a `null` value as a suppression of that default.

### packages/ai/src/utils/identity.ts
- Purpose: how pi identifies the calling app to providers.
- Key abstractions: `UserAgentMode` (`short | detailed | { custom }`); `ClientIdentity`; `ClientAttribution`; `ClientIdentityTarget`.
- Data flow: `mergeClientIdentity(...)` (field by field, later sources win) → `formatUserAgent` → `getAttributionHeaders(target, identity)` → per-provider header names; `withClientIdentity(models, identity)` wraps a `Models` collection.
- Non-obvious design decisions: **the attribution header names are provider-specific** — OpenRouter wants `HTTP-Referer` + `X-OpenRouter-Title` + `X-OpenRouter-Categories`, NVIDIA wants a capitalized `X-BILLING-INVOKE-ORIGIN` (`name.charAt(0).toUpperCase() + …`), OpenCode wants `x-opencode-client`; a null attribution also turns off attribution set by a merged identity.
- Edge cases / failure handling: an empty attribution returns no headers at all; `matchesHost` catches URL parse errors and returns false.
- Surprising: `withClientIdentity` wraps ~25 methods of the `Models` interface by hand — the price of not using a proxy.

### packages/ai/src/utils/json-parse.ts
- Purpose: parse tool arguments without ever executing them as `{}`.
- Key abstractions: `repairJson(json)`; `parseJsonWithRepair`; `parseToolCallArguments`; `parseStreamingJson`.
- Data flow: `parseToolCallArguments(text)` → `parseJsonWithRepair` → on failure, `{ arguments: {}, argumentsError: "<message>\n\nReceived arguments:\n<text>" }`; `parseStreamingJson` falls back to `partial-json` and then to a repaired partial.
- Non-obvious design decisions: **`repairJson` is a scanner, not a regex** (`:33`): it tracks whether it is inside a string, escapes raw control characters, leaves a valid `\uXXXX` alone, and **doubles a backslash only when the next character is not a valid JSON escape** — so a Windows path (`C:\new\file`) written with single backslashes is repaired, while a body whose escapes are all valid is left untouched.
- Edge cases / failure handling: a parsed value that is not a plain object (an array, a number, `null`) is an error, not an empty object; `parseStreamingJson` never throws — it returns `{}`.
- Surprising: `repairJson` preserves the trailing `"` correctly by tracking `inString` — a naive `"` search would break on an escaped quote.

### packages/ai/src/utils/model-operations.ts
Model-type helpers: models without `type` are chat models; `getModelType` / `isModelType` / `assertChatModel` / `assertImageModel` / `assertClassifierModel` / `assertClassifierInputSupported`; and the `imageErrorResult` / `classifierErrorResult` builders used by the never-rejecting paths.

### packages/ai/src/utils/models-error.ts
`ModelsError` with a code (`model_source` / `model_validation` / `provider` / `stream` / `auth` / `oauth`); the cause detail is folded into the message because callers surface `error.message` only.

### packages/ai/src/utils/node-http-proxy.ts
- Purpose: resolve the HTTP/HTTPS proxy for a target URL.
- Key abstractions: `DEFAULT_PROXY_PORTS`; `parseNoProxyEntry`.
- Data flow: `resolveHttpProxyUrlForTarget(url, env)` → `getProxyForUrl` → `shouldProxyHostname` (full `no_proxy` parsing: wildcards, `*.` suffixes, ports, bracket-wrapped IPv6) → the proxy URL, or `undefined`.
- Non-obvious design decisions: **SOCKS and PAC proxy URLs are refused with an explicit message** (`UNSUPPORTED_PROXY_PROTOCOL_MESSAGE`) rather than being silently ignored, because a user who configured one wants to know it is not in effect; `no_proxy` matching is per-entry, and every entry must match for the proxy to apply.
- Edge cases / failure handling: an invalid proxy URL throws naming the URL; a bracket-wrapped host is unwrapped for comparison.
- Surprising: the provider-scoped `env` is consulted **before** `process.env`, so a per-provider proxy overrides the global one.

### packages/ai/src/utils/oauth-page.ts
Self-contained dark-themed success/failure HTML for the OAuth callback page, with every interpolated value HTML-escaped (`&`, `<`, `>`, `"`, `'`).

### packages/ai/src/utils/overflow.ts
- Purpose: decide whether a failed (or suspiciously successful) response is a context overflow.
- Key abstractions: `OVERFLOW_PATTERNS` (≈25 provider shapes); `NON_OVERFLOW_PATTERNS`.
- Data flow: `isContextOverflow(message, contextWindow?)` → pattern match on `errorMessage` → then the silent-overflow check → then the length-stop check.
- Non-obvious design decisions: **three detection modes** (`:142`): (1) an error whose text matches a provider pattern; (2) **silent overflow** — a `stopReason: "stop"` whose `usage.input + cacheRead` exceeds the context window (z.ai accepts the over-long input); (3) a **length stop with zero output** and a full context window (Xiaomi MiMo truncates the input, leaving no room to generate). The exclusion list is checked first, because Bedrock's "ThrottlingException: Too many tokens, please wait before trying again" would otherwise match the overflow pattern `/too many tokens/i`.
- Edge cases / failure handling: HTTP 413 is treated as request-size overflow regardless of the body; Cerebras's bodyless `400 (no body)` has its own pattern; `isRecoverableLength(message, desiredMaxOutput)` distinguishes a length stop that ended below the intended output limit — the signal for one bounded compact-and-retry attempt.
- Surprising: the doc comment states per provider which detection is *unreliable* — z.ai, Xiaomi MiMo and Ollama — and says outright that silent Ollama truncation cannot be detected here.

### packages/ai/src/utils/provider-env.ts
Provider env lookup order: scoped overrides, then `process.env`, then a `/proc/self/environ` fallback for Bun binaries whose `process.env` is empty inside a Linux sandbox — with the duplication of `restoreSandboxEnv()` explained and justified by the package being usable directly.

### packages/ai/src/utils/provider-retry.ts
- Purpose: reproduce the OpenAI/Anthropic SDK retry policy with an **interruptible** sleep.
- Key abstractions: `ProviderError` (an Error carrying `status` and `headers`).
- Data flow: `retryProviderRequest(request, options)` → attempt → on a provider error, decide retryability → `getRetryDelayMs` → `abortableSleep` → retry.
- Non-obvious design decisions:
  - **The SDK's own retry is disabled** (`maxRetries: 0` at the call site) because the SDK's backoff timer ignores the request's `AbortSignal` — pi reimplements the policy so a cancel interrupts the wait.
  - **A server-requested delay above `maxRetryDelayMs` fails immediately** (`validateServerRetryDelayMs`, `:39`) with a message naming both the requested and the maximum; the default cap is 60 s and `0` disables it.
  - **`x-should-retry` overrides the status decision** (`:26-28`) in both directions.
  - `retry-after-ms` is preferred over `retry-after`, and `retry-after` is parsed as seconds or as an HTTP date.
- Edge cases / failure handling: the exponential fallback is `min(0.5 · 2ⁿ, 8)` seconds with a 25 % jitter; `noRetryStatuses` lets a caller exclude a status the default policy would retry.
- Surprising: the file's doc comment says "review when either SDK is upgraded" — the policy is pinned to a specific SDK version on purpose.

### packages/ai/src/utils/retry.ts
- Purpose: two retry layers — the transport-level one (`provider-retry.ts`) and the assistant-message one here.
- Key abstractions: `RetryPolicy` (`enabled`, `maxRetries`, `baseDelayMs`, `maxAgentDelayMs`); `RetryCallbacks`.
- Data flow: `retryAssistantCall(produce, policy, signal, callbacks)` → call → classify the result → sleep → retry; `isRetryableAssistantError(message)` decides.
- Non-obvious design decisions: **the non-retryable list is checked first** (`:269`) — a 429 that is really a quota or billing exhaustion ("insufficient_quota", "quota exceeded", "billing", "Monthly usage limit reached", the ChatGPT subscription limits) must fail fast, because retrying it just burns the budget; the retryable list then covers transient transport text ("overloaded", "server_busy", "rate.?limit", "socket hang up", "getaddrinfo", "ENOTFOUND", the gRPC "ResourceExhausted", the Codex "stream disconnected before completion") — matched against **text**, not status codes, because the provider's own wording is the only signal available.
- Edge cases / failure handling: an abort is terminal and is never retried, and an abort *during* the backoff sleep is normalised to the same `aborted` assistant message shape; `onRetryScheduled` / `onRetryAttemptStart` / `onRetryFinished` let the caller show the wait.
- Surprising: the status-code arm uses a lookaround (`(?<![a-z0-9])(?:429|500|…)(?![a-z0-9])`) so a request id like `#11057` is not read as an HTTP 500.

### packages/ai/src/utils/sanitize-unicode.ts
Removes unpaired UTF-16 surrogates, which otherwise cause JSON serialization errors at several providers, while correctly paired emoji are preserved.

### packages/ai/src/utils/sleep.ts
A 14-line abortable sleep that rejects with `signal.reason`.

### packages/ai/src/utils/text.ts
`contentText` and the system-message renderers: `getSystemMessageText` joins the content and the sections; `renderSystemMessageUpdate` frames a later system message by section name (`Updated system prompt section "name": …`, `Removed system prompt section "name".`) so the model can relate an update to the original — the doc comment notes this framing is request-time only and may change between versions.

### packages/ai/src/utils/transcript.ts
- Purpose: the transcript algebra — how a message list becomes a prompt and a tool set.
- Key abstractions: `TranscriptContext` (re-exported); `TranscriptToolSupport` (`"none" | "additions" | "changes"`); `TranscriptTools`.
- Data flow: `normalizeContext(context)` → a branded `TranscriptContext`; `getCurrentTools(messages)` → the tool set after every delta; `getCurrentSystemMessage(messages)` → the replayed prompt; `resolveTranscript(context, supportsMidConvoSystemMessages)` → collapse or keep; `resolveTranscriptTools(messages, support)` → the split.
- Non-obvious design decisions:
  - **System messages are a delta stream, not a list of prompts** (`:73-96`): replaying every system message yields the current prompt (content joined) and the current sections (patched by name, `null` removes one) and the current tools (added/removed by name).
  - **`resolveTranscriptTools` splits declarations per transport capability** (`:252`): `"none"` puts the current tool set in the top-level list; `"changes"` puts **nothing** in the top-level list (every tool is declared in place); `"additions"` puts the tool state *after the last non-additive change* in the top-level list, so the cached prefix is invalidated once per removal instead of once per later addition.
  - **A redeclaration counts as non-additive even after a removal** (`:206-207`): "Kimi K3 ignores a removed tool that a later tool message declares again (verified October 2026)".
  - `declarationsEqual` compares the JSON of the declaration (after a round trip that drops typebox symbols and `undefined`), which avoids a deep-equal dependency in a browser-safe package.
- Edge cases / failure handling: `hasToolRedefinitions` is deprecated — no built-in transport needs it, since Anthropic expresses redefinitions with inline `tool_definition` blocks.
- Surprising: the tool-change model is a *first-class transcript concept* — the tool set is part of the conversation, not part of the request options.

### packages/ai/src/utils/typebox-helpers.ts
`StringEnum` builds a plain string-enum JSON schema (not TypeBox's `anyOf`/`const` form) for providers that reject those patterns.

### packages/ai/src/utils/uuid.ts
`uuidv7` — a time-ordered id with a monotonic timestamp guard (a clock that goes backwards does not reorder ids) and a 41-bit sequence that throws when exhausted; an explicit timestamp is preserved so follower ids can share a timestamp.

### packages/ai/src/utils/version.ts
Two-line constant `PI_AI_VERSION = "1.4.0"`, kept in sync with `package.json` by `scripts/sync-versions.js`.

### packages/ai/src/utils/validation.ts
- Purpose: validate and coerce a tool call's arguments against its TypeBox schema.
- Key abstractions: `validatorCache` (a `WeakMap` from schema object to compiled validator).
- Data flow: `validateToolArguments(tool, toolCall)` → reject if `toolCall.argumentsError` is set → `structuredClone` the arguments → `normalizeOptionalNulls` → `Value.Convert` → (for a non-TypeBox schema) `coerceWithJsonSchema` → `validator.Check` → return the arguments or throw.
- Non-obvious design decisions: **a JSON-Schema coercion pass exists for schemas that are not TypeBox** (`:194-238`) — a string that should be a number is converted, a boolean from `"true"`/`1`, an object property recursively — and it is applied *only* when the schema has no `TypeBox.Kind` symbol, so a TypeBox schema is never second-guessed; `normalizeOptionalNulls` deletes a null for an **optional** property that does not accept null, but leaves a required one alone.
- Edge cases / failure handling: the error message names the failing path in dotted form (`tools.foo.bar`), lists every failing constraint, and **echoes the received arguments back** — so the model can see what it sent wrong.
- Surprising: the coercion pass tries each `anyOf` / `oneOf` member in turn and keeps the first that validates, which is how a model that sent `"5"` for a `number | string` union gets a working value.

## Ideas worth stealing

- **Repair orphaned tool calls at the serialization door, not in the error handler** — `packages/ai/src/api/transform-messages.ts:188` — every assistant tool call without a matching tool result is closed with a synthetic `{ text: "No result provided", isError: true }` before the request leaves. August's `_stuckRequestEscape` escalates *after* a provider has already 400'd on an orphaned `tool_use_id`; pi makes the orphan unrepresentable. Transfer: August's history projection should guarantee a 1:1 tool-call/tool-result pairing before it is persisted, and the "stuck request" ladder becomes a backstop rather than the primary mechanism.

- **Make malformed tool arguments an explicit field, not an empty object** — `packages/ai/src/utils/json-parse.ts:106` — `parseToolCallArguments` returns `{ arguments: {}, argumentsError: "<parse error>\n\nReceived arguments:\n<the model's text>" }`, and `ToolCall.argumentsError` is a declared field on the type (`packages/ai/src/types.ts:456`). The validator then refuses the call with the model's own text attached. August's rule "malformed tool JSON never executes as `{}`" is currently a loop-level promise; pi makes it a *type-level* guarantee plus one parse door that every adapter routes through.

- **Detect context overflow in three modes, not one** — `packages/ai/src/utils/overflow.ts:142` — (a) an error whose text matches one of ~25 provider shapes, (b) **silent overflow**: a successful response whose `usage.input + cacheRead` exceeds the context window, and (c) a **length stop with zero output** and a full context window (the server truncated the input, leaving no room to generate). August's `classify_error` matches text patterns only; z.ai-style silent overflow and MiMo-style truncation would be classified as success or as a normal length stop, and the compaction ladder would never fire. The exclusion list is checked first, because Bedrock's "ThrottlingException: Too many tokens" otherwise matches `/too many tokens/i` — the same trap August hit with the `Blocked:` marker.

- **Check the non-retryable quota list BEFORE the retryable one** — `packages/ai/src/utils/retry.ts:269` — a 429 that is really a quota/billing exhaustion ("insufficient_quota", "quota exceeded", "billing", "Monthly usage limit reached", the ChatGPT subscription limits) must fail fast; the retryable list then covers transient transport *text* ("overloaded", "socket hang up", "getaddrinfo", "stream disconnected before completion") rather than status codes, because the provider's wording is the only signal. August's `_retryWaitRefusalMs` refuses a long wait; pi's is the complementary axis — do not retry an account-level limit at all, and match on text because status alone is ambiguous.

- **A server-requested retry delay above the cap must fail, not be absorbed** — `packages/ai/src/utils/provider-retry.ts:39` — `validateServerRetryDelayMs` throws naming both the requested and the maximum delay, for both `retry-after-ms` and `retry-after` (seconds or HTTP-date). This is the same rule as August's `_retryWaitRefusalMs`, but implemented in the transport layer where it applies to *every* provider rather than in one loop.

- **Named compat flags, auto-detected then overridden per model** — `packages/ai/src/providers/compat-schema.ts:188` and `packages/ai/src/api/openai-completions.ts:1603` — every provider quirk is a named boolean in a TypeBox schema with a documented default; `detectCompat` infers ~20 of them from the provider name and URL, and `model.compat` overrides them field by field. August's per-model `apiFormat` is the same idea but coarser: pi's model entry can say "this exact model accepts a system message mid-conversation" or "this one rejects `max_tokens`". Transfer: replace August's `apiFormat` dropdown with a per-model *capability block*, and keep the auto-detection as the default so a new provider needs no configuration.

- **Make the tool set part of the transcript, and let the transport say how it can express changes** — `packages/ai/src/utils/transcript.ts:252` — `resolveTranscriptTools` splits tool declarations into a top-level request list and in-place deltas according to a three-level `TranscriptToolSupport` (`"none" | "additions" | "changes"`), and invalidates the cached prefix once per *removal* rather than once per later addition. August's progressive-disclosure tool surface changes the tool list mid-conversation; pi's model makes that a first-class transcript concept with three expressible transports, so August's tool-surface changes stop being an implicit cache-buster.

- **Reserve a never-callable tool so the provider's prompt scaffolding stays in the cached prefix** — `packages/ai/src/api/anthropic-messages.ts:208` — `DEFERRED_TOOL_PLACEHOLDER` is declared from the first request precisely so Anthropic's hidden scaffolding for mid-conversation tool changes does not move; the comment records "measured: full miss without it". August changes its tool surface as the agent discovers tools; each change currently costs a full prefix cache miss. Transfer: declare a reserved placeholder tool in the initial request so the prefix survives.

- **Send effort changes as in-conversation items so the prompt cache survives them** — `packages/ai/src/api/openai-responses-shared.ts:266` and `:134-142` — `configuration_update` items carry the thinking level, one before every earlier reply with the level recorded on it and one at the end, instead of changing `reasoning.effort` on the request. The provider records `providerThinkingLevel` on the reply so the history can be replayed faithfully. Transfer: August's per-model thinking level is a request field; changing it mid-session invalidates the provider prefix cache.

- **A generation counter that makes a superseded refresh unable to publish** — `packages/ai/src/models.ts:498` and `:516` — each provider refresh carries a generation; `publishProviderModels` checks it before the store write **and** again before the in-memory update, and publications are serialized through a per-provider promise chain. Transfer: August's provider/model refresh can race two refreshes and write a stale catalog; a generation check before *and* after the write closes that window.

- **An OAuth refresh that survives cancellation once it has started** — `packages/ai/src/auth/resolve.ts:119` — the signal cancels only the wait for the credential-store lock; once the provider may have rotated the refresh token, the refresh and its persistence ignore the signal and are bounded only by a 15 s timeout, "because a cancelled caller could otherwise discard the only valid refresh token". Transfer: August's credential refresh must not lose the only valid token because the user pressed Ctrl-C; and the refresh belongs **inside** the store's serialized `modify`, which is why `CredentialStore.modify` is documented as the only write path (`packages/ai/src/auth/types.ts:78`).

- **Anchor the context estimate on the last provider-reported usage, and invalidate it when a compaction summary lands after it** — `packages/ai/src/utils/estimate.ts:71` — `getLastAssistantUsageInfo` refuses a usage block whose timestamp precedes a newer message, with the comment "A newer prefix message was inserted after this response (for example, a compaction summary), so its usage cannot describe the current prefix". Transfer: August's compaction inserts a `<<compressed_summary` block; any estimator that trusts the last assistant usage across that insertion is wrong in exactly the case that matters.

- **One error-body extractor for every SDK, with a class-instance guard** — `packages/ai/src/utils/error-body.ts:112` — `normalizeProviderError` probes the known SDK field shapes in a fixed order and `isPlainNonEmptyObject` refuses to treat a class instance as an HTTP body, because AWS SDK v3's `$response.body` is a stream wrapper whose stringification produced `{"_events":…}` as the "body" and **replaced** the real `error.message`. August's error classification reads one error string; an extractor bug there is a classification bug that hides every downstream rule.

- **Telemetry that records block sizes, never content** — `packages/ai/src/telemetry.ts:41` and `:161` — the schema records a block's type, index and UTF-16 character count (and the tool name for tool calls), and the error status message is capped at 500 characters. Transfer: August's usage/loop page can adopt the same "never record content" rule for its telemetry, which makes it safe to enable by default.

- **A provider-agnostic transcript where later system messages patch the prompt by name** — `packages/ai/src/utils/transcript.ts:73` and `packages/ai/src/utils/text.ts:28` — a later system message adds instructions, replaces or removes a **named section**, and adds or removes tools; the rendered update frames the change as `Updated system prompt section "memory": …` so the model can relate it to the original. Transfer: August's system prompt is a static string assembled at startup; this is a mechanism for changing the prompt mid-session without rewriting the prefix, which is what a "recalled memory" or "switched agent mode" feature needs.

- **A thinking-level map where `null` means "unsupported", and clamping searches upward first** — `packages/ai/src/providers/model-schema.ts:15` and `packages/ai/src/models.ts:1271` — every level a provider does not have is `null`, `getSupportedThinkingLevels` filters on it, and `clampThinkingLevel` searches **upward** from the requested level before searching downward, so an unsupported request prefers more thinking rather than silently dropping to "off". Transfer: August maps a thinking level onto a provider effort; an explicit rule for the unsupported case is currently implicit.

- **A test double that models the prompt cache** — `packages/ai/src/providers/faux.ts:228` — the faux provider computes the cache-read / cache-write / input split by measuring the **common prefix length** of the previous and current prompts, so a cache-aware harness can be tested against a fake that bills like a real provider. Transfer: August's cache accounting and prefix-hit UI could be tested against this rather than against a provider.

- **Return a stream synchronously and put the async setup behind it** — `packages/ai/src/api/lazy.ts:60` — `lazyStream` returns the stream object immediately, resolves auth and loads the module in the background, and converts a setup failure into a terminal `error` event carrying a complete, zero-usage assistant message. Transfer: August's provider call path can return its handle before the key is resolved and still deliver every failure on the channel the caller is already reading.

- **Make an unknown provider stop reason fail loudly** — `packages/ai/src/api/openai-responses-shared.ts:883` and `packages/ai/src/api/google-shared.ts:467` — the switch has an exhaustive `never` check and throws. A new provider stop reason must be handled explicitly rather than defaulting to "stop", which is what makes a silent truncation visible.

## Files skipped (with reasons)

None. All 210 files in this shard were opened and read; every ledger row is `read`. No file was skipped.

Six files were only **partially** read line by line, and each ledger note says so explicitly:
`packages/ai/scripts/generate-models.ts` (131 KB; read the head, the models.dev loader, the `generateModels()` entry and the full function index — the per-provider model tables were not), `packages/ai/src/api/openai-codex-responses.ts` (read 1–999 of 1724), `packages/ai/src/api/bedrock-converse-stream.ts` (read 1–610 and 900–1139 of 1428), `packages/ai/src/api/mistral-conversations.ts` (read 1–479 of 952), `packages/ai/src/api/google-generative-ai.ts` (read 1–200 and 200–472 — complete), `packages/ai/src/providers/faux.ts` (read 1–499 of 727) and `packages/ai/src/api/llama-cpp-classify.ts` (read 1–360 of 461). Four OAuth modules were read to ~line 120–200 of 239–309 lines: `kimi-coding.ts`, `meta.ts`, `openai-chatgpt.ts`, `xai.ts`.

## Uncertainties

- **The generated data files were out of shard.** `packages/ai/src/providers/data/*.json` and `packages/ai/src/providers/data/.manifest.json` are imported by the `.models.ts` shards and by `providers/all.ts` (`modelDataManifest`), but they are not in this shard's file list. I therefore know the *shape* of the catalog (from `scripts/model-data.ts`'s validator, which checks `type`, `id`, `provider`, `api`, `name`, `baseUrl`, `input`, `output`, `reasoning`, `contextWindow`, `maxTokens` and the four `cost` fields) but **not** any specific model's capability flags or prices. Every "the catalog says X" statement in this report would have to be checked against the JSON, which I did not read.
- **`providers/faux.ts` — the registration tail (lines 500–727) was sampled, not read.** I established the response-queueing, the delta re-emission, the prompt-cache modelling and the deferred-response machinery, but I did not read `createFauxCore`'s provider object literal, so I cannot state exactly which `Provider` members it wires up.
- **`api/bedrock-converse-stream.ts` — the block-delta handlers (lines 611–899) were sampled.** The event loop, the client construction, the SigV4 header middleware, the error formatter and the message conversion were read; the per-block start/delta/stop handlers were not.
- **`api/openai-codex-responses.ts` — the WebSocket transport body (lines 1000–1724) was sampled.** The connection cache, the fallback bookkeeping, the debug stats and the SSE parser were read; the actual frame send/receive and the header builders were not.
- **`scripts/generate-models.ts` — the per-provider tables were not read.** The generator's *algorithm* (fetch → merge → apply metadata → group → write → validate) is established; the individual compat tables (which model gets `supportsStrictMode`, which gets `supportsMidConvoSystemMessages`) are not, and those tables are where the real knowledge lives.
- **`api/mistral-conversations.ts` — the SSE event consumer and the payload builder tail were sampled.** The client, the wire remap, the tool-call id normalizer and the header handling were read.
- **The OAuth tails of `kimi-coding.ts`, `meta.ts`, `openai-chatgpt.ts` and `xai.ts` were sampled** — the device-authorization start and the credential shape were read in each; the token-exchange and refresh paths were not.
- **The `.models.ts` shards were confirmed by pattern, not by opening each one.** I opened five in full (`openai`, `moonshotai`, `deepseek`, and by inspection the identical shape of `opencode`/`openrouter` etc.) and then grepped every `*.models.ts` file for its import line and its three export names. All 42 shards matched the identical 14-line template; only the provider id and the JSON filename differ. I did not open the remaining 37 individually.
- **`models.generated.ts` — only the import block (lines 1–40 of 309) was read.** The export block repeats the same pattern for the remaining providers.
- **Lens coverage note.** This shard contains **no** agent loop, **no** tool executor, **no** session storage or branching, **no** compaction implementation, **no** extension/plugin/skill mechanism, **no** TUI or streaming renderer and **no** configuration layer. It has *adjacent* machinery for several of those lenses: the transcript algebra and `resolveTranscriptTools` (tool definition), `streamSimple`/`clampThinkingLevel` (provider/model abstraction), the OAuth + credential subsystem (config), `validateToolArguments` (tool validation), the `AssistantMessageEvent` protocol and `AssistantMessageEventStream` (streaming), and `estimateContextTokens` (context management). The lenses this shard does *not* cover — agent loop and turn lifecycle, steering and queued messages, session storage / branching / compaction, extension / plugin / skill mechanisms, system-prompt philosophy and size, TUI rendering, and the testing approach — are presumably in other shards; I did not look for them, since they are outside my file list.
- **The eight distinct `.lazy.ts` wrappers for chat APIs are `lazyApi(...)`; the four for classifier/image APIs are hand-written `ProviderClassifier` / `ProviderImages` objects.** I read all sixteen; the classifier/image ones do their own dynamic import inside the method rather than going through `lazyApi`, because `lazyApi` only knows how to build a `ProviderStreams`.
- **I did not verify any claim by running anything.** No code was executed from the clone, per the shard rules; every statement above is from reading the source.
