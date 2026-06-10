/**
 * tool-registry.js — Centralized tool registration with Zod schemas.
 * Inspired by Hermes's ToolRegistry (Python) and OpenCode's Tool.make() (Effect-TS).
 *
 * Each tool has: name, description, schema (Zod or JSON), handler, permissions, toolset.
 * Tools are registered centrally and dispatched by name.
 */

const { z } = require('zod');

// ── Internal State ──

const _tools = new Map();      // name -> ToolEntry
const _toolsets = new Map();   // toolset -> Set<toolName>
const _generation = { value: 0 };

// ── ToolEntry ──

class ToolEntry {
  constructor(opts) {
    this.name = opts.name;
    this.description = opts.description || '';
    this.toolset = opts.toolset || 'general';
    this.schema = opts.schema || null;          // Zod schema or JSON Schema object
    this.handler = opts.handler || null;        // async (args, ctx) => result
    this.zodSchema = null;                       // compiled Zod schema
    this.permissions = opts.permissions || { category: 'read', destructive: false };
    this.emoji = opts.emoji || '🔧';
    this.maxResultSize = opts.maxResultSize || 100000;
    this.timeoutMs = opts.timeoutMs || 30000;
    this.isAsync = opts.isAsync !== false;
    this.requiresEnv = opts.requiresEnv || [];
    this.checkFn = opts.checkFn || null;         // availability check
    this.metadata = opts.metadata || {};
    this.generation = _generation.value;

    // Build Zod schema
    if (opts.schema && opts.schema instanceof z.ZodType) {
      this.zodSchema = opts.schema;
    } else if (opts.schema && typeof opts.schema === 'object' && !(opts.schema instanceof z.ZodType)) {
      // Lazy import zod-to-json-schema for JSON Schema compat
      try {
        // Try to convert JSON Schema to Zod
        this.zodSchema = z.object(
          Object.fromEntries(
            Object.entries(opts.schema.properties || {}).map(([key, prop]) => {
              let field = zodFromJsonSchema(prop);
              if (opts.schema.required?.includes(key)) field = field;
              else field = field.optional();
              return [key, field];
            })
          )
        );
      } catch (e) {
        // Fallback: use passthrough
        this.zodSchema = z.any();
      }
    } else {
      this.zodSchema = z.any();
    }
  }

  async execute(args, ctx = {}) {
    // Validate with Zod
    let parsed = args;
    if (this.zodSchema && !(this.zodSchema instanceof z.ZodAny)) {
      const result = this.zodSchema.safeParse(args);
      if (!result.success) {
        const errors = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
        throw new Error(`Validation error for ${this.name}: ${errors}`);
      }
      parsed = result.data;
    }

    if (!this.handler) {
      throw new Error(`No handler registered for tool: ${this.name}`);
    }

    const start = Date.now();
    try {
      const result = await this.handler(parsed, ctx);
      const duration = Date.now() - start;
      return { result, duration, toolName: this.name };
    } catch (e) {
      const duration = Date.now() - start;
      throw Object.assign(e, { toolName: this.name, duration });
    }
  }

  toOpenAIFormat() {
    const params = this.zodSchema ? zodToJsonSchema(this.zodSchema) : { type: 'object', properties: {} };
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: params
      }
    };
  }

  get isAvailable() {
    if (!this.checkFn) return true;
    try { return this.checkFn(); } catch (e) { return false; }
  }
}

// ── JSON Schema ↔ Zod Helpers ──

function zodFromJsonSchema(prop) {
  const type = prop.type || 'string';
  switch (type) {
    case 'string':
      if (prop.enum) return z.enum(prop.enum);
      return z.string();
    case 'number': return z.number();
    case 'integer': return z.number().int();
    case 'boolean': return z.boolean();
    case 'array': return z.array(z.any());
    case 'object': return z.record(z.any());
    default: return z.any();
  }
}

