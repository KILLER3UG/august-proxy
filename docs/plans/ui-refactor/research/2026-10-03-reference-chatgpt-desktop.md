# Reference study — ChatGPT desktop (OpenAI)

Stage 1 evidence for the 2026-10-03 UI/UX refactor spec. Produced by a research subagent on
2026-10-03. No local install exists on this machine (checked exhaustively), so all evidence is
from OpenAI's official help center / release notes, Microsoft's Store catalog API, and cited
community threads. Claim labels: **[A]** desktop/Store-verified from official sources,
**[B]** official-source web behavior the desktop mirrors, **[C]** reputable secondary,
**[U]** UNVERIFIED — do not design from this.

---

# ChatGPT Desktop (Windows/Mac) — UI/UX Study for August Proxy

## 0. What this app is + exact version studied + verification method

- ChatGPT Desktop is OpenAI's official desktop client, shipped as **two distinct apps as of July 2026**: (1) the original Microsoft Store app, now renamed **"ChatGPT Classic"** (Windows package `OpenAI.ChatGPT-Desktop_2026.709.1617.0…`, store ID `9NT1R1C2HH7J`, package stamp 2026-07-13), and (2) the **new unified ChatGPT desktop app** (Chat + Work + Codex in one window, macOS + Windows, announced 2026-07-09). Sources: Microsoft displaycatalog API (queried live 2026-10-03; `ProductTitle: "ChatGPT Classic"`); ChatGPT Release Notes, entry "July 9, 2026 — Introducing ChatGPT Work / The new ChatGPT desktop app brings Chat, Work, and Codex together", `https://help.openai.com/en/articles/6825453-chatgpt-release-notes`.
- **Verification method**: no local install exists on this machine — `$LOCALAPPDATA/Programs`, `$LOCALAPPDATA`, `$APPDATA`, `/c/Program Files/WindowsApps` (permission-denied), `Get-AppxPackage`, uninstall keys, Start Menu — all empty, so binary/asar inspection was impossible. `help.openai.com`, `openai.com` and `chatgpt.com` return HTTP 403/challenge to direct fetches; articles were read via a reader service.
- The ChatGPT app and chatgpt.com are one shared React UI shell; release notes describe them together and name their surfaces.

## 1. Launch experience

- **System requirements (Classic app)**: Windows 10 (x64/arm64) 17763.0+. Enterprise: `winget.exe install --id=9NT1R1C2HH7J --source=msstore`. [A] `https://help.openai.com/en/articles/9982051-using-the-chatgpt-windows-app`
- **Companion window is real and is the signature Windows launch surface**: "To open the companion chat, press Alt + Space when you have the ChatGPT app open. The companion window remembers the last position it was in, and resets to the bottom center of your screen when you reset the app." It has a **New chat button at top**; a conversation opened in the companion window is fully visible from the main window's chat history. [A] Same source.
- **The hotkey is user-configurable** under **Settings > App > Companion window hotkey**, and OpenAI documents the failure state: "If you're having trouble using the hotkey, check that it hasn't already been registered by another app in your system." [A] Same source.
- **First-run / sign-in visuals**: sign-in uses the ChatGPT account; splash/loading, first-run permissions, onboarding tour: **UNVERIFIED**. [U]
- **App reset is deliberately NOT in-app**: Windows Settings > Apps > ChatGPT > Advanced options > Reset. [A] Same source.
- **Migration launch flow (2026)**: users of the previous app get an in-app prompt to download the new version; the previous app remains as "ChatGPT Classic". [A] Release notes July 9, 2026.

**Adopt for August:**
1. Build the Windows quick-launch companion window (small, position-remembered, one global hotkey) — Tauri can host a second small window cheaply.
2. Make the companion hotkey configurable with conflict detection + messaging.
3. Remember companion window position; one canonical reset position.
4. Route app reset through the OS-standard path and document it.
5. A conversation started in the companion must be immediately findable in the main window's history — one session store, two window surfaces.

## 2. Layout, spacing, typography, color, theming

