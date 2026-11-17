import type { LucideIcon } from 'lucide-react';
import { LogOut, Menu, X } from 'lucide-react';
import type { Permission } from '@skillconnect/contracts';
import { useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '@/app/auth';
import { NotificationBell } from '@/routes/shared/notifications';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
  /** Hide the entry unless the user holds this permission (the API enforces it anyway). */
  permission?: Permission;
}

function useVisibleNav(items: NavItem[]): NavItem[] {
  const { can } = useAuth();
  return items.filter((i) => !i.permission || can(i.permission));
}

export function Logo({ className }: { className?: string }) {
  return (
    <Link
      to="/"
      className={cn('flex items-center gap-2 font-bold tracking-tight', className)}
      aria-label="SkillConnect home"
    >
      <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-sm text-primary-foreground">
        S
      </span>
      <span className="text-lg">SkillConnect</span>
    </Link>
  );
}

/** Public marketing layout. */
export function PublicLayout() {
  const { status } = useAuth();
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-40 border-b bg-background/90 backdrop-blur">
        <div className="container flex h-16 items-center justify-between gap-4">
          <Logo />
          <nav className="flex items-center gap-2">
            <Button asChild variant="ghost" className="hidden md:inline-flex">
              <Link to="/request-a-quote">Hire Us</Link>
            </Button>
            <Button asChild variant="ghost" className="hidden sm:inline-flex">
              <Link to="/become-a-provider">Register</Link>
            </Button>
            {status === 'authenticated' ? (
              <Button asChild>
                <Link to="/app">Dashboard</Link>
              </Button>
            ) : (
              <Button asChild>
                <Link to="/login">Sign in</Link>
              </Button>
            )}
          </nav>
        </div>
      </header>
      <main className="flex-1">
        <Outlet />
      </main>
      <footer className="border-t bg-muted/50">
        <div className="container flex flex-col gap-2 py-8 text-sm text-muted-foreground sm:flex-row sm:justify-between">
          <span>© {new Date().getFullYear()} SkillConnect</span>
          <span>Verified professionals and vendors for businesses</span>
        </div>
      </footer>
    </div>
  );
}

function SideNav({ items: all, onNavigate }: { items: NavItem[]; onNavigate?: () => void }) {
  const items = useVisibleNav(all);
  return (
    <nav className="flex flex-col gap-1" aria-label="Main">
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          onClick={onNavigate}
          className={({ isActive }) =>
            cn(
              'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
              isActive && 'bg-accent text-accent-foreground hover:bg-accent',
            )
          }
        >
          <item.icon className="size-4" aria-hidden />
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}

/**
 * Authenticated shell for company and admin portals: collapsible sidebar on small screens,
 * persistent sidebar from `lg` (ARCHITECTURE §8.2).
 */
export function AppShell({
  nav,
  title,
  notificationsPath,
  children,
}: {
  nav: NavItem[];
  title: string;
  notificationsPath: string;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const { user, signOut } = useAuth();

  return (
    <div className="min-h-dvh bg-muted/40">
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r bg-background p-4 transition-transform lg:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="mb-6 flex items-center justify-between">
          <Logo />
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            onClick={() => setOpen(false)}
            aria-label="Close menu"
          >
            <X />
          </Button>
        </div>
        <p className="mb-2 px-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </p>
        <SideNav items={nav} onNavigate={() => setOpen(false)} />
      </aside>
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/30 lg:hidden"
          onClick={() => setOpen(false)}
          aria-hidden
        />
      )}

      <div className="lg:pl-64">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b bg-background/90 px-4 backdrop-blur sm:px-6">
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            onClick={() => setOpen(true)}
            aria-label="Open menu"
          >
            <Menu />
          </Button>
          <div className="flex-1" />
          <NotificationBell to={notificationsPath} />
          {user && <span className="hidden text-sm font-medium sm:inline">{user.name}</span>}
          <Button variant="ghost" size="icon" aria-label="Sign out" onClick={() => void signOut()}>
            <LogOut />
          </Button>
        </header>
        <main className="mx-auto w-full max-w-7xl p-4 sm:p-6 lg:p-8">{children ?? <Outlet />}</main>
      </div>
    </div>
  );
}

/** Mobile-first provider layout with bottom navigation under 768px (ARCHITECTURE §8.2). */
export function ProviderMobileLayout({
  nav,
  notificationsPath,
}: {
  nav: NavItem[];
  notificationsPath: string;
}) {
  const { signOut } = useAuth();
  const items = useVisibleNav(nav);
  return (
    <div className="min-h-dvh bg-muted/40 pb-20 md:pb-0">
      <header className="sticky top-0 z-30 border-b bg-background/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4">
          <Logo />
          <nav className="hidden gap-1 md:flex">
            {items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cn(
                    'rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted',
                    isActive && 'text-primary',
                  )
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="flex items-center gap-1">
            <NotificationBell to={notificationsPath} />
            <Button variant="ghost" size="icon" aria-label="Sign out" onClick={() => void signOut()}>
              <LogOut />
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl p-4 sm:p-6">
        <Outlet />
      </main>
      <nav
        className="fixed inset-x-0 bottom-0 z-30 grid border-t bg-background md:hidden"
        style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}
        aria-label="Provider"
      >
        {items.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              cn(
                'flex flex-col items-center gap-1 py-2 text-[11px] font-medium text-muted-foreground',
                isActive && 'text-primary',
              )
            }
          >
            <item.icon className="size-5" aria-hidden />
            {item.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
