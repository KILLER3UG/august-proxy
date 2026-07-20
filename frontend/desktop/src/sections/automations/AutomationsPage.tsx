/* Automations page — scheduled jobs in the chat shell (like Brain). */

import { Automations } from './Automations';

export function AutomationsPage() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-5xl mx-auto">
        <Automations />
      </div>
    </div>
  );
}
