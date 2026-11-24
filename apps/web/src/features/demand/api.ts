import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { openDocumentViewer } from '@/components/document-viewer';
import type {
  AdminEnquiryCreateInput,
  CommercialTerms,
  CompanyCreateInput,
  CompanyUpdateInput,
  CompanyUserInviteInput,
  CompanyUserView,
  CompanyView,
  ConvertLeadInput,
  EnquiryCreateInput,
  EnquiryView,
  JobCreateInput,
  JobUpdateInput,
  JobUpdateResult,
  JobView,
  PublicEnquiryInput,
  QuotationAcceptResult,
  QuotationInput,
  QuotationTaxContext,
  QuotationView,
  SiteInput,
  SiteUpdateInput,
  SiteView,
} from '@bijliwala/contracts';
import { api, ApiError } from '@/lib/api-client';
import { newIdempotencyKey } from '@/lib/utils';

/**
 * Data hooks for Phase 4 (companies, enquiries, quotations, jobs). Company-portal hooks use the
 * `/companies/me`, `/enquiries`, `/quotations` and `/jobs` routes; admin hooks the `/admin` ones.
 */

type ListParams = Record<string, string | number | undefined>;

function useInvalidate(...prefixes: string[]) {
  const qc = useQueryClient();
  return () => Promise.all(prefixes.map((p) => qc.invalidateQueries({ queryKey: [p] })));
}

/* ================================================================ company portal */

/** null when the user has not registered a company yet. */
export function useMyCompany() {
  return useQuery({
    queryKey: ['company', 'me'],
    queryFn: async () => {
      try {
        return await api.get<CompanyView>('/companies/me');
      } catch (e) {
        if (e instanceof ApiError && e.code === 'COMPANY_PROFILE_MISSING') return null;
        throw e;
      }
    },
  });
}

export function useCompanyMutations(onCreated?: () => Promise<void>) {
  const invalidate = useInvalidate('company');
  return {
    create: useMutation({
      mutationFn: (input: CompanyCreateInput) => api.post<CompanyView>('/companies', input),
      // Creating the company grants Company Admin: reload the session's permissions first.
      onSuccess: async () => {
        await onCreated?.();
        await invalidate();
      },
    }),
    update: useMutation({
      mutationFn: (input: CompanyUpdateInput) => api.patch<CompanyView>('/companies/me', input),
      onSuccess: invalidate,
    }),
  };
}

export function useMySites(enabled = true) {
  return useQuery({
    queryKey: ['company', 'sites'],
    queryFn: () => api.get<SiteView[]>('/companies/me/sites'),
    enabled,
  });
}

export function useSiteMutations() {
  const invalidate = useInvalidate('company');
  return {
    create: useMutation({
      mutationFn: (input: SiteInput) => api.post<SiteView>('/companies/me/sites', input),
      onSuccess: invalidate,
    }),
    update: useMutation({
      mutationFn: ({ id, input }: { id: string; input: SiteUpdateInput }) =>
        api.patch<SiteView>(`/companies/me/sites/${id}`, input),
      onSuccess: invalidate,
    }),
  };
}

export function useTeam(enabled = true) {
  return useQuery({
    queryKey: ['company', 'team'],
    queryFn: () => api.get<CompanyUserView[]>('/companies/me/users'),
    enabled,
  });
}

export function useTeamMutations() {
  const invalidate = useInvalidate('company');
  return {
    invite: useMutation({
      mutationFn: (input: CompanyUserInviteInput) =>
        api.post<CompanyUserView[]>('/companies/me/users', input),
      onSuccess: invalidate,
    }),
    remove: useMutation({
      mutationFn: (userId: string) => api.delete<CompanyUserView[]>(`/companies/me/users/${userId}`),
      onSuccess: invalidate,
    }),
  };
}

export function useCompanyEnquiries(params: ListParams) {
  return useQuery({
    queryKey: ['enquiries', 'mine', params],
    queryFn: () => api.page<EnquiryView>('/enquiries', params),
    placeholderData: keepPreviousData,
  });
}

export function useCompanyEnquiry(id: string) {
  return useQuery({
    queryKey: ['enquiries', 'mine', 'detail', id],
    queryFn: () => api.get<EnquiryView>(`/enquiries/${id}`),
  });
}

export function useEnquiryMutations() {
  const invalidate = useInvalidate('enquiries');
  return {
    create: useMutation({
      mutationFn: (input: EnquiryCreateInput) => api.post<EnquiryView>('/enquiries', input),
      onSuccess: invalidate,
    }),
    cancel: useMutation({
      mutationFn: ({ id, reason }: { id: string; reason: string }) =>
        api.post<EnquiryView>(`/enquiries/${id}/cancel`, { reason }),
      onSuccess: invalidate,
    }),
  };
}

