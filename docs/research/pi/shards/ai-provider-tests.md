# pi / ai-provider-tests

## Shard shape

This shard is the **entire `packages/ai/test/` directory** — 185 files, ~1.5 MB — and it is the test suite of pi's unified LLM client library (`@earendil-works/pi-ai`), not of the coding agent. It is organised around **wire protocols**, not around the harness loop: every file drives one provider adapter (`anthropic-messages`, `openai-completions`, `openai-responses`, `openai-codex-responses`, `azure-openai-responses`, `bedrock-converse-stream`, `google-generative-ai` / `google-vertex`, `mistral-conversations`, `pi-messages`, `typesafe-system-one`, `openai-decisions`, `llama-cpp-classify`) and asserts what the adapter puts on the wire. Four layers recur. (1) **Payload-capture tests** mock the vendor SDK and assert the exact JSON body (`onPayload` / `vi.mock("openai")`), which is where nearly every "wire quirk" lives — thinking shape, cache markers, tool-choice, tool schemas, sampling params. (2) **Live E2E sweeps** (`stream.test.ts`, `empty.test.ts`, `tokens.test.ts`, `total-tokens.test.ts`, `unicode-surrogate.test.ts`, `context-overflow.test.ts`) run the same scenario against every provider whose credentials are present and are skipped otherwise. (3) **Auth/OAuth tests** cover eleven device-code and PKCE flows, the callback server, the credential store and the per-provider `toAuth` mapping. (4) **Catalog tests** assert the generated model data (`models.generated.ts` + per-provider JSON shards) and the reasoning-level maps, including a strict generator that must fail *before* mutating generated files. The layer that pi's harness actually owns — the agent loop, tool execution, compaction, session storage — is **not in this shard**; what the shard supplies to the harness is the provider contract underneath it: how a model is described, how a request body is built, how a stream is terminated, how an error is classified, and how a cancelled turn must be replayable.

## Per-file notes

### packages/ai/test/abort.test.ts
- Purpose: Live abort semantics across every provider.
- Key abstractions: `stream()`/`complete()` returning an `AssistantMessageEventStream`; `stopReason: "aborted"`.
- Data flow: consume deltas → `controller.abort()` at 50 chars → await `response.result()` → push the aborted assistant message back into the context → issue a follow-up turn.
- Non-obvious design decisions: an aborted turn is still appended to history and the *next* turn must succeed — the aborted message is a legal transcript entry (`:46-55`); an immediate abort yields **empty** content, not an error (`:83`).
- Edge cases / failure handling: mid-stream abort vs. pre-flight abort are separate cases; the follow-up assertion is that `stopReason === "stop"`.
- Surprising: `testAbortThenNewMessage` exists specifically because an aborted assistant message in history used to poison the next request.

### packages/ai/test/anthropic-adaptive-thinking-models.test.ts
- Purpose: Pins which catalog models use Anthropic *adaptive* thinking.
- Key abstractions: `model.compat.forceAdaptiveThinking` as a per-model boolean flag.
- Data flow: enumerate all providers × models → filter `api === "anthropic-messages"` → filter the flag → compare the sorted id list against a literal expected list.
- Non-obvious design decisions: the expected set is checked **twice** — once against a hardcoded list (`:36`) and once against a regex predicate over the whole filtered set (`:37-48`), so a new adaptive model that nobody added to the list fails the test instead of silently inheriting adaptive thinking.
- Edge cases / failure handling: Fireworks, MiniMax and MiniMax-CN are exempted by prefix because they derive the behaviour from catalog effort metadata rather than a fixed name set.
- Surprising: the exemption is written as a *negative* filter (`flaggedModels.filter(...)`) — the test asserts that the flagged set contains nothing else.

### packages/ai/test/anthropic-auth-token.test.ts
- Purpose: The three Anthropic credential shapes map to three different wire forms.
- Key abstractions: `provider.auth.apiKey.resolve({ctx, signal})` returning `{auth, source}`; `ANTHROPIC_AUTH_TOKEN_ENV` / `ANTHROPIC_OAUTH_TOKEN_ENV`.
- Data flow: a fake `ctx.env` → the provider's resolver → either `{headers: {Authorization: "Bearer …"}}` or an OAuth-shaped auth → the SDK constructor options.
- Non-obvious design decisions: `ANTHROPIC_AUTH_TOKEN` becomes a **Bearer** header (`:108-111`) while `ANTHROPIC_OAUTH_TOKEN` keeps OAuth-shaped auth (`:114`) and `ANTHROPIC_API_KEY` keeps the plain key — one env var, three wire shapes.
- Edge cases / failure handling: an explicit `anthropic-beta` header replaces the beta list (`:219-226`) and `anthropic-beta: null` suppresses it entirely (`:228-235`).
- Surprising: the test asserts the header set through the *SDK constructor options*, not through a fetch spy, so it also pins that the header is `defaultHeaders` rather than a per-request header.

### packages/ai/test/anthropic-cache-write-1h-cost.test.ts
- Purpose: Pricing of Anthropic's two cache TTLs.
- Key abstractions: `usage.cacheWrite` and `usage.cacheWrite1h`; `model.cost.input` as the 1h multiplier basis.
- Data flow: fake SSE carrying `cache_creation: {ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}` → the adapter splits the two buckets → `cost.cacheWrite = 5m × cacheWriteRate + 1h × 2 × inputRate`.
- Non-obvious design decisions: the 1h bucket is priced at **2× the input rate** rather than at a separate catalogue rate (`:73-74`, comment at `:58`).
- Edge cases / failure handling: a gateway that reports cache usage only in `message_delta` (not `message_start`) is handled (`:78-110`); a missing breakdown falls back to the 5m rate (`:112-123`).
- Surprising: `cacheWrite1h` is `?? 0`-safe — the test asserts `result.usage.cacheWrite1h ?? 0` because the field is optional.

### packages/ai/test/anthropic-eager-tool-input-compat.test.ts
- Purpose: The per-tool `eager_input_streaming` flag and the legacy beta that replaces it.
- Key abstractions: `compat.supportsEagerToolInputStreaming`; the `fine-grained-tool-streaming-2025-05-14` beta.
- Data flow: a real `node:http` server captures the request body → assert `tools[0].eager_input_streaming === true` and that no beta header was sent.
- Non-obvious design decisions: the legacy beta is only sent **when there are tools at all** (`:121-126`) — an empty tool list must not attract a beta header.
- Edge cases / failure handling: the server is closed in a `finally` and the port is taken from `address()` so the test can run in parallel.
- Surprising: the request goes over a real socket rather than a mocked SDK, because the Anthropic SDK builds the body internally.

### packages/ai/test/anthropic-eager-tool-input-e2e.test.ts
- Purpose: Live check that each provider's Anthropic-Messages route accepts the eager-tool-input body.
- Key abstractions: `getProviders()` → `getModels(provider)` filtered by `api`; `it.skipIf(!apiKey)` per provider.
- Data flow: enumerate all anthropic-messages models → pick ONE per provider → send a real tool call → assert the request is accepted.
- Non-obvious design decisions: `getProbePriority` (`:48-64`) prefers cheap current Claude 4 Haiku routes and deliberately penalises stale Claude 3.x aliases that can linger in a catalog after upstream removal — a cost-control and flakiness-control mechanism baked into the test.
- Edge cases / failure handling: the suite asserts its own coverage first (`it("covers every generated anthropic-messages model")`, `:127-132`), so a newly added model cannot silently escape the probe.
- Surprising: a *forced* variant (`supportsEagerToolInputStreaming: true` on every model) runs alongside the configured one, so a provider whose catalog says "unsupported" is still tested.

### packages/ai/test/anthropic-empty-thinking-signature-compat.test.ts
- Purpose: Unsigned thinking blocks must not be replayed as thinking.
- Key abstractions: `compat.allowEmptySignature`; the `onPayload` capture seam.
- Data flow: build an assistant message with `thinkingSignature: ""` → `streamSimple` → capture the Anthropic body → assert the thinking block became `{type: "text"}`.
- Non-obvious design decisions: the default is **lossy conversion to text** (`:82-86`) rather than an error, because a gateway that strips signatures would otherwise brick every turn; `allowEmptySignature` opts a provider back into keeping the block (`:94-98`).
- Edge cases / failure handling: a *present* signature with empty thinking text is preserved as a thinking block (`:88-92`) — empty text and empty signature are different cases.
- Surprising: the whole provider set is asserted at once (`getModels("vercel-ai-gateway").every(m => m.compat?.allowEmptySignature === true)`, `:101-105`).

### packages/ai/test/anthropic-error-tool-result-images.test.ts
- Purpose: Anthropic rejects an **error** tool result that contains images.
- Key abstractions: the `isError` flag on a tool result; the Anthropic `tool_result` content shape.
- Data flow: an error tool result with text + 2 images + text → the adapter flattens the text and relocates the images → the payload carries `tool_result` (text only) followed by a text marker and the two images.
- Non-obvious design decisions: the relocation marker is a literal sentence — `"(image attached after the tool results)"` (`:104`) — so the model can tell the image was moved rather than lost; the error text keeps both text segments joined by that marker.
- Edge cases / failure handling: an error tool result *without* images is left byte-identical (`:120-140`).
- Surprising: the non-error tool result in the same turn keeps its image inline as `[{type:"text"}, image]` (`:110-111`) — the relocation applies only to the failing call.

### packages/ai/test/anthropic-federation-sdk.test.ts
- Purpose: How often the workload-identity federation token exchange happens.
- Key abstractions: `ANTHROPIC_FEDERATION_RULE_ID` / `ANTHROPIC_ORGANIZATION_ID` / `ANTHROPIC_IDENTITY_TOKEN_FILE`; the real `@anthropic-ai/sdk` driven by a fake `fetch`.
- Data flow: three sequential streams → the SDK's credential chain hits `/v1/oauth/token` → the token is reused for `/v1/messages`.
- Non-obvious design decisions: the exchange must happen **exactly once** across three requests (`:99`) — the SDK is allowed to cache, but not to re-exchange.
- Edge cases / failure handling: when the caller supplies its own `Authorization` header the SDK credential chain must not run at all (`:107-118`), asserted by the request list being exactly one entry.
- Surprising: this test drives the *real* SDK precisely so the credential-chain behaviour is measured rather than re-implemented in a mock.

### packages/ai/test/anthropic-federation.test.ts
- Purpose: Federation is an *alternative* to key auth, not an addition.
- Key abstractions: `provider.auth.apiKey.resolve()` returning `{auth: {}, env, source: "workload identity federation"}`.
- Data flow: env → resolver → SDK constructor options (`apiKey: null`, `authToken: null`, `config: {authentication: {type: "oidc_federation"}}`).
- Non-obvious design decisions: `ANTHROPIC_SERVICE_ACCOUNT_ID` is optional, "like the SDK" (`:122-135`); a *missing* `ANTHROPIC_IDENTITY_TOKEN_FILE` means federation is not configured at all (`:117-120`).
- Edge cases / failure handling: an explicit API key or auth token beats federation (`:137-146`), and an explicit API key at the *request* level beats federation env (`:174-179`).
- Surprising: federation applies only to the `anthropic` provider — the same env on a `kimi-coding` model produces an error, not a federation attempt (`:181-191`).

### packages/ai/test/anthropic-force-adaptive-thinking.test.ts
- Purpose: A per-model compat flag overrides id-name sniffing.
- Key abstractions: `compat.forceAdaptiveThinking`; the legacy `thinking: {type: "enabled"}` vs. the adaptive `thinking: {type: "adaptive", display: "summarized"}` + `output_config.effort`.
- Data flow: model id `vendor--claude-opus-latest` (deliberately unrecognisable) → payload capture → assert the payload shape.
- Non-obvious design decisions: the model id is *intentionally* one that no name-matching rule catches (`:25-27`), because the production bug was a corporate proxy id (`anthropic--claude-opus-latest`) silently getting the legacy payload.
- Edge cases / failure handling: `reasoning: off` wins over the override (`:103-108`); a built-in adaptive model can opt back out with `forceAdaptiveThinking: false` (`:92-101`).
- Surprising: the "capture" is done by throwing from the `onPayload` callback — the request is aborted deliberately so no network call happens (`:55-58`).

### packages/ai/test/anthropic-long-cache-retention-e2e.test.ts
- Purpose: Live probe that each provider accepts a forced 1h cache TTL.
- Key abstractions: `cacheRetention: "long"`; `compat.supportsLongCacheRetention`.
- Data flow: same cheapest-model-per-provider selection as the eager-input probe → a forced long-retention request → assert it is not rejected.
- Non-obvious design decisions: the probe FORCES the flag on every model (`:71-79`) rather than trusting the catalog, so a provider whose catalog is wrong is still exercised.
- Edge cases / failure handling: the coverage assertion (`:111-116`) again prevents a new model from escaping.
- Surprising: it is the same selection algorithm as `anthropic-eager-tool-input-e2e.test.ts` — the probe-priority idea is duplicated across two files rather than shared.

### packages/ai/test/anthropic-mid-conversation-effort.test.ts
- Purpose: The mid-conversation effort protocol (a marker that binds a signed thinking block to the effort that produced it).
- Key abstractions: `assistantMessage.providerThinkingLevel`; a synthetic `{role: "system", content: [], output_config: {effort}}` message in the request.
- Data flow: turn 1 at effort `low` → turn 2 at effort `high` → the adapter replays the *exact* historical marker prefix and appends the current marker.
- Non-obvious design decisions: the replayed prefix must be **byte-identical** to the previous request's messages (`:105`) — anything else invalidates the provider's signature binding; the effort marker travels as a `system` message with empty content, not as a top-level field.
- Edge cases / failure handling: `thinking.block_binding.prefix_mismatch_behavior` can be forced to `"error"` for the conformance test (`:16-19`).
- Surprising: the last request's marker is the *only* thing that changes; the whole point is that the prefix does not move.

### packages/ai/test/anthropic-oauth.test.ts
- Purpose: The Anthropic OAuth flows.
- Key abstractions: `anthropicOAuth.login({signal, notify, prompt})`; `AuthEvent` of type `auth_url`; prompt kinds `select` and `manual_code`.
- Data flow: stubbed `fetch` → the flow emits an auth URL → the prompt returns a pasted code → the token endpoint is called with `grant_type: authorization_code`.
- Non-obvious design decisions: the manual-code flow keeps the **localhost** redirect_uri (`:51`) while the browser flow uses Anthropic's own `https://platform.claude.com/oauth/code/callback` (`:93`) — two different redirect targets for two different login methods.
- Edge cases / failure handling: the browser path replays the `state` from the auth URL back in the exchange body (`:92`), and the manual path derives the redirect_uri and state from the URL it was given.
- Surprising: the manual path builds its callback URL by *parsing the auth URL it was handed*, so the test exercises the real URL plumbing rather than a constant.

