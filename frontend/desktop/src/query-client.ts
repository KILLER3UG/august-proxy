import { QueryClient } from '@tanstack/react-query';

/** Shared React Query client — realtime bridge invalidates via this instance. */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 5_000, refetchOnWindowFocus: false, retry: 1 },
  },
});
