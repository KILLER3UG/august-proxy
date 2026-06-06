// ── Lightweight token estimation (no heavy deps like tiktoken) ──
// Uses character-based heuristics that are "good enough" for compaction decisions.
// English ASCII: ~4 chars per token
// CJK / Unicode: ~1.5 chars per token
// Overhead per message: ~4 tokens (role marker + formatting)
// Overhead per tool definition: ~50 tokens (schema + description)

function estimateStringTokens(str) {
  if (!str) return 0;
  let tokens = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    // CJK Unified Ideographs
    if (code >= 0x4E00 && code <= 0x9FFF) { tokens += 0.67; continue; }
    // CJK Extension A
    if (code >= 0x3400 && code <= 0x4DBF) { tokens += 0.67; continue; }
    // CJK Punctuation
    if (code >= 0x3000 && code <= 0x303F) { tokens += 0.67; continue; }
    // Fullwidth forms
    if (code >= 0xFF00 && code <= 0xFFEF) { tokens += 0.67; continue; }
    // Hiragana / Katakana
    if (code >= 0x3040 && code <= 0x309F) { tokens += 0.67; continue; }
    if (code >= 0x30A0 && code <= 0x30FF) { tokens += 0.67; continue; }
    // Hangul
    if (code >= 0xAC00 && code <= 0xD7AF) { tokens += 0.67; continue; }
    // ASCII and everything else: ~4 chars/token
    tokens += 0.25;
  }
  return Math.ceil(tokens);
}

function estimateMessageContent(content) {
  if (!content) return 0;
  if (typeof content === 'string') {
    return estimateStringTokens(content);
  }
  if (Array.isArray(content)) {
    return content.reduce((sum, part) => {
      if (part.type === 'text' && part.text) return sum + estimateStringTokens(part.text);
      if (part.type === 'image_url' || part.type === 'input_image') return sum + 512; // Image placeholder
      if (part.type === 'tool_result' && part.content) return sum + estimateStringTokens(typeof part.content === 'string' ? part.content : JSON.stringify(part.content));
      if (part.type === 'tool_use') return sum + estimateStringTokens(JSON.stringify(part.input || {}));
      return sum + estimateStringTokens(JSON.stringify(part));
    }, 0);
  }
  return estimateStringTokens(JSON.stringify(content));
}

function estimateMessageTokens(msg) {
  if (!msg) return 0;
  // Base overhead per message (role + structure)
  let tokens = 4;
  tokens += estimateMessageContent(msg.content);
  // Tool calls add overhead
  if (msg.tool_calls) {
    msg.tool_calls.forEach(tc => {
      tokens += 10; // tool call structure
      tokens += estimateStringTokens(tc.function?.name || '');
      tokens += estimateStringTokens(tc.function?.arguments || '');
      tokens += estimateStringTokens(tc.id || '');
    });
  }
  if (msg.tool_call_id) {
    tokens += 4 + estimateStringTokens(msg.tool_call_id);
  }
  return tokens;
}

function estimateToolTokens(tools) {
  if (!tools || !Array.isArray(tools)) return 0;
  return tools.reduce((sum, tool) => {
    let t = 50; // base tool overhead
    t += estimateStringTokens(tool.function?.name || tool.name || '');
    t += estimateStringTokens(tool.function?.description || tool.description || '');
    t += estimateStringTokens(JSON.stringify(tool.function?.parameters || tool.input_schema || {}));
    return sum + t;
  }, 0);
}

function estimateTokens(messages, tools) {
  if (!messages || !Array.isArray(messages)) return 0;
  let total = 3; // base prompt overhead
  total += messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
  if (tools) total += estimateToolTokens(tools);
  return Math.ceil(total);
}

function formatTokenCount(n) {
  if (n >= 1000000) return (n / 1048576).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1024).toFixed(1) + 'K';
  return n.toString();
}

module.exports = {
  estimateStringTokens,
  estimateMessageTokens,
  estimateTokens,
  estimateToolTokens,
  formatTokenCount
};
