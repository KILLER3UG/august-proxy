---
name: writing-skills
description: "Create, edit, and test SKILL.md files with iterative validation."
category: meta
trigger: "creating or editing skills"
version: 1.0.0
author: August Proxy (adapted from obra/superpowers)
license: MIT
---

# Writing Skills

## Overview

A meta-skill for creating, editing, and validating SKILL.md files. This skill guides the full lifecycle of a skill: from intent capture through drafting, testing, iteration, and quality review.

**Core principle:** A skill is only as good as its triggers and testability. If you cannot write a test prompt that activates the skill, the skill is not well-defined.

## When to Use

Use this skill when:
- Creating a brand new skill from scratch
- Editing or refining an existing skill
- Improving trigger phrases based on usage data
- Validating that a skill works correctly
- Converting workflow documentation into a reusable skill

**Do NOT use when:**
- Editing non-skill documents (use general writing tools instead)
- Making trivial typo fixes (just fix them)

## The Process

### Phase 1: Capture Intent

Before writing anything, answer these four questions:

1. **What should the skill do?** (One sentence. If it needs "and", it is two skills.)
   - Example: Guide completion by verifying tests and presenting merge/PR/keep/discard options.

2. **When should the skill trigger?** (The exact trigger phrase or context.)
   - Example: "implementation complete, all tests pass"
   - Good triggers: Specific, contextual, action-oriented
   - Bad triggers: Vague ("when needed"), passive ("when asked"), overly broad ("for programming")

3. **Who is the author?** (Name for the YAML frontmatter.)
   - "August Proxy (adapted from <source>)"

4. **What existing skills does it relate to?** (Chaining targets.)
   - Which skill comes before this one?
   - Which skill comes after this one?

Record these answers in a structured format:

```yaml
Intent:
  Purpose: "<one-sentence description>"
  Trigger: "<trigger phrase>"
  Author: "<author name>"
  Predecessor: "<skill-to-skill input>"
  Successor: "<skill-to-skill output>"
```

### Phase 2: Write Draft SKILL.md

Create the SKILL.md file using this template:

```markdown
---
name: <name>
description: "<one-sentence description>"
trigger: "<trigger phrase>"
version: 1.0.0
author: <author>
license: MIT
---

# <Skill Name>

## Overview

<2-3 paragraphs explaining the core principle and value proposition.>

## When to Use

Use this skill when:
- <specific situation 1>
- <specific situation 2>
- <specific situation 3>

**Do NOT use when:**
- <situation where this skill is inappropriate>

## <The Process>

<Break the skill into logical phases or steps.>

## <Red Flags or Common Mistakes>

<Tables work well here for listing rationalizations vs. reality.>

## <Quick Reference>

<Optional summary table or diagram.>

## Related Skills

<Skill-to-skill chaining with august__load_skill.>
```

**Style guidelines:**
- Use august__run_command for terminal commands
- Use august__spawn_subagent for subagent delegation
- Use august__load_skill for skill-to-skill chaining
- Use august__read_file and august__search_files for file operations
- Use tables for comparison, decision trees, and quick references
- Use bold for **core principles** and **iron laws**
- Use code blocks for YAML, commands, and file paths
- File paths should use the correct OS conventions

**Write to the correct path:**

```
august__run_command mkdir -p skills/<skill-name>
```

Then write the file to skills/<skill-name>/SKILL.md.

### Phase 3: Create Test Prompts

Write 3-5 test prompts that should trigger the skill. These serve as validation tests.

**Good test prompts:**
- Direct trigger match: "Tests pass, ready to merge" (for finishing-a-development-branch)
- Contextual match: "I finished implementing the feature" (for the same skill)
- Edge case: "All tests fail, what now?" (should NOT trigger this skill)
- Negative test: "Can you write a plan?" (for writing-plans)

Save test prompts in a comment block or a separate test file:

```markdown
<!--
Test prompts for validation:
1. "Tests pass, can you help me finish this branch?"
2. "I am done with the implementation."
3. "Ready to merge my changes."
4. "All tests are green, what next?"
5. [Negative] "Tests are failing, help!"
-->
```


