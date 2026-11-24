import { AlertCircle, Loader2 } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api, toApiError } from '@/lib/api-client';

/**
 * In-app viewer for stored files (onboarding documents, payment proofs, quotation PDFs).
 * `openDocumentViewer` can be called from anywhere; the single `<DocumentViewerHost />` mounted
 * at the app root shows the file in a dialog instead of opening or saving it.
 */

export interface ViewerRequest {
  /** API path returning `{ url, mime?, fileName? }` (a short-lived signed URL). */
  urlPath: string;
  title: string;
  /** Used when the API response does not say. Defaults to PDF. */
  mime?: string;
}

let current: ViewerRequest | null = null;
const listeners = new Set<() => void>();

function setRequest(next: ViewerRequest | null) {
  current = next;
  listeners.forEach((l) => l());
}

export function openDocumentViewer(request: ViewerRequest): void {
  setRequest(request);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; url: string; mime: string; fileName?: string };

export function DocumentViewerHost() {
  const request = useSyncExternalStore(subscribe, () => current);
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    if (!request) return;
    let cancelled = false;
    setState({ status: 'loading' });
    api
      .get<{ url: string; mime?: string; fileName?: string }>(request.urlPath)
      .then((res) => {
        if (cancelled) return;
        setState({
          status: 'ready',
          url: res.url,
          mime: res.mime ?? request.mime ?? 'application/pdf',
          fileName: res.fileName,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = toApiError(err).message || 'The file could not be loaded.';
        setState({ status: 'error', message });
      });
    return () => {
      cancelled = true;
    };
  }, [request]);

  const title = state.status === 'ready' && state.fileName ? state.fileName : (request?.title ?? '');

  return (
    <Dialog open={request !== null} onOpenChange={(open) => !open && setRequest(null)}>
      <DialogContent className="flex h-[90vh] max-w-5xl flex-col gap-3 p-4 sm:p-5">
        <DialogHeader>
          <DialogTitle className="truncate">{title}</DialogTitle>
          <DialogDescription className="sr-only">Document preview</DialogDescription>
        </DialogHeader>
        <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg border bg-muted/40">
          {state.status === 'loading' && (
            <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
              <Loader2 className="size-6 animate-spin" aria-label="Loading" />
            </div>
          )}
          {state.status === 'error' && (
            <div
              role="alert"
              className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center text-sm text-destructive"
            >
              <AlertCircle className="size-6" aria-hidden />
              {state.message}
            </div>
          )}
          {state.status === 'ready' &&
            (state.mime.startsWith('image/') ? (
              <div className="flex h-full w-full items-center justify-center overflow-auto p-2">
                <img
                  src={state.url}
                  alt={title}
                  className="max-h-full max-w-full object-contain"
                  draggable={false}
                  onContextMenu={(e) => e.preventDefault()}
                />
              </div>
            ) : (
              <iframe
                // #toolbar=0 hides the browser PDF viewer's download/print bar (Chrome, Edge).
                src={`${state.url}#toolbar=0&navpanes=0`}
                title={title}
                className="h-full w-full border-0 bg-white"
              />
            ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
