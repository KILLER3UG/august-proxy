/* Artifacts page — workspace .aug plans/todos in the chat shell (like Brain). */

import { PlansSection } from '@/sections/settings/PlansSection';

export function ArtifactsPage() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="p-6 max-w-5xl mx-auto">
        <PlansSection />
      </div>
    </div>
  );
}