- **Exact design tokens are UNVERIFIED** — no local binary; all direct fetches 403. Do not reuse any hex from this report. [U]
- **Typeface family (official, property-verified)**: OpenAI properties load **OpenAI Sans** (`OpenAISans-Regular.woff2`, `-Semibold.woff2` from `cdn.openai.com`); the app is widely reported to use the same family, but the binary could not be inspected. [A for OpenAI properties / U for the app]
- **Layout skeleton**: left sidebar + central conversation column + composer; model picker lives **in the composer** (release notes June 10, 2026). [B]
- **Top-left global switcher (new 2026 app)**: "A global switcher lets you choose between ChatGPT and Codex. In ChatGPT, choose Chat … or Work to complete tasks end to end." [A] Release notes "July 16, 2026 — ChatGPT desktop app experience updates (macOS and Windows)".
- **Theming**: light/dark across surfaces; the only verified user-facing control is **Accent color** in Settings > General (Aug 7, 2025 — "On web"). Desktop accent control: [U].

**Adopt for August:**
1. Put the model/mode picker in the composer — selection is a per-message decision.
2. Keep a permanent top-left app-level switcher pattern if August grows multiple surfaces.
3. Ship a small set of named accent-color options driven from Settings > General.
4. Never cite ChatGPT's colors without extraction from a real install (none was possible).

## 3. Left sidebar

- **Classic-era sidebar**: New chat, Search chats, Library, Sora/GPTs entries, history grouped by recency. **Pinned chats** shipped Dec 18, 2025: "hover over a chat in the left-hand sidebar, click ⋯, select Pin chat". [A] Release notes.
- **Web sidebar behavior inherited**: floating mode with soft dismissal; recent conversations limited with an infinite-scroll flyout; "Settings always at bottom of sidebar"; sidebar can stay open with active canvas if there is space. [B] Release notes Nov 22, 2024.
- **Projects**: created from the sidebar; chats dragged in; user-chosen colors and icons (Sep 3, 2025); project-only memory "initially only available on the ChatGPT website and Windows app" (Aug 22, 2025). [A/B] `https://help.openai.com/en/articles/10169521`
- **The 2026 redesign removed chat history from the sidebar**: "Unified Recents: Chat and Work conversations appear together in Recents, where you can sort, filter, and pin them." [A] Release notes July 16, 2026. OpenAI staff: "select ChatGPT from the top-left switcher. Your previous chats appear in Recents…" [A] staff reply, community.openai.com/t/desktop-app-redesign-removed-chat-history-from-the-sidebar-please-bring-it-back/1386361 (2026-08-20).
- **User reaction was strongly negative** — history now lives in "a pop-up window in the middle of the screen, which loads slowly and reveals chats little by little as I scroll. A huge step backwards." [C] Same thread. **A documented anti-pattern to avoid.**
- **Search chats**: full-surface search across chats, projects, images, documents (July 14, 2026); message-content search with role/date filters and exact-match toggle, Ctrl/Cmd+Shift+F. [B] + [C]
- **Account/plan area**: profile icon bottom-left opens Settings; plan-tier upsell entries in the account area. [B]

**Adopt for August:**
1. **Never remove persistent chat history from the sidebar** — the 2026 redesign is a live, documented case study in user backlash.
2. Do adopt the *unified Recents list* idea (one activity-sorted list across chat/agent turns) as a filterable view **on top of** the sidebar, not as its replacement.
3. Pinning via a hover "⋯" menu per chat row — cheap and repeatedly requested.
4. Search spanning chats + workspace artifacts from one sidebar entry, with role/date filters.
5. Projects with color/icon personalization and drag-to-project.
6. Keep Settings pinned to the sidebar bottom (and a fallback icon when the sidebar is closed).

## 4. Right panel (canvas, work artifacts, agent panels)

