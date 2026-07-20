/* Skills & Tools page — skills catalog in the chat shell (like Brain). */

import { SkillsSection } from '@/sections/settings/SkillsSection';

export function SkillsPage() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="p-6 max-w-5xl mx-auto">
        <SkillsSection />
      </div>
    </div>
  );
}
