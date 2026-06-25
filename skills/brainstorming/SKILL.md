---
name: brainstorming
description: "Structured design exploration before implementation, with approval gates."
category: design
trigger: "before any creative or implementation work"
version: 1.0.0
author: August Proxy (adapted from obra/superpowers)
license: MIT
---

# Brainstorming

## Overview

Before any creative work — features, components, architecture, or behavior changes — this skill guides a structured design exploration. No code until the design is written and approved.

**Core principle:** Understanding what to build is harder than building it. Explore first, implement second.

## When to Use

**Always before:**
- New features or components
- Modifying existing behavior
- Adding functionality
- Architectural changes

**Not for:**
- Bug fixes (use `systematic-debugging`)
- Pure refactoring with no behavior change
- Configuration changes
- Simple, well-understood tasks

## Workflow

### 1. Explore Context

Read relevant project files, documentation, and recent changes to understand the landscape:

- Read the current code structure in the relevant area
- Check for existing patterns or conventions
- Look at recent commits for context

### 2. Clarify Requirements

Ask the user clarifying questions ONE AT A TIME. Do not dump multiple questions at once.

Focus on:
- What problem are we solving?
- Who is the user?
- What are the acceptance criteria?
- What constraints exist (time, technology, compatibility)?
- Are there existing examples or references?

### 3. Propose Approaches

Present 2-3 distinct approaches with:
- How each approach works
- Trade-offs (complexity, performance, maintainability)
- Your recommendation with reasoning

### 4. Design Incrementally

Present the design one section at a time:
- Data model / types
- Component tree / file structure
- Data flow / API contracts
- UI / interaction (if applicable)

Get user approval on each section before proceeding to the next.

### 5. Write Design Doc

Save the approved design to a document for reference:

Summarize:
- Problem statement
- Chosen approach and why
- File / component structure
- Data flow
- Key decisions and trade-offs

### 6. Self-Review the Spec

Check for:
- [ ] Any placeholder sections or TODOs?
- [ ] Internal contradictions?
- [ ] Ambiguous requirements?
- [ ] Scope creep beyond what was approved?
- [ ] Missing edge cases or error states?
- [ ] Dependencies on unplanned work?

### 7. User Review

Present the complete written spec to the user for final approval.

### 8. Handoff

When the spec is approved:
- Tell the user: "The next step is to create an implementation plan. Load the `writing-plans` skill via `august__load_skill` if available."

## Key Principles

- **One question at a time** — don't overwhelm the user
- **2-3 options with a recommendation** — don't make the user choose from 10
- **Approval gates** — don't proceed past a section without sign-off
- **Write it down** — designs not written down don't exist
- **Self-review** — catch your own mistakes before the user does
