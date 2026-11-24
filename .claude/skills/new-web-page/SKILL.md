---
name: new-web-page
description: Add a page or portal section to the Bijli Wala React/Vite web app (public site, company, provider, admin, or new advertiser portal) using the repo's router, nav, React Query hooks, DataTable, forms and permission patterns, with a Vitest+MSW test. Use when building or replacing any screen, including the "SectionPlaceholder" pages.
---

# New web page

The web app lives in `apps/web/src`:
- `app/router.tsx`: routes, all lazy loaded.
- `routes/portals.tsx`: `ADMIN_NAV`, `COMPANY_NAV`, `PROVIDER_NAV`, the portal shells and `homePathFor`.
- `routes/<portal>/`: the pages.
- `features/<domain>/api.ts`: React Query hooks.
- `components/` (`data-table`, `forms`, `layout`, `ui`).

## Steps
1. **API hooks:** in `features/<domain>/api.ts`, follow `features/notifications/api.ts`:
   - A query-key factory (`xKeys`).
   - `useQuery` with `api.get<T>(path)` (unwraps the `{success,data}` envelope). Use `http` when you need `meta` (pagination).
   - Mutations that invalidate the affected keys.
   - Money and allocation mutations send an `Idempotency-Key` (a UUID generated per user action and reused on retry).
   - Import request and view types from `@bijliwala/contracts`. Never redeclare them.
2. **Page component:** `routes/<portal>/<area>.tsx`, exported by name.
   - Lists: `DataTable` + `useListParams` (URL-synced page and filters), `PageHeader`, a status badge and empty states.
   - Forms: React Hook Form + `zodResolver(contractSchema)` + `FormField`. On a 422 response, call `applyServerErrors` to map `details[]` onto fields.
   - Use `useCan('perm.code')` to hide or disable actions. The server is still the authority.
   - Brand text comes from `APP_NAME` / `APP_TAGLINE` in `@bijliwala/contracts`. Never type the product name.
   - Provider and employee screens are **mobile first** (360 px). Admin screens may be dense.
3. **Route:** add `const XPage = lazy(() => import('@/routes/...').then(m => ({ default: m.XPage })))` in `router.tsx` under the right portal's children. If you are replacing a placeholder, swap out the `SectionPlaceholder` element.
4. **Nav:** add `{ to, label, icon, permission }` to the portal's `*_NAV` in `portals.tsx`, using lucide-react icons.
5. **Test:** `routes/<portal>/<area>.test.tsx`, modelled on `routes/company/demand.test.tsx`:
   - MSW (`setupServer`) handlers for the endpoints.
   - `createMemoryRouter(routes, { initialEntries: [...] })` with `AuthProvider`.
   - `tokenStore` for a signed-in user.
   - Assert the visible behaviour, and a permission-hidden action for a user without the permission.
6. **Verify:** run the `quality-gates` skill (web scope). Then use `run-app` and look at the page at desktop width and at 360 px.
