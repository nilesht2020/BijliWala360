import { Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  PERMISSIONS,
  roleCodeSchema,
  type Permission,
  type RoleView,
  type ScopeType,
} from '@skillconnect/contracts';
import { ConfirmDialog } from '@/components/layout/confirm-dialog';
import { PageHeader } from '@/components/layout/page-parts';
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
  Checkbox,
  Input,
  Label,
  Select,
  Skeleton,
  Textarea,
} from '@/components/ui/primitives';
import { useDeleteRole, useRoles, useSaveRole } from '@/features/admin/api';
import type { ApiError } from '@/lib/api-client';
import { humanize } from '@/lib/format';

/** Permissions grouped by their prefix ("job.read" -> "job") for a readable checklist. */
const GROUPS = PERMISSIONS.reduce<Record<string, Permission[]>>((acc, p) => {
  const group = p.split('.')[0] as string;
  (acc[group] ??= []).push(p);
  return acc;
}, {});

type Draft = {
  id?: string;
  version?: number;
  isSystem: boolean;
  code: string;
  name: string;
  description: string;
  scopeType: ScopeType;
  permissions: Set<Permission>;
};

const emptyDraft = (): Draft => ({
  isSystem: false,
  code: '',
  name: '',
  description: '',
  scopeType: 'PLATFORM',
  permissions: new Set(),
});

export function RolesPage() {
  const roles = useRoles();
  const save = useSaveRole();
  const remove = useDeleteRole();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<RoleView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const edit = (r: RoleView) =>
    setDraft({
      id: r.id,
      version: r.version,
      isSystem: r.isSystem,
      code: r.code,
      name: r.name,
      description: r.description ?? '',
      scopeType: r.scopeType,
      permissions: new Set(r.permissions),
    });

  const codeError = useMemo(
    () =>
      draft && !draft.id && draft.code && !roleCodeSchema.safeParse(draft.code).success
        ? 'Use UPPER_SNAKE_CASE, 3-50 characters'
        : null,
    [draft],
  );
  const superAdmin = draft?.code === 'SUPER_ADMIN';

  const submit = async () => {
    if (!draft) return;
    setError(null);
    try {
      const permissions = [...draft.permissions];
      if (draft.id) {
        await save.mutateAsync({
          id: draft.id,
          version: draft.version,
          update: {
            name: draft.name,
            description: draft.description || undefined,
            ...(superAdmin ? {} : { permissions }),
          },
        });
      } else {
        await save.mutateAsync({
          create: {
            code: draft.code,
            name: draft.name,
            description: draft.description || undefined,
            scopeType: draft.scopeType,
            permissions,
          },
        });
      }
      setDraft(null);
    } catch (e) {
      setError((e as ApiError).message);
    }
  };

  return (
    <>
      <PageHeader
        title="Roles & permissions"
        description="Roles bundle permissions. System roles can be edited but not deleted."
        actions={
          <Button onClick={() => setDraft(emptyDraft())}>
            <Plus /> New role
          </Button>
        }
      />
      {roles.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {roles.data?.map((r) => (
            <Card key={r.id} className="flex flex-col gap-3 p-5">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h3 className="font-semibold">{r.name}</h3>
                  <p className="font-mono text-xs text-muted-foreground">{r.code}</p>
                </div>
                <div className="flex gap-1">
                  {r.isSystem && <Badge>System</Badge>}
                  <Badge tone="info">{humanize(r.scopeType)}</Badge>
                </div>
              </div>
              <p className="text-sm text-muted-foreground">
                {r.code === 'SUPER_ADMIN' ? 'All permissions' : `${r.permissions.length} permissions`} ·{' '}
                {r.assignedUsers ?? 0} users
              </p>
              <div className="mt-auto flex gap-2">
                <Button variant="outline" size="sm" onClick={() => edit(r)}>
                  Edit
                </Button>
                {!r.isSystem && (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Delete ${r.name}`}
                    onClick={() => setDeleting(r)}
                  >
                    <Trash2 />
                  </Button>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={!!draft} onOpenChange={(o) => !o && setDraft(null)}>
        <DialogContent className="max-h-[90dvh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{draft?.id ? `Edit ${draft.name}` : 'New role'}</DialogTitle>
            <DialogDescription>
              Users holding this role get the new permissions on their next request.
            </DialogDescription>
          </DialogHeader>
          {draft && (
            <div className="flex flex-col gap-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="role-code">Code</Label>
                  <Input
                    id="role-code"
                    value={draft.code}
                    disabled={!!draft.id}
                    aria-invalid={!!codeError}
                    onChange={(e) => setDraft({ ...draft, code: e.target.value.toUpperCase() })}
                  />
                  {codeError && <p className="text-xs text-destructive">{codeError}</p>}
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="role-name">Name</Label>
                  <Input
                    id="role-name"
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="role-scope">Scope</Label>
                  <Select
                    id="role-scope"
                    value={draft.scopeType}
                    disabled={!!draft.id}
                    onChange={(e) => setDraft({ ...draft, scopeType: e.target.value as ScopeType })}
                  >
                    <option value="PLATFORM">Platform</option>
                    <option value="COMPANY">Company</option>
                    <option value="VENDOR">Vendor</option>
                  </Select>
                </div>
                <div className="flex flex-col gap-1.5 sm:col-span-2">
                  <Label htmlFor="role-desc">Description</Label>
                  <Textarea
                    id="role-desc"
                    className="min-h-16"
                    value={draft.description}
                    onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  />
                </div>
              </div>
              {superAdmin ? (
                <Alert tone="info">Super Admin always has every permission.</Alert>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {Object.entries(GROUPS).map(([group, perms]) => (
                    <fieldset key={group} className="rounded-lg border p-3">
                      <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        {humanize(group)}
                      </legend>
                      {perms.map((p) => (
                        <label key={p} className="flex items-center gap-2 py-0.5 text-sm">
                          <Checkbox
                            checked={draft.permissions.has(p)}
                            onChange={(e) => {
                              const next = new Set(draft.permissions);
                              if (e.target.checked) next.add(p);
                              else next.delete(p);
                              setDraft({ ...draft, permissions: next });
                            }}
                          />
                          <span className="font-mono text-xs">{p}</span>
                        </label>
                      ))}
                    </fieldset>
                  ))}
                </div>
              )}
              {error && <Alert>{error}</Alert>}
              <DialogFooter>
                <Button variant="outline" onClick={() => setDraft(null)}>
                  Cancel
                </Button>
                <Button
                  onClick={submit}
                  loading={save.isPending}
                  disabled={!draft.name || (!draft.id && (!draft.code || !!codeError))}
                >
                  Save role
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete ${deleting?.name}?`}
        description="A role can only be deleted when nobody holds it."
        destructive
        confirmLabel="Delete role"
        onConfirm={async () => {
          if (deleting) await remove.mutateAsync(deleting.id);
        }}
      >
        {remove.error && <Alert>{(remove.error as ApiError).message}</Alert>}
      </ConfirmDialog>
    </>
  );
}
