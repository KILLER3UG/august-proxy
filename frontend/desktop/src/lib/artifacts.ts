/* ── Artifacts — session-wide deliverables gallery ──────────────── */
/* Hermes/DeepSeek pattern: collect what the agent produced (files,     */
/* images, links) across the whole session into a searchable gallery.   */
/* Extracted from ChatMessage[] so it stays pure + testable.           */

import { collectProducedFiles } from '@/lib/produced-files';
import type { ChatMessage, FileAttachment } from '@/types/chat';

export type ArtifactKind = 'file' | 'image' | 'link';

export interface SessionArtifact {
  id: string;
  kind: ArtifactKind;
  /** Human label (basename for files, domain for links, filename for images) */
  label: string;
  /** Full path or URL */
  href: string;
  /** Optional preview / snippet */
  snippet?: string;
  /** Source message id for jump-back */
  sourceMessageId: string;
  /** ISO timestamp of source message */
  timestamp: string;
  /** Extra — mime for images, ext for files */
  meta?: string;
}

const LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
const BARE_LINK_RE = /(?<![(\]])(https?:\/\/[^\s<>"']+)/g;

function extractLinks(markdown: string): Array<{ title: string; url: string }> {
  const out: Array<{ title: string; url: string }> = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(markdown))) {
    const url = m[2];
    if (!seen.has(url)) {
      seen.add(url);
      out.push({ title: m[1].trim() || url, url });
    }
  }
  BARE_LINK_RE.lastIndex = 0;
  while ((m = BARE_LINK_RE.exec(markdown))) {
    const url = m[1];
    if (!seen.has(url)) {
      seen.add(url);
      try {
        const u = new URL(url);
        out.push({ title: u.hostname.replace(/^www\./, ''), url });
      } catch {
        out.push({ title: url, url });
      }
    }
  }
  return out;
}

function labelForFile(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function domainForUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export function collectArtifacts(messages: ChatMessage[]): SessionArtifact[] {
  const out: SessionArtifact[] = [];
  const seenFile = new Set<string>();
  const seenLink = new Set<string>();
  const seenImage = new Set<string>();

  for (const msg of messages) {
    // 1) Produced files — per-turn edit tool paths
    const files = collectProducedFiles(msg.blocks);
    for (const path of files) {
      const key = path.replace(/\\/g, '/');
      if (seenFile.has(key)) continue;
      seenFile.add(key);
      out.push({
        id: `file:${key}:${msg.id}`,
        kind: 'file',
        label: labelForFile(path),
        href: path,
        snippet: path,
        sourceMessageId: msg.id,
        timestamp: msg.timestamp,
        meta: path.split('.').pop()?.toLowerCase() || '',
      });
    }

    // 2) Attachments — images + files attached to user messages or produced by agent
    const atts: FileAttachment[] = msg.attachments ?? [];
    for (const att of atts) {
      if (att.type === 'image' && (att.dataUrl || att.path)) {
        const href = att.dataUrl || att.path || '';
        if (!href || seenImage.has(href.slice(0, 120))) continue;
        seenImage.add(href.slice(0, 120));
        out.push({
          id: `image:${att.name}:${msg.id}`,
          kind: 'image',
          label: att.name,
          href,
          snippet: att.path || att.name,
          sourceMessageId: msg.id,
          timestamp: msg.timestamp,
          meta: att.mimeType || 'image',
        });
      } else if (att.path && att.type === 'text') {
        const key = att.path.replace(/\\/g, '/');
        if (seenFile.has(key)) continue;
        seenFile.add(key);
        out.push({
          id: `file:${key}:${msg.id}`,
          kind: 'file',
          label: att.name || labelForFile(att.path),
          href: att.path,
          snippet: att.path,
          sourceMessageId: msg.id,
          timestamp: msg.timestamp,
          meta: att.path.split('.').pop()?.toLowerCase() || '',
        });
      }
    }

    // 3) Links — from assistant message markdown (content + block content)
    if (msg.role === 'assistant') {
      const texts: string[] = [];
      if (msg.content) texts.push(msg.content);
      for (const b of msg.blocks ?? []) {
        if (b.content) texts.push(b.content);
        if (b.tool?.preview) texts.push(b.tool.preview);
        if (b.tool?.summary) texts.push(b.tool.summary);
      }
      for (const text of texts) {
        for (const { title, url } of extractLinks(text)) {
          if (seenLink.has(url)) continue;
          seenLink.add(url);
          out.push({
            id: `link:${url}:${msg.id}`,
            kind: 'link',
            label: title || domainForUrl(url),
            href: url,
            snippet: url,
            sourceMessageId: msg.id,
            timestamp: msg.timestamp,
            meta: domainForUrl(url),
          });
        }
      }
    }
  }

  // Newest last (insertion order). Keep stable — caller can sort.
  return out;
}

export function artifactKindLabel(kind: ArtifactKind): string {
  switch (kind) {
    case 'file': return 'Files';
    case 'image': return 'Images';
    case 'link': return 'Links';
  }
}
