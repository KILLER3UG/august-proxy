/**
 * skills-v2.js — Standardized skill management with SKILL.md frontmatter format
 * Inspired by Hermes Agent's SKILL.md format and Skills Hub.
 *
 * Skills are stored as: ~/.august/skills/{name}/SKILL.md
 * Format: YAML frontmatter (---) + markdown body
 */

const fs = require('fs');
const path = require('path');

const SKILLS_DIR = path.join(require('os').homedir(), '.august', 'skills');
const PROJECT_SKILLS_DIR = path.join(__dirname, '..', '..', '..', 'skills');

// ── Skill Entry ──

/**
 * @typedef {Object} SkillEntry
 * @property {string} name - Unique skill name
 * @property {string} displayName - Human-readable name
 * @property {string} description - Brief description
 * @property {string} category - Category/domain
 * @property {string} instructions - Full markdown body
 * @property {string} author - Skill author
 * @property {string} version - Semver version
 * @property {boolean} enabled - Whether the skill is active
 * @property {string[]} triggers - Trigger patterns
 * @property {string} updatedAt - ISO timestamp
 * @property {string} source - 'user' | 'project' | 'builtin'
 * @property {string} scope - 'user' | 'project' | 'global'
 * @property {string[]} requires - Required capabilities/tools
 * @property {string[]} tags - Search tags
 */

// ── Helpers ──

function skillsDir() {
  if (!fs.existsSync(SKILLS_DIR)) fs.mkdirSync(SKILLS_DIR, { recursive: true });
  return SKILLS_DIR;
}

function skillPath(name) {
  return path.join(skillsDir(), name, 'SKILL.md');
}

function projectSkillPath(name) {
  return path.join(PROJECT_SKILLS_DIR, name, 'SKILL.md');
}

function now() {
  return new Date().toISOString();
}

// ── Parse SKILL.md (frontmatter + body) ──

