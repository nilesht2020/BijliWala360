import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AuditLogView,
  ConfigEntryView,
  CreateAdminUserInput,
  CreateRoleInput,
  GrantRoleInput,
  NotificationTemplateInput,
  NotificationTemplateView,
  RoleAssignmentView,
  RoleView,
  UpdateRoleInput,
  UserDetailView,
  UserView,
} from '@skillconnect/contracts';
import { api, http, type CursorPage, type Page } from '@/lib/api-client';

/** Query keys for administration features (ARCHITECTURE §8.2). */
export const adminKeys = {
  users: (params: object) => ['admin', 'users', params] as const,
  user: (id: string) => ['admin', 'users', 'detail', id] as const,
  roles: ['admin', 'roles'] as const,
  audit: (params: object) => ['admin', 'audit', params] as const,
  config: ['admin', 'config'] as const,
  templates: ['admin', 'templates'] as const,
};

/* ------------------------------------------------------------------ users */

export interface UserListParams {
  page: number;
  pageSize: number;
  q?: string;
  userType?: string;
  status?: string;
  roleCode?: string;
}

export function useUsers(params: UserListParams) {
  return useQuery({
    queryKey: adminKeys.users(params),
    queryFn: () => api.page<UserView>('/admin/users', params) as Promise<Page<UserView>>,
    placeholderData: keepPreviousData,
  });
}

export function useUser(id: string) {
  return useQuery({
    queryKey: adminKeys.user(id),
    queryFn: () => api.get<UserDetailView>(`/admin/users/${id}`),
  });
}

function useInvalidateUsers() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['admin', 'users'] });
}

export function useCreateAdmin() {
  const invalidate = useInvalidateUsers();
  return useMutation({
    mutationFn: (input: CreateAdminUserInput) => api.post<UserDetailView>('/admin/users', input),
    onSuccess: invalidate,
  });
}

export function useUserAction(id: string) {
  const invalidate = useInvalidateUsers();
  return useMutation({
    mutationFn: (
      action:
        | { kind: 'suspend' | 'reactivate' | 'deactivate'; reason: string }
        | { kind: 'mfa-reset' | 'revoke-sessions' },
    ) => {
      switch (action.kind) {
        case 'mfa-reset':
          return api.post(`/admin/users/${id}/mfa/reset`);
        case 'revoke-sessions':
          return api.post(`/admin/users/${id}/sessions/revoke`);
        default:
          return api.post(`/admin/users/${id}/${action.kind}`, { reason: action.reason });
      }
    },
    onSuccess: invalidate,
  });
}

export function useGrantRole(userId: string) {
  const invalidate = useInvalidateUsers();
  return useMutation({
    mutationFn: (input: GrantRoleInput) =>
      api.post<RoleAssignmentView>(`/admin/users/${userId}/role-assignments`, input),
    onSuccess: invalidate,
  });
}

export function useRevokeRole(userId: string) {
  const invalidate = useInvalidateUsers();
  return useMutation({
    mutationFn: (assignmentId: string) =>
      api.delete(`/admin/users/${userId}/role-assignments/${assignmentId}`),
    onSuccess: invalidate,
  });
}

/* ------------------------------------------------------------------ roles */

export function useRoles() {
  return useQuery({ queryKey: adminKeys.roles, queryFn: () => api.get<RoleView[]>('/admin/roles') });
}

export function useSaveRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      id?: string;
      version?: number;
      create?: CreateRoleInput;
      update?: UpdateRoleInput;
    }) =>
      input.id
        ? api.patch<RoleView>(`/admin/roles/${input.id}`, input.update, { ifMatch: input.version })
        : api.post<RoleView>('/admin/roles', input.create),
    onSuccess: () => qc.invalidateQueries({ queryKey: adminKeys.roles }),
  });
}

export function useDeleteRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/admin/roles/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: adminKeys.roles }),
  });
}

/* ------------------------------------------------------------------ audit */

export interface AuditParams {
  entityType?: string;
  entityId?: string;
  actorId?: string;
  action?: string;
}

export async function fetchAuditPage(
  params: AuditParams & { cursor?: string; limit?: number },
): Promise<CursorPage<AuditLogView>> {
  const res = await http.get<{ data: AuditLogView[]; meta: { nextCursor: string | null } }>(
    '/admin/audit-logs',
    { params },
  );
  return { items: res.data.data, meta: res.data.meta };
}

/* ------------------------------------------------------------------ settings */

export function useConfig() {
  return useQuery({ queryKey: adminKeys.config, queryFn: () => api.get<ConfigEntryView[]>('/admin/config') });
}

export function useSaveConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, value, version }: { key: string; value: unknown; version: number }) =>
      api.put<ConfigEntryView>(`/admin/config/${key}`, { value }, { ifMatch: version }),
    onSuccess: () => qc.invalidateQueries({ queryKey: adminKeys.config }),
  });
}

/* ------------------------------------------------------------------ notification templates */

export function useTemplates() {
  return useQuery({
    queryKey: adminKeys.templates,
    queryFn: () => api.get<NotificationTemplateView[]>('/admin/notification-templates'),
  });
}

export function useSaveTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      version,
      input,
    }: {
      id?: string;
      version?: number;
      input: NotificationTemplateInput;
    }) =>
      id
        ? api.patch<NotificationTemplateView>(`/admin/notification-templates/${id}`, input, {
            ifMatch: version,
          })
        : api.post<NotificationTemplateView>('/admin/notification-templates', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: adminKeys.templates }),
  });
}

export function previewTemplate(id: string, data: Record<string, unknown>) {
  return api.post<{
    title?: string;
    body?: string;
    subject?: string;
    html?: string;
    link?: string;
    whatsapp?: { params: string[] };
  }>(`/admin/notification-templates/${id}/preview`, { data });
}
