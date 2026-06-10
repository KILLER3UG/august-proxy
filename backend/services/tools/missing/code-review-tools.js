/**
 * code-review-tools.js — Code review and quality analysis tools.
 * Inspired by OpenCode's code review capability.
 * Provides:
 * - august__review_code: Review source code for issues (security, performance, style, correctness)
 * - august__suggest_improvements: Suggest code improvements and refactoring analysis
 *
 * Both tools call the active LLM provider with structured review prompts.
 */

const { z } = require('zod');
const https = require('https');

// ── LLM Call Helpers ──

function getConfiguredProvider() {
  // Try to extract from env — adapters might have this
  return process.env.AUGUST_PROVIDER || process.env.LLM_PROVIDER || 'openai';
}

function getOpenAIKey() {
  return process.env.OPENAI_API_KEY || process.env.AUGUST_OPENAI_KEY || '';
}

function httpsPost(url, data, headers = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const postData = JSON.stringify(data);
    const options = {
      method: 'POST',
      hostname: urlObj.hostname,
      path: urlObj.pathname,
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 120000
    };

    const req = https.request(options, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.write(postData);
    req.end();
  });
}

// ── Review Prompts ──

function buildReviewPrompt(code, language, focus) {
  const languageHint = language ? ` in ${language}` : '';

  const focusInstructions = {
    security: 'Focus on SECURITY vulnerabilities: injection flaws, XSS, CSRF, authentication issues, insecure deserialization, path traversal, hardcoded secrets, and other OWASP Top 10 categories.',
    performance: 'Focus on PERFORMANCE issues: algorithmic inefficiency, memory leaks, unnecessary allocations, blocking operations, database query N+1 problems, cache misses, and concurrency bottlenecks.',
    style: 'Focus on CODE STYLE and maintainability: naming conventions, code organization, readability, adherence to language idioms, DRY violations, overly complex functions, and documentation quality.',
    correctness: 'Focus on CORRECTNESS: logic errors, edge cases, race conditions, type mismatches, off-by-one errors, null/undefined dereferences, incorrect API usage, and boundary conditions.'
  };

  const focusText = focusInstructions[focus] || focusInstructions.correctness;

  return `You are an expert code reviewer. Review the following code${languageHint} and provide detailed feedback.

${focusText}

Analyze the code thoroughly and provide your review in this structured format:

## Summary
Brief overview of the code's purpose and overall assessment.

## Issues Found
For each issue, include:
- **Severity**: critical/high/medium/low
- **Category**: (security|performance|style|correctness)
- **Location**: line number or code section
- **Description**: What the issue is
- **Impact**: How it affects the codebase
- **Fix**: Specific code suggestion to resolve it

## Recommendations
- Top improvements ordered by priority
- Best practices that should be followed

## Positive Aspects
What the code does well.

\`\`\`${language || ''}
// CODE TO REVIEW
${code}
\`\`\`

Please be thorough and specific. Include line numbers and code snippets in your suggestions.`;
}

function buildImprovementPrompt(code, context) {
  const contextBlock = context ? `\nContext: ${context}\n` : '';

  return `You are an expert software architect and refactoring specialist. Analyze the following code and suggest concrete improvements.

${contextBlock}

Focus on:
1. **Refactoring opportunities** — can the code be restructured for better maintainability?
2. **Design patterns** — would a known design pattern improve the architecture?
3. **Duplication** — are there repeated patterns that could be extracted?
4. **Testability** — is the code easy to test? If not, how to improve it?
5. **Error handling** — are errors handled gracefully?
6. **API design** — are the interfaces clean and intuitive?
7. **Extensibility** — how easy would it be to add new features?

For each suggestion, provide:
- **Current code**: What it looks like now
- **Suggested code**: The improved version
- **Rationale**: Why this change improves the codebase

\`\`\`
${code}
\`\`\`

Be practical and specific. Only suggest changes that provide clear value.`;
}

// ── LLM Call ──

