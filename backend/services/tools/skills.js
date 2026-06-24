const fs = require('fs');
const path = require('path');
const os = require('os');
const { getConfig, saveConfig } = require('../../lib/config');

const { scanForThreats } = require('../memory/threat-patterns');

const SKILL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const SKILLS_DIR = path.join(os.homedir(), '.august', 'skills');
const PROJECT_SKILLS_DIR = path.join(__dirname, '..', '..', '..', 'skills');
const TEAM_SKILLS_DIR = path.join(PROJECT_SKILLS_DIR, 'team');

let _skillsCache = null;

function escapeXml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

function normalizeSkill(raw) {
    const name = String(raw?.name || '').trim();
    if (!SKILL_NAME_PATTERN.test(name)) {
        throw new Error('Skill name must be 1-64 characters and use only letters, numbers, underscores, or dashes.');
    }
    const description = String(raw?.description || '').trim();
    const trigger = String(raw?.trigger || '').trim();
    const instructions = String(raw?.instructions || raw?.content || '').trim();
    if (!instructions) throw new Error('Skill instructions are required.');

    return {
        name,
        enabled: raw.enabled !== false,
        description,
        trigger,
        instructions,
        updatedAt: raw.updatedAt || new Date().toISOString()
    };
}

function parseSkillMd(filePath, ownerAgentId = '') {
    try {
        const text = fs.readFileSync(filePath, 'utf8');
        const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
        if (!match) return null;

        const frontmatter = {};
        match[1].split('\n').forEach(line => {
            const colonIdx = line.indexOf(':');
            if (colonIdx > 0) {
                const key = line.slice(0, colonIdx).trim();
                const val = line.slice(colonIdx + 1).trim();
                frontmatter[key] = val;
            }
        });

        const body = match[2].trim();
        if (!body) return null;

        const stat = fs.statSync(filePath);
        const owner = String(ownerAgentId || frontmatter.owner || '').trim();
        return {
            name: frontmatter.name || path.basename(path.dirname(filePath)),
            owner,
            ownerAgentId: owner,
            enabled: frontmatter.disabled !== 'true',
            description: frontmatter.description || '',
            trigger: frontmatter.trigger || '',
            instructions: body,
            updatedAt: stat.mtime.toISOString()
        };
    } catch {
        return null;
    }
}

function toSkillMd(skill) {
    const lines = ['---'];
    lines.push(`name: ${skill.name}`);
    if (skill.description) lines.push(`description: ${skill.description}`);
    if (skill.trigger) lines.push(`trigger: ${skill.trigger}`);
    if (!skill.enabled) lines.push('disabled: true');
    lines.push('---');
    lines.push('');
    lines.push(skill.instructions || '');
    return lines.join('\n');
}

function discoverSkills() {
    if (_skillsCache) return _skillsCache;

    const dirs = [SKILLS_DIR];
    if (fs.existsSync(PROJECT_SKILLS_DIR)) {
        dirs.push(PROJECT_SKILLS_DIR);
    }

    const skills = [];
    dirs.forEach(dir => {
        if (!fs.existsSync(dir)) return;
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            entries.forEach(entry => {
                if (!entry.isDirectory()) return;
                const skillMdPath = path.join(dir, entry.name, 'SKILL.md');
                if (fs.existsSync(skillMdPath)) {
                    const parsed = parseSkillMd(skillMdPath);
                    if (parsed) skills.push(parsed);
                }
            });
        } catch {}
    });

    const map = new Map();
    skills.forEach(s => map.set(s.name, s));
    _skillsCache = Array.from(map.values());
    return _skillsCache;
}

function discoverTeamSkills() {
    if (!fs.existsSync(TEAM_SKILLS_DIR)) return [];

    const skills = [];
    try {
        const ownerEntries = fs.readdirSync(TEAM_SKILLS_DIR, { withFileTypes: true });
        ownerEntries.forEach(ownerEntry => {
            if (!ownerEntry.isDirectory()) return;
            const ownerAgentId = ownerEntry.name.trim();
            if (!SKILL_NAME_PATTERN.test(ownerAgentId)) return;

            const skillEntries = fs.readdirSync(path.join(TEAM_SKILLS_DIR, ownerAgentId), { withFileTypes: true });
            skillEntries.forEach(skillEntry => {
                if (!skillEntry.isDirectory()) return;
                const skillMdPath = path.join(TEAM_SKILLS_DIR, ownerAgentId, skillEntry.name, 'SKILL.md');
                if (fs.existsSync(skillMdPath)) {
                    const parsed = parseSkillMd(skillMdPath, ownerAgentId);
                    if (parsed) {
                        parsed.source = 'team';
                        parsed.scope = ownerAgentId;
                        skills.push(parsed);
                    }
                }
            });
        });
    } catch {}

    return skills;
}

