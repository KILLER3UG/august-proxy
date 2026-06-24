/**
 * threat-patterns.js — Scans content for prompt injection patterns before it
 * enters the system prompt or memory store.
 *
 * Hook points (all verified in source):
 *   - core-memory.js writeAugustCoreMemory()
 *   - skills.js / skills-v2.js loadSkillInstructions()
 *   - auto-memory.js extractAndSaveMemories()
 *   - august__skill_create / august__skill_edit dispatch
 */

class ThreatScanner {
  /**
   * Scan content for known injection patterns.
   * @param {string} content - The text to scan
   * @returns {{ safe: boolean, threats: string[] }}
   */
  scan(content) {
    if (!content || typeof content !== 'string') return { safe: true, threats: [] };

    const threats = [];

    // 1. System prompt override patterns
    if (PATTERN_SYSTEM_OVERRIDE.test(content)) {
      threats.push('system override instruction detected');
    }

    // 2. Role-play / persona change patterns
    if (PATTERN_ROLE_PLAY.test(content)) {
      threats.push('role-play persona change detected');
    }

    // 3. Exfiltration patterns
    if (PATTERN_EXFILTRATION.test(content)) {
      threats.push('data exfiltration attempt detected');
    }

    // 4. Memory manipulation patterns
    if (PATTERN_MEMORY_MANIPULATION.test(content)) {
      threats.push('memory manipulation attempt detected');
    }

    return {
      safe: threats.length === 0,
      threats
    };
  }
}

// Case-insensitive patterns for injection detection
const PATTERN_SYSTEM_OVERRIDE = /ignore\s+(all\s+)?previous\s+(instructions|commands|directives|system\s+prompt)|you\s+(are\s+now|must\s+ignore)|new\s+system\s+prompt|override\s+(all\s+)?(instructions|commands)/i;

const PATTERN_ROLE_PLAY = /pretend\s+(to\s+)?be|act\s+as\s+(if\s+)?(you\s+are\s+)?|from\s+now\s+on\s+(you\s+are\s+)?|you\s+are\s+not\s+(an?\s+)?(ai|assistant|claude)|forget\s+(that\s+)?you\s+are/i;

const PATTERN_EXFILTRATION = /send\s+(this|the\s+(above|following))\s+(to|via)|(POST|upload|exfiltrate)\s+(this|the|to)|steal\s+(this|the|these)|copy\s+(all\s+)?(the\s+)?(above|following)\s+(to|and)/i;

const PATTERN_MEMORY_MANIPULATION = /delete\s+(all\s+)?(memories|stored|saved)|erase\s+(your\s+)?(memory|context)|clear\s+(your\s+)?(context|history|memory|state)|forget\s+(everything|all\s+prior)/i;

const _scanner = new ThreatScanner();

/**
 * Check if content contains injection threats.
 * Convenience wrapper returning true/false.
 */
function containsThreats(content) {
  return !_scanner.scan(content).safe;
}

/**
 * Validate content and return result.
 */
function scanForThreats(content) {
  return _scanner.scan(content);
}

module.exports = {
  ThreatScanner,
  containsThreats,
  scanForThreats
};