async function callLLMForReview(systemPrompt, userContent, ctx = {}) {
  // Try provider adapter first
  try {
    const provider = ctx.provider || getConfiguredProvider();
    if (ctx.adapters && typeof ctx.adapters.chat === 'function') {
      const result = await ctx.adapters.chat({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent }
        ],
        max_tokens: 4000,
        temperature: 0.3
      });
      return result;
    }
  } catch (e) {
    // Fall through
  }

  // Fallback: direct OpenAI API call
  const apiKey = getOpenAIKey();
  if (!apiKey) {
    // Return a generated review without an LLM call
    return generateLocalReview(userContent);
  }

  try {
    const result = await httpsPost(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent }
        ],
        max_tokens: 4000,
        temperature: 0.3
      },
      { 'Authorization': `Bearer ${apiKey}` }
    );

    if (result.status >= 400) {
      let errorMsg = `API returned status ${result.status}`;
      try {
        const errBody = JSON.parse(result.body);
        errorMsg += `: ${errBody.error?.message || result.body.slice(0, 200)}`;
      } catch { errorMsg += `: ${result.body.slice(0, 200)}`; }
      return { error: errorMsg };
    }

    const parsed = JSON.parse(result.body);
    const content = parsed.choices?.[0]?.message?.content || '';
    return { content, model: parsed.model, usage: parsed.usage };
  } catch (e) {
    // If API call fails, generate a local static review
    return generateLocalReview(userContent);
  }
}

// ── Local Static Review Fallback ──

function generateLocalReview(codeBlock) {
  // Extract the actual code from the prompt block
  const codeMatch = codeBlock.match(/```(?:\w*)\n([\s\S]*?)```/);
  const code = codeMatch ? codeMatch[1].trim() : codeBlock;

  if (!code) {
    return {
      content: 'No code provided for review.',
      generated_locally: true
    };
  }

  const lines = code.split('\n');
  const lineCount = lines.length;
  const charCount = code.length;
  const hasTodos = code.includes('TODO') || code.includes('FIXME') || code.includes('HACK');
  const hasConsole = code.includes('console.log') || code.includes('console.error');
  const hasComments = code.includes('//') || code.includes('/*') || code.includes('*');
  const longLines = lines.filter(l => l.length > 100).length;

  const issues = [];

  if (hasConsole) {
    issues.push({
      severity: 'low',
      category: 'style',
      description: 'Console logging statements found. Consider removing or replacing with a proper logging framework before production.',
      line: 'multiple locations'
    });
  }

  if (hasTodos) {
    issues.push({
      severity: 'info',
      category: 'maintainability',
      description: 'Code contains TODO/FIXME/HACK comments that should be addressed.',
      line: 'various'
    });
  }

  if (longLines > 2) {
    issues.push({
      severity: 'low',
      category: 'style',
      description: `${longLines} line(s) exceed 100 characters. Consider breaking long lines for readability.`,
      line: `lines with >100 chars`
    });
  }

  if (lineCount > 300) {
    issues.push({
      severity: 'medium',
      category: 'maintainability',
      description: `File is very large (${lineCount} lines). Consider splitting into smaller modules.`,
      line: 'entire file'
    });
  }

  if (lineCount < 3) {
    issues.push({
      severity: 'info',
      category: 'completeness',
      description: 'Code is very short. Verify the complete code was provided for review.',
      line: 'entire file'
    });
  }

  // Basic language detection
  let language = 'unknown';
  if (code.includes('function') || code.includes('const ') || code.includes('let ') || code.includes('=>')) {
    language = 'JavaScript/TypeScript';
  } else if (code.includes('def ') || code.includes('import ') || code.includes('class ')) {
    language = 'Python';
  } else if (code.includes('{') && code.includes('}') && (code.includes('int ') || code.includes('void ') || code.includes('#include'))) {
    language = 'C/C++';
  }

  return {
    content: `## Static Analysis (LLM unavailable — local analysis)

**File Stats:** ${lineCount} lines, ${charCount} characters
**Detected Language:** ${language}
**Review Type:** Basic static analysis (no AI review available)

### Issues Found (${issues.length})

${issues.map(i => `- **[${i.severity.toUpperCase()}]** ${i.category}: ${i.description} (${i.line})`).join('\n')}

### Limitations
This is a basic static analysis performed without an LLM. For a thorough review including semantic analysis, security auditing, and best-practice recommendations, please configure an LLM provider (set OPENAI_API_KEY or ensure the provider adapter supports chat completions).`,
    generated_locally: true
  };
}

