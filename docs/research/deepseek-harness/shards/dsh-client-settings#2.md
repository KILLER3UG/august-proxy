# deepseek-harness / dsh-client-settings#2

## Shard shape

This shard is **entirely client-side settings UI** — seven `packages/client/ui-settings-*` packages (160 files, ~958 KB) that make up the Settings surface of the DeepSeek Harness web client. It holds no agent loop, no streaming code, no prompt assembly and no memory store. What it does hold is the *control plane* through which a user configures a running harness: `ui-settings-models` (provider/API-key/model-catalog page, plus the first-run onboarding dialogs), `ui-settings-plugin-inventory` (read-only plugin inventory tab), `ui-settings-plugins` (the tab shell the other packages register into), `ui-settings-session-log` (a session-log-upload consent switch), `ui-settings-shell` (command timeout and output cap), `ui-settings-subagent` (delegation depth, parallelism cap and the model allowlist subagents may pick from), and `ui-settings-web-search` (the Messages-vs-Search-API switch, key and per-search budget).

The architectural spine shared by all seven is the same and is the most transferable thing in the shard: **a settings section is a slot contribution, not a page**. Each package's browser half registers into a parent's slot (`settings.section`, `settings.plugins.tab`, `plugins.item`, `settings.general.item`, `shell.overlay`) via `ctx.slots.inject`, so a section appears only while the Host actually *serves* the settings namespace it edits (`ctx.configForms.whileServed`), and a deployment without that plugin shows no trace of it. The Host half of every package is an empty `apply()` whose only job is to hold a Loader row so the client module system serves the browser half. Writes are staged in a `SettingsFormModel` and committed on Save; a failed write keeps the draft; a stale revision is a *conflict*, not a rejection.

## Per-file notes

### packages/client/ui-settings-models

#### locale/en.json
- Purpose: Package metadata locale stub — `{"meta":{"title":"ui-settings-models"}}` only.
- Key abstractions: None.
- Data flow: Read by the package manifest tooling; the real copy is in `src/client/locales.ts`.
- Non-obvious design decisions: The `locale/` directory carries only *package* metadata, not UI strings; a package that also needs a Chinese description ships one (`zh.json`) and English does not.
- Edge cases / failure handling: None.
- Surprising: Two files that look like dictionaries hold one string each.

#### locale/zh.json
- Purpose: Chinese package metadata (title 模型设置界面 plus a description).
- Key abstractions: None.
- Data flow: Same channel as the English stub.
- Non-obvious design decisions: The Chinese file carries a `description` the English one does not — the pair is not symmetric here.
- Edge cases / failure handling: None.
- Surprising: The English locale file is not a translation of the Chinese one.

#### package.json
- Purpose: Publishable manifest for `@deepseek-ai/dsh-client-ui-settings-models` v0.2.1-rc.2.
- Key abstractions: `exports` exposes `.` (Host half) and `./client` (browser half) plus raw `./src/*`; `dsh.client.inject` lists the three client plugins this package pulls.
- Data flow: The loader reads `dsh.client` to know which client-side peers must be present before the browser half activates.
- Non-obvious design decisions: The Host half ships as `lib/index.js` and the browser half as `lib/client.js`; `files` whitelists `locale/*.json`, both bundles and the type tree, so nothing else leaks into the tarball.
- Edge cases / failure handling: None.
- Surprising: `@deepseek-ai/schemastery` is a *runtime* dependency while the other schema-related packages are devDependencies.

#### README.i18n.yaml
- Purpose: Per-heading hash record pinning the English/Chinese README pair together.
- Key abstractions: One YAML key per heading section, each holding an `en` and a `zh` hash of the block outside code fences.
- Data flow: `pnpm run verify-translation-pairing --write <README.md>` regenerates it; a check compares the file to the READMEs.
- Non-obvious design decisions: The pairing is enforced *per heading section*, not per file, so a section can be translated and merged independently.
- Edge cases / failure handling: Hashes of the root and of the H1 are included, so a renamed title is also caught.
- Surprising: Every one of the seven packages in this shard ships one of these — bilingual consistency is a build gate, not a convention.

#### README.md
- Purpose: The behavioural spec of the Models page (152 lines) — the contract the code is read against.
- Key abstractions: Documents the write-only API-key semantics, the curated "自定义设置" fold, the first-run posture, the extension slots and the concurrency rules.
- Data flow: Describes the page's read path (directory × settings mirror × credentials) and its write path (path ops + `credentials.set`).
- Non-obvious design decisions: The key paragraph states the API key is stored *write-only* under the profile's reference and that the pi-ai profile records the derivation as `apiKeyEnv` so `cordis.patch.yml` never carries a key value.
- Edge cases / failure handling: The "Concurrency and credentials" section states that after a settings commit the card adopts the returned redacted user subtree and revision *before* storing the credential, so a failed credential stage retries only that stage.
- Surprising: A dedicated "Model Experience / KV Cache effect" section says "None" — this package contributes nothing model-facing.

#### README.zh.md
- Purpose: Chinese mirror of the Models page spec (152 lines, same section structure).
- Key abstractions: Same as the English file.
- Data flow: Same.
- Non-obvious design decisions: Confirms the English text is not a one-language artifact — every limitation (credential cleanup scope, pi-ai-only hand declaration, protocol coverage) is stated in both.
- Edge cases / failure handling: Same.
- Surprising: The i18n hash file lets a reviewer prove the two sides match without reading both.

#### src/client/apiKey.ts
- Purpose: Browser-side judgement of a typed API key — the single gate every key field consults.
- Key abstractions: `apiKeyFailure(draft)` returns `'keyBlank' | 'keyIllegalCharacters' | undefined`; `LEGAL_API_KEY = /^[\x21-\x7E]+$/`; `ENV_LINE = /^[A-Z][A-Z0-9_]*=[^=]/`.
- Data flow: `ProviderEditor` and `CustomProviderCard` both call it and both refuse to submit on a failure.
- Non-obvious design decisions: The rule is *mirrored* from `@deepseek-ai/dsh-llm`'s `normalizeApiKey` rather than imported, because "client packages reference only client packages" — the comment explicitly says "keep the two in step". The ENV_LINE heuristic narrows twice: the name must be upper-case (so `sk-` breaks at the hyphen) and `=` must be followed by something other than `=` (so base64 padding `ABCD==` is not mistaken for an assignment).
- Edge cases / failure handling: An **empty** field is *not* a failure (the card opens empty even when a key is stored, meaning "keep that one"); a whitespace-only field **is** a failure, "so typed input is never silently discarded".
- Surprising: The ENV_LINE heuristic runs only in the browser — the comment explains that a resolver applying it "could lock a user out of a gateway whose key legitimately takes this shape".

#### src/client/ApiKeyInput.tsx
- Purpose: Write-only masked credential input with a reveal eye.
- Key abstractions: `ApiKeyInput` wraps a native input in `type={revealed ? 'text' : 'password'}` with `autoComplete="new-password"`.
- Data flow: Local `revealedValue` state holds *which* value was revealed; any `onChange` clears it, so the field re-masks.
- Non-obvious design decisions: "Reveal only a nonempty draft; a different value starts masked, as in SecretText." The stored credential is never read into the field — only the draft lives here.
- Edge cases / failure handling: The reveal button only renders when `value.length > 0`; `aria-pressed` carries the state.
- Surprising: The eye SVG is inlined as three path constants rather than imported from the icon set, because the eye-off variant is not in the primitive library.