### Phase 4: Validate the Skill

Test the skill by simulating its use:

1. **Trigger test:** Do the test prompts match the trigger field?
   - The trigger phrase in the YAML frontmatter should appear in or be implied by the test prompts.

2. **Clarity test:** Can you follow the process without external context?
   - Hand the file to another agent (or re-read it cold). Can you execute the steps?

3. **Completeness test:** Does the skill cover:
   - When to use it?
   - When NOT to use it?
   - Step-by-step process?
   - Error handling / edge cases?
   - Subagent integration?
   - Skill-to-skill chaining?
   - Red flags / rationalization prevention?

4. **Path test:** Are all file paths correct?
   - Verify the directory exists or will be created.
   - Verify path separators are correct for the OS.

### Phase 5: Iterate on Feedback

When revising a skill based on feedback:

1. **Identify the gap:** What did the skill miss or get wrong?
2. **Fix the specific section:** Do not rewrite the whole file.
3. **Update test prompts:** Add a test prompt that covers the gap.
4. **Re-validate:** Run through Phase 4 again.

**Checklist for each edit:**

- [ ] Intent captured accurately
- [ ] Trigger phrase updated if behavior changed
- [ ] Process steps updated
- [ ] Examples updated
- [ ] Test prompts updated
- [ ] Version bumped (patch for small edits, minor for new phases)

### Phase 6: Quality Check

Before finalizing, verify all items:

**Structure:**
- [ ] YAML frontmatter is valid (--- delimiters, no trailing spaces)
- [ ] Frontmatter includes: name, description, trigger, version, author, license
- [ ] Version follows semver and is greater than previous version (or 1.0.0 for new)
- [ ] License is MIT (standard for all skills)

**Content:**
- [ ] When to Use section includes both use and non-use cases
- [ ] Each phase/step has concrete actions, not just philosophy
- [ ] Commands use the august__run_command prefix
- [ ] Subagent calls use august__spawn_subagent
- [ ] Skill chaining uses august__load_skill
- [ ] Tables are used where comparison or decision-making is needed
- [ ] Red flags or rationalization table is present
- [ ] No placeholder text like TODO or FIXME

**Testing:**
- [ ] At least 3 test prompts defined
- [ ] At least 1 negative test prompt (should NOT trigger)
- [ ] Skill has been manually walkthrough-tested

## Rationalization Prevention

| Rationalization | Reality |
|-----------------|---------|
| "I will write the trigger later" | Trigger is the most important field. Write it first. |
| "This skill is obvious, skip the test" | If it is obvious, testing is fast. Do it. |
| "One more phase will not hurt" | Scope creep kills clarity. Keep it focused. |
| "My previous skill works fine as-is" | Every skill can improve. Review triggers quarterly. |
| "The user will figure out the trigger" | If they cannot trigger it, the skill does not exist. |
| "I will add the negative cases later" | Edge cases define robustness. Include them now. |

## Quick Reference

| Phase | Activity | Key Question |
|-------|----------|-------------|
| 1. Capture | Intent, trigger, author, relations | What should it do? |
| 2. Draft | Write SKILL.md from template | Is the process actionable? |
| 3. Test Prompts | 3-5 prompts including negative | Does it trigger correctly? |
| 4. Validate | Trigger, clarity, completeness, paths | Can someone use it cold? |
| 5. Iterate | Fix gaps, update tests, bump version | Is every edit an improvement? |
| 6. Quality | Structure, content, testing checklists | Is it ready to ship? |

## Subagent Integration for Skill Testing

For validating a skill through simulated use:

```python
august__spawn_subagent(
    goal="Test the <skill-name> skill with these prompts: <list prompts>",
    context="Read skills/<skill-name>/SKILL.md, then simulate responding to each test prompt. Report whether the skill would activate correctly for each one.",
    toolsets=["terminal", "file"]
)
```

When you need a plan for implementing a complex skill change, load the writing-plans skill via august__load_skill to create a structured implementation plan first.