function zodToJsonSchema(zodSchema) {
  if (zodSchema instanceof z.ZodObject) {
    const shape = zodSchema.shape;
    const properties = {};
    const required = [];
    for (const [key, field] of Object.entries(shape)) {
      let isOptional = field.isOptional ? field.isOptional() : false;
      let inner = field;
      // Unwrap optional
      if (field instanceof z.ZodOptional) {
        isOptional = true;
        inner = field._def.innerType;
      } else if (field instanceof z.ZodDefault) {
        isOptional = true;
        inner = field._def.innerType;
      }
      properties[key] = zodTypeToJson(inner);
      if (!isOptional) required.push(key);
    }
    return { type: 'object', properties, required, additionalProperties: false };
  }
  if (zodSchema instanceof z.ZodString) return { type: 'string' };
  if (zodSchema instanceof z.ZodNumber) return { type: 'number' };
  if (zodSchema instanceof z.ZodBoolean) return { type: 'boolean' };
  if (zodSchema instanceof z.ZodArray) return { type: 'array', items: zodToJsonSchema(zodSchema._def.type) };
  if (zodSchema instanceof z.ZodEnum) return { type: 'string', enum: zodSchema._def.values };
  if (zodSchema instanceof z.ZodAny) return {};
  return {};
}

function zodTypeToJson(field) {
  if (field instanceof z.ZodString) return { type: 'string' };
  if (field instanceof z.ZodNumber) return { type: 'number' };
  if (field instanceof z.ZodBoolean) return { type: 'boolean' };
  if (field instanceof z.ZodArray) return { type: 'array', items: zodTypeToJson(field._def.type) };
  if (field instanceof z.ZodEnum) return { type: 'string', enum: field._def.values };
  if (field instanceof z.ZodLiteral) return { type: typeof field._def.value, enum: [field._def.value] };
  if (field instanceof z.ZodObject) return zodToJsonSchema(field);
  return { type: 'string' };
}

// ── Registry API ──

function register(opts) {
  if (_tools.has(opts.name)) {
    if (opts.override) {
      _tools.delete(opts.name);
      const ts = _toolsets.get(opts.toolset);
      if (ts) ts.delete(opts.name);
    } else {
      throw new Error(`Tool "${opts.name}" is already registered. Use override=true to replace.`);
    }
  }
  const entry = new ToolEntry(opts);
  _tools.set(opts.name, entry);
  if (!_toolsets.has(opts.toolset)) _toolsets.set(opts.toolset, new Set());
  _toolsets.get(opts.toolset).add(opts.name);
  _generation.value++;
  return entry;
}

function registerMany(tools) {
  for (const t of tools) register(t);
}

function get(name) {
  return _tools.get(name) || null;
}

function unregister(name) {
  const entry = _tools.get(name);
  if (entry) {
    _tools.delete(name);
    const ts = _toolsets.get(entry.toolset);
    if (ts) ts.delete(name);
    _generation.value++;
  }
}

function list() {
  return Array.from(_tools.values());
}

function listAvailable() {
  return Array.from(_tools.values()).filter(t => t.isAvailable);
}

function getDefinitions(format = 'openai') {
  return listAvailable().map(t => t.toOpenAIFormat());
}

function getToolsets() {
  return Array.from(_toolsets.keys());
}

function getToolsByToolset(toolset) {
  const names = _toolsets.get(toolset);
  if (!names) return [];
  return Array.from(names).map(n => _tools.get(n)).filter(Boolean);
}

function getGeneration() {
  return _generation.value;
}

async function dispatch(name, args, ctx = {}) {
  const tool = _tools.get(name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  return tool.execute(args, ctx);
}

// ── Tool builder helper (like OpenCode's Tool.make()) ──

function tool(name, schema, handler, opts = {}) {
  return register({
    name,
    schema,
    handler,
    description: opts.description || '',
    toolset: opts.toolset || 'general',
    permissions: opts.permissions || { category: 'read', destructive: false },
    emoji: opts.emoji || '🔧',
    maxResultSize: opts.maxResultSize || 100000,
    timeoutMs: opts.timeoutMs || 30000,
    requiresEnv: opts.requiresEnv || [],
    checkFn: opts.checkFn || null,
    metadata: opts.metadata || {}
  });
}

module.exports = {
  ToolEntry,
  register,
  registerMany,
  get,
  unregister,
  list,
  listAvailable,
  getDefinitions,
  getToolsets,
  getToolsByToolset,
  getGeneration,
  dispatch,
  tool
};
