/* ── Message block parsing (thinking / tools / content) ───────────────── */
/* Pure functions extracted from ChatThread.                              */

import type { ChatMessage, MessageBlock } from '@/types/chat';

export function parseSequentialText(
  text: string,
): { type: 'thinking' | 'finalOutput'; content: string }[] {
  const blocks: { type: 'thinking' | 'finalOutput'; content: string }[] = [];
  let currentIndex = 0;

  const markers = [
    { open: '<thinking>', close: '</thinking>' },
    { open: '<think>', close: '</think>' },
    { open: '[THINK]', close: '[/THINK]' },
    { open: '[REASONING]', close: '[/REASONING]' },
  ];

  while (currentIndex < text.length) {
    let earliestOpenIdx = -1;
    let selectedMarker: (typeof markers)[number] | null = null;

    for (const marker of markers) {
      const idx = text.indexOf(marker.open, currentIndex);
      if (idx !== -1 && (earliestOpenIdx === -1 || idx < earliestOpenIdx)) {
        earliestOpenIdx = idx;
        selectedMarker = marker;
      }
    }

    if (earliestOpenIdx === -1) {
      const remaining = text.slice(currentIndex);
      if (remaining) blocks.push({ type: 'finalOutput', content: remaining });
      break;
    }

    if (earliestOpenIdx > currentIndex) {
      const preceding = text.slice(currentIndex, earliestOpenIdx);
      if (preceding) blocks.push({ type: 'finalOutput', content: preceding });
    }

    if (!selectedMarker) continue;
    const contentStartIdx = earliestOpenIdx + selectedMarker.open.length;
    const closeIdx = text.indexOf(selectedMarker.close, contentStartIdx);

    if (closeIdx !== -1) {
      blocks.push({
        type: 'thinking',
        content: text.slice(contentStartIdx, closeIdx),
      });
      currentIndex = closeIdx + selectedMarker.close.length;
    } else {
      blocks.push({ type: 'thinking', content: text.slice(contentStartIdx) });
      currentIndex = text.length;
    }
  }

  return blocks;
}

export function getDisplayBlocks(
  blocks?: MessageBlock[],
  thinking?: string,
  tools?: ChatMessage['tools'],
  content?: string,
): MessageBlock[] {
  try {
    const result: MessageBlock[] = [];
    let hasFinalContent = false;

    if (blocks && blocks.length > 0) {
      for (const block of blocks) {
        if (block.type === 'finalOutput' && block.content) {
          hasFinalContent = true;
          const parsed = parseSequentialText(block.content);
          for (const [subIndex, sub] of parsed.entries()) {
            result.push({
              id: `${block.id}_sub_${subIndex}_${sub.type}`,
              type: sub.type,
              content: sub.content,
            });
          }
        } else {
          result.push(block);
        }
      }

      if (!hasFinalContent && content && content.trim()) {
        const parsed = parseSequentialText(content);
        for (const [subIndex, sub] of parsed.entries()) {
          result.push({
            id: `safety_content_sub_${subIndex}_${sub.type}`,
            type: sub.type,
            content: sub.content,
          });
        }
      }

      if (result.length > 0) return result;
    }

    const resultFallback: MessageBlock[] = [];
    if (thinking && thinking.trim()) {
      resultFallback.push({
        id: 'fallback_thinking',
        type: 'thinking',
        content: thinking.trim(),
      });
    }

    if (tools && tools.length > 0) {
      for (const tool of tools) {
        const isCommand =
          tool.name.startsWith('@run_command') || tool.name.startsWith('run_command');
        resultFallback.push({
          id: `fallback_tool_${tool.id}`,
          type: isCommand ? 'command' : 'toolCall',
          tool,
        });
      }
    }

    if (content && content.trim()) {
      const parsed = parseSequentialText(content);
      for (const [subIndex, sub] of parsed.entries()) {
        resultFallback.push({
          id: `fallback_content_sub_${subIndex}_${sub.type}`,
          type: sub.type,
          content: sub.content,
        });
      }
    }

    if (resultFallback.length > 0) return resultFallback;
  } catch (err) {
    console.error('Failed to parse blocks, falling back:', err);
  }

  return [
    {
      id: 'fallback_raw',
      type: 'finalOutput',
      content: content || '',
    },
  ];
}

export function parseThinkingAndContent(
  rawContent: string,
  existingThinking?: string,
): { thinking: string; content: string } {
  const blocks = parseSequentialText(rawContent);
  let thinking = existingThinking || '';
  let content = '';

  for (const block of blocks) {
    if (block.type === 'thinking') {
      thinking += (thinking ? '\n' : '') + block.content;
    } else {
      content += block.content;
    }
  }

  return { thinking: thinking.trim(), content: content.trim() };
}
