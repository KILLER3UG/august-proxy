/**
 * One-line process summary for the settled ActivitySummary header.
 * Prefer a short prose gist from thinking text; callers
 * fall back to count segments when this returns null.
 */

/** Split running thinking text into sentence-ish parts (period + whitespace
 *  or paragraph breaks). The final part is the still-in-flight tail.
 *
 *  ONE owner: the live working indicator and the settled thinking card
 *  both need "the model's thinking, one sentence at a time", and two
 *  splitters would drift - the live list would show a different set of
 *  sentences from the card that claims to be the same thought. */
export function splitThinkingSentences(content: string): string[] {
  return content
    .split(/\.\s+|\n+/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/**
 * The distilled "what the model is doing" lines a thinking card renders —
 * the ONE owner of summary-split → header-distill → noise-filter → dedupe.
 * Two cards (the main rail and the subagent panel) both render this list;
 * separate pipelines drifted the moment one of them filtered noise the
 * other showed. Consecutive duplicates collapse: a thought made of several
 * noise sentences distilled each to the same "Processing request."
 * placeholder, and a card that repeats one line reads as broken.
 */
export function distillThoughtLines(content: string): string[] {
  const out: string[] = [];
  for (const line of splitThinkingSentences(content)) {
    // Recitation is dropped here rather than distilled into a placeholder, so
    // a thought made of five measurements yields its actions and not five
    // copies of one filler line (the dedupe below would collapse them anyway).
    if (isThoughtRecitation(line)) continue;
    const distilled = summarizeThoughtHeader(line, false);
    if (distilled && distilled !== out[out.length - 1]) out.push(distilled);
  }
  return out.length > 0 ? out : ['Working through the details.'];
}

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

/** A thought that states a fact is not an activity.
 *
 *  The card is a list of what the model was DOING. Sentences that recite —
 *  "the KV cache is about 36 KiB per token", "Q4_K_M is 2.6 GB", "this means
 *  the default is 512" — are the CONTENT of the reasoning, and printing them
 *  is what made the card read as a transcript of the thought instead of a
 *  summary of it. The test is deliberately narrow: a measurement with a unit,
 *  or a copula definition. A long action sentence stays. */
export function isThoughtRecitation(sentence: string): boolean {
  const s = sentence.toLowerCase();
  if (/\b\d+(?:\.\d+)?\s*(?:kib|mib|gib|kb|mb|gb|tb|ms|s|sec|w|v|a|hz|tokens?|layers?|params?)\b/.test(s)) {
    return true;
  }
  if (/^(?:the|this|that|these|those|a|an|it)\s+[\w -]{1,34}\b(?:is|are|means|refers to|stands for|equals)\b/.test(s)) {
    return true;
  }
  return false;
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

  // Pass 2b: a first-person declarative is an activity wearing a subject.
  // "I'm checking the offload settings" is the same act as "Checking the
  // offload settings", and quoting the first is what made the card read as the
  // model's own words.
  //
  // The rewrite is deliberately conservative about the verb. Stripping "We are"
  // from "We are past 6 GB" and participle-ising the next word would mint
  // "Pasting 6 GB", so a bare word is only converted when an auxiliary that
  // takes one preceded it ("I will check", "I need to weigh"); otherwise the
  // first word has to already be a participle ("I'm checking").
  const BARE_VERB_AUX = /^(?:'ll|will|shall|would|should|must|can|could|need\s+to|have\s+to)\b/i;
  for (const original of candidateSentences) {
    // Expand the contraction first. Matching `^i\b[\s']*` instead leaves a bare
    // "m" at the head of the remainder, which is why "I'm checking…" survived
    // the first version of this pass and printed verbatim.
    const s = original.replace(
      /^(i|we|you)'(m|ll|re|ve|d)\b/i,
      (_x, p: string, c: string) =>
        `${p} ${c === 'm' ? 'am' : c === 'll' ? 'will' : c === 're' ? 'are' : c === 've' ? 'have' : 'would'}`,
    );
    const head = s.match(/^(?:i|we|you)\s+(.*)$/i);
    if (!head) continue;
    let tail = head[1];
    const aux = tail.match(/^(?:am|are|will|shall|would|should|must|can|could|need\s+to|have\s+to)\b\s*/i);
    // Only an auxiliary that governs a bare infinitive licenses converting the
    // next word ("I will check" → "Checking"). "We are past 6 GB" must not
    // become "Pasting 6 GB".
    const bareVerb = aux ? BARE_VERB_AUX.test(aux[0]) : false;
    if (aux) tail = tail.slice(aux[0].length);
    tail = tail
      .replace(/^(?:also|first|now|then|just|still|probably|definitely|going\s+to)\s+/i, '')
      .trim();
    if (!tail) continue;
    const first = tail.split(/\s+/)[0].replace(/[^a-zA-Z]/g, '').toLowerCase();
    if (!first) continue;
    let participle: string | null = null;
    if (first.endsWith('ing')) participle = first;
    else if (bareVerb)
      participle =
        VERB_PARTICIPLES[first] || (first.endsWith('e') ? `${first.slice(0, -1)}ing` : `${first}ing`);
    if (!participle) continue;
    const rest = tail.split(/\s+/).slice(1).join(' ');
    const capitalized = participle[0].toUpperCase() + participle.slice(1);
    return formatHeader(rest ? `${capitalized} ${rest}` : `${capitalized}.`);
  }

  // Pass 3: Skip meta filler ("The user is asking...", "This is likely...") and
  // recitation — a stated fact is the thought's content, not the model's action.
  const informative = candidateSentences.filter(
    (s) =>
      !/^(?:the user|user is|this is likely|i should not|just show)\b/i.test(s) &&
      !isThoughtRecitation(s),
  );

  if (informative.length > 0) {
    return formatHeader(informative[0]);
  }

  // Every sentence was filler or recitation. There is no honest activity to
  // name, so say that plainly instead of quoting the model to fill the row.
  return isGenerating ? 'Thinking…' : 'Working through the details.';
}

