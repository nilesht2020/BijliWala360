import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CategoryCreateInput,
  CategoryUpdateInput,
  CategoryView,
  IdentityConflictView,
  RegistrationDetailView,
  RegistrationPaymentView,
  RegistrationPlanInput,
  RegistrationPlanView,
  RegistrationRefundView,
  RegistrationView,
  SkillCreateInput,
  SkillView,
  WorkerView,
} from '@skillconnect/contracts';
import { api } from '@/lib/api-client';
import { newIdempotencyKey } from '@/lib/utils';

const k = {
  regs: (p: object) => ['admin', 'registrations', p] as const,
  reg: (id: string) => ['admin', 'registrations', 'detail', id] as const,
  workers: ['admin', 'workers-pending'] as const,
  conflicts: ['admin', 'identity-conflicts'] as const,
  categories: ['admin', 'categories'] as const,
  skills: ['admin', 'skills'] as const,
  plans: ['admin', 'plans'] as const,
  payments: (p: object) => ['admin', 'reg-payments', p] as const,
  refunds: (p: object) => ['admin', 'reg-refunds', p] as const,
};

function useInvalidate(prefix: string) {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['admin', prefix] });
}

/* ------------------------------------------------------------------ verification */

export function useRegistrationsQueue(params: {
  page: number;
  pageSize: number;
  verificationStatus?: string;
  providerType?: string;
}) {
  return useQuery({
    queryKey: k.regs(params),
    queryFn: () => api.page<RegistrationView>('/admin/registrations', params),
    placeholderData: keepPreviousData,
  });
}

export function useRegistrationDetail(id: string) {
  return useQuery({
    queryKey: k.reg(id),
    queryFn: () => api.get<RegistrationDetailView>(`/admin/registrations/${id}`),
  });
}

export function useVerificationActions(id: string) {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ['admin'] });
  return {
    reviewDocument: useMutation({
      mutationFn: (v: { docId: string; decision: 'VERIFIED' | 'REJECTED'; comment?: string }) =>
        api.post(`/admin/documents/${v.docId}/review`, {
          decision: v.decision,
          ...(v.comment ? { comment: v.comment } : {}),
        }),
      onSuccess: invalidate,
    }),
    approve: useMutation({
      mutationFn: () => api.post(`/admin/registrations/${id}/approve`),
      onSuccess: invalidate,
    }),
    reject: useMutation({
      mutationFn: (reason: string) => api.post(`/admin/registrations/${id}/reject`, { reason }),
      onSuccess: invalidate,
    }),
    requestChanges: useMutation({
      mutationFn: (comment: string) =>
        api.post(`/admin/registrations/${id}/request-changes`, { comment, items: [] }),
      onSuccess: invalidate,
    }),
    waive: useMutation({
      mutationFn: (reason: string) =>
        api.post(`/admin/registrations/${id}/waive`, { reason }, { idempotencyKey: newIdempotencyKey() }),
      onSuccess: invalidate,
    }),
  };
}

export function usePendingWorkers() {
  return useQuery({
    queryKey: k.workers,
    queryFn: () => api.page<WorkerView>('/admin/vendor-workers/pending', { page: 1, pageSize: 50 }),
  });
}

export function useVerifyWorker() {
  const invalidate = useInvalidate('workers-pending');
  return useMutation({
    mutationFn: (v: { id: string; decision: 'APPROVED' | 'REJECTED'; comment?: string }) =>
      api.post(`/admin/vendor-workers/${v.id}/verify`, {
        decision: v.decision,
        ...(v.comment ? { comment: v.comment } : {}),
      }),
    onSuccess: invalidate,
  });
}

export function useIdentityConflicts() {
  return useQuery({
    queryKey: k.conflicts,
    queryFn: () => api.get<IdentityConflictView[]>('/admin/identity-conflicts'),
  });
}

