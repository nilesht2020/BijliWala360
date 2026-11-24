import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { openDocumentViewer } from '@/components/document-viewer';
import type {
  CategoryView,
  DocumentTypeView,
  DocumentView,
  OfflinePaymentInput,
  OnlineOrderResponse,
  ProfessionalUpdateInput,
  ProfessionalView,
  PublicCategoryDetail,
  ReadinessView,
  RegistrationPaymentView,
  RegistrationPlanView,
  RegistrationView,
  SkillView,
  UploadIntentResponse,
  VendorCreateInput,
  VendorUpdateInput,
  VendorView,
  WorkerCreateInput,
  WorkerView,
} from '@bijliwala/contracts';
import type { FileUploadApi } from '@/components/forms/file-upload';
import { api, ApiError } from '@/lib/api-client';
import { newIdempotencyKey } from '@/lib/utils';

export const providerKeys = {
  professional: ['provider', 'professional'] as const,
  vendor: ['provider', 'vendor'] as const,
  registration: ['provider', 'registration'] as const,
  readiness: ['provider', 'readiness'] as const,
  payments: ['provider', 'payments'] as const,
  workers: (page: number) => ['provider', 'workers', page] as const,
  documents: (ownerType: string, ownerId: string) => ['documents', ownerType, ownerId] as const,
  docTypes: ['documents', 'types'] as const,
  plans: (type: string) => ['plans', type] as const,
  skills: ['catalog', 'skills'] as const,
  categories: ['catalog', 'categories'] as const,
};

/** Refetches everything that depends on the provider's registration state. */
export function useInvalidateProvider() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['provider'] });
}

/* ------------------------------------------------------------------ catalogue */

export function useCategories() {
  return useQuery({
    queryKey: providerKeys.categories,
    queryFn: () => api.get<CategoryView[]>('/public/categories'),
    staleTime: 300_000,
  });
}

export function useCategoryDetail(slug: string) {
  return useQuery({
    queryKey: ['catalog', 'category', slug],
    queryFn: () => api.get<PublicCategoryDetail>(`/public/categories/${slug}`),
  });
}

export function useSkills() {
  return useQuery({
    queryKey: providerKeys.skills,
    queryFn: () => api.get<SkillView[]>('/public/skills'),
    staleTime: 300_000,
  });
}

export function usePlans(providerType: 'PROFESSIONAL' | 'VENDOR') {
  return useQuery({
    queryKey: providerKeys.plans(providerType),
    queryFn: () => api.get<RegistrationPlanView[]>('/public/registration-plans', { providerType }),
  });
}

/* ------------------------------------------------------------------ profiles */

/** null when the profile does not exist yet (the API answers PROVIDER_PROFILE_MISSING). */
async function orNull<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof ApiError && (e.code === 'PROVIDER_PROFILE_MISSING' || e.status === 403)) return null;
    throw e;
  }
}

export function useMyProfessional(enabled = true) {
  return useQuery({
    queryKey: providerKeys.professional,
    queryFn: () => orNull(api.get<ProfessionalView>('/professionals/me')),
    enabled,
  });
}

export function useMyVendor(enabled = true) {
  return useQuery({
    queryKey: providerKeys.vendor,
    queryFn: () => orNull(api.get<VendorView>('/vendors/me')),
    enabled,
  });
}

export function useProfessionalMutations() {
  const invalidate = useInvalidateProvider();
  const opts = { onSuccess: invalidate };
  return {
    create: useMutation({ mutationFn: () => api.post<ProfessionalView>('/professionals/me'), ...opts }),
    update: useMutation({
      mutationFn: (input: ProfessionalUpdateInput) => api.patch<ProfessionalView>('/professionals/me', input),
      ...opts,
    }),
    skills: useMutation({
      mutationFn: (skills: Array<{ skillId: string; proficiency: string; years: number }>) =>
        api.put<ProfessionalView>('/professionals/me/skills', { skills }),
      ...opts,
    }),
  };
}

export function useVendorMutations(onCreated?: () => Promise<void>) {
  const invalidate = useInvalidateProvider();
  return {
    create: useMutation({
      mutationFn: (input: VendorCreateInput) => api.post<VendorView>('/vendors', input),
      // Creating the vendor grants the Vendor Admin role: reload the session's permissions.
      onSuccess: async () => {
        await onCreated?.();
        await invalidate();
      },
    }),
    update: useMutation({
      mutationFn: (input: VendorUpdateInput) => api.patch<VendorView>('/vendors/me', input),
      onSuccess: invalidate,
    }),
  };
}