function parseSkillMd(content) {
  const result = {
    frontmatter: {},
    body: content.trim()
  };

  // Parse YAML-like frontmatter between --- markers
  const frontmatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (frontmatch) {
    const yamlText = frontmatch[1];
    result.body = frontmatch[2].trim();
    // Simple YAML parser for common patterns
    for (const line of yamlText.split('\n')) {
      const match = line.match(/^(\w+):\s*(.*)$/);
      if (match) {
        let value = match[2].trim();
        // Parse arrays: [item1, item2] or multiline arrays
        if (value.startsWith('[') && value.endsWith(']')) {
          try { value = JSON.parse(value.replace(/'/g, '"')); } catch (e) { value = value.slice(1, -1).split(',').map(s => s.trim().replace(/['"]/g, '')); }
        }
        // Parse booleans and numbers
        if (value === 'true') value = true;
        else if (value === 'false') value = false;
        else if (/^\d+$/.test(value)) value = parseInt(value);
        result.frontmatter[match[1]] = value;
      }
      // Handle multiline arrays (indented items starting with -)
      const arrayMatch = line.match(/^\s+-\s+(.*)$/);
      if (arrayMatch) {
        const lastKey = Object.keys(result.frontmatter).pop();
        if (lastKey && Array.isArray(result.frontmatter[lastKey])) {
          result.frontmatter[lastKey].push(arrayMatch[1].trim().replace(/['"]/g, ''));
        }
      }
    }
  }
  return result;
}

// ── Generate SKILL.md ──

function toSkillMd(skill) {
  const frontmatter = [];
  frontmatter.push('---');
  frontmatter.push(`name: ${skill.name}`);
  if (skill.displayName) frontmatter.push(`displayName: ${skill.displayName}`);
  if (skill.description) frontmatter.push(`description: ${skill.description}`);
  if (skill.category) frontmatter.push(`category: ${skill.category}`);
  if (skill.author) frontmatter.push(`author: ${skill.author}`);
  if (skill.version) frontmatter.push(`version: ${skill.version}`);
  if (skill.enabled !== undefined) frontmatter.push(`enabled: ${skill.enabled}`);
  if (skill.triggers && skill.triggers.length) frontmatter.push(`triggers: [${skill.triggers.map(t => `'${t}'`).join(', ')}]`);
  if (skill.tags && skill.tags.length) frontmatter.push(`tags: [${skill.tags.map(t => `'${t}'`).join(', ')}]`);
  if (skill.requires && skill.requires.length) frontmatter.push(`requires: [${skill.requires.map(r => `'${r}'`).join(', ')}]`);
  if (skill.scope) frontmatter.push(`scope: ${skill.scope}`);
  frontmatter.push(`updatedAt: ${skill.updatedAt || now()}`);
  frontmatter.push('---');
  frontmatter.push('');
  frontmatter.push(skill.instructions || skill.body || skill.description || '');
  return frontmatter.join('\n');
}

// ── CRUD ──

function getSkills() {
  const skills = [];

  // User skills (~/.august/skills/)
  const dir = skillsDir();
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const mdPath = path.join(dir, entry.name, 'SKILL.md');
      if (!fs.existsSync(mdPath)) continue;
      try {
        const content = fs.readFileSync(mdPath, 'utf8');
        const parsed = parseSkillMd(content);
        skills.push({
          name: parsed.frontmatter.name || entry.name,
          displayName: parsed.frontmatter.displayName || parsed.frontmatter.name || entry.name,
          description: parsed.frontmatter.description || '',
          category: parsed.frontmatter.category || 'uncategorized',
          author: parsed.frontmatter.author || '',
          version: parsed.frontmatter.version || '1.0.0',
          tags: parsed.frontmatter.tags || [],
          triggers: parsed.frontmatter.triggers || [],
          requires: parsed.frontmatter.requires || [],
          scope: parsed.frontmatter.scope || 'user',
          enabled: parsed.frontmatter.enabled !== false,
          instructions: parsed.body,
          updatedAt: parsed.frontmatter.updatedAt || '',
          source: 'user',
          path: mdPath
        });
      } catch (e) {
        // Skip malformed skills
      }
    }
  } catch (e) {}

  // Project skills (./skills/)
  try {
    if (fs.existsSync(PROJECT_SKILLS_DIR)) {
      for (const entry of fs.readdirSync(PROJECT_SKILLS_DIR, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (skills.some(s => s.name === entry.name)) continue; // User skills override
        const mdPath = path.join(PROJECT_SKILLS_DIR, entry.name, 'SKILL.md');
        if (!fs.existsSync(mdPath)) continue;
        try {
          const content = fs.readFileSync(mdPath, 'utf8');
          const parsed = parseSkillMd(content);
          skills.push({
            name: parsed.frontmatter.name || entry.name,
            displayName: parsed.frontmatter.displayName || parsed.frontmatter.name || entry.name,
            description: parsed.frontmatter.description || '',
            category: parsed.frontmatter.category || 'uncategorized',
            author: parsed.frontmatter.author || '',
            version: parsed.frontmatter.version || '1.0.0',
            tags: parsed.frontmatter.tags || [],
            triggers: parsed.frontmatter.triggers || [],
            requires: parsed.frontmatter.requires || [],
            scope: parsed.frontmatter.scope || 'project',
            enabled: true,
            instructions: parsed.body,
            updatedAt: parsed.frontmatter.updatedAt || '',
            source: 'project',
            path: mdPath
          });
        } catch (e) {}
      }
    }
  } catch (e) {}

  return skills;
}

function getSkill(name) {
  // Try user skills first
  const userPath = skillPath(name);
  if (fs.existsSync(userPath)) {
    const content = fs.readFileSync(userPath, 'utf8');
    const parsed = parseSkillMd(content);
    return {
      name: parsed.frontmatter.name || name,
      displayName: parsed.frontmatter.displayName || name,
      description: parsed.frontmatter.description || '',
      category: parsed.frontmatter.category || 'uncategorized',
      author: parsed.frontmatter.author || '',
      version: parsed.frontmatter.version || '1.0.0',
      tags: parsed.frontmatter.tags || [],
      triggers: parsed.frontmatter.triggers || [],
      requires: parsed.frontmatter.requires || [],
      scope: parsed.frontmatter.scope || 'user',
      enabled: parsed.frontmatter.enabled !== false,
      instructions: parsed.body,
      updatedAt: parsed.frontmatter.updatedAt || '',
      source: 'user',
      path: userPath
    };
  }

  // Try project skills
  const projectPath = projectSkillPath(name);
  if (fs.existsSync(projectPath)) {
    const content = fs.readFileSync(projectPath, 'utf8');
    const parsed = parseSkillMd(content);
    return {
      name: parsed.frontmatter.name || name,
      displayName: parsed.frontmatter.displayName || name,
      description: parsed.frontmatter.description || '',
      category: parsed.frontmatter.category || 'uncategorized',
      author: parsed.frontmatter.author || '',
      version: parsed.frontmatter.version || '1.0.0',
      tags: parsed.frontmatter.tags || [],
      triggers: parsed.frontmatter.triggers || [],
      requires: parsed.frontmatter.requires || [],
      scope: parsed.frontmatter.scope || 'project',
      enabled: true,
      instructions: parsed.body,
      updatedAt: parsed.frontmatter.updatedAt || '',
      source: 'project',
      path: projectPath
    };
  }

  return null;
}

function saveSkill(skill) {
  const dirPath = path.join(skillsDir(), skill.name);
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
  const mdPath = path.join(dirPath, 'SKILL.md');
  const content = toSkillMd({
    ...skill,
    updatedAt: now()
  });
  fs.writeFileSync(mdPath, content, 'utf8');
  return { name: skill.name, path: mdPath };
}

function deleteSkill(name) {
  const dirPath = path.join(skillsDir(), name);
  const mdPath = path.join(dirPath, 'SKILL.md');
  if (fs.existsSync(mdPath)) fs.unlinkSync(mdPath);
  try { fs.rmdirSync(dirPath); } catch (e) {}
  return true;
}

function updateSkill(name, updates) {
  const existing = getSkill(name);
  if (!existing) return saveSkill({ name, ...updates });
  return saveSkill({ ...existing, ...updates, name, updatedAt: now() });
}

function enableSkill(name) {
  return updateSkill(name, { enabled: true });
}

function disableSkill(name) {
  return updateSkill(name, { enabled: false });
}

function searchSkills(query) {
  const q = query.toLowerCase();
  return getSkills().filter(s =>
    s.name.toLowerCase().includes(q) ||
    s.displayName.toLowerCase().includes(q) ||
    s.description.toLowerCase().includes(q) ||
    (s.tags && s.tags.some(t => t.toLowerCase().includes(q))) ||
    (s.category && s.category.toLowerCase().includes(q))
  );
}

function loadSkillInstructions(name) {
  const skill = getSkill(name);
  if (!skill) return null;
  return skill.instructions;
}

function getEnabledSkills() {
  return getSkills().filter(s => s.enabled);
}

// ── Remote skill import (from Skills Hub URL) ──

async function importFromUrl(url) {
  try {
    const https = require('https');
    const http = require('http');
    const protocol = url.startsWith('https') ? https : http;

    return new Promise((resolve, reject) => {
      protocol.get(url, { timeout: 15000 }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            if (res.statusCode !== 200) {
              return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
            }
            const parsed = parseSkillMd(data);
            if (!parsed.frontmatter.name) {
              return reject(new Error('Imported skill has no name in frontmatter'));
            }
            const result = saveSkill({
              name: parsed.frontmatter.name,
              displayName: parsed.frontmatter.displayName,
              description: parsed.frontmatter.description,
              category: parsed.frontmatter.category,
              tags: parsed.frontmatter.tags,
              triggers: parsed.frontmatter.triggers,
              instructions: parsed.body
            });
            resolve(result);
          } catch (e) {
            reject(e);
          }
        });
      }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('Timeout')); });
    });
  } catch (e) {
    throw new Error(`Failed to import skill from URL: ${e.message}`);
  }
}

module.exports = {
  getSkills,
  getSkill,
  saveSkill,
  deleteSkill,
  updateSkill,
  enableSkill,
  disableSkill,
  searchSkills,
  loadSkillInstructions,
  getEnabledSkills,
  importFromUrl,
  parseSkillMd,
  toSkillMd
};
