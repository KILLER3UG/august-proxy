/* ── Composer popovers ─────────────────────────────────────────────────── */
/* Tracks + / @ / slash menus: open state, anchor positions, skill search,  */
/* keyboard navigation, and text insertion into the composer textarea.     */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
} from 'react';
import { api } from '@/api/client';
import { voiceCommandEvents } from '@/api/voice/registry-events';
import { getDisplayCommands } from '@/api/voice/registry';
import { COMPOSER_TOOLS as TOOLS, parseAtMention, type MentionItem } from '../composer-mentions';

/** Closers useChatSend calls after a send so open popovers dismiss. */
export type ComposerDropdownApi = {
  setShowToolsDropdown: (open: boolean) => void;
  setShowCommandsDropdown: (open: boolean) => void;
};

export type AnchorPos = { top: number; left: number };

function useFixedAnchor(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  opts?: { leftOffset?: number },
): AnchorPos | null {
  const [pos, setPos] = useState<AnchorPos | null>(null);
  const leftOffset = opts?.leftOffset ?? 0;

  useEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const compute = () => {
      const el = anchorRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setPos({ top: Math.max(8, r.top - 8), left: r.left + leftOffset });
    };
    requestAnimationFrame(compute);
    window.addEventListener('scroll', compute, true);
    window.addEventListener('resize', compute);
    return () => {
      window.removeEventListener('scroll', compute, true);
      window.removeEventListener('resize', compute);
    };
  }, [open, anchorRef, leftOffset]);

  return pos;
}

export interface UseComposerPopoversArgs {
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  taRef: RefObject<HTMLTextAreaElement | null>;
  dropdownApiRef?: MutableRefObject<ComposerDropdownApi | null>;
  send: (textOverride?: string) => Promise<void>;
}

/**
 * Owns slash-command, @-mention, tools, and composer-actions popover state.
 */
