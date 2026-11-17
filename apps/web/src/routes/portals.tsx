import type { UserType } from '@skillconnect/contracts';
import {
  BarChart3,
  Bell,
  Briefcase,
  Building2,
  CalendarCheck,
  ClipboardList,
  FileSignature,
  FileText,
  Home,
  KeyRound,
  LayoutGrid,
  MessageSquareText,
  ScrollText,
  LayoutDashboard,
  Settings,
  ShieldCheck,
  UserRound,
  Users,
  Wallet,
} from 'lucide-react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/app/auth';
import { AppShell, ProviderMobileLayout, type NavItem } from '@/components/layout/shells';
import { EmptyState, PageHeader } from '@/components/layout/page-parts';
import { Skeleton } from '@/components/ui/primitives';

export const ADMIN_NAV: NavItem[] = [
  { to: '/admin', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/admin/verification', label: 'Verification', icon: ShieldCheck, permission: 'registration.verify' },
  { to: '/admin/enquiries', label: 'Enquiries', icon: ClipboardList, permission: 'enquiry.manage' },
  { to: '/admin/companies', label: 'Companies', icon: Building2, permission: 'company.read' },
  { to: '/admin/jobs', label: 'Jobs', icon: Briefcase, permission: 'job.read' },
  { to: '/admin/finance', label: 'Finance', icon: Wallet, permission: 'payment.read' },
  { to: '/admin/catalogue', label: 'Catalogue', icon: LayoutGrid, permission: 'category.manage' },
  { to: '/admin/reports', label: 'Reports', icon: BarChart3, permission: 'report.read' },
  { to: '/admin/users', label: 'Users', icon: Users, permission: 'user.read' },
  { to: '/admin/roles', label: 'Roles', icon: KeyRound, permission: 'role.manage' },
  { to: '/admin/audit', label: 'Audit log', icon: ScrollText, permission: 'audit.read' },
  {
    to: '/admin/templates',
    label: 'Message templates',
    icon: MessageSquareText,
    permission: 'template.manage',
  },
  { to: '/admin/settings', label: 'Settings', icon: Settings, permission: 'config.read' },
];

export const COMPANY_NAV: NavItem[] = [
  { to: '/company', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/company/enquiries', label: 'Enquiries', icon: ClipboardList, permission: 'enquiry.create' },
  { to: '/company/quotations', label: 'Quotations', icon: FileSignature, permission: 'quotation.decide' },
  { to: '/company/jobs', label: 'Jobs', icon: Briefcase, permission: 'job.read' },
  { to: '/company/invoices', label: 'Invoices', icon: FileText, permission: 'invoice.read' },
  { to: '/company/sites', label: 'Sites', icon: Building2 },
  { to: '/company/users', label: 'Team', icon: Users, permission: 'company.users.manage' },
];

export const PROVIDER_NAV: NavItem[] = [
  { to: '/provider', label: 'Home', icon: Home, end: true },
  { to: '/provider/onboarding', label: 'Registration', icon: UserRound },
  { to: '/provider/workers', label: 'Workers', icon: Users, permission: 'worker.manage' },
  { to: '/provider/invitations', label: 'Invitations', icon: Bell },
  { to: '/provider/assignments', label: 'Work', icon: CalendarCheck },
];

/** Portal each user type lands on after sign-in. */
export function homePathFor(userType: UserType): string {
  switch (userType) {
    case 'ADMIN':
      return '/admin';
    case 'COMPANY':
      return '/company';
    default:
      return '/provider';
  }
}

/** Route guard: anonymous users go to /login; users of another portal are redirected to their own. */
export function RequireAuth({
  allow,
  loginPath = '/login',
  children,
}: {
  allow: UserType[];
  loginPath?: string;
  children: JSX.Element;
}) {
  const { status, user } = useAuth();
  const location = useLocation();
  if (status === 'loading') {
    return (
      <div className="mx-auto max-w-3xl space-y-3 p-8" aria-busy>
        <Skeleton className="h-8 w-1/3" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (status === 'anonymous' || !user)
    return <Navigate to={loginPath} replace state={{ from: location.pathname }} />;
  if (!allow.includes(user.userType)) return <Navigate to={homePathFor(user.userType)} replace />;
  return children;
}

export function AppHomeRedirect() {
  const { status, user } = useAuth();
  if (status === 'loading') return null;
  return <Navigate to={user ? homePathFor(user.userType) : '/login'} replace />;
}

export const AdminPortal = () => (
  <RequireAuth allow={['ADMIN']} loginPath="/admin/login">
    <AppShell nav={ADMIN_NAV} title="Administration" notificationsPath="/admin/notifications" />
  </RequireAuth>
);

export const CompanyPortal = () => (
  <RequireAuth allow={['COMPANY']}>
    <AppShell nav={COMPANY_NAV} title="Company" notificationsPath="/company/notifications" />
  </RequireAuth>
);

export const ProviderPortal = () => (
  <RequireAuth allow={['PROFESSIONAL', 'VENDOR', 'VENDOR_WORKER']}>
    <ProviderMobileLayout nav={PROVIDER_NAV} notificationsPath="/provider/notifications" />
  </RequireAuth>
);

/** Placeholder content for portal sections whose modules are delivered in later phases. */
export function SectionPlaceholder({ title }: { title: string }) {
  return (
    <>
      <PageHeader title={title} />
      <EmptyState
        title="Nothing to show yet"
        description="This section will list your records once they exist."
      />
    </>
  );
}