export function useWorkers(page: number, enabled = true) {
  return useQuery({
    queryKey: providerKeys.workers(page),
    queryFn: () => api.page<WorkerView>('/vendors/me/workers', { page, pageSize: 20 }),
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useWorkerMutations() {
  const invalidate = useInvalidateProvider();
  return {
    create: useMutation({
      mutationFn: (input: WorkerCreateInput) => api.post<WorkerView>('/vendors/me/workers', input),
      onSuccess: invalidate,
    }),
    deactivate: useMutation({
      mutationFn: (id: string) => api.delete<WorkerView>(`/vendors/me/workers/${id}`),
      onSuccess: invalidate,
    }),
  };
}

/* ------------------------------------------------------------------ registration & payments */

export function useRegistration(enabled = true) {
  return useQuery({
    queryKey: providerKeys.registration,
    queryFn: () => orNull(api.get<RegistrationView>('/registrations/me')),
    enabled,
  });
}

export function useReadiness(enabled = true) {
  return useQuery({
    queryKey: providerKeys.readiness,
    queryFn: () => orNull(api.get<ReadinessView>('/registrations/me/readiness')),
    enabled,
  });
}

export function useMyPayments(enabled = true) {
  return useQuery({
    queryKey: providerKeys.payments,
    queryFn: () => orNull(api.get<RegistrationPaymentView[]>('/registrations/me/payments')),
    enabled,
  });
}

export function useRegistrationMutations() {
  const invalidate = useInvalidateProvider();
  return {
    selectPlan: useMutation({
      mutationFn: (planCode: string) => api.put<RegistrationView>('/registrations/me/plan', { planCode }),
      onSuccess: invalidate,
    }),
    submit: useMutation({
      mutationFn: () => api.post<RegistrationView>('/registrations/me/submit'),
      onSuccess: invalidate,
    }),
    offline: useMutation({
      mutationFn: (input: OfflinePaymentInput) =>
        api.post<RegistrationPaymentView>('/registrations/me/payments/offline', input, {
          idempotencyKey: newIdempotencyKey(),
        }),
      onSuccess: invalidate,
    }),
    payOnline: useMutation({ mutationFn: payOnline, onSuccess: invalidate }),
  };
}

interface CheckoutResult {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void };
  }
}

function loadCheckoutScript(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Could not load the payment window. Check your connection.'));
    document.body.appendChild(s);
  });
}

/**
 * Online payment: create the order, open Razorpay Checkout (or the development simulator when the
 * API runs with the fake gateway), then confirm the signed result. The webhook settles the payment.
 */
async function payOnline(): Promise<'paid' | 'cancelled'> {
  const order = await api.post<OnlineOrderResponse>('/registrations/me/payments/online', undefined, {
    idempotencyKey: newIdempotencyKey(),
  });
  let result: CheckoutResult | null;
  if (order.mode === 'fake') {
    result = await api.post<CheckoutResult>('/dev/payments/simulate', {
      orderId: order.razorpay.orderId,
      outcome: 'success',
    });
  } else {
    await loadCheckoutScript();
    result = await new Promise<CheckoutResult | null>((resolve) => {
      const Razorpay = window.Razorpay;
      if (!Razorpay) return resolve(null);
      new Razorpay({
        key: order.razorpay.keyId,
        order_id: order.razorpay.orderId,
        amount: order.razorpay.amount,
        currency: order.razorpay.currency,
        name: order.razorpay.name,
        description: order.razorpay.description,
        handler: (r: CheckoutResult) => resolve(r),
        modal: { ondismiss: () => resolve(null) },
      }).open();
    });
  }
  if (!result) return 'cancelled';
  await api.post(`/registrations/me/payments/${order.paymentId}/verify`, result);
  return 'paid';
}

/* ------------------------------------------------------------------ documents */

export function useDocumentTypes() {
  return useQuery({
    queryKey: providerKeys.docTypes,
    queryFn: () => api.get<DocumentTypeView[]>('/documents/types'),
    staleTime: 300_000,
  });
}

export function useDocuments(ownerType: string, ownerId: string | undefined) {
  return useQuery({
    queryKey: providerKeys.documents(ownerType, ownerId ?? ''),
    queryFn: () => api.get<DocumentView[]>('/documents', { ownerType, ownerId }),
    enabled: !!ownerId,
  });
}

/** Short-lived signed URL for showing a stored image (e.g. the profile photo) in an <img>. */
export function useDocumentImageUrl(documentId: string | undefined) {
  return useQuery({
    queryKey: ['documents', 'image-url', documentId ?? ''],
    queryFn: () => api.get<{ url: string }>(`/documents/${documentId}/download-url`),
    enabled: !!documentId,
    // Signed URLs live ~60 s; an <img> that has loaded keeps its pixels, so only refresh when stale.
    staleTime: 45_000,
    refetchOnWindowFocus: false,
    select: (r) => r.url,
  });
}

/** Adapter for <FileUpload>: rejected files surface as an error message. */
export function documentUploadApi(params: {
  typeCode: string;
  owner: { type: string; id: string };
  number?: string;
  expiresOn?: string;
}): FileUploadApi {
  return {
    requestIntent: async (file) => {
      const intent = await api.post<UploadIntentResponse>('/documents/upload-intent', {
        typeCode: params.typeCode,
        owner: params.owner,
        fileName: file.name,
        mime: file.type,
        sizeBytes: file.size,
        ...(params.number ? { number: params.number } : {}),
        ...(params.expiresOn ? { expiresOn: params.expiresOn } : {}),
      });
      return { documentId: intent.documentId, uploadUrl: intent.uploadUrl, headers: intent.headers };
    },
    complete: async (documentId) => {
      const doc = await api.post<DocumentView>(`/documents/${documentId}/complete`);
      if (doc.status.startsWith('REJECTED'))
        throw new Error(doc.rejectionReason ?? 'The file was not accepted.');
    },
  };
}

/** Shows a stored document in the in-app viewer (no new tab, no file saved). */
export function openDocument(id: string, title = 'Document'): void {
  openDocumentViewer({ urlPath: `/documents/${id}/download-url`, title });
}
