/**
 * Voice Command Registry — extensible plugin-style registry that maps voice
 * transcripts (and slash commands) to handlers, with optional inline UI cards.
 *
 * Spec: docs/superpowers/specs/2026-06-30-voice-subagent-provider-overhaul-design.md
 *
 * Usage:
 *   import { voiceCommandRegistry } from '@/api/voice/registry';
 *   const matched = voiceCommandRegistry.matchCommand('switch model');
 *   if (matched) matched.handler({ sessionId, transcript, messages, setMessages });
 *
 * Extension (for plugins):
 *   voiceCommandRegistry.register({ id, triggers, handler, category: 'plugin' });
 */

// ── Types ──────────────────────────────────────────────────────────────────

export interface VoiceCommandContext {
  sessionId: string;
  transcript: string;
  args?: string;
  messages: ChatMessageLite[];
  setMessages: React.Dispatch<React.SetStateAction<ChatMessageLite[]>>;
}

/**
 * Minimal chat message shape used by handlers so this file doesn't depend
 * on the heavier ChatMessage type. Cast on the consumer side as needed.
 */
export interface ChatMessageLite {
  id?: string;
  role: 'user' | 'assistant' | 'system';
  kind?: string;
  content?: string;
  commandId?: string;
  breakdown?: unknown;
  context?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface VoiceCommandCardProps {
  sessionId: string;
  onDismiss: () => void;
  context?: Record<string, unknown>;
}

export type VoiceCommandCategory = 'core' | 'plugin';

export type VoiceCommandHandler = (
  context: VoiceCommandContext,
) => void | Promise<void>;

export interface VoiceCommandDefinition {
  id: string;
  triggers: string[];
  slashCommand?: string;
  handler: VoiceCommandHandler;
  uiCard?: React.ComponentType<VoiceCommandCardProps>;
  category: VoiceCommandCategory;
  description: string;
}

// ── Matcher helpers ────────────────────────────────────────────────────────

/** Lowercase, strip punctuation, collapse whitespace. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(text: string): string[] {
  return normalize(text).split(' ').filter(t => t.length > 0);
}

interface ScoredCandidate {
  command: VoiceCommandDefinition;
  score: number;
  exactOverlap: number;
}

const THRESHOLD = 0.6;
const SUBSTRING_BONUS = 2;

/** Score a single command's triggers against a normalized transcript. */
function scoreCommand(
  command: VoiceCommandDefinition,
  transcriptNorm: string,
  transcriptTokens: string[],
): { score: number; exactOverlap: number } {
  let bestScore = 0;
  let bestExactOverlap = 0;

  for (const trigger of command.triggers) {
    const triggerTokens = tokenize(trigger);
    if (triggerTokens.length === 0) continue;

    // Substring bonus — exact substring match on the normalized transcript.
    if (
      transcriptNorm.length > 0 &&
      trigger.length > 0 &&
      transcriptNorm.includes(trigger)
    ) {
      bestScore = Math.max(bestScore, SUBSTRING_BONUS);
    }

    // Token overlap ratio (intersection / max(trigger, transcript) tokens).
    const transcriptSet = new Set(transcriptTokens);
    const triggerSet = new Set(triggerTokens);
    let matched = 0;
    for (const t of triggerSet) {
      if (transcriptSet.has(t)) matched += 1;
    }
    const denom = Math.max(triggerTokens.length, transcriptTokens.length);
    if (denom > 0) {
      const ratio = matched / denom;
      bestScore = Math.max(bestScore, ratio);
      if (matched === triggerSet.size) {
        bestExactOverlap = Math.max(bestExactOverlap, ratio);
      }
    }
  }

  return { score: bestScore, exactOverlap: bestExactOverlap };
}

// ── Registry ───────────────────────────────────────────────────────────────

/**
 * Singleton registry. Backed by an insertion-ordered array so
 * getAllCommands() returns commands in registration order.
 */
class VoiceCommandRegistry {
  private definitions: VoiceCommandDefinition[] = [];
  private ids = new Set<string>();