### packages/ai/test/anthropic-opus-4-8-smoke.test.ts
- Purpose: Live smoke of the newest Claude wire shape.
- Key abstractions: `reasoning: "high"`; `onPayload` capture; a thinking block with a signature.
- Data flow: a prompt demanding an exact arithmetic answer → the stream is consumed → the payload, the thinking events and the final text are all asserted.
- Non-obvious design decisions: the expected answer is an exact string (`sum=353418362; divisibleBy11=yes`, `:69`) so a model that answers approximately fails.
- Edge cases / failure handling: the thinking signature must be a non-empty string (`:57-62`), not merely present.
- Surprising: the prompt asks for an *internal* computation plus an exact output — a cheap way to force a reasoning pass without asking for visible reasoning.

### packages/ai/test/anthropic-sse-parsing.test.ts
- Purpose: The raw Anthropic SSE parser.
- Key abstractions: `onProviderStreamEvent(event, eventModel)`; `AssistantMessageEventStream`.
- Data flow: a hand-built SSE body → the adapter → provider events forwarded in order → a normalised assistant message.
- Non-obvious design decisions: unknown SSE events **after** `message_stop` are ignored rather than fatal (`:680-699`), because proxies append their own frames (`proxy.stats`, `[DONE]`).
- Edge cases / failure handling: `rawStopReason` is preserved for `refusal` (`:598`) and `sensitive` (`:648`) — the provider's own vocabulary is kept next to the normalised one.
- Surprising: the provider events are forwarded with the *model* attached as a second argument, so a caller can attribute a chunk to the model that produced it even on a routed endpoint.

### packages/ai/test/anthropic-strict-tool-fallback.test.ts
- Purpose: Degrade a strict-tool request when the provider refuses the grammar.
- Key abstractions: `constrainedSampling: {type: "json_schema", strict: "prefer" | "require"}`; three distinct provider error messages.
- Data flow: the request is sent strict → the provider 400s with a grammar error → the adapter retries the SAME request with the original non-strict schemas.
- Non-obvious design decisions: the fallback is **selective**: "require" tools keep strict, "prefer" tools are downgraded (`:74-…`), so a hard requirement is never silently relaxed.
- Edge cases / failure handling: the recognised messages are enumerated as test cases (`:69-73`): grammar too large, too many strict tools (32 > 20), and too many union-typed parameters (480 > 16) — all observed from the live API.
- Surprising: the same fallback path is exercised through a *gateway* provider (`pi-messages`, `:260-287`), proving the retry lives in the shared layer and not in the Anthropic adapter.

### packages/ai/test/anthropic-strict-tool-schema.test.ts
- Purpose: Strict tool schemas have a different wire form.
- Key abstractions: `strict: true`; `additionalProperties: false`; optionals widened to `anyOf [T, null]`.
- Data flow: a TypeBox schema → `convertResponsesTools`-equivalent → the Anthropic `tools[]` entry.
- Non-obvious design decisions: a "prefer" tool whose schema uses a keyword Anthropic's strict mode rejects is sent **non-strict** instead of failing (`:102-123`) — the list of rejected keywords is `minimum`/`maximum` on an integer, `minItems`, and `format: "regex"`.
- Edge cases / failure handling: a legacy (non-constrained) tool gets only `{type, properties, required}` — no `strict`, no `additionalProperties` (`:76-82`).
- Surprising: the supported set includes `pattern`, `format: "uri"` and `minLength`/`maxLength` — the allowlist is per keyword, not "simple vs complex".

### packages/ai/test/anthropic-temperature-compat.test.ts
- Purpose: Which Claude models accept a temperature.
- Key abstractions: `compat.supportsTemperature`; a per-model catalogue fact.
- Data flow: `temperature: 0` → payload capture → assert the field is present or absent.
- Non-obvious design decisions: the rule is per **model version** (4.6 yes, 4.7/4.8 no), not per API — so it is catalogue data, not adapter logic (`:68-96`).
- Edge cases / failure handling: a custom model can opt out with `compat.supportsTemperature: false` (`:98-102`).
- Surprising: `temperature: 1` (the default) is omitted too — the omission is about the *model*, not about the value.

### packages/ai/test/anthropic-thinking-binding-e2e.test.ts
- Purpose: Proof that the effort marker is load-bearing.
- Key abstractions: `thinking.block_binding.prefix_mismatch_behavior = "error"`; `providerThinkingLevel`.
- Data flow: a signed thinking reply → a follow-up *with* the level → a follow-up *without* it (the field deleted) → the provider rejects the second.
- Non-obvious design decisions: the test deliberately deletes `providerThinkingLevel` from the history (`:53-54`) to show the failure mode rather than to assert success.
- Edge cases / failure handling: the expected failure is the literal provider message `Invalid \`signature\`` (`:57`) — the harness's own error taxonomy would otherwise see a generic 400.
- Surprising: this is the strongest argument in the shard for treating the effort level as part of the *message*, not as a session-wide setting.

### packages/ai/test/anthropic-thinking-disable.test.ts
- Purpose: Turning thinking off must actually turn it off.
- Key abstractions: `thinking: {type: "disabled"}`; the thinking event counters.
- Data flow: a prompt that says "solve this internally, then reply with pong ×40" → the stream is counted for thinking events → the payload is captured.
- Non-obvious design decisions: the payload assertion is per model family — Sonnet 4.5, Opus 4.6 and Opus 4.8 all get `thinking: {type: "disabled"}` (`:113-132`) while **Fable 5 gets nothing at all** (`:134-139`), because that model refuses the field.
- Edge cases / failure handling: the live E2E asserts zero thinking events AND zero thinking blocks in the content AND ≥35 pongs (`:164-171`) — the count check is what catches a model that thinks but hides it.
- Surprising: the "pong" trick — asking for a long exact output — is how you prove the model did not spend its budget on reasoning.

### packages/ai/test/anthropic-tool-name-normalization.test.ts
- Purpose: Tool names must survive a Claude Code OAuth round trip.
- Key abstractions: a case-insensitive name lookup between the session's tool names and Claude Code's canonical casing.
- Data flow: session tool `todowrite` → wire name `TodoWrite` → the provider returns `TodoWrite` → the adapter maps it back to `todowrite`.
- Non-obvious design decisions: the header comment (`:9-24`) records *why* an earlier `find → Glob` mapping was wrong: the inbound direction looks up a tool by name, and no tool named "glob" existed, so the call came back unexecutable.
- Edge cases / failure handling: a tool with no Claude Code counterpart (`my_custom_tool`) passes through untouched (`:164-203`).
- Surprising: the normalisation is symmetric *and* self-inverse — it is a lookup, not a translation table, and the test asserts the negative case explicitly so a "helpful" remap cannot come back.

### packages/ai/test/azure-openai-base-url.test.ts
- Purpose: How Azure env vars become an AzureOpenAI client.
- Key abstractions: `AZURE_OPENAI_BASE_URL` / `AZURE_OPENAI_RESOURCE_NAME` / `AZURE_OPENAI_API_VERSION`; `apiVersion`.
- Data flow: env → the mocked `AzureOpenAI` constructor → `constructorCalls[0].baseURL` / `.apiVersion`.
- Non-obvious design decisions: the env is **deleted** in `beforeEach` and restored in `afterEach` (`:66-100`) rather than stubbed, because the adapter reads `process.env` directly.
- Edge cases / failure handling: both a full base URL and a bare resource name are accepted (`:…`).
- Surprising: the User-Agent default and the provider-event passthrough are asserted in the same file (`:249-272`), because both are properties of the constructed client.

### packages/ai/test/azure-openai-completions.test.ts
- Purpose: Azure's OpenAI-compatible path and its per-model quirks.
- Key abstractions: the per-model API choice (`openai-completions` vs `azure-openai-responses`); `AZURE_OPENAI_DEPLOYMENT_NAME_MAP`.
- Data flow: `azure.stream(model, …)` → the provider dispatches to `chat.completions` or `responses` → the mocked client records which.
- Non-obvious design decisions: the routing is a **per-model** property, not a per-provider one (`:268-280`): a Responses model still goes to the Responses API even inside the Azure provider.
- Edge cases / failure handling: Azure Foundry rejects DeepSeek's `thinking` field *and every* prompt-cache parameter (`:110-…`), so those are stripped for that model.
- Surprising: the deployment-name map lets one catalogue model name resolve to a different Azure deployment, and the map is applied to the request `model` field.

### packages/ai/test/azure-openai-responses-reasoning-replay.test.ts
- Purpose: Which reasoning item wins when replaying encrypted content.
- Key abstractions: `ResponseReasoningItem.encrypted_content`; `processResponsesStream`; `convertResponsesMessages`.
- Data flow: two events carrying different `encrypted_content` → the stream processor stores one → the replay converter reads it back.
- Non-obvious design decisions: `output_item.done` wins over `response.completed` (`:83-109`), because the earlier event is the authoritative one; the completed event is only a fallback (`:111-136`).
- Edge cases / failure handling: the answers are matched by **id**, not by position — the test deliberately reverses them.
- Surprising: the same provider-level rule is implemented once in `openai-responses-shared.ts` and therefore applies to Azure for free.

### packages/ai/test/azure-openai-tool-choice.test.ts
- Purpose: `tool_choice` reaches the wire.
- Key abstractions: `stream()` (provider-specific) vs `streamSimple()` (provider-neutral) options; `toolChoice: "required" | "none"`.
- Data flow: options → the Azure Responses body → the payload capture.
- Non-obvious design decisions: forwarding the tool choice must not cost the tool *definitions* — the payload still carries one tool (`:47-48`).
- Edge cases / failure handling: both the provider-specific and the provider-neutral form are asserted, so a translation layer between them cannot drop the value.
- Surprising: the payload is captured by throwing from `onPayload`, so no HTTP request is ever made.

### packages/ai/test/azure-utils.ts
- One specific line: parses `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` (`model=deployment,model=deployment`) into a map and reports whether Azure credentials are present.

### packages/ai/test/baseten-models.test.ts
- One specific line: asserts the two GLM 5.2 endpoints stay text-only and that Baseten carries reasoning as `chat_template_args: {enable_thinking}` alongside `reasoning_effort`.

### packages/ai/test/bedrock-cache-write-1h-cost.test.ts
- One specific line: Bedrock's `cacheDetails` array (two separate 1h entries) is summed into `cacheWrite1h` and priced at 2× input while the 5m part keeps the catalogue rate.

### packages/ai/test/bedrock-convert-messages.test.ts
- Purpose: The Bedrock Converse request shape.
- Key abstractions: `toolConfig.tools[].toolSpec.strict`; `compat.supportsStrictMode`.
- Data flow: a context with tools → the Bedrock `ConverseStreamCommand` input → assertions on `toolConfig` and `messages`.
- Non-obvious design decisions: native strict tool use is gated by **model capability** (`:101-…`): a model with `supportsStrictMode` sends `strict: true`, one without sends nothing — the request is not rejected, it is degraded.
- Edge cases / failure handling: an empty `edit` argument is widened to include the literal `""` key so the Bedrock schema validation passes (`:501`).
- Surprising: the capture uses `signal: AbortSignal.abort()` so the request dies before the network.

