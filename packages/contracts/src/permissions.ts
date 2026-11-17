/** Permission catalogue (API.md §2). Roles are DB-configurable bundles of these codes. */
export const PERMISSIONS = [
  // users & rbac
  'user.read',
  'user.manage',
  'role.manage',
  'session.revoke',
  // config & audit
  'config.read',
  'config.manage',
  'audit.read',
  'template.manage',
  // catalogue
  'category.manage',
  'skill.manage',
  'doctype.manage',
  'plan.manage',
  // providers
  'provider.read',
  'registration.verify',
  'registration.waive',
  'provider.suspend',
  'identity.resolve',
  'profile.self',
  'vendor.manage',
  'worker.manage',
  // documents
  'document.upload',
  'document.read',
  'document.verify',
  // companies
  'company.read',
  'company.activate',
  'company.manage',
  'company.users.manage',
  'site.manage',
  // demand
  'enquiry.create',
  'enquiry.manage',
  'quotation.manage',
  'quotation.decide',
  // jobs & allocation
  'job.read',
  'job.manage',
  'matching.run',
  'matching.override',
  'invitation.send',
  'invitation.respond',
  'allocation.propose',
  'allocation.approve',
  'assignment.read',
  'assignment.manage',
  'assignment.request_change',
  // execution
  'attendance.mark',
  'attendance.proxy',
  'attendance.review',
  'attendance.correct',
  'complaint.create',
  'complaint.manage',
  'rating.create',
  // finance
  'invoice.read',
  'invoice.manage',
  'payment.create',
  'payment.record_offline',
  'payment.verify',
  'payment.read',
  'refund.request',
  'refund.approve',
  'reconciliation.manage',
  'ledger.read',
  // reports
  'report.read',
  'report.export',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}
