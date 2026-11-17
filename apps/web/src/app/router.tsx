import { lazy, Suspense, type ReactNode } from 'react';
import { createBrowserRouter, type RouteObject } from 'react-router-dom';
import { PublicLayout, type NavItem } from '@/components/layout/shells';
import { Skeleton } from '@/components/ui/primitives';
import { BecomeProviderPage, NotFoundPage } from '@/routes/public/simple-pages';
import {
  ADMIN_NAV,
  AdminPortal,
  AppHomeRedirect,
  COMPANY_NAV,
  CompanyPortal,
  PROVIDER_NAV,
  ProviderPortal,
  SectionPlaceholder,
} from '@/routes/portals';

// Route groups are code-split (ARCHITECTURE §8.2).
const HomePage = lazy(() => import('@/routes/public/home'));
const LoginPage = lazy(() => import('@/routes/public/login'));
const AdminLoginPage = lazy(() => import('@/routes/public/admin-login'));
const ForgotPasswordPage = lazy(() =>
  import('@/routes/public/password-pages').then((m) => ({ default: m.ForgotPasswordPage })),
);
const ResetPasswordPage = lazy(() =>
  import('@/routes/public/password-pages').then((m) => ({ default: m.ResetPasswordPage })),
);
const UsersPage = lazy(() => import('@/routes/admin/users').then((m) => ({ default: m.UsersPage })));
const UserDetailPage = lazy(() =>
  import('@/routes/admin/users').then((m) => ({ default: m.UserDetailPage })),
);
const RolesPage = lazy(() => import('@/routes/admin/roles').then((m) => ({ default: m.RolesPage })));
const AuditLogPage = lazy(() => import('@/routes/admin/platform').then((m) => ({ default: m.AuditLogPage })));
const SettingsPage = lazy(() => import('@/routes/admin/platform').then((m) => ({ default: m.SettingsPage })));
const TemplatesPage = lazy(() =>
  import('@/routes/admin/platform').then((m) => ({ default: m.TemplatesPage })),
);
const VerificationPage = lazy(() =>
  import('@/routes/admin/onboarding').then((m) => ({ default: m.VerificationPage })),
);
const RegistrationReviewPage = lazy(() =>
  import('@/routes/admin/onboarding').then((m) => ({ default: m.RegistrationReviewPage })),
);
const CatalogAdminPage = lazy(() =>
  import('@/routes/admin/onboarding').then((m) => ({ default: m.CatalogAdminPage })),
);
const FinancePage = lazy(() => import('@/routes/admin/onboarding').then((m) => ({ default: m.FinancePage })));
const OnboardingPage = lazy(() =>
  import('@/routes/provider/onboarding').then((m) => ({ default: m.OnboardingPage })),
);
const ProviderHomePage = lazy(() =>
  import('@/routes/provider/pages').then((m) => ({ default: m.ProviderHomePage })),
);
const WorkersPage = lazy(() => import('@/routes/provider/pages').then((m) => ({ default: m.WorkersPage })));
const CategoryPage = lazy(() => import('@/routes/provider/pages').then((m) => ({ default: m.CategoryPage })));
const RequestQuotePage = lazy(() => import('@/routes/public/request-quote'));
const company = () => import('@/routes/company/pages');
const CompanyHomePage = lazy(() => company().then((m) => ({ default: m.CompanyHomePage })));
const SitesPage = lazy(() => company().then((m) => ({ default: m.SitesPage })));
const TeamPage = lazy(() => company().then((m) => ({ default: m.TeamPage })));
const CompanyEnquiriesPage = lazy(() => company().then((m) => ({ default: m.EnquiriesPage })));
const NewEnquiryPage = lazy(() => company().then((m) => ({ default: m.NewEnquiryPage })));
const CompanyEnquiryPage = lazy(() => company().then((m) => ({ default: m.CompanyEnquiryPage })));
const CompanyQuotationsPage = lazy(() => company().then((m) => ({ default: m.QuotationsPage })));
const CompanyQuotationPage = lazy(() => company().then((m) => ({ default: m.CompanyQuotationPage })));
const CompanyJobsPage = lazy(() => company().then((m) => ({ default: m.CompanyJobsPage })));
const CompanyJobPage = lazy(() => company().then((m) => ({ default: m.CompanyJobPage })));
const demand = () => import('@/routes/admin/demand');
const CompaniesPage = lazy(() => demand().then((m) => ({ default: m.CompaniesPage })));
const CompanyDetailPage = lazy(() => demand().then((m) => ({ default: m.CompanyDetailPage })));
const EnquiriesInboxPage = lazy(() => demand().then((m) => ({ default: m.EnquiriesInboxPage })));
const AdminEnquiryPage = lazy(() => demand().then((m) => ({ default: m.AdminEnquiryPage })));
const NewQuotationPage = lazy(() => demand().then((m) => ({ default: m.NewQuotationPage })));
const QuotationBuilderPage = lazy(() => demand().then((m) => ({ default: m.QuotationBuilderPage })));
const AdminJobsPage = lazy(() => demand().then((m) => ({ default: m.AdminJobsPage })));
const NewJobPage = lazy(() => demand().then((m) => ({ default: m.NewJobPage })));
const AdminJobPage = lazy(() => demand().then((m) => ({ default: m.AdminJobPage })));
const NotificationsPage = lazy(() =>
  import('@/routes/shared/notifications').then((m) => ({ default: m.NotificationsPage })),
);

