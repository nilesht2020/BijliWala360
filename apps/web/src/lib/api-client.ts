import axios, {
  AxiosError,
  type AxiosInstance,
  type AxiosRequestConfig,
  type InternalAxiosRequestConfig,
} from 'axios';
import {
  IDEMPOTENCY_HEADER,
  type ApiErrorDetail,
  type ApiFailure,
  type ApiSuccess,
  type CursorMeta,
  type PageMeta,
} from '@skillconnect/contracts';

/** Normalised error thrown by every API call (mirrors the server error envelope). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: ApiErrorDetail[] = [],
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get isConflict(): boolean {
    return this.status === 409;
  }

  get isValidation(): boolean {
    return this.status === 400 || this.status === 422;
  }
}

export interface Page<T> {
  items: T[];
  meta: PageMeta;
}

export interface CursorPage<T> {
  items: T[];
  meta: CursorMeta;
}

/**
 * Access token lives in memory only (ARCHITECTURE §8.2). The refresh token is an HttpOnly cookie,
 * so a page reload calls /auth/refresh during bootstrap.
 */
export const tokenStore = (() => {
  let accessToken: string | null = null;
  const listeners = new Set<(token: string | null) => void>();
  return {
    get: () => accessToken,
    set: (token: string | null) => {
      accessToken = token;
      listeners.forEach((l) => l(token));
    },
    subscribe: (listener: (token: string | null) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
})();

export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof AxiosError) {
    const body = error.response?.data as Partial<ApiFailure> | undefined;
    if (body && body.success === false && body.error) {
      return new ApiError(
        error.response?.status ?? 0,
        body.error.code,
        body.error.message,
        body.error.details ?? [],
        body.requestId,
      );
    }
    if (!error.response) {
      return new ApiError(
        0,
        'NETWORK_ERROR',
        'Unable to reach the server. Check your connection and try again.',
      );
    }
    return new ApiError(error.response.status, 'HTTP_ERROR', error.message);
  }
  return new ApiError(0, 'UNKNOWN_ERROR', error instanceof Error ? error.message : 'Something went wrong.');
}

type RetriableConfig = InternalAxiosRequestConfig & { _retried?: boolean; skipAuthRefresh?: boolean };

export interface ApiClientOptions {
  baseURL?: string;
  /** Called when the session cannot be refreshed (e.g. redirect to login). */
  onSessionExpired?: () => void;
}

export function createApiClient(options: ApiClientOptions = {}): AxiosInstance {
  const instance = axios.create({
    baseURL: options.baseURL ?? '/api/v1',
    withCredentials: true,
    timeout: 30_000,
    headers: { 'Content-Type': 'application/json' },
  });

  instance.interceptors.request.use((config) => {
    const token = tokenStore.get();
    if (token) config.headers.set('Authorization', `Bearer ${token}`);
    return config;
  });

  // Single-flight refresh: concurrent 401s share one /auth/refresh call.
  let refreshing: Promise<string | null> | null = null;
  const refresh = (): Promise<string | null> => {
    refreshing ??= instance
      .post<ApiSuccess<{ accessToken: string }>>('/auth/refresh', undefined, {
        skipAuthRefresh: true,
      } as AxiosRequestConfig)
      .then((res) => {
        tokenStore.set(res.data.data.accessToken);
        return res.data.data.accessToken;
      })
      .catch(() => {
        tokenStore.set(null);
        return null;
      })
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  };

  instance.interceptors.response.use(
    (res) => res,
    async (error: unknown) => {
      if (error instanceof AxiosError && error.response?.status === 401 && error.config) {
        const config = error.config as RetriableConfig;
        const code = (error.response.data as Partial<ApiFailure> | undefined)?.error?.code;
        const refreshable = code === 'TOKEN_EXPIRED' || code === 'UNAUTHENTICATED';
        if (refreshable && !config._retried && !config.skipAuthRefresh) {
          config._retried = true;
          const token = await refresh();
          if (token) {
            config.headers.set('Authorization', `Bearer ${token}`);
            return instance.request(config);
          }
          options.onSessionExpired?.();
        }
      }
      throw toApiError(error);
    },
  );

  return instance;
}

export const http = createApiClient();

/** Typed helpers that unwrap the `{ success, data, meta }` envelope. */
export const api = {
  async get<T>(url: string, params?: object): Promise<T> {
    const res = await http.get<ApiSuccess<T>>(url, { params });
    return res.data.data;
  },
  async page<T>(url: string, params?: object): Promise<Page<T>> {
    const res = await http.get<ApiSuccess<T[]>>(url, { params });
    return { items: res.data.data, meta: res.data.meta as PageMeta };
  },
  async post<T>(url: string, body?: unknown, opts: { idempotencyKey?: string } = {}): Promise<T> {
    const res = await http.post<ApiSuccess<T>>(url, body, {
      headers: opts.idempotencyKey ? { [IDEMPOTENCY_HEADER]: opts.idempotencyKey } : undefined,
    });
    return res.data.data;
  },
  async put<T>(
    url: string,
    body?: unknown,
    opts: { idempotencyKey?: string; ifMatch?: number } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (opts.idempotencyKey) headers[IDEMPOTENCY_HEADER] = opts.idempotencyKey;
    if (opts.ifMatch !== undefined) headers['If-Match'] = String(opts.ifMatch);
    const res = await http.put<ApiSuccess<T>>(url, body, { headers });
    return res.data.data;
  },
  async patch<T>(url: string, body?: unknown, opts: { ifMatch?: number } = {}): Promise<T> {
    const res = await http.patch<ApiSuccess<T>>(url, body, {
      headers: opts.ifMatch !== undefined ? { 'If-Match': String(opts.ifMatch) } : undefined,
    });
    return res.data.data;
  },
  async delete<T>(url: string): Promise<T> {
    const res = await http.delete<ApiSuccess<T>>(url);
    return res.data.data;
  },
};
