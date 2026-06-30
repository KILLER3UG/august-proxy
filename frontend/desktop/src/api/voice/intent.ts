/**
 * Voice intent matcher — BM25-based fuzzy matching of voice transcripts to commands.
 * 
 * Spec: docs/superpowers/specs/2026-06-30-voice-command-ui-infrastructure-design.md
 * 
 * Usage:
 *   const cmd = matchIntent("switch model", COMMANDS);
 *   if (cmd) dispatch(cmd, transcript);
 */

import type { ChatCommand } from '@/sections/chat/commands-data';

// ── BM25 Parameters ────────────────────────────────────────────────────────

const K1 = 1.2;
const B = 0.75;

// ── Tokenizer ──────────────────────────────────────────────────────────────

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 0);
}

// ── BM25 Scoring ───────────────────────────────────────────────────────────

interface Document {
  command: ChatCommand;
  tokens: string[];
}

function bm25(query: string[], doc: Document, avgDocLen: number, idf: Map<string, number>): number {
  const docLen = doc.tokens.length;
  let score = 0;

  for (const term of query) {
    const termFreq = doc.tokens.filter(t => t === term).length;
    if (termFreq === 0) continue;

    const idfScore = idf.get(term) || 0;
    const numerator = termFreq * (K1 + 1);
    const denominator = termFreq + K1 * (1 - B + B * (docLen / avgDocLen));

    score += idfScore * (numerator / denominator);
  }

  return score;
}

function computeIDF(docs: Document[], term: string): number {
  const docsWithTerm = docs.filter(d => d.tokens.includes(term)).length;
  if (docsWithTerm === 0) return 0;
  return Math.log((docs.length - docsWithTerm + 0.5) / (docsWithTerm + 0.5) + 1);
}

// ── Intent Matcher ─────────────────────────────────────────────────────────

/**
 * Match a voice transcript to a command using BM25.
 * 
 * @param transcript - Raw voice transcript (e.g., "switch model")
 * @param commands - Array of ChatCommand with voiceTriggers
 * @param threshold - Minimum BM25 score to accept (default 1.0)
 * @returns Matched command or null if no match above threshold
 */
export function matchIntent(
  transcript: string,
  commands: ChatCommand[],
  threshold = 1.0
): ChatCommand | null {
  const query = tokenize(transcript);
  if (query.length === 0) return null;

  // Build documents from voice triggers
  const docs: Document[] = [];
  for (const cmd of commands) {
    if (!cmd.voiceTriggers || cmd.voiceTriggers.length === 0) continue;
    const tokens = cmd.voiceTriggers.flatMap(t => tokenize(t));
    docs.push({ command: cmd, tokens });
  }

  if (docs.length === 0) return null;

  // Compute IDF for all query terms
  const idf = new Map<string, number>();
  for (const term of query) {
    idf.set(term, computeIDF(docs, term));
  }

  // Compute average document length
  const avgDocLen = docs.reduce((sum, d) => sum + d.tokens.length, 0) / docs.length;

  // Score all documents
  const scores = docs.map(doc => ({
    command: doc.command,
    score: bm25(query, doc, avgDocLen, idf),
  }));

  // Find best match above threshold
  scores.sort((a, b) => b.score - a.score);
  const best = scores[0];

  if (best && best.score >= threshold) {
    return best.command;
  }

  return null;
}

/**
 * Check if a transcript is likely a command (not dictation).
 * 
 * Heuristic: If the transcript is short (< 6 words) and contains a command trigger word,
 * it's probably a command. Otherwise, it's dictation.
 */
export function isLikelyCommand(transcript: string, commands: ChatCommand[]): boolean {
  const tokens = tokenize(transcript);
  if (tokens.length > 6) return false; // Long phrases are dictation

  const triggerWords = new Set(
    commands.flatMap(c => c.voiceTriggers || []).flatMap(t => tokenize(t))
  );

  // If any token matches a trigger word, it's likely a command
  return tokens.some(t => triggerWords.has(t));
}