### packages/ai/test/bedrock-credentials.test.ts
- One specific line: an explicit or env-scoped AWS profile beats ambient `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, which are used only when no profile is configured at all.

### packages/ai/test/bedrock-custom-headers.test.ts
- Purpose: Caller-supplied headers must reach the Bedrock request without clobbering the SDK's own.
- Key abstractions: a Smithy `middlewareStack.add(handler, {step, name, priority})` middleware named `pi-ai-custom-headers`.
- Data flow: `streamBedrock(…, {headers})` → the middleware is registered → the handler mutates `args.request.headers` → `next(args)`.
- Non-obvious design decisions: reserved headers (`authorization`, `x-amz-date`, `host`) are skipped **case-insensitively** (`:110-152`) — the test asserts that no `Authorization` / `X-Amz-Date` / `HOST` key leaks in, because a case-sensitive guard would add them back as distinct capitalised keys.
- Edge cases / failure handling: no middleware is registered at all when `headers` is undefined or empty (`:154-164`); a request with no `headers` object, or with `request: undefined`, passes through unchanged (`:166-183`).
- Surprising: the middleware is registered at the `build` step with `priority: "low"`, so it runs after the SDK has built its own headers.

### packages/ai/test/bedrock-endpoint-resolution.test.ts
- One specific line: an EU inference profile pins the EU runtime URL, an explicit `AWS_REGION` suppresses the pinned endpoint, an EU baseUrl implies the region, and the generic API key becomes a Bedrock bearer token.

### packages/ai/test/bedrock-error-metadata.test.ts
- Purpose: Bedrock failures become structured diagnostics.
- Key abstractions: `AssistantMessageDiagnostic` of type `bedrock_response_failure`; `$metadata.httpStatusCode` / `requestId`.
- Data flow: a modelled `ServiceException` thrown from inside the event-stream iterator → the adapter classifies it → a diagnostic with `{status, requestId, code}`.
- Non-obvious design decisions: values that exceed a length bound are **dropped** rather than truncated (`:189-198`), and the SDK's `Unknown` placeholder is omitted instead of being reported as an error code (`:200-211`).
- Edge cases / failure handling: the mock exposes the `ServiceException` base class so the test can construct a *real instance* of the modelled error (`:7-8`, `:68-74`).
- Surprising: the diagnostic details are `{status: 400}` alone when the header values were too long — absence, not a truncated value.

### packages/ai/test/bedrock-models.test.ts
- One specific line: the catalogue sanity check (Claude Opus 5 is reachable only through an inference profile) plus an opt-in live sweep of every model behind `BEDROCK_EXTENSIVE_MODEL_TEST`.

### packages/ai/test/bedrock-raw-stop-reason.test.ts
- One specific line: raw SDK stream items (including error items) are forwarded to `onProviderStreamEvent` **before** normalisation, and the provider's own stop reason is kept in `rawStopReason` next to the normalised `stopReason`.

### packages/ai/test/bedrock-redacted-reasoning.test.ts
- One specific line: Bedrock's `redactedContent` (encrypted OpenAI reasoning) arrives as a `Uint8Array` and must round-trip byte-identically through the request payload.

### packages/ai/test/bedrock-response-headers.test.ts
- One specific line: a fake eventstream server proves the raw Smithy response headers reach `onResponse` with the status, before the (intentionally empty) body is consumed.

### packages/ai/test/bedrock-thinking-payload.test.ts
- One specific line: the Bedrock `additionalModelRequestFields.thinking` shape — adaptive + `block_binding` + the thinking-binding beta for new models, fixed-budget + the interleaved-thinking beta for older ones — plus a `cachePoint` on the last message.

### packages/ai/test/bedrock-utils.ts
- One specific line: reports whether any valid AWS credential source (named profile, IAM key pair, or Bedrock API key) is configured.

### packages/ai/test/cache-retention.test.ts
- Purpose: `PI_CACHE_RETENTION` → the four providers' cache knobs.
- Key abstractions: `cacheRetention: "none" | "short" | "long"`; Anthropic `cache_control.ttl`, OpenAI `prompt_cache_key`/`prompt_cache_retention`/`prompt_cache_options`.
- Data flow: env → options → the provider body → the cache marker assertions.
- Non-obvious design decisions: the Anthropic system prompt carries `cache_control: {type: "ephemeral"}` **without** a ttl by default (`:70-74`) and with `ttl: "1h"` only under `PI_CACHE_RETENTION=long`.
- Edge cases / failure handling: a non-`api.anthropic.com` baseUrl gets the ttl **by default** (`:99-…`) because a proxy cannot be assumed to have a default TTL.
- Surprising: the same file also pins that an empty tool list never becomes `tools: []` on the OpenAI-compatible path.

### packages/ai/test/classifier-images-live.test.ts
- One specific line: sends a solid **red** PNG and a solid **blue** PNG in separate requests so a service that silently drops the image cannot pass by chance.

### packages/ai/test/classifier-models.test.ts
- One specific line: chat and classifier entries sharing provider+id stay separate in the catalogue, a chat model passed to `classify()` errors at runtime, and an OAuth-only credential hides classifier models while leaving chat models available.

### packages/ai/test/cloudflare-ai-binding.test.ts
- One specific line: the Workers AI binding fetch adapter passes requests through untouched, rejects a binding with no `fetch()` **at construction** (not on the first request), and `Authorization: null` keeps the OpenAI SDK's placeholder bearer off the wire.

### packages/ai/test/cloudflare-stream.test.ts
- One specific line: the `{CLOUDFLARE_ACCOUNT_ID}` / `{CLOUDFLARE_GATEWAY_ID}` placeholders in a baseUrl are materialised before dispatch and left unresolved when the env does not supply them.

### packages/ai/test/cloudflare-utils.ts
- One specific line: credential-presence helpers for Cloudflare Workers AI and for the AI Gateway (which additionally needs `CLOUDFLARE_GATEWAY_ID`).

### packages/ai/test/cloudflare-workers-ai-system-one.test.ts
- One specific line: the account-scoped `/ai/run` envelope, the `typesafe/jev` classifier being reachable **only** through the classifier catalogue accessor, and non-completed runs and Cloudflare error envelopes surfacing as errors.

### packages/ai/test/codex-websocket-cached-probe.ts
- One specific line: a standalone runnable probe (not a vitest file) that drives a real tool loop against the Codex websocket-cached transport and prints transport, cache-hit and latency percentiles.

### packages/ai/test/compat-env.test.ts
- One specific line: the legacy API registry still dispatches a provider it has never seen, and the request `apiKey` reaches the registered implementation.

### packages/ai/test/compat-schema.test.ts
- Purpose: The compat flag bag is per-API, with a provider superset that inherits nothing.
- Key abstractions: `AnthropicMessagesCompatSchema`, `BedrockCompatSchema`, `OpenAICompletionsCompatSchema`, `OpenAIResponsesCompatSchema`, `ProviderCompatSchema` (TypeBox).
- Data flow: `Compile(schema).Default({})` → the default object → assertions about which keys appear.
- Non-obvious design decisions: the provider superset must NOT pick up API-specific defaults (`:33-39`) — otherwise a provider-level model would silently inherit `supportsDeveloperRole: true` and start sending a `developer` role to an endpoint that rejects it.
- Edge cases / failure handling: `expectTypeOf` pins the *literal* property types so a widened union (`supportsStore: boolean | undefined`) is caught at compile time.
- Surprising: this is the only place in the shard where the shape of the capability system is asserted directly.

### packages/ai/test/constrained-sampling.test.ts
- Purpose: Grammar- and strict-schema-constrained tool sampling.
- Key abstractions: `constrainedSampling: {type: "json_schema", strict}` and `{type: "grammar", variants: {openai_lark}}`; `makeStrictJsonSchema`; `appendGrammarToolInputJsonDelta`.
- Data flow: a tool with a constraint → `convertResponsesTools` → the wire tool; and the grammar path → `processResponsesStream` → a reassembled tool call.
- Non-obvious design decisions: a "require" constraint on an adapter that cannot do strict is a **hard throw** with a named message (`:95-100`), not a silent downgrade — a hard requirement must fail loudly.
- Edge cases / failure handling: a grammar with no variants also throws (`:109-…`); the streamed grammar input arrives as raw text deltas and is parsed into the argument object at `toolcall_end` (`:342-347`).
- Surprising: the test hooks `stream.push` to capture `toolcall_start`/`toolcall_delta` separately from the final message, so it can assert the *incremental* view as well as the final one.

### packages/ai/test/context-estimate.test.ts
- Purpose: How pi estimates how much context a request will consume.
- Key abstractions: `estimateContextTokens(context)` → `{tokens, usageTokens, trailingTokens, lastUsageIndex}`; `buildBaseOptions(model, context).maxTokens`.
- Data flow: the last assistant message's own `usage.totalTokens` is taken as the measured prefix; only the text after it is estimated.
- Non-obvious design decisions: the chars-per-token ratio for *new* text is **3.5**, not 4 (`:46-58`), because a large new input needs more room than chars/4 allows.
- Edge cases / failure handling: an assistant usage that is *older* than a message inserted after it is ignored, because it no longer describes the current prefix (`:60-77`).
- Surprising: `lastUsageIndex` is part of the return value, so a caller can tell "measured" from "estimated" — absence (`null`) is a distinct value from zero.

### packages/ai/test/context-overflow.test.ts
- Purpose: A live sweep proving every provider reports a context overflow recognisably.
- Key abstractions: `isContextOverflow(message, contextWindow?)`; a lorem-ipsum payload sized to `contextWindow + 10000` tokens.
- Data flow: an oversized prompt → the provider → the normalised message → `stopReason` + `errorMessage` → `isContextOverflow`.
- Non-obvious design decisions: the doc header (`:1-12`) states the contract explicitly — every provider must return `stopReason: "error"` with a context-too-large message, **or** (z.ai) succeed with `usage.input > contextWindow`; and `isContextOverflow()` must agree.
- Edge cases / failure handling: a local llama.cpp server on port 8081 is probed with a 4096-token window to match its `--ctx-size` (`:748-769`).
- Surprising: the overflow content is generated at `chars/4 × 1.5` so it *varied* text is used — repeated characters tokenise differently and would not overflow reliably.

### packages/ai/test/cross-provider-handoff.test.ts
- Purpose: A context produced by one provider must be consumable by another.
- Key abstractions: `PROVIDER_MODEL_PAIRS`; `completeSimple`; a `double_number` tool.
- Data flow: each source provider generates a four-message context (user → assistant-with-thinking-and-tool-call → tool result → assistant) → all contexts are concatenated → every target provider is asked to say hi.
- Non-obvious design decisions: the strategy is *generate-then-concatenate-then-consume* (`:10-22`), which is the only way to find cross-provider format incompatibilities (tool-call id formats, thinking-block transformations, message shapes).
- Edge cases / failure handling: a failure dumps the offending payload and the messages to the console before the assertion (`:495-505`) — a failed handoff is un-debuggable without the payload.
- Surprising: fixtures are generated fresh on every run (`:22`) rather than cached, so a provider that changes its id format is caught immediately.

### packages/ai/test/data/red-circle.png
- One specific line: a binary 200×200 PNG fixture (solid red circle on white) used by every image-input and tool-result-image test; opened and viewed as an image, not read as text.

### packages/ai/test/empty.test.ts
- Purpose: Degenerate inputs must degrade, not explode.
- Key abstractions: empty content array, empty string, whitespace-only content, an empty assistant message mid-history.
- Data flow: each degenerate context → `complete()` → the response must exist, be an assistant message, and either error with a message or carry content.
- Non-obvious design decisions: the assertion is *disjunctive* — "should either handle gracefully or return an error" (`:34-42`) — because different providers legitimately differ.
- Edge cases / failure handling: the whitespace-only case (`"   \n\t  "`, `:70-93`) is the one that catches a provider that rejects a blank turn outright.
- Surprising: an empty *assistant* message in the middle of the history is a separate case from an empty user message, because the former is what an aborted turn leaves behind.

### packages/ai/test/env-api-keys.test.ts
- One specific line: generic `GH_TOKEN`/`GITHUB_TOKEN` are **not** Copilot credentials, `ANTHROPIC_AUTH_TOKEN` is *reported* by `findEnvKeys` but never returned by `getEnvApiKey`, and `ANTHROPIC_OAUTH_TOKEN` is.

### packages/ai/test/error-body.test.ts
- Purpose: One normaliser for four different SDK error shapes.
- Key abstractions: `normalizeProviderError(error)` → `{status, body, message, messageCarriesBody}`; `formatProviderError(norm, prefix)`; `MAX_PROVIDER_ERROR_BODY_CHARS`.
- Data flow: a synthetic SDK error → the normaliser → the composed message.
- Non-obvious design decisions: the normaliser reports **whether the message already carries the body** (`messageCarriesBody`, `:22`, `:49`, `:85`) so the composer never duplicates it.
- Edge cases / failure handling: a Bedrock `$response.body` that is a **response stream** is ignored rather than serialised (`:67-86`), and a class-instance body without a `pipe` method is ignored too (`:88-…`) — serialising either would replace the real message with internals noise.
- Surprising: `@google/genai` folds the body into the message itself, so the normaliser must not re-add it — the same body, two different handling paths.

### packages/ai/test/event-stream.test.ts
- Purpose: The event stream's ordering and timing contract.
- Key abstractions: `EventStream<TEvent, TResult>`; `AssistantMessageEventStream`; `durationMs`.
- Data flow: push events → await iteration → await `result()`.
- Non-obvious design decisions: events pushed **after** completion are ignored (`:7-24`) — a late provider chunk cannot resurrect a finished turn; and buffered events drain in order before `result()` resolves.
- Edge cases / failure handling: `durationMs` is stamped only on a message the stream **saw start** (`:156-160`); a message that started before the stream (a fetched deferred result) is left untimed.
- Surprising: a forwarding stream keeps the *inner* measurement and does not overwrite it (`:140-154`) — the elapsed time belongs to the provider call, not to the relay.

### packages/ai/test/faux-provider.test.ts
- Purpose: A scriptable in-process provider double.
- Key abstractions: `registerFauxProvider({models})` → `{getModel, setResponses, state.callCount, unregister}`; `fauxAssistantMessage`, `fauxText`, `fauxThinking`, `fauxToolCall`.
- Data flow: `setResponses([...])` → `complete(model, context)` → the scripted message → usage estimated from the input.
- Non-obvious design decisions: the response list is *consumed in order* and the factories are model-aware (`(_ctx, _opts, _state, model) => …`, `:79`), so one script can branch on which model was called.
- Edge cases / failure handling: an abort during a tool-call delta produces `toolcall_start` + `toolcall_delta` + `error` but **no** `toolcall_end` (`:611-626`) — the exact shape a harness must tolerate mid-tool aborts.
- Surprising: `unregister()` makes the next call throw `No API provider registered for api: …` (`:628-636`), so the double can prove the dispatch path is really gone.

### packages/ai/test/fetch-option.test.ts
- Purpose: The per-request `fetch` option must reach every transport.
- Key abstractions: `ProviderStreamOptions.fetch`; `FetchFunction`.
- Data flow: a custom fetch → the adapter → the request; the ambient `globalThis.fetch` is a spy that throws if called.
- Non-obvious design decisions: the Google adapters **refuse** a custom fetch with an explicit error rather than silently ignoring it (`:124-140`) — silent bypass is how a proxy/DNS policy gets skipped.
- Edge cases / failure handling: passing `globalThis.fetch` *explicitly* to a Google adapter is accepted (`:142-159`), so the check is "is this the ambient fetch?" not "is a fetch supplied?".
- Surprising: the image-generation path is included (`:161-179`) — the fetch option is a *provider* option, not a chat-only option.

### packages/ai/test/fireworks-model-generation.test.ts
- Purpose: The generated Fireworks catalogue must reflect upstream effort metadata.
- Key abstractions: `spawnSync(node, ["--import", preload, "scripts/generate-models.ts", "--json-only"])`; a preload module that stubs `globalThis.fetch` for models.dev.
- Data flow: a mocked models.dev catalogue → the real generator → `providers/fireworks.json` → assertions on `thinkingLevelMap` and `compat`.
- Non-obvious design decisions: the generator is run as a **subprocess with a fetch preload**, so the real generator code path (not a re-implementation) is exercised (`:37-60`).
- Edge cases / failure handling: a model whose metadata is only a toggle, only a budget, or missing entirely must NOT get adaptive thinking (`:129-141`).
- Surprising: the test asserts that upstream effort metadata **overrides** the hardcoded per-model map (`:144-167`) — the hardcoded map is a fallback, not the source of truth.

### packages/ai/test/fireworks-models.test.ts
- One specific line: pins which Fireworks models use the Anthropic-Messages API vs OpenAI-completions, that a "fast" router alias must mirror its base model's `compat` and `thinkingLevelMap` exactly, and that unsupported long cache retention is omitted.

### packages/ai/test/generate-models-strict.test.ts
- Purpose: The strict generator must fail without mutating anything.
- Key abstractions: an isolated copy of `package.json` + `scripts` + `src` in a temp dir; the generated file set.
- Data flow: a mocked models.dev catalogue where one model loses tool support → `generate-models.ts --strict` → exit code 1 → the generated files are compared byte-for-byte with their pre-run content.
- Non-obvious design decisions: the assertion is on **all four** generated artefacts (the aggregator, the provider shard, the data JSON and the data manifest) and on the *original* checkout as well as the isolated copy (`:82-85`).
- Edge cases / failure handling: the error message names the exact missing model id (`:79-81`).
- Surprising: this is a transactional-write test for a code generator — the property August's migration runner wants.

### packages/ai/test/github-copilot-anthropic.test.ts
- One specific line: Copilot Claude over the Anthropic Messages API uses `authToken` (not `apiKey`) plus the Copilot static and dynamic headers, applies per-model adaptive-thinking effort overrides, and omits the interleaved-thinking beta.

### packages/ai/test/github-copilot-oauth.test.ts
- One specific line: the Copilot device-code login, the model-list and per-model policy endpoints, and the `slow_down` polling cadence (5 s then 15 s) under fake timers.

### packages/ai/test/github-copilot-request-size-overflow.test.ts
- One specific line: an HTTP 413 (nested or flat error body) is classified as a context overflow through the real SDK, while the same body under a 400 is not, and the usage stays zero.

### packages/ai/test/google-raw-stop-reason.test.ts
- One specific line: Gemini finish reasons are kept raw (`MALFORMED_FUNCTION_CALL`, `SAFETY`, `MAX_TOKENS`), provider chunks are forwarded to `onProviderStreamEvent` in order, and the User-Agent defaults to pi but is overridable.

### packages/ai/test/google-shared-convert-tools.test.ts
- Purpose: Turning a TypeBox schema into a Gemini function declaration.
- Key abstractions: `convertTools(tools, useParameters)`; `resolveGoogleFunctionCallingMode`; `supportsGoogleStrictToolSampling`.
- Data flow: a tool schema → `convertTools` → `functionDeclarations[0].parameters`.
- Non-obvious design decisions: JSON Schema *meta* keys (`$schema`, `$id`, `$comment`, `$defs`, `definitions`) are stripped **recursively** (`:56-83`) while `$ref` is preserved (`:85-112`).
- Edge cases / failure handling: the conversion must not mutate the caller's schema object (`:114-135`) — the tool object is reused across requests.
- Surprising: `useParameters: false` keeps `$schema` and sends a `parametersJsonSchema` instead (`:137-161`) — two different Gemini dialects for the same schema.

### packages/ai/test/google-shared-gemini3-unsigned-tool-call.test.ts
- One specific line: Gemini 3 tool-call ids survive the round trip, unsigned tool calls get no `skip_thought_signature_validator`, a valid signature is preserved only for the same provider and model, and `requiresToolCallId` is gated per model.

### packages/ai/test/google-shared-image-tool-result-routing.test.ts
- One specific line: an image tool result is nested inside the `functionResponse` for Gemini 3 but split into a synthetic user turn for Gemini 2.x, and whitespace-only tool text becomes empty output rather than a blank string.

### packages/ai/test/google-shared-retry.test.ts
- One specific line: `retryGoogleRequest` retries a headers-less SDK error carrying a retryable status, does nothing when `maxRetries` is unset, and does not retry a non-retryable status.

### packages/ai/test/google-shared-signed-empty-blocks.test.ts
- Purpose: An empty but *signed* block must be kept, because dropping it breaks the reasoning chain.
- Key abstractions: `thoughtSignature` on a thinking or text block; the provider/model identity on the assistant message.
- Data flow: an assistant message with an empty signed thinking block → `convertMessages` → the model turn's parts.
- Non-obvious design decisions: the rule is "an empty text/thinking block is skipped only when it is **UNSIGNED**" (`:9-10`) — a signed empty block is the mechanism by which Gemini binds a thought burst to the next request.
- Edge cases / failure handling: a signature belonging to a *different* provider/model is dropped (`:109-125`), because it is unusable there.
- Surprising: the header comment (`:6-10`) names the observable symptom: dropping such blocks makes the model "intermittently end a mid-task turn with a thought-only STOP and no tool call".

### packages/ai/test/google-thinking-disable.test.ts
- One specific line: a live cross-provider check that thinking is really off — zero thinking events, no thinking block in the content, and the exact-output answer still complete — for Anthropic, Gemini 2.5/3.x, Vertex and OpenRouter.

### packages/ai/test/google-thinking-level-map.test.ts
- One specific line: `thinkingLevelMap` resolution for Google and Vertex, including that the mapped level also selects the matching token budget from `thinkingBudgets`.

### packages/ai/test/google-thinking-signature.test.ts
- One specific line: only `part.thought === true` marks a part as thinking (a bare `thoughtSignature` does not, per Google's own docs), and a signature is retained across later deltas that omit it.

### packages/ai/test/google-vertex-api-key-resolution.test.ts
- One specific line: placeholder apiKey markers (and a placeholder `GOOGLE_CLOUD_API_KEY`) fall back to ADC, and a custom baseUrl that already carries an apiVersion is not given a second one.

### packages/ai/test/identity.test.ts
- Purpose: The client identity headers.
- Key abstractions: `ClientIdentity`; `formatUserAgent`; `getIdentityHeaders`; `getAttributionHeaders`; `mergeClientIdentity`; `withClientIdentity`.
- Data flow: an identity → the request headers → the captured request.
- Non-obvious design decisions: `PI_AI_VERSION` is asserted equal to `package.json`'s version (`:69-72`) — a version constant that can drift is a bug factory.
- Edge cases / failure handling: attribution is sent **only** when enabled (`:94-…`); the User-Agent can be a bare string (`"pi"`), a custom string, or a `{custom}` object (`:74-79`).
- Surprising: the per-provider header rule is also here — a custom provider pointing at OpenCode gets `x-opencode-session` from the session id (`:236-254`), and an explicit header wins.

### packages/ai/test/image-model-data.test.ts
- One specific line: the OpenRouter catalogue builder splits one model id into separate chat and image entries, drops models that neither support tools nor emit images, and emits decision models as System One classifiers.

### packages/ai/test/image-tool-result.test.ts
- One specific line: a live E2E in which a tool result containing **only** an image reaches the model and the model describes its colour and shape, across every image-capable provider.

### packages/ai/test/images-models.test.ts
- One specific line: the registry discriminates chat, image and classifier entries, one credential covers both the chat and the image model of a provider, and the image entry of a dual-operation id is reachable only through `getModelOfType("image", …)`.

### packages/ai/test/images.test.ts
- One specific line: live image generation through OpenRouter — a basic generation and an image-to-image variation that uses the red-circle fixture.

### packages/ai/test/interleaved-thinking.test.ts
- One specific line: a live check that the model thinks again before the **second** tool call (thinking present in both turns), for Anthropic and Bedrock.

### packages/ai/test/json-parse.test.ts
- Purpose: Streaming JSON parsing that does not lose fields.
- Key abstractions: `parseStreamingJson`; `parseToolCallArguments` → `{arguments, argumentsError?}`.
- Data flow: a partial JSON string → the parser → either an object or an explicit error.
- Non-obvious design decisions: an invalid `\u` escape is kept as **literal text** rather than dropping the field (`:6-13`), because a Windows path or a LaTeX command is far more common than a real bad escape.
- Edge cases / failure handling: malformed tool arguments yield `arguments: {}` **and** an `argumentsError` carrying the raw text (`:36-42`) — the valid prefix is never kept.
- Surprising: a cut-off JSON document is not completed (`:44-49`), even though `partial-json` is a dependency; a half-written tool call is a refusal, not a guess.

### packages/ai/test/kimi-coding-oauth.test.ts
- One specific line: the Kimi device-authorization login — poll timing with `waitBeforeFirstPoll`, `temporarily_unavailable` retried, `invalid_grant` not retried, and the refresh path's own rules.

### packages/ai/test/lax-message-content.test.ts
- Purpose: The one place where the message contract is deliberately relaxed.
- Key abstractions: `transformMessages(messages, model)` as the choke point before every provider request.
- Data flow: a hand-built message with `content: null` → `transformMessages` → a normalised message with `content: []`.
- Non-obvious design decisions: the type says `content` is always present, but untyped callers (custom tools, hand-built histories, old session files) violate it, so the choke point normalises instead of throwing (`:4-7`).
- Edge cases / failure handling: the test uses a **text-only** model so the image-downgrade path also runs — that was the original crash site for null tool-result content (`:13-15`).
- Surprising: the header names the two issue numbers, so the reason for the laxness is recoverable from the code.

### packages/ai/test/lazy-module-load.test.ts
- Purpose: The provider SDKs must not be loaded until a provider is actually used.
- Key abstractions: `node:module`'s `registerHooks` with a `resolve` hook that records specifiers; a spawned node process.
- Data flow: spawn node → import the barrel → import the compat entrypoint → build all builtin providers → stream through one adapter → the recorded specifier list is asserted.
- Non-obvious design decisions: the probe asserts the **exact** list, so loading one extra SDK fails the test (`:60-79`, `:81-112`).
- Edge cases / failure handling: the probe runs the real source (`../src/index.ts`), not the built package, so it measures the source graph.
- Surprising: even `builtinModels().getModels()` must load zero SDKs — the catalogue is data, not code, and the test enforces that.

### packages/ai/test/max-thinking.test.ts
- Purpose: The `xhigh`/`max` reasoning levels are opt-in per model.
- Key abstractions: `thinkingLevelMap` as `{logicalLevel: wireValue | null}`; `getSupportedThinkingLevels`; `clampThinkingLevel`.
- Data flow: a model → its map → the offered level set → a clamped request level → the wire `reasoning.effort`.
- Non-obvious design decisions: a **hole** in the ladder is representable — `{xhigh: null, max: "max"}` yields the levels `off, minimal, low, medium, high, max` with no `xhigh` (`:51-68`).
- Edge cases / failure handling: `clampThinkingLevel(model, "xhigh")` falls back to `"max"` and `clampThinkingLevel(model, "max")` falls back to `"high"` for a model that has neither.
- Surprising: the same map is what the UI reads to decide which levels to offer, so a capability ladder is one piece of data, not three code paths.

### packages/ai/test/message-types.test.ts
- One specific line: `ToolResultMessage.details` must be a `JsonValue`; non-JSON detail types (`any`, `undefined[]`, a callback, a `Date`, `unknown`) are rejected at the type level.

### packages/ai/test/meta-oauth.test.ts
- One specific line: the Meta device flow plus a second step that mints a Model API key from the identity token and re-mints it on refresh; a missing key reports the billing setup URL.

### packages/ai/test/mistral-http-transport.test.ts
- Purpose: The Mistral wire body, byte by byte.
- Key abstractions: the Mistral request shape; `promptMode`; `reasoningEffort`; `toolChoice`; `responseFormat`.
- Data flow: SDK-style options → the serialised JSON body → the captured request URL, headers and body.
- Non-obvious design decisions: `onPayload` may **return a modified payload** (`:81-102`) and the modification is what goes on the wire — the hook is an edit point, not only an observer.
- Edge cases / failure handling: a byte-at-a-time SSE response is parsed correctly (`:17-28`); a timeout produces a thinking-only message (`:520-527`); an HTTP 403 keeps both the status and the body in the error (`:529-541`).
- Surprising: the tool choice is forwarded in Anthropic shape (`{type: "function", function: {name}}`, `:79`) and translated to the Mistral shape on the wire.

### packages/ai/test/mistral-raw-stop-reason.test.ts
- One specific line: Mistral's finish reason is kept raw; an unknown finish reason becomes a non-retryable provider error while `error` is retryable, and the retry classifier reads the *message* to decide.

### packages/ai/test/mistral-reasoning-mode.test.ts
- Purpose: How the reasoning control is expressed per model family.
- Key abstractions: `promptMode: "reasoning"` vs `reasoning_effort`; `thinkingLevelMap` with `null` holes.
- Data flow: a reasoning level → the model's map → the clamped wire value → the payload field.
- Non-obvious design decisions: Magistral uses `prompt_mode`; the newer models **ignore** Magistral's `prompt_mode` and use `reasoning_effort` (`:88-111`), and an unsupported level is clamped to a supported one rather than rejected.
- Edge cases / failure handling: `reasoning_effort: "none"` is sent when thinking is off (`:105-110`); a non-reasoning model gets neither field (`:136-141`).
- Surprising: `promptCacheKey` is the session id, and it is omitted entirely when cache retention is off (`:143-158`) — the cache key is part of the retention policy, not of the identity.

### packages/ai/test/mistral-tool-schema.test.ts
- One specific line: TypeBox symbol keys must be stripped from the tool parameters — recursively — before the Mistral SDK validates the schema, or the SDK rejects the request with "Input validation failed".

### packages/ai/test/model-catalog-types.test.ts
- One specific line: compile-time assertions that the grouped model data still yields literal `api`, `id` and `provider` types, so a catalogue entry cannot silently widen into `string`.

### packages/ai/test/model-cost-tiers.test.ts
- One specific line: OpenRouter's prompt-length overrides become cost tiers, a base rate missing from an override is kept, time-of-day overrides are ignored, and the Vercel AI Gateway's bracket prices become tiers with the rates in effect at each bracket.

### packages/ai/test/model-data-validation.test.ts
- Purpose: The published model-data directory is validated before it is trusted.
- Key abstractions: `MODEL_DATA_MANIFEST_FILE`; `MODEL_DATA_SCHEMA_VERSION`; `ModelDataStructure`; `assertExactModelIds`; `validateModelDataDirectory`; `hydrateModelCatalog`.
- Data flow: a temp fixture package → a manifest + a provider JSON shard → `validateModelDataDirectory` → acceptance or a named rejection.
- Non-obvious design decisions: the manifest carries a **generation timestamp** and a **schema version**, and both are checked (`:338-345`); the aggregator's imports must match the shards on disk exactly (`:347-354`).
- Edge cases / failure handling: hydration of a clean checkout is asserted to be **deterministic** and to leave the generated TypeScript unchanged (`:87-98`).
- Surprising: this is a lockfile for generated data — the same idea as a migration manifest.

### packages/ai/test/model-types.test.ts
- One specific line: a chat model with no `type` field works through a handwritten provider, mixed lists narrow with `isModelType`, and stored models of an **unknown** type (`embedding`, `video`) are dropped rather than failing the refresh.

### packages/ai/test/models-entry.test.ts
- Purpose: The lightweight `models` entry point must not drag in the world.
- Key abstractions: a `node:module` `load` hook that throws when a forbidden URL is loaded; the list of forbidden paths (TypeBox, the four SDKs, `/providers/data/`, `models.generated.`).
- Data flow: spawn node with the preload → import the entry → build a faux provider → run a completion → assert exit 0.
- Non-obvious design decisions: the preload is installed **before** the static imports (`:8`) so that even unused barrel re-exports are checked.
- Edge cases / failure handling: the test runs against both the source entry and the published package specifier (`:31`).
- Surprising: `/providers/data/` and `models.generated.` are forbidden too — the catalogue JSON is not allowed in the light path either.

### packages/ai/test/models-runtime.test.ts
- Purpose: The `Models` runtime — the registry, auth and refresh machinery.
- Key abstractions: `createModels({credentials, modelsStore})`; `createProvider`; `getAuth(provider)`; `refresh({providers, allowNetwork})`; `DeferredHandle` / `fetchDeferred` / `cancelDeferred`.
- Data flow: a provider registers → the model list is enumerated → auth is resolved (and refreshed) → a stream runs → a deferred handle is fetched or cancelled.
- Non-obvious design decisions: credential **metadata** is enumerable without exposing the secret (`:110-…`); `refresh` returns an error **map** rather than throwing, so one failing provider does not abort the others.
- Edge cases / failure handling: an unknown provider produces an **error stream** (`Unknown provider: ghost`, `:1193-1198`) rather than a thrown exception — the same shape as a model-level failure.
- Surprising: `fetchDeferred` and `cancelDeferred` are separate provider methods, so a long-running request can be polled and then killed.

### packages/ai/test/node-http-proxy.test.ts
- One specific line: proxy resolution honours `NO_PROXY` including wildcards, IPv6 and `host:port`, prefers scoped env aliases over process env, and refuses SOCKS and PAC URLs with a named error message.

### packages/ai/test/oauth-auth.test.ts
- Purpose: The OAuth adapter contract, across every provider.
- Key abstractions: `OAuthAuth` with `login` / `refresh` / `toAuth` / `isSubscription`; `InMemoryCredentialStore`.
- Data flow: a stored credential → `models.getAuth(provider)` → `{auth: {apiKey, baseUrl?}, source}`.
- Non-obvious design decisions: `isSubscription` marks exactly the subscription-backed flows (`:32-44`) — OpenRouter is an API-key provider with an OAuth front-end and must not be labelled a subscription.
- Edge cases / failure handling: the extension OAuth barrel must **not** export the built-in flows (`:23-26`), so an extension cannot depend on a built-in by accident.
- Surprising: GitHub Copilot's `toAuth` derives the **baseUrl** from the token's `proxy-ep` field, with a GHE fallback chain (`:77-100`).

### packages/ai/test/oauth-callback-server.test.ts
- Purpose: The loopback callback server used by the browser OAuth flows.
- Key abstractions: `startOAuthCallbackServer({providerName, host, port, path, state, complete})` → `{redirectUri, wait(), close()}`; `waitForCallbackOrManualInput`.
- Data flow: the server listens on an ephemeral port → a browser hits `redirect_uri?code&state` → the server validates and resolves `complete(code)`.
- Non-obvious design decisions: the state check is **skipped when no state is expected** (`:80-…`) — some providers do not use one — and the redirect host is configurable separately from the listen host.
- Edge cases / failure handling: a wrong path is 404, a wrong state is 400 with an HTML page naming the mismatch (`:56-60`), a POST is 404, a missing code is 400.
- Surprising: the success page is a styled HTML page with three named brand colours (`:74-75`) — the OAuth callback is a user-visible surface, not just a protocol endpoint.

### packages/ai/test/oauth-device-code.test.ts
- Purpose: The device-code polling cadence.
- Key abstractions: `pollOAuthDeviceCodeFlow({intervalSeconds, expiresInSeconds, waitBeforeFirstPoll, poll, signal})`.
- Data flow: the poller → `poll()` → `{status: "pending" | "slow_down" | "complete"}` → resolve or reject.
- Non-obvious design decisions: a `slow_down` with no server interval **adds 5 seconds** to the current interval (`:68-96`), while a server-supplied interval **replaces** it (`:98-129`).
- Edge cases / failure handling: `waitBeforeFirstPoll` defers even the first poll (`:44-66`); an abort during the wait rejects with `Login cancelled` and leaves no timer behind.
- Surprising: the poll times are asserted to the millisecond under fake timers (`:95`, `:128`), so a drift of one tick is caught.

### packages/ai/test/openai-chatgpt-oauth.test.ts
- One specific line: the ChatGPT OAuth flow registers a user-owned client, stores the **issued** client id and the granted scopes, refreshes three minutes early, and sends no `scope` on refresh.

### packages/ai/test/openai-codex-cache-affinity-e2e.test.ts
- One specific line: a live Codex SSE request in which the session id is used consistently as the cache-affinity identifier.

### packages/ai/test/openai-codex-oauth.test.ts
- One specific line: the Codex device-code and browser flows, the manual-paste path, and the account id carried inside the access token's payload.

### packages/ai/test/openai-codex-stream.test.ts
- Purpose: The Codex transport — SSE, websocket, and the cached websocket.
- Key abstractions: `transport: "sse" | "websocket" | "websocket-cached" | "auto"`; `getOpenAICodexWebSocketDebugStats(sessionId)`; `zstdDecompressSync`.
- Data flow: the request is either an SSE POST or a websocket frame → the events are decoded → the assistant message is assembled → the debug stats record connections created/reused, full vs delta requests and fallbacks.
- Non-obvious design decisions: in `websocket-cached` mode the second request sends **only the delta** and carries `previous_response_id` (`:2241-2252`), so the server keeps the context; `store` is always false (`:2244`).
- Edge cases / failure handling: a websocket that is idle **before** the first event falls back to SSE (`:1803-1903`); a websocket idle **after** the stream started is an error, not a fallback (`:1905-1988`); a `previous_response_not_found` is recovered by reconnecting with the full context (`:2266-2481`); the cached connection is recycled before the backend's connection-age limit (`:1990-2092`).
- Edge cases / failure handling (retry): a server-requested delay above the limit fails immediately (`:2557-2595`), and repeated retries without a header use exponential backoff 1s/2s/4s (`:2670-2745`).
- Surprising: request bodies are **zstd-compressed** (`:2597-2668`), and the test decompresses them to assert the content — a wire detail August would otherwise rediscover the hard way.

### packages/ai/test/openai-completions-cache-control-format.test.ts
- Purpose: Anthropic-style cache markers on an OpenAI-compatible endpoint.
- Key abstractions: `compat.cacheControlFormat: "anthropic"`; `cache_control: {type: "ephemeral"}` on message parts and tools.
- Data flow: the context → the OpenAI body → the marker placement.
- Non-obvious design decisions: the conversation marker is **moved onto the trailing tool result** when the turn ends with one (`:162-201`) — the marker must sit on the last stable prefix, not on a message that is about to change.
- Edge cases / failure handling: with `cacheRetention: "none"` the markers vanish entirely and the content reverts to a plain string (`:203-230`).
- Surprising: the OpenRouter Anthropic "batch" aliases carry the anthropic cache format on the *completions* API — a per-model flag, not a per-API one.

### packages/ai/test/openai-completions-empty-tools.test.ts
- Purpose: An empty tool list must not be serialised.
- Key abstractions: `context.tools` (possibly `[]`); the OpenAI request body.
- Data flow: a context with `tools: []` → the body → the assertion that `tools` is **absent**.
- Non-obvious design decisions: the header records the concrete failure (`"[] is too short - 'tools'"`, HTTP 400, DashScope/Qwen) — the rule exists because of a named backend.
- Edge cases / failure handling: a turn that genuinely contained a tool call still sends `tools: []` (`:295-303`) — the empty array is meaningful there and must not be dropped.
- Surprising: the distinction is "no tools were ever offered" vs. "the tools are gone now", and both reach the wire differently.

### packages/ai/test/openai-completions-prompt-cache.test.ts
- Purpose: `prompt_cache_key`, `prompt_cache_retention` and the session-affinity headers.
- Key abstractions: `sessionId` → `prompt_cache_key`; `compat.sendSessionAffinityHeaders`; `sessionAffinityFormat`.
- Data flow: the options → the request body and the default headers.
- Non-obvious design decisions: explicit caller headers **override** the generated session-affinity headers (`:258-278`), so a user can point affinity at their own gateway.
- Edge cases / failure handling: with cache retention off, neither the cache key nor the affinity headers are sent (`:…`, `:253-256`).
- Surprising: `prompt_cache_key` and `prompt_cache_retention` are separate knobs — the key is the session, the retention is the policy.

### packages/ai/test/openai-completions-provider-stream-event.test.ts
- One specific line: the provider's raw chunks — including OpenRouter's `openrouter_metadata` — are exposed verbatim through `onProviderStreamEvent`.

### packages/ai/test/openai-completions-raw-stop-reason.test.ts
- One specific line: the OpenAI `finish_reason` is preserved raw next to the normalised `stopReason`, and `content_filter` becomes a provider error with the raw reason attached.

### packages/ai/test/openai-completions-reasoning-details.test.ts
- One specific line: `reasoning_details` (encrypted, text and summary variants) are carried into the thinking signature and replayed, and a single delta carrying both reasoning and content orders thinking before text.

### packages/ai/test/openai-completions-response-model.test.ts
- One specific line: a router model keeps `model` = the requested id and exposes the routed concrete id in `responseModel`; an echoing or empty `chunk.model` leaves `responseModel` undefined.

### packages/ai/test/openai-completions-retry.test.ts
- One specific line: SDK-internal retries are disabled (`maxRetries: 0` on the SDK call) so that only pi's own retry policy applies, and a server-requested delay above the limit fails immediately instead of sleeping.

### packages/ai/test/openai-completions-thinking-as-text.test.ts
- One specific line: for an adapter that requires thinking as text, a same-model thinking block is replayed as an assistant text part, and the request still reaches the endpoint.

### packages/ai/test/openai-completions-thinking-token-budget.test.ts
- One specific line: the thinking token budget is clamped to the response ceiling minus 1024, `xhigh` and `max` clamp to the high budget, a named budget field wins over the boolean alias, and a `chat_template_kwargs` mapping can carry the budget instead.

### packages/ai/test/openai-completions-tool-choice.test.ts
- Purpose: The OpenAI-completions wire in full: tool choice, stream termination, tool-call accumulation and per-provider reasoning shapes.
- Key abstractions: `compat.supportsFinishReason`; tool-call deltas keyed by `index`; `thinkingFormat` (`openai`, `zai`, `qwen`, `together`, `chat-template`, `openrouter`).
- Data flow: mocked chunks → the accumulator → the tool call → the final message.
- Non-obvious design decisions: a stream that ends with only `finish_reason: null` chunks is an **error** — `Stream ended without finish_reason` (`:702-732`) — unless the model opts out with `supportsFinishReason: false` (`:734-759`).
- Edge cases / failure handling: tool-call deltas are coalesced by a stable `index` even when the provider mutates the id mid-stream (`:810-…`), and an empty `custom: {}` object on a delta is ignored (`:761-808`).
- Edge cases / failure handling (reasoning): the same logical effort maps to different wire fields per provider — `reasoning_content` vs `reasoning.effort` vs `thinking: {type}` vs `chat_template_kwargs` — and the file asserts one family at a time (`:1400-1955`).
- Surprising: the "finish_reason required" rule is a *model capability flag*, so a provider that cannot report completion is trusted — the same shape as August's abort/stall detection.

### packages/ai/test/openai-completions-tool-result-images.test.ts
- Purpose: Tool results that carry images.
- Key abstractions: `image_url` parts; the OpenAI `tool` message role.
- Data flow: two tool results, one with an image → `convertMessages` → the tool messages plus a trailing user message carrying the images.
- Non-obvious design decisions: images from **consecutive** tool results are **batched** into one trailing user message (`:101-145`) rather than one message per image.
- Edge cases / failure handling: an empty text part in a user message that also has an image is dropped (`:73-99`); whitespace-only tool output becomes the literal `(no tool output)` placeholder (`:148-184`).
- Surprising: the placeholder exists because an empty `content` on a tool message is rejected by some backends — it is a protocol requirement, not a nicety.

### packages/ai/test/openai-completions-vllm-priority.test.ts
- One specific line: `compat.vllmPriority` is sent as the top-level `priority` request field and omitted entirely when unset.

### packages/ai/test/openai-decisions.test.ts
- One specific line: the OpenAI Decisions classifier maps choice/score/bool questions to the wire shape, matches the answers back by **name** rather than by order, prices usage, and refuses a model whose API is not `openai-decisions`.

### packages/ai/test/openai-responses-cache-affinity-e2e.test.ts
- One specific line: a live direct OpenAI Responses request with aligned cache-affinity identifiers.

### packages/ai/test/openai-responses-chatgpt-sign-in.test.ts
- Purpose: The same model, two credential shapes, two request shapes.
- Key abstractions: the ChatGPT token vs the API key; `compat.supportsExplicitPromptCacheMode`.
- Data flow: a token → the Responses body → the field set.
- Non-obvious design decisions: a ChatGPT token rejects `max_output_tokens`, `temperature` and `prompt_cache_retention`, so those fields are **omitted** (`:45-51`) — an explicit-key path for a restricted credential.
- Edge cases / failure handling: an API key or another OpenAI-compatible endpoint keeps all of them (`:63-76`).
- Surprising: the credential shape, not the endpoint, decides which request fields are legal.

### packages/ai/test/openai-responses-compat.test.ts
- One specific line: the Responses provider defaults — reasoning omitted when not requested, `tool_choice` forwarded, session-affinity headers emitted, and `supportsMaxOutputTokens` gating `max_output_tokens`.

### packages/ai/test/openai-responses-empty-tool-result.test.ts
- One specific line: whitespace-only tool-result text becomes the `(no tool output)` placeholder inside `function_call_output`.

### packages/ai/test/openai-responses-foreign-toolcall-id.test.ts
- Purpose: A foreign tool-call id must be made legal for the target API.
- Key abstractions: `shortHash`; the `fc_<hash>` id shape; the 64-character id limit.
- Data flow: a 400+ character Copilot id → `convertResponsesMessages` → a hashed `fc_…` item id → the replayed body.
- Non-obvious design decisions: the hash is taken over the **second** segment of the pipe-separated id (`:61`) — the part that is actually the provider's item id — not over the whole string.
- Edge cases / failure handling: the result is asserted to be ≤ 64 characters and to match `^fc_[A-Za-z0-9]+$` (`:63-64`).
- Surprising: the id is stable across a replay, so the pairing between the call and its result survives the hash.

### packages/ai/test/openai-responses-message-id.test.ts
- One specific line: the fallback message ids for multiple text blocks in one assistant turn are unique (`msg_pi_1`, `msg_pi_1_1`).

### packages/ai/test/openai-responses-mid-convo-effort.test.ts
- Purpose: Changing the effort mid-conversation.
- Key abstractions: `reasoningEffort`; the `configuration_update` input item.
- Data flow: turn 1 at `high` → turn 2 at `high` (no change) → turn 3 at `low` (change) → the body.
- Non-obvious design decisions: the top-level `reasoning.effort` stays **constant** across the conversation and only a `configuration_update` input item is appended when the level changes (`:93-…`) — the wire shape is designed for a mid-conversation change.
- Edge cases / failure handling: when the compat flag is off, or the level is `off`, the level is sent as a plain `reasoning.effort` and no `configuration_update` item is added (`:180-203`).
- Surprising: `message.providerThinkingLevel` is left undefined on this path — the level lives in the request, not in the transcript.

### packages/ai/test/openai-responses-namespace.test.ts
- Purpose: Tool-call namespaces (`dynamic_tools`) must round-trip.
- Key abstractions: the `namespace` field on a function/custom tool call.
- Data flow: a namespace that arrives only on `output_item.done` → the tool call block → the replayed body.
- Non-obvious design decisions: the namespace is dropped for targets that **cannot replay the load items** (`:178-224`) — replaying a namespace the target does not understand would 400.
- Edge cases / failure handling: an ordinary function call gets no namespace (`:226-242`); an absent error message is not added to the output (`:114-119`).
- Surprising: the tool-call id is the composite `call_id|item_id` (`:129`), which is what lets the replay split them back apart.

### packages/ai/test/openai-responses-partial-json-cleanup.test.ts
- Purpose: The streaming partial-JSON scratch state must not reach the transcript.
- Key abstractions: `partialJson` on a tool-call block; `argumentsError`.
- Data flow: argument deltas → the accumulated block → `output_item.done` → the persisted block.
- Non-obvious design decisions: `partialJson` is **removed** from the persisted block at `output_item.done` (`:95`) and from the emitted `toolcall_end` event (`:104`); the streaming scratch state is not part of the durable message.
- Edge cases / failure handling: malformed final arguments set `arguments: {}` and an `argumentsError` carrying the raw text rather than keeping the parsed prefix (`:108-131`).
- Surprising: the test asserts the *persisted* block and the *emitted event* are the same object, so a divergence between what the UI saw and what was stored is impossible.

### packages/ai/test/openai-responses-reasoning-replay-e2e.test.ts
- Purpose: Live proof that a corrupted history does not brick the next turn.
- Key abstractions: an assistant message whose content is only the thinking block, with `stopReason: "aborted"`.
- Data flow: a real tool-calling reply → the reasoning block is isolated → a follow-up turn.
- Non-obvious design decisions: the aborted-turn case (`:19-81`) and the same-provider different-model handoff (`:83-…)` are separate live scenarios, because they fail differently.
- Edge cases / failure handling: the assertion is only "not an error" plus non-empty content — the model may answer or call a tool.
- Surprising: the header comment (`:83-91`) spells out the provider's 400 ("function_call without required reasoning item") and the fix (tool calls and results converted to text).

### packages/ai/test/openai-responses-terminal-event.test.ts
- Purpose: A Responses stream must end with a terminal event.
- Key abstractions: `response.completed` / `response.incomplete` / `response.failed`; `rawStopReason`.
- Data flow: a truncated stream → the processor → the outcome.
- Non-obvious design decisions: an early EOF (a stream that ends mid-reasoning) is an **error**, not a partial success (`:…`); an incomplete response carries `rawStopReason: "incomplete.max_output_tokens"` (`:405`) and `"incomplete.content_filter"` (`:423`).
- Edge cases / failure handling: an unknown incomplete reason is treated as a non-retryable error (`:427-437`); a failed terminal event rejects with the provider's own error text (`:439-448`).
- Surprising: the `rawStopReason` vocabulary is `incomplete.<reason>`, so the normalised reason and the provider's reason are both available.

### packages/ai/test/openai-responses-tool-result-images.test.ts
- One specific line: tool-result images stay inside the `function_call_output` item as `input_text` + `input_image` and are **not** lifted into a later user message.

### packages/ai/test/openai-responses-usage-limit.test.ts
- One specific line: a ChatGPT subscription usage-limit error — returned as an HTTP 429 or as a failed stream event — puts a ChatGPT usage link in the error message.

### packages/ai/test/opencode-provider-headers.test.ts
- One specific line: the OpenCode session header is mapped from `sessionId` on both the `stream` and `streamSimple` paths, a case-insensitive caller override is preserved, and no header is fabricated without a session id.

### packages/ai/test/openrouter-cache-control-models.test.ts
- One specific line: the OpenRouter Anthropic "latest" aliases keep the anthropic cache-control format on the completions API.

### packages/ai/test/openrouter-cache-write-repro.test.ts
- One specific line: a live repro asserting `cache_write_tokens` survives the openai-completions stream path when an explicit `cache_control` marker is added to the last user message.

### packages/ai/test/openrouter-images.test.ts
- One specific line: OpenRouter image generation returns text plus images, honours the abort signal, and requests only the image modality for an image-only model.

### packages/ai/test/openrouter-oauth.test.ts
- One specific line: the OpenRouter PKCE flow on a one-shot loopback callback exchanges the code for a permanent API key, and the callback host is configurable by env.

### packages/ai/test/openrouter-reasoning-options.test.ts
- One specific line: OpenRouter's reasoning metadata becomes a `thinkingLevelMap` (mandatory reasoning leaves `off` unavailable) and a mandatory-reasoning model omits the `reasoning` field entirely when no effort was requested.

### packages/ai/test/openrouter-user-models.test.ts
- One specific line: personalising the catalogue from `/models/user` keeps only the key's models with the key's limits and prices, leaves image and classifier entries alone, and returns the catalogue unchanged on 401/403/404.

### packages/ai/test/overflow.test.ts
- Purpose: The context-overflow classifier.
- Key abstractions: `isContextOverflow(message, contextWindow?)`; `isRecoverableLength(message, contextWindow?)`.
- Data flow: an error message → the classifier → a boolean.
- Non-obvious design decisions: the HTTP status is matched only at the **start** of the message: `413` is an overflow but `4130` is not, and a 413 quoted inside a 400 body is not (`:46-55`).
- Edge cases / failure handling: the status match applies only to a **failed** response — the same message on a `stop` or `aborted` message is not an overflow (`:57-61`).
- Edge cases / failure handling (length): a zero-output length stop far below the context window is recoverable; a normal length stop with output is not (`:209-226`).
- Surprising: the provider-specific shapes are listed by name — Ollama's "prompt too long", z.ai's `{"code":"1261"}` in two wordings, Together's "the input (N tokens) is longer than …".

### packages/ai/test/pi-messages.test.ts
- Purpose: pi's own gateway protocol.
- Key abstractions: the `pi-messages` event vocabulary (`start`, `text_start/delta/end`, `toolcall_start/delta/end`, `done`).
- Data flow: the client posts a `TranscriptContext` → the server streams events → the client assembles the assistant message.
- Non-obvious design decisions: the request body carries the **whole context** (`{context: …}`, `:276-278`), so the gateway is stateless.
- Edge cases / failure handling: a stream that ends without a terminal event is an error (`stream ended without a terminal event`, `:270`).
- Surprising: the api is asserted to be a registered builtin provider (`:274-283`), so the protocol cannot drift from the registry.

### packages/ai/test/pre-generation-error.test.ts
- One specific line: every direct API adapter throws **synchronously** when the api key is missing, rather than returning an error stream — a missing key is a caller bug, not a provider failure.

### packages/ai/test/provider-error-body-passthrough.test.ts
- Purpose: A body-blind catch hides the real reason for a failure.
- Key abstractions: the OpenAI SDK's `APIError` shape (opaque message, parsed body on `.error`).
- Data flow: a 403 with a body → the provider's catch → the assistant message's `errorMessage`.
- Non-obvious design decisions: the header comment (`:1-13`) states the failure precisely: the SDK's `makeMessage` produces `"403 status code (no body)"` while the real reason sits on `error.error`, so a catch that reads only `error.message` throws the reason away.
- Edge cases / failure handling: the assertion is that the message contains **both** the status and the body reason, and is not the opaque string (`:74-77`).
- Surprising: this is exactly August's `_errorEventText` nested-envelope blindness, expressed as a provider-level regression test.

### packages/ai/test/provider-error-body-regression.test.ts
- One specific line: the same body-passthrough guarantee is asserted per provider tier — openai-completions, openai-responses and Bedrock — and a Bedrock response-stream body never leaks its internals into the message.

### packages/ai/test/provider-retry.test.ts
- Purpose: The provider-level retry policy.
- Key abstractions: `retryProviderRequest(request, {maxRetries, maxRetryDelayMs, noRetryStatuses, signal})`; the `x-should-retry` header; `retry-after` / `retry-after-ms`.
- Data flow: a failing request → the policy → a delay → a retry → a result or a thrown error.
- Non-obvious design decisions: a **server-requested delay above the limit is refused, not absorbed** (`:48-55`) — the error names both the requested and the maximum. This is the single most transferable rule in the shard.
- Edge cases / failure handling: `x-should-retry: false` disables the retry (`:32-38`); `noRetryStatuses` disables a specific status (`:40-46`); `maxRetryDelayMs: 0` disables the cap (`:57-71`); an abort during the wait leaves no pending timer (`:73-88`).
- Surprising: the cap can be *disabled* — the mechanism is a policy value, not a hard-coded safety.

### packages/ai/test/providers.test.ts
- Purpose: The builtin provider registry.
- Key abstractions: `builtinModels()`, `builtinProviders()`, `getBuiltinModel`, `getBuiltinImageModel`, `getBuiltinClassifierModel`; `createProvider`.
- Data flow: the registry is built → the providers are enumerated → a model is looked up → a stream runs → a deferred handle is fetched or cancelled.
- Non-obvious design decisions: unknown provider ids return **empty results** rather than throwing, for every accessor (`:79-92`).
- Edge cases / failure handling: the registry is expected to hold more than 500 models (`:66`) — a shrink is a bug.
- Surprising: the deferred lifecycle is tested end to end here: a deferred submission is fetched, a failed one reports `deferred failed`, and a cancelled one reports "was cancelled" (`:805-822`).

### packages/ai/test/qwen-token-plan-models.test.ts
- One specific line: the Qwen Token Plan catalogues expose exactly the documented model sets and send `enable_thinking` plus `reasoning_effort` (including `xhigh`) for the reasoning models.

### packages/ai/test/radius-oauth.test.ts
- One specific line: Radius device login goes straight to the gateway endpoints, refresh needs no discovery, only the interactive flow performs discovery, and a failed code exchange renders a 502 page carrying the upstream reason.

### packages/ai/test/radius-provider.test.ts
- One specific line: the Radius catalogue is replaced wholesale by a refreshed config, a cached catalogue can be used with no network, and models disabled by the organization do not reappear from the shipped catalogue.

### packages/ai/test/radius-thinking-replay-e2e.test.ts
- Purpose: Proof that replayed thinking actually reaches the provider — measured, not asserted.
- Key abstractions: `providerThinkingLevel`; the reported input-token counts.
- Data flow: a reply with signed thinking → two follow-ups (with and without the thinking blocks) → the difference in reported input tokens.
- Non-obvious design decisions: the *measurement* is the difference between two requests' `input + cacheRead + cacheWrite` (`:92-109`) — a token delta, not a boolean.
- Non-obvious design decisions (diagnosis): the header comment (`:1-30`) reconstructs the whole causal chain — a 996 K-token session whose compaction request was 1.38 M tokens, `prefix_mismatch_behavior: "drop_block"` silently dropping unsigned blocks, and Radius omitting `providerThinkingLevel` from its `done` event.
- Edge cases / failure handling: `expect.soft` on the level (`:124`) so the token measurement still runs and reports the effect even when the cause assertion fails.
- Surprising: this is the only file in the shard that measures a **semantic** property (did the reasoning reach the model?) rather than a wire shape.

### packages/ai/test/reasoning-options.test.ts
- One specific line: `getEffortThinkingLevelMap` exposes only verified effort values plus `none`, refuses to infer thinking-off from an effort list, and leaves toggle and budget controls to their adapter-specific implementations.

### packages/ai/test/responseid.test.ts
- One specific line: every provider surfaces a `responseId` on the assistant message, checked live for Google, Vertex, OpenAI (both APIs), Anthropic, Azure, Mistral, Copilot and Codex.

### packages/ai/test/retry.test.ts
- Purpose: Retry classification from the error *message*.
- Key abstractions: `isRetryableAssistantError(message)`; `retryAssistantCall(produce, policy, signal, {onRetryFinished})`; `retryDelayMs`.
- Data flow: an error message → a classification → a backoff → a retry.
- Non-obvious design decisions: the classifier reads **wording**, not status codes, because several providers hide the status: explicit retry guidance, DNS failures (`ENOTFOUND`, `EAI_AGAIN`), Bun's socket-close message, HTTP/2 "pending stream has been canceled", and service-unavailable phrasing (`:19-79`).
- Edge cases / failure handling: an abort during the backoff returns an **aborted** message with no `errorMessage` and reports `onRetryFinished(false, 1, …)` (`:311-325`).
- Surprising: a wrapped DNS error ("The pending stream has been canceled (caused by: getaddrinfo ENOTFOUND …)") is matched — the pattern search covers the wrapper.

### packages/ai/test/sampling-options.test.ts
- Purpose: The precedence order for sampling parameters.
- Key abstractions: `model.samplingParams`; `model.samplingParamsByThinkingLevel`; `options.samplingParams`.
- Data flow: the effective thinking level → the level bucket → merged with the model defaults → merged with the request options → the request body.
- Non-obvious design decisions: the precedence is **request > model > thinking-level bucket** (`:96-175`), and the named request fields (`temperature`, `top_p`) override the merged bag.
- Edge cases / failure handling: the model defaults must apply to the *direct* `stream()` path, not only to `streamSimple()` (`:114-125`) — that was the bug (#9506).
- Edge cases / failure handling: a summary-only Responses request is treated as effort `medium` for the purposes of picking the bucket (`:198-215`).
- Surprising: the whole mechanism is ignored by non-OpenAI-compatible APIs (`:226-233`) — sampling params are an OpenAI-family concept.

### packages/ai/test/scratch.ts
- One specific line: a hand-written runnable example (not a test) showing the Models API end to end — `createModels`, `setProvider`, `getAuth`, `completeSimple`, then a streaming loop.

### packages/ai/test/stream.test.ts
- Purpose: The main live provider sweep.
- Key abstractions: `basicTextGeneration`, `handleToolCall`, `handleStreaming`, `handleThinking`, `multiTurn`, `handleImage` — one helper per capability, run against every provider.
- Data flow: each helper builds a context, runs one or two turns, and asserts on the content, the usage and the absence of an error.
- Non-obvious design decisions: the *same* helper is used for every provider, so a provider that fails one capability fails the same assertion as everyone else — the comparison is apples to apples.
- Edge cases / failure handling: the tool schema uses the `StringEnum` helper because Google's API rejects the `anyOf`/`const` shape Type.Enum produces (`:30-38`) — a schema constraint that would otherwise fail only on Google.
- Edge cases / failure handling (local): the suite can start and stop an Ollama server itself (`:1651-1738`) and skips itself when `PI_NO_LOCAL_LLM` is set.
- Surprising: the file is 1 739 lines and mostly a matrix of provider × capability, with the capability bodies written once.

### packages/ai/test/supports-xhigh.test.ts
- One specific line: the xhigh/max thinking level matrix per model and provider, including the pricing, context window and compat flags of the newest Claude models.

### packages/ai/test/system-message-replay.test.ts
- Purpose: The system prompt is a **replayable leading message**, not a string.
- Key abstractions: `SystemMessage` with `sections`, `toolsAdded`, `toolsRemoved`; `getCurrentSystemMessage`; `getCurrentSystemPrompt`; `collapseSystemMessages`; `getToolStateChanges`; `hasNonAdditiveToolChanges`; `hasToolRedefinitions`; `declarationsEqual`.
- Data flow: a history of system messages → the current prompt = the merged content + the merged sections + the current tool set → one leading message.
- Non-obvious design decisions: a **changed** tool definition is modelled as removal + addition (`:117-124`), because the wire has no "update" verb.
- Edge cases / failure handling: `declarationsEqual` compares tools **without** their executable or undefined fields (`:110-115`), so a re-created function object is not a change; a non-additive history is **flagged** (`hasNonAdditiveToolChanges`) rather than silently replayed.
- Edge cases / failure handling: a late full patch on a transcript with no leading system message still replays as the prompt (`:69-84`).
- Surprising: the prompt is stored as *sections* with add/remove semantics — the same shape August would need for live prompt editing.

### packages/ai/test/telemetry-options.test.ts
- Purpose: The telemetry span must reach every request-option surface.
- Key abstractions: `ProviderRequestOptions.telemetry`; `TelemetrySpan`; `DeferredHandle`.
- Data flow: the option → `buildBaseOptions` → the provider's `stream` / `streamSimple` / `fetchDeferred` / `cancelDeferred` → the image dispatch.
- Non-obvious design decisions: the old name must not compile — `@ts-expect-error telemetryContext was renamed` (`:74-78`) — so an alias cannot creep back.
- Edge cases / failure handling: the span is observed at eight call sites and must be the *same object* at every one (`:126-127`).
- Surprising: the image path is included, so telemetry is not a chat-only concept.

### packages/ai/test/telemetry.test.ts
- Purpose: Observing a request must not change it.
- Key abstractions: `observeModelRequest`; `InMemoryTelemetryContext`; `lazyStream` with `onEvent` / `onResult`.
- Data flow: a provider stream → the telemetry wrapper → the consumer sees the same events and the same result.
- Non-obvious design decisions: the telemetry records usage and cost but **not** the message content — the fixture deliberately fills the content with `"-secret"` strings (`:29-33`) so a leak would be visible.
- Edge cases / failure handling: a setup failure is reported once as an error and the result resolves to the error message (`:407-421`).
- Surprising: the spans must all be *settled* before the test finishes (`:89-91`) — an un-settled span is a leak, not a slow test.

### packages/ai/test/text.test.ts
- One specific line: `contentText` extracts assistant text blocks and tool-result text, joining with a newline by default and with a custom separator on request, and passes a plain string through.

### packages/ai/test/together-models.test.ts
- One specific line: the Together catalogue metadata — api, baseUrl, `thinkingLevelMap`, cost and compat — for the Kimi and gpt-oss entries.

### packages/ai/test/tokens.test.ts
- Purpose: What each provider reports for an aborted turn.
- Key abstractions: `usage.input` / `usage.output` / `usage.cost` on an aborted message.
- Data flow: a long generation → abort at 1 000 characters → the reported usage.
- Non-obvious design decisions: the expectation is **per provider family** (`:54-83`): the OpenAI family, Mistral, Bedrock and z.ai report nothing (usage arrives only in the final chunk); Kimi reports input but not output; Anthropic and Google report both.
- Edge cases / failure handling: a provider with zero cost rates must report zero cost even when the token counts are non-zero (`:79-82`).
- Surprising: the cost assertion is conditional on the rate being non-zero — the test would otherwise fail on every free provider.

### packages/ai/test/tool-call-id-normalization.test.ts
- Purpose: A tool-call id from one provider must be legal at the next.
- Key abstractions: the OpenAI Responses `{call_id}|{id}` id shape.
- Data flow: Copilot generates a tool call → the id is sent to OpenRouter and to Codex → the request must be accepted.
- Non-obvious design decisions: the live handoff is the test (`:44-…`) — the normalisation itself is not re-implemented in the test.
- Edge cases / failure handling: the assertion is that the error message does **not** contain "too long" (`:107`, `:259-260`), which is the exact provider error.
- Surprising: the same file also covers a *prefilled* context handed to Codex with the long ids already in it (`:265-289`).

### packages/ai/test/tool-call-without-result.test.ts
- Purpose: An orphaned tool call must not break the next request.
- Key abstractions: a trailing assistant message with a tool call and no matching tool result.
- Data flow: a tool-calling turn → a user message **without** the tool result → the next request.
- Non-obvious design decisions: the expectation is disjunctive — the model may answer directly or make a new tool call; only the *error* is forbidden (`:74-86`).
- Edge cases / failure handling: the aborted/cancelled tool call is the real-world source of the orphan, and the test models it by simply omitting the result.
- Surprising: the same scenario is run against every provider, because each has a different tolerance for an unpaired call.

### packages/ai/test/total-tokens.test.ts
- Purpose: `totalTokens` must equal the sum of its components, everywhere.
- Key abstractions: `usage.totalTokens`; a long system prompt to force a cache write.
- Data flow: two identical-prefix requests → the first writes the cache, the second reads it → the usage of both.
- Non-obvious design decisions: the header (`:1-13`) states the per-provider derivation — native `total_tokens` for OpenAI, `totalTokenCount` for Google, **computed** as input + output + cacheRead + cacheWrite for Anthropic.
- Edge cases / failure handling: the assertion is the same for both the cache-write and the cache-read request (`:95-98`).
- Surprising: the second request includes the first response in the history, so the cache read is real rather than assumed.

### packages/ai/test/transcript-tool-changes.test.ts
- Purpose: Loading and unloading tools mid-conversation.
- Key abstractions: `resolveTranscriptTools`; `compat.supportsMidConvoSystemMessages`; `compat.supportsAdditionalTools`.
- Data flow: a system message with `toolsRemoved` → the next request → the tool list and the message list.
- Non-obvious design decisions: for an adapter with native support the tool change becomes a **system message** carrying the delta; for one without, it is folded into the system prompt (`:589-606`).
- Non-obvious design decisions: the invariant `expectGrowingPrefix` (`:71-77`) asserts that **every** request's message list starts with the previous request's message list — the prefix must never change under the provider's feet, because that invalidates a cached prefix.
- Edge cases / failure handling: a tool that is removed and re-added is handled, and a removal followed by an addition is a net change.
- Surprising: the growing-prefix invariant is the mechanism behind pi's prompt-cache effectiveness — a stable prefix is a *tested* property, not a hope.

### packages/ai/test/transform-messages-copilot-openai-to-anthropic.test.ts
- Purpose: Migrating a history across API families.
- Key abstractions: `transformMessages(messages, model, normalizeToolCallId)`; `thoughtSignature`.
- Data flow: an OpenAI-shaped history → `transformMessages` → the Anthropic-shaped messages.
- Non-obvious design decisions: a **foreign** `thoughtSignature` is removed (`:50-94`) — the Anthropic endpoint would reject a signature it did not mint.
- Non-obvious design decisions: trailing tool calls that still have no result get a **synthetic** tool result — `isError: true`, content `"No result provided"` (`:96-120`) — instead of being left unpaired.
- Edge cases / failure handling: the synthetic result is added only for the calls that are genuinely missing one (`:122-150`); the id is normalised by the injected function, so `call_123|fc_123` becomes `call_123_fc_123`.
- Surprising: the normaliser is *injected* into `transformMessages`, so the test does not have to reimplement it — the test exercises the caller's real function shape.

### packages/ai/test/transform-messages-cross-model-thinking.test.ts
- Purpose: Another model's reasoning must not be replayed.
- Key abstractions: the assistant message's `model` field; the target model's id.
- Data flow: a history interleaving two models' thinking blocks → `transformMessages` → the replayed messages.
- Non-obvious design decisions: a *readable* thinking block from another model is **dropped**, not converted to text (`:40-69`) — replaying it as text would put another model's reasoning into the prompt as if it were the current model's.
- Edge cases / failure handling: only the target model's own thinking survives when the models alternate (`:71-98`).
- Surprising: the rule is per-message, not per-provider — the same provider with a different model id is already "another model".

### packages/ai/test/typesafe-system-one.test.ts
- Purpose: The System One classifier protocol.
- Key abstractions: `ClassifierContext` with `state` and `questions`; the `choice` / `score` / `bool` question types; the `noul` wire type for bools.
- Data flow: the context → the `/systemone` body → the answers, matched back by question name.
- Non-obvious design decisions: an empty description on a choice is omitted from the wire (`:102`); the option `temperature` is ignored because System One has no such field (`:60-61`).
- Edge cases / failure handling: a billed request that produced **no** answer keeps its usage (`:375-376`) — the cost is real even when the answer is missing.
- Edge cases / failure handling: malformed usage is ignored rather than trusted (`:379-393`).
- Surprising: the `bool` question is called **`noul`** on the wire — a domain-specific vocabulary that the adapter translates.

### packages/ai/test/unicode-surrogate.test.ts
- Purpose: Emoji and lone surrogates in tool results must not corrupt the JSON.
- Key abstractions: base64 tool-result images; the `toolResult` content array.
- Data flow: a tool result full of emoji → the provider → the request body.
- Non-obvious design decisions: the fixture includes an **unpaired high surrogate** (`0xD83D`) as its own case (`:831-837`) — the failure mode is a lone surrogate, not an emoji.
- Edge cases / failure handling: a "real-world LinkedIn comment data with emoji" case (`:821-828`) exercises text that a synthetic fixture would not produce.
- Surprising: the header names the exact provider error (`"no low surrogate in string"`) — the failure was a JSON serialisation error inside the SDK, reported as a provider error.

### packages/ai/test/uuid.test.ts
- Purpose: The UUIDv7 generator.
- Key abstractions: `uuidv7(timestamp?)`.
- Data flow: a timestamp → a UUIDv7 → its embedded timestamp and randomness.
- Non-obvious design decisions: a clock rollback does **not** lower the timestamp (`:22-26`) — the ids stay monotonic, which matters for an ordered transcript.
- Edge cases / failure handling: an explicitly supplied timestamp is preserved exactly; invalid timestamps (`-1`, `2**48`, `1.5`, `NaN`, `Infinity`) throw a `RangeError`.
- Surprising: the random tail is fresh on every call even for the same timestamp, so two ids with the same millisecond are still distinct.

### packages/ai/test/validation.test.ts
- Purpose: Tool-argument validation.
- Key abstractions: `validateToolArguments(tool, toolCall)` → the coerced arguments.
- Data flow: a tool call's raw arguments → a schema validator → the coerced value or a throw.
- Non-obvious design decisions: validation must work when the `Function` constructor is unavailable (`:37-62`) — a hardened runtime (CSP) must not silently disable argument checking.
- Edge cases / failure handling: a **serialized plain JSON schema** is coerced with AJV-compatible primitive rules (`"42"` → `42`, `true` → `1`, `null` → `""`), while a TypeBox schema is not.
- Edge cases / failure handling: `null` is treated as omission for an optional non-nullable property; a malformed arguments JSON throws `Invalid arguments for tool "echo": …` rather than validating `{}`.
- Surprising: the coercion table is written out case by case (`:65-93`) because the behaviour of a plain schema and a compiled schema must be identical.

### packages/ai/test/xai-oauth.test.ts
- One specific line: the xAI device flow — the exact client id and scope, the poll cadence with `slow_down`, the refresh expiry margin, and the upstream error code and description surfaced on failure.

### packages/ai/test/xai-responses.test.ts
- One specific line: the xAI Responses request shape and headers, the provider routing, and the User-Agent default with an explicit override on both the Responses and the Completions paths.

### packages/ai/test/xhigh.test.ts
- One specific line: `xhigh` works on gpt-5.5 and is a clear **error** — not a silent downgrade — on a model that does not support it, on both the Responses and the Completions APIs.

### packages/ai/test/xiaomi-models.test.ts
- One specific line: Xiaomi MiMo drops the deprecated model ids, keeps the replacements, and models reasoning as a plain off/on toggle with no `reasoning_effort` at all.

### packages/ai/test/xiaomi-token-plan-ams-anthropic-empty-signature-smoke.test.ts
- One specific line: a live smoke that reproduces the empty thinking signatures from the Xiaomi AMS endpoint and asserts they survive the replay payload unchanged.

### packages/ai/test/zai-coding-plan-models.test.ts
- One specific line: the zai-coding-cn catalogue exposes GLM-4.6V with the right api, baseUrl, cost and compat, and Coding Plan models with no API price keep a zero cost.

### packages/ai/test/zen.test.ts
- One specific line: a live smoke over every OpenCode Zen and OpenCode Go model in the generated catalogue.

### packages/ai/test/oauth.ts
- One specific line: the test helper that resolves an API key from `~/.pi/agent/auth.json`, refreshing an expired OAuth credential through the provider's own flow and saving it back with 0600 permissions.

### packages/ai/test/llama-cpp-classify.test.ts
- Purpose: The local llama.cpp classifier.
- Key abstractions: the llama.cpp server endpoints `/tokenize`, `/apply-template`, `/completion`; `n_probs` (the number of candidate tokens to score).
- Data flow: the context → tokenize → apply the chat template → request the next-token log-probabilities → map the top tokens to labels → a choice/score/bool answer.
- Non-obvious design decisions: the classifier scores the **next token** and reads the label out of the token text — the fake tokenizer maps a label to its first character (`:44-46`, `:82-86`), and a fresh server URL per test avoids a cached label-token map (`:12-27`).
- Edge cases / failure handling: `peakConfidence` and `answerFromProbabilities` implement TypeSafe's confidence semantics exactly (`:387-398`).
- Surprising: the whole classifier is a local model scored by log-probability — no text generation at all.

## Ideas worth stealing

- **Refuse an over-long server-requested retry delay instead of absorbing it** — `packages/ai/test/provider-retry.test.ts:48` — the retry helper *throws* `"Server requested 277403s retry delay (max: 1s)"` rather than sleeping for it, and the same rule is pinned per transport at `packages/ai/test/openai-completions-retry.test.ts:136` and `packages/ai/test/openai-codex-stream.test.ts:2593`. August already has this rule but only in the agent loop (`_retryWaitRefusalMs`); moving it into the **provider client** means every transport inherits it, and the cap becomes a policy value (`maxRetryDelayMs: 0` disables it — `packages/ai/test/provider-retry.test.ts:57`) instead of a hard-coded safety. The same file also pins the abort behaviour: an abort during the wait leaves no pending timer (`:73-88`).

- **One error-body normaliser for every SDK shape, and never serialise a response stream to get a body** — `packages/ai/test/error-body.test.ts:12` (Mistral / openai APIError / @google/genai / AWS ServiceException) and `packages/ai/test/error-body.test.ts:67` (a Bedrock `$response.body` that is a stream is ignored). August's `_errorEventText` blindness to a nested `{"error": {"message": …}}` envelope is exactly this bug; the normaliser also reports `messageCarriesBody` so the composer never duplicates the body, and the guarantee is then asserted **per provider tier** at `packages/ai/test/provider-error-body-regression.test.ts:1` and `packages/ai/test/provider-error-body-passthrough.test.ts:1`. Transfer: one `normalizeProviderError` in August's transport layer plus a per-adapter regression test that asserts the error message contains the status *and* the body reason.

- **A synthetic tool result for an orphaned tool call** — `packages/ai/test/transform-messages-copilot-openai-to-anthropic.test.ts:96` — a trailing tool call with no result is given a synthetic `isError: true` result whose content is the literal `"No result provided"`, and only for the calls that are genuinely missing one (`:122`). August's `_stuckRequestEscape` ladder currently flattens the whole tool pairing into text; this is the cheaper, more local fix — the pairing is repaired rather than destroyed, and the model sees a failed tool rather than a rewritten transcript. The same rule is pinned live across every provider at `packages/ai/test/tool-call-without-result.test.ts:32`.

- **Hash a foreign tool-call id into the target's legal shape instead of hoping it fits** — `packages/ai/test/openai-responses-foreign-toolcall-id.test.ts:20` — a 400+ character Copilot id is hashed over its *provider item* segment into `fc_<shortHash>`, bounded to 64 characters and asserted against `^fc_[A-Za-z0-9]+$` (`:61-64`). The hash is stable, so the call/result pairing survives the rewrite. August's tool-call ids are short and internal, but the same mechanism is what it needs the moment a *provider* id is stored in the transcript (which is what the OpenAI Responses `{call_id}|{id}` shape forces).

- **Prefer the provider's own last usage report over a characters-per-token estimate** — `packages/ai/test/context-estimate.test.ts:46` — `estimateContextTokens` returns `{tokens, usageTokens, trailingTokens, lastUsageIndex}`: the last assistant message's own `usage.totalTokens` is the measured prefix and only the text after it is estimated, at **3.5** chars per token rather than 4 (`:45`); a usage report that is older than a message inserted after it is ignored (`:60`), and `lastUsageIndex: null` distinguishes "not measured" from "measured zero" (`:74`). This is a much better basis for August's context projection than a global estimate, and it is directly comparable with August's own `estimateContextTokens`-style accounting.

- **A capability map with explicit holes, and a clamp to the nearest supported level** — `packages/ai/test/max-thinking.test.ts:51` — `thinkingLevelMap` maps a logical level to a wire value or `null`, so `{xhigh: null, max: "max"}` is a *ladder with a hole* (`getSupportedThinkingLevels` yields `off, minimal, low, medium, high, max` with no `xhigh`), and `clampThinkingLevel(model, "xhigh")` returns `"max"` (`:67`). The same map drives the request, the UI's level list and the clamp, so there is one source of truth per model. The catalogue-level discipline around it is at `packages/ai/test/anthropic-adaptive-thinking-models.test.ts:37` — the flagged set must equal a regex-derived expectation, so a newly-added model fails until its metadata is written.

- **Provider quirks live in DATA (a per-model `compat` bag), not in adapter code** — `packages/ai/test/compat-schema.test.ts:22` (each API schema has its own defaults) and `packages/ai/test/compat-schema.test.ts:33` (the provider superset must inherit **none** of them). Every quirk in this shard — `forceAdaptiveThinking`, `allowEmptySignature`, `supportsStrictTools`, `supportsMidConvoEffort`, `supportsLongCacheRetention`, `supportsTemperature`, `cacheControlFormat`, `supportsEagerToolInputStreaming`, `sessionAffinityFormat` — is one boolean or enum in the model record. August's per-model `apiFormat` idea is the same shape; the discipline pi adds is that the flags are *typed and schema-validated* and that the superset does not leak API-specific defaults into provider-level models.

- **A single `onPayload` seam that both observes and edits the outbound body** — `packages/ai/test/anthropic-force-adaptive-thinking.test.ts:55` (capture by throwing a sentinel) and `packages/ai/test/mistral-http-transport.test.ts:81` (return a modified payload, and the modification is what goes on the wire). One hook on the transport lets a test assert the exact upstream JSON with no network, lets a caller rewrite a field (August's `exclude_none` scrubbing could live here), and lets a proxy inject a header. It is the seam that makes 60+ of the files in this shard cheap.

- **A stream that ends without a terminal event is an error** — `packages/ai/test/openai-completions-tool-choice.test.ts:731` (`"Stream ended without finish_reason"`) and `packages/ai/test/pi-messages.test.ts:270` (`"stream ended without a terminal event"`) — with a per-model opt-out for providers that cannot report completion (`compat.supportsFinishReason: false`, `:734`). This is the cheapest possible truncation detector and it mirrors the Responses variant (`packages/ai/test/openai-responses-terminal-event.test.ts:386`, where `rawStopReason` becomes `incomplete.max_output_tokens`). August's stall detection currently has to infer truncation from silence; this is the explicit version.

- **Keep the provider's raw reason next to the normalised one** — `packages/ai/test/bedrock-raw-stop-reason.test.ts:121` (`rawStopReason: "end_turn"` beside `stopReason: "stop"`), `packages/ai/test/mistral-raw-stop-reason.test.ts:43`, `packages/ai/test/openai-completions-raw-stop-reason.test.ts:67`, `packages/ai/test/google-raw-stop-reason.test.ts:134`, `packages/ai/test/openai-responses-terminal-event.test.ts:405` (`"incomplete.max_output_tokens"`). The harness's own vocabulary stays small (`finished | length | cap | stall-stop | …`) while the provider's own reason survives next to it. August's `turn_end {reason}` should carry the raw provider reason as a second field.

- **Retry classification from the error WORDING, because several providers hide the status** — `packages/ai/test/retry.test.ts:19` (explicit provider retry guidance), `:56` (DNS: `ENOTFOUND`, `EAI_AGAIN`, a wrapped `getaddrinfo` inside a "pending stream canceled" message), `:37` (Bun's socket-close text), `:73` (service-unavailable phrasing). The message is the only signal available for some providers, and the file pins the exact phrasings. August's eight-family taxonomy is keyed on shapes it controls; this adds the provider-authored half.

- **Measure semantics, not just wire shapes** — `packages/ai/test/radius-thinking-replay-e2e.test.ts:92` — the test sends the same follow-up twice, with and without the thinking blocks, and compares the **reported input tokens**; the difference is the proof that the reasoning reached the model. The header (`:1-30`) reconstructs the whole causal chain from that measurement — a 996 K-token session whose compaction request was 1.38 M tokens — and the `expect.soft` on the cause assertion (`:124`) lets the effect measurement still run and report. August could use the same technique to prove that a compacted summary, a replayed tool result or a scrubbed credential actually reaches the provider.

- **The system prompt as a replayable leading message with sections and tool deltas** — `packages/ai/test/system-message-replay.test.ts:44` (content + sections + tools collapse into one leading message) and `:117` (a changed tool definition is modelled as removal + addition, because the wire has no "update" verb); the history is *flagged* when it is not additively replayable (`:126`). The prompt is therefore patchable at runtime without rewriting the whole prefix — and `packages/ai/test/transcript-tool-changes.test.ts:72` asserts the property that makes this cheap: **every request's message list starts with the previous request's message list**, so a cached prefix is never invalidated.

- **Test the loader, not just the code** — `packages/ai/test/lazy-module-load.test.ts:17` spawns node with a `node:module` resolve hook and asserts that importing the root barrel, the compat entrypoint and even building all builtin providers loads **zero** provider SDKs (`:60-79`), and `packages/ai/test/models-entry.test.ts:9` goes further by forbidding TypeBox, the catalogues and `models.generated.` from the light path and then running a full completion through it. August's startup cost is a live concern; this is a 60-line gate that measures it.

- **A generator that fails BEFORE it mutates** — `packages/ai/test/generate-models-strict.test.ts:78` — the strict generator exits 1 and all four generated artefacts are byte-identical to their pre-run content (`:82-85`). This is the transactional-write property August's migration runner wants, expressed for a code generator instead of a database.

- **A model-data directory validated by a manifest before it is trusted** — `packages/ai/test/model-data-validation.test.ts:338` (schema version + generation timestamp) and `:347` (the aggregator's imports must match the shards on disk exactly). August's `providers.json` / brain config would benefit from the same lockfile shape: a manifest that pins what was generated, when, and from what.

- **A scriptable in-process provider double** — `packages/ai/test/faux-provider.test.ts:31` — `registerFauxProvider({models})` with an ordered response list, model-aware factories, estimated usage, and an abort that produces `toolcall_start` + `toolcall_delta` + `error` but **no** `toolcall_end` (`:611`). August has no such double; without one, every harness test needs a live provider. The abort shape in particular is the exact event sequence August's tool loop must tolerate.

- **A strict-tool request that degrades instead of failing** — `packages/ai/test/anthropic-strict-tool-fallback.test.ts:74` — a grammar error, a "too many strict tools" error and a "too many union-typed parameters" error each trigger one retry with the original **non-strict** schemas, while tools marked `strict: "require"` keep their strictness (`:76-78`). The recognised provider messages are enumerated as test cases, so a new one can be added. This is the shape of a graceful degradation ladder that does not silently relax a hard requirement.

- **Per-provider tool-name round-tripping is a lookup, not a translation** — `packages/ai/test/anthropic-tool-name-normalization.test.ts:9` — the header records why an earlier `find → Glob` mapping was wrong (the inbound direction looks the name up, and no tool named `glob` existed, so the call came back unexecutable); the correct implementation is a case-insensitive lookup that is its own inverse, and the negative case is asserted explicitly (`:111-162`) so a "helpful" remap cannot come back.

- **A connector surface is a separate API, not a chat API with a flag** — `packages/ai/test/openai-decisions.test.ts:81` and `packages/ai/test/typesafe-system-one.test.ts:50` — the question kinds (`choice`, `score`, `bool`) map to a wire vocabulary (`noul` for bools, probabilities, confidence), the answers come back **by name** rather than by position, and the connector has its own pricing and its own usage semantics. August's "message the agent" or "ask a question" features should be a separate API surface with a separate model type, not a prompt template — the classifier models in this shard are a different `type` in the registry and are reached only through `getModelOfType("classifier", …)`.

## Files skipped (with reasons)

- None. Every one of the 185 files in the shard was opened and read.
- One binary file is noted for completeness: `packages/ai/test/data/red-circle.png` — a 2 565-byte PNG fixture (a solid red circle on white, 200×200). It cannot be read as text; I opened it as an image and confirmed what it depicts, and it is used by `image-tool-result.test.ts`, `images.test.ts` and `openai-responses-tool-result-images.test.ts` as the tool-result image.
- Two files are not vitest suites and are read as what they are: `packages/ai/test/scratch.ts` (a runnable example script) and `packages/ai/test/codex-websocket-cached-probe.ts` (a standalone live probe script with a `#!/usr/bin/env node` shebang).
- Three files are helper modules rather than tests: `packages/ai/test/azure-utils.ts`, `packages/ai/test/bedrock-utils.ts`, `packages/ai/test/cloudflare-utils.ts` (credential-presence checks) and `packages/ai/test/oauth.ts` (an auth.json resolver that refreshes and writes back an OAuth credential).

