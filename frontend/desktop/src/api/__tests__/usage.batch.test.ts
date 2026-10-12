/* usageApi.sessions — the two ceilings on one batched read.
 *
 * The server truncates the `IN (...)` at 250 ids; the route rejects an `ids`
 * string over 8000 characters with a 422. A count-only cap satisfied the first
 * and tripped the second, because the session ids this app mints are 36-character
 * uuids: 250 of them is 9,249 characters, and one 422 zeroes every row's token
 * delta rather than the tail of it. These tests pin the character bound, which
 * is the one a count cap cannot express.
 */

import { describe, expect, it } from 'vitest';
import { USAGE_BATCH_MAX_CHARS, USAGE_BATCH_MAX_IDS, usageBatchIds } from '../usage';

const uuid = (i: number) =>
  `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const encodedLen = (ids: string[]) => ids.map(encodeURIComponent).join(',').length;

describe('usageBatchIds', () => {
  it('keeps 250 uuid-shaped ids under the route ceiling', () => {
    const ids = usageBatchIds(Array.from({ length: 400 }, (_, i) => uuid(i)));
    // The count cap alone would have sent 250 and produced a 9,249-char query.
    expect(encodedLen(ids)).toBeLessThanOrEqual(USAGE_BATCH_MAX_CHARS);
    expect(encodedLen(Array.from({ length: 250 }, (_, i) => uuid(i)))).toBeGreaterThan(8000);
    expect(ids.length).toBeLessThan(USAGE_BATCH_MAX_IDS);
    expect(ids[0]).toBe(uuid(0));
    expect(ids[ids.length - 1]).not.toBe(uuid(399));
  });

  it('still uses the server count cap when ids are short enough', () => {
    const ids = usageBatchIds(Array.from({ length: 400 }, (_, i) => `wb_${i}`));
    expect(ids).toHaveLength(USAGE_BATCH_MAX_IDS);
    expect(encodedLen(ids)).toBeLessThanOrEqual(USAGE_BATCH_MAX_CHARS);
  });

  it('dedupes and trims before deciding what fits', () => {
    expect(usageBatchIds([' a ', 'a', '', '  ', 'b'])).toEqual(['a', 'b']);
    expect(usageBatchIds([])).toEqual([]);
    expect(usageBatchIds([',,', ' '])).toEqual([]);
  });

  it('never sends a query the route would refuse outright', () => {
    // Longest realistic id shape: a uuid plus a workbench prefix.
    const fat = Array.from({ length: 250 }, (_, i) => `wb_${uuid(i)}`);
    expect(encodedLen(usageBatchIds(fat))).toBeLessThanOrEqual(8000);
  });
});
