# Voice Command Implementation - Testing Guide

**Date:** June 30, 2026  
**Status:** Ready for testing

---

## Pre-Flight Checklist

### Build Status
- ✅ Duplicate imports fixed in ChatThread.tsx
- ✅ All new files created (intent.ts, dispatch.ts, ModelPickerCard.tsx)
- ✅ Schema extended (voiceTriggers added to commands-data.ts)
- ✅ Tests written (voice-intent.test.ts)
- ⚠️ TypeScript errors are **pre-existing** (not introduced by our changes)

### Files to Verify Exist
```bash
ls src/api/voice/intent.ts
ls src/api/voice/dispatch.ts
ls src/sections/chat/ModelPickerCard.tsx
ls src/test/voice-intent.test.ts
```

---

## Manual Testing Checklist

### 1. Start the Development Server
```bash
cd frontend/desktop
npm run dev
```

**Expected:** Server starts without compilation errors related to our files

---

### 2. Voice Command Tests

Open the August app in browser and test each command:

#### ✅ Model Switching
- [ ] Say: **"switch model"**
  - Expected: Inline model picker appears in chat
  - Expected: Can search models
  - Expected: Arrow keys navigate (↑↓)
  - Expected: Enter selects model
  - Expected: Esc closes picker

- [ ] Say: **"change model"**
  - Expected: Same as above (different trigger)

- [ ] Say: **"pick model"**
  - Expected: Same as above (different trigger)

- [ ] Type: **`/model`** (without voice)
  - Expected: Model picker opens
  - Expected: Typing still works

#### ✅ Session Management
- [ ] Say: **"clear chat"**
  - Expected: Chat messages clear immediately
  - Expected: Toast confirms action

- [ ] Say: **"new session"**
  - Expected: New chat session starts
  - Expected: Previous chat saved

- [ ] Say: **"start over"**
  - Expected: Same as "new session" (different trigger)

#### ✅ Help & Discovery
- [ ] Say: **"help"**
  - Expected: Help message appears in chat
  - Expected: Shows all available commands

- [ ] Say: **"show commands"**
  - Expected: Same as "help" (different trigger)

#### ✅ Exam Mode
- [ ] Say: **"test me"**
  - Expected: Exam banner appears
  - Expected: No topic (user needs to specify)

- [ ] Say: **"quiz me on python"**
  - Expected: Exam banner appears with "python" topic
  - Expected: Questions are about Python

- [ ] Say: **"exam python decorators"**
  - Expected: Exam opens with "python decorators" topic

#### ✅ Skills
- [ ] Say: **"show skills"**
  - Expected: `/skills` prefilled in composer
  - Expected: User can hit Enter to execute

- [ ] Say: **"search skills"**
  - Expected: Same as above

#### ✅ Dictation Fallback
- [ ] Say: **"write a function to parse JSON"**
  - Expected: Text appends to composer (dictation mode)
  - Expected: NO command execution (too long, not a command)

- [ ] Say: **"create a React component"**
  - Expected: Text appends to composer
  - Expected: NO command execution

- [ ] Say: **"explain quantum computing"**
  - Expected: Text appends to composer
  - Expected: NO command execution

---

### 3. Edge Cases

#### Case Sensitivity
- [ ] Say: **"SWITCH MODEL"** (shouting)
  - Expected: Model picker opens (case-insensitive)

#### Punctuation
- [ ] Say: **"switch model!"** (with exclamation)
  - Expected: Model picker opens (punctuation stripped)

#### Partial Matches
- [ ] Say: **"model"** (single word)
  - Expected: Model picker opens (exact trigger match)

#### Non-Matches
- [ ] Say: **"I need to switch my model"** (command embedded in sentence)
  - Expected: Falls back to dictation (not a command pattern)

#### Short Ambiguous Phrases
- [ ] Say: **"help me with this"**
  - Expected: May match /help or fall back to dictation
  - Expected: If matches, shows help card

---

### 4. Integration Tests

#### Model Picker Workflow
- [ ] Say "switch model"
- [ ] Type "opus" in search box
- [ ] Press ↓ to navigate
- [ ] Press Enter to select
- [ ] **Expected:** Model switches, toast confirms, picker closes

#### Voice + Typing Combo
- [ ] Say "test me on"
- [ ] Type " python" in composer
- [ ] Hit Enter
- [ ] **Expected:** Exam opens with "python" topic

#### Multiple Commands in Session
- [ ] Say "clear chat"
- [ ] Say "switch model"
- [ ] Select a model
- [ ] Say "test me"
- [ ] **Expected:** All commands work in sequence

---

### 5. Unit Tests

Run the test suite:
```bash
cd frontend/desktop
npm test voice-intent.test.ts
```

**Expected:**
- ✅ All 20+ tests pass
- ✅ Exact trigger matching works
- ✅ Partial matching works
- ✅ Case-insensitive matching works
- ✅ `isLikelyCommand()` heuristic works
- ✅ BM25 ranking prefers more specific matches

---

## Known Issues

### Pre-Existing TypeScript Errors
The following errors existed BEFORE our implementation:
- `ChatThread.tsx(1281,27): Property 'path' does not exist on type 'FileAttachment'`
- `WorkspaceModelsSection.tsx(139,10): Comparison has no overlap`
- Various test file errors in `v4_1_model_fleet.test.tsx`

**These are NOT caused by voice command implementation.**

---

## Success Criteria

✅ **All 13 commands are voice-triggerable**  
✅ **Model picker appears on "switch model"**  
✅ **Dictation still works for long phrases**  
✅ **No regression in existing chat functionality**  
✅ **All unit tests pass**  

---

## Troubleshooting

### Issue: "Identifier 'matchIntent' has already been declared"
**Solution:** ✅ Fixed - duplicate imports removed

### Issue: Voice not working at all
**Check:** Browser supports Web Speech API (Chrome, Edge work best)  
**Check:** Microphone permissions granted

### Issue: All transcripts become dictation, no commands
**Check:** `COMMANDS` is imported correctly in ChatThread  
**Check:** `voiceTriggers` exist in commands-data.ts  
**Debug:** Add `console.log(matchIntent(transcript, COMMANDS))` in recognition.onend

### Issue: Model picker doesn't appear
**Check:** `modelPickerActive` state exists in ChatThread  
**Check:** `ModelPickerCard` is imported  
**Check:** Models array has data  
**Debug:** Add `console.log('Model picker active:', modelPickerActive)` before render

---

## Reporting Results

After testing, document:
1. Which commands work ✅
2. Which commands fail ❌
3. Any unexpected behavior
4. Browser/OS combination tested
5. Microphone accuracy issues (if any)

---

**Happy Testing!** 🎤✨
