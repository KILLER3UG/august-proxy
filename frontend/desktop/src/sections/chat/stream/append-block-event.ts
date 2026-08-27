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
    // Skip demotion for system notices (warnings/info/errors) — those should
    // collapse into the thinking pack WITHOUT displacing the real answer.
    let demoted = false;
    if (!event.system) {
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
  } else if (event.type === 'memoryUpdated') {
    // In-chat memory notice: a memory was remembered/updated/forgotten —
    // rendered as a subtle chip, capped so a long agent run doesn't stack
    // an unbounded list.
    const noticeBlock: MessageBlock = {
      id: `b_memory_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      type: 'memoryNotice',
      content: event.summary || event.content || 'Memory updated.',
    };
    const memoryBlocks = blocks.filter((b) => b.type === 'memoryNotice');
    if (memoryBlocks.length >= 4) {
      const first = blocks.findIndex((b) => b.type === 'memoryNotice');
      if (first !== -1) blocks[first] = noticeBlock;
      else blocks.push(noticeBlock);
    } else {
      blocks.push(noticeBlock);
    }
  } else if (event.type === 'executionState') {
    // Plan §4.1 plan-tree marker: each update_state phase starts a new
    // group; step updates within the same phase patch the marker in place
    // so the tree head reads the latest step without stacking duplicates.
    const phase = (event.phase || '').trim();
    if (!phase) return blocks;
    const last = blocks[blocks.length - 1];
    if (last && last.type === 'phase' && last.content === phase) {
      blocks[blocks.length - 1] = {
        ...last,
        ...(typeof event.step === 'number' ? { step: event.step } : {}),
      };
    } else {
      blocks.push({
        id: `b_phase_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        type: 'phase',
        content: phase,
        ...(typeof event.step === 'number' ? { step: event.step } : {}),
      });
    }
  } else if (event.type === 'recalledMemories') {
    if (event.memories && event.memories.length > 0) {
      blocks.push({
        id: `b_recall_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        type: 'recalledMemories',
        memories: event.memories,
      });
    }
  } else if (event.type === 'error') {
    // Real failure banner — replace any prior error block for this turn
    // rather than stacking duplicates (retries can error more than once).
    const prevErrIdx = blocks.findIndex((b) => b.type === 'error');
    const errBlock: MessageBlock = {
      id: `b_error_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      type: 'error',
      content: event.content || 'Generation failed',
      ...(event.rawContent ? { rawContent: event.rawContent } : {}),
    };
    if (prevErrIdx !== -1) {
      blocks[prevErrIdx] = errBlock;
    } else {
      blocks.push(errBlock);
    }
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
          integrationSetup: event.integrationSetup ?? target.tool.integrationSetup,
        };
      }
      blocks[targetIdx] = target;
    }
  }

  return blocks;
}
