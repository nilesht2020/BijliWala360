import { useInfiniteQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Pencil, Plus, RotateCcw } from 'lucide-react';
import { Fragment, useMemo, useState } from 'react';
import {
  BUSINESS_CONFIG,
  isBusinessConfigKey,
  NOTIFICATION_CHANNELS,
  notificationTemplateSchema,
  USER_TYPES,
  type ConfigEntryView,
  type NotificationChannel,
  type NotificationTemplateInput,
  type NotificationTemplateView,
} from '@bijliwala/contracts';
import { useCan } from '@/app/auth';
import { EmptyState, PageHeader } from '@/components/layout/page-parts';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Alert,
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  Input,
  Label,
  Select,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from '@/components/ui/primitives';
import {
  fetchAuditPage,
  previewTemplate,
  useConfig,
  useSaveConfig,
  useSaveTemplate,
  useTemplates,
  type AuditParams,
} from '@/features/admin/api';
import type { ApiError } from '@/lib/api-client';
import { formatDateTime, humanize } from '@/lib/format';

/* =============================================================== Audit log explorer (FR-AUD-03) */

export function AuditLogPage() {
  const [draft, setDraft] = useState<AuditParams>({});
  const [filters, setFilters] = useState<AuditParams>({});
  const [open, setOpen] = useState<string | null>(null);

  const query = useInfiniteQuery({
    queryKey: ['admin', 'audit', filters],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      fetchAuditPage({ ...filters, limit: 50, ...(pageParam ? { cursor: pageParam } : {}) }),
    getNextPageParam: (last) => last.meta.nextCursor ?? undefined,
  });
  const rows = query.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every change and sign-in, newest first. Entries cannot be edited or deleted."
      />
      <Card className="mb-4 p-4">
        <form
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5"
          onSubmit={(e) => {
            e.preventDefault();
            setFilters(Object.fromEntries(Object.entries(draft).filter(([, v]) => v)) as AuditParams);
          }}
        >
          <Input
            placeholder="Action, e.g. auth.* or role.grant"
            aria-label="Action"
            value={draft.action ?? ''}
            onChange={(e) => setDraft({ ...draft, action: e.target.value })}
          />
          <Input
            placeholder="Entity type, e.g. User"
            aria-label="Entity type"
            value={draft.entityType ?? ''}
            onChange={(e) => setDraft({ ...draft, entityType: e.target.value })}
          />
          <Input
            placeholder="Entity id"
            aria-label="Entity id"
            value={draft.entityId ?? ''}
            onChange={(e) => setDraft({ ...draft, entityId: e.target.value })}
          />
          <Input
            placeholder="Actor user id"
            aria-label="Actor user id"
            value={draft.actorId ?? ''}
            onChange={(e) => setDraft({ ...draft, actorId: e.target.value })}
          />
          <Button type="submit">Filter</Button>
        </form>
      </Card>
      <Card className="overflow-hidden">
        {query.isLoading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="p-4">
            <EmptyState title="No audit entries match" className="border-0" />
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-8" />
                <TableHead>When</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Entity</TableHead>
                <TableHead>Actor</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <Fragment key={r.id}>
                  <TableRow className="cursor-pointer" onClick={() => setOpen(open === r.id ? null : r.id)}>
                    <TableCell>
                      {open === r.id ? (
                        <ChevronDown className="size-4" />
                      ) : (
                        <ChevronRight className="size-4" />
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs">{formatDateTime(r.at)}</TableCell>
                    <TableCell>
                      <span className="font-mono text-xs">{r.action}</span>{' '}
                      {r.isFinancial && <Badge tone="warning">Financial</Badge>}
                    </TableCell>
                    <TableCell className="text-xs">
                      {r.entityType} <span className="font-mono text-muted-foreground">{r.entityId}</span>
                    </TableCell>
                    <TableCell className="text-xs">
                      {r.actor.system ? `system: ${r.actor.system}` : (r.actor.userId ?? '—')}
                    </TableCell>
                  </TableRow>
                  {open === r.id && (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={5} className="bg-muted/40">
                        <div className="grid gap-3 md:grid-cols-2">
                          <JsonBlock title="Before" value={r.before} />
                          <JsonBlock title="After" value={r.after} />
                        </div>
                        <p className="mt-2 text-xs text-muted-foreground">
                          {r.reason && <>Reason: {r.reason} · </>}IP {r.ip ?? '—'} · request{' '}
                          {r.requestId ?? '—'}
                        </p>
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        )}
        {query.hasNextPage && (
          <div className="border-t p-3 text-center">
            <Button
              variant="outline"
              loading={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              Load older entries
            </Button>
          </div>
        )}
      </Card>
    </>
  );
}

function JsonBlock({ title, value }: { title: string; value: unknown }) {
  return (
    <div>
      <p className="mb-1 text-xs font-semibold uppercase text-muted-foreground">{title}</p>
      <pre className="max-h-64 overflow-auto rounded-lg border bg-background p-2 text-xs">
        {value === undefined ? '—' : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

/* =============================================================== Settings (FR-CFG-01) */

/** Editor for one config value: simple inputs for scalars, JSON for structured values. */
function ConfigEditor({ entry, canEdit }: { entry: ConfigEntryView; canEdit: boolean }) {
  const save = useSaveConfig();
  const kind =
    typeof entry.defaultValue === 'number'
      ? 'number'
      : typeof entry.defaultValue === 'boolean'
        ? 'boolean'
        : typeof entry.defaultValue === 'string'
          ? 'string'
          : 'json';
  const initial = kind === 'json' ? JSON.stringify(entry.value, null, 2) : String(entry.value);
  const [text, setText] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const dirty = text !== initial;

  const parse = (): unknown => {
    if (kind === 'number') return Number(text);
    if (kind === 'boolean') return text === 'true';
    if (kind === 'string') return text;
    return JSON.parse(text) as unknown;
  };

  const submit = () => {
    setError(null);
    let value: unknown;
    try {
      value = parse();
    } catch {
      setError('This is not valid JSON.');
      return;
    }
    if (isBusinessConfigKey(entry.key)) {
      const result = BUSINESS_CONFIG[entry.key].schema.safeParse(value);
      if (!result.success) {
        setError(result.error.issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`).join('; '));
        return;
      }
    }
    save.mutate(
      { key: entry.key, value, version: entry.version },
      { onError: (e) => setError((e as ApiError).message) },
    );
  };

  return (
    <div className="flex flex-col gap-2 border-b py-4 last:border-0 sm:flex-row sm:items-start sm:gap-6">
      <div className="sm:w-1/2">
        <p className="text-sm font-medium">{entry.description}</p>
        <p className="font-mono text-xs text-muted-foreground">
          {entry.key} ·{' '}
          {entry.isDefault ? 'default' : `v${entry.version}, updated ${formatDateTime(entry.updatedAt)}`}
        </p>
      </div>
      <div className="flex flex-1 flex-col gap-2">
        {kind === 'boolean' ? (
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={text === 'true'}
              disabled={!canEdit}
              onChange={(e) => setText(String(e.target.checked))}
            />{' '}
            Enabled
          </label>
        ) : kind === 'json' ? (
          <Textarea
            className="font-mono text-xs"
            rows={Math.min(10, text.split('\n').length + 1)}
            value={text}
            disabled={!canEdit}
            onChange={(e) => setText(e.target.value)}
            aria-label={entry.key}
          />
        ) : (
          <Input
            type={kind === 'number' ? 'number' : 'text'}
            value={text}
            disabled={!canEdit}
            onChange={(e) => setText(e.target.value)}
            aria-label={entry.key}
          />
        )}
        {error && <Alert>{error}</Alert>}
        {canEdit && dirty && (
          <div className="flex gap-2">
            <Button size="sm" onClick={submit} loading={save.isPending}>
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setText(initial)}>
              <RotateCcw /> Undo
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

export function SettingsPage() {
  const config = useConfig();
  const canEdit = useCan('config.manage');
  const groups = useMemo(() => {
    const map = new Map<string, ConfigEntryView[]>();
    for (const e of config.data ?? []) map.set(e.group, [...(map.get(e.group) ?? []), e]);
    return [...map.entries()];
  }, [config.data]);

  return (
    <>
      <PageHeader
        title="Settings"
        description="Business rules used across the platform. Every change is validated, versioned and audited."
      />
      {config.isLoading ? (
        <Skeleton className="h-96 w-full" />
      ) : (
        <div className="flex flex-col gap-6">
          {groups.map(([group, entries]) => (
            <Card key={group}>
              <CardHeader>
                <CardTitle>{group}</CardTitle>
              </CardHeader>
              <CardContent>
                {entries.map((e) => (
                  <ConfigEditor key={`${e.key}:${e.version}`} entry={e} canEdit={canEdit} />
                ))}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}

/* =============================================================== Notification templates (FR-NTF-03) */

const emptyTemplate = (): NotificationTemplateInput => ({
  eventType: '',
  channel: 'SMS',
  locale: 'en',
  audience: 'PROFESSIONAL',
  isActive: true,
  sms: { body: '' },
});

export function TemplatesPage() {
  const templates = useTemplates();
  const [editing, setEditing] = useState<{
    id?: string;
    version?: number;
    input: NotificationTemplateInput;
  } | null>(null);

  return (
    <>
      <PageHeader
        title="Notification templates"
        description="Message text per event, channel and audience. Use {{variable}} placeholders."
        actions={
          <Button onClick={() => setEditing({ input: emptyTemplate() })}>
            <Plus /> New template
          </Button>
        }
      />
      <Card className="overflow-hidden">
        {templates.isLoading ? (
          <Skeleton className="h-64" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Event</TableHead>
                <TableHead>Channel</TableHead>
                <TableHead>Audience</TableHead>
                <TableHead>Variables</TableHead>
                <TableHead>Status</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {templates.data?.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="font-mono text-xs">{t.eventType}</TableCell>
                  <TableCell>{humanize(t.channel)}</TableCell>
                  <TableCell>{humanize(t.audience)}</TableCell>
                  <TableCell className="font-mono text-xs">{t.variables.join(', ') || '—'}</TableCell>
                  <TableCell>
                    {t.isActive ? <Badge tone="success">Active</Badge> : <Badge>Inactive</Badge>}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Edit ${t.eventType} ${t.channel}`}
                      onClick={() => setEditing({ id: t.id, version: t.version, input: toInput(t) })}
                    >
                      <Pencil />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
      {editing && (
        <TemplateDialog key={editing.id ?? 'new'} initial={editing} onClose={() => setEditing(null)} />
      )}
    </>
  );
}

function toInput(t: NotificationTemplateView): NotificationTemplateInput {
  const { eventType, channel, locale, audience, whatsapp, sms, email, inApp, isActive } = t;
  return {
    eventType,
    channel,
    locale,
    audience,
    isActive,
    ...(whatsapp ? { whatsapp } : {}),
    ...(sms ? { sms } : {}),
    ...(email ? { email } : {}),
    ...(inApp ? { inApp } : {}),
  };
}

function contentFor(
  channel: NotificationChannel,
  prev: NotificationTemplateInput,
): Partial<NotificationTemplateInput> {
  switch (channel) {
    case 'SMS':
      return { sms: prev.sms ?? { body: '' } };
    case 'EMAIL':
      return { email: prev.email ?? { subject: '', html: '' } };
    case 'IN_APP':
      return { inApp: prev.inApp ?? { title: '', body: '' } };
    case 'WHATSAPP':
      return { whatsapp: prev.whatsapp ?? { templateName: '', language: 'en', paramOrder: [] } };
  }
}

function TemplateDialog({
  initial,
  onClose,
}: {
  initial: { id?: string; version?: number; input: NotificationTemplateInput };
  onClose: () => void;
}) {
  const save = useSaveTemplate();
  const [t, setT] = useState<NotificationTemplateInput>(initial.input);
  const [error, setError] = useState<string | null>(null);
  const [previewData, setPreviewData] = useState('{\n  "name": "Asha"\n}');
  const [preview, setPreview] = useState<string | null>(null);

  const setChannel = (channel: NotificationChannel) => {
    const { sms: _s, email: _e, inApp: _i, whatsapp: _w, ...rest } = t;
    setT({ ...rest, channel, ...contentFor(channel, t) } as NotificationTemplateInput);
  };

  const submit = () => {
    setError(null);
    const parsed = notificationTemplateSchema.safeParse(t);
    if (!parsed.success) {
      setError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      return;
    }
    save.mutate(
      { id: initial.id, version: initial.version, input: parsed.data },
      { onSuccess: onClose, onError: (e) => setError((e as ApiError).message) },
    );
  };

  const runPreview = async () => {
    if (!initial.id) return;
    try {
      const out = await previewTemplate(initial.id, JSON.parse(previewData) as Record<string, unknown>);
      setPreview(
        [out.subject, out.title, out.body, out.html, out.whatsapp?.params.join(' | ')]
          .filter(Boolean)
          .join('\n'),
      );
    } catch (e) {
      setPreview(e instanceof SyntaxError ? 'Preview data is not valid JSON.' : (e as ApiError).message);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{initial.id ? 'Edit template' : 'New template'}</DialogTitle>
          <DialogDescription>
            WhatsApp templates must match a template approved in your WhatsApp Business account.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label htmlFor="tpl-event">Event type</Label>
            <Input
              id="tpl-event"
              placeholder="invitation.sent"
              value={t.eventType}
              onChange={(e) => setT({ ...t, eventType: e.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="tpl-channel">Channel</Label>
            <Select
              id="tpl-channel"
              value={t.channel}
              onChange={(e) => setChannel(e.target.value as NotificationChannel)}
            >
              {NOTIFICATION_CHANNELS.map((c) => (
                <option key={c} value={c}>
                  {humanize(c)}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="tpl-audience">Audience</Label>
            <Select
              id="tpl-audience"
              value={t.audience}
              onChange={(e) =>
                setT({ ...t, audience: e.target.value as NotificationTemplateInput['audience'] })
              }
            >
              {USER_TYPES.map((u) => (
                <option key={u} value={u}>
                  {humanize(u)}
                </option>
              ))}
            </Select>
          </div>

          {t.channel === 'SMS' && (
            <>
              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <Label htmlFor="tpl-sms">SMS text</Label>
                <Textarea
                  id="tpl-sms"
                  value={t.sms?.body ?? ''}
                  onChange={(e) => setT({ ...t, sms: { ...t.sms, body: e.target.value } })}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="tpl-dlt">DLT template id</Label>
                <Input
                  id="tpl-dlt"
                  value={t.sms?.dltTemplateId ?? ''}
                  onChange={(e) =>
                    setT({
                      ...t,
                      sms: { body: t.sms?.body ?? '', dltTemplateId: e.target.value || undefined },
                    })
                  }
                />
              </div>
            </>
          )}
          {t.channel === 'IN_APP' && (
            <>
              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <Label htmlFor="tpl-title">Title</Label>
                <Input
                  id="tpl-title"
                  value={t.inApp?.title ?? ''}
                  onChange={(e) =>
                    setT({ ...t, inApp: { body: t.inApp?.body ?? '', ...t.inApp, title: e.target.value } })
                  }
                />
              </div>
              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <Label htmlFor="tpl-body">Body</Label>
                <Textarea
                  id="tpl-body"
                  value={t.inApp?.body ?? ''}
                  onChange={(e) =>
                    setT({ ...t, inApp: { title: t.inApp?.title ?? '', ...t.inApp, body: e.target.value } })
                  }
                />
              </div>
              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <Label htmlFor="tpl-link">Link (optional)</Label>
                <Input
                  id="tpl-link"
                  value={t.inApp?.link ?? ''}
                  onChange={(e) =>
                    setT({
                      ...t,
                      inApp: {
                        title: t.inApp?.title ?? '',
                        body: t.inApp?.body ?? '',
                        link: e.target.value || undefined,
                      },
                    })
                  }
                />
              </div>
            </>
          )}
          {t.channel === 'EMAIL' && (
            <>
              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <Label htmlFor="tpl-subject">Subject</Label>
                <Input
                  id="tpl-subject"
                  value={t.email?.subject ?? ''}
                  onChange={(e) =>
                    setT({ ...t, email: { html: t.email?.html ?? '', subject: e.target.value } })
                  }
                />
              </div>
              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <Label htmlFor="tpl-html">HTML body</Label>
                <Textarea
                  id="tpl-html"
                  className="font-mono text-xs"
                  value={t.email?.html ?? ''}
                  onChange={(e) =>
                    setT({ ...t, email: { subject: t.email?.subject ?? '', html: e.target.value } })
                  }
                />
              </div>
            </>
          )}
          {t.channel === 'WHATSAPP' && (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="tpl-wa">Approved template name</Label>
                <Input
                  id="tpl-wa"
                  value={t.whatsapp?.templateName ?? ''}
                  onChange={(e) =>
                    setT({
                      ...t,
                      whatsapp: {
                        language: 'en',
                        paramOrder: [],
                        ...t.whatsapp,
                        templateName: e.target.value,
                      },
                    })
                  }
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="tpl-params">Parameters, in order</Label>
                <Input
                  id="tpl-params"
                  placeholder="name, jobNo"
                  value={t.whatsapp?.paramOrder.join(', ') ?? ''}
                  onChange={(e) =>
                    setT({
                      ...t,
                      whatsapp: {
                        templateName: t.whatsapp?.templateName ?? '',
                        language: t.whatsapp?.language ?? 'en',
                        paramOrder: e.target.value
                          .split(',')
                          .map((s) => s.trim())
                          .filter(Boolean),
                      },
                    })
                  }
                />
              </div>
            </>
          )}
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <Checkbox checked={t.isActive} onChange={(e) => setT({ ...t, isActive: e.target.checked })} />{' '}
            Active
          </label>
        </div>

        {initial.id && (
          <div className="grid gap-2 rounded-lg border p-3">
            <Label htmlFor="tpl-preview">Preview with sample data (JSON)</Label>
            <Textarea
              id="tpl-preview"
              className="min-h-16 font-mono text-xs"
              value={previewData}
              onChange={(e) => setPreviewData(e.target.value)}
            />
            <Button
              variant="outline"
              size="sm"
              className="justify-self-start"
              onClick={() => void runPreview()}
            >
              Preview saved version
            </Button>
            {preview && <pre className="whitespace-pre-wrap rounded bg-muted p-2 text-xs">{preview}</pre>}
          </div>
        )}
        {error && <Alert>{error}</Alert>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={save.isPending}>
            Save template
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