  /**
   * Register a new voice command. Throws if `id` is already registered.
   */
  register(definition: VoiceCommandDefinition): void {
    if (this.ids.has(definition.id)) {
      throw new Error(`voiceCommandRegistry: duplicate id "${definition.id}"`);
    }
    this.ids.add(definition.id);
    this.definitions.push(definition);
  }

  /**
   * Remove a registered voice command by id. Returns true if removed.
   */
  unregister(id: string): boolean {
    const idx = this.definitions.findIndex(d => d.id === id);
    if (idx === -1) return false;
    this.definitions.splice(idx, 1);
    this.ids.delete(id);
    return true;
  }

  /** Returns a registered definition by id, or null. */
  getById(id: string): VoiceCommandDefinition | null {
    return this.definitions.find(d => d.id === id) ?? null;
  }

  /**
   * Returns a registered definition whose slashCommand equals the given
   * name (e.g. '/model'). Returns null if no match.
   */
  getBySlashCommand(slashCommand: string): VoiceCommandDefinition | null {
    return (
      this.definitions.find(d => d.slashCommand === slashCommand) ?? null
    );
  }

  /**
   * Returns the best match for a normalized transcript. Returns null if no
   * candidate scores above THRESHOLD.
   *
   * Algorithm (per spec):
   *   1. Normalize transcript.
   *   2. Tokenize.
   *   3. For each registered command, score each of its triggers.
   *      - Exact substring match: score += 2
   *      - Token overlap ratio: score += (matched / max(trigger, transcript))
   *   4. Take command's max score across its triggers.
   *   5. Discard scores below 0.6.
   *   6. Return highest-scoring command; null if no match.
   *   7. Tie-break: prefer more exact token overlap, then first-registered.
   */
  matchCommand(transcript: string): VoiceCommandDefinition | null {
    const transcriptNorm = normalize(transcript);
    if (transcriptNorm.length === 0) return null;
    const transcriptTokens = tokenize(transcript);
    if (transcriptTokens.length === 0) return null;

    const candidates: ScoredCandidate[] = [];
    for (const cmd of this.definitions) {
      if (cmd.triggers.length === 0) continue;
      const { score, exactOverlap } = scoreCommand(
        cmd,
        transcriptNorm,
        transcriptTokens,
      );
      if (score >= THRESHOLD) {
        candidates.push({ command: cmd, score, exactOverlap });
      }
    }

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.exactOverlap !== a.exactOverlap) {
        return b.exactOverlap - a.exactOverlap;
      }
      // First-registered wins.
      return (
        this.definitions.indexOf(a.command) -
        this.definitions.indexOf(b.command)
      );
    });

    return candidates[0].command;
  }

  /** All registered commands, in registration order. */
  getAllCommands(): VoiceCommandDefinition[] {
    return [...this.definitions];
  }

  /** Registered commands filtered by category, in registration order. */
  getCommandsByCategory(category: VoiceCommandCategory): VoiceCommandDefinition[] {
    return this.definitions.filter(d => d.category === category);
  }

  /** Total number of registered commands. */
  size(): number {
    return this.definitions.length;
  }

  /** Wipe the registry. Intended for tests only. */
  clear(): void {
    this.definitions = [];
    this.ids.clear();
  }
}

export const voiceCommandRegistry = new VoiceCommandRegistry();

// ── Display helpers ────────────────────────────────────────────────────────

/**
 * Shape used by ChatComposer dropdown and CommandHelpCard. Derived from
 * the registry so the two surfaces stay in sync with handler definitions.
 */
export interface DisplayCommand {
  name: string;           // slash command, e.g. "/model"; falls back to id
  desc: string;
  category: string;
  voiceTriggers: string[];
  usage?: string;
  example?: string;
}

export function toDisplayCommand(
  def: VoiceCommandDefinition,
): DisplayCommand {
  return {
    name: def.slashCommand ?? def.id,
    desc: def.description,
    category: def.category,
    voiceTriggers: [...def.triggers],
  };
}

export function getDisplayCommands(): DisplayCommand[] {
  return voiceCommandRegistry.getAllCommands().map(toDisplayCommand);
}

// Exposed for unit tests.
export const __testing = {
  normalize,
  tokenize,
  scoreCommand,
  THRESHOLD,
  SUBSTRING_BONUS,
};
