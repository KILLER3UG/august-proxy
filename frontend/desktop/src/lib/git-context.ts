/* ── @git context snapshot ─────────────────────────────────────────────── */
/* Compact git state (branch, dirty files, recent commits) appended to the  */
/* outgoing request when the user mentions @git. Best-effort: any failure   */
/* resolves to null and the message sends without context.                  */

import { gitApi } from '@/api/git';

export async function buildGitContextBlock(
  sessionId: string | null,
): Promise<string | null> {
  try {
    const sid = sessionId ?? undefined;
    const [branch, status, log] = await Promise.all([
      gitApi.branch(sid),
      gitApi.status(sid),
      gitApi.log(sid, 5),
    ]);
    const commits = (log.log || '').trim();
    if (!branch.current && status.files.length === 0 && !commits) return null;

    const lines: string[] = ['<git_context>'];
    if (branch.current) lines.push(`branch: ${branch.current}`);
    const dirty = status.files.slice(0, 20);
    if (dirty.length > 0) {
      lines.push('changed files:');
      for (const f of dirty) {
        lines.push(`  ${f.status} ${f.path} (+${f.added}/-${f.removed})`);
      }
      if (status.files.length > dirty.length) {
        lines.push(`  …and ${status.files.length - dirty.length} more`);
      }
    } else {
      lines.push('changed files: (clean working tree)');
    }
    if (commits) {
      lines.push('recent commits:');
      for (const c of commits.split('\n').slice(0, 5)) {
        lines.push(`  ${c}`);
      }
    }
    lines.push('</git_context>');
    return lines.join('\n');
  } catch {
    return null;
  }
}
