/**
 * Durable sub-agent transcript blocks.
 *
 * A delegated worker's own timeline (its thinking, tool calls, results and
 * final answer) is accumulated by `applySubagentEvent` into the session
 * stream store's `subagentBlocks` map. That map is in-memory only: it is
 * dropped by the LRU cap, emptied on reload, and starts empty on a session
 * switch. The parent transcript's own blocks are durable twice over —
 * localStorage via `persistMessages`, and the backend via the structured
 * block sync — so mirroring each worker onto a `subagent` block of its parent
 * assistant message is what makes the inline worker output survive a restart.
 *
 * The block id is `b_sub_<jobId>`: derived from the stable backend job id, so
 * re-syncing the same run replaces its block in place instead of appending a
 * second one. That is the whole anti-duplication story — a reconnect that
 * replays `subagentStart` for a job already on the block list must collapse
 * onto the existing block, and a run whose block is already settled must not
 * be restarted by a late duplicate frame.
 */

import type { ChatMessage, MessageBlock, SubagentBlockState, SubagentSnapshot } from '@/types/chat';

/** Block id for a worker's durable snapshot. Stable per job. */
export function subagentBlockId(jobId: string): string {
  return `b_sub_${jobId}`;
}

/** The live container, reduced to its persistable form. */
export function toSnapshot(state: SubagentBlockState): SubagentSnapshot {
  return {
    jobId: state.jobId,
    parentToolId: state.parentToolId,
    agentId: state.agentId,
    task: state.task,
    status: state.status,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    error: state.error,
    workstream: state.workstream,
    skills: state.skills,
    blocks: state.blocks,
  };
}

/** Inverse of {@link toSnapshot} — rebuild the live container shape. */
export function fromSnapshot(snapshot: SubagentSnapshot): SubagentBlockState {
  return {
    id: `sb_${snapshot.jobId}`,
    jobId: snapshot.jobId,
    parentToolId: snapshot.parentToolId,
    agentId: snapshot.agentId,
    task: snapshot.task,
    status: snapshot.status,
    startedAt: snapshot.startedAt,
    finishedAt: snapshot.finishedAt,
    error: snapshot.error,
    workstream: snapshot.workstream,
    skills: snapshot.skills,
    blocks: Array.isArray(snapshot.blocks) ? snapshot.blocks : [],
  };
}

/** A snapshot is only usable when it names a job and carries a timeline. */
function isUsableSnapshot(value: unknown): value is SubagentSnapshot {
  if (!value || typeof value !== 'object') return false;
  const s = value as Partial<SubagentSnapshot>;
  return typeof s.jobId === 'string' && !!s.jobId.trim();
}

/**
 * Read one worker snapshot off a block. Tolerates a row written before the
 * shape was pinned: anything that is not an object is simply absent, so the
 * caller renders the row without a timeline rather than crashing on it.
 */
export function readSnapshot(block: MessageBlock | undefined): SubagentSnapshot | null {
  if (!block || block.type !== 'subagent') return null;
  return isUsableSnapshot(block.subagent) ? block.subagent : null;
}

/**
 * Upsert one worker's snapshot into a block list, keyed by job id.
 *
 * Returns the SAME array reference when the incoming snapshot is identical to
 * what is already stored, so a duplicate SSE frame costs no re-render. A
 * SETTLED block is never downgraded back to running: the backend can replay
 * an in-flight `subagentStart` after a reconnect, and letting that reset a
 * finished worker to "running" was the visible symptom of output appearing to
 * un-finish on every session switch.
 */
export function upsertSnapshotBlock(
  blocks: MessageBlock[],
  state: SubagentBlockState,
): MessageBlock[] {
  const id = subagentBlockId(state.jobId);
  const idx = blocks.findIndex((b) => b.id === id);
  const next: MessageBlock = {
    id,
    type: 'subagent',
    subagent: toSnapshot(state),
  };

  if (idx === -1) return [...blocks, next];

  const current = blocks[idx];
  const existing = readSnapshot(current);
  if (existing && isSettled(existing.status) && !isSettled(state.status)) {
    return blocks; // late duplicate frame — keep the settled transcript
  }
  if (existing && sameSnapshot(existing, next.subagent!)) return blocks;
  const out = [...blocks];
  out[idx] = { ...next, id: current.id };
  return out;
}

