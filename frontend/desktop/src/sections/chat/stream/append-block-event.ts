/**
 * Pure reducer for assistant message blocks. Merges SSE deltas into the
 * block list the chat bubble renders: consecutive thinking/text chunks
 * coalesce onto the open block; toolCall/toolResult update by tool id.
 * Shared by the per-turn handler and applySubagentEvent (nested agents).
 */

import type { MessageBlock, AppendBlockEvent } from '@/types/chat';

/** Merge adjacent thinking blocks so demotion cannot produce Thought (2). */
export function coalesceAdjacentThinking(blocks: MessageBlock[]): MessageBlock[] {
  if (blocks.length < 2) return blocks;
  const out: MessageBlock[] = [];
  for (const block of blocks) {
    const prev = out[out.length - 1];
    if (prev?.type === 'thinking' && block.type === 'thinking') {
      prev.content = `${prev.content || ''}${block.content || ''}`;
      continue;
    }
    out.push({ ...block });
  }
  return out;
}

export function appendBlockEvent(
  prevBlocks: MessageBlock[],
  event: AppendBlockEvent
): MessageBlock[] {
  const blocks = [...prevBlocks];

  if (event.type === 'thinking') {
    const text = event.content || '';
    // Model wrote "answer" then kept thinking — that prose was provisional.
    // Demote it into thinking so it cannot stack into the true final reply.
    let demoted = false;
    for (let i = 0; i < blocks.length; i++) {
      if (blocks[i].type === 'finalOutput') {
        blocks[i] = {
          ...blocks[i],
          type: 'thinking',
        };
        demoted = true;
      }
    }
    if (demoted) {
      const coalesced = coalesceAdjacentThinking(blocks);
      blocks.length = 0;
      blocks.push(...coalesced);
    }
    const last = blocks[blocks.length - 1];
    if (last && last.type === 'thinking') {
      last.content = (last.content || '') + text;
    } else {
      blocks.push({
        id: `b_think_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        type: 'thinking',
        content: text
      });
    }
  } else if (event.type === 'text' || event.type === 'content' || event.type === 'finalOutput') {
    const text = event.content || '';
    const last = blocks[blocks.length - 1];
    if (last && last.type === 'finalOutput') {
      last.content = (last.content || '') + text;
    } else {
      blocks.push({
        id: `b_out_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        type: 'finalOutput',
        content: text
      });
    }
  } else if (event.type === 'toolCall' || event.type === 'command') {
    const isCommand = event.type === 'command' || event.name?.startsWith('@run_command') || event.name?.startsWith('run_command');
    const existingIdx = blocks.findIndex(b => b.tool && b.tool.id === event.id);
    if (existingIdx !== -1) {
      const target = { ...blocks[existingIdx] };
      if (target.tool) {
        target.tool = {
          ...target.tool,
          context: event.context || target.tool.context || '',
          status: event.status || target.tool.status || 'running',
        };
      }
      blocks[existingIdx] = target;
    } else {
      blocks.push({
        id: `b_tool_${event.id || Date.now()}`,
        type: isCommand ? 'command' : 'toolCall',
        tool: {
          id: event.id || `tc_${Date.now()}`,
          name: event.name || 'tool',
          context: event.context || '',
          status: event.status || 'running',
          startedAt: Date.now()
        },
        ...(event.isRevisedPlan ? { isRevisedPlan: true } : {}),
      });
    }
  } else if (event.type === 'tool_progress') {
    const targetIdx = blocks.findIndex(b => b.tool && b.tool.id === event.id);
    if (targetIdx !== -1) {
      const target = { ...blocks[targetIdx] };
      if (target.tool) {
        target.tool = {
          ...target.tool,
          preview: (target.tool.preview || '') + (event.preview || ''),
          ...(event.summary ? { summary: event.summary } : {}),
        };
      }
      blocks[targetIdx] = target;
    }
  } else if (event.type === 'recalledMemories') {
    if (event.memories && event.memories.length > 0) {
      blocks.push({
        id: `b_recall_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        type: 'recalledMemories',
        memories: event.memories,
      });
    }
  } else if (event.type === 'checkpoint') {
    // Save point created before file mutations — rendered as an inline
    // chip by the timeline, never as prose in the assistant reply.
    blocks.push({
      id: `b_ckpt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      type: 'checkpoint',
      checkpoint: event.checkpoint ?? {},
    });
  } else if (event.type === 'toolResult') {
    const targetIdx = blocks.findIndex(b => b.tool && b.tool.id === event.id);
    if (targetIdx !== -1) {
      const target = { ...blocks[targetIdx] };
      if (target.tool) {
        target.tool = {
          ...target.tool,
          status: event.status || 'done',
          summary: event.summary || '',
          error: event.error || '',
          duration: event.duration,
          searchHits: event.searchHits ?? target.tool.searchHits,
          providerSetup: event.providerSetup ?? target.tool.providerSetup,
        };
      }
      blocks[targetIdx] = target;
    }
  }

  return blocks;
}
