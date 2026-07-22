/* ── AddedMemorySection — user-authored memories (injected every turn) ── */

import { AutoMemoryBrowse } from './AutoMemoryBrowse';

export function AddedMemorySection() {
  return (
    <AutoMemoryBrowse
      origin="added"
      title="Added Memory"
      subtitle="Facts you told August to remember. These are included in every chat turn."
      emptyTitle="No added memories yet"
      emptyHint="Add something below — for example, your dog’s name or a standing preference."
      listComposerPlaceholder="My dog's name is Beans"
      detailComposerPlaceholder="Tell August what to change or remove"
      showListComposer
    />
  );
}
