/* ── useChatVoiceCommands ─────────────────────────────────────────────── */
/* Subscribes to the voice-command event bus and drives composer/chat state */
/* (cards, skills, exam, AUG.md, dictation match → handler).               */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { toast } from 'sonner';
import { api } from '@/api/client';
import {
  voiceCommandRegistry,
  type ChatMessageLite,
} from '@/api/voice/registry';
import { voiceCommandEvents, type VoiceCommandEvent } from '@/api/voice/registry-events';
import type { ChatMessage, FileAttachment } from '@/types/chat';
import {
  clearComposerDraft,
  persistMessages,
} from '../message-storage';

export type ExamSeed = { topic?: string; files?: string[] };
export type AugPreviewState = {
  draft: string;
  existing: boolean;
  workspacePath: string;
};

export interface UseChatVoiceCommandsOptions {
  sessionId: string | null;
  messages: ChatMessage[];
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setInput: Dispatch<SetStateAction<string>>;
  clearAttachments: () => void;
  attachments: FileAttachment[];
  /** Workspace path of the active sidebar session (for /init AUG.md). */
  workspacePath?: string | null;
  /** Latest send() from useChatSend — read via ref so the bus need not re-subscribe. */
  send: (textOverride?: string) => Promise<void>;
  setExamActive: Dispatch<SetStateAction<boolean>>;
  setExamSeed: Dispatch<SetStateAction<ExamSeed>>;
  setAugPreview: Dispatch<SetStateAction<AugPreviewState | null>>;
}

/**
 * Wires voice-command registry events into the active chat thread and
 * starts browser speech recognition for dictation / spoken slash-equivalents.
 */
