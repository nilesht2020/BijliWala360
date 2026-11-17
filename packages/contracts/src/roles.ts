import type { ScopeType } from './enums';
import { PERMISSIONS, type Permission } from './permissions';

export interface SystemRoleSeed {
  code: string;
  name: string;
  scopeType: ScopeType;
  permissions: readonly Permission[];
}

const ALL: readonly Permission[] = PERMISSIONS;

/** Seeded, non-deletable system roles (API.md §2). Permissions remain editable by SUPER_ADMIN. */
export const SYSTEM_ROLES: readonly SystemRoleSeed[] = [
  { code: 'SUPER_ADMIN', name: 'Super Admin', scopeType: 'PLATFORM', permissions: ALL },
  {
    code: 'OPS_ADMIN',
    name: 'Operations Admin',
    scopeType: 'PLATFORM',
    permissions: [
      'company.read',
      'provider.read',
      'enquiry.manage',
      'quotation.manage',
      'job.read',
      'job.manage',
      'matching.run',
      'matching.override',
      'invitation.send',
      'allocation.propose',
      'assignment.read',
      'assignment.manage',
      'attendance.correct',
      'document.read',
      'complaint.manage',
      'report.read',
    ],
  },
  {
    code: 'ALLOCATION_APPROVER',
    name: 'Allocation Approver',
    scopeType: 'PLATFORM',
    permissions: ['job.read', 'provider.read', 'allocation.approve', 'assignment.read', 'document.read'],
  },
  {
    code: 'VERIFICATION_OFFICER',
    name: 'Verification Officer',
    scopeType: 'PLATFORM',
    permissions: [
      'provider.read',
      'registration.verify',
      'document.read',
      'document.verify',
      'identity.resolve',
      'company.read',
    ],
  },
  {
    code: 'FINANCE_ADMIN',
    name: 'Finance Admin',
    scopeType: 'PLATFORM',
    permissions: [
      'company.read',
      'provider.read',
      'invoice.read',
      'invoice.manage',
      'payment.read',
      'payment.record_offline',
      'payment.verify',
      'refund.request',
      'reconciliation.manage',
      'ledger.read',
      'document.read',
      'report.read',
      'report.export',
    ],
  },
  {
    code: 'FINANCE_APPROVER',
    name: 'Finance Approver',
    scopeType: 'PLATFORM',
    permissions: ['payment.read', 'refund.approve', 'ledger.read', 'invoice.read'],
  },
  {
    code: 'SUPPORT_AGENT',
    name: 'Support Agent',
    scopeType: 'PLATFORM',
    permissions: [
      'complaint.manage',
      'job.read',
      'assignment.read',
      'company.read',
      'provider.read',
      'payment.read',
    ],
  },
  {
    code: 'COMPANY_ADMIN',
    name: 'Company Admin',
    scopeType: 'COMPANY',
    permissions: [
      'company.manage',
      'company.users.manage',
      'site.manage',
      'enquiry.create',
      'quotation.decide',
      'job.read',
      'assignment.read',
      'attendance.review',
      'complaint.create',
      'rating.create',
      'invoice.read',
      'payment.create',
      'payment.record_offline',
      'payment.read',
      'document.upload',
      'document.read',
    ],
  },
  {
    code: 'COMPANY_USER',
    name: 'Company User',
    scopeType: 'COMPANY',
    permissions: [
      'enquiry.create',
      'job.read',
      'assignment.read',
      'attendance.review',
      'complaint.create',
      'rating.create',
      'document.upload',
      'document.read',
    ],
  },
  {
    code: 'PROFESSIONAL',
    name: 'Individual Professional',
    scopeType: 'PLATFORM',
    permissions: [
      'profile.self',
      'document.upload',
      'document.read',
      'invitation.respond',
      'assignment.read',
      'assignment.request_change',
      'attendance.mark',
      'complaint.create',
    ],
  },
  {
    code: 'VENDOR_ADMIN',
    name: 'Vendor Admin',
    scopeType: 'VENDOR',
    permissions: [
      'vendor.manage',
      'worker.manage',
      'document.upload',
      'document.read',
      'invitation.respond',
      'assignment.read',
      'assignment.request_change',
      'attendance.proxy',
      'complaint.create',
    ],
  },
  {
    code: 'VENDOR_WORKER',
    name: 'Vendor Worker',
    scopeType: 'VENDOR',
    permissions: ['assignment.read', 'attendance.mark'],
  },
];
