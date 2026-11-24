import { useQuery } from '@tanstack/react-query';
import type { WorkQueueView } from '@bijliwala/contracts';
import { api } from '@/lib/api-client';

export const dashboardKeys = {
  workQueue: ['admin', 'dashboard', 'work-queue'] as const,
};

/** Counts of items waiting for the signed-in admin (only queues their role can act on). */
export function useWorkQueue() {
  return useQuery({
    queryKey: dashboardKeys.workQueue,
    queryFn: () => api.get<WorkQueueView>('/admin/dashboard/work-queue'),
    refetchInterval: 60_000,
  });
}