- **Canvas**: opened from the composer toolbox or "the canvas shortcut in the upper right of the composer" (Dec 10, 2024). Critically, it is being **retired as a separate surface**: "Starting May 28, 2026 … canvas will no longer be available in GPT-5.5 Instant or GPT-5.5 Thinking. Writing and coding functionality is now supported directly in chat responses through writing blocks and code blocks." [B] Release notes.
- **Deep research**: "A redesigned sidebar entry point and fullscreen report view. Create and edit a research plan before it begins, and track progress with the ability to adjust direction mid-run." (Feb 10, 2026). Mid-run steering: "Click 'update' in the sidebar and send new info; the model adjusts midstream" (Nov 5, 2025). [B]
- **Agent (Work) progress**: "You can watch each step in the Work panel, follow its progress, answer questions, change direction, and approve important actions" (July 9, 2026). Codex PR review happens "in the side panel". [A]
- **Built-in browser panel (new 2026 app)**: "ChatGPT Work and Codex can now use tools that supported websites provide directly in the desktop app's built-in browser." (Aug 31, 2026). [A]
- **Resizing, docking, multiple simultaneous right-panel items**: UNVERIFIED. [U] What is verified: fullscreen report view for deep research, panel-based progress for Work/Codex, side-by-side file view on web — **one primary artifact surface at a time, with fullscreen escalation**.

**Adopt for August:**
1. Progressive simplification won: ChatGPT folded canvas into inline blocks. Prefer inline artifact blocks that expand to a full panel over a permanently-split editing pane.
2. Copy the deep-research pattern for long agent runs: editable plan **before** start → live progress → mid-run "update" input → fullscreen report at the end.
3. Approval gates inside the agent progress panel ("approve important actions") — put the approve button where progress is watched, not in a modal.
4. Escalation path: panel → fullscreen, then back. Design one primary artifact surface; do not attempt multiple simultaneous right panels.

## 5. Settings

- Settings opens from the **profile icon at the bottom-left** (Aug 7, 2025). [B]
- **Verified section names**: **General** (accent color), **Notifications** ("Settings > Notifications > Manage tasks" — `https://help.openai.com/en/articles/10291617`), **Personalization** (custom instructions, personality, memory; consolidated Sep 15, 2025), **Data Controls**, **Security** (Lockdown Mode Jun 4 2026; Active sessions; Security history), **Storage** (May 14, 2026), **Apps**, **Plugins** (Sep 14, 2026), **Cloud browser > Browser data**, **My Plan**, **Memory > Saved memories**, and — Windows-desktop-specific — **App** ("Settings > App > Companion window hotkey"). [A/B]
- "Speech" appears superseded by **Voice**. A desktop "About" section: **UNVERIFIED**. [U]
- **Keyboard-shortcuts surface**: "Try ⌘ (Ctrl) + / to see the complete list" — official release-notes entry. [A]

**Adopt for August:**
1. Flat left-nav modal with ~10 named sections, ordered: General → Notifications → Personalization → Data/Privacy → Security → About.
2. Include a desktop-specific section ("App") for OS-level things: hotkeys, launch behavior, companion window.
3. Name the voice section "Voice".
4. Ship the Ctrl+/ shortcuts overlay as the single source of shortcut truth.
5. Fold personalization (memory, custom instructions, personality) into one section — ChatGPT explicitly consolidated this in Sep 2025.

## 6. Update flow

- **Classic (Store) app**: distributed and updated through the Microsoft Store; "access to the Windows app will follow the policies set by your IT admin for all apps in the Store" — updates ride Store policy including managed/deferred deployment. [A] Help article 9982051.
- **New (2026) app — migration is an in-app prompt, not a silent swap**: "follow the prompt in the app to download the new version. The previous app may remain installed as ChatGPT Classic. ChatGPT Classic continues to receive model updates, bug fixes, security patches." [A] Release notes July 9, 2026.
- **Store auto-update cadence, in-app "what's new" surfaces, update-failure UI, rollback**: UNVERIFIED. [U]

**Adopt for August:**
1. Pair every desktop release with a persistent but dismissible in-app migration/update prompt.
2. Keep the old version alive under a distinct identity during transitions ("Classic" naming + continued security patches) instead of force-replacing — directly relevant to August's update-must-keep-everything promise.
3. For store/winget paths, treat update policy as an enterprise concern.
4. Version stamps like `2026.709.1617.0` (year.build-day.time) make build age instantly legible in support.

## 7. Icon system

- **UNVERIFIED** — no library, stroke weight, or size scale extractable. [U]
- What is verifiable: a small set of monoline functional icons; sidebar rows pair one icon + label; per-project color/icon personalization. [B]

