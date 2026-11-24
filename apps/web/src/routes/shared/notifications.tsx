import { Bell, CheckCheck } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import type { NotificationPreferences } from '@bijliwala/contracts';
import { EmptyState, PageHeader } from '@/components/layout/page-parts';
import { Button } from '@/components/ui/button';
import {
  Alert,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Skeleton,
} from '@/components/ui/primitives';
import {
  useInbox,
  useMarkRead,
  usePreferences,
  useSavePreferences,
  useUnreadCount,
} from '@/features/notifications/api';
import type { ApiError } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';

/** Header bell with unread badge; links to the portal's notifications page. */
export function NotificationBell({ to }: { to: string }) {
  const unread = useUnreadCount();
  const count = unread.data ?? 0;
  return (
    <Button
      asChild
      variant="ghost"
      size="icon"
      aria-label={count ? `Notifications, ${count} unread` : 'Notifications'}
    >
      <Link to={to} className="relative">
        <Bell />
        {count > 0 && (
          <span className="absolute right-1.5 top-1.5 flex min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold leading-4 text-destructive-foreground">
            {count > 99 ? '99+' : count}
          </span>
        )}
      </Link>
    </Button>
  );
}

const CHANNEL_LABELS: Record<keyof NotificationPreferences['channels'], string> = {
  WHATSAPP: 'WhatsApp',
  SMS: 'SMS',
  EMAIL: 'Email',
};

export function NotificationsPage() {
  const navigate = useNavigate();
  const inbox = useInbox();
  const markRead = useMarkRead();
  const prefs = usePreferences();
  const savePrefs = useSavePreferences();
  const items = inbox.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <>
      <PageHeader
        title="Notifications"
        actions={
          items.some((i) => !i.readAt) && (
            <Button variant="outline" onClick={() => markRead.mutate('all')} loading={markRead.isPending}>
              <CheckCheck /> Mark all read
            </Button>
          )
        }
      />
      <div className="grid gap-6 lg:grid-cols-[1.6fr_1fr]">
        <Card className="overflow-hidden">
          {inbox.isLoading ? (
            <div className="space-y-2 p-4">
              <Skeleton className="h-14" />
              <Skeleton className="h-14" />
            </div>
          ) : items.length === 0 ? (
            <div className="p-4">
              <EmptyState
                icon={Bell}
                title="You're all caught up"
                description="Updates about your account and work will appear here."
                className="border-0"
              />
            </div>
          ) : (
            <ul className="divide-y">
              {items.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    className={cn(
                      'flex w-full gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/60',
                      !n.readAt && 'bg-accent/40',
                    )}
                    onClick={() => {
                      if (!n.readAt) markRead.mutate(n.id);
                      if (n.link) navigate(n.link);
                    }}
                  >
                    <span
                      className={cn(
                        'mt-1.5 size-2 shrink-0 rounded-full',
                        n.readAt ? 'bg-transparent' : 'bg-primary',
                      )}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold">{n.title}</span>
                      <span className="block text-sm text-muted-foreground">{n.body}</span>
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {formatDateTime(n.createdAt)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {inbox.hasNextPage && (
            <div className="border-t p-3 text-center">
              <Button
                variant="outline"
                loading={inbox.isFetchingNextPage}
                onClick={() => void inbox.fetchNextPage()}
              >
                Load more
              </Button>
            </div>
          )}
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Delivery preferences</CardTitle>
            <CardDescription>
              Security codes, assignment and payment messages are always sent.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {prefs.data &&
              (Object.keys(CHANNEL_LABELS) as Array<keyof NotificationPreferences['channels']>).map((ch) => (
                <label key={ch} className="flex items-center justify-between gap-3 text-sm">
                  {CHANNEL_LABELS[ch]}
                  <Checkbox
                    checked={prefs.data.channels[ch]}
                    disabled={savePrefs.isPending}
                    onChange={(e) =>
                      savePrefs.mutate({
                        ...prefs.data,
                        channels: { ...prefs.data.channels, [ch]: e.target.checked },
                      })
                    }
                  />
                </label>
              ))}
            {savePrefs.error && <Alert>{(savePrefs.error as ApiError).message}</Alert>}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