export function useChatVoiceCommands(opts: UseChatVoiceCommandsOptions) {
  const {
    sessionId,
    messages,
    setMessages,
    setInput,
    clearAttachments,
    attachments,
    workspacePath,
    send,
    setExamActive,
    setExamSeed,
    setAugPreview,
  } = opts;

  const [voiceActive, setVoiceActive] = useState(false);

  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const sendRef = useRef(send);
  sendRef.current = send;

  // Handlers in `api/voice/builtins.ts` emit events; this effect applies them
  // as local state mutations (push card, clear chat, load skill, open exam, …).
  useEffect(() => {
    const unsubscribe = voiceCommandEvents.subscribe((event: VoiceCommandEvent) => {
      switch (event.type) {
        case 'push-card': {
          const cardMsg: ChatMessage = {
            id: `card-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            role: 'assistant',
            content: '',
            timestamp: new Date().toISOString(),
            kind: 'voice-command-card',
            commandId: event.commandId,
            context: event.context,
          };
          setMessages((prev) => [...prev, cardMsg]);
          persistMessages(sessionId, [...messagesRef.current, cardMsg]);
          setInput('');
          clearComposerDraft(sessionId);
          break;
        }
        case 'push-message': {
          setMessages((prev) => [...prev, event.message as unknown as ChatMessage]);
          persistMessages(
            sessionId,
            [...messagesRef.current, event.message as unknown as ChatMessage],
          );
          break;
        }
        case 'clear-chat': {
          setMessages([]);
          persistMessages(sessionId, []);
          setInput('');
          clearAttachments();
          clearComposerDraft(sessionId);
          break;
        }
        case 'new-session': {
          window.dispatchEvent(new CustomEvent('august:new-session'));
          break;
        }
        case 'insert-text': {
          setInput((prev) => prev + event.text);
          break;
        }
        case 'send-message': {
          void sendRef.current(event.text);
          break;
        }
        case 'toast': {
          if (event.level === 'error') toast.error(event.message);
          else if (event.level === 'success') toast.success(event.message);
          else toast.info(event.message);
          break;
        }
        case 'open-skills': {
          setInput('/skills ');
          break;
        }
        case 'load-skill': {
          api
            .get<{
              total: number;
              skills: Array<{
                name: string;
                description: string;
                trigger: string;
                category: string;
              }>;
            }>(`/api/skills?q=${encodeURIComponent(event.skillName)}`)
            .then((data) => {
              if (data.total === 0) {
                toast.error(
                  'No skill found matching "' +
                    event.skillName +
                    '". Try /skills to list available skills.',
                );
                return;
              }
              const skill = data.skills[0];
              const lines = [
                '[Loaded skill: **' + skill.name + '**]',
                '',
                '> **' + skill.description + '**',
                '> *Trigger: ' + (skill.trigger || '—') + '*',
                '> *Category: ' + skill.category + '*',
                '',
                'Use august__load_skill { name: "' +
                  skill.name +
                  '" } to load the full instructions.',
              ];
              setInput(lines.join('\n'));
              toast.success('Loaded skill: ' + skill.name);
            })
            .catch(() => toast.error('Failed to fetch skills.'));
          break;
        }
        case 'fetch-skills': {
          const url =
            '/api/skills' + (event.query ? '?q=' + encodeURIComponent(event.query) : '');
          api
            .get<{
              total: number;
              skills: Array<{
                name: string;
                category: string;
                enabled: boolean;
                description: string;
              }>;
            }>(url)
            .then((data) => {
              if (data.total === 0) {
                toast.info(
                  'No skills found' +
                    (event.query ? ' matching "' + event.query + '"' : '') +
                    '.',
                );
                return;
              }
              const items = data.skills
                .slice(0, 20)
                .map(
                  (s: {
                    name: string;
                    category: string;
                    enabled: boolean;
                    description: string;
                  }) =>
                    '• **' +
                    s.name +
                    '** [' +
                    s.category +
                    ']' +
                    (s.enabled ? '' : ' ⚠️ inactive') +
                    '\n  ' +
                    s.description,
                );
              setInput(
                '**Skills (' +
                  data.total +
                  ' found)**\n\n' +
                  items.join('\n\n') +
                  '\n\nUse /load <skill-name> to inject a skill into your message.',
              );
              toast.success(
                'Found ' + data.total + ' skill' + (data.total > 1 ? 's' : ''),
              );
            })
            .catch(() => toast.error('Failed to fetch skills.'));
          break;
        }
        case 'open-exam': {
          const seed = event.topic;
          if (attachments.length > 0) {
            const filePaths = attachments.map((a) => a.path || a.name).filter(Boolean);
            setExamSeed({ topic: seed, files: filePaths });
          } else {
            setExamSeed({ topic: seed, files: [] });
          }
          setExamActive(true);
          setInput('');
          clearComposerDraft(sessionId);
          break;
        }
        case 'init-aug': {
          const ws = event.workspacePath || workspacePath || '';
          setInput('');
          clearComposerDraft(sessionId);
          // Prefer refine when AUG.md already exists for this workspace.
          const decideMode = api
            .get<{ exists: boolean }>(
              '/api/aug/context' +
                (ws ? `?workspacePath=${encodeURIComponent(ws)}` : ''),
            )
            .then((c) => (c && c.exists ? 'refine' : 'create'))
            .catch(() => 'create');
          decideMode
            .then((mode) =>
              api.post<{ draft: string; existing: boolean }>('/api/aug/init', {
                mode,
                workspacePath: ws || undefined,
              }),
            )
            .then((data) => {
              setAugPreview({
                draft: data.draft || '',
                existing: Boolean(data.existing),
                workspacePath: ws || '',
              });
            })
            .catch((e: unknown) =>
              toast.error(e instanceof Error ? e.message : 'Failed to generate AUG.md'),
            );
          break;
        }
        case 'aug-preview': {
          setAugPreview({
            draft: event.draft,
            existing: event.existing,
            workspacePath: event.workspacePath,
          });
          break;
        }
        case 'aug-saved': {
          setAugPreview(null);
          toast.success('AUG.md saved');
          break;
        }
        case 'reset-session': {
          setInput('/reset');
          setTimeout(() => {
            void sendRef.current();
          }, 0);
          break;
        }
      }
    });
    return unsubscribe;
  }, [
    sessionId,
    attachments,
    workspacePath,
    setMessages,
    setInput,
    clearAttachments,
    setExamActive,
    setExamSeed,
    setAugPreview,
  ]);

  /** Starts one-shot browser speech recognition; matched voice commands clear dictation. */
  const startVoiceInput = useCallback(() => {
    if (voiceActive) return;
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
      toast.error('Speech recognition not supported in this browser');
      return;
    }
    setVoiceActive(true);
    const SpeechRecognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!SpeechRecognition) return;
    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    let finalTranscript = '';

    recognition.onresult = (event) => {
      let interim = '';
      const results = event.results;
      for (let i = event.resultIndex; i < results.length; i++) {
        if (results[i].isFinal) {
          finalTranscript += results[i][0].transcript;
        } else {
          interim += results[i][0].transcript;
        }
      }
      if (finalTranscript || interim) {
        setInput((prev) => {
          const space = prev.length > 0 && !prev.endsWith(' ') ? ' ' : '';
          return prev + space + finalTranscript + interim;
        });
      }
    };

    recognition.onend = () => {
      setVoiceActive(false);
      if (!finalTranscript) {
        toast.info('No speech detected');
        return;
      }

      // Match spoken text against the voice-command registry; on hit, strip
      // the appended transcript so only the handler's side effects remain.
      const matched = voiceCommandRegistry.matchCommand(finalTranscript);
      if (matched) {
        try {
          const handlerResult = matched.handler({
            sessionId: sessionId ?? '',
            transcript: finalTranscript,
            messages: messages as unknown as ChatMessageLite[],
            setMessages: setMessages as unknown as Dispatch<
              SetStateAction<ChatMessageLite[]>
            >,
          });
          void Promise.resolve(handlerResult).catch((err) => {
            console.error('[voice] handler threw', err);
            toast.error('Voice command failed');
          });
          toast.success(`Command: ${matched.description || matched.id}`);
          setInput((prev) => prev.replace(finalTranscript, '').trim());
          return;
        } catch (err) {
          console.error('[voice] handler threw synchronously', err);
          toast.error('Voice command failed');
        }
      }
      // No match (or below threshold): transcript stays as dictation.
    };

    recognition.onerror = (event) => {
      setVoiceActive(false);
      if (event.error !== 'no-speech') {
        toast.error(`Speech error: ${event.error}`);
      }
    };

    recognition.start();
  }, [voiceActive, sessionId, messages, setMessages, setInput]);

  return { voiceActive, startVoiceInput };
}