export function useCompanyQuotations(params: ListParams, enabled = true) {
  return useQuery({
    queryKey: ['quotations', 'mine', params],
    queryFn: () => api.page<QuotationView>('/quotations', params),
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useCompanyQuotation(id: string) {
  return useQuery({
    queryKey: ['quotations', 'mine', 'detail', id],
    queryFn: () => api.get<QuotationView>(`/quotations/${id}`),
  });
}

export function useQuotationDecision(id: string) {
  const invalidate = useInvalidate('quotations', 'enquiries', 'jobs');
  return {
    // One key per decision attempt: a retried click replays instead of accepting twice.
    accept: useMutation({
      mutationFn: (idempotencyKey: string) =>
        api.post<QuotationAcceptResult>(`/quotations/${id}/accept`, undefined, { idempotencyKey }),
      onSuccess: invalidate,
    }),
    reject: useMutation({
      mutationFn: (reason: string) => api.post<QuotationView>(`/quotations/${id}/reject`, { reason }),
      onSuccess: invalidate,
    }),
  };
}

/** Shows a quotation PDF in the in-app viewer (no new tab, no file saved). */
export function openPdf(path: string, title = 'Quotation'): void {
  openDocumentViewer({ urlPath: path, title, mime: 'application/pdf' });
}

export function useCompanyJobs(params: ListParams) {
  return useQuery({
    queryKey: ['jobs', 'mine', params],
    queryFn: () => api.page<JobView>('/jobs', params),
    placeholderData: keepPreviousData,
  });
}

export function useCompanyJob(id: string) {
  return useQuery({
    queryKey: ['jobs', 'mine', 'detail', id],
    queryFn: () => api.get<JobView>(`/jobs/${id}`),
  });
}

export function usePublicEnquiry() {
  return useMutation({
    mutationFn: (input: PublicEnquiryInput) => api.post<{ enquiryNo: string }>('/public/enquiries', input),
  });
}

/* ================================================================ admin */

export function useAdminCompanies(params: ListParams) {
  return useQuery({
    queryKey: ['admin-companies', params],
    queryFn: () => api.page<CompanyView>('/admin/companies', params),
    placeholderData: keepPreviousData,
  });
}

export function useAdminCompany(id: string | undefined) {
  return useQuery({
    queryKey: ['admin-companies', 'detail', id],
    queryFn: () => api.get<CompanyView>(`/admin/companies/${id}`),
    enabled: !!id,
  });
}

export function useAdminCompanySites(id: string | undefined) {
  return useQuery({
    queryKey: ['admin-companies', 'sites', id],
    queryFn: () => api.get<SiteView[]>(`/admin/companies/${id}/sites`),
    enabled: !!id,
  });
}

export function useAdminCompanyUsers(id: string) {
  return useQuery({
    queryKey: ['admin-companies', 'users', id],
    queryFn: () => api.get<CompanyUserView[]>(`/admin/companies/${id}/users`),
  });
}

export function useAdminCompanyActions(id: string) {
  const invalidate = useInvalidate('admin-companies');
  return {
    activate: useMutation({
      mutationFn: () => api.post<CompanyView>(`/admin/companies/${id}/activate`, {}),
      onSuccess: invalidate,
    }),
    suspend: useMutation({
      mutationFn: (reason: string) => api.post<CompanyView>(`/admin/companies/${id}/suspend`, { reason }),
      onSuccess: invalidate,
    }),
    terms: useMutation({
      mutationFn: (terms: CommercialTerms) =>
        api.put<CompanyView>(`/admin/companies/${id}/commercial-terms`, terms),
      onSuccess: invalidate,
    }),
    addSite: useMutation({
      mutationFn: (input: SiteInput) => api.post<SiteView>(`/admin/companies/${id}/sites`, input),
      onSuccess: invalidate,
    }),
  };
}

export function useAdminEnquiries(params: ListParams) {
  return useQuery({
    queryKey: ['admin-enquiries', params],
    queryFn: () => api.page<EnquiryView>('/admin/enquiries', params),
    placeholderData: keepPreviousData,
  });
}

export function useAdminEnquiry(id: string) {
  return useQuery({
    queryKey: ['admin-enquiries', 'detail', id],
    queryFn: () => api.get<EnquiryView>(`/admin/enquiries/${id}`),
  });
}

export function useAdminEnquiryActions(id: string) {
  const invalidate = useInvalidate('admin-enquiries', 'admin-quotations');
  return {
    assign: useMutation({
      mutationFn: (userId: string | null) =>
        api.post<EnquiryView>(`/admin/enquiries/${id}/assign`, { userId }),
      onSuccess: invalidate,
    }),
    note: useMutation({
      mutationFn: (text: string) => api.post<EnquiryView>(`/admin/enquiries/${id}/notes`, { text }),
      onSuccess: invalidate,
    }),
    status: useMutation({
      mutationFn: (input: { status: 'IN_REVIEW' | 'REJECTED' | 'CANCELLED'; reason?: string }) =>
        api.post<EnquiryView>(`/admin/enquiries/${id}/status`, input),
      onSuccess: invalidate,
    }),
    convert: useMutation({
      mutationFn: (input: ConvertLeadInput) =>
        api.post<EnquiryView>(`/admin/enquiries/${id}/convert-lead`, input),
      onSuccess: invalidate,
    }),
    createQuotation: useMutation({
      mutationFn: (input: QuotationInput) =>
        api.post<QuotationView>(`/admin/enquiries/${id}/quotations`, input),
      onSuccess: invalidate,
    }),
  };
}

export function useAdminCreateEnquiry() {
  const invalidate = useInvalidate('admin-enquiries');
  return useMutation({
    mutationFn: (input: AdminEnquiryCreateInput) => api.post<EnquiryView>('/admin/enquiries', input),
    onSuccess: invalidate,
  });
}

export function useAdminQuotations(params: ListParams, enabled = true) {
  return useQuery({
    queryKey: ['admin-quotations', params],
    queryFn: () => api.page<QuotationView>('/admin/quotations', params),
    enabled,
  });
}

export function useAdminQuotation(id: string) {
  return useQuery({
    queryKey: ['admin-quotations', 'detail', id],
    queryFn: () => api.get<QuotationView>(`/admin/quotations/${id}`),
  });
}

export function useQuotationTaxContext(companyId: string | undefined) {
  return useQuery({
    queryKey: ['admin-quotations', 'tax-context', companyId],
    queryFn: () => api.get<QuotationTaxContext>('/admin/quotations/tax-context', { companyId }),
    enabled: !!companyId,
    staleTime: 60_000,
  });
}

export function useAdminQuotationActions(id: string) {
  const invalidate = useInvalidate('admin-quotations', 'admin-enquiries');
  return {
    update: useMutation({
      mutationFn: ({ input, rev }: { input: QuotationInput; rev: number }) =>
        api.patch<QuotationView>(`/admin/quotations/${id}`, input, { ifMatch: rev }),
      onSuccess: invalidate,
    }),
    send: useMutation({
      mutationFn: () => api.post<QuotationView>(`/admin/quotations/${id}/send`),
      onSuccess: invalidate,
    }),
    revise: useMutation({
      mutationFn: () => api.post<QuotationView>(`/admin/quotations/${id}/revise`),
      onSuccess: invalidate,
    }),
  };
}

export function useAdminJobs(params: ListParams) {
  return useQuery({
    queryKey: ['admin-jobs', params],
    queryFn: () => api.page<JobView>('/admin/jobs', params),
    placeholderData: keepPreviousData,
  });
}

export function useAdminJob(id: string) {
  return useQuery({
    queryKey: ['admin-jobs', 'detail', id],
    queryFn: () => api.get<JobView>(`/admin/jobs/${id}`),
  });
}

export function useAdminJobActions(id: string) {
  const invalidate = useInvalidate('admin-jobs');
  const post = (action: string) => (body?: { reason: string }) =>
    api.post<JobView>(`/admin/jobs/${id}/${action}`, body);
  return {
    open: useMutation({ mutationFn: () => post('open')(), onSuccess: invalidate }),
    hold: useMutation({ mutationFn: (reason: string) => post('hold')({ reason }), onSuccess: invalidate }),
    resume: useMutation({ mutationFn: () => post('resume')(), onSuccess: invalidate }),
    cancel: useMutation({
      mutationFn: (reason: string) => post('cancel')({ reason }),
      onSuccess: invalidate,
    }),
    complete: useMutation({ mutationFn: () => post('complete')(), onSuccess: invalidate }),
    update: useMutation({
      mutationFn: ({ input, version }: { input: JobUpdateInput; version: number }) =>
        api.patch<JobUpdateResult>(`/admin/jobs/${id}`, input, { ifMatch: version }),
      onSuccess: invalidate,
    }),
  };
}

export function useAdminCreateJob() {
  const invalidate = useInvalidate('admin-jobs');
  return useMutation({
    mutationFn: (input: JobCreateInput) => api.post<JobView>('/admin/jobs', input),
    onSuccess: invalidate,
  });
}

export { newIdempotencyKey };
