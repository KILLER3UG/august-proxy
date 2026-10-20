/* Create form for a new model provider.
 * Posts name, base URL, API format, and key via providersApi.create, then
 * hands the resulting Provider back so the list rail can select it.
 */

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Plus, Eye, EyeOff, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { providersApi, type Provider, type ApiFormat } from '@/api/providers';
import { WorkspaceField } from '@/components/workspace/WorkspaceField';
import { WorkspaceSelect } from '@/components/workspace/WorkspaceSelect';
import { SettingsSelect } from '@/components/settings/SettingsSelect';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { API_FORMATS, DEFAULT_API_FORMAT } from './modelSettingsShared';

export function AddProviderForm({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (p: Provider) => void;
}) {
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [apiFormat, setApiFormat] = useState<ApiFormat>(DEFAULT_API_FORMAT);

  const create = useMutation({
    mutationFn: () =>
      providersApi.create({ name, baseUrl, apiFormat, apiKey, enabled: true }),
    onSuccess: async (p) => {
      toast.success(`Created ${p.name}`);
      // Pull /v1/models so chat dropdowns get the new provider's catalog.
      if (baseUrl.trim() && (apiKey.trim() || p.apiKeySet)) {
        try {
          await providersApi.refreshModels(p.id);
        } catch {
          /* discovery is best-effort; user can refresh from detail pane */
        }
      }
      onCreated(p);
    },
    onError: (e: unknown) => {
      toast.error(e instanceof Error ? e.message : 'Failed to create provider');
    },
  });

  const valid = name.trim() && baseUrl.trim();

  return (
    <div className="flex flex-col min-h-0 h-full max-h-full">
      <div className="px-5 pt-4 pb-3 border-b border-border/60 flex items-center justify-between gap-3 shrink-0">
        <div>
          {/* A bare label. The reference's section headers carry a count or
              nothing; this one carried a sentence under the title. */}
          <h3 className="text-base font-semibold">Add model provider</h3>
        </div>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-5 space-y-4">
        <WorkspaceField label="Name">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. DeepSeek"
            autoFocus
          />
        </WorkspaceField>

        <WorkspaceField
          label="Base URL"
          hint="Used exactly as pasted — only the API format leaf is appended."
        >
          <Input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://opencode.ai/zen/v1"
          />
        </WorkspaceField>

        <WorkspaceField label="API key">
          <div className="relative">
            <Input
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="Enter API key"
              autoComplete="new-password"
            />
            <button
              type="button"
              onClick={() => setShowKey((v) => !v)}
              aria-label={showKey ? 'Hide API key' : 'Show API key'}
              className="absolute right-2 top-1/2 -translate-y-1/2 grid size-7 place-items-center rounded text-muted-foreground hover:text-foreground transition"
            >
              {showKey ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
            </button>
          </div>
        </WorkspaceField>

        <WorkspaceField label="API format">
          {/* The app's own listbox, not a native <select>: a native one
              renders the OS popup, which is the loudest element on a page
              that is supposed to be four quiet rows -- the same reason
              every other select in Settings was moved in c365c586. */}
          <SettingsSelect
            value={apiFormat}
            onChange={(v) => setApiFormat(v as ApiFormat)}
            options={API_FORMATS.map((f) => ({ value: f.value, label: f.label }))}
            aria-label="API format"
          />
        </WorkspaceField>

        <div className="flex items-center justify-end gap-2 pt-4">
          <Button
            onClick={() => create.mutate()}
            disabled={!valid || create.isPending}
          >
            {create.isPending ? <Loader2 className="size-3 animate-spin" /> : <Plus className="size-3" />}
            Add provider
          </Button>
        </div>
      </div>
    </div>
  );
}
