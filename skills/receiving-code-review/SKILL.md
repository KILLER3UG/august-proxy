---
name: receiving-code-review
description: "Structured framework for processing code review feedback with technical rigor."
trigger: "receiving code review feedback"
version: 1.0.0
author: August Proxy (adapted from obra/superpowers)
license: MIT
---

# Receiving Code Review

## Overview

A technical, rigorous framework for handling code review feedback. Emphasizes verification before implementation, technical correctness over social comfort, and reasoned pushback when appropriate.

**Core principle:** Understand the feedback completely before responding. Verify against codebase reality. Respond with evidence, not ego.

## Workflow

### Step 1: READ

Read the complete feedback without reacting. Do not formulate responses while reading. Do not start implementing changes.

- Read every comment, even if it seems wrong
- Note which comments are about behavior, style, or architecture
- Distinguish between hard requirements and suggestions

### Step 2: UNDERSTAND

Restate the requirement in your own words. If you can't restate it clearly, you don't understand it.

- "This comment is asking me to..." (complete the sentence)
- If unclear, ask the reviewer for clarification before implementing
- Note the specific files and lines referenced

### Step 3: VERIFY

Check each comment against the actual codebase:

- Is the comment technically accurate?
- Does the suggested change work correctly?
- Are there side effects the reviewer might have missed?
- Run tests to verify assumptions

### Step 4: EVALUATE

For each piece of feedback, determine:

- **Critical** — Bug, security issue, or incorrect behavior. Must fix.
- **Important** — Design or architecture concern. Should fix or discuss.
- **Minor** — Style preference or suggestion. Can defer.

Apply the YAGNI check: "Does this change add complexity without proven need?" If yes, push back.

### Step 5: RESPOND

Respond to each comment:

- **Accepted:** "Fixed in [commit]."
- **Addressed differently:** "I considered that but chose X because [reason]. Here's the approach I used."
- **Push back:** When the feedback is technically wrong or violates YAGNI:
  - State your reasoning clearly with evidence
  - Reference specific code or behavior
  - Offer alternatives if appropriate

### Step 6: IMPLEMENT

One item at a time:
1. Implement the change
2. Run tests to verify nothing broke
3. Commit
4. Move to the next item

Start with Critical items, then Important, then Minor.

## Red Flags

- **Responding before understanding** — You can't evaluate what you haven't understood
- **Accepting without verification** — Even experienced reviewers make mistakes
- **Pushing back without evidence** — "I think it's fine" is not a technical argument
- **Defensiveness** — The code is being reviewed, not you
- **Ignoring minor comments** — Style consistency matters for long-term maintainability
- **Implementing multiple items before testing** — One change at a time, verify each

## Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "They're right, just accept it" | Verify first. Even good reviewers miss things. |
| "Not worth arguing about" | If it's technically wrong, it's worth addressing. |
| "I'll fix it later" | Later never comes. Fix it now or defer explicitly. |
| "It's just style" | Style consistency has real maintenance cost. |
