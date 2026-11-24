import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { InboxItem, NotificationPreferences } from '@bijliwala/contracts';
import { useAuth } from '@/app/auth';
import { api, http } from '@/lib/api-client';

export const notificationKeys = {
  all: ['notifications'] as const,
  unread: ['notifications', 'unread'] as const,
  inbox: ['notifications', 'inbox'] as const,
  prefs: ['notifications', 'prefs'] as const,
};

/** Unread badge count; polled every minute while signed in. */
export function useUnreadCount() {
  const { status } = useAuth();
  return useQuery({
    queryKey: notificationKeys.unread,
    queryFn: () => api.get<{ count: number }>('/notifications/unread-count'),
    enabled: status === 'authenticated',
    refetchInterval: 60_000,
    select: (d) => d.count,
  });
}

export function useInbox() {
  return useInfiniteQuery({
    queryKey: notificationKeys.inbox,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const res = await http.get<{ data: InboxItem[]; meta: { nextCursor: string | null } }>(
        '/notifications',
        {
          params: { limit: 20, ...(pageParam ? { cursor: pageParam } : {}) },
        },
      );
      return res.data;
    },
    getNextPageParam: (last) => last.meta.nextCursor ?? undefined,
  });
}

export function useMarkRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string | 'all') =>
      id === 'all' ? api.post('/notifications/read-all') : api.post(`/notifications/${id}/read`),
    onSuccess: () => qc.invalidateQueries({ queryKey: notificationKeys.all }),
  });
}

export function usePreferences() {
  return useQuery({
    queryKey: notificationKeys.prefs,
    queryFn: () => api.get<NotificationPreferences>('/notifications/preferences'),
  });
}

export function useSavePreferences() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (prefs: NotificationPreferences) =>
      api.put<NotificationPreferences>('/notifications/preferences', prefs),
    onSuccess: (data) => qc.setQueryData(notificationKeys.prefs, data),
  });
}
