import { CheckCircle2, FileUp, Loader2, ShieldAlert } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * The three-step presigned upload flow (ARCHITECTURE §6.7):
 *   1. requestIntent -> server validates type/size/ownership, returns a presigned PUT URL;
 *   2. browser PUTs the file straight to private object storage;
 *   3. complete -> server queues the virus/type scan.
 * The API calls are injected so the component is reusable for every document owner type.
 */
export interface UploadIntent {
  documentId: string;
  uploadUrl: string;
  headers: Record<string, string>;
}

export interface FileUploadApi {
  requestIntent: (file: File) => Promise<UploadIntent>;
  complete: (documentId: string) => Promise<void>;
  /** Defaults to fetch(PUT). Injectable for tests and progress-capable implementations. */
  putFile?: (intent: UploadIntent, file: File) => Promise<void>;
}

type Phase = 'idle' | 'uploading' | 'scanning' | 'error';

async function defaultPut(intent: UploadIntent, file: File): Promise<void> {
  const res = await fetch(intent.uploadUrl, { method: 'PUT', headers: intent.headers, body: file });
  if (!res.ok) throw new Error(`Upload failed (${res.status})`);
}

export function FileUpload({
  accept,
  maxSizeBytes,
  api,
  onUploaded,
  label = 'Choose a file',
  disabled,
}: {
  accept: string[];
  maxSizeBytes: number;
  api: FileUploadApi;
  onUploaded: (documentId: string, file: File) => void;
  label?: string;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);

  const handleFile = async (file: File) => {
    setError(null);
    setFileName(file.name);
    // Client-side checks are for UX only; the server re-validates (type by magic bytes, size, AV scan).
    if (accept.length > 0 && !accept.includes(file.type)) {
      setPhase('error');
      setError('This file type is not allowed.');
      return;
    }
    if (file.size > maxSizeBytes) {
      setPhase('error');
      setError(`File is too large. Maximum size is ${(maxSizeBytes / (1024 * 1024)).toFixed(1)} MB.`);
      return;
    }
    try {
      setPhase('uploading');
      const intent = await api.requestIntent(file);
      await (api.putFile ?? defaultPut)(intent, file);
      setPhase('scanning');
      await api.complete(intent.documentId);
      onUploaded(intent.documentId, file);
      setPhase('idle');
    } catch (e) {
      setPhase('error');
      setError(e instanceof Error ? e.message : 'Upload failed. Please try again.');
    }
  };

  const busy = phase === 'uploading' || phase === 'scanning';

  return (
    <div
      className={cn(
        'flex flex-col items-center gap-3 rounded-2xl border border-dashed p-6 text-center',
        phase === 'error' && 'border-destructive/60',
      )}
    >
      <input
        ref={inputRef}
        type="file"
        className="sr-only"
        accept={accept.join(',')}
        disabled={disabled || busy}
        data-testid="file-input"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void handleFile(file);
        }}
      />
      {busy ? (
        <Loader2 className="size-6 animate-spin text-primary" aria-hidden />
      ) : phase === 'error' ? (
        <ShieldAlert className="size-6 text-destructive" aria-hidden />
      ) : fileName ? (
        <CheckCircle2 className="size-6 text-success" aria-hidden />
      ) : (
        <FileUp className="size-6 text-muted-foreground" aria-hidden />
      )}
      <p className="text-sm" aria-live="polite">
        {phase === 'uploading' && `Uploading ${fileName}…`}
        {phase === 'scanning' && 'Checking the file for safety…'}
        {phase === 'error' && <span className="font-medium text-destructive">{error}</span>}
        {phase === 'idle' && (fileName ? `${fileName} uploaded` : 'PDF or image files')}
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled || busy}
        onClick={() => inputRef.current?.click()}
      >
        {fileName && phase === 'idle' ? 'Replace file' : label}
      </Button>
    </div>
  );
}
