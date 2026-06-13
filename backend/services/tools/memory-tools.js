const { hybridSearchEntries, readVectorEntries, saveCheckpointWithEmbedding, searchCheckpointsByText } = require('../memory/vector-db');
const { searchGraph, graphStats } = require('../memory/graph-memory');
const semanticMemory = require('../memory/semantic-memory');
const { readAugustCoreMemory } = require('../memory/core-memory');
const { buildMemorySnapshot, buildModelMemoryPack, searchBrain } = require('../memory/memory-service');
const { commitBrainEdit, createBrainEditProposal } = require('../memory/brain-edit-service');
const { applyRetentionDecision, generateRetentionPlan } = require('../memory/retention-service');
const { recordModelObservation, listModelObservations } = require('../memory/model-observation-service');

// ── Tool Definitions ──

const MEMORY_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'august__memory_topics',
      description: 'List all distinct topics from past conversation checkpoints. Use this first to discover what the agent remembers across sessions.',
      parameters: {
        type: 'object',
        properties: {
          filter: { type: 'string', description: 'Optional keyword to narrow topics.' },
          limit: { type: 'number', description: 'Maximum topics to return. Defaults to 30.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'august__memory_search',
      description: 'Search past conversation checkpoints by topic, summary, or keywords. Returns the most relevant results ranked by similarity. Use memory_topics first to discover what topics exist.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query — topic, keywords, or natural language description of what you are looking for.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional filter by tags (e.g. ["auth", "debugging"]).' },
          limit: { type: 'number', description: 'Maximum results. Defaults to 5.' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'august__memory_read',
      description: 'Read the full content of a specific conversation checkpoint by ID. Use after memory_search to get full details of a relevant past session.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Checkpoint ID from memory_search results.' }
        },
        required: ['id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'august__fact_search',
      description: 'Search semantic memory facts by keyword or category. Facts are structured key-value pairs about the user, projects, and workflow rules.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query across fact keys and values.' },
          category: { type: 'string', enum: ['user_preference', 'user_detail', 'project_info', 'workflow_rule', 'session_temp'], description: 'Optional category filter.' },
          limit: { type: 'number', description: 'Maximum results. Defaults to 10.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'august__context_read',
      description: 'Read the current user profile, active projects, persistent facts, and recent events stored in core memory. Use this to quickly recall cross-session context.',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'august__graph_explore',
      description: 'Explore the full neighborhood of a specific entity in the graph: all its relations, observations, and connected entities. Use this after graph_search to drill into details.',
      parameters: {
        type: 'object',
        properties: {
          entity_id: { type: 'string', description: 'Entity ID or name to explore.' },
          depth: { type: 'number', description: 'How many hops to traverse. Defaults to 1.' }
        },
        required: ['entity_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'august__scan_brain',
      description: 'Scan the organized August brain and return a compact structured snapshot. Prefer this over raw context_read when you need cross-session memory, sqlite facts, proposals, retention, model observations, and graph/vector status.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Optional focus query for graph search and result filtering.' },
          includeRaw: { type: 'boolean', description: 'Include raw core memory object. Defaults to false.' },
          limits: { type: 'object', description: 'Optional per-section limits to keep the scan readable.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'august__memory_pack',
      description: 'Return a model-readable memory pack for the active model. Use before a task when you need durable context but want to avoid dumping the whole brain.',
      parameters: {
        type: 'object',
        properties: {
          modelId: { type: 'string', description: 'Model id, without provider prefix when possible.' },
          provider: { type: 'string', description: 'Provider name.' },
          query: { type: 'string', description: 'Optional focus query.' },
          maxChars: { type: 'number', description: 'Target max chars for downstream context. Defaults to 6000.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'august__brain_edit',
      description: 'Propose a safe brain edit without mutating memory. Use this when a model infers a durable fact, guideline, cleanup, merge, or model observation. Review the returned proposal before committing.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short human-readable title.' },
          description: { type: 'string', description: 'Why this edit is useful.' },
          action: { type: 'string', enum: ['set_fact', 'delete_fact', 'update_core', 'update_guideline', 'archive_memory', 'pin_memory', 'unpin_memory', 'keep_memory', 'delete_memory', 'merge_memory', 'upsert_model_observation'], description: 'Edit action to propose.' },
          memoryType: { type: 'string', description: 'Target memory type: core, semantic, sqlite, sqlite-fact, vector, guideline, model-observation.' },
          targetId: { type: 'string', description: 'Target id for sqlite, vector, or guideline edits.' },
          targetKey: { type: 'string', description: 'Target key for core or semantic edits.' },
          targetType: { type: 'string', description: 'Target type for core edits: project, integration, event, checkpoint.' },
          after: { type: 'object', description: 'Patch, fact, guideline, observation, or target state to apply if committed.' },
          metadata: { type: 'object', description: 'Optional actor/model/source metadata.' }
        },
        required: ['title', 'action', 'memoryType', 'after']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'august__brain_commit',
      description: 'Commit a pending august__brain_edit proposal by id. Only use after reviewing the proposal.',
      parameters: {
        type: 'object',
        properties: {
          proposalId: { type: 'string', description: 'Proposal id returned by august__brain_edit.' },
          actor: { type: 'string', description: 'Optional actor, usually model or user.' },
          force: { type: 'boolean', description: 'Allow recommitting a non-pending proposal. Defaults to false.' }
        },
        required: ['proposalId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'august__memory_retention',
      description: 'Score the brain for keep/review/remove/merge recommendations. Use before cleanup or when deciding whether to store a new fact.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Optional focus query.' },
          limit: { type: 'number', description: 'Candidate limit. Defaults to 80.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'august__memory_retention_apply',
      description: 'Apply an approved keep/review/remove/merge decision to memory. Use only after reviewing the retention recommendation.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['keep', 'review', 'remove', 'merge'], description: 'Approved action.' },
          memoryType: { type: 'string', description: 'Memory type: core, semantic, sqlite, sqlite-fact, vector, guideline.' },
          targetId: { type: 'string', description: 'Target id.' },
          targetKey: { type: 'string', description: 'Target key.' },
          type: { type: 'string', description: 'Core memory type if applicable.' },
          score: { type: 'number', description: 'Retention score.' },
          reasons: { type: 'array', items: { type: 'string' }, description: 'Reasons for the decision.' },
          actor: { type: 'string', description: 'Actor applying the decision.' },
          mergeTarget: { type: 'string', description: 'Target to merge into, if action is merge.' }
        },
        required: ['action', 'memoryType']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'august__model_observation',
      description: 'Record a useful model observation, failure pattern, or memory behavior note so future models can learn from it.',
      parameters: {
        type: 'object',
        properties: {
          modelId: { type: 'string', description: 'Model id, without provider prefix when possible.' },
          provider: { type: 'string', description: 'Provider name.' },
          observationType: { type: 'string', description: 'Example: tool_failure, memory_success, context_gap, prompt_behavior.' },
          summary: { type: 'string', description: 'Concise observation.' },
          details: { type: 'object', description: 'Structured details.' },
          relatedMemory: { type: 'object', description: 'Related memory ids/keys if any.' }
        },
        required: ['summary']
      }
    }
  }
];

// ── Handler ──

function getAllVectorEntries() {
  try {
    return readVectorEntries() || [];
  } catch (e) {
    return [];
  }
}

function getVectorEntryById(id) {
  const all = getAllVectorEntries();
  return all.find(e => e.id === id) || null;
}

async function handleMemoryTool(toolName, args) {
  switch (toolName) {
    case 'august__memory_topics': {
      const all = getAllVectorEntries();
      if (all.length === 0) return 'No conversation checkpoints found.';

      const topicMap = new Map();
      for (const entry of all) {
        const topic = (entry.topic || 'Untitled').trim();
        if (args.filter && !topic.toLowerCase().includes(args.filter.toLowerCase())) continue;
        const existing = topicMap.get(topic) || { count: 0, lastTimestamp: entry.timestamp };
        existing.count++;
        if (entry.timestamp > existing.lastTimestamp) existing.lastTimestamp = entry.timestamp;
        topicMap.set(topic, existing);
      }

      const sorted = Array.from(topicMap.entries())
        .sort((a, b) => b[1].count - a[1].count || new Date(b[1].lastTimestamp) - new Date(a[1].lastTimestamp))
        .slice(0, Math.max(1, Math.min(50, Number(args.limit || 30))));

      if (sorted.length === 0) return 'No matching topics found.';
      const lines = sorted.map(([topic, info]) =>
        `- "${topic}" (${info.count} session${info.count > 1 ? 's' : ''}, last: ${new Date(info.lastTimestamp).toLocaleDateString()})`
      );
      return `[Conversation Topics (${sorted.length})]\n${lines.join('\n')}\n\nUse memory_search("<topic>") to find specific checkpoints.`;
    }

    case 'august__memory_search': {
      const query = String(args.query || '').trim();
      if (!query) return 'Query is required.';
      const limit = Math.max(1, Math.min(20, Number(args.limit || 5)));

      const all = getAllVectorEntries();
      const filters = {};
      if (Array.isArray(args.tags) && args.tags.length > 0) filters.tags = args.tags;
      const results = hybridSearchEntries(query, all, limit, { filters });

      if (!results || results.length === 0) {
        const brain = searchBrain(query, { limit });
        const fallback = brain?.results || [];
        if (fallback.length > 0) {
          const lines = fallback.map((r, i) =>
            `[${i + 1}] ${r.provider || 'memory'}: ${r.topic || r.key || 'Untitled'}\n    Key: ${r.key || r.id || ''}\n    Score: ${(r.score || 0).toFixed(3)}\n    Summary: ${String(r.summary || r.text || '').slice(0, 200)}`
          );
          return `[Memory Search: "${query}"]\n${lines.join('\n\n')}\n\nUse fact_search() for structured facts or context_read() for core memory.`;
        }
        return `No matching checkpoints found for "${query}". Use memory_topics() to see all available topics.`;
      }

      const lines = results.map((r, i) =>
        `[${i + 1}] ${r.topic}\n    ID: ${r.id}\n    Score: ${(r._rrfScore || 0).toFixed(3)}\n    Date: ${new Date(r.timestamp).toLocaleDateString()}\n    Summary: ${(r.summary || '').slice(0, 200)}${(r.tags?.length ? '\n    Tags: ' + r.tags.join(', ') : '')}`
      );
      return `[Memory Search: "${query}"]\n${lines.join('\n\n')}\n\nUse memory_read("<id>") to open a specific checkpoint.`;
    }

    case 'august__memory_read': {
      const id = String(args.id || args.key || '').trim();
      if (!id) return 'Checkpoint ID or fact key is required.';
      const entry = getVectorEntryById(id);
      if (entry) {
        const meta = entry.metadata || {};
        return [
          `[Conversation Checkpoint]`,
          `Topic: ${entry.topic || 'Untitled'}`,
          `Date: ${new Date(entry.timestamp).toLocaleString()}`,
          `Summary: ${entry.summary || ''}`,
          meta.project ? `Project: ${meta.project}` : '',
          meta.outcome ? `Outcome: ${meta.outcome}` : '',
          meta.task ? `Task: ${meta.task}` : '',
          meta.tags?.length ? `Tags: ${meta.tags.join(', ')}` : '',
          `ID: ${entry.id}`
        ].filter(Boolean).join('\n');
      }

      const fact = semanticMemory.getFact(id);
      if (fact) {
        return [
          `[Semantic Fact]`,
          `Key: ${fact.key}`,
          `Category: ${fact.category}`,
          `Value: ${fact.value}`,
          `Source: ${fact.provenance?.source || fact.source || ''}`,
          `Confidence: ${fact.confidence ?? ''}`
        ].filter(Boolean).join('\n');
      }

      return `Checkpoint or fact "${id}" not found. Use memory_search() or fact_search() to find valid IDs/keys.`;
    }

    case 'august__fact_search': {
      const query = String(args.query || '').trim();
      const category = args.category;
      const limit = Math.max(1, Math.min(50, Number(args.limit || 10)));

      let facts;
      if (category) {
        facts = semanticMemory.getFactsByCategory(category);
        if (query) facts = facts.filter(f => f.key.includes(query) || f.value.includes(query));
      } else if (query) {
        facts = semanticMemory.searchFacts(query);
      } else {
        facts = semanticMemory.getAllFacts();
      }

      if (!facts || facts.length === 0) {
        return query
          ? `No semantic facts found for "${query}".`
          : 'No semantic facts stored.';
      }

      const lines = facts.slice(0, limit).map(f =>
        `- ${f.key}: ${f.value} [${f.category}]${f.source ? ` (from ${f.source})` : ''}`
      );
      const label = category ? `category="${category}"` : query ? `query="${query}"` : 'all';
      return `[Semantic Facts (${label})]\n${lines.join('\n')}`;
    }

    case 'august__context_read': {
      const memory = readAugustCoreMemory();
      const sections = [
        '=== User Profile ===',
        memory.user_profile || '(not set)',
        '',
        '=== Global Context ===',
        memory.global_context || '(not set)',
        '',
        '=== Active Projects ===',
        ...(Array.isArray(memory.active_projects) && memory.active_projects.length > 0
          ? memory.active_projects.map(p => `- ${p.name}: ${p.summary || p.status || ''}`)
          : ['(none)']),
        '',
        '=== Recent Events ===',
        ...(Array.isArray(memory.recent_events) && memory.recent_events.length > 0
          ? memory.recent_events.slice(-5).map(e => `- ${e.summary} (${new Date(e.timestamp).toLocaleDateString()})`)
          : ['(none)']),
        '',
        '=== Conversation Checkpoints ===',
        ...(Array.isArray(memory.conversation_checkpoints) && memory.conversation_checkpoints.length > 0
          ? memory.conversation_checkpoints.slice(-5).map(c => `- ${c.topic}: ${c.summary.slice(0, 120)}`)
          : ['(none)']),
      ];
      return sections.join('\n');
    }

    case 'august__graph_explore': {
      const { readGraphMemory } = require('../memory/graph-memory');
      const entityRef = String(args.entity_id || '').trim();
      if (!entityRef) return 'Entity ID or name is required.';

      const graph = readGraphMemory();
      const labels = new Map(graph.entities.map(e => [e.id, e.name || e.id]));

      const entity = graph.entities.find(e =>
        e.id === entityRef ||
        e.name.toLowerCase() === entityRef.toLowerCase() ||
        e.id.toLowerCase() === entityRef.toLowerCase() ||
        (e.aliases || []).some(a => a.toLowerCase() === entityRef.toLowerCase())
      );

      if (!entity) return `Entity "${entityRef}" not found. Use graph_search() to find entities.`;

      const relationsFrom = graph.relations.filter(r => r.from === entity.id);
      const relationsTo = graph.relations.filter(r => r.to === entity.id);
      const observations = graph.observations.filter(o => o.entityId === entity.id);

      const lines = [
        `[Entity: ${entity.name}]`,
        `  Type: ${entity.type}`,
        `  ID: ${entity.id}`,
        ...(entity.aliases?.length ? [`  Aliases: ${entity.aliases.join(', ')}`] : []),
        `  Confidence: ${entity.confidence}`,
        '',
      ];

      if (relationsFrom.length > 0) {
        lines.push(`Relations FROM ${entity.name}:`);
        relationsFrom.slice(0, 15).forEach(r =>
          lines.push(`  --${r.type}--> ${labels.get(r.to) || r.to}`)
        );
        lines.push('');
      }

      if (relationsTo.length > 0) {
        lines.push(`Relations TO ${entity.name}:`);
        relationsTo.slice(0, 15).forEach(r =>
          lines.push(`  ${labels.get(r.from) || r.from} --${r.type}--> ${entity.name}`)
        );
        lines.push('');
      }

      if (observations.length > 0) {
        lines.push(`Observations:`);
        observations.slice(0, 10).forEach(o =>
          lines.push(`  - ${o.text.slice(0, 300)}`)
        );
      }

      return lines.join('\n') || 'Entity found but no relations or observations.';
    }

    case 'august__scan_brain': {
      const snapshot = buildMemorySnapshot({
        query: args.query || '',
        includeRaw: args.includeRaw === true,
        ...(args.limits || {})
      });
      return JSON.stringify({
        generatedAt: snapshot.generatedAt,
        counts: snapshot.counts,
        core: {
          rendered: snapshot.core.rendered,
          items: snapshot.core.items
        },
        semanticFacts: snapshot.semantic.facts,
        sqliteFacts: snapshot.sqlite.facts,
        sqliteMemories: snapshot.sqlite.memories,
        vectorEntries: snapshot.vector.entries,
        graph: snapshot.graph,
        learnedGuidelines: snapshot.guidelines.items,
        modelObservations: snapshot.modelObservations.items,
        providers: snapshot.providers,
        schema: snapshot.sqlite.schema
      }, null, 2);
    }

    case 'august__memory_pack': {
      const pack = buildModelMemoryPack({
        modelId: args.modelId || args.model_id || '',
        provider: args.provider || '',
        query: args.query || '',
        maxChars: args.maxChars
      });
      return JSON.stringify(pack, null, 2);
    }

    case 'august__brain_edit': {
      const proposal = createBrainEditProposal(args);
      return JSON.stringify({
        status: 'proposal_created',
        proposal,
        next: 'review the proposal, then call august__brain_commit({ proposalId })'
      }, null, 2);
    }

    case 'august__brain_commit': {
      const proposalId = String(args.proposalId || '').trim();
      if (!proposalId) return 'proposalId is required.';
      const result = commitBrainEdit(proposalId, {
        actor: args.actor || 'model',
        force: args.force === true
      });
      return JSON.stringify(result, null, 2);
    }

    case 'august__memory_retention': {
      const plan = generateRetentionPlan({
        query: args.query || '',
        limit: args.limit || 80
      });
      return JSON.stringify(plan, null, 2);
    }

    case 'august__memory_retention_apply': {
      const result = applyRetentionDecision(args);
      return JSON.stringify(result, null, 2);
    }

    case 'august__model_observation': {
      const observation = recordModelObservation(args);
      return JSON.stringify({
        status: 'recorded',
        observation
      }, null, 2);
    }

    default:
      return `Unknown memory tool: ${toolName}`;
  }
}

module.exports = { MEMORY_TOOLS, handleMemoryTool };
