/**
 * One-line process summary for the settled ActivitySummary header.
 * Prefer a short prose gist from thinking text; callers
 * fall back to count segments when this returns null.
 */

export function buildProcessSummaryLine(thinkingParts: string[]): string | null {
  const joined = thinkingParts
    .map((t) =>
      t
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`[^`]+`/g, ' ')
        .replace(/[#*_>[\]()-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter(Boolean)
    .join(' ');

  if (joined.length < 12) return null;

  // Prefer a complete first sentence when it is a useful length.
  const sentenceMatch = joined.match(/^(.{12,140}?[.!?])(?:\s|$)/);
  let line = (sentenceMatch?.[1] || joined.slice(0, 110)).trim();
  if (!sentenceMatch && joined.length > line.length) {
    line = line.replace(/\s+\S*$/, '').trim();
  }
  if (line.length < 12) return null;

  if (/^[a-z]/.test(line)) {
    line = line[0].toUpperCase() + line.slice(1);
  }
  return line;
}

const VERB_PARTICIPLES: Record<string, string> = {
  load: 'Loading',
  loading: 'Loading',
  check: 'Checking',
  checking: 'Checking',
  search: 'Searching',
  searching: 'Searching',
  find: 'Finding',
  finding: 'Finding',
  verify: 'Verifying',
  verifying: 'Verifying',
  run: 'Running',
  running: 'Running',
  test: 'Testing',
  testing: 'Testing',
  draft: 'Drafting',
  drafting: 'Drafting',
  write: 'Writing',
  writing: 'Writing',
  inspect: 'Inspecting',
  inspecting: 'Inspecting',
  analyze: 'Analyzing',
  analyzing: 'Analyzing',
  analyse: 'Analyzing',
  analysing: 'Analyzing',
  evaluate: 'Evaluating',
  evaluating: 'Evaluating',
  consider: 'Considering',
  considering: 'Considering',
  weigh: 'Weighing',
  weighing: 'Weighing',
  compare: 'Comparing',
  comparing: 'Comparing',
  examine: 'Examining',
  examining: 'Examining',
  explore: 'Exploring',
  exploring: 'Exploring',
  review: 'Reviewing',
  reviewing: 'Reviewing',
  investigate: 'Investigating',
  investigating: 'Investigating',
  format: 'Formatting',
  formatting: 'Formatting',
  create: 'Creating',
  creating: 'Creating',
  update: 'Updating',
  updating: 'Updating',
  add: 'Adding',
  adding: 'Adding',
  remove: 'Removing',
  removing: 'Removing',
  delete: 'Deleting',
  deleting: 'Deleting',
  fix: 'Fixing',
  fixing: 'Fixing',
  read: 'Reading',
  reading: 'Reading',
  prepare: 'Preparing',
  preparing: 'Preparing',
  synthesize: 'Synthesizing',
  synthesizing: 'Synthesizing',
  formulate: 'Formulating',
  formulating: 'Formulating',
  refine: 'Refining',
  refining: 'Refining',
  determine: 'Determining',
  determining: 'Determining',
  identify: 'Identifying',
  identifying: 'Identifying',
  look: 'Looking into',
  looking: 'Looking into',
  see: 'Checking',
  understand: 'Understanding',
  understanding: 'Understanding',
  execute: 'Executing',
  executing: 'Executing',
  query: 'Querying',
  querying: 'Querying',
  simulate: 'Simulating',
  simulating: 'Simulating',
};

function isTechnicalNoise(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length < 4) return true;
  // Netlists: component letter + number (e.g. V1, R1, C1, L2, M1, Q1)
  if (/^[vircmldqxy]\d+\b/i.test(trimmed)) return true;
  // SPICE directives starting with a dot (e.g. .ac, .control, .endc, .end, .model, .tran)
  if (/^\.[a-z]+/i.test(trimmed)) return true;
  // Special characters at start
  if (/^[#$!~/*&%@;]/.test(trimmed)) return true;
  if (
    /(\.ac\s|\.control|\.endc|\.end|vout_max|==|!=|=>|->|::|;|\bAC\s+1\b|\bfind\s+v\(|\b0\s+1u\b)/i.test(
      trimmed,
    )
  ) {
    return true;
  }
  // Code syntax
  if (
    /^(?:import|export|const|let\s+[a-z0-9_]+\s*=|var|function|def|class|return|curl|npm|where|cd|ls|cat|echo)\b/i.test(
      trimmed,
    )
  ) {
    return true;
  }
  // Short status affirmations
  if (/^(?:ok|okay|yes|sure|done|passed|failed|right|now)\.?$/i.test(trimmed)) {
    return true;
  }
  return false;
}

function cleanThinkingText(raw: string): string {
  return raw
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]+`/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[#*_~]+/g, ' ')
    .replace(/\r\n/g, '\n')
    .trim();
}

function formatHeader(sentence: string): string {
  let h = sentence
    .replace(/^(?:so|and|then|also|okay|ok|well|now|next|sure),?\s*/i, '')
    .trim();

  // Strip trailing secondary clauses like ", then try to use it" or ", and then..."
  h = h
    .replace(/,\s*(?:then|and then|so that|in order to|and try to|and see|and ask)\b.*$/i, '')
    .trim();

  // If sentence contains trailing filler clauses, clamp at natural boundary
  if (h.length > 85) {
    const clauseIdx = h
      .slice(0, 85)
      .search(/,\s+|\s+and then\s+|\s+so that\s+|\s+in order to\s+|\s+and ask\s+/i);
    if (clauseIdx > 25) {
      h = h.slice(0, clauseIdx);
    } else {
      h = h.slice(0, 80).replace(/\s+\S*$/, '');
    }
  }

  // Ensure first letter is capitalized
  if (/^[a-z]/.test(h)) {
    h = h[0].toUpperCase() + h.slice(1);
  }

  // Ensure ends with period
  if (!/[.!?]$/.test(h)) {
    h = `${h}.`;
  }

  return h;
}

export function summarizeThoughtHeader(text: string, isGenerating = false): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return isGenerating ? 'Thinking…' : 'Thinking.';
  }

  const cleaned = cleanThinkingText(trimmed);
  // Split into sentence-like segments (including sentences ending in quotes)
  const rawSegments = cleaned
    .split(/(?<=[.!?]["')\]]?)\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 6);

  const candidateSentences = rawSegments.filter((s) => !isTechnicalNoise(s));

  if (candidateSentences.length === 0) {
    return isGenerating ? 'Thinking…' : 'Processing request.';
  }

  // Pass 1: Look for natural participle openers ("Weighing...", "Drafting...", "Checking...")
  for (const s of candidateSentences) {
    const words = s.split(/\s+/);
    const firstWord = words[0]?.toLowerCase().replace(/[^a-z]/g, '');
    if (firstWord && VERB_PARTICIPLES[firstWord] && firstWord.endsWith('ing')) {
      return formatHeader(s);
    }
  }

  // Pass 2: Look for intent phrases ("Let me load...", "I'll check...", "Next I'm checking...", "I need to verify...")
  for (const s of candidateSentences) {
    const intentMatch = s.match(
      /(?:let me|i will|i'll|i need to|i should|plan is to|plan to|going to|next i'm|now i'm|now)\s+(?:try to\s+|also\s+|first\s+)?([a-z]+)\b\s*(.*)/i,
    );
    if (intentMatch) {
      const verb = intentMatch[1].toLowerCase();
      const rest = intentMatch[2].trim();
      const participle =
        VERB_PARTICIPLES[verb] ||
        (verb.endsWith('e') ? `${verb.slice(0, -1)}ing` : `${verb}ing`);
      if (rest) {
        const capitalized = participle[0].toUpperCase() + participle.slice(1);
        return formatHeader(`${capitalized} ${rest}`);
      }
    }
  }

  // Pass 3: Skip meta filler sentences ("The user is asking...", "The user wants...", "This is likely...")
  const informative = candidateSentences.filter(
    (s) => !/^(?:the user|user is|this is likely|i should not|just show)\b/i.test(s),
  );

  if (informative.length > 0) {
    return formatHeader(informative[0]);
  }

  // Fallback: Take the first candidate sentence
  return formatHeader(candidateSentences[0]);
}