## Uncertainties

- **I did not read the implementation these tests exercise.** The shard is `packages/ai/test/`; the code under test lives in `packages/ai/src/`, which is assigned to the `ai-provider-core` shard. Every note above therefore describes the **contract the test asserts**, not the implementation. Where I said "the adapter does X", that is an inference from the assertion's shape, and it could be wrong about which layer implements it.
- **Two very large files were read in three passes and may have thin coverage in their middles.** `packages/ai/test/openai-codex-stream.test.ts` is 2 746 lines and `packages/ai/test/openai-completions-tool-choice.test.ts` is 1 956 lines; I read both in full, but the `openai-codex-stream` middle section (roughly lines 700–1 670) is a long sequence of similar websocket cases and I summarised its mechanisms rather than enumerating each assertion. Same for the second half of `openai-completions-tool-choice` (lines 1 400–1 956), which is a per-provider reasoning-payload matrix.
- **`stream.test.ts` (1 739 lines) and `tokens.test.ts` / `total-tokens.test.ts` / `unicode-surrogate.test.ts` are wide matrices, not deep mechanisms.** I read them in full and describe the shared helpers and the per-provider expectation differences, but a per-provider anomaly inside those matrices (a single provider expecting something unusual) may not be surfaced in my notes.
- **The live E2E expectations are not verified as passing.** Every `describe.skipIf(!credential)` block would be skipped in CI without keys; I could not run the suite (the clone is untrusted and read-only), so I report what the tests *assert*, not what they currently *do*.
- **The `compat` flag vocabulary is not exhaustively mapped.** I catalogued the flags that appear in assertions, but `packages/ai/src/providers/compat-schema.ts` presumably defines more; a flag with no test in this shard would not appear here.
- **Two lenses have no representation in this shard at all**: *steering / queued messages* and *extension / plugin / skill mechanisms*. There is no steering, queueing or extension machinery in `packages/ai/test/` — those belong to the coding-agent shards. Likewise *session storage / branching / compaction* is only touched obliquely (the `cross-provider-handoff` fixture builds a synthetic history; `system-message-replay` covers prompt replay) — the real session/compaction code is elsewhere.
- **`openai-codex-stream.test.ts` also references a GitHub release fetch** (`https://api.github.com/repos/openai/codex/releases/latest`, `:599`) and a raw.githubusercontent prompt fetch (`:602`); I could not determine whether those are a required code path or a fallback, because the source of `openai-codex-responses.ts` is in the other shard.
- **I did not verify the shard boundary.** I took the 185 rows whose 4th manifest column is exactly `ai-provider-tests` and cross-checked that every path I recorded matches the manifest exactly (no missing, no extra, no duplicates). I did not check whether the other shards' claims about these files are consistent with mine.
