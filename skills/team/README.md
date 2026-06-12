# August team skills

Team skills live under this folder so each team agent can own its own capabilities.

Folder shape:

```text
skills/team/<agent_id>/<skill_name>/SKILL.md
```

Examples:

```text
skills/team/project_manager/team-run-plan/SKILL.md
skills/team/frontend_dev/react-ui-audit/SKILL.md
skills/team/backend_dev/api-contract-review/SKILL.md
skills/team/backend_dev/node-service-change/SKILL.md
skills/team/qa_tester/evidence-regression/SKILL.md
skills/team/documentation/release-notes/SKILL.md
skills/team/deployment/docker-release/SKILL.md
```

Each `SKILL.md` uses normal August skill frontmatter:

```markdown
---
name: react-ui-audit
description: Audit React components for layout, accessibility, and behavior issues
trigger: react ui audit, component review
---
Use this skill when reviewing React UI changes.
```

The owning folder name becomes `ownerAgentId`. A team agent sees only skills from its own folder through the Workbench system prompt and `/ui/team-skills/<agent_id>`.