**Adopt for August:** (1) one monoline icon set, single stroke weight, used at 2 sizes; (2) icons only next to labels in navigation, alone only for row-level affordances; (3) if ChatGPT's polish is wanted, budget a future session with a real install for token/icon extraction.

## 8. Micro-interactions

- **Streaming/interrupt**: mid-run interruption is a first-class control — "Click 'update' … the model adjusts midstream" (Nov 5, 2025); GPT-5.4 Thinking "can now provide an upfront plan of its thinking, so you can adjust course mid-response" (Mar 5, 2026). [B]
- **Thinking indicator**: effort surfaced as a composer-level picker (Instant/Medium/High/Extra High/Pro, Jun 10, 2026); a "Think" button for free users (Aug 6, 2026). [B]
- **Waiting states made playful**: "While images are generating, you can now play Snake" (Sep 8, 2026). [B]
- **Error handling in-stream**: "In-line message error retries" plus **Conversation Drafts** (unsubmitted messages are saved) and a new Temporary Chat UI — explicitly scoped to "**Web and the Windows desktop app**" (Mar 18, 2025). **Windows-desktop-verified.** [A]
- **Drafts/large input guard**: messages pasting over 10k characters are converted to attachments (Aug 4, 2026). [B]
- **Voice**: integrated into the main chat interface; the Windows app retains voice after macOS retired it (Dec 11, 2025). [A/B]
- **Keyboard shortcuts (verified)**: Ctrl+/ full shortcuts panel; Ctrl/Cmd+Shift+; copy last code block; **Alt+Space companion window (Windows)** [A]; Ctrl+Shift+O new chat / Ctrl+Shift+S toggle sidebar / Ctrl+K search chats reported by secondary cheat sheets [C — probable, not official].
- **Streaming-replay bug class**: "completed answers now appear without slowly replaying as though they're still being generated" (iOS, Aug 7, 2026) — resumed sessions must not re-animate prior text. [B]

**Adopt for August:**
1. In-line error retry on failed assistant messages (per-message button, not a toast) — verified on the Windows app.
2. Persist drafts of unsubmitted composer text per conversation; restore on return.
3. Auto-convert giant pastes (10k+ chars) into attachments with a notice.
4. Mid-run "update" input while an agent turn is running — expose user steering, not just stop.
5. Show the model's plan upfront for long agent turns and allow course-correction mid-response.
6. Make long waits ownable: a small idle game or animated progress is an official OpenAI pattern.
7. Guard resumed sessions against re-animating already-completed text.
8. Adopt Ctrl+/ as the shortcuts-panel chord and Alt+Space as August's quick-launch chord (document conflict handling).

---

### Source register (all read 2026-10-03)

- Using the ChatGPT Windows app — `https://help.openai.com/en/articles/9982051-using-the-chatgpt-windows-app` [A]
- ChatGPT — Release Notes (changelog Oct 2023–Oct 2026) — `https://help.openai.com/en/articles/6825453-chatgpt-release-notes` [A/B]
- Scheduled tasks in ChatGPT — `https://help.openai.com/en/articles/10291617` [A]
- Projects in ChatGPT — `https://help.openai.com/en/articles/10169521` [A]
- Microsoft displaycatalog product API for `9NT1R1C2HH7J` [A]
- Community: "Desktop app redesign removed chat history from the sidebar" (incl. OpenAI_Support staff reply 2026-08-20) — `https://community.openai.com/t/desktop-app-redesign-removed-chat-history-from-the-sidebar-please-bring-it-back/1386361` [C, staff reply A-adjacent]
- Community: Alt+Space default behavior threads — `https://community.openai.com/t/985894`, `/t/1058161` [C]
- Microsoft Store listing — `https://apps.microsoft.com/detail/9nt1r1c2hh7j` [A]
- Secondary shortcut/sidebar writeups — `https://www.ai-toolbox.co` [C]

**Known gaps (all UNVERIFIED above)**: exact color/spacing/type tokens, icon library details, splash/first-run visuals, right-panel resizing and multi-panel stacking, desktop "About" settings section, update-failure UI, Store auto-update cadence. A future pass with an installed build would close these via resource extraction.
