/**
 * learn-command.js — Structured skill authoring from external sources.
 * Inspired by Hermes's /learn command pattern.
 *
 * Builds a structured prompt that instructs the agent to:
 * 1. Gather material using existing tools (read_file, search_files, web_extract)
 * 2. Author ONE SKILL.md via skill_manage(action="create")
 */

const path = require('path');
const fs = require('fs');

// ── Authoring Standards ──

const AUTHORING_STANDARDS = {
  frontmatter: {
    name: { maxLength: 64, pattern: /^[a-z0-9][a-z0-9._-]*$/ },
    description: { maxLength: 60, noMarketingWords: true },
    version: '0.1.0',
    metadata: { tags: [] }
  },
  bodySectionOrder: [
    'Title',
    'When to Use',
    'Prerequisites',
    'How to Run',
    'Quick Reference',
    'Procedure',
    'Pitfalls',
    'Verification'
  ],
  qualityBar: {
    maxLinesSimple: 100,
    maxLinesComplex: 200,
    exactCommandsFromSource: true,
    noInventedFlags: true
  }
};

// ── Marketing Words to Avoid ──

const MARKETING_WORDS = [
  'revolutionary', 'cutting-edge', 'state-of-the-art', 'best-in-class',
  'game-changing', 'transformative', 'innovative', 'powerful', 'advanced',
  'seamless', 'intuitive', 'robust', 'enterprise-grade', 'world-class'
];

// ── Build Learn Prompt ──

function buildLearnPrompt(userRequest) {
  const source = userRequest || 'the workflow we just went through in this conversation';

  return `
You are a skill author for August Proxy. Your task is to create a reusable skill from external sources.

## Source Material

Gather material from: ${source}

Use these tools to gather information:
- \`read_file\` for local files
- \`search_files\` for codebase search
- \`web_extract\` for URLs and web content
- Review the conversation history for context

## Authoring Standards

Create ONE SKILL.md file following these EXACT standards:

### Frontmatter
- \`name\`: lowercase, hyphens/dots/underscores, max 64 chars, pattern: ^[a-z0-9][a-z0-9._-]*$
- \`description\`: ONE sentence, max 60 chars, NO marketing words (${MARKETING_WORDS.join(', ')})
- \`version\`: 0.1.0
- \`metadata.tags\`: relevant tags array

### Body Sections (in this order)
1. **Title** — Clear, descriptive title
2. **When to Use** — Specific scenarios where this skill applies
3. **Prerequisites** — Required tools, access, or setup
4. **How to Run** — Step-by-step commands or actions
5. **Quick Reference** — Key commands or patterns at a glance
6. **Procedure** — Detailed implementation steps
7. **Pitfalls** — Common mistakes and how to avoid them
8. **Verification** — How to confirm the skill works correctly

### Quality Bar
- Use EXACT commands from the source material
- Do NOT invent flags, paths, or API endpoints
- Simple skills: ~100 lines
- Complex skills: ~200 lines
- Use tool names: \`terminal\` (not shell), \`read_file\` (not cat), \`search_files\` (not grep)

## Output

Use the \`skill_manage\` tool with action="create" to save the skill.

The skill name should be descriptive and follow the naming pattern above.
`;
}

// ── Validate Skill Against Standards ──
// Delegates to validation.js for the canonical implementation.
const { validateSkillMd } = require('./validation');

// ── Parse Source URL ──

function parseSourceUrl(source) {
  try {
    const url = new URL(source);
    return {
      type: 'url',
      url: url.href,
      hostname: url.hostname,
      pathname: url.pathname
    };
  } catch {
    // Not a URL, treat as text description
    return {
      type: 'text',
      content: source
    };
  }
}

// ── Build Gather Sources Prompt ──

function buildGatherSourcesPrompt(source) {
  const parsed = parseSourceUrl(source);

  if (parsed.type === 'url') {
    return `
Gather information from this URL: ${parsed.url}

Use the \`web_extract\` tool to fetch and analyze the content.
Focus on:
- What the tool/library/framework does
- Key commands and usage patterns
- Configuration options
- Common pitfalls or gotchas
- Examples and code snippets
`;
  }

  return `
Gather information about: ${parsed.content}

Use these tools to find relevant information:
- \`search_files\` to search the codebase for related code
- \`read_file\` to read relevant files
- \`web_extract\` to search the web if needed

Focus on extracting:
- Key concepts and patterns
- Step-by-step procedures
- Commands and configurations
- Common pitfalls
`;
}

// ── Exports ──

module.exports = {
  AUTHORING_STANDARDS,
  MARKETING_WORDS,
  buildLearnPrompt,
  validateSkillMd,
  parseSourceUrl,
  buildGatherSourcesPrompt
};
