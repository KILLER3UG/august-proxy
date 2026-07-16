/* Provider templates were removed — users configure providers fully themselves.
   This hook remains as a no-op so any residual imports do not break. */

export function useProviderTemplates() {
  return {
    templates: [] as never[],
    isLoading: false,
    error: null as Error | null,
  };
}