function invalidateCache() {
    _skillsCache = null;
}

function migrateFromConfig() {
    const config = getConfig();
    const configSkills = Array.isArray(config.customSkills) ? config.customSkills : [];
    if (configSkills.length === 0) return;
    if (fs.existsSync(SKILLS_DIR)) return;

    ensureDir(SKILLS_DIR);
    let migrated = 0;
    configSkills.forEach(raw => {
        try {
            const skill = normalizeSkill(raw);
            const skillDir = path.join(SKILLS_DIR, skill.name);
            ensureDir(skillDir);
            fs.writeFileSync(path.join(skillDir, 'SKILL.md'), toSkillMd(skill), 'utf8');
            migrated++;
        } catch (e) {
            console.warn(`[Skills] Failed to migrate skill "${raw?.name}": ${e.message}`);
        }
    });

    delete config.customSkills;
    saveConfig(config);
    if (migrated > 0) {
        console.log(`[Skills] Migrated ${migrated} skill(s) from config.json to ${SKILLS_DIR}`);
    }
}

function getSkills() {
    migrateFromConfig();
    return discoverSkills();
}

function getEnabledSkills() {
    return getSkills().filter(s => s.enabled);
}

function getTeamSkills(agentId = '') {
    const owner = String(agentId || '').trim();
    const skills = discoverTeamSkills().filter(s => s.enabled !== false);
    return owner ? skills.filter(s => s.ownerAgentId === owner) : skills;
}

function getSkillsForAgent(agentId = '') {
    const owner = String(agentId || '').trim();
    if (!owner) return getEnabledSkills();
    return [...getEnabledSkills(), ...getTeamSkills(owner)];
}

function saveSkill(data) {
    const normalized = normalizeSkill(data);
    const skillDir = path.join(SKILLS_DIR, normalized.name);
    ensureDir(skillDir);
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), toSkillMd(normalized), 'utf8');
    invalidateCache();
    return normalized;
}

function deleteSkill(name) {
    const normalizedName = String(name || '').trim();
    if (!SKILL_NAME_PATTERN.test(normalizedName)) {
        throw new Error('Invalid skill name.');
    }
    const skillDir = path.join(SKILLS_DIR, normalizedName);
    if (fs.existsSync(skillDir)) {
        fs.rmSync(skillDir, { recursive: true, force: true });
        invalidateCache();
        return { deleted: true };
    }
    return { deleted: false };
}

function loadSkillInstructions(name, agentId = '') {
    const owner = String(agentId || '').trim();
    let instructions;
    if (owner) {
        const teamSkill = getTeamSkills(owner).find(s => s.name === name);
        if (teamSkill) instructions = teamSkill.instructions;
    } else {
        const skill = getEnabledSkills().find(s => s.name === name);
        if (skill) instructions = skill.instructions;
    }
    if (!instructions) return null;

    // Scan for injection threats before returning to system prompt builder
    const result = scanForThreats(instructions);
    if (!result.safe) {
        console.warn(`[Skills] Threat patterns detected in skill "${name}": ${result.threats.join(', ')}`);
        return null;
    }
    return instructions;
}

function renderSkillCatalog(skills) {
    const list = skills || getEnabledSkills();
    if (!list || list.length === 0) return '';
    return list.map(skill =>
        `<skill name="${escapeXml(skill.name)}" trigger="${escapeXml(skill.trigger || '')}" owner="${escapeXml(skill.ownerAgentId || skill.owner || '')}">${escapeXml(skill.description || '')}</skill>`
    ).join('\n');
}

function renderTeamSkillCatalog(agentId) {
    const skills = getTeamSkills(agentId);
    if (!skills.length) return '';
    return `<team_skills owner="${escapeXml(agentId || '')}">\n` +
        skills.map(skill =>
            `<skill name="${escapeXml(skill.name)}" trigger="${escapeXml(skill.trigger || '')}" owner="${escapeXml(skill.ownerAgentId || skill.owner || '')}" scope="${escapeXml(skill.scope || skill.ownerAgentId || '')}">${escapeXml(skill.description || '')}</skill>`
        ).join('\n') +
        '\n</team_skills>';
}

function renderSkillsForSystem(skills) {
    return renderSkillCatalog(skills);
}

function renderTeamSkillsForSystem(agentId) {
    return renderTeamSkillCatalog(agentId);
}

module.exports = {
    deleteSkill,
    discoverTeamSkills,
    getEnabledSkills,
    getSkills,
    getSkillsForAgent,
    getTeamSkills,
    loadSkillInstructions,
    normalizeSkill,
    renderSkillCatalog,
    renderSkillsForSystem,
    renderTeamSkillCatalog,
    renderTeamSkillsForSystem,
    saveSkill,
    escapeXml,
    invalidateCache,
    migrateFromConfig
};
