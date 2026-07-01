/**
 * Registry event bus — tiny pub/sub used by voice command handlers and
 * subscribers (ChatThread, etc.) to coordinate without React coupling.
 *
 * Handlers run outside any React lifecycle; React components subscribe
 * to these events from within `useEffect`. The bus is intentionally
 * synchronous and in-process.
 */

import type { ChatMessageLite } from './registry';

export type VoiceCommandEvent =
  | {
      type: 'push-card';
      commandId: string;
      context?: Record<string, unknown>;
    }
  | {
      type: 'push-message';
      message: ChatMessageLite;
    }
  | {
      type: 'clear-chat';
    }
  | {
      type: 'new-session';
    }
  | {
      type: 'insert-text';
      text: string;
    }
  | {
      type: 'send-message';
      text: string;
    }
  | {
      type: 'toast';
      level: 'info' | 'success' | 'error';
      message: string;
    }
  | {
      type: 'open-skills';
    }
  | {
      type: 'load-skill';
      skillName: string;
    }
  | {
      type: 'fetch-skills';
      query: string;
    }
  | {
      type: 'open-exam';
      topic?: string;
    }
  | {
      type: 'reset-session';
    };

type Listener = (event: VoiceCommandEvent) => void;

class VoiceCommandEventBus {
  private listeners = new Set<Listener>();

  emit(event: VoiceCommandEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        // Never let one listener break the rest.
        // eslint-disable-next-line no-console
        console.error('[voice-events] listener threw', err);
      }
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  clear(): void {
    this.listeners.clear();
  }

  size(): number {
    return this.listeners.size;
  }
}

export const voiceCommandEvents = new VoiceCommandEventBus();
export type { Listener as VoiceCommandEventListener };
