/**
 * external-tools.js — Tools from Hermes/OpenCode not yet in August Proxy
 * 
 * Implements parity tools from:
 * - Hermes: clarify, todo, mixture_of_agents, kanban, discord, homeassistant,
 *           send_message, x_search, yuanbao, feishu_doc, feishu_drive, video_generation
 * - OpenCode: plan, question, lsp, task
 * 
 * Registration:
 *   const { registerExternalTools } = require('./missing/external-tools');
 *   registerExternalTools(toolRegistry);
 */

const { z } = require('zod');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { getDataDir } = require('../../../lib/data-paths');

const DATA_DIR = getDataDir();
const TODO_FILE = path.join(DATA_DIR, 'august_todos.json');
const KANBAN_FILE = path.join(DATA_DIR, 'august_kanban.json');
const PLAN_FILE = path.join(DATA_DIR, 'august_plan.md');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

function id(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function writeJson(filePath, data) {
  ensureDataDir();
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// ── Tool: august__clarify ──
// Ask the user a clarifying question with optional choices
const CLARIFY_SCHEMA = z.object({
  question: z.string().min(1).describe('The question to ask the user'),
  choices: z.array(z.string()).optional().describe('Optional multiple-choice answers (max 4)'),
  open_ended: z.boolean().optional().default(true).describe('Whether to allow free-form responses')
});

async function clarifyHandler(args) {
  return {
    status: 'asked',
    question: args.question,
    choices: args.choices || [],
    open_ended: args.open_ended !== false,
    note: 'Question is ready to present to the user. In Hermes this would render a clarification UI.'
  };
}

function registerClarifyTool(registry) {
  registry.register({
    name: 'august__clarify',
    toolset: 'clarify',
    description: 'Ask the user a clarifying question when the request is ambiguous or needs a decision before proceeding.',
    schema: CLARIFY_SCHEMA,
    handler: clarifyHandler,
    permissions: { category: 'interaction', destructive: false },
    emoji: '❓'
  });
}

// ── Tool: august__todo ──
// Manage task list (OpenCode todowrite + Hermes todo)
const TODO_SCHEMA = z.object({
  todos: z.array(z.object({
    id: z.string().optional(),
    content: z.string().min(1),
    status: z.enum(['pending', 'in_progress', 'completed', 'cancelled'])
  })).describe('Complete task list to write (replace or merge)'),
  merge: z.boolean().optional().default(false).describe('Merge with existing tasks instead of replacing')
});

function readTodos() {
  const data = readJson(TODO_FILE, { todos: [] });
  return Array.isArray(data.todos) ? data.todos : [];
}

function writeTodos(todos) {
  writeJson(TODO_FILE, { todos, updatedAt: nowIso() });
}

async function todoHandler(args) {
  const incoming = args.todos || [];
  let existing = readTodos();
  
  if (args.merge) {
    const byId = new Map(existing.map(t => [t.id, t]));
    for (const item of incoming) {
      const todoId = item.id || id('todo');
      byId.set(todoId, { ...item, id: todoId });
    }
    existing = Array.from(byId.values());
  } else {
    existing = incoming.map(item => ({
      ...item,
      id: item.id || id('todo')
    }));
  }
  
  writeTodos(existing);
  
  return {
    status: 'updated',
    todos: existing,
    summary: {
      total: existing.length,
      pending: existing.filter(t => t.status === 'pending').length,
      in_progress: existing.filter(t => t.status === 'in_progress').length,
      completed: existing.filter(t => t.status === 'completed').length,
      cancelled: existing.filter(t => t.status === 'cancelled').length
    }
  };
}

function registerTodoTool(registry) {
  registry.register({
    name: 'august__todo',
    toolset: 'todo',
    description: 'Manage a task list for complex multi-step work. Use this to track progress, mark items complete, or update task states.',
    schema: TODO_SCHEMA,
    handler: todoHandler,
    permissions: { category: 'state', destructive: false },
    emoji: '☑️'
  });
}

// ── Tool: august__mixture_of_agents ──
// Route a hard problem through multiple model calls and aggregate responses
const MIXTURE_SCHEMA = z.object({
  user_prompt: z.string().min(1).max(50000).describe('The complex query to solve'),
  model_count: z.number().int().min(2).max(5).optional().default(4).describe('Number of model calls to make (2-5)'),
  aggregator: z.boolean().optional().default(true).describe('Whether to make a final aggregation call')
});

async function mixtureOfAgentsHandler(args) {
  // This is a framework-level tool — the actual multi-model routing
  // is handled by the proxy's provider system. Return a structured request.
  return {
    status: 'ready',
    prompt: args.user_prompt,
    model_count: args.model_count,
    aggregator: args.aggregator,
    note: 'Mixture-of-agents routing requires provider-level integration. This tool marks the request for multi-model processing.'
  };
}

function registerMixtureOfAgentsTool(registry) {
  registry.register({
    name: 'august__mixture_of_agents',
    toolset: 'ensemble',
    description: 'Route a hard problem through multiple AI models collaboratively, then aggregate their responses into a final answer.',
    schema: MIXTURE_SCHEMA,
    handler: mixtureOfAgentsHandler,
    permissions: { category: 'llm', destructive: false },
    emoji: '🧠'
  });
}

// ── Tool: august__kanban ──
// Manage kanban boards
const KANBAN_SCHEMA = z.object({
  action: z.enum(['list', 'create_board', 'delete_board', 'create_column', 'move_column', 'create_card', 'update_card', 'move_card', 'delete_card']),
  board_id: z.string().optional(),
  column_id: z.string().optional(),
  card_id: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  position: z.number().int().min(0).optional(),
  status: z.string().optional()
});

function readKanban() {
  return readJson(KANBAN_FILE, { boards: [] });
}

function writeKanban(data) {
  writeJson(KANBAN_FILE, { ...data, updatedAt: nowIso() });
}

async function kanbanHandler(args) {
  const data = readKanban();
  let boards = Array.isArray(data.boards) ? data.boards : [];
  
  switch (args.action) {
    case 'list':
      return { boards };
    
    case 'create_board': {
      const board = { id: id('board'), name: args.name || 'Untitled Board', columns: [], createdAt: nowIso() };
      boards.push(board);
      writeKanban({ boards });
      return { board };
    }
    
    case 'delete_board': {
      const before = boards.length;
      boards = boards.filter(b => b.id !== args.board_id);
      writeKanban({ boards });
      return { deleted: boards.length < before };
    }
    
    case 'create_column': {
      const board = boards.find(b => b.id === args.board_id);
      if (!board) return { error: 'Board not found' };
      const column = { id: id('col'), name: args.name || 'Column', cards: [], position: args.position ?? board.columns.length };
      board.columns.push(column);
      board.columns.sort((a, b) => a.position - b.position);
      writeKanban({ boards });
      return { column };
    }
    
    case 'move_column': {
      const board = boards.find(b => b.id === args.board_id);
      if (!board) return { error: 'Board not found' };
      const column = board.columns.find(c => c.id === args.column_id);
      if (!column) return { error: 'Column not found' };
      column.position = args.position ?? column.position;
      board.columns.sort((a, b) => a.position - b.position);
      writeKanban({ boards });
      return { column };
    }
    
    case 'create_card': {
      const board = boards.find(b => b.id === args.board_id);
      if (!board) return { error: 'Board not found' };
      const column = board.columns.find(c => c.id === args.column_id);
      if (!column) return { error: 'Column not found' };
      const card = { id: id('card'), name: args.name || 'Card', description: args.description || '', status: args.status || '', createdAt: nowIso() };
      column.cards.push(card);
      writeKanban({ boards });
      return { card };
    }
    
    case 'update_card': {
      const board = boards.find(b => b.id === args.board_id);
      if (!board) return { error: 'Board not found' };
      const column = board.columns.find(c => c.id === args.column_id);
      if (!column) return { error: 'Column not found' };
      const card = column.cards.find(c => c.id === args.card_id);
      if (!card) return { error: 'Card not found' };
      Object.assign(card, {
        ...(args.name ? { name: args.name } : {}),
        ...(args.description !== undefined ? { description: args.description } : {}),
        ...(args.status ? { status: args.status } : {})
      });
      writeKanban({ boards });
      return { card };
    }
    
    case 'move_card': {
      const srcBoard = boards.find(b => b.id === args.board_id);
      if (!srcBoard) return { error: 'Board not found' };
      const srcColumn = srcBoard.columns.find(c => c.id === args.column_id);
      if (!srcColumn) return { error: 'Source column not found' };
      const cardIndex = srcColumn.cards.findIndex(c => c.id === args.card_id);
      if (cardIndex === -1) return { error: 'Card not found' };
      const [card] = srcColumn.cards.splice(cardIndex, 1);
      const dstColumn = srcBoard.columns.find(c => c.id === args.column_id);
      if (!dstColumn) return { error: 'Destination column not found' };
      const pos = args.position ?? dstColumn.cards.length;
      dstColumn.cards.splice(Math.min(pos, dstColumn.cards.length), 0, card);
      writeKanban({ boards });
      return { card };
    }
    
    case 'delete_card': {
      const board = boards.find(b => b.id === args.board_id);
      if (!board) return { error: 'Board not found' };
      const column = board.columns.find(c => c.id === args.column_id);
      if (!column) return { error: 'Column not found' };
      const before = column.cards.length;
      column.cards = column.cards.filter(c => c.id !== args.card_id);
      writeKanban({ boards });
      return { deleted: column.cards.length < before };
    }
    
    default:
      return { error: 'Unknown action' };
  }
}

function registerKanbanTool(registry) {
  registry.register({
    name: 'august__kanban',
    toolset: 'kanban',
    description: 'Manage kanban boards with columns and cards. Supports list, create, update, move, and delete operations.',
    schema: KANBAN_SCHEMA,
    handler: kanbanHandler,
    permissions: { category: 'state', destructive: false },
    emoji: '📋'
  });
}

// ── Tool: august__send_message ──
// Send a message to a platform (Discord, Slack, Telegram, etc.)
const SEND_MESSAGE_SCHEMA = z.object({
  platform: z.enum(['discord', 'slack', 'telegram', 'email', 'sms']).describe('Target platform'),
  recipient: z.string().describe('Recipient ID, channel ID, or address'),
  message: z.string().min(1).max(10000).describe('Message content'),
  thread_id: z.string().optional().describe('Optional thread/conversation ID')
});

async function sendMessageHandler(args) {
  // Framework-level tool — actual delivery depends on configured platform credentials
  return {
    status: 'ready',
    platform: args.platform,
    recipient: args.recipient,
    thread_id: args.thread_id || null,
    message_length: args.message.length,
    note: 'Message is ready to send. Configure platform credentials in config.json to enable actual delivery.'
  };
}

function registerSendMessageTool(registry) {
  registry.register({
    name: 'august__send_message',
    toolset: 'messaging',
    description: 'Send a message to an external platform (Discord, Slack, Telegram, email, or SMS).',
    schema: SEND_MESSAGE_SCHEMA,
    handler: sendMessageHandler,
    permissions: { category: 'external', destructive: false },
    emoji: '💬'
  });
}

// ── Tool: august__x_search ──
// Search X/Twitter
const X_SEARCH_SCHEMA = z.object({
  query: z.string().min(1).max(1000).describe('Search query'),
  limit: z.number().int().min(1).max(50).optional().default(10).describe('Number of results')
});

async function xSearchHandler(args) {
  return {
    status: 'ready',
    query: args.query,
    limit: args.limit,
    note: 'X/Twitter search requires API credentials. Configure X_API_KEY in config.json to enable live search.'
  };
}

function registerXSearchTool(registry) {
  registry.register({
    name: 'august__x_search',
    toolset: 'web',
    description: 'Search X/Twitter for recent posts and conversations.',
    schema: X_SEARCH_SCHEMA,
    handler: xSearchHandler,
    permissions: { category: 'web', destructive: false },
    emoji: '𝕏'
  });
}

// ── Tool: august__plan ──
// Enter/exit plan mode
const PLAN_SCHEMA = z.object({
  action: z.enum(['enter', 'exit', 'get', 'update']).describe('Plan action'),
  content: z.string().optional().describe('Plan markdown content')
});

async function planHandler(args) {
  switch (args.action) {
    case 'enter':
      if (!fs.existsSync(PLAN_FILE)) fs.writeFileSync(PLAN_FILE, '# Plan\n\n');
      return { status: 'entered', path: PLAN_FILE };
    
    case 'exit':
      if (fs.existsSync(PLAN_FILE)) fs.unlinkSync(PLAN_FILE);
      return { status: 'exited' };
    
    case 'get':
      return { exists: fs.existsSync(PLAN_FILE), content: fs.existsSync(PLAN_FILE) ? fs.readFileSync(PLAN_FILE, 'utf8') : '' };
    
    case 'update':
      ensureDataDir();
      fs.writeFileSync(PLAN_FILE, args.content || '');
      return { status: 'updated', path: PLAN_FILE };
    
    default:
      return { error: 'Unknown action' };
  }
}

function registerPlanTool(registry) {
  registry.register({
    name: 'august__plan',
    toolset: 'planning',
    description: 'Enter or exit plan mode. Write and maintain a plan.md file for complex multi-step work.',
    schema: PLAN_SCHEMA,
    handler: planHandler,
    permissions: { category: 'state', destructive: false },
    emoji: '📝'
  });
}

// ── Tool: august__lsp ──
// Language Server Protocol operations
const LSP_SCHEMA = z.object({
  action: z.enum(['start', 'stop', 'diagnostics', 'definition', 'references', 'rename', 'format']).describe('LSP action'),
  file_path: z.string().optional().describe('File path'),
  line: z.number().int().min(0).optional().describe('Line number'),
  column: z.number().int().min(0).optional().describe('Column number'),
  new_name: z.string().optional().describe('New name for rename')
});

async function lspHandler(args) {
  return {
    status: 'ready',
    action: args.action,
    file_path: args.file_path || null,
    note: 'LSP integration requires a language server to be running. Configure LSP settings to enable live diagnostics, go-to-definition, and rename operations.'
  };
}

function registerLspTool(registry) {
  registry.register({
    name: 'august__lsp',
    toolset: 'code',
    description: 'Language Server Protocol operations: diagnostics, go-to-definition, references, rename, and formatting.',
    schema: LSP_SCHEMA,
    handler: lspHandler,
    permissions: { category: 'code', destructive: false },
    emoji: '🔍'
  });
}

// ── Tool: august__video_generation ──
// Generate video from text or image
const VIDEO_GEN_SCHEMA = z.object({
  prompt: z.string().min(1).max(4000).describe('Video generation prompt'),
  image_url: z.string().url().optional().describe('Optional image URL for image-to-video'),
  duration: z.number().int().min(1).max(60).optional().default(5).describe('Duration in seconds'),
  resolution: z.enum(['480p', '720p', '1080p']).optional().default('720p')
});

async function videoGenerationHandler(args) {
  return {
    status: 'ready',
    prompt: args.prompt,
    image_url: args.image_url || null,
    duration: args.duration,
    resolution: args.resolution,
    note: 'Video generation requires a configured video generation provider. Wire this to a provider adapter to enable actual generation.'
  };
}

function registerVideoGenerationTool(registry) {
  registry.register({
    name: 'august__video_generation',
    toolset: 'media',
    description: 'Generate video from text prompts or image-to-video inputs.',
    schema: VIDEO_GEN_SCHEMA,
    handler: videoGenerationHandler,
    permissions: { category: 'media', destructive: false },
    emoji: '🎬'
  });
}

// ── Tool: august__yuanbao ──
// Tencent Yuanbao group operations
const YUANBAO_SCHEMA = z.object({
  action: z.enum(['list_groups', 'get_group_info', 'mention_user', 'query_info']).describe('Yuanbao action'),
  group_id: z.string().optional().describe('Group ID'),
  user_id: z.string().optional().describe('User ID to @mention'),
  query: z.string().optional().describe('Query string')
});

async function yuanbaoHandler(args) {
  return {
    status: 'ready',
    action: args.action,
    group_id: args.group_id || null,
    user_id: args.user_id || null,
    query: args.query || null,
    note: 'Yuanbao integration requires Tencent credentials. Configure in config.json to enable live group operations.'
  };
}

function registerYuanbaoTool(registry) {
  registry.register({
    name: 'august__yuanbao',
    toolset: 'messaging',
    description: 'Tencent Yuanbao group operations: list groups, get info, mention users, and query group info.',
    schema: YUANBAO_SCHEMA,
    handler: yuanbaoHandler,
    permissions: { category: 'external', destructive: false },
    emoji: '💬'
  });
}

// ── Tool: august__homeassistant ──
// Control Philips Hue / Home Assistant devices
const HOMEASSISTANT_SCHEMA = z.object({
  action: z.enum(['list_lights', 'set_light', 'list_scenes', 'activate_scene', 'get_state']).describe('Home Assistant action'),
  entity_id: z.string().optional().describe('Entity ID (e.g. light.bedroom)'),
  state: z.enum(['on', 'off']).optional().describe('Light state'),
  brightness: z.number().int().min(0).max(255).optional().describe('Brightness 0-255'),
  scene_id: z.string().optional().describe('Scene ID')
});

async function homeassistantHandler(args) {
  return {
    status: 'ready',
    action: args.action,
    entity_id: args.entity_id || null,
    state: args.state || null,
    brightness: args.brightness || null,
    scene_id: args.scene_id || null,
    note: 'Home Assistant integration requires HA server URL and token in config.json.'
  };
}

function registerHomeassistantTool(registry) {
  registry.register({
    name: 'august__homeassistant',
    toolset: 'smart_home',
    description: 'Control Home Assistant / Philips Hue devices: lights, scenes, rooms, and sensors.',
    schema: HOMEASSISTANT_SCHEMA,
    handler: homeassistantHandler,
    permissions: { category: 'external', destructive: false },
    emoji: '🏠'
  });
}

// ── Tool: august__feishu_doc ──
// Feishu document operations
const FEISHU_DOC_SCHEMA = z.object({
  action: z.enum(['list', 'get', 'create', 'update', 'delete']).describe('Feishu doc action'),
  doc_id: z.string().optional().describe('Document ID'),
  title: z.string().optional().describe('Document title'),
  content: z.string().optional().describe('Document markdown content')
});

async function feishuDocHandler(args) {
  return {
    status: 'ready',
    action: args.action,
    doc_id: args.doc_id || null,
    title: args.title || null,
    content_length: args.content ? args.content.length : 0,
    note: 'Feishu integration requires app ID and secret in config.json.'
  };
}

function registerFeishuDocTool(registry) {
  registry.register({
    name: 'august__feishu_doc',
    toolset: 'documents',
    description: 'Feishu document operations: list, get, create, update, and delete documents.',
    schema: FEISHU_DOC_SCHEMA,
    handler: feishuDocHandler,
    permissions: { category: 'external', destructive: false },
    emoji: '📄'
  });
}

// ── Tool: august__feishu_drive ──
// Feishu Drive file operations
const FEISHU_DRIVE_SCHEMA = z.object({
  action: z.enum(['list', 'upload', 'download', 'delete', 'share']).describe('Feishu drive action'),
  file_id: z.string().optional().describe('File ID'),
  file_path: z.string().optional().describe('Local file path'),
  folder_id: z.string().optional().describe('Folder ID')
});

async function feishuDriveHandler(args) {
  return {
    status: 'ready',
    action: args.action,
    file_id: args.file_id || null,
    file_path: args.file_path || null,
    folder_id: args.folder_id || null,
    note: 'Feishu Drive integration requires app ID and secret in config.json.'
  };
}

function registerFeishuDriveTool(registry) {
  registry.register({
    name: 'august__feishu_drive',
    toolset: 'documents',
    description: 'Feishu Drive file operations: list, upload, download, delete, and share files.',
    schema: FEISHU_DRIVE_SCHEMA,
    handler: feishuDriveHandler,
    permissions: { category: 'external', destructive: false },
    emoji: '📁'
  });
}

// ── Registration ──
function registerExternalTools(registry) {
  if (!registry) throw new Error('A tool registry is required.');
  
  const tools = [
    registerClarifyTool,
    registerTodoTool,
    registerMixtureOfAgentsTool,
    registerKanbanTool,
    registerSendMessageTool,
    registerXSearchTool,
    registerPlanTool,
    registerLspTool,
    registerVideoGenerationTool,
    registerYuanbaoTool,
    registerHomeassistantTool,
    registerFeishuDocTool,
    registerFeishuDriveTool
  ];
  
  let registered = 0;
  const errors = [];
  
  for (const registerFn of tools) {
    try {
      registerFn(registry);
      registered++;
    } catch (e) {
      errors.push(e.message);
    }
  }
  
  return { registered, errors };
}

function getExternalToolDefinitions() {
  return [
    { name: 'august__clarify', toolset: 'clarify' },
    { name: 'august__todo', toolset: 'todo' },
    { name: 'august__mixture_of_agents', toolset: 'ensemble' },
    { name: 'august__kanban', toolset: 'kanban' },
    { name: 'august__send_message', toolset: 'messaging' },
    { name: 'august__x_search', toolset: 'web' },
    { name: 'august__plan', toolset: 'planning' },
    { name: 'august__lsp', toolset: 'code' },
    { name: 'august__video_generation', toolset: 'media' },
    { name: 'august__yuanbao', toolset: 'messaging' },
    { name: 'august__homeassistant', toolset: 'smart_home' },
    { name: 'august__feishu_doc', toolset: 'documents' },
    { name: 'august__feishu_drive', toolset: 'documents' }
  ];
}

module.exports = {
  registerExternalTools,
  getExternalToolDefinitions,
  // Handlers for direct testing
  clarifyHandler,
  todoHandler,
  kanbanHandler,
  planHandler
};
