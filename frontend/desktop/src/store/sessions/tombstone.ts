/* Short-lived delete tombstones so reconcile cannot resurrect a just-deleted id. */

const _tombstonedSessionIds = new Map<string, number>();
const TOMBSTONE_TTL_MS = 120_000;

export function tombstoneSessionId(id: string): void {
  if (!id) return;
  _tombstonedSessionIds.set(id, Date.now() + TOMBSTONE_TTL_MS);
}

export function isSessionIdTombstoned(id: string | undefined | null): boolean {
  if (!id) return false;
  const exp = _tombstonedSessionIds.get(id);
  if (exp == null) return false;
  if (Date.now() > exp) {
    _tombstonedSessionIds.delete(id);
    return false;
  }
  return true;
}