#### src/client/CustomProviderCard.tsx
- Purpose: The create form for a provider the adapter does not ship (a relay, a self-hosted server, a newer provider).
- Key abstractions: `ROUTE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/`; `NS = 'llm-pi-ai'`; `createOnce()` performs one `settings.mutate` for the profile and then one `credentials.set`.
- Data flow: route id → `deriveKeyRef(route)` → the credential reference; the profile records `apiKeyEnv` **only when a key is entered**, otherwise the route keeps its provider-native auth path.
- Non-obvious design decisions: The route id must start with a letter because `deriveKeyRef` uppercases and replaces non-alphanumerics with `_`, and "a credential reference is a POSIX shell identifier, which cannot start with a digit" — a digit-leading id would fail at the credential seam with a raw regular expression. A target equal to the composed value is never stored (that is the web-search package's rule, but the same shape appears here as `committed`).
- Edge cases / failure handling: `committed` is set after the profile write lands, so "a retry after the key write below fails must not re-run this mutate" — otherwise the second mutate would carry the superseded revision and answer `settings-conflict` forever, and the key could never be stored. The `hint` line is silent when the key or route field already speaks, "rather than answering with the next unmet gate — which is satisfied, and reads as a second, false fault."
- Surprising: The card is a *create*, not an edit, so it is its own form rather than the provider editor with extra fields — the settings address does not exist until the route id is chosen.

#### src/client/DeepSeekModelsEditor.tsx
- Purpose: The direct-DeepSeek adapter's advisory model catalog editor, plus the shared capacity helpers.
- Key abstractions: `parseCapacity(text)` / `formatCapacity(value)` (K/M suffixes, decimal scale 1000); `modelDrafts(value)`; `validateDeepSeekModels(value)` returning `{index, key}`.
- Data flow: `parseCapacity` → the draft's `contextWindow`/`maxTokens`; `validateDeepSeekModels` runs before every write and names the offending row.
- Non-obvious design decisions: "A decimal multiple is exact in intent but not in binary floating point (2.3 * 1e6 lands a few ULPs high), so an integral intent snaps back" — `Math.abs(scaled - rounded) < 1e-6`. The editing buffer is one entry **per field** (`${index}:${field}`), not one active buffer, because "a single buffer would be displaced by editing any other field, and the abandoned one would render its stored NaN as the literal `NaN`". `remove()` re-keys the buffer around the dropped row.
- Edge cases / failure handling: `parseCapacity` returns `undefined` for blank (inherit) and `NaN` for unreadable; unreadable text is *kept* on screen past blur so the save-time refusal names a row the user can still see.
- Surprising: `formatCapacity` deliberately never produces a spelling that would not survive being read back (`1_500_000` → `'1500K'`, not `'1.5M'`).

#### src/client/DeepSeekOnboardingDialog.module.css
- Purpose: Two-rule stylesheet for the first-run DeepSeek dialog.
- Key abstractions: `.description` (secondary label tone) and `.editor` (24px top margin).
- Data flow: None.
- Non-obvious design decisions: The margin shrinks to 20px under a 560px viewport, matching the shared modal's own padding change.
- Edge cases / failure handling: None.
- Surprising: Nothing.

#### src/client/DeepSeekOnboardingDialog.tsx
- Purpose: The conditional first-run step that asks for the official DeepSeek key.
- Key abstractions: `onboardingReadiness(state)` from the store; `renderSlot('settings.models.sign-in', …, { fallback: editor })`.
- Data flow: Reads the *same* Models join snapshot the settings page uses; writes through the same `ProviderEditor` in `credentialOnly` mode.
- Non-obvious design decisions: "ANY provider the user can already reach ends it without rendering; only a user with none is asked for the official DeepSeek key." Every unavailable reason (`adapter-absent`, `provider-inactive`, `credentials-unavailable`, `settings-read-only`, `credential-read-only`) **completes** the step rather than blocking the product — Models remains the diagnostic surface.
- Edge cases / failure handling: The step completes on `unavailable` so a broken credentials service can never trap the user at a modal that cannot succeed. `explicit` (opened from the account menu) bypasses the `provider-ready` early exit.
- Surprising: The `settings.models.sign-in` slot lets another plugin offer "sign in with your account" *instead of* the API-key editor, with the editor as the fallback — the step is a coordinator, not a form.

#### src/client/EditorFooter.tsx
- Purpose: The cancel/commit row every provider card ends with.
- Key abstractions: `EditorFooter` takes `busy`, `submitDisabled`, label keys and two handlers; it carries no knowledge of what is being committed.
- Data flow: None of its own; the owning card decides when a commit is allowed.
- Non-obvious design decisions: "Cancel refuses input only while a commit is in flight, never because the card is disabled: a card the deployment cannot write to must still be dismissable."
- Edge cases / failure handling: The commit button is disabled by the owning card's `submitDisabled`; the busy state swaps the label to the busy variant.
- Surprising: The footer is shared by a *create* card and an *edit* card with different label keys, so it never needs to know which it is.

#### src/client/index.ts
- Purpose: The browser apply — registers the Models section and the two onboarding steps, and wires invalidations.
- Key abstractions: `inject = ['slots','locale','remote','remote.credentials','remote.llm','remote.settings','remote.session','configForms','settingsSchema']`; `refreshIfLoaded(controller)`; `NS = 'settings.models'`.
- Data flow: `ctx.remote.$on('settings/document-updated' | 'credentials/record-updated' | 'credentials/reference-updated' | 'llm/adapters-updated')` plus `ctx.on('connection/reset')` all call `refreshIfLoaded`.
- Non-obvious design decisions: "Refetch the page snapshot only after its first load: an unopened Models page must not fetch on background invalidations." The `credentialOnboarding` flag is ANDed with `!('dshDesktop' in globalThis)`, so the Electron preload marker suppresses automatic credential onboarding while leaving manual editing available. The nav label is a **thunk** (`label: () => t('nav')`) so a locale switch needs no re-registration.
- Edge cases / failure handling: The whole thing is wrapped in one `ctx.effect` so the disposers run with the fiber; `welcomeController.dispose()` releases the scope subscription.
- Surprising: The DeepSeek onboarding step is registered **unconditionally** while the welcome notice is skipped on desktop — the two steps differ in who owns the introduction.

#### src/client/locales.ts
- Purpose: The 138-key en/zh dictionary for the Models section.
- Key abstractions: `en` is the key-set source of truth; `zh` is typed `{ [Key in keyof typeof en]: string }`; `ModelsKey = keyof typeof en`.
- Data flow: `ctx.locale.register(NS, { zh, en })`; the section binds one `t` and passes it down.
- Non-obvious design decisions: The Chinese dictionary is checked against the English key set *by the type system*, so a missing translation is a compile error rather than a runtime blank.
- Edge cases / failure handling: The `welcomeBody` string contains `\n\n` paragraph separators, and the notice splits on them to render paragraphs.
- Surprising: The dictionary mixes UI strings with *policy* strings (e.g. `keyHelp` names the credential resolution order and the three env sources in one sentence).

#### src/client/ModelInputTypes.tsx
- Purpose: The text/image input-type checkboxes, shared by both adapter families.
- Key abstractions: `field: 'inputModalities' | 'input'` — DeepSeek and pi-ai name the same capability differently.
- Data flow: `model[field]` → the selected set; `onChange` replaces the whole row, preserving every other field.
- Non-obvious design decisions: The selected set is the model's own declaration when it is a nonempty array, else the catalog fallback, else `['text']`. The last remaining modality cannot be unchecked ("at least one type required").
- Edge cases / failure handling: For DeepSeek (`inputModalities`), unchecking image also **removes** `imagePixelBudget` and `imageMaxBytes`, "because the adapter rejects those limits without image input". For pi-ai (`input`) they are kept.
- Surprising: The two families' difference is not cosmetic — the same checkbox click produces different stored shapes.

#### src/client/ModelListEditor.tsx
- Purpose: The pi-ai model list plus the "Fetch available models" endpoint interrogation.
- Key abstractions: `ProbeTarget` (`settingsNs`, `provider?`, `baseURL?`, `api?`, `apiKey?`); `ModelDraft = DeepSeekModelDraft`; `CAPACITY_HINT` (`'256K'` / `'32K'`).
- Data flow: `fetchModels()` calls `operations.discoverModels` with the *form's current* endpoint and unsaved key, then opens a picker; the reply is candidates the user picks from, never configuration written behind them.
- Data flow detail: An installed catalog is read with **no endpoint I/O** — `catalogProvider` is asked for directly and answered from the adapter's own registry.
- Non-obvious design decisions: "Everything already configured starts unchecked, so adopting a selection never silently rewrites a capacity the user corrected." "**Deselect all** clears the entire selection so hidden results cannot be adopted accidentally", while "**Select all** adds the visible results" only. The per-field editing buffer is keyed `${index}:${field}` and re-indexed on row removal (`reindexOnRemove`).
- Edge cases / failure handling: A provider that cannot be interrogated is "a detour, not a dead end": the failure is shown next to rows the user can still fill in by hand. A late catalog response for a replaced provider is dropped via a `current` flag.
- Surprising: `CAPACITY_HINT` counts K as 1000 while the adapter's fallback is 262144 — the placeholder is "a hint, not a mirror", and the difference is stated in the comment.

#### src/client/ModelReasoningEfforts.tsx
- Purpose: The per-model `reasoningEfforts` editor for a hand-declared pi-ai route.
- Key abstractions: `INITIAL_LEVELS = ['off','low','medium','high']`; `defaultValue(level)` (`null` for `off`); `acceptedValue(level, wire)`; `validateReasoningEfforts(value)`.
- Data flow: The stored dict is read as `Object.entries` in stored order; every edit replaces the whole dict on the row.
- Non-obvious design decisions: Changing a row's level "resets a value still spelled as the old level; a custom value carries over only between two thinking levels, so changing a row to or from Off resets it." A stored key the schema does not list **keeps its row and stays selectable there** (`choicesFor`). Rows are keyed by *position*, not by level, because "keying by level would remount the select on every change and drop keyboard focus".
- Edge cases / failure handling: Leaving a field whose stored value the adapter refuses repairs it with the level name. A valueless dict (`reasoningEfforts: null`) shows the switch **on with no rows**, which the validator refuses.
- Surprising: The validator deliberately does *not* live in the shared model checker — `validateDeepSeekModels` must stay ignorant of reasoning so both families can use it.

#### src/client/ModelRow.tsx
- Purpose: One model row shared by both catalog editors.
- Key abstractions: `CapacityInput` (`value`, `placeholder`, `onChange`, `onBlur?`); `inputField` chooses the adapter's modality field name.
- Data flow: `onFieldChange('id'|'name', value)` — an emptied name is sent as `undefined` so it is *unset* rather than stored as `''`.
- Non-obvious design decisions: "Square, label-free affordances: the row's own inputs carry the meaning, so the actions stay glyphs and announce themselves through aria-label." The capacities and input types live behind the row's own chevron disclosure — "the row shows what identifies a model; capacities are the exception".
- Edge cases / failure handling: The reasoning group renders only when `reasoningLevels` is a nonempty list, which is how a catalog row is kept out of the reasoning editor.
- Surprising: `inputField` is a prop rather than a detection, because the difference is an adapter contract, not a data shape.

#### src/client/ModelsSection.module.css
- Purpose: The 831-line stylesheet for the whole Models page.
- Key abstractions: Section / row card / editor / add card / model catalog / delete dialog / fetch dialog blocks.
- Data flow: None.
- Non-obvious design decisions: "Every color resolves through a `--dsw-alias-*` token. Bare `--border` / `--surface` / `--text-*` names, which nothing in this app defines, would render the light-mode literals written as their fallbacks and stay light under the dark theme." `.addPanel[hidden] { display: none; }` is explicit because the panel's own `display: flex` would otherwise beat the `hidden` attribute and show both add-mode drafts at once. `.addButton` is dashed and full-width because it is "the last slot of the provider list … to read as a place rather than a command".
- Edge cases / failure handling: `box-sizing: border-box` is set on every button "the app has no global border-box reset, so without it the outlined variants stand 2px taller than the filled ones they sit beside". A `prefers-reduced-motion` block removes the chevron transition.
- Surprising: `.hiddenLabel` (a visually-hidden label seat) is defined and commented as existing "for the tests that query these controls by their text" — the stylesheet is written for the test suite too.

#### src/client/ModelsSection.tsx
- Purpose: The Models page itself — provider rows, the first-run setup posture, the add flow and the removal confirmation.
- Key abstractions: `AddMode = 'catalog' | 'custom'`; `EditorTarget`; `needsSetup(row, anyUsable)`; `removeProviderProfile(operations, controller, target)`; `providerTargetLabel` / `providerCopy`.
- Data flow: The page renders from `controller.store`; every mutation writes through `operations`; the page re-renders from pushed invalidations or a post-apply reload.
- Non-obvious design decisions: The **first-run posture** is the page's central idea: a whole-section provider without a configured key renders as its *open setup card* instead of a row, "but only in the first-run posture — no provider on the page can serve requests yet — and only until the user closes that card". Each card kind owns its own open state (`closeAdd` vs `closeSetup`), so closing one never discards a draft in another. Both add-mode panels stay **mounted but hidden** after first visit, so switching modes discards neither draft; the switch is **locked** while either panel has a write or an endpoint interrogation in flight, "since a switch underneath one would orphan the answer".
- Edge cases / failure handling: Removal removes the credential **first**, "so a second-step failure leaves the provider row visible and the whole operation safely retryable"; both unsets are idempotent. The saved-status notice is keyed by the route id and reads its *name* from the refreshed directory, because an apply can rename the route.
- Surprising: The add card is one button behind one card; the mode switch is a `SegmentedControl` inside the card, and the panels carry `role="tabpanel"` with `aria-labelledby` pointing at ids the switch does not actually own (`${addId}-catalog` is never rendered as an id — the SegmentedControl's own ids are used). This is a small accessibility seam.

#### src/client/OnboardingModal.module.css
- Purpose: Shared modal chrome for every onboarding step.
- Key abstractions: `.dialog` (600px max, `padding: 0`), `.content` (28px padding, `overflow-y: auto`), `.title`, `.body`.
- Data flow: None.
- Non-obvious design decisions: The padding drops to 24px under 560px, matching the dialog width rule.
- Edge cases / failure handling: `overflow-y: auto` on `.content` with `min-height: 0` keeps long bodies scrollable inside a max-height dialog.
- Surprising: `padding: 0` on the dialog itself and padding on `.content` instead — the content scrolls, not the shell.

#### src/client/OnboardingModal.tsx
- Purpose: The blocking modal every onboarding step renders into.
- Key abstractions: `ignoreImplicitDismiss` (a no-op `onClose`).
- Data flow: Sets `document.getElementById('root').inert = true` on mount and restores the **previous** value on unmount.
- Non-obvious design decisions: The onboarding modal cannot be dismissed by Escape or a mask click — `onClose={ignoreImplicitDismiss}` — because a first-run step that can be dismissed by accident is a step that silently never happened.
- Edge cases / failure handling: `titleRef.current?.focus()` only when `focusTitle` is set (a step with no form control); `tabIndex={-1}` in that case so the heading is focusable but not in the tab order.
- Surprising: `appRoot` may be absent (`if (appRoot === null) return`) — the component still renders, it just cannot inert anything, which is what makes it testable outside a mounted app.

#### src/client/operations.ts
- Purpose: The Host reads and writes the Models cards perform, bound in the plugin body.
- Key abstractions: `SettingsWriteOutcome` = `written | conflict | refused`; `ModelDiscoveryOutcome` = `found | refused`; `ModelsOperations`.
- Data flow: `createModelsOperations(ctx)` wraps `ctx.remote.credentials.set/unset`, `ctx.remote.settings.mutate`, `ctx.remote.llm.discoverModels`.
- Non-obvious design decisions: "Cards receive these instead of a context: the outcomes name what a card renders — a stored view, a stale revision, a refusal message — so the failure codes and Remote namespaces stay in the apply world." The `settings/conflict` code is the *only* thing that distinguishes a stale draft from any other refusal, and the mapping happens once, here.
- Edge cases / failure handling: `storeCredential` / `removeCredential` return `undefined` on success and the refusal message on failure — a `string | undefined` rather than a boolean, so the card can show the Host's own diagnostic.
- Surprising: The `mutate` call takes `expectedRevision: number | undefined`, and the *removal* path deliberately passes `undefined` (unfenced) — a delete is idempotent and does not need a fence.

#### src/client/protocol-label.ts
- Purpose: Product names for the three wire protocols a pi-ai route may speak.
- Key abstractions: `PROTOCOL_LABEL_KEYS` maps `openai-completions | openai-responses | anthropic-messages` to copy keys.
- Data flow: `protocolLabel(t, protocol)` is called by the two `<select>`s that render the protocol.
- Non-obvious design decisions: "The pickers show these instead of the schema identifiers (`openai-completions`), which are what `settings.yaml` carries and **what the option values stay**." A protocol the adapter adds before this page names it shows its raw identifier, "the spelling `settings.yaml` needs anyway".
- Edge cases / failure handling: None.
- Surprising: The identifier space is open-ended on purpose — the adapter may add protocols the UI has no name for.

#### src/client/ProviderEditor.tsx
- Purpose: One provider's editing card — the hand-written editor for the two known adapter families.
- Key abstractions: `pathOps(base, before, after)` → minimal set/unset ops; `layoutOf(ns)` → `'deepseek' | 'pi-ai' | 'unknown'`; `refFor(...)`; `ProviderEditorProps`.
- Data flow: draft → `pathOps` → `operations.writeSettings(ns, ops, expectedRevision)` → then `operations.storeCredential(keyRef, keyValue)`.
- Non-obvious design decisions: "Every edit travels as path ops against the STORED section: the draft comes from the redacted descriptor, so a wholesale replace rebuilt from it could delete fields outside the card." After the settings write the card adopts the returned redacted user subtree and revision **before** the credential write, so "a failed credential stage retries only that stage". Reasoning effort is deliberately absent at provider scope: "effort is a per-MODEL capability, and the models under one provider disagree about it, so a provider-scoped control can only be set to a value some of them reject." A whitespace-only base URL is *cleared*, not stored, "where both adapters would accept that non-empty string as a real value".
- Edge cases / failure handling: An unresolvable settings path renders a visible error instead of a blank card ("showing it beats a blank card"). The `inheritedModels()` helper reads the **base layer** or the schema default, never the effective value, because the effective value still carries the stored override until the unset is applied — reading it "would echo that override straight back the moment reset drops it". The pi-ai `apiKeyEnv` is only written "when this page is about to store a key".
- Surprising: The credential hint distinguishes **three** states — detected (success tone), missing (warning tone) and unconfirmed (tertiary tone) — because "Detection does not validate credentials, test a connection, or inspect provider-managed files such as AWS profiles".

#### src/client/schema-operations.ts
- Purpose: Wraps the Cordis `SettingsSchemaService` into plain callbacks.
- Key abstractions: `SettingsSchemaOperations = Pick<SettingsSchemaService, 'rehydrate' | 'validate' | 'nodeAtPath' | 'getPath' | 'hasPath' | 'setPath' | 'deletePath'>`.
- Data flow: Every schema call in the package goes through this object.
- Non-obvious design decisions: "Hide the Cordis service identity behind bound schema callbacks … callbacks that cannot expose the service context to React components."
- Edge cases / failure handling: None.
- Surprising: The `Pick` is a deliberate whitelist — a new method on the service does not silently become available to the UI.

#### src/client/slot-contract.ts
- Purpose: Declares the three extension seats through which a plugin distributed outside this repo adds UI to the Models page.
- Key abstractions: `settings.models.provider-card` (kinded, keyed by `settingsNs`), `settings.models.sign-in` (single), `settings.models.footer` (list); `ProviderCardExtrasOwnerProps`, `ModelsFooterOwnerProps`.
- Data flow: `ctx.slots.inject('settings.models.provider-card', …)` by a registrant; the section dispatches with `entryKey = row.entry.settingsNs`.
- Non-obvious design decisions: Keying on the *namespace* rather than the route id means "one registration under an adapter family's namespace receives every card of that family, shipped, added, and hand-declared rows alike — while the section never learns what the namespace means". The key domain stays the open string space "because hand-declared route ids are user-chosen at runtime". The types live with their declarer ("a plugin registering an extension already depends on this package for the declaration").
- Edge cases / failure handling: Without a registrant the area renders nothing; the hand-declared draft card has no directory row yet, so it dispatches nothing until saved.
- Surprising: The owner props carry `keyConfigured` — a *derived* credential fact (the profile's `apiKeyEnv`, or the page's derived `<ROUTE>_API_KEY` while the profile names none) — so a registrant sees the same fact the editor does.

#### src/client/store.ts
- Purpose: The page store — the directory × namespaces × credentials join — plus the first-run readiness projection.
- Key abstractions: `joinProviderDirectory(registered, directory)`; `deriveKeyRef(provider)`; `protocolChoices(ns, schema)`; `reasoningLevelChoices(ns, schema)`; `ModelsSettingsStore`; `onboardingReadiness(state)`; `providerUsable(row)`.
- Data flow: `load()` → `listProviders` + `listConfigurableProviders` + the mirror's `ensure()` in parallel → join → `session.modelCatalog()` (account row) → a **batched** `credentials.describe` in chunks of 64 → publish.
- Non-obvious design decisions: The protocol and reasoning-level choices are read out of the **namespace's own schema** through a probe path (`['providers', '\u0000probe', 'api']`), "so the choices the page offers cannot drift from the ones the adapter accepts: both come from the same `Config`". The probe key is a NUL character so it "cannot collide with a configured route". A credential-describe failure **degrades the badge, not the page** (`credentialError`), while a directory failure keeps the last good rows and surfaces an error.
- Edge cases / failure handling: A generation counter makes the newest load win: an older response "can neither publish nor settle callers". `settleLoads` resolves concurrent callers only after the *current* refresh publishes its ready or error snapshot. The account row is hidden entirely while its catalog is empty, and reappears when sign-in returns.
- Surprising: `joinProviderDirectory` sorts `deepseek-account` first and `deepseek-official` second, and third-party providers keep their directory order — a product decision encoded in a sort comparator.

#### src/client/welcome-store.ts
- Purpose: Durable acknowledgement state for the versioned preview notice.
- Key abstractions: `decodeWelcomeSection(section)`; `WelcomeNoticeStore` with a `SnapshotStore<WelcomeNoticeState>`.
- Data flow: Reads `ui-settings-general.welcomeNoticeVersion` through the shared config scope; `acknowledge()` writes it with `scope.set`.
- Non-obvious design decisions: A malformed durable value is read as an **empty section**, so the notice treats it as unacknowledged "instead of leaving the scope stuck on its previous value". Acknowledgement is compared for **exact equality** with the current version, so a user who acknowledged an earlier version sees the notice again.
- Edge cases / failure handling: Success is judged against **the state the write left behind**, not against the write's return value: "a refused or failed write reports false after its recovery read settles". `derive()` is suppressed while `saving` so the scope's own echo does not race the write.
- Surprising: `assertNever` on the scope's closed-union status is marked `/* v8 ignore next 3 */` — the default arm exists only to defend future source widening, and the ignore comment says so.

#### src/client/WelcomeNotice.module.css
- Purpose: Four rules for the notice copy, its error line and the Continue button.
- Key abstractions: `.copy`, `.copy p`, `.error`, `.actions`, `.primary`.
- Data flow: None.
- Non-obvious design decisions: `.primary { min-width: 120px }` becomes `width: 100%` under 560px.
- Edge cases / failure handling: None.
- Surprising: The paragraph margin is expressed as `.copy p + p { margin-top: 12px }` so a single paragraph has no leading gap.

#### src/client/WelcomeNotice.tsx
- Purpose: The product-wide, versioned preview notice.
- Key abstractions: `WelcomeNoticeInjected` (`hooks.welcome`, `controller`, `t`).
- Data flow: `controller.load()` on mount; `controller.acknowledge()` on Continue; `complete()` when the state says acknowledged.
- Non-obvious design decisions: The notice renders **until** its exact copy version is acknowledged, and `finish` is guarded by a `useRef` flag so `complete()` fires once even under React's double-invoked effects.
- Edge cases / failure handling: While the scope is still loading the notice renders nothing ("No answer stands, so the step renders nothing and never acknowledges"). A refused write shows an `role="alert"` and keeps the modal open.
- Surprising: `state.status === 'idle' | 'loading' | acknowledged` all return `null` — the notice is a step in a coordinator, not a standalone dialog.

#### src/css-modules.d.ts
- Purpose: Ambient declaration for `*.module.css` and `*.css` imports.
- Key abstractions: `const classes: Record<string, string>`.
- Data flow: None.
- Non-obvious design decisions: None.
- Edge cases / failure handling: None.
- Surprising: Nothing.

#### src/index.ts
- Purpose: The Host half — publishes the public onboarding option into the page.
- Key abstractions: `ONBOARDING_CONFIG_GLOBAL`; `Config` from `onboarding-config.ts`.
- Data flow: `ctx.on('webserver/index-inject', …)` pushes `{kind:'global', name, value:{credentialOnboarding}}` before browser plugins activate.
- Non-obvious design decisions: The option is **public page-initialization data, not a durable completion marker** — so a reload of the page reads the same value rather than "already onboarded".
- Edge cases / failure handling: The Client validates the payload with the same `Config` schema before registering dialogs, so a malformed bootstrap option throws at apply time rather than rendering a broken dialog.
- Surprising: A Host-side `apply` that does nothing but publish a boolean — the Host half of a UI package can be pure page-init data.

#### src/onboarding-config.ts
- Purpose: The schemastery `Config` for the public onboarding option.
- Key abstractions: `Config` (`credentialOnboarding: boolean`, default `true`); `ONBOARDING_CONFIG_GLOBAL = '__DSH_MODELS_ONBOARDING__'`.
- Data flow: The Host validates host config with it; the Client validates the page-global payload with it.
- Non-obvious design decisions: The same schema object validates both the Host-side plugin option and the Client-side page global, so the two can never disagree about the option's shape.
- Edge cases / failure handling: `z.boolean().default(true)` means a missing value is "on"; a string `'false'` fails validation.
- Surprising: The page-global key is namespaced with `__DSH_` and is set as a `globalThis` property.

#### src/onboarding-copy.ts
- Purpose: The durable namespace, field name and version constant for the preview notice.
- Key abstractions: `WELCOME_NOTICE_SETTINGS_NAMESPACE = 'ui-settings-general'`; `WELCOME_NOTICE_ACK_FIELD = 'welcomeNoticeVersion'`; `WELCOME_NOTICE_VERSION = '2026-09-28.1'`.
- Data flow: The notice reads and writes the field through the shared config scope.
- Non-obvious design decisions: "Bump only when the notice changes materially and every user should see it again. The acknowledgement is compared for exact equality."
- Edge cases / failure handling: None.
- Surprising: The acknowledgement lives in the *general* settings namespace, not a notice-specific one, so the switch survives a package rename.

#### tests/apply.client.spec.ts
- Purpose: Registration spec for the browser half.
- Key abstractions: A `bench()` that wires a `SlotRegistry`, a `LocaleRuntime` (set to zh) and a `TestRemote` with scripted `credentials`/`llm`/`settings`/`session` faces.
- Data flow: Drives `apply()` and asserts on `ctx.slots.entries(...)` and the injected face.
- Non-obvious design decisions: "These specs assert the shipped Chinese copy. The lane has no jsdom `window`, so browser-language detection never runs and a fresh LocaleRuntime opens on FALLBACK_LOCALE (en); bench stages zh explicitly." The HMR case asserts that a stale disposer cannot block re-registration after the declarer reloads.
- Edge cases / failure handling: The spec asserts the injected `inject` array literally, so a new service cannot be added without updating the spec.
- Surprising: The locale-thunk test switches locale *after* registration and asserts the label changes — proving no re-registration is needed.

#### tests/components.client.spec.tsx
- Purpose: The 2425-line behavioural spec of the section, the setup card, the editor, the add flow and the credential states.
- Key abstractions: `wireNamespaces()` (five fixture namespaces), `scriptedFace()` (scripted Remote), `mountFace`/`mountFirstRun`/`mountDeepSeekCard`, `stubRenderSlot()` recording every slot dispatch.
- Data flow: Renders `ModelsSection` over a real `ModelsSettingsStore` and a real `SettingsDescribeMirror`.
- Non-obvious design decisions: `contexts` and `operations` are `WeakMap`s keyed by the scripted face, "One context per face, as in production: an editor effect keyed by the context would otherwise re-probe on every render". The spec pins the *order* of writes: `expect(unset.mock.invocationCallOrder[0]).toBeLessThan(mutate.mock.invocationCallOrder[0])`.
- Edge cases / failure handling: Covers the whole matrix: stale load vs newest load, a superseded reader, a failed credential read, a conflict, a rejected write, a read-only deployment, an unresolvable settings path, a partially failed page load, and the mode switch locked during an in-flight write or interrogation.
- Surprising: It asserts that the Models page never calls `session.initializeDefaultModel` — "Saving credentials or a custom provider preserves the selected model."

#### tests/model-input-types.client.spec.tsx
- Purpose: Per-field input-type spec, run twice — once for `inputModalities`, once for `input`.
- Key abstractions: `describe.each(['inputModalities','input'])`.
- Data flow: Renders `ModelInputTypes` directly with a controlled `onChange`.
- Non-obvious design decisions: The spec asserts the *original* model object is not mutated (`expect(model).not.toHaveProperty(field)`) — the component replaces the row rather than editing it in place.
- Edge cases / failure handling: Asserts the last remaining modality cannot be unchecked, that DeepSeek's image limits are dropped only for `inputModalities`, and that both checkboxes are disabled while read-only.
- Surprising: The same suite runs against both field names and expects **different** image-limit behaviour.

#### tests/model-list-catalog.client.spec.tsx
- Purpose: Catalog read spec — draft ownership and stale-response handling.
- Key abstractions: `Promise.withResolvers<ModelDiscoveryOutcome>()` for controllable responses.
- Data flow: Renders `ModelListEditor` with a scripted `operations.discoverModels`.
- Non-obvious design decisions: "ignores a late catalog response after the provider changes" — the editor is told which provider the answer is for and compares.
- Edge cases / failure handling: "restores inherited image input after a failed catalog read is retried manually" — a failed read degrades to no inherited types, and a manual retry restores them.
- Surprising: The inherited input types arrive from the catalog, so the *first* fetch is a side effect of opening a row, not of pressing Fetch.

#### tests/model-reasoning-efforts.client.spec.tsx
- Purpose: The reasoning-level spec: echo of stored order, level rows, API values, refusals and placement.
- Key abstractions: `LEVELS = ['off','minimal','low','medium','high','xhigh','max']` — the schema's list today.
- Data flow: Renders `ModelReasoningEfforts` over local state and records every write.
- Non-obvious design decisions: The rows are keyed by position, so the spec asserts that "writes only the surviving model's own levels after the row above it is deleted" — a deleted row's editor instance is reused by the survivor and must not leak state.
- Edge cases / failure handling: A refused value is marked `aria-invalid` and is repaired on blur. A valueless dict shows the switch on with no rows and is refused by the validator.
- Surprising: The spec asserts `validateDeepSeekModels` does **not** know about reasoning efforts ("stays out of the shared model checker that DeepSeek and catalog rows use").

#### tests/onboarding-dialog.client.spec.tsx
- Purpose: First-run dialog spec over the shared Models join.
- Key abstractions: `harness(options)` builds a scripted face with switchable failure modes; `DeepSeekConfig` is a schemastery object with `role('credential-ref')`.
- Data flow: Renders the dialog with a real `ModelsSettingsStore` over a `SettingsDescribeMirror`.
- Non-obvious design decisions: The spec asserts the modal "cannot be dismissed implicitly" — Escape and a mask click both leave it open — and that `appRoot.inert` is restored to its previous value on unmount.
- Edge cases / failure handling: Seven separate harnesses cover every unavailable reason, each asserting the dialog does **not** render and `complete()` is called once.
- Surprising: The spec asserts `h.mutate` was never called — the onboarding key write touches only the credentials domain.

#### tests/provider-form.client.spec.tsx
- Purpose: The 1711-line spec for model-list editing, endpoint interrogation and hand-declared provider creation.
- Key abstractions: `scriptedFace()` (providers / userProviders / baseProviders / declaredRoutes), `firstMutate(mutate)` (regroups the Remote's positional call into one record), `lastProbe(discover)`.
- Data flow: Drives the section and the create card through jsdom events and asserts on the recorded `settings.mutate` ops.
- Non-obvious design decisions: "A hand-declared route reaches the same judgement as an edited one, so a key that no header can carry never becomes a profile plus a bad secret." The probe assertion pins the exact payload: `{settingsNs, provider, baseURL, apiKey}` — the *unsaved* key is included.
- Edge cases / failure handling: Covers a digit-leading route id, a non-HTTP base URL, a localhost/IPv6 URL that must be *accepted*, whitespace normalisation, a network failure kept distinct from a syntax error, a duplicate model id, an unreadable capacity, a conflict, a rejected write and a refused credential write.
- Surprising: `derives a reference the credential seam accepts for every id it admits` is checked as a **relation** (`CREDENTIAL_REF.test(deriveKeyRef(id))`) rather than through the DOM — "the two rules have to stay in step".

#### tests/readiness.client.spec.ts
- Purpose: Pure spec for `onboardingReadiness` and `providerUsable`.
- Key abstractions: `row()` and `otherRow()` fixtures; `state()` builder.
- Data flow: No I/O — the snapshot is constructed directly.
- Non-obvious design decisions: "turns missing capabilities into diagnostics that never block the product" — every failure maps to a typed `unavailable` reason rather than an exception.
- Edge cases / failure handling: Covers a reference-free registered route (provider-native auth, no key owed), a file credential, an env credential, an unreadable credential, and each read-only case separately.
- Surprising: A credential with `source:'env'` and `writable:false` still ends onboarding as `provider-ready` — writability does not matter when a key already exists.

#### tests/settings-schema.client.ts
- Purpose: A six-line shared fixture.
- Key abstractions: `settingsSchema = createSettingsSchemaOperations(new SettingsSchemaService(new Context()))`.
- Data flow: Imported by the component specs to give them a stateless schema service.
- Non-obvious design decisions: "Stateless schema operations used by settings-model component fixtures" — it is a *fixture*, not a spec, and has no `.spec.` in its name so the runner does not treat it as a suite.
- Edge cases / failure handling: None.
- Surprising: The file lives in `tests/` but is not a test.

#### tests/store.client.spec.ts
- Purpose: The join spec — directory × namespaces × credentials, with last-good rows on failure.
- Key abstractions: `api(overrides)` builds a scripted face; `DIRECTORY` and `NAMESPACES` fixtures.
- Data flow: Drives `ModelsSettingsStore.load()` over a real `SettingsDescribeMirror`.
- Non-obvious design decisions: The provider batch is read through a rotating promise so a test can prove "the newest load wins over a stale slow response" — the second read gets a *different* promise.
- Edge cases / failure handling: Asserts the 64-reference batching exactly (`[64, 64, 2]`), the credential-domain degradation, a directory failure keeping the last good rows, and four separate concurrency scenarios (superseded callers pending, latest refusal settling obsolete callers, unexpected rejection propagating, and a refresh started by a snapshot subscriber owning the waiters).
- Surprising: The credential list is asserted to be `['DEEPSEEK_API_KEY','OPENAI_API_KEY','ANTHROPIC_API_KEY','GHOST_API_KEY']` — named references first in row order, then the derived references of rows whose profile names none, in **one** batched describe.

#### tests/styles.client.spec.ts
- Purpose: A stylesheet contract asserted against the CSS text on disk.
- Key abstractions: `block(selector)` extracts one rule's declarations; `tokens` concatenates every theme sheet.
- Data flow: Reads `ModelsSection.module.css` and `../../ui-theme/src/styles/*.css` with `node:fs` at test time.
- Non-obvious design decisions: "A `--dsw-*` name the theme does not declare fails silently: the browser takes the `var()` fallback, so the sheet still renders and only the dark theme looks wrong." The check covers `--dsw-`, `--dsh-` and `--ds-` prefixes — "a `--dsh-` name reads as a plausible sibling and would otherwise slip past this gate into a fallback literal."
- Edge cases / failure handling: Also asserts brace balance ("a missing `}` on an `@media` block is not a parse error: every rule after it silently becomes conditional"), that no `var()` has a literal colour fallback, and that **every** `<select` in the package carries the `selectInput` class — the check parses the `.tsx` sources by splitting on `<select` and reading to the first `>`.
- Surprising: The select check reads *source text*, not the DOM, because a `<select>` that takes `.input` alone "silently keeps the OS one".

#### tests/welcome-notice.client.spec.tsx
- Purpose: The notice spec.
- Key abstractions: `WELCOME_NOTICE_COPY` freezes the exact en/zh strings; `mount(version?, mutateImpl?)` builds the scope and the injected props.
- Data flow: Renders the notice over a real `ConfigFormController` and `SettingsDescribeMirror`.
- Non-obvious design decisions: The spec asserts `en.welcomeBody` **equals** the frozen copy — the notice's text is a tested constant, not a string.
- Edge cases / failure handling: Asserts Escape and the mask do not dismiss it, `appRoot.inert` is true while it is up, the sole action is disabled while saving, and a refused write shows the alert without completing the step.
- Surprising: The dialog must contain exactly one button and exactly two paragraphs — the copy's paragraph structure is part of the contract.

#### tests/welcome-store.client.spec.ts
- Purpose: The durable-acknowledgement spec.
- Key abstractions: `buildWelcome(api)` wires a real `ConfigFormController` over a real mirror.
- Data flow: Drives `WelcomeNoticeStore.load()` / `.acknowledge()`.
- Non-obvious design decisions: "persists the owner version through one revision-fenced mutation" — the spec asserts the exact `mutate` call including the revision `3`.
- Edge cases / failure handling: A failed write triggers exactly one mirror recovery read (`describeCall` called twice), a missing namespace is an error rather than a silent skip, and a malformed durable value reads as unacknowledged.
- Surprising: "retains acknowledgement when the settings plugin is recreated" — the spec disposes and re-creates the whole settings plugin and asserts the acknowledgement survived, i.e. it is durable in the Host, not in the client.

#### tsconfig.json
- Purpose: Client tsconfig.
- Key abstractions: `extends ../../../tsconfig.base.client.json`; `rootDir: src`, `outDir: lib/types`.
- Data flow: Project references wire the ten workspace packages this one compiles against.
- Non-obvious design decisions: The references include both `../ui-settings/tsconfig.client.json` and `../locale/tsconfig.client.json` — the *client* variants.
- Edge cases / failure handling: None.
- Surprising: `include: ["src"]` — the tests are type-checked by a different tsconfig.

#### tsdown.config.ts
- Purpose: The bundler config.
- Key abstractions: `clientBundle(import.meta.dirname, ['lib/types/index.js'])`.
- Data flow: None.
- Non-obvious design decisions: Identical three lines in all seven packages — the shared helper carries the whole policy.
- Edge cases / failure handling: None.
- Surprising: Nothing.

### packages/client/ui-settings-plugin-inventory

#### locale/en.json
- Purpose: Package metadata stub — `{"meta":{"title":"ui-settings-plugin-inventory"}}`.
- Key abstractions: None.
- Data flow: Manifest tooling only.
- Non-obvious design decisions: Same convention as the sibling packages.
- Edge cases / failure handling: None.
- Surprising: Nothing.

#### locale/zh.json
- Purpose: Chinese package metadata with a description of the built-in plugin list surface.
- Key abstractions: None.
- Data flow: Manifest tooling only.
- Non-obvious design decisions: Chinese carries a description the English file does not.
- Edge cases / failure handling: None.
- Surprising: Nothing.

#### package.json
- Purpose: Publishable manifest for `@deepseek-ai/dsh-client-ui-settings-plugin-inventory`.
- Key abstractions: `dsh.client.inject` pulls api-remotes, ui-settings, locale, ui-agent-preset and client-modules.
- Data flow: The loader ensures those peers are present before the browser half activates.
- Non-obvious design decisions: `dsh-agent-preset-registry` is a devDependency because it is imported for a **pure function** (`presetDisplayText`) that the bundle inlines.
- Edge cases / failure handling: None.
- Surprising: The package pulls in the preset registry purely to share a display fold, not to depend on the registry's runtime.

#### README.i18n.yaml
- Purpose: Per-heading hash record for the README pair.
- Key abstractions: Same as the siblings.
- Data flow: Regenerated by `verify-translation-pairing`.
- Non-obvious design decisions: None.
- Edge cases / failure handling: None.
- Surprising: Nothing.

#### README.md
- Purpose: The spec of the read-only inventory tab.
- Key abstractions: Documents the card anatomy, the enablement tag set, the phase dot set and the preset switcher.
- Data flow: Describes the lazy `ctx.remote.pluginInventory.list()` call and the client-sync state.
- Non-obvious design decisions: "The tab is a read-only projection of a Host-owned snapshot; it performs no Remote read during plugin activation and takes the snapshot on first selection."
- Edge cases / failure handling: The tab handles loading, empty, no-match, failure and retry states "without exposing transport details".
- Surprising: "A failed installation with pending pnpm build permissions offers **Allow these scripts and retry**" — that affordance is described in this package's README even though its implementation lives elsewhere in the client.

#### README.zh.md
- Purpose: Chinese mirror of the inventory tab spec.
- Key abstractions: Same.
- Data flow: Same.
- Non-obvious design decisions: The zh rendering section repeats the same "preset-provided marking is derived client-side" rule, so the derivation rule is stated in both languages.
- Edge cases / failure handling: Same.
- Surprising: Nothing.

#### src/client/index.ts
- Purpose: The browser apply for the inventory tab.
- Key abstractions: `NS = 'settings.pluginInventory'`; `inject = ['slots','locale','remote','remote.pluginInventory','modules']`.
- Data flow: `list()` calls `ctx.remote.pluginInventory.list()` and throws on a refusal; `presetName` resolves through `presetDisplayText(preset, agentPresetCopy)`.
- Non-obvious design decisions: "Resolved per call over ui-agent-preset's dictionaries, so a language switch re-resolves shipped names; user-authored metadata passes through." The `list` callback throws `pluginInventory.list failed: ${code}: ${message}` — the code stays in the message because the transport detail is not shown.
- Edge cases / failure handling: `retryClient` catches and logs the failure rather than letting it escape.
- Surprising: The tab registers under `settings.plugins.tab` with id `all` — "all" is the tab's *id*, not a claim that it lists everything.

#### src/client/locales.ts
- Purpose: The zh-first dictionary with an `en` typed against the zh key set.
- Key abstractions: `PluginInventoryLocaleKey = keyof typeof zh`.
- Data flow: Registered as `ctx.locale.register(NS, { zh, en })`.
- Non-obvious design decisions: The **zh** dictionary is the source of truth here (the reverse of the models package) — the file's own comment says "Simplified Chinese dictionary and key source of truth".
- Edge cases / failure handling: None.
- Surprising: The vocabulary is deliberately minimal: five enablement tags, five runtime phase labels, and nothing else.

#### src/client/PluginInventorySettingsTab.module.css
- Purpose: The 488-line stylesheet for the inventory tab.
- Key abstractions: `.cards` grid (2 columns), `.card`, `.cardContent`, `.skeletonCard`, `.details` grid.
- Data flow: None.
- Non-obvious design decisions: `container: plugin-inventory / inline-size` — "The tab's own width, not the window's, decides the card columns below", with a `@container` query collapsing to one column below 520px. The `nth-child(odd)` selectors keep the *other* card in an expanded card's row from stretching, with a comment warning "The selectors assume the two columns `.cards` declares … and must change with that count".
- Edge cases / failure handling: The skeleton pulse is inside `@media (prefers-reduced-motion: no-preference)`.
- Surprising: The scrollbar thumb token is rebound on `.fetchDialog` — no wait, that is the models package; here the equivalent is the shared `--dsh-scrollbar-thumb` contract.

#### src/client/PluginInventorySettingsTab.tsx
- Purpose: The read-only inventory tab.
- Key abstractions: `PluginInventorySettingsTabInjected` (`resolveText`, `hooks.clientSync`, `retryClient`, `list`, `presetName`); `PluginCard`; `CardFacts`; `PhaseDot`; `StateTag`.
- Data flow: `list()` → a snapshot of `entries` + `agentPresets`; the tab renders the preset group (open) and the global group (folded).
- Non-obvious design decisions: Row keys are **scope-qualified** (`global:<entryId>` / `preset:<id>:<index>`), "so one module appearing in both scopes keeps distinct disclosure state". The "provided by presets" marking is derived client-side: a global entry carries it only when it is disabled globally **and** at least one preset row for the same module specifier is actually enabled — "a module every preset gates off (or declares only conditionally) stays plainly disabled rather than over-claiming provision." A tag renders only for states that depart from plainly enabled; a dot renders only for phases no tag states.
- Edge cases / failure handling: A failed read renders a generic error and a Retry; the transport detail is not shown. A late answer after unmount is dropped by a `current` flag. A synchronous `list()` throw is contained because the call is wrapped in `Promise.resolve().then(...)`.
- Surprising: `moduleShortName` strips the npm scope and the `cordis:` / `cordis-plugin-` / `dsh-` prefixes for display, but "Full module specifiers remain available in details and search".

#### src/css-modules.d.ts
- Purpose: Ambient CSS module declaration.
- Key abstractions: None.
- Data flow: None.
- Non-obvious design decisions: None.
- Edge cases / failure handling: None.
- Surprising: Nothing.

#### src/index.ts
- Purpose: The Host half — an empty `apply()`.
- Key abstractions: None.
- Data flow: None.
- Non-obvious design decisions: "Host plugin body — no host-side behavior for the plugin inventory tab."
- Edge cases / failure handling: None.
- Surprising: This package has no Host half at all: the inventory is produced by a *different* Host plugin (`host/plugin-inventory`).

#### tests/browser-plugin.client.spec.tsx
- Purpose: The registration spec.
- Key abstractions: `bench()` wires a `SlotRegistry`, a `LocaleRuntime` and a fake `remote.pluginInventory` service; `usePinnedBrowserLanguages('zh-CN')` pins the browser language so the locale is deterministic.
- Data flow: Drives `apply()` and asserts on the registered slot and the injected face.
- Non-obvious design decisions: The spec asserts the tab "registers a localized tab **without reading the Remote eagerly**" — `expect(b.list).not.toHaveBeenCalled()`.
- Edge cases / failure handling: Covers late declaration, declarer reload, and the disposer letting the `(ns, locale)` dictionary seat be reused.
- Surprising: The preset-name resolution is asserted directly: a shipped preset resolves to the dictionary string, a user-authored one keeps its own metadata.

#### tests/components.client.spec.tsx
- Purpose: The 663-line rendering spec.
- Key abstractions: `SNAPSHOT` fixture with one failed global row, two preset-provided rows, a broken preset and an anonymous row.
- Data flow: Renders the tab over a scripted `list()`.
- Non-obvious design decisions: The spec asserts "keeps authored locale titles verbatim when they resemble module names" — a hand-written title `dsh-Navigation` must not be shortened to `navigation`.
- Edge cases / failure handling: Covers failures-first ordering in the global plane, a rosterless deployment, a preset-only snapshot, a search that matches only in another preset, and a search that matches only on a Loader entry id.
- Surprising: The spec asserts that the *global* group shows the failed row first, "Failures float above the Loader-ordered remainder".

#### tsconfig.json
- Purpose: Client tsconfig with eleven workspace references.
- Key abstractions: None.
- Data flow: None.
- Non-obvious design decisions: References `../../util/package-manifest` and `../../preset/agent-preset-registry` because the tab consumes their types.
- Edge cases / failure handling: None.
- Surprising: Nothing.

#### tsdown.config.ts
- Purpose: Three-line tsdown config delegating to `clientBundle`.
- Key abstractions: None.
- Data flow: None.
- Non-obvious design decisions: None.
- Edge cases / failure handling: None.
- Surprising: Nothing.

### packages/client/ui-settings-plugins

#### locale/en.json
- Purpose: Package metadata stub — title only.
- Key abstractions: None.
- Data flow: Manifest tooling.
- Non-obvious design decisions: None.
- Edge cases / failure handling: None.
- Surprising: Nothing.

#### locale/zh.json
- Purpose: Chinese package metadata with a description.
- Key abstractions: None.
- Data flow: Manifest tooling.
- Non-obvious design decisions: None.
- Edge cases / failure handling: None.
- Surprising: Nothing.

#### package.json
- Purpose: Publishable manifest for the built-in plugins settings section.
- Key abstractions: `dsh.client.inject` pulls only `locale` and `ui-settings` — the smallest dependency set in the shard.
- Data flow: The loader ensures those two peers are present.
- Non-obvious design decisions: The package registers no namespace of its own; it is purely a section shell.
- Edge cases / failure handling: None.
- Surprising: The peer set is just Cordis — the shell does not depend on any feature package.

#### README.i18n.yaml
- Purpose: Per-heading hash record for the README pair.
- Key abstractions: Same as the siblings.
- Data flow: Regenerated by `verify-translation-pairing`.
- Non-obvious design decisions: None.
- Edge cases / failure handling: None.
- Surprising: Nothing.

#### README.md
- Purpose: The spec of the shell package.
- Key abstractions: Documents the tab contract (`id`, `order`, localized `label`) and the section's ownership split.
- Data flow: Describes the slot ledger projection and the lazy mounting.
- Non-obvious design decisions: "The section is a shell: it owns the navigation entry and the tab row, and every tab in it is registered by another plugin." "a lone contribution renders as the page itself, and a tab stays mounted after its first selection so search and the inventory snapshot survive switching."
- Edge cases / failure handling: "The section has no tab of its own — it renders its empty line until a feature plugin registers one; the shell cannot fill the section alone."
- Surprising: The tab projection is "cached until the ledger version or the locale revision moves" — two independent invalidation sources for one projection.

#### README.zh.md
- Purpose: Chinese mirror of the plugins section spec.
- Key abstractions: Same.
- Data flow: Same.
- Non-obvious design decisions: Same.
- Edge cases / failure handling: Same.
- Surprising: Nothing.

#### src/client/index.ts
- Purpose: The browser apply — registers the section and projects the tab ledger.
- Key abstractions: `inject = ['slots','locale']`; `NS = 'settings.plugins'`; a `HostObservable<readonly PluginsSettingsTabEntry[]>` built over the ledger.
- Data flow: `getSnapshot()` reads `ctx.slots.getVersion('settings.plugins.tab')` and `ctx.locale.getSnapshot().revision`; if either moved, it rebuilds the ordered rows. `subscribe` wires both the slot ledger and the locale.
- Non-obvious design decisions: The projection is memoised on **(ledger version, locale revision)** rather than on a React state update, so a locale switch re-derives the labels without a re-registration. "Cross-plugin collaboration goes through slots, never a value import (client bundle purity gate)."
- Edge cases / failure handling: A registration with no `id` falls back to `''` and no `order` to `0`; both are marked `/* v8 ignore */` because the ledger requires them.
- Surprising: The section owns the `settings.plugins.tab` slot declaration *and* is the first registrant in it — the owner declares the children it will render.

#### src/client/locales.ts
- Purpose: A five-key dictionary (`nav`, `title`, `intro`, `tabs`, `empty`).
- Key abstractions: `PluginsSettingsLocaleKey` is a hand-written union, not derived.
- Data flow: Registered as `ctx.locale.register(NS, { zh, en })`.
- Non-obvious design decisions: The union is explicit rather than `keyof typeof en` because the type is exported and consumed by other packages' `LocaleNamespaceMap` merges.
- Edge cases / failure handling: None.
- Surprising: `nav` and `title` are the same string in both locales — the nav label and the page heading coincide.

#### src/client/PluginsSettingsSection.module.css
- Purpose: The tab-row stylesheet.
- Key abstractions: `.tabs` (underline row), `.tab` with a `::after` underline for the active and focused states, `.panel`, `.cards`, `.empty`, `.configurable`, `.presetSettings`.
- Data flow: None.
- Non-obvious design decisions: The active underline is a pseudo-element on `.tab[data-active='true']::after` *and* on `:focus-visible::after`, so a keyboard-focused inactive tab shows the underline too.
- Edge cases / failure handling: None.
- Surprising: The sheet also carries `.configurable` and `.presetSettings` rules that no component in *this* package uses — they are here for the sibling packages that render inside the same section.

#### src/client/PluginsSettingsSection.tsx
- Purpose: The tab shell around feature-owned pages.
- Key abstractions: `PluginsSettingsTabEntry` (`id`, `order`, `label`); `PluginsSettingsSectionProps`.
- Data flow: `useTabs(selector)` reads the projection; `renderSlot('settings.plugins.tab', {}, { only: row.id })` dispatches one tab's content.
- Non-obvious design decisions: "A tab mounts only when first selected, then stays mounted while hidden so local drafts, disclosure state, search, and the inventory snapshot survive switching between the two views." A **single** contribution renders as the page itself (`renderSlot(..., { only: single.id })`) with no tablist at all — "one contribution shows as the page itself". The keydown handler implements the standard horizontal tab pattern (ArrowLeft/Right/Home/End, wrapping) and moves focus with `nextTab.focus()`.
- Edge cases / failure handling: `rows.length === 0` renders the empty line. `tabIndex` is 0 on the selected tab and -1 on the others (roving tabindex).
- Surprising: The visited-tab set is derived from state rather than stored per tab, so a tab removed from the ledger simply stops being rendered.

#### src/css-modules.d.ts
- Purpose: Ambient CSS module declaration (four lines).
- Key abstractions: None.
- Data flow: None.
- Non-obvious design decisions: None.
- Edge cases / failure handling: None.
- Surprising: Nothing.

#### src/index.ts
- Purpose: The Host half — an empty `apply()`.
- Key abstractions: None.
- Data flow: None.
- Non-obvious design decisions: "The empty apply exists so the plugin appears in the host cordis.yml / Loader; the browser half owns the section and its configurable tab through exports["./client"], discovered from the package.json dsh.client declaration."
- Edge cases / failure handling: None.
- Surprising: The Host half is *not* where the section lives — the Loader row exists only so the client module system can serve the browser half.

#### tests/apply.client.spec.ts
- Purpose: The registration spec.
- Key abstractions: `bench()` wires a `SlotRegistry` and a `LocaleRuntime` set to zh.
- Data flow: Drives `apply()` and asserts on the registered section and the injected tab projection.
- Non-obvious design decisions: The spec asserts the tab projection is **ordered by the contribution's `order`**, not by registration order ("Tabs follow their contribution's order, whatever order they registered in"), and that `getSnapshot()` returns the *same array instance* when nothing moved (`expect(...).toBe(initialTabs)`).
- Edge cases / failure handling: Covers registration into a declaration that arrives after apply, and teardown collapsing the section.
- Surprising: The label is asserted as the Chinese string, proving the locale thunk resolves at read time.

#### tests/section.client.spec.tsx
- Purpose: The section spec.
- Key abstractions: `renderSection(rows)` builds the props directly.
- Data flow: Renders `PluginsSettingsSection` with a stub `renderSlot` that renders the `only` id.
- Non-obvious design decisions: The spec asserts a second tab's panel is `hidden` rather than unmounted after the first is visited ("mounts another only after selection").
- Edge cases / failure handling: Covers the empty line, the heading and intro, and the full keyboard sequence including wrap-around and Escape (which changes nothing).
- Surprising: The spec pins `tabindex` 0/-1 — the roving-tabindex contract.

#### tsconfig.json
- Purpose: Client tsconfig with seven workspace references.
- Key abstractions: None.
- Data flow: None.
- Non-obvious design decisions: References `../../test-support/client-runtime` because the spec imports from it.
- Edge cases / failure handling: None.
- Surprising: Nothing.

#### tsdown.config.ts
- Purpose: Three-line tsdown config.
- Key abstractions: None.
- Data flow: None.
- Non-obvious design decisions: None.
- Edge cases / failure handling: None.
- Surprising: Nothing.

### packages/client/ui-settings-session-log

#### locale/en.json
- Purpose: Package metadata stub — title only.
- Key abstractions: None.
- Data flow: Manifest tooling.
- Non-obvious design decisions: None.
- Edge cases / failure handling: None.
- Surprising: Nothing.

#### locale/zh.json
- Purpose: Chinese package metadata with a description.
- Key abstractions: None.
- Data flow: Manifest tooling.
- Non-obvious design decisions: None.
- Edge cases / failure handling: None.
- Surprising: Nothing.

#### package.json
- Purpose: Publishable manifest for the session-log upload companion.
- Key abstractions: `dsh.client.inject` pulls locale, ui-settings and ui-layout.
- Data flow: The loader ensures those peers are present.
- Non-obvious design decisions: `ui-layout` is pulled for the `shell.overlay` slot the toast registers into.
- Edge cases / failure handling: None.
- Surprising: Nothing.

#### README.i18n.yaml
- Purpose: Per-heading hash record for the README pair.
- Key abstractions: Same as the siblings.
- Data flow: Regenerated by `verify-translation-pairing`.
- Non-obvious design decisions: None.
- Edge cases / failure handling: None.
- Surprising: Nothing.

#### README.md
- Purpose: The spec of the upload-preference companion.
- Key abstractions: Documents the `settings.general.item` row and the `shell.overlay` toast.
- Data flow: The switch edits the Host plugin's `enabled` field through the shared configuration form.
- Non-obvious design decisions: "The shared form owns persistence and reconnect synchronization; the companion owns only pending-write state and localized notices." A save failure "keeps the accepted value and shows a toast that survives closing Settings".
- Edge cases / failure handling: The row is unavailable when the Host does not expose the `session-log-deepseek` namespace.
- Surprising: "A save failure keeps the accepted value" — the UI never rolls back to what the user asked for; it reports the failure and leaves the Host's accepted value visible.

#### README.zh.md
- Purpose: Chinese mirror of the session-log spec.
- Key abstractions: Same.
- Data flow: Same.
- Non-obvious design decisions: Same.
- Edge cases / failure handling: Same.
- Surprising: Nothing.

#### src/client/index.ts
- Purpose: The browser apply for the preference.
- Key abstractions: `inject = ['slots','locale','configForms']`; `namespace = 'session-log-deepseek'`.
- Data flow: `ctx.configForms.whileServed([namespace], …)` registers the `settings.general.item` row; a separate unconditional `ctx.slots.inject('shell.overlay', …)` registers the toast.
- Non-obvious design decisions: The toast is registered **unconditionally** while the row is conditional — "a toast that survives closing Settings" must be able to appear even after the row's namespace disappears. Both entries share one `face`, so the toast and the row read the same mutation store.
- Edge cases / failure handling: The row's `order: 90` places it last in General.
- Surprising: The locale namespace is `'settings.sessionLog'` while the settings namespace is `'session-log-deepseek'` — two different names for two different things.

#### src/client/locales.ts
- Purpose: A four-key dictionary: `title`, `description`, `saved`, `failed`.
- Key abstractions: `zh` is typed `Record<keyof typeof en, string>`.
- Data flow: Registered as `ctx.locale.register(locale, { en, zh })`.
- Non-obvious design decisions: The `notice` key doubles as the toast copy: `t(state.notice)` picks `saved` or `failed` from the same dictionary.
- Edge cases / failure handling: None.
- Surprising: Nothing.

#### src/client/upload-preference.ts
- Purpose: The ordered preference write and its outcome notice.
- Key abstractions: `UploadSettings` (`enabled`); `UploadMutation` (`busy`, `notice`, `sequence`).
- Data flow: `setEnabled(enabled)` → `this.form.set('enabled', enabled)` → the mutation store.
- Non-obvious design decisions: "Writes the Host setting **without publishing an optimistic upload state**" — the switch reads the *accepted* Host value, never the user's pending intent. The `busy` guard makes a second click a no-op while a write is in flight. The `sequence` counter increments on every settlement.
- Edge cases / failure handling: A **thrown** error from the form is swallowed ("The shell notice reports the failed write while the form retains accepted state") and becomes `notice: 'failed'`; a `false` return is the same.
- Surprising: `dismiss()` only clears the notice — it does not touch the accepted value or the busy flag.

#### src/client/UploadRow.module.css
- Purpose: Three rules for the preference row.
- Key abstractions: `.row` (space-between with a bottom border), `.title`, `.description`.
- Data flow: None.
- Non-obvious design decisions: The description uses the secondary label tone at 12px so the switch reads as the primary control.
- Edge cases / failure handling: None.
- Surprising: Nothing.

#### src/client/UploadRow.tsx
- Purpose: The General-settings row and the persistent shell toast.
- Key abstractions: `UploadInjected` (`hooks.upload`, `hooks.mutation`, `setEnabled`, `dismiss`).
- Data flow: `useUpload` reads the accepted value; `useMutation` reads the write outcome; `setEnabled` writes through the preference.
- Non-obvious design decisions: The switch's `checked` is `upload.value?.enabled === true` — the **accepted** value, and `disabled` covers `busy || upload.status !== 'ready' || !upload.writable`. The toast is keyed by `state.sequence`, so a second save re-triggers the animation even though the notice text is identical.
- Edge cases / failure handling: The toast returns `null` when `notice === null`; `onDone={dismiss}` clears it when the toast's own timer expires.
- Surprising: The toast is a `shell.overlay` entry, not part of the settings panel — that is the whole point of the design.

#### src/css-modules.d.ts
- Purpose: Ambient CSS module declaration (four lines).
- Key abstractions: None.
- Data flow: None.
- Non-obvious design decisions: None.
- Edge cases / failure handling: None.
- Surprising: Nothing.

#### src/index.ts
- Purpose: The Host half — an empty `apply()`.
- Key abstractions: None.
- Data flow: None.
- Non-obvious design decisions: "Mount the browser entry through the Loader."
- Edge cases / failure handling: None.
- Surprising: Nothing.

#### tests/apply.client.spec.ts
- Purpose: The registration spec.
- Key abstractions: A scripted `settings.describe` that answers with and without the namespace.
- Data flow: Drives `apply()` and emits a `settings/document-updated` event to move the served set.
- Non-obvious design decisions: The spec asserts the row appears **only** while the namespace is served, and that the toast and the row share the same mutation store (`expect(toast.hooks.mutation).toBe(face.hooks.mutation)`).
- Edge cases / failure handling: A refused `form.set` yields `notice: 'failed'`; `dismiss()` clears it; removing the namespace removes the row.
- Surprising: The spec asserts the toast entry survives the namespace's removal — the toast is registered unconditionally.

#### tests/expected/upload-row.zh.txt
- Purpose: A one-line file snapshot of the Chinese row text.
- Key abstractions: None.
- Data flow: `await expect(container.textContent + '\n').toMatchFileSnapshot('./expected/upload-row.zh.txt')`.
- Non-obvious design decisions: The expected string has **no separator** between the title and the description ("在使用官方模型 API 时上传 Session Log帮助改进 DeepSeek 模型与产品") — the two divs are adjacent in the DOM.
- Edge cases / failure handling: The trailing `\n` is added so the file ends with a newline.
- Surprising: A file snapshot rather than a string assertion: the Chinese wording of the consent prompt is a byte-exact contract.

#### tests/upload.client.spec.tsx
- Purpose: The switch spec.
- Key abstractions: `fixture(writable)` builds a `ConfigForm` over a `SnapshotStore` and a real `UploadPreference`.
- Data flow: Renders `UploadRow` and `UploadToast` over the same props.
- Non-obvious design decisions: "shows a saved preference and keeps its notice after the row unmounts" — the row is unmounted and the toast still shows.
- Edge cases / failure handling: Both a refused write (`false`) and a rejected write (a thrown error) keep the switch at the accepted value and show `failed`. The switch is disabled while a write is pending.
- Surprising: The read-only case still shows `aria-checked="true"` — the accepted value is displayed even when it cannot be changed.

#### tsconfig.json
- Purpose: Client tsconfig with nine workspace references.
- Key abstractions: None.
- Data flow: None.
- Non-obvious design decisions: References `../ui-layout` because the toast registers into its `shell.overlay` slot.
- Edge cases / failure handling: None.
- Surprising: Nothing.

#### tsdown.config.ts
- Purpose: Three-line tsdown config.
- Key abstractions: None.
- Data flow: None.
- Non-obvious design decisions: None.
- Edge cases / failure handling: None.
- Surprising: Nothing.

### packages/client/ui-settings-shell

#### locale/en.json
- Purpose: Package metadata stub — title only.
- Key abstractions: None.
- Data flow: Manifest tooling.
- Non-obvious design decisions: None.
- Edge cases / failure handling: None.
- Surprising: Nothing.

#### locale/zh.json
- Purpose: Chinese package metadata with a description of the timeout and output cap.
- Key abstractions: None.
- Data flow: Manifest tooling.
- Non-obvious design decisions: None.
- Edge cases / failure handling: None.
- Surprising: Nothing.

#### package.json
- Purpose: Publishable manifest for the shell executor's settings page.
- Key abstractions: `dsh.client.inject` pulls locale, ui-settings and ui-plugin-manager.
- Data flow: The loader ensures those peers are present.
- Non-obvious design decisions: The page registers into the **Plugins page** (`plugins.item`), not into Settings — a plugin's own configuration page lives in the plugin manager, not in the settings shell.
- Edge cases / failure handling: None.
- Surprising: Nothing.

#### README.i18n.yaml
- Purpose: Per-heading hash record for the README pair.
- Key abstractions: Same as the siblings.
- Data flow: Regenerated by `verify-translation-pairing`.
- Non-obvious design decisions: None.
- Edge cases / failure handling: None.
- Surprising: Nothing.

#### README.md
- Purpose: The spec of the shell page.
- Key abstractions: Documents the two fields and the staged-write model.
- Data flow: The page binds the composed shell executor entry through `ctx.configForms.get` and writes through `SettingsFormModel`.
- Non-obvious design decisions: "Both render the effective value — the user's override over the composed default — and a field the user overrode carries an **Overridden** badge with **Reset to default** beside it. Nothing is written until **Save**; leaving the page drops the drafts, an empty field saves as a reset, and text that is not a number blocks the save and says so under the field."
- Edge cases / failure handling: "The page follows the composed executor" — the POSIX and PowerShell families share the `shell` namespace, so the served schema differs by platform while the page edits the same two fields.
- Surprising: "Output beyond this spills to a temporary file rather than being lost" — the cap is a spill, not a truncation, and the copy says so.

#### README.zh.md
- Purpose: Chinese mirror of the shell page spec.
- Key abstractions: Same.
- Data flow: Same.
- Non-obvious design decisions: Same.
- Edge cases / failure handling: Same.
- Surprising: Nothing.

#### src/client/index.ts
- Purpose: The browser apply — binds the executor entry and registers the page.
- Key abstractions: `BASH_NS = 'bash-sandbox'`; `PWSH_NS = 'pwsh-sandbox'`; `inject = ['slots','locale','configForms']`.
- Data flow: `ctx.configForms.whileServed([BASH_NS, PWSH_NS], served => ctx.slots.inject('plugins.item', …))`; the injected face is `(served.has(PWSH_NS) ? pwsh : bash).inject()`.
- Non-obvious design decisions: "The base bundle composes exactly one shell executor per platform; the page binds the served one." Both controllers are constructed unconditionally and disposed by an effect, so switching executors does not re-create the subscriptions.
- Edge cases / failure handling: The page's registration is withdrawn when the Host stops serving either namespace.
- Surprising: Two controllers are always live even though only one is ever shown — the *face* decides which one is injected, not the registration.

#### src/client/locales.ts
- Purpose: The en/zh dictionary plus `formLabels()`.
- Key abstractions: `ShellSettingsLocaleKey` is a hand-written union of 15 keys; `formLabels(t)` projects five of them into `SettingsFormLabels`.
- Data flow: `formLabels(t)` feeds the shared `SettingsForm` frame.
- Non-obvious design decisions: The frame's copy (unavailable / readOnly / saveFailed / save / saving) is *projected* from the page's own dictionary rather than hardcoded in the shared primitive — so every plugin page localises the frame for free.
- Edge cases / failure handling: None.
- Surprising: The `saveFailed` copy says "The deployment did not accept these values; **they were left for you to correct**" — the error message promises the draft survives.

#### src/client/shell-card-controller.ts
- Purpose: The staged form over one shell executor's configuration scope.
- Key abstractions: `ShellSettings` (`timeoutMs?`, `maxOutputBytes?`); `ShellCardState extends SettingsFormShell`; `ShellCardFace`.
- Data flow: `new SettingsFormModel(scope, [settingsNumberField('timeoutMs'), settingsNumberField('maxOutputBytes')])`; `this.form.bind(() => this.projection())` publishes the snapshot.
- Non-obvious design decisions: "The shell fields this page edits — a subset of the served schema by design." The two fields are edited as **numbers** with the shared numeric field spec, so a non-numeric draft is refused by the shared model rather than by this page.
- Edge cases / failure handling: `dispose()` releases the form subscription; the effect that owns both controllers disposes them with the fiber.
- Surprising: `timeoutMs` and `maxOutputBytes` are optional in `ShellSettings` — the page edits a *subset*, and the adapter's own defaults fill the rest.

#### src/client/ShellCard.tsx
- Purpose: The shell page's rendering.
- Key abstractions: `ShellCardProps`; two `SettingsValueField`s.
- Data flow: `props.useShellCard(snapshot => snapshot)`; edits go through `props.edit(field, text)` and resets through `props.resetField(field)`.
- Non-obvious design decisions: The summary view returns the one-liner **and nothing else** — "renders its one-liner alone in the summary view". The page renders no title of its own; the Plugins page owns the heading. The field ids are stable (`plugin-config-shell-timeout`, `plugin-config-shell-output`) so they can be addressed by tests and by automation.
- Edge cases / failure handling: `disabled = !state.writable`; the `SettingsForm` frame renders the unavailable / read-only lines instead of the fields when the namespace is not served.
- Surprising: The card renders the two fields "at once on its page" — there is no disclosure for the advanced ones.

#### src/css-modules.d.ts
- Purpose: Ambient CSS module declaration (four lines).
- Key abstractions: None.
- Data flow: None.
- Non-obvious design decisions: None.
- Edge cases / failure handling: None.
- Surprising: Nothing.

#### src/index.ts
- Purpose: The Host half — an empty `apply()`.
- Key abstractions: None.
- Data flow: None.
- Non-obvious design decisions: "The `shell` namespace the page edits is registered by the shell executor, so this package registers no namespace of its own."
- Edge cases / failure handling: None.
- Surprising: Nothing.

#### tests/apply.client.spec.ts
- Purpose: The registration spec.
- Key abstractions: `bench(served?)` answers with a list of served namespaces or a failed read.
- Data flow: Drives `apply()` and emits `settings/document-updated` to move the served set.
- Non-obvious design decisions: The spec asserts the page appears **and disappears** as the Host's served set changes — a deployment composing no executor shows nothing.
- Edge cases / failure handling: Covers a failed settings read (nothing registered), the PowerShell entry, a late declaration and teardown.
- Surprising: The spec asserts the face's hooks are exactly `['shellCard']` — the page's injectable surface is one store.

#### tests/card.client.spec.tsx
- Purpose: The card spec.
- Key abstractions: `renderCard(state, view)` builds a `ShellCardState` store and four action mocks.
- Data flow: Renders `ShellCard` over a fake snapshot.
- Non-obvious design decisions: "keeps the save inert until something is staged, offers no discard" — the card exposes exactly **one** button when clean.
- Edge cases / failure handling: Covers the summary view, the unavailable line, the read-only line, an invalid draft, a save in flight and a refused save.
- Surprising: "drops the staged edits when it leaves the page" — the spec asserts `discard` is called on unmount, i.e. the draft's lifetime is the page's.

#### tests/controller.client.spec.ts
- Purpose: The controller spec.
- Key abstractions: `acceptWrites(host)` teaches the stub config form to behave like an accepting Host.
- Data flow: Drives `ShellCardController` over three stub scopes.
- Non-obvious design decisions: The spec asserts the two fields save in **one** write pass — a single `mutate` with two `set` ops — rather than two separate writes.
- Edge cases / failure handling: A reset stages an `unset` and the composed default comes back; `discard()` writes nothing.
- Surprising: `acceptWrites` is duplicated verbatim in three packages' specs (shell, subagent, web-search) — the same 20-line Host simulator, copied three times.

#### tsconfig.json
- Purpose: Client tsconfig with nine workspace references.
- Key abstractions: None.
- Data flow: None.
- Non-obvious design decisions: References `../ui-plugin-manager/tsconfig.client.json` for the `plugins.item` slot.
- Edge cases / failure handling: None.
- Surprising: Nothing.

#### tsdown.config.ts
- Purpose: Three-line tsdown config.
- Key abstractions: None.
- Data flow: None.
- Non-obvious design decisions: None.
- Edge cases / failure handling: None.
- Surprising: Nothing.

### packages/client/ui-settings-subagent

#### locale/en.json
- Purpose: Package metadata stub — title only.
- Key abstractions: None.
- Data flow: Manifest tooling.
- Non-obvious design decisions: None.
- Edge cases / failure handling: None.
- Surprising: Nothing.

#### locale/zh.json
- Purpose: Chinese package metadata describing delegation depth, concurrency and selectable models.
- Key abstractions: None.
- Data flow: Manifest tooling.
- Non-obvious design decisions: None.
- Edge cases / failure handling: None.
- Surprising: Nothing.

#### package.json
- Purpose: Publishable manifest for the Subagent settings page.
- Key abstractions: `dsh.client.inject` pulls locale, ui-settings, ui-plugin-manager and api-remotes.
- Data flow: The loader ensures those peers are present.
- Non-obvious design decisions: `api-remotes` is pulled for the model catalog read.
- Edge cases / failure handling: None.
- Surprising: The description enumerates the three things the page edits, which is also the three things a reader wants to know.

#### README.i18n.yaml
- Purpose: Per-heading hash record for the README pair.
- Key abstractions: Same as the siblings.
- Data flow: Regenerated by `verify-translation-pairing`.
- Non-obvious design decisions: None.
- Edge cases / failure handling: None.
- Surprising: Nothing.

#### README.md
- Purpose: The spec of the Subagent page.
- Key abstractions: Documents the two namespaces, the one save and the conflict rule.
- Data flow: The browser half binds each namespace through `ctx.configForms.get` and joins the stored routes with `remote.session.modelCatalog()`.
- Non-obvious design decisions: "One **Save** writes both sections through their own namespaces, each fenced by the revision its draft read. The writes are independent: a section the Host refuses keeps its draft with the failure reported while the other lands, and a model draft a newer Host revision superseded is reported as a conflict to discard rather than overwriting the newer routes."
- Edge cases / failure handling: "Routes the Host stored but no adapter advertises stay listed under **Saved but currently unavailable** and remain removable; a provider that failed to load is reported without hiding the others."
- Surprising: The limitation is stated honestly: "The catalogue re-reads on three signals only — adapter changes, document commits, and reconnects."

#### README.zh.md
- Purpose: Chinese mirror of the Subagent page spec.
- Key abstractions: Same.
- Data flow: Same.
- Non-obvious design decisions: Same.
- Edge cases / failure handling: Same.
- Surprising: Nothing.

#### src/client/index.ts
- Purpose: The browser apply for the Subagent page.
- Key abstractions: `SUBAGENT_NS = 'subagent'`; `inject = ['slots','locale','remote','remote.session','configForms']`.
- Data flow: `ctx.remote.$on('llm/adapters-updated' | 'settings/document-updated')` → `models.refreshCatalog()`; `ctx.on('connection/reset')` → `models.resetConnection()`; `ctx.configForms.whileServed([SUBAGENT_NS, SUBAGENT_MODEL_SELECTION_NS], …)` → the `plugins.item` registration.
- Non-obvious design decisions: "Namespace of the delegation limits. Spelled here rather than imported: **a client package must not depend on a Host package**." The model catalogue is not part of any settings section, so the page refreshes it on invalidations rather than reading it once.
- Edge cases / failure handling: The page exists while the Host serves **either** namespace, and shows only the sections it serves.
- Surprising: Three separate `ctx.effect`s for the three invalidation signals, each with a name — the effect names are a debugging surface.

#### src/client/locales.ts
- Purpose: A 36-key en/zh dictionary plus `formLabels()`.
- Key abstractions: `SubagentSettingsLocaleKey` is a hand-written union.
- Data flow: Registered and bound as `t`.
- Non-obvious design decisions: The capacity help states the counting rule exactly: "Total live Subagents under the same main Agent, across all recursion levels. **The main Agent is excluded.** New start requests are rejected when the limit is reached." The depth help is a **table** of 0 and 1 with their meanings.
- Edge cases / failure handling: The depth help also states the precedence rule: "If a tool defines its own maximum recursion depth, that setting takes precedence."
- Surprising: The model-selection copy says the switch "Applies only to new sessions" and that disabling "keeps the selected routes for later" — the setting is about *composition*, not about a live session.

#### src/client/subagent-card-controller.ts
- Purpose: Composes the two section controllers into one card face.
- Key abstractions: `SubagentCardFace`; `subagentCardShell(limits, models)`; `subagentCardFace(limits, models)`.
- Data flow: `save()` reads both snapshots, computes the shared shell state, and calls `models.save()` / `limits.save()` only for the dirty ones.
- Non-obvious design decisions: The shared shell state is `available` if *any* section is available, `writable` only if **every** available section is writable, `dirty` if **any** is dirty, and `invalid` if any is invalid **or** the model draft is dirty and conflicted. The save guard is a single conjunction: "if (!state.available || !state.writable || !state.dirty || state.invalid || state.saving) return".
- Edge cases / failure handling: `discard()` is refused while either section is saving, so a pending write's draft is not thrown away mid-flight.
- Surprising: The two namespaces are genuinely independent — a rejected model draft survives while the limits land, and the retry writes only the model draft.

#### src/client/subagent-limits-card-controller.ts
- Purpose: Stages the two delegation limits.
- Key abstractions: `SubagentLimitsSettings` (`maxDepth`, `maxActiveSubagents`); `limitField(field, minimum)`.
- Data flow: `new SettingsFormModel(scope, [limitField('maxDepth', 0), limitField('maxActiveSubagents', 1)])`.
- Non-obvious design decisions: `limitField` wraps the shared numeric spec and adds a **floor**: `Number.isSafeInteger(value) && value >= minimum && !Object.is(value, -0)`. The `-0` rejection is explicit because `-0` is a safe integer that is `>= 0` but is a different value from `0`.
- Edge cases / failure handling: `maxDepth` accepts 0 (disable subagents) while `maxActiveSubagents` requires 1 — each field has its own floor.
- Surprising: The floors are the *only* validation this page adds; everything else is the shared model.

#### src/client/subagent-model-selection-card-controller.ts
- Purpose: The staged editor for the subagent model allowlist.
- Key abstractions: `AllowedSubagentModel` (`provider`, `model`); `subagentModelKey(route)` = `provider\0model`; `subagentModelCandidates(groups, stored, selected)`; `SubagentModelSelectionCardController`.
- Data flow: The catalog comes from `ctx.remote.session.modelCatalog()`; the save is one `scope.mutate([{op:'set',path:['enabled']}, {op:'set',path:['allowedModels']}], draftRevision)`.
- Non-obvious design decisions: The route key is `provider\0model` — an opaque lookup key that "callers resolve by lookup and never parse". The catalog join keeps stored-but-unadvertised routes as `available: false` candidates so they remain **removable**. The conflict rule distinguishes two cases: if the newer Host revision *already contains* the draft, the draft is settled (`clearDraft()`); otherwise `conflicted = true` and the save is refused.
- Edge cases / failure handling: Two generation counters (`saveGeneration`, `catalogGeneration`) suppress late settlements after a dispose or a refresh. `resetConnection()` drops the draft and the catalog — "Drop Host-specific candidates and drafts, then reload after reconnecting". A save is judged by **what landed** (`landed = currentEnabled() === desiredEnabled && sameRoutes(...)`), not by the mutate's return.
- Surprising: `invalid` is `enabled && desired.length === 0` — enabling the permission with no route selected is invalid, so the switch cannot be saved empty.

#### src/client/SubagentCard.tsx
- Purpose: Renders both Subagent settings sections on one page inside one shared `SettingsForm`.
- Key abstractions: `SubagentCardProps` (`PropsRuntime<'plugins.item'>` + `PropsLocale<'settings.subagent'>` + `InjectFace<SubagentCardFace>`).
- Data flow: `props.useSubagentLimitsCard(snapshot => snapshot)` and `props.useSubagentModelSelectionCard(snapshot => snapshot)`; the shared shell state is recomputed by `subagentCardShell(limits, models)` on every render.
- Non-obvious design decisions: Each section renders **only when the Host serves it** (`limits.available` / `models.available`), so a deployment with one of the two namespaces shows one section and not an empty placeholder. Both sections are wrapped in `aria-labelledby` sections with `useId()`-derived heading ids, so a screen reader can name each region. The card carries no title of its own — the Plugins page owns the heading — and the summary view returns only the one-liner.
- Edge cases / failure handling: The `saving` flag of the *shared* shell is pushed down into each section's state (`{ ...limits, saving: state.saving }`), so a save in one section disables the other section's controls too — "locks both sections while either is saving".
- Surprising: The card renders both sections with the same `SettingsForm` and therefore the same single Save/Discard footer, even though the two sections are separate Host namespaces with separate revision fences.

#### src/client/SubagentCard.module.css
- Purpose: Two rules: the section padding and the sub-heading.
- Key abstractions: None.
- Data flow: None.
- Non-obvious design decisions: The heading is 13px/600 — a *sub*-heading inside the shared card, not a page heading.
- Edge cases / failure handling: None.
- Surprising: Nothing.

#### src/client/SubagentLimitsFields.tsx
- Purpose: The two limit fields and their inline rules.
- Key abstractions: `SubagentLimitsFieldsProps`.
- Data flow: `props.edit('maxDepth', text)` / `props.resetField('maxDepth')`.
- Non-obvious design decisions: The depth field's help is a **two-row table** (`0` → disable subagents, `1` → only the main agent can create subagents) rendered as JSX inside the shared field's `help` slot, with `scope="row"` headers and an `aria-label` naming the table.
- Edge cases / failure handling: `disabled={!state.writable || state.saving}`.
- Surprising: The rule disclosure lives in the field, not in a separate help page — "the information button beside each label discloses its rule".

#### src/client/SubagentLimitsFields.module.css
- Purpose: The auto-fit grid for the two fields plus the depth-rule table.
- Key abstractions: `.limits` (`repeat(auto-fit, minmax(min(220px, 100%), 1fr))`), `.limit`, `.depthTable`.
- Data flow: None.
- Non-obvious design decisions: `minmax(min(220px, 100%), 1fr)` — the two columns stack on narrow screens without a media query, and the `min()` keeps the track from overflowing a container narrower than 220px.
- Edge cases / failure handling: `font-variant-numeric: tabular-nums` on the inputs so a changing number does not jitter the field width.
- Surprising: The `min()` inside `minmax()` is the whole responsive story — no breakpoint.

#### src/client/SubagentModelSelectionFields.tsx
- Purpose: The permission switch and the exact-route choices.
- Key abstractions: `SubagentModelSelectionFieldsProps`.
- Data flow: `props.toggleEnabled()` / `props.toggleModel(candidate.key)` / `props.retryCatalog()`.
- Non-obvious design decisions: Candidates are grouped by provider at render time; unavailable ones are pulled into a **separate** group at the end rather than being hidden. The route line shows both the display names and the raw `provider/model` route, so the user can see what will actually be sent.
- Edge cases / failure handling: A partial catalog failure is reported as a notice, not an error, and the other providers stay usable. `state.conflicted` renders a `role="status"` conflict line, distinct from `state.invalid`'s validation line.
- Surprising: The switch's `onChange` is `props.toggleEnabled` directly (a toggle action, not a value), so the control's state is derived from the draft rather than from the event.

#### src/client/SubagentModelSelectionFields.module.css
- Purpose: Styling for the switch row, the scrollable fieldset and the provider groups.
- Key abstractions: `.models` (`max-height: 280px; overflow: auto`), `.modelGroup`, `.model`.
- Data flow: None.
- Non-obvious design decisions: The model list is a **fieldset with a legend** and a bounded scroll height, so a long catalog does not push the page.
- Edge cases / failure handling: `.modelName` and `.route` both ellipsize on one line.
- Surprising: `.catalogError button` uses `--dsw-alias-brand-primary` while the surrounding text uses the error tone — the retry affordance is a brand-coloured text button.

#### src/css-modules.d.ts
- Purpose: Ambient CSS module declaration (four lines).
- Key abstractions: None.
- Data flow: None.
- Non-obvious design decisions: None.
- Edge cases / failure handling: None.
- Surprising: Nothing.

#### src/index.ts
- Purpose: The Host half — an empty `apply()`.
- Key abstractions: None.
- Data flow: None.
- Non-obvious design decisions: "The `subagent` and `subagent-model-selection` namespaces the page edits are registered by the delegation plugins, so this package registers no namespace of its own."
- Edge cases / failure handling: None.
- Surprising: Nothing.

#### tests/apply.client.spec.ts
- Purpose: The registration spec.
- Key abstractions: `bench(served?)`; a `models` mock for `session.modelCatalog`.
- Data flow: Drives `apply()` and emits the three invalidation signals.
- Non-obvious design decisions: The spec spies on `SubagentModelSelectionCardController.prototype.refreshCatalog` / `.resetConnection` to assert **which signal** reaches the controller — adapter change → refresh, document commit → refresh, connection reset → reset.
- Edge cases / failure handling: Covers the page existing while only the model namespace is served, and the page not existing when neither is.
- Surprising: The spec asserts the injected hooks are exactly `['subagentLimitsCard','subagentModelSelectionCard']` — sorted.

#### tests/card.client.spec.tsx
- Purpose: The card spec.
- Key abstractions: `renderSubagent(limitState, modelState, view)` builds two stores and eight action mocks.
- Data flow: Renders `SubagentCard` over two independent snapshots.
- Non-obvious design decisions: The spec asserts the two sections share **one** Save button ("shows both sections on one page with one save footer") and that the rules disclosure does not change staged values ("reveals field rules on demand without changing staged values").
- Edge cases / failure handling: Covers a conflict blocking the save, a rejected section keeping the other open, and both sections locked while either saves.
- Surprising: "keeps validation visible when the rules are collapsed and links it to the input" — the validation message stays reachable through `aria-describedby` even when the help region is folded.

#### tests/controllers.client.spec.ts
- Purpose: The 626-line controller spec.
- Key abstractions: `acceptWrites(host)`; `modelsApi(options)`; `deferred<T>()`.
- Data flow: Drives both controllers over stub scopes and a scripted catalog.
- Non-obvious design decisions: "suppresses duplicate actions and late save settlements" — the spec calls `save()` five times and asserts `mutate` was called **once**.
- Edge cases / failure handling: Covers the catalog join with unavailable routes, the atomic mutate, a rejected write, a directory error and retry, the two conflict outcomes (refused vs settled), unsaved routes surviving a catalog refresh, a connection reset dropping the draft, read-only scope, and post-dispose suppression.
- Surprising: "retains a rejected model draft after limits save, and retries only that draft" — the two namespaces' failures are genuinely independent.

#### tsconfig.json
- Purpose: Client tsconfig with nine workspace references.
- Key abstractions: None.
- Data flow: None.
- Non-obvious design decisions: None.
- Edge cases / failure handling: None.
- Surprising: Nothing.

#### tsdown.config.ts
- Purpose: Three-line tsdown config.
- Key abstractions: None.
- Data flow: None.
- Non-obvious design decisions: None.
- Edge cases / failure handling: None.
- Surprising: Nothing.

### packages/client/ui-settings-web-search

#### locale/en.json
- Purpose: Package metadata stub — title only.
- Key abstractions: None.
- Data flow: Manifest tooling.
- Non-obvious design decisions: None.
- Edge cases / failure handling: None.
- Surprising: Nothing.

#### locale/zh.json
- Purpose: Chinese package metadata describing the key, endpoint and request budget.
- Key abstractions: None.
- Data flow: Manifest tooling.
- Non-obvious design decisions: None.
- Edge cases / failure handling: None.
- Surprising: Nothing.

#### package.json
- Purpose: Publishable manifest for the web-search provider's settings page.
- Key abstractions: `dsh.client.inject` pulls locale, ui-settings, ui-plugin-manager and api-remotes.
- Data flow: The loader ensures those peers are present.
- Non-obvious design decisions: `api-remotes` is pulled for the credentials read/write.
- Edge cases / failure handling: None.
- Surprising: Nothing.

#### README.i18n.yaml
- Purpose: Per-heading hash record for the README pair.
- Key abstractions: Same as the siblings.
- Data flow: Regenerated by `verify-translation-pairing`.
- Non-obvious design decisions: None.
- Edge cases / failure handling: None.
- Surprising: Nothing.

#### README.md
- Purpose: The spec of the web-search page.
- Key abstractions: Documents the three namespaces, the switch and the credential rule.
- Data flow: The key is written through `remote.credentials.set` under the reference the selected section's `apiKeyEnv` names; success is read back from `remote.credentials.describe`.
- Non-obvious design decisions: "**API key** starts blank on every load and reports only whether a key is configured; without one, it says that only conversations using a DeepSeek Account model can search, through the default endpoint, because those searches authenticate with the account sign-in." The switch "is disabled while an invalid edit or a failed save is staged, so a field it would hide stays visible."
- Edge cases / failure handling: "One save writes the provider settings before the selection, so a refused section leaves the switch unsaved." The control is disabled "when the credential cannot be written from here, such as a key the process environment supplies" — the credential's writability is independent of the settings document's.
- Surprising: "Three fields of the namespace — the provider's model, API version, and token budget stay at their composed values" — the page deliberately edits a subset.

#### README.zh.md
- Purpose: Chinese mirror of the web-search page spec.
- Key abstractions: Same.
- Data flow: Same.
- Non-obvious design decisions: Same.
- Edge cases / failure handling: Same.
- Surprising: Nothing.

#### src/client/index.ts
- Purpose: The browser apply for the web-search page.
- Key abstractions: `WEB_SEARCH_NS = 'web-search-deepseek'`; `WEB_API_NS = 'web-deepseek-api'`; `WEB_NS = 'web'`; `inject = ['slots','locale','remote','remote.credentials','configForms']`.
- Data flow: `ctx.configForms.whileServed([WEB_SEARCH_NS], …)` registers the `plugins.item` entry; `ctx.remote.$on('credentials/reference-updated', ref => card.refreshCredential(ref))` re-reads the key.
- Non-obvious design decisions: "The credential the page reports is not part of any settings section, so no scope publishes when one is written. **This is the only signal** that a key written on another surface reached the Host." The page's *existence* depends on `web-search-deepseek` alone, while the *switch* appears only while `web` and `web-deepseek-api` are also served.
- Edge cases / failure handling: The credential event handler is filtered to the watched reference inside the controller, not at the subscription.
- Surprising: The three namespaces are bound unconditionally at apply time — the page reads them even when the Host serves none.

#### src/client/locales.ts
- Purpose: The en/zh dictionary plus `formLabels()`.
- Key abstractions: `WebSearchSettingsLocaleKey` is a hand-written union of 28 keys.
- Data flow: Registered and bound as `t`.
- Non-obvious design decisions: There are **two** endpoint labels and **two** endpoint hints (Messages vs Search/Fetch), so the protocol is named by the field's own label rather than by a mode indicator. The count hint disambiguates two similarly-named concepts: "Results returned per query … **This controls result count, not search calls.** web_search keeps no more sources than its own result limit."
- Edge cases / failure handling: `invalidCount` names the range ("an integer from 1 to 50, or leave blank to use the default").
- Surprising: The `apiKeyUnset` copy explains a consequence the user would otherwise have to guess: with no key, only DeepSeek-Account conversations can search.

#### src/client/web-search-card-controller.ts
- Purpose: The staged form over three settings namespaces plus the credentials domain.
- Key abstractions: `PROVIDERS` (`searchProvider`/`fetchProvider` × `api`/`messages`); `DEFAULT_API_KEY_REF = 'DEEPSEEK_API_KEY'`; `CredentialState` (`ref`, `configured`, `writable`); `WebSearchCardScopes`; `WebSearchCardController`.
- Data flow: Three `SettingsFormModel`s (selection / messages / api); the credential is read via `ctx.remote.credentials.describe([ref])` and written via `ctx.remote.credentials.set(ref, value)`.
- Non-obvious design decisions: The switch selects **both** providers together (`deepseek-search-api` + `deepseek-fetch-api`) or Messages search + local HTTP fetch. "A selection equal to the deployment's composed value clears the override instead of storing a copy of it" — a target equal to `base[field]` stages a **reset**, so the default keeps applying. The key is the one control that does not live in a section: its write goes to the credentials domain and success is judged by re-reading `describe`, because "the Host is the only authority on whether the key now exists".
- Edge cases / failure handling: A credential answer is stored **with the reference it describes**, and a response for a reference no longer in force is dropped — "a new reference knows nothing yet; keeping the old answer would claim the key is configured under a name nobody has checked". An unknown reference is treated as **writable**, so "the control stays usable and the Host is what refuses, rather than the page guessing a refusal". The save order is fixed: the provider sections first, "so a switch takes effect only after the endpoint it uses has landed"; a refused section stops the selection from saving and keeps every remaining draft.
- Surprising: The result-count field's parser accepts 1–50 and treats blank as a **clear** (which restores the default), and the key's staged value is a `SettingsFormModel` field like any other — so one Save covers everything the page shows.

#### src/client/WebSearchCard.module.css
- Purpose: Four rules for the switch block, its hint and the guide link.
- Key abstractions: `.feature`, `.toggleRow`, `.hint`, `.link`.
- Data flow: None.
- Non-obvious design decisions: The hint and the link are adjacent elements inside one `<p>` — the spec asserts `guide.parentElement.textContent` equals the hint plus the link label, i.e. they read as one sentence.
- Edge cases / failure handling: None.
- Surprising: The link uses `--dsw-alias-link`, a token that appears nowhere else in this shard.

#### src/client/WebSearchCard.tsx
- Purpose: The web-search page's rendering.
- Key abstractions: `WebSearchCardProps`; `limitField = searchApi ? 'count' : 'maxUses'`.
- Data flow: `props.useWebSearchCard(snapshot => snapshot)`; `props.setSearchApi(checked)`; `props.edit(field, text)`.
- Non-obvious design decisions: The secret field's `disabled` is **`state.apiKeyWritable` only** — "The credentials domain accepts a key even when the settings document itself is read-only; they are separate stores with separate refusals." The endpoint label and hint switch with the mode, but each mode keeps its own base URL because the two live in different namespaces.
- Edge cases / failure handling: The switch is `disabled` when `disabled || state.apiSwitchBlocked` — an invalid draft or a failed save keeps the field it would hide visible.
- Surprising: The endpoint field's `onReset` calls `props.resetField('baseURL')` with no field discrimination — the controller's `formOf()` routes it to the *selected* API's form.

#### src/css-modules.d.ts
- Purpose: Ambient CSS module declaration (four lines).
- Key abstractions: None.
- Data flow: None.
- Non-obvious design decisions: None.
- Edge cases / failure handling: None.
- Surprising: Nothing.

#### src/index.ts
- Purpose: The Host half — an empty `apply()`.
- Key abstractions: None.
- Data flow: None.
- Non-obvious design decisions: "The `web`, `web-search-deepseek`, and `web-deepseek-api` namespaces the page edits are registered by their plugins, so this package registers no namespace of its own."
- Edge cases / failure handling: None.
- Surprising: Nothing.

#### tests/apply.client.spec.ts
- Purpose: The registration spec.
- Key abstractions: `bench(served?)` with a scripted `credentials.describe` that fails by default.
- Data flow: Drives `apply()` and emits `credentials/reference-updated`.
- Non-obvious design decisions: The spec asserts the controller re-reads the credential for the **watched** reference only — `remote.emit('credentials/reference-updated', ['SOME_OTHER_KEY'])` produces no read, while `['DEEPSEEK_API_KEY']` produces exactly one.
- Edge cases / failure handling: Covers the page not existing when the namespace is unserved, and the page collapsing on teardown.
- Surprising: The comment states the reason the event exists at all: "A key written on another surface changes no settings section, so this event is the only thing that reaches the page."

#### tests/card.client.spec.tsx
- Purpose: The card spec.
- Key abstractions: `renderWebSearch(state)` builds the snapshot store and the six action mocks.
- Data flow: Renders `WebSearchCard` over a fake snapshot.
- Non-obvious design decisions: "reports whether a key is configured **without ever showing one**" — the input's type is asserted to be `password` and the configured state is a separate label.
- Edge cases / failure handling: The key control stays usable on a read-only settings document but is disabled when the *credential* is not writable — the two refusals are independent.
- Edge cases / failure handling (2): The switch is locked while an invalid draft, a failed save or a save in flight, and the field it would hide stays visible in all three cases.
- Surprising: The spec asserts the localized hint and link label concatenate into one sentence in Chinese too.

#### tests/controller.client.spec.ts
- Purpose: The 394-line controller spec.
- Key abstractions: `bench(options)` mounts three stub scopes; `serve(b, selection)` publishes the three served sections; `endpointRoundTrip()` is a shared edit/save/reset/save helper.
- Data flow: Drives the controller over stub scopes and a scripted credentials face.
- Non-obvious design decisions: The save ordering is asserted as a **sequence**: `expect(order).toEqual(['api','web'])` — the provider section lands before the selection that starts using it.
- Edge cases / failure handling: Covers the credential write never touching a settings scope, a blank draft keeping the stored key, an answer for a renamed reference being dropped, a refused read *and* write leaving the card usable, the switch as a reset against the composed value, and the switch blocked by an invalid draft.
- Surprising: "drops a credential answer for a reference that changed while it was pending" — the answer arrives for `DEEPSEEK_API_KEY` after the section renamed the reference to `RENAMED_KEY`, and it is discarded rather than applied.

#### tsconfig.json
- Purpose: Client tsconfig with nine workspace references.
- Key abstractions: None.
- Data flow: None.
- Non-obvious design decisions: None.
- Edge cases / failure handling: None.
- Surprising: Nothing.

#### tsdown.config.ts
- Purpose: Three-line tsdown config.
- Key abstractions: None.
- Data flow: None.
- Non-obvious design decisions: None.
- Edge cases / failure handling: None.
- Surprising: Nothing.

## Ideas worth stealing

- **Derive the offered option set from the schema the adapter actually ships, not from a hardcoded list** — `packages/client/ui-settings-models/src/client/store.ts:138` (`protocolChoices`) and `packages/client/ui-settings-models/src/client/store.ts:158` (`reasoningLevelChoices`). Both walk the namespace's own serialized schema through a probe path (`['providers', '\u0000probe', 'api']`) and read the union members / the dict's key schema. Why it transfers to August: the picker's choices and the adapter's accepted values come from one `Config`, so a new reasoning level or wire protocol appears in the UI the day the adapter adds it, and the UI can never offer a value the adapter will reject. The probe key is a NUL character specifically so it "cannot collide with a configured route".

- **A settings write is a set of path ops against the STORED section, never a section replace** — `packages/client/ui-settings-models/src/client/ProviderEditor.tsx:134` (`pathOps`) and `packages/client/ui-settings-web-search/src/client/web-search-card-controller.ts:279`. The card holds a *redacted descriptor*, not the section, so a wholesale replace "rebuilt from it could delete fields outside the card". Why it transfers: August's settings surface (brain keys, per-model capability profiles) has the same shape — the editor sees a projection, so the write must be expressed as the minimal set/unset set, or every unrelated field in the same namespace is silently deleted.

- **Two-stage commit with per-stage retry: commit the settings, adopt the returned revision, *then* write the secret** — `packages/client/ui-settings-models/src/client/ProviderEditor.tsx:301-311`. After the settings write the card adopts the returned redacted user subtree and revision before `storeCredential`, so "a failed credential stage retries only that stage". The create card's twin is the `committed` flag at `packages/client/ui-settings-models/src/client/CustomProviderCard.tsx:190`: without it, a retry after a failed key write re-runs the profile mutate with a superseded revision, the Host answers `settings-conflict`, and the key can never be stored from that card.

- **A credential write's success is judged by re-reading the credential domain, never by the write's return value** — `packages/client/ui-settings-web-search/src/client/web-search-card-controller.ts:324-330` (`writeKey`). "Refusals surface through the re-read below: the Host is the only authority on whether the key now exists." Why it transfers: a secret that crosses a transport boundary must be confirmed by an independent read; a 200 on the write is not a fact about the store.

- **Store a credential answer together with the reference it describes, and drop it when the reference moves** — `packages/client/ui-settings-web-search/src/client/web-search-card-controller.ts:226-247`. The comment is the lesson: "a new reference knows nothing yet; keeping the old answer would claim the key is configured under a name nobody has checked." Pinned by `packages/client/ui-settings-web-search/tests/controller.client.spec.ts:171`. Why it transfers: any UI that shows a secret's *state* (configured / missing / unknown) races a config change; tagging the answer with the identity it answers for makes the race harmless.

- **A secret written on another surface changes no settings section — so subscribe to the credential event, filtered to the reference you watch** — `packages/client/ui-settings-web-search/src/client/index.ts:60-63` and `packages/client/ui-settings-web-search/src/client/web-search-card-controller.ts:257` (`refreshCredential(ref)`). Why it transfers: August's brain/credential writes happen from several surfaces (the Models page writes the same `DEEPSEEK_API_KEY` the web-search page reads); without this the badge keeps reporting a state the Host already replaced.

- **An unknown reference is treated as WRITABLE so the Host refuses, not the page** — `packages/client/ui-settings-web-search/src/client/web-search-card-controller.ts:240-242`: "An unknown reference is treated as writable: the control stays usable and the Host is what refuses, rather than the page guessing a refusal." Why it transfers: a client that pre-judges writability produces a dead control the user cannot explain; a client that lets the write fail produces a diagnostic.

- **A selection equal to the deployment's composed value CLEARS the override instead of storing a copy of it** — `packages/client/ui-settings-web-search/src/client/web-search-card-controller.ts:292-300` (`select`). If the target equals `base[field]`, the field stages a **reset** rather than an `edit`. Why it transfers: storing a copy of the default pins the value forever; the reset keeps the deployment's default live. Same idea in the models package: `packages/client/ui-settings-models/src/client/ProviderEditor.tsx:344-347` reads the *base* layer (or the schema default) for "Restore defaults", never the effective value, "because the effective value still carries the stored override until the unset is applied".

- **Save the thing a switch starts using BEFORE the switch** — `packages/client/ui-settings-web-search/src/client/web-search-card-controller.ts:308-317`. The provider sections are saved first; a refused section stops the selection from saving and keeps every remaining draft for correction. Asserted as a sequence at `packages/client/ui-settings-web-search/tests/controller.client.spec.ts:321-335`. Why it transfers: a toggle that takes effect before the setting it depends on lands leaves the harness in a state no configuration describes.

- **"Latest load wins" as an explicit generation counter, with the callers settled only by the CURRENT refresh** — `packages/client/ui-settings-models/src/client/store.ts:192` (`generation`), `:218` (`load`), `:315` (`settleLoads`). An older response "can neither publish nor settle callers"; concurrent callers resolve only after the current refresh publishes its ready or error snapshot. Why it transfers: any store fed by a push channel plus a pull refresh hits this exact race; the counter plus a pending-set is a two-line solution to "the last request does not win".

- **An enrichment failure degrades a badge, not the page; a primary read failure keeps the last good rows** — `packages/client/ui-settings-models/src/client/store.ts:280-286` (credential describe → `credentialError`, page stays `ready`) versus `:238` (directory failure → `status: 'error'`, previous rows untouched). Why it transfers: August's settings page joins several domains (providers, settings, credentials, catalogs); the page must stay usable when one of them is down, and each domain's failure needs its own place.

- **The three states of a credential are DIFFERENT states, not two** — `packages/client/ui-settings-models/src/client/ProviderEditor.tsx:382-391`: detected (success tone), missing (warning tone), unconfirmed (tertiary tone). The comment says why: "Detection does not validate credentials, test a connection, or inspect provider-managed files such as AWS profiles and Google application-default credentials." Why it transfers: August's "key missing" badge is currently a two-state claim; the third state is the difference between "we checked and it is absent" and "we could not check", which is exactly what a user needs to see before they start editing environment files.

- **Endpoint configuration variables must not count as credentials** — `packages/client/ui-settings-models/src/client/ProviderEditor.tsx:374-376` filters `baseURLEnv` out of the auth refs, and `:377` filters any ref containing `oauth` from *display* only ("This presentation filter does not change the credential resolution order"). Pinned for Cloudflare and Vertex at `packages/client/ui-settings-models/tests/components.client.spec.tsx:2327-2342`. Why it transfers: August resolves credentials from env vars too; a variable like `AZURE_OPENAI_BASE_URL` or `GOOGLE_CLOUD_PROJECT` is configuration, not a secret, and conflating them produces a false "key missing".

- **A capability that varies per MODEL is offered per model, never per provider** — `packages/client/ui-settings-models/src/client/CustomProviderCard.tsx:20-26` and `packages/client/ui-settings-models/src/client/ProviderEditor.tsx:14-18`: "effort is a per-MODEL capability, and the models under one provider disagree about it, so a provider-scoped control can only be set to a value some of them reject." Why it transfers: this is exactly August's per-model capability profile (`toolSurface` full/reduced/bare, `maxTools`, `maxToolResultChars`) — the shard's reasoning is the argument for keeping it per-model, and for offering the composer's model picker the model's own levels.

- **Validate a model row with the adapter's own rules, and name the ROW** — `packages/client/ui-settings-models/src/client/ModelReasoningEfforts.tsx:77` (`validateReasoningEfforts`) and `packages/client/ui-settings-models/src/client/DeepSeekModelsEditor.tsx:93` (`validateDeepSeekModels`). Both return `{index, key}` so the card says "Model 2: Model ID must be unique" instead of failing at the write with a message naming a path. Why it transfers: a validation failure the user cannot locate is indistinguishable from a bug; row-index failures are locatable.

- **One editing buffer PER FIELD, keyed by row, re-keyed on row removal** — `packages/client/ui-settings-models/src/client/ModelListEditor.tsx:186` (the `editing` map), `:189` (`bufferKey`), `:201` (`reindexOnRemove`); mirrored in `packages/client/ui-settings-models/src/client/DeepSeekModelsEditor.tsx:162-196`. Why: "a single buffer would be displaced by editing any other field, and the abandoned one would render its stored NaN as the literal `NaN`" — the user loses the text they were told they could still correct. Why it transfers: any editor with per-row text fields and add/remove rows (August's tool list, the model list) needs this or it will silently corrupt a draft.

- **A capacity field is edited as text but stored as a count, and the *typed* spelling wins until blur** — `packages/client/ui-settings-models/src/client/DeepSeekModelsEditor.tsx:42` (`parseCapacity`) and `:63` (`formatCapacity`). `formatCapacity` never emits a spelling that would not survive a round trip (`1_500_000` → `'1500K'`, not `'1.5M'`), and `parseCapacity` snaps an integral intent back after the float multiply. Why it transfers: August shows context windows and token caps; letting the user type `256K` while the stored value is a plain integer, and never rewriting `1000` to `1K` mid-word, is the difference between a usable capacity field and an unusable one.

- **A card's own draft must never be rewritten by a background refresh, and the mode switch must LOCK while a write is in flight** — `packages/client/ui-settings-models/src/client/ModelsSection.tsx:393` (`switchLocked = catalogBusy || customBusy`) and `:259-263` (the per-panel busy flags). Why: "a switch underneath one would orphan the answer" — the interrogation's reply would land in a panel that is no longer visible. Pinned at `packages/client/ui-settings-models/tests/components.client.spec.tsx:1925-1956`. Why it transfers: any UI with two modes that each own an async operation needs this lock, and August's own "grouped activity line" work is the same class of bug (a result landing somewhere the user cannot see).

- **Both panels of a tabbed card stay MOUNTED (hidden) after first visit, so switching modes discards neither draft** — `packages/client/ui-settings-models/src/client/ModelsSection.tsx:392` (`mounted(candidate)`) and `:611`/`:666`; the same rule in `packages/client/ui-settings-plugins/src/client/PluginsSettingsSection.tsx:45-51`. Why it transfers: draft loss on a tab switch is the most common settings-page complaint, and "mount on first visit, then keep mounted" is the cheapest fix.

- **A lone contribution renders as the page itself, with no orphan tablist** — `packages/client/ui-settings-plugins/src/client/PluginsSettingsSection.tsx:40` (`single`) and `:57-58`; the same idea for the add card's single mode at `packages/client/ui-settings-models/src/client/ModelsSection.tsx:600-606`. Why it transfers: a one-tab UI that renders a tab row is noise; the rule "one tab is a page, two tabs are a tab list" costs four lines and removes a whole class of a11y questions.

- **A settings section is a SLOT contribution that exists only while the Host serves its namespace** — `packages/client/ui-settings-shell/src/client/index.ts:50` (`ctx.configForms.whileServed([BASH_NS, PWSH_NS], …)`), `packages/client/ui-settings-subagent/src/client/index.ts:85`, `packages/client/ui-settings-web-search/src/client/index.ts:64`. Why it transfers: August's Settings is a plugin host too; a page whose backing capability is not deployed should not appear at all, and `whileServed` gives that for free with a re-register on every namespace change.

- **The Host half of a UI package is an empty `apply()` whose only job is to hold a Loader row** — `packages/client/ui-settings-subagent/src/index.ts:11`, `packages/client/ui-settings-web-search/src/index.ts:11`, `packages/client/ui-settings-plugins/src/index.ts:11`. Why it transfers: it separates "this capability is deployed" (Host) from "this capability has a UI" (Client), so a headless deployment still registers the feature.

- **A tab label is a THUNK, and the tab projection is memoised on (ledger version, locale revision)** — `packages/client/ui-settings-plugins/src/client/index.ts:56` (`label: () => t('nav')`) and `:43-61` (the version+revision cache). Why it transfers: a resolved label string requires a re-registration on every language switch; a thunk plus a two-key cache makes i18n free.

- **A nav/section label follows the locale without re-registration, proven by a test that switches locale after apply** — `packages/client/ui-settings-models/tests/apply.client.spec.ts:167-178`. Why it transfers: the test is the artifact worth copying — it asserts the *behaviour* ("the label thunk follows the active locale without re-registration") rather than the implementation.

- **A namespace name is spelled in the client package, never imported from a Host package** — `packages/client/ui-settings-subagent/src/client/index.ts:47-50` and `packages/client/ui-settings-web-search/src/client/web-search-card-controller.ts:26-34`: "a client package must not depend on a Host package." Why it transfers: it keeps the client bundle free of Host code and makes the dependency direction enforceable by a lint rule; August should copy the rule before it copies the imports.

- **A delegated field spec adds only the floor** — `packages/client/ui-settings-subagent/src/client/subagent-limits-card-controller.ts:28-39` (`limitField`): `Number.isSafeInteger(value) && value >= minimum && !Object.is(value, -0)`. The `-0` rejection is explicit because `-0` is a safe integer that passes `>= 0` but is not `0`. Why it transfers: August's numeric brain keys (budget ceilings, timeouts) need exactly this guard, and `Object.is(value, -0)` is the check people forget.

- **A draft is revision-fenced, and a newer Host revision that ALREADY CONTAINS the draft settles it rather than reporting a conflict** — `packages/client/ui-settings-subagent/src/client/subagent-model-selection-card-controller.ts:153-162` and `:269-273`. Why it transfers: this is the difference between "someone did what you wanted" (settle) and "someone else changed something" (conflict → ask the user to discard). Conflating the two makes a cooperative colleague's action look like an attack.

- **A conflict is a distinct UI state from a rejected save** — `packages/client/ui-settings-subagent/src/client/subagent-card-controller.ts:39` (`invalid: ... || (models.available && models.dirty && models.conflicted)`) and `packages/client/ui-settings-subagent/src/client/SubagentModelSelectionFields.tsx:123-125` (a `role="status"` conflict line). Pinned at `packages/client/ui-settings-subagent/tests/card.client.spec.tsx:157-162` ("distinguishes a stale draft from a rejected save"). Why it transfers: a conflict asks the user to *discard*; a refusal asks them to *correct*. Merging them into one "save failed" loses the action.

- **Two namespaces, one Save, each write keeps its own revision fence, and a rejection in one does not roll back the other** — `packages/client/ui-settings-subagent/src/client/subagent-card-controller.ts:62-69`. Pinned at `packages/client/ui-settings-subagent/tests/controllers.client.spec.ts:612-625`. Why it transfers: August's Settings writes several independent domains; a "save everything" button should not be atomic across them, and the per-domain draft survival is what makes that safe.

- **A connection reset DROPS the draft and the cached catalog** — `packages/client/ui-settings-subagent/src/client/subagent-model-selection-card-controller.ts:306-313` (`resetConnection`). Why: after a reconnect the Host's state may be entirely different, and a draft built against the old one is not safely rebaseable. Why it transfers: any client that caches a server projection must decide what a reconnect does to unsaved work, and "drop it" is the safe answer.

- **Late settlements are suppressed by explicit generation counters** — `packages/client/ui-settings-subagent/src/client/subagent-model-selection-card-controller.ts:138-139` (`saveGeneration`, `catalogGeneration`), checked at `:287` and `:322`, and bumped by `dispose()` at `:167-172`. Why it transfers: after a dispose or a refresh, a pending promise's `then` would otherwise publish into a dead store; a counter is cheaper than an `AbortController` and works for writes as well as reads.

- **A stored-but-no-longer-advertised route stays listed and stays removable** — `packages/client/ui-settings-subagent/src/client/subagent-model-selection-card-controller.ts:106-116` (`subagentModelCandidates` keeps the leftovers as `available: false`) and `packages/client/ui-settings-subagent/src/client/SubagentModelSelectionFields.tsx:106-113` (a separate "Saved but currently unavailable" group). Why it transfers: dropping it would silently lose a permission the user granted; hiding it without an escape would strand it.

- **A partial catalog failure is reported without hiding the rest** — `packages/client/ui-settings-subagent/src/client/subagent-model-selection-card-controller.ts:325` (`catalogPartial = response.value.failures.length > 0`) and `packages/client/ui-settings-subagent/src/client/SubagentModelSelectionFields.tsx:93-95`. Why it transfers: a per-provider failure must not blank the whole picker; the "some providers failed" line tells the user which rows are missing.

- **The catalogue re-reads on exactly three signals, and the README says so** — `packages/client/ui-settings-subagent/src/client/index.ts:72-83` (adapters-updated, document-updated, connection/reset) and `packages/client/ui-settings-subagent/README.md:71`. Why it transfers: documenting the *staleness window* of a cached projection is a design decision users deserve to know; it also stops the next person from adding a fourth poll.

- **The credential-upload consent switch shows the ACCEPTED value, never the pending intent** — `packages/client/ui-settings-session-log/src/client/UploadRow.tsx:34` (`checked={upload.value?.enabled === true}`) and `packages/client/ui-settings-session-log/src/client/upload-preference.ts:30-44`. Why it transfers: an optimistic switch that snaps back when the Host refuses is worse than one that waits; the write is reported separately by a toast.

- **A write outcome that must outlive the panel is published as a shell overlay, keyed by a sequence counter so a repeat save re-triggers it** — `packages/client/ui-settings-session-log/src/client/UploadRow.tsx:45-50` (`<Toast key={state.sequence} …>`) and `packages/client/ui-settings-session-log/src/client/index.ts:38-40`. Why it transfers: the pattern (a small mutation store shared by a settings row and a global overlay) is what August needs for "saved" / "failed" notices on any settings write.

- **A duplicate action is a no-op while a write is in flight** — `packages/client/ui-settings-session-log/src/client/upload-preference.ts:31` (`if (this.state.getSnapshot().busy) return`) and the same guard in the subagent model controller at `packages/client/ui-settings-subagent/src/client/subagent-model-selection-card-controller.ts:219` and `:228`. Why it transfers: double-clicking a Save must not produce two writes.

- **A refusal keeps the draft; the copy promises it** — `packages/client/ui-settings-subagent/src/client/locales.ts:32` ("The deployment did not accept these values; **they were left for you to correct**") and `packages/client/ui-settings-shell/src/client/locales.ts:26`. Why it transfers: the message is part of the contract — a user who reads it knows their input is still there.

- **The rule disclosure lives in the field, not in a help page, and it does not change staged values** — `packages/client/ui-settings-subagent/src/client/SubagentLimitsFields.tsx:25-41` (an inline two-row table) and `packages/client/ui-settings-subagent/tests/card.client.spec.tsx:202-224`. Why it transfers: the field's own rule is where the user's decision is; the disclosure must be openable without a context switch and without disturbing the draft.

- **A numeric limit's rule is stated as a count with its exclusions** — `packages/client/ui-settings-subagent/src/client/locales.ts:44` ("Total live Subagents under the same main Agent, across all recursion levels. **The main Agent is excluded.** New start requests are rejected when the limit is reached."). Why it transfers: August's subagent caps are exactly this shape; stating the counting basis in the field is the difference between a configurable limit and a mystery.

- **The card controller is a thin callback layer so no React component ever holds a Cordis context** — `packages/client/ui-settings-models/src/client/operations.ts:76` (`createModelsOperations`) and `packages/client/ui-settings-models/src/client/schema-operations.ts:16`. Why: "Cards receive these instead of a context … so the failure codes and Remote namespaces stay in the apply world." Why it transfers: the same boundary keeps the UI testable without a container and keeps the failure taxonomy in one place.

- **Outcomes are UNIONS, not booleans** — `packages/client/ui-settings-models/src/client/operations.ts:15-31`: `SettingsWriteOutcome` = `written | conflict | refused` and `ModelDiscoveryOutcome` = `found | refused`. Why it transfers: the `settings/conflict` code is mapped to a distinct outcome exactly once, at the boundary; every consumer then renders "stale" without re-reading a wire code.

- **An extension seat is keyed by the owning NAMESPACE, so one registration covers a whole adapter family** — `packages/client/ui-settings-models/src/client/slot-contract.ts:33` and `packages/client/ui-settings-models/src/client/ModelsSection.tsx:450-454` (`entryKey: row.entry.settingsNs`). Why it transfers: August's plugin/settings surfaces can expose per-family extension points without the section learning what a family means.

- **The type of an extension seat lives with its declarer** — `packages/client/ui-settings-models/src/client/slot-contract.ts:15-17` ("TYPE HOME RATIONALE"). Why it transfers: it avoids a shared types package that both sides must agree on, and it keeps the dependency direction one-way.

- **A route id must be validated so the credential reference it derives is always legal** — `packages/client/ui-settings-models/src/client/CustomProviderCard.tsx:47-55` (`ROUTE_PATTERN`) and the relation test at `packages/client/ui-settings-models/tests/provider-form.client.spec.tsx:1289-1296`. Why: "a credential reference is a POSIX shell identifier, which cannot start with a digit", so a digit-leading id passes every other check and then fails at the credential seam with a raw regular expression. Why it transfers: August derives credential names from user-chosen ids too; the rule belongs at the id's input, and the relation should be tested as a relation.

- **The endpoint interrogation asks the form as it CURRENTLY shows, including an unsaved key** — `packages/client/ui-settings-models/src/client/ModelListEditor.tsx:240-249` and `packages/client/ui-settings-models/src/client/ProviderEditor.tsx:251-261` (the `probe` object). Why: "so adding a provider is one pass instead of save-then-return." Why it transfers: August's provider/model onboarding can interrogate an endpoint the user is still typing.

- **An endpoint that the adapter already describes is answered from the adapter's registry, with no network call and no endpoint needed** — `packages/client/ui-settings-models/src/client/ModelListEditor.tsx:164-173` and the probe's `provider` field at `packages/client/ui-settings-models/src/client/ProviderEditor.tsx:255-259`. Why it transfers: a "fetch models" button that hits the network when the catalog is already local is slower and fails offline.

- **The candidate picker never writes; the user picks and then adopts** — `packages/client/ui-settings-models/src/client/ModelListEditor.tsx:277-291` (`adoptPicked`) and the "already configured starts unchecked" rule at `:262-265`. Why it transfers: discovery must be a read; a configuration change behind the user's back is the thing people distrust.

- **"Select all" adds the visible results; "Deselect all" clears the entire selection** — `packages/client/ui-settings-models/src/client/ModelListEditor.tsx:310-319`, pinned at `packages/client/ui-settings-models/tests/provider-form.client.spec.tsx:768-814`. Why: "Deselecting a filtered result must also clear hidden selections so they cannot be adopted accidentally." Why it transfers: the asymmetric pair is a deliberate safety choice — one direction is scoped to what is visible, the other is global.

- **A user-tuned row wins over the provider's disclosed numbers** — `packages/client/ui-settings-models/src/client/ModelListEditor.tsx:284-287` (`byId.set(candidate.id, byId.get(candidate.id) ?? adopt(candidate))`). Why it transfers: re-fetching a catalogue must not silently overwrite a capacity the user corrected.

- **A schema identifier shows a product name, and an unknown identifier shows itself** — `packages/client/ui-settings-models/src/client/protocol-label.ts:24` and `packages/client/ui-settings-models/src/client/ModelReasoningEfforts.tsx:153-156`. Why it transfers: the stored value must stay the machine value; the display name is a presentation layer that must degrade gracefully.

- **A stored key the schema does not name keeps its row and stays selectable there** — `packages/client/ui-settings-models/src/client/ModelReasoningEfforts.tsx:152-156` (`choicesFor`). Why it transfers: a hand-written config must survive a UI that learned a new schema.

- **Changing a level resets a value that was only the old level's name; a custom value carries over only between two thinking levels** — `packages/client/ui-settings-models/src/client/ModelReasoningEfforts.tsx:124-129` (`changeLevel`). Why it transfers: this is the general rule for renaming a key in a structured setting — derive the new default from the old one only when the old value was the default.

- **A display name that resembles a module name is left verbatim** — `packages/client/ui-settings-plugin-inventory/src/client/PluginInventorySettingsTab.tsx:93-100` (`pluginText` resolves a localized title as-is and only shortens a *fallback* module name), pinned at `packages/client/ui-settings-plugin-inventory/tests/components.client.spec.tsx:152-166`. Why it transfers: the shortener must apply to generated identifiers, never to human-authored text.

- **A "provided by presets" claim is derived, not declared** — `packages/client/ui-settings-plugin-inventory/src/client/PluginInventorySettingsTab.tsx:282-293` (`enabledIn`) and the README's rule at `packages/client/ui-settings-plugin-inventory/README.md:64`. A global entry is marked preset-provided only when it is disabled globally **and** at least one preset row for the same module specifier is actually enabled; "a module every preset gates off (or declares only conditionally) stays plainly disabled rather than over-claiming provision." Why it transfers: any UI that summarises "who actually enables this" must compute it from the leaves, not from a flag.

- **Only the states that depart from the default carry a tag** — `packages/client/ui-settings-plugin-inventory/src/client/PluginInventorySettingsTab.tsx:246-249` (`StateTag` returns `null` for `enabled`). Why it transfers: a status chip on every row trains the eye to ignore chips; tagging only the exceptions makes the exceptions visible.

- **A status dot is used only for the states no tag covers** — `packages/client/ui-settings-plugin-inventory/src/client/PluginInventorySettingsTab.tsx:211-215` (`PHASE_DOT_STATES`: pending→idle, loading/unloading→ongoing; `active` and `failed` get no dot). Why it transfers: two status channels covering the same states is redundant; each channel should own a disjoint set.

- **Row keys are scope-qualified so the same module in two scopes keeps distinct disclosure state** — `packages/client/ui-settings-plugin-inventory/src/client/PluginInventorySettingsTab.tsx:331` (`preset:${id}:${index}`) and `:380` (`global:${entryId}`). Why it transfers: an expansion state keyed by the entity alone collapses across scopes.

- **A display-only shortener for module names, with the full specifier retained in details and search** — `packages/client/ui-settings-plugin-inventory/src/client/PluginInventorySettingsTab.tsx:70-76` (`moduleShortName`). Why it transfers: it strips the npm scope and the `cordis:` / `cordis-plugin-` / `dsh-` prefixes but keeps the identity reachable.

- **A container query, not a media query, decides the card grid** — `packages/client/ui-settings-plugin-inventory/src/client/PluginInventorySettingsTab.module.css:2` (`container: plugin-inventory / inline-size`) and `:484` (`@container plugin-inventory (max-width: 520px)`). Why it transfers: a settings panel embedded in a resizable shell should respond to its own width, not the window's.

- **A static gate: every theme token a sheet names must be declared by a theme sheet** — `packages/client/ui-settings-models/tests/styles.client.spec.ts:32-44`. Why it transfers: an undeclared `--dsw-*` name silently resolves to its fallback literal, so the sheet still renders and only the dark theme looks wrong — a bug no type checker or runtime test can see. The check covers `--dsw-`, `--dsh-` and `--ds-` because "a `--dsh-` name reads as a plausible sibling and would otherwise slip past this gate into a fallback literal."

- **A static gate: braces must balance in a CSS sheet** — `packages/client/ui-settings-models/tests/styles.client.spec.ts:46-53`. Why: "a missing `}` on an `@media` block is not a parse error: every rule after it silently becomes conditional". Why it transfers: it is four lines of JavaScript and it catches a class of bug that only shows up on one user's machine.

- **A static gate: every `<select>` in the package must carry the shared chevron class** — `packages/client/ui-settings-models/tests/styles.client.spec.ts:61-82`. It parses the `.tsx` sources as text, splits on `<select`, and reads to the first `>`. Why it transfers: "a `<select>` that takes `.input` alone silently keeps the OS one" — a visual inconsistency that no DOM test would catch unless the test knew to look.

- **A static gate on the read path: a credential's *source* label is never shown** — `packages/client/ui-settings-models/tests/components.client.spec.tsx:2202-2231` ("shows only the blank-input environment detection for source %s"). Why it transfers: the presence of a source label tells the user where their key lives, which is information the UI does not need and might be safer not to volunteer.

- **The refusal vocabulary is a closed set the UI renders, not raw wire codes** — `packages/client/ui-settings-models/src/client/operations.ts:15-31` and the whole `conflict`/`refused` split. Why it transfers: a wire code leaks into the UI as soon as one component renders it raw.

- **The model's own reasoning about a first-run step: ANY usable provider ends it, and every failure mode COMPLETES rather than blocks** — `packages/client/ui-settings-models/src/client/store.ts:374-417` (`onboardingReadiness`) and the README's rationale at `packages/client/ui-settings-models/README.md:70`. The typed `unavailable` reasons (`load-failed | provider-inactive | credentials-unavailable | settings-read-only | credential-read-only`) are all non-blocking. Why it transfers: this is the shape August's onboarding should take — a first-run prompt that can trap the user on a broken capability is worse than no prompt.

- **A stored provider keeps its route id even when its display name changes** — `packages/client/ui-settings-models/src/client/ModelsSection.tsx:354-363` (the saved notice is keyed by the route id and reads the *refreshed* display name). Why it transfers: the id is the key every other namespace and every logged session references; the name is presentation.

- **Removal is idempotent and ordered so a partial failure stays recoverable** — `packages/client/ui-settings-models/src/client/ModelsSection.tsx:153-170` (`removeProviderProfile`): the credential is removed **first**, "so a second-step failure leaves the provider row visible and the whole operation safely retryable". Pinned at `packages/client/ui-settings-models/tests/components.client.spec.tsx:1668` (the invocation order). Why it transfers: multi-step deletions should be ordered so the retryable half is the one that can fail independently.

- **A credential is only removed when the page can prove it owns it** — `packages/client/ui-settings-models/src/client/ModelsSection.tsx:200-219` (`targetOf`): the reference must equal the page's derived `<ROUTE>_API_KEY` **and** be configured **and** be writable. The README states the limit: "Custom references, environment credentials, and unidentifiable targets are retained because the row cannot prove ownership of them." Why it transfers: August's key management has the same ownership question, and "prove it before deleting" is the right default.

- **An error state has a Retry, and the retry is the same load path** — `packages/client/ui-settings-models/src/client/ModelsSection.tsx:333-343`. Why it transfers: a settings page that fails once and offers no way back is a dead end.

- **A page load failure keeps the previous good rows rather than clearing them** — `packages/client/ui-settings-models/src/client/store.ts:238-246` and `packages/client/ui-settings-models/tests/store.client.spec.ts:219-230`. Why it transfers: a transient failure should degrade the page, not wipe it.

- **A draft that the section cannot resolve renders a visible error, not a blank card** — `packages/client/ui-settings-models/src/client/ProviderEditor.tsx:331-335`. Why: "showing it beats a blank card."

- **An unknown provider namespace renders only a hint and offers no Apply** — `packages/client/ui-settings-models/src/client/ProviderEditor.tsx:557-559` and the submit gate at `:571`. Why it transfers: a card that cannot write anything should not offer a commit button.

- **The write that a switch selects is staged in the SELECTION namespace and the key in a section that is not one** — `packages/client/ui-settings-web-search/src/client/web-search-card-controller.ts:146-162`. The credential field is attached to the *selection* form because it is "the one control that does not live in a section". Why it transfers: a secret that belongs to no single config namespace still needs to be staged with the rest of the form so one Save covers everything.

- **A literal that is not a number is refused at the field, and the refusal names the range** — `packages/client/ui-settings-web-search/src/client/web-search-card-controller.ts:152-161` (the count parser accepts 1–50) and `packages/client/ui-settings-subagent/src/client/subagent-limits-card-controller.ts:36`. Why it transfers: a range the client enforces must be the range the server accepts, and both live in one place.

- **A credential's writability and the settings document's writability are two different gates** — `packages/client/ui-settings-web-search/src/client/WebSearchCard.tsx:53-57`. Why it transfers: two separate stores refuse for two separate reasons; a UI that merges them disables the wrong control.

## Files skipped (with reasons)

None. Every one of the 160 files in this shard was opened and read; the ledger records `read` for all of them. No file in the shard is generated, vendored, binary or large-data — the largest is `packages/client/ui-settings-models/tests/components.client.spec.tsx` at 119 KB / 2425 lines, which was read in full across three passes, and `packages/client/ui-settings-models/tests/provider-form.client.spec.tsx` at 80 KB / 1711 lines, read in full across two passes. No file exceeded the read tool's line limit in a way that lost content.

## Uncertainties

- **I did not read the code that these packages call.** `SettingsFormModel` / `settingsNumberField` / `settingsTextField` / `SettingsForm` / `SettingsValueField` / `SettingsSecretField` live in `@deepseek-ai/dsh-client-ui-primitives`; `SettingsDescribeMirror` / `ConfigFormController` / `SettingsSchemaService` live in `@deepseek-ai/dsh-client-ui-settings`; the slot ledger lives in `@deepseek-ai/dsh-client-ui-slots` / `ui-renderer`. Those are outside this shard, so statements above about "staged edits", "revision fencing" and "the effective value" are taken from this shard's own comments, spec text and tests — I did not verify them against the implementation.
- **The Host-side halves are outside the shard.** The `settings` / `credentials` / `llm` / `session` Remote namespaces, the plugin inventory Host projection (`packages/host/plugin-inventory`), the delegation tools that register `subagent` and `subagent-model-selection`, and the `web` provider selection are all referenced but not read. In particular I could not verify that `settings.mutate`'s `expectedRevision` is enforced host-side — I only know the client treats a `settings/conflict` code as a conflict.
- **`packages/client/ui-settings-models/tests/components.client.spec.tsx` is 2425 lines.** I read all of it (three passes: 1–760, 761–1600, 1601–2425), but it is dense; if the lead needs a specific assertion from it, it should be re-read rather than trusted from this note.
- **A suspected accessibility seam in the Models add card.** `packages/client/ui-settings-models/src/client/ModelsSection.tsx:615` and `:669` set `aria-labelledby={`${addId}-catalog`}` and `${addId}-custom` on the two panels, but the `SegmentedControl` at `:575-597` is never given those ids — the addId-derived ids exist only on the panels. I could not confirm from this shard alone whether the shared `SegmentedControl` primitive generates matching ids internally (it is in `ui-primitives`, outside the shard). If it does not, the two panels' `aria-labelledby` points at a non-existent element. I did not run the code to check.
- **Lens coverage.** This shard contains no agent loop, no tool-calling code, no streaming/thinking-content handling, no prompt construction or cache-hit logic, no context-window management or compaction, no memory store, and no eval harness. The only subagent-adjacent content is the *settings surface* for delegation limits and the model allowlist (`packages/client/ui-settings-subagent/`), and the only model-capability content is the reasoning-effort editor (`packages/client/ui-settings-models/src/client/ModelReasoningEfforts.tsx`). The lenses "agent loop and tool-calling flow", "reasoning/thinking streaming", "prompt construction and caching", "context management and compaction", "memory/learning" and "evals/testing" are therefore **not covered by this shard** and must be sourced from other shards. The lenses this shard *does* cover in depth are UI/UX patterns, config, model-specific adaptations (per-model reasoning levels and per-model input modalities), and the tool-call reliability surface that lives in *settings* (revision fencing, conflict versus refusal, retry staging).
- **Testing lens.** The shard carries 29 test files (≈ 30 % of its bytes) and they are unusually good — they pin ordering, not just outcomes (write order, invocation order, save-before-switch) and they distinguish states that are easy to merge (conflict vs refusal, detected vs missing vs unconfirmed credential, busy vs idle). If the lead's merge keeps only one package's specs as a style guide, `packages/client/ui-settings-models/tests/components.client.spec.tsx` is the best single example.
