import { zodResolver } from '@hookform/resolvers/zod';
import type { ColumnDef } from '@tanstack/react-table';
import { ArrowLeft, KeyRound, LogOut, Plus, ShieldOff, UserCheck, UserX } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  createAdminUserSchema,
  USER_STATUSES,
  USER_TYPES,
  type CreateAdminUserInput,
  type RoleView,
  type UserView,
} from '@bijliwala/contracts';
import { useCan } from '@/app/auth';
import { DataTable, useListParams } from '@/components/data-table/data-table';
import { applyServerErrors, FormField } from '@/components/forms/form-field';
import { ConfirmDialog } from '@/components/layout/confirm-dialog';
import { EmptyState, PageHeader, StatusBadge } from '@/components/layout/page-parts';
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
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Input,
  Select,
  Skeleton,
  Textarea,
} from '@/components/ui/primitives';
import {
  useCreateAdmin,
  useGrantRole,
  useRevokeRole,
  useRoles,
  useUser,
  useUserAction,
  useUsers,
} from '@/features/admin/api';
import type { ApiError } from '@/lib/api-client';
import { formatDateTime, formatMobile, humanize } from '@/lib/format';

const columns: ColumnDef<UserView, unknown>[] = [
  {
    header: 'Name',
    accessorKey: 'name',
    cell: ({ row }) => (
      <div className="min-w-0">
        <p className="font-medium">{row.original.name}</p>
        <p className="truncate text-xs text-muted-foreground">
          {row.original.email ?? (row.original.mobile ? formatMobile(row.original.mobile) : '')}
        </p>
      </div>
    ),
  },
  { header: 'Type', accessorKey: 'userType', cell: ({ getValue }) => humanize(String(getValue())) },
  {
    header: 'Roles',
    accessorKey: 'roleCodes',
    cell: ({ row }) => (
      <div className="flex flex-wrap gap-1">
        {row.original.roleCodes.length ? (
          row.original.roleCodes.map((r) => <Badge key={r}>{humanize(r)}</Badge>)
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </div>
    ),
  },
  {
    header: 'Status',
    accessorKey: 'status',
    cell: ({ getValue }) => <StatusBadge status={String(getValue())} />,
  },
  {
    header: 'Last sign-in',
    accessorKey: 'lastLoginAt',
    cell: ({ getValue }) => formatDateTime(getValue() as string | undefined),
  },
];

export function UsersPage() {
  const navigate = useNavigate();
  const canManage = useCan('user.manage');
  const { page, pageSize, filters, setPage, setFilter } = useListParams(['q', 'userType', 'status'] as const);
  const users = useUsers({ page, pageSize, ...filters });
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState(filters.q ?? '');

  return (
    <>
      <PageHeader
        title="Users"
        description="Everyone with access to Bijli Wala: administrators, companies and providers."
        actions={
          canManage && (
            <Button onClick={() => setCreating(true)}>
              <Plus /> Add administrator
            </Button>
          )
        }
      />
      <DataTable
        columns={columns}
        data={users.data?.items}
        meta={users.data?.meta}
        isLoading={users.isLoading}
        onPageChange={setPage}
        getRowId={(u) => u.id}
        onRowClick={(u) => navigate(`/admin/users/${u.id}`)}
        emptyTitle="No users match these filters"
        toolbar={
          <>
            <form
              className="flex-1"
              onSubmit={(e) => {
                e.preventDefault();
                setFilter('q', search.trim() || undefined);
              }}
            >
              <Input
                placeholder="Search name, email or mobile"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Search users"
              />
            </form>
            <Select
              aria-label="User type"
              className="sm:w-44"
              value={filters.userType ?? ''}
              onChange={(e) => setFilter('userType', e.target.value || undefined)}
            >
              <option value="">All types</option>
              {USER_TYPES.map((t) => (
                <option key={t} value={t}>
                  {humanize(t)}
                </option>
              ))}
            </Select>
            <Select
              aria-label="Status"
              className="sm:w-40"
              value={filters.status ?? ''}
              onChange={(e) => setFilter('status', e.target.value || undefined)}
            >
              <option value="">All statuses</option>
              {USER_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {humanize(s)}
                </option>
              ))}
            </Select>
          </>
        }
        renderMobileCard={(u) => (
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-medium">{u.name}</p>
              <p className="truncate text-xs text-muted-foreground">{u.email ?? u.mobile}</p>
              <p className="mt-1 text-xs text-muted-foreground">{humanize(u.userType)}</p>
            </div>
            <StatusBadge status={u.status} />
          </div>
        )}
      />
      <CreateAdminDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(id) => navigate(`/admin/users/${id}`)}
      />
    </>
  );
}

function adminRoles(roles: RoleView[] | undefined): RoleView[] {
  return (roles ?? []).filter((r) => r.scopeType === 'PLATFORM' && r.code !== 'PROFESSIONAL');
}

function CreateAdminDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (id: string) => void;
}) {
  const roles = useRoles();
  const create = useCreateAdmin();
  const form = useForm<CreateAdminUserInput>({
    resolver: zodResolver(createAdminUserSchema),
    defaultValues: { name: '', email: '', roleCodes: [] },
  });

  const submit = form.handleSubmit((values) =>
    create.mutate(values, {
      onSuccess: (user) => {
        form.reset();
        onOpenChange(false);
        onCreated(user.id);
      },
      onError: (err) => applyServerErrors(err, form.setError),
    }),
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Add administrator</DialogTitle>
          <DialogDescription>
            They will receive an email to choose a password and must set up an authenticator app on first
            sign-in.
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
          <FormField
            control={form.control}
            name="name"
            label="Full name"
            required
            render={(f, a) => <Input {...a} {...f} />}
          />
          <FormField
            control={form.control}
            name="email"
            label="Work email"
            required
            render={(f, a) => <Input {...a} {...f} type="email" />}
          />
          <FormField
            control={form.control}
            name="roleCodes"
            label="Roles"
            required
            render={(field, a11y) => (
              <div
                id={a11y.id}
                className="grid max-h-56 gap-2 overflow-y-auto rounded-lg border p-3 sm:grid-cols-2"
              >
                {adminRoles(roles.data).map((r) => (
                  <label key={r.code} className="flex items-start gap-2 text-sm">
                    <Checkbox
                      checked={field.value.includes(r.code)}
                      onChange={(e) =>
                        field.onChange(
                          e.target.checked
                            ? [...field.value, r.code]
                            : field.value.filter((c) => c !== r.code),
                        )
                      }
                    />
                    <span>{r.name}</span>
                  </label>
                ))}
              </div>
            )}
          />
          {create.error && !(create.error as ApiError).details.length && (
            <Alert>{(create.error as ApiError).message}</Alert>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending}>
              Create and send invite
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type PendingAction =
  | { kind: 'suspend' | 'reactivate' | 'deactivate' }
  | { kind: 'mfa-reset' | 'revoke-sessions' }
  | { kind: 'revoke-role'; assignmentId: string; roleName: string };

export function UserDetailPage() {
  const { id = '' } = useParams();
  const user = useUser(id);
  const roles = useRoles();
  const action = useUserAction(id);
  const grant = useGrantRole(id);
  const revoke = useRevokeRole(id);
  const canManage = useCan('user.manage');
  const canRoles = useCan('role.manage');
  const canSessions = useCan('session.revoke');
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [reason, setReason] = useState('');
  const [roleToGrant, setRoleToGrant] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (user.isLoading) return <Skeleton className="h-64 w-full" />;
  if (user.error || !user.data)
    return (
      <EmptyState
        title="User not found"
        action={
          <Button asChild variant="outline">
            <Link to="/admin/users">Back to users</Link>
          </Button>
        }
      />
    );
  const u = user.data;

  const grantable = (roles.data ?? []).filter(
    (r) =>
      !u.roleCodes.includes(r.code) &&
      r.scopeType === 'PLATFORM' &&
      (u.userType === 'ADMIN' ? r.code !== 'PROFESSIONAL' : r.code === 'PROFESSIONAL'),
  );

  const run = async () => {
    if (!pending) return;
    setError(null);
    try {
      if (pending.kind === 'revoke-role') await revoke.mutateAsync(pending.assignmentId);
      else if (pending.kind === 'mfa-reset' || pending.kind === 'revoke-sessions')
        await action.mutateAsync({ kind: pending.kind });
      else await action.mutateAsync({ kind: pending.kind, reason });
      setReason('');
    } catch (e) {
      setError((e as ApiError).message);
      throw e;
    }
  };

  const needsReason = pending && ['suspend', 'reactivate', 'deactivate'].includes(pending.kind);
  const titles: Record<PendingAction['kind'], string> = {
    suspend: `Suspend ${u.name}?`,
    reactivate: `Reactivate ${u.name}?`,
    deactivate: `Deactivate ${u.name}?`,
    'mfa-reset': 'Reset two-factor authentication?',
    'revoke-sessions': 'Sign this user out everywhere?',
    'revoke-role': `Remove the ${pending?.kind === 'revoke-role' ? pending.roleName : ''} role?`,
  };

  return (
    <>
      <Button asChild variant="ghost" size="sm" className="mb-2 -ml-2">
        <Link to="/admin/users">
          <ArrowLeft /> Users
        </Link>
      </Button>
      <PageHeader
        title={u.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            {humanize(u.userType)} <StatusBadge status={u.status} />
            {u.lockedUntil && <Badge tone="danger">Locked until {formatDateTime(u.lockedUntil)}</Badge>}
          </span>
        }
        actions={
          <>
            {canSessions && (
              <Button variant="outline" onClick={() => setPending({ kind: 'revoke-sessions' })}>
                <LogOut /> Sign out everywhere
              </Button>
            )}
            {canManage && u.mfaEnabled && (
              <Button variant="outline" onClick={() => setPending({ kind: 'mfa-reset' })}>
                <KeyRound /> Reset 2FA
              </Button>
            )}
            {canManage && u.status === 'ACTIVE' && (
              <Button variant="destructive" onClick={() => setPending({ kind: 'suspend' })}>
                <UserX /> Suspend
              </Button>
            )}
            {canManage && u.status !== 'ACTIVE' && (
              <Button onClick={() => setPending({ kind: 'reactivate' })}>
                <UserCheck /> Reactivate
              </Button>
            )}
          </>
        }
      />
      {error && !pending && <Alert className="mb-4">{error}</Alert>}

      <div className="grid gap-6 lg:grid-cols-[1fr_1.4fr]">
        <Card>
          <CardHeader>
            <CardTitle>Account</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-3 text-sm">
              <dt className="text-muted-foreground">Email</dt>
              <dd className="break-all">{u.email ?? '—'}</dd>
              <dt className="text-muted-foreground">Mobile</dt>
              <dd>{u.mobile ? formatMobile(u.mobile) : '—'}</dd>
              <dt className="text-muted-foreground">Two-factor</dt>
              <dd>{u.mfaEnabled ? 'Enabled' : u.userType === 'ADMIN' ? 'Not set up yet' : 'Not required'}</dd>
              <dt className="text-muted-foreground">Last sign-in</dt>
              <dd>{formatDateTime(u.lastLoginAt)}</dd>
              <dt className="text-muted-foreground">Created</dt>
              <dd>{formatDateTime(u.createdAt)}</dd>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Roles</CardTitle>
            <CardDescription>
              Roles decide what this person can see and do. Changes apply on their next request.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {u.assignments.length === 0 && (
              <p className="text-sm text-muted-foreground">No roles assigned.</p>
            )}
            <ul className="divide-y rounded-lg border">
              {u.assignments.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-3 px-3 py-2">
                  <div>
                    <p className="text-sm font-medium">{a.roleName ?? humanize(a.roleCode)}</p>
                    <p className="text-xs text-muted-foreground">
                      {a.scope.type === 'PLATFORM'
                        ? 'Platform-wide'
                        : a.scope.type === 'COMPANY'
                          ? `Company ${a.scope.companyId}`
                          : `Vendor ${a.scope.vendorId}`}{' '}
                      · granted {formatDateTime(a.grantedAt)}
                    </p>
                  </div>
                  {canRoles && (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Remove ${a.roleCode}`}
                      onClick={() =>
                        setPending({
                          kind: 'revoke-role',
                          assignmentId: a.id,
                          roleName: a.roleName ?? a.roleCode,
                        })
                      }
                    >
                      <ShieldOff />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
            {canRoles && grantable.length > 0 && (
              <form
                className="flex flex-col gap-2 sm:flex-row"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!roleToGrant) return;
                  setError(null);
                  grant.mutate(
                    { roleCode: roleToGrant, scope: { type: 'PLATFORM' } },
                    {
                      onSuccess: () => setRoleToGrant(''),
                      onError: (err) => setError((err as ApiError).message),
                    },
                  );
                }}
              >
                <Select
                  aria-label="Role to add"
                  value={roleToGrant}
                  onChange={(e) => setRoleToGrant(e.target.value)}
                >
                  <option value="">Choose a role…</option>
                  {grantable.map((r) => (
                    <option key={r.code} value={r.code}>
                      {r.name}
                    </option>
                  ))}
                </Select>
                <Button type="submit" variant="outline" disabled={!roleToGrant} loading={grant.isPending}>
                  Add role
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
      </div>

      <ConfirmDialog
        open={!!pending}
        onOpenChange={(o) => {
          if (!o) {
            setPending(null);
            setError(null);
          }
        }}
        title={pending ? titles[pending.kind] : ''}
        description={
          pending?.kind === 'suspend'
            ? 'They are signed out immediately and cannot sign in until reactivated.'
            : pending?.kind === 'mfa-reset'
              ? 'They will have to set up a new authenticator app on their next sign-in.'
              : pending?.kind === 'revoke-sessions'
                ? 'All their sessions end immediately on every device.'
                : undefined
        }
        destructive={pending?.kind !== 'reactivate'}
        confirmLabel={pending ? humanize(pending.kind.replace('revoke-role', 'remove role')) : 'Confirm'}
        onConfirm={run}
      >
        {needsReason && (
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Reason (recorded in the audit log)
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} required />
          </label>
        )}
        {error && <Alert>{error}</Alert>}
      </ConfirmDialog>
    </>
  );
}
