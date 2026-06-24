/**
 * validation.js — Skill validation with authoring standards.
 * Validates SKILL.md files against Hermes-inspired authoring standards.
 */

const fs = require('fs');
const path = require('path');

// ── Authoring Standards ──

const STANDARDS = {
  frontmatter: {
    name: {
      maxLength: 64,
      pattern: /^[a-z0-9][a-z0-9._-]*$/,
      required: true
    },
    description: {
      maxLength: 60,
      noMarketingWords: true,
      required: false
    },
    version: {
      pattern: /^\d+\.\d+\.\d+$/,
      required: false
    }
  },
  body: {
    minLines: 10,
    maxLinesSimple: 100,
    maxLinesComplex: 200,
    requiredSections: [
      'When to Use',
      'Prerequisites',
      'How to Run',
      'Procedure'
    ],
    recommendedSections: [
      'Title',
      'Quick Reference',
      'Pitfalls',
      'Verification'
    ]
  },
  naming: {
    pattern: /^[a-z0-9][a-z0-9._-]*$/,
    maxLength: 64,
    forbiddenPatterns: [
      /\s/, // No spaces
      /[A-Z]/, // No uppercase
      /^[._-]/, // No leading special chars
      /[._-]$/ // No trailing special chars
    ]
  }
};

// ── Marketing Words to Avoid ──

const MARKETING_WORDS = [
  'revolutionary', 'cutting-edge', 'state-of-the-art', 'best-in-class',
  'game-changing', 'transformative', 'innovative', 'powerful', 'advanced',
  'seamless', 'intuitive', 'robust', 'enterprise-grade', 'world-class',
  'next-generation', 'breakthrough', 'unprecedented', 'exceptional'
];

// ── Validation Functions ──

function validateName(name) {
  const errors = [];
  const warnings = [];

  if (!name) {
    errors.push('Name is required');
    return { valid: false, errors, warnings };
  }

  if (name.length > STANDARDS.naming.maxLength) {
    errors.push(`Name too long: ${name.length} chars (max ${STANDARDS.naming.maxLength})`);
  }

  if (!STANDARDS.naming.pattern.test(name)) {
    errors.push(`Name must match pattern: ${STANDARDS.naming.pattern}`);
  }

  for (const pattern of STANDARDS.naming.forbiddenPatterns) {
    if (pattern.test(name)) {
      errors.push(`Name contains forbidden pattern: ${pattern}`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

function validateDescription(description) {
  const errors = [];
  const warnings = [];

  if (!description) {
    warnings.push('Description is recommended');
    return { valid: true, errors, warnings };
  }

  if (description.length > STANDARDS.frontmatter.description.maxLength) {
    warnings.push(`Description too long: ${description.length} chars (max ${STANDARDS.frontmatter.description.maxLength})`);
  }

  if (STANDARDS.frontmatter.description.noMarketingWords) {
    const lowerDesc = description.toLowerCase();
    const foundMarketing = MARKETING_WORDS.filter(w => lowerDesc.includes(w));
    if (foundMarketing.length > 0) {
      warnings.push(`Description contains marketing words: ${foundMarketing.join(', ')}`);
    }
  }

  // Check if it's a single sentence
  const sentences = description.split(/[.!?]+/).filter(s => s.trim().length > 0);
  if (sentences.length > 1) {
    warnings.push('Description should be a single sentence');
  }

  return { valid: errors.length === 0, errors, warnings };
}

function validateFrontmatter(frontmatter) {
  const errors = [];
  const warnings = [];

  // Validate name
  const nameResult = validateName(frontmatter.name);
  errors.push(...nameResult.errors);
  warnings.push(...nameResult.warnings);

  // Validate description
  const descResult = validateDescription(frontmatter.description);
  errors.push(...descResult.errors);
  warnings.push(...descResult.warnings);

  // Validate version if present
  if (frontmatter.version && !STANDARDS.frontmatter.version.pattern.test(frontmatter.version)) {
    warnings.push(`Version should follow semver pattern: ${STANDARDS.frontmatter.version.pattern}`);
  }

  return { valid: errors.length === 0, errors, warnings };
}

function validateBody(body) {
  const errors = [];
  const warnings = [];

  if (!body) {
    errors.push('Body content is required');
    return { valid: false, errors, warnings };
  }

  const lines = body.split('\n');

  if (lines.length < STANDARDS.body.minLines) {
    warnings.push(`Body very short: ${lines.length} lines (recommended min ${STANDARDS.body.minLines})`);
  }

  if (lines.length > STANDARDS.body.maxLinesComplex) {
    warnings.push(`Body very long: ${lines.length} lines (typical max ${STANDARDS.body.maxLinesComplex})`);
  }

  // Extract section headers
  const foundSections = [];
  for (const line of lines) {
    const headerMatch = line.match(/^#+\s+(.+)/);
    if (headerMatch) {
      foundSections.push(headerMatch[1].trim());
    }
  }

  // Check required sections
  for (const required of STANDARDS.body.requiredSections) {
    const found = foundSections.some(s =>
      s.toLowerCase().includes(required.toLowerCase())
    );
    if (!found) {
      errors.push(`Missing required section: ${required}`);
    }
  }

  // Check recommended sections
  for (const recommended of STANDARDS.body.recommendedSections) {
    const found = foundSections.some(s =>
      s.toLowerCase().includes(recommended.toLowerCase())
    );
    if (!found) {
      warnings.push(`Missing recommended section: ${recommended}`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

function validateSkillMd(content) {
  const errors = [];
  const warnings = [];

  // Parse frontmatter
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) {
    errors.push('Missing or invalid frontmatter (must start with --- and have closing ---)');
    return { valid: false, errors, warnings };
  }

  const frontmatterLines = match[1].split('\n');
  const body = match[2].trim();

  // Parse frontmatter key-value pairs
  const frontmatter = {};
  for (const line of frontmatterLines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      const val = line.slice(colonIdx + 1).trim();
      frontmatter[key] = val;
    }
  }

  // Validate frontmatter
  const fmResult = validateFrontmatter(frontmatter);
  errors.push(...fmResult.errors);
  warnings.push(...fmResult.warnings);

  // Validate body
  const bodyResult = validateBody(body);
  errors.push(...bodyResult.errors);
  warnings.push(...bodyResult.warnings);

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    frontmatter,
    bodyLines: body.split('\n').length
  };
}

function validateSkillFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return { valid: false, errors: ['File not found'], warnings: [] };
    }

    const content = fs.readFileSync(filePath, 'utf8');
    return validateSkillMd(content);
  } catch (error) {
    return { valid: false, errors: [`Failed to read file: ${error.message}`], warnings: [] };
  }
}

function validateSkillDirectory(dirPath) {
  const results = [];

  if (!fs.existsSync(dirPath)) {
    return { valid: false, errors: ['Directory not found'], warnings: [], files: [] };
  }

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.md')) {
      const filePath = path.join(dirPath, entry.name);
      const result = validateSkillFile(filePath);
      results.push({
        file: entry.name,
        ...result
      });
    }
  }

  const allValid = results.every(r => r.valid);
  const allErrors = results.flatMap(r => r.errors);
  const allWarnings = results.flatMap(r => r.warnings);

  return {
    valid: allValid,
    errors: allErrors,
    warnings: allWarnings,
    files: results
  };
}

// ── Exports ──

module.exports = {
  STANDARDS,
  MARKETING_WORDS,
  validateName,
  validateDescription,
  validateFrontmatter,
  validateBody,
  validateSkillMd,
  validateSkillFile,
  validateSkillDirectory
};