export function useResolveConflict() {
  const invalidate = useInvalidate('identity-conflicts');
  return useMutation({
    mutationFn: (v: { id: string; note: string }) =>
      api.post(`/admin/identity-conflicts/${v.id}/resolve`, { note: v.note }),
    onSuccess: invalidate,
  });
}

/* ------------------------------------------------------------------ catalogue & plans */

export function useAdminCategories() {
  return useQuery({ queryKey: k.categories, queryFn: () => api.get<CategoryView[]>('/admin/categories') });
}

export function useAdminSkills() {
  return useQuery({ queryKey: k.skills, queryFn: () => api.get<SkillView[]>('/admin/skills') });
}

export function useCatalogMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ['admin'] });
  return {
    createCategory: useMutation({
      mutationFn: (v: CategoryCreateInput) => api.post<CategoryView>('/admin/categories', v),
      onSuccess: invalidate,
    }),
    updateCategory: useMutation({
      mutationFn: (v: { id: string; input: CategoryUpdateInput }) =>
        api.patch<CategoryView>(`/admin/categories/${v.id}`, v.input),
      onSuccess: invalidate,
    }),
    createSkill: useMutation({
      mutationFn: (v: SkillCreateInput) => api.post<SkillView>('/admin/skills', v),
      onSuccess: invalidate,
    }),
  };
}

export function useAdminPlans() {
  return useQuery({
    queryKey: k.plans,
    queryFn: () => api.get<RegistrationPlanView[]>('/admin/registration-plans'),
  });
}

export function useSavePlan() {
  const invalidate = useInvalidate('plans');
  return useMutation({
    mutationFn: (v: { id?: string; version?: number; input: RegistrationPlanInput }) =>
      v.id
        ? api.patch<RegistrationPlanView>(`/admin/registration-plans/${v.id}`, v.input, {
            ifMatch: v.version,
          })
        : api.post<RegistrationPlanView>('/admin/registration-plans', v.input),
    onSuccess: invalidate,
  });
}

/* ------------------------------------------------------------------ finance */

export function useRegistrationPayments(params: {
  page: number;
  pageSize: number;
  status?: string;
  mode?: string;
}) {
  return useQuery({
    queryKey: k.payments(params),
    queryFn: () => api.page<RegistrationPaymentView>('/admin/registration-payments', params),
    placeholderData: keepPreviousData,
  });
}

export function useRegistrationRefunds(params: { page: number; pageSize: number; status?: string }) {
  return useQuery({
    queryKey: k.refunds(params),
    queryFn: () => api.page<RegistrationRefundView>('/admin/registration-refunds', params),
    placeholderData: keepPreviousData,
  });
}

export function useFinanceActions() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ['admin'] });
  return {
    verifyPayment: useMutation({
      mutationFn: (id: string) =>
        api.post(`/admin/registration-payments/${id}/verify`, undefined, {
          idempotencyKey: newIdempotencyKey(),
        }),
      onSuccess: invalidate,
    }),
    rejectPayment: useMutation({
      mutationFn: (v: { id: string; reason: string }) =>
        api.post(`/admin/registration-payments/${v.id}/reject`, { reason: v.reason }),
      onSuccess: invalidate,
    }),
    approveRefund: useMutation({
      mutationFn: (id: string) =>
        api.post(`/admin/registration-refunds/${id}/approve`, undefined, {
          idempotencyKey: newIdempotencyKey(),
        }),
      onSuccess: invalidate,
    }),
    rejectRefund: useMutation({
      mutationFn: (v: { id: string; reason: string }) =>
        api.post(`/admin/registration-refunds/${v.id}/reject`, { reason: v.reason }),
      onSuccess: invalidate,
    }),
    completeRefund: useMutation({
      mutationFn: (v: { id: string; reference: string }) =>
        api.post(`/admin/registration-refunds/${v.id}/offline-complete`, { reference: v.reference }),
      onSuccess: invalidate,
    }),
  };
}
