/* ── RecalledMemorySection — agent-captured memories (on-demand recall) ── */

import { AutoMemoryBrowse } from './AutoMemoryBrowse';

export function RecalledMemorySection() {
  return (
    <AutoMemoryBrowse
      origin="recalled"
      title="Recalled Memory"
      subtitle="Past context August learned automatically. Searchable on demand in chat — browse by topic, open a row for details."
      emptyTitle="No recalled memories yet"
      emptyHint="August saves these as you chat. They stay searchable via memory tools rather than filling every prompt."
      listComposerPlaceholder=""
      detailComposerPlaceholder="Tell August what to change or remove"
      showListComposer={false}
    />
  );
}