// ── Tool: august__review_code ──

const REVIEW_CODE_SCHEMA = z.object({
  code: z.string().min(1).max(50000).describe('The source code to review'),
  language: z.string().optional().describe('The programming language (e.g., javascript, python, go). Helps focus the review.'),
  focus: z.enum(['security', 'performance', 'style', 'correctness'])
    .optional().default('correctness')
    .describe('Area of focus for the review')
});

async function reviewCodeHandler(args, ctx = {}) {
  const { code, language, focus } = args;

  try {
    const systemPrompt = 'You are an expert code reviewer. Provide thorough, actionable feedback.';
    const userPrompt = buildReviewPrompt(code, language || 'auto', focus || 'correctness');

    const result = await callLLMForReview(systemPrompt, userPrompt, ctx);

    if (result.error) {
      return { error: result.error };
    }

    return {
      review: result.content,
      language: language || 'auto',
      focus: focus || 'correctness',
      model: result.model || 'local-static',
      generated_locally: result.generated_locally || false,
      code_length: code.length,
      code_lines: code.split('\n').length
    };
  } catch (e) {
    return { error: `Code review failed: ${e.message}` };
  }
}

// ── Tool: august__suggest_improvements ──

const SUGGEST_IMPROVEMENTS_SCHEMA = z.object({
  code: z.string().min(1).max(50000).describe('The source code to analyze for improvements'),
  context: z.string().max(2000).optional().describe('Optional context about the codebase, what the code does, or specific areas of concern')
});

async function suggestImprovementsHandler(args, ctx = {}) {
  const { code, context } = args;

  try {
    const systemPrompt = 'You are an expert software architect specializing in code refactoring and design improvement.';
    const userPrompt = buildImprovementPrompt(code, context || '');

    const result = await callLLMForReview(systemPrompt, userPrompt, ctx);

    if (result.error) {
      return { error: result.error };
    }

    return {
      suggestions: result.content,
      context: context || null,
      model: result.model || 'local-static',
      generated_locally: result.generated_locally || false,
      code_length: code.length,
      code_lines: code.split('\n').length
    };
  } catch (e) {
    return { error: `Improvement analysis failed: ${e.message}` };
  }
}

// ── Tool Definitions ──

const toolDefinitions = [
  {
    name: 'august__review_code',
    description: 'Review source code for issues. Analyzes security vulnerabilities, performance problems, style issues, or correctness bugs. Calls the active LLM provider (or falls back to local static analysis if no provider is configured).',
    schema: REVIEW_CODE_SCHEMA,
    handler: reviewCodeHandler,
    permissions: { category: 'read', destructive: false },
    toolset: 'missing',
    emoji: '\u{1F50D}',
    timeoutMs: 120000,
    requiresEnv: [],
    metadata: { category: 'code-review', source: 'missing-tools' }
  },
  {
    name: 'august__suggest_improvements',
    description: 'Suggest code improvements and refactoring opportunities. Analyzes code structure, design patterns, testability, and extensibility. Calls the active LLM provider for intelligent suggestions.',
    schema: SUGGEST_IMPROVEMENTS_SCHEMA,
    handler: suggestImprovementsHandler,
    permissions: { category: 'read', destructive: false },
    toolset: 'missing',
    emoji: '\u{1F4A1}',
    timeoutMs: 120000,
    requiresEnv: [],
    metadata: { category: 'code-review', source: 'missing-tools' }
  }
];

// ── Registration helper ──

function registerCodeReviewTools(registry) {
  if (!registry || typeof registry.registerMany !== 'function') {
    throw new Error('registry must have a registerMany() method');
  }
  registry.registerMany(toolDefinitions);
}

module.exports = {
  toolDefinitions,
  registerCodeReviewTools,
  reviewCodeHandler,
  suggestImprovementsHandler
};