/** Statuses that will not change again. */
export function isSettled(
  status: SubagentBlockState['status'] | string | undefined,
): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'partial';
}

/** Field-wise equality, cheap enough to run on every SSE frame. */
function sameSnapshot(a: SubagentSnapshot, b: SubagentSnapshot): boolean {
  if (
    a.status !== b.status ||
    a.agentId !== b.agentId ||
    a.task !== b.task ||
    a.error !== b.error ||
    a.finishedAt !== b.finishedAt ||
    a.workstream !== b.workstream ||
    a.parentToolId !== b.parentToolId
  ) {
    return false;
  }
  const ab = a.blocks ?? [];
  const bb = b.blocks ?? [];
  if (ab.length !== bb.length) return false;
  for (let i = 0; i < ab.length; i++) {
    const x = ab[i];
    const y = bb[i];
    if (x.id !== y.id || x.type !== y.type || x.content !== y.content) return false;
    if ((x.tool?.status ?? null) !== (y.tool?.status ?? null)) return false;
    if ((x.tool?.summary ?? '') !== (y.tool?.summary ?? '')) return false;
  }
  return true;
}

/** Every worker snapshot on a block list, in spawn order. */
export function collectSnapshots(blocks: MessageBlock[] | undefined): SubagentSnapshot[] {
  if (!Array.isArray(blocks)) return [];
  const out: SubagentSnapshot[] = [];
  for (const block of blocks) {
    const snapshot = readSnapshot(block);
    if (snapshot) out.push(snapshot);
  }
  return out;
}

/**
 * Rebuild the live `subagentBlocks` map from a restored transcript.
 *
 * Runs on history load and on session-store init, which is what closes the
 * reload/session-switch gap: the drawer and the inline row both read the
 * store, so rehydrating there fixes both at once. Snapshots are ordered by
 * `startedAt` so rows render in the order the workers were launched, and the
 * first snapshot wins for a duplicate job id (two rows for one worker would
 * render the same transcript twice).
 */
export function snapshotsToState(
  snapshots: ReadonlyArray<SubagentSnapshot>,
): Map<string, SubagentBlockState> {
  const out = new Map<string, SubagentBlockState>();
  for (const snapshot of snapshots) {
    if (!isUsableSnapshot(snapshot) || out.has(snapshot.jobId)) continue;
    out.set(snapshot.jobId, fromSnapshot(snapshot));
  }
  return new Map(
    [...out.entries()].sort((a, b) => (a[1].startedAt || 0) - (b[1].startedAt || 0)),
  );
}

/** Every persisted worker across a whole transcript, de-duplicated by job. */
export function snapshotsFromMessages(
  messages: ReadonlyArray<ChatMessage> | undefined,
): Map<string, SubagentBlockState> {
  const collected: SubagentSnapshot[] = [];
  for (const message of messages ?? []) {
    collected.push(...collectSnapshots(message.blocks));
  }
  return snapshotsToState(collected);
}

/**
 * Replace (or add) one worker's snapshot inside the message that spawned it.
 *
 * The owner is chosen by `parentToolId`, matching how the live map is keyed,
 * with a fallback to the last assistant message. The backend only reports a
 * `parentToolUseId` when the spawn happened inside a tool call; without one
 * the row is anchored to the newest assistant turn, which is where the user
 * is reading.
 */
export function attachSnapshot(
  messages: ChatMessage[],
  state: SubagentBlockState,
): ChatMessage[] {
  if (!messages.length) return messages;
  let target = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const blocks = messages[i].blocks;
    if (!Array.isArray(blocks)) continue;
    if (blocks.some((b) => b.id === subagentBlockId(state.jobId))) {
      target = i;
      break;
    }
    if (blocks.some((b) => b.tool?.id === state.parentToolId)) {
      target = i;
      break;
    }
    if (target === -1 && messages[i].role === 'assistant') target = i;
  }
  if (target === -1) return messages;
  const owner = messages[target];
  const blocks = owner.blocks ?? [];
  const nextBlocks = upsertSnapshotBlock(blocks, state);
  if (nextBlocks === blocks) return messages;
  const out = [...messages];
  out[target] = { ...owner, blocks: nextBlocks };
  return out;
}