const withSuspense = (node: ReactNode) => (
  <Suspense
    fallback={
      <div className="space-y-3 p-2" aria-busy>
        <Skeleton className="h-10 w-1/2" />
        <Skeleton className="h-64 w-full" />
      </div>
    }
  >
    {node}
  </Suspense>
);

/** Portal sections not yet delivered render a placeholder (DEVELOPMENT_PLAN Phases 3-8). */
const placeholders = (nav: NavItem[], implemented: string[]): RouteObject[] =>
  nav
    .filter((item) => !implemented.includes(item.to))
    .map((item) =>
      item.end
        ? { index: true, element: <SectionPlaceholder title={item.label} /> }
        : { path: item.to.split('/').pop(), element: <SectionPlaceholder title={item.label} /> },
    );

const notificationsRoute: RouteObject = {
  path: 'notifications',
  element: withSuspense(<NotificationsPage />),
};

export const routes: RouteObject[] = [
  {
    element: <PublicLayout />,
    children: [
      { index: true, element: withSuspense(<HomePage />) },
      { path: 'login', element: withSuspense(<LoginPage />) },
      { path: 'admin/login', element: withSuspense(<AdminLoginPage />) },
      { path: 'forgot-password', element: withSuspense(<ForgotPasswordPage />) },
      { path: 'reset-password', element: withSuspense(<ResetPasswordPage />) },
      { path: 'become-a-provider', element: <BecomeProviderPage /> },
      { path: 'request-a-quote', element: withSuspense(<RequestQuotePage />) },
      { path: 'services/:slug', element: withSuspense(<CategoryPage />) },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
  { path: 'app', element: <AppHomeRedirect /> },
  {
    path: 'admin',
    element: <AdminPortal />,
    children: [
      ...placeholders(ADMIN_NAV, [
        '/admin/users',
        '/admin/roles',
        '/admin/audit',
        '/admin/templates',
        '/admin/settings',
        '/admin/verification',
        '/admin/catalogue',
        '/admin/finance',
        '/admin/enquiries',
        '/admin/companies',
        '/admin/jobs',
      ]),
      { path: 'companies', element: withSuspense(<CompaniesPage />) },
      { path: 'companies/:id', element: withSuspense(<CompanyDetailPage />) },
      { path: 'enquiries', element: withSuspense(<EnquiriesInboxPage />) },
      { path: 'enquiries/:id', element: withSuspense(<AdminEnquiryPage />) },
      { path: 'quotations/new', element: withSuspense(<NewQuotationPage />) },
      { path: 'quotations/:id', element: withSuspense(<QuotationBuilderPage />) },
      { path: 'jobs', element: withSuspense(<AdminJobsPage />) },
      { path: 'jobs/new', element: withSuspense(<NewJobPage />) },
      { path: 'jobs/:id', element: withSuspense(<AdminJobPage />) },
      { path: 'verification', element: withSuspense(<VerificationPage />) },
      { path: 'verification/:id', element: withSuspense(<RegistrationReviewPage />) },
      { path: 'catalogue', element: withSuspense(<CatalogAdminPage />) },
      { path: 'finance', element: withSuspense(<FinancePage />) },
      { path: 'users', element: withSuspense(<UsersPage />) },
      { path: 'users/:id', element: withSuspense(<UserDetailPage />) },
      { path: 'roles', element: withSuspense(<RolesPage />) },
      { path: 'audit', element: withSuspense(<AuditLogPage />) },
      { path: 'templates', element: withSuspense(<TemplatesPage />) },
      { path: 'settings', element: withSuspense(<SettingsPage />) },
      notificationsRoute,
    ],
  },
  {
    path: 'company',
    element: <CompanyPortal />,
    children: [
      ...placeholders(COMPANY_NAV, [
        '/company',
        '/company/enquiries',
        '/company/quotations',
        '/company/jobs',
        '/company/sites',
        '/company/users',
      ]),
      { index: true, element: withSuspense(<CompanyHomePage />) },
      { path: 'enquiries', element: withSuspense(<CompanyEnquiriesPage />) },
      { path: 'enquiries/new', element: withSuspense(<NewEnquiryPage />) },
      { path: 'enquiries/:id', element: withSuspense(<CompanyEnquiryPage />) },
      { path: 'quotations', element: withSuspense(<CompanyQuotationsPage />) },
      { path: 'quotations/:id', element: withSuspense(<CompanyQuotationPage />) },
      { path: 'jobs', element: withSuspense(<CompanyJobsPage />) },
      { path: 'jobs/:id', element: withSuspense(<CompanyJobPage />) },
      { path: 'sites', element: withSuspense(<SitesPage />) },
      { path: 'users', element: withSuspense(<TeamPage />) },
      notificationsRoute,
    ],
  },
  {
    path: 'provider',
    element: <ProviderPortal />,
    children: [
      ...placeholders(PROVIDER_NAV, ['/provider', '/provider/onboarding', '/provider/workers']),
      { index: true, element: withSuspense(<ProviderHomePage />) },
      { path: 'onboarding', element: withSuspense(<OnboardingPage />) },
      { path: 'workers', element: withSuspense(<WorkersPage />) },
      notificationsRoute,
    ],
  },
];

export const createRouter = () =>
  createBrowserRouter(routes, {
    future: {
      v7_relativeSplatPath: true,
      v7_fetcherPersist: true,
      v7_normalizeFormMethod: true,
      v7_partialHydration: true,
      v7_skipActionErrorRevalidation: true,
    },
  });