export function useComposerPopovers({
  input,
  setInput,
  taRef,
  dropdownApiRef,
  send,
}: UseComposerPopoversArgs) {
  const [showComposerActionsDropdown, setShowComposerActionsDropdown] = useState(false);
  const [showToolsDropdown, setShowToolsDropdown] = useState(false);
  const [showCommandsDropdown, setShowCommandsDropdown] = useState(false);
  const [highlightedCommandIndex, setHighlightedCommandIndex] = useState(0);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionStart, setMentionStart] = useState(0);
  const [skillMentions, setSkillMentions] = useState<MentionItem[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [highlightedMentionIndex, setHighlightedMentionIndex] = useState(0);

  const composerActionsTriggerRef = useRef<HTMLButtonElement>(null);
  const composerRootRef = useRef<HTMLDivElement>(null);

  const showMentionsDropdown = mentionQuery !== null;

  const composerActionsPos = useFixedAnchor(
    showComposerActionsDropdown,
    composerActionsTriggerRef,
  );
  const toolsPos = useFixedAnchor(
    showToolsDropdown || showMentionsDropdown,
    composerRootRef,
    { leftOffset: 8 },
  );
  const commandsPos = useFixedAnchor(showCommandsDropdown, composerRootRef, {
    leftOffset: 8,
  });

  // Expose popover closers to useChatSend (dismiss after message send).
  useEffect(() => {
    if (!dropdownApiRef) return;
    dropdownApiRef.current = {
      setShowToolsDropdown,
      setShowCommandsDropdown,
    };
    return () => {
      dropdownApiRef.current = null;
    };
  }, [dropdownApiRef]);

  useEffect(() => {
    if (mentionQuery === null) return;
    let cancelled = false;
    setSkillsLoading(true);
    const q = mentionQuery.trim();
    const url = '/api/skills' + (q ? `?q=${encodeURIComponent(q)}` : '');
    api
      .get<{ total: number; skills: Array<{ name: string; description?: string; category?: string }> }>(
        url,
      )
      .then((data) => {
        if (cancelled) return;
        const items: MentionItem[] = (data.skills ?? []).slice(0, 30).map((s) => ({
          kind: 'skill' as const,
          name: s.name,
          desc: s.description || s.category || 'Skill',
          insert: `@skill:${s.name} `,
        }));
        setSkillMentions(items);
      })
      .catch(() => {
        if (!cancelled) setSkillMentions([]);
      })
      .finally(() => {
        if (!cancelled) setSkillsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [mentionQuery]);

  const mentionItems: MentionItem[] = useMemo(() => {
    if (mentionQuery === null) return [];
    const q = mentionQuery.toLowerCase();
    const tools: MentionItem[] = TOOLS.filter((t) => {
      if (!q) return true;
      return t.name.toLowerCase().includes(q) || t.desc.toLowerCase().includes(q);
    }).map((t) => ({
      kind: 'tool' as const,
      name: t.name,
      desc: t.desc,
      insert: t.name.startsWith('@') ? `${t.name} ` : `@${t.name} `,
    }));
    const skills = skillMentions.filter((s) => {
      if (!q) return true;
      return s.name.toLowerCase().includes(q) || s.desc.toLowerCase().includes(q);
    });
    return [...skills, ...tools];
  }, [mentionQuery, skillMentions]);

  const closeAllPopovers = useCallback(() => {
    setShowComposerActionsDropdown(false);
    setShowToolsDropdown(false);
    setShowCommandsDropdown(false);
    setMentionQuery(null);
  }, []);

  useEffect(() => {
    const anyOpen =
      showComposerActionsDropdown ||
      showToolsDropdown ||
      showCommandsDropdown ||
      showMentionsDropdown;
    if (!anyOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (composerActionsTriggerRef.current?.contains(t)) {
        return;
      }
      const target = e.target as HTMLElement | null;
      if (target?.closest?.('[data-composer-popover]')) return;
      closeAllPopovers();
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeAllPopovers();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [
    showComposerActionsDropdown,
    showToolsDropdown,
    showCommandsDropdown,
    showMentionsDropdown,
    closeAllPopovers,
  ]);

  const insertText = useCallback(
    (text: string) => {
      const ta = taRef.current;
      if (!ta) {
        setInput((prev) => prev + text);
        return;
      }
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const nextText = ta.value.substring(0, start) + text + ta.value.substring(end);
      setInput(nextText);
      setTimeout(() => {
        ta.focus();
        ta.selectionStart = ta.selectionEnd = start + text.length;
      }, 50);
    },
    [setInput, taRef],
  );

  const insertCommand = useCallback(
    (name: string) => {
      const fullCmd = name + ' ';
      const ta = taRef.current;
      if (!ta) {
        setInput(() => '/' + name + ' ');
        return;
      }
      const cursor = ta.selectionStart ?? ta.value.length;
      const before = ta.value.slice(0, cursor);
      const match = before.match(/\/[\w-]*$/);
      const tokenStart = match ? cursor - match[0].length : cursor;
      const after = ta.value.slice(cursor);
      const nextText = ta.value.slice(0, tokenStart) + fullCmd + after;
      setInput(nextText);
      setTimeout(() => {
        ta.focus();
        const newCursor = tokenStart + fullCmd.length;
        ta.selectionStart = ta.selectionEnd = newCursor;
      }, 50);
    },
    [setInput, taRef],
  );

  const insertMention = useCallback(
    (item: MentionItem) => {
      setMentionQuery(null);
      setShowToolsDropdown(false);
      if (item.kind === 'skill') {
        const ta = taRef.current;
        const value = ta?.value ?? input;
        const cursor = ta?.selectionStart ?? value.length;
        const parsed = parseAtMention(value, cursor);
        if (parsed) {
          setInput(value.slice(0, parsed.start) + value.slice(cursor));
        }
        voiceCommandEvents.emit({ type: 'load-skill', skillName: item.name });
        return;
      }
      const ta = taRef.current;
      const value = ta?.value ?? input;
      const cursor = ta?.selectionStart ?? value.length;
      const parsed = parseAtMention(value, cursor);
      const start = parsed?.start ?? mentionStart;
      const end = cursor;
      const next = value.slice(0, start) + item.insert + value.slice(end);
      setInput(next);
      setTimeout(() => {
        if (!ta) return;
        ta.focus();
        const pos = start + item.insert.length;
        ta.selectionStart = ta.selectionEnd = pos;
      }, 50);
    },
    [input, mentionStart, setInput, taRef],
  );

  const loadSkillsIfEmpty = useCallback(() => {
    if (skillMentions.length > 0) return;
    api
      .get<{
        skills: Array<{
          name: string;
          description?: string;
          category?: string;
        }>;
      }>('/api/skills')
      .then((data) => {
        setSkillMentions(
          (data.skills ?? []).slice(0, 30).map((s) => ({
            kind: 'skill' as const,
            name: s.name,
            desc: s.description || s.category || 'Skill',
            insert: `@skill:${s.name} `,
          })),
        );
      })
      .catch(() => undefined);
  }, [skillMentions.length]);

  const openMentionPicker = useCallback(() => {
    setShowToolsDropdown(true);
    setMentionQuery('');
    setMentionStart(input.length);
    setShowCommandsDropdown(false);
    setShowComposerActionsDropdown(false);
    loadSkillsIfEmpty();
  }, [input.length, loadSkillsIfEmpty]);

  const onKey = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (showMentionsDropdown && mentionItems.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setHighlightedMentionIndex((i) => (i + 1) % mentionItems.length);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setHighlightedMentionIndex(
            (i) => (i - 1 + mentionItems.length) % mentionItems.length,
          );
          return;
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          const item = mentionItems[highlightedMentionIndex] ?? mentionItems[0];
          if (item) insertMention(item);
          return;
        }
        if (e.key === 'Tab' && !e.shiftKey) {
          e.preventDefault();
          const item = mentionItems[highlightedMentionIndex] ?? mentionItems[0];
          if (item) insertMention(item);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          setMentionQuery(null);
          return;
        }
      }
      if (showCommandsDropdown) {
        const allCommands = getDisplayCommands();
        const visible = allCommands.filter((c) => {
          const q = input.trim().toLowerCase();
          if (!q) return true;
          return c.name.toLowerCase().startsWith(q);
        });
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setHighlightedCommandIndex((i) => (i + 1) % Math.max(1, visible.length));
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setHighlightedCommandIndex(
            (i) => (i - 1 + Math.max(1, visible.length)) % Math.max(1, visible.length),
          );
          return;
        }
        if (e.key === 'Enter' && !e.shiftKey && visible.length > 0) {
          e.preventDefault();
          const cmd = visible[highlightedCommandIndex] ?? visible[0];
          insertCommand(cmd.name);
          setShowCommandsDropdown(false);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          setShowCommandsDropdown(false);
          return;
        }
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void send();
      }
    },
    [
      showMentionsDropdown,
      mentionItems,
      highlightedMentionIndex,
      insertMention,
      showCommandsDropdown,
      input,
      highlightedCommandIndex,
      insertCommand,
      send,
    ],
  );

  const handleInputChange = useCallback(
    (value: string) => {
      setInput(value);
      setHighlightedCommandIndex(0);
      setHighlightedMentionIndex(0);
      if (value.startsWith('/')) {
        setShowCommandsDropdown(true);
        setShowToolsDropdown(false);
        setMentionQuery(null);
        return;
      }
      if (showCommandsDropdown && !value.startsWith('/')) {
        setShowCommandsDropdown(false);
      }
      const ta = taRef.current;
      const cursor = ta?.selectionStart ?? value.length;
      const at = parseAtMention(value, cursor);
      if (at) {
        setMentionQuery(at.query);
        setMentionStart(at.start);
        setShowToolsDropdown(false);
        setShowCommandsDropdown(false);
      } else if (mentionQuery !== null) {
        setMentionQuery(null);
      }
    },
    [setInput, showCommandsDropdown, taRef, mentionQuery],
  );

  // Insert-text custom event from other UI (e.g. cards) into the composer.
  useEffect(() => {
    const handleInsertText = (e: Event) => {
      const customEvent = e as CustomEvent<string>;
      if (customEvent.detail) {
        insertText(customEvent.detail);
      }
    };
    window.addEventListener('august-insert-composer-text', handleInsertText);
    return () => {
      window.removeEventListener('august-insert-composer-text', handleInsertText);
    };
  }, [insertText]);

  return {
    composerRootRef,
    composerActionsTriggerRef,
    showComposerActionsDropdown,
    setShowComposerActionsDropdown,
    showToolsDropdown,
    setShowToolsDropdown,
    showCommandsDropdown,
    setShowCommandsDropdown,
    showMentionsDropdown,
    mentionQuery,
    setMentionQuery,
    skillMentions,
    skillsLoading,
    mentionItems,
    highlightedMentionIndex,
    highlightedCommandIndex,
    composerActionsPos,
    toolsPos,
    commandsPos,
    insertText,
    insertCommand,
    insertMention,
    openMentionPicker,
    onKey,
    handleInputChange,
  };
}
