import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './api-client';

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        // Never retry client errors (4xx); retry transient failures twice.
        retry: (failureCount, error) => {
          if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
          return failureCount < 2;
        },
      },
      mutations: { retry: false },
    },
  });
}

/**
 * Query-key factory root. Each feature extends it (e.g. `queryKeys.jobs.detail(id)`) so that
 * invalidation stays consistent (ARCHITECTURE §8.2).
 */
export const queryKeys = {
  auth: { me: ['auth', 'me'] as const },
  categories: { all: ['categories'] as const, tree: () => ['categories', 'tree'] as const },
  config: { all: ['config'] as const },
} as const;
