---
name: skill-creator
description: "Iterative skill authoring: draft, test, evaluate, and improve SKILL.md files."
trigger: "creating a new skill or editing an existing one"
version: 1.0.0
author: August Proxy (adapted from obra/superpowers)
license: MIT
---

# Skill Creator

## Overview

Create and refine SKILL.md files through an iterative loop: draft, test, evaluate, improve. This skill uses August Proxy's `august__skill_create` and `august__skill_edit` tools for CRUD operations.

**Core principle:** A skill is only ready when it's been tested with real prompts. Don't publish untested skills.

## When to Use

- Creating a new skill from scratch
- Editing an existing skill's wording or structure
- Improving a skill's description so it triggers more reliably
- Turning a repeated manual workflow into a reusable skill

## Workflow

### 1. Capture Intent

Before writing anything, clarify:

- **What should the skill do?** Describe the workflow in one sentence
- **When should it trigger?** What phrase or situation should activate it
- **What output should it produce?** What does success look like after following the skill

### 2. Write a Draft

Use `august__skill_create` to create the initial version:

```
august__skill_create {
  name: "my-skill-name",
  body: "---
name: my-skill-name
description: \"One clear line describing what this does.\"
trigger: \"when to use this\"
version: 1.0.0
author: August Proxy
license: MIT
---

# Skill Name

## Overview
...
"
}
```

### 3. Create Test Prompts

Come up with 2-3 realistic prompts the skill should handle:

- A typical use case
- An edge case
- A negative case (should NOT trigger this skill)

### 4. Test the Skill

Load the skill and verify it works:

```
august__load_skill { name: "my-skill-name" }
```

Check:
- Does it load without errors?
- Are the instructions complete?
- Can you follow the workflow with the test prompts?

### 5. Review with User

Present the draft and ask:
- Does this do what you expected?
- Is the trigger phrase clear?
- Any missing steps?

### 6. Iterate

Use `august__skill_edit` to update the skill:

```
august__skill_edit {
  name: "my-skill-name",
  body: "...updated content..."
}
```

Repeat steps 3-6 until the skill works well.

## Quality Checklist

- [ ] Frontmatter has name, description, and trigger
- [ ] Description is a single clear line
- [ ] Workflow steps are actionable
- [ ] Red flags list common mistakes
- [ ] Test prompts validate the trigger
