import { z } from 'zod';
import { COMPLAINT_SEVERITIES, NOTIFICATION_CHANNELS, OFFLINE_METHODS } from './enums';

/**
 * Typed registry of business configuration (SRS FR-CFG-01, ARCHITECTURE §6.9).
 * Every key has a schema, a default and a group used to render the admin settings page.
 * Nothing in this list may be hard-coded elsewhere in the code base.
 */
const def = <S extends z.ZodTypeAny>(
  group: string,
  description: string,
  schema: S,
  defaultValue: z.infer<S>,
) => ({
  group,
  description,
  schema,
  defaultValue,
});

const matchingWeightsSchema = z
  .object({
    skill: z.number().min(0).max(1),
    distance: z.number().min(0).max(1),
    experience: z.number().min(0).max(1),
    rating: z.number().min(0).max(1),
    reliability: z.number().min(0).max(1),
    companyHistory: z.number().min(0).max(1),
    workload: z.number().min(0).max(1),
  })
  .refine((w) => Math.abs(Object.values(w).reduce((a, b) => a + b, 0) - 1) < 1e-6, 'Weights must sum to 1');

export const BUSINESS_CONFIG = {
  'otp.ttlSeconds': def('Authentication', 'OTP validity in seconds', z.number().int().min(60).max(900), 300),
  'otp.maxAttempts': def(
    'Authentication',
    'Maximum verification attempts per OTP',
    z.number().int().min(1).max(10),
    5,
  ),
  'otp.resendCooldownSeconds': def(
    'Authentication',
    'Minimum seconds between OTP sends',
    z.number().int().min(10).max(300),
    30,
  ),
  'otp.maxSendsPerWindow': def(
    'Authentication',
    'OTP sends allowed per number per window',
    z.number().int().min(1).max(20),
    3,
  ),
  'otp.sendWindowMinutes': def(
    'Authentication',
    'Window for OTP send limit (minutes)',
    z.number().int().min(1).max(1440),
    15,
  ),
  'auth.maxFailedLogins': def(
    'Authentication',
    'Failed logins before temporary lockout',
    z.number().int().min(3).max(20),
    5,
  ),
  'auth.lockoutMinutes': def(
    'Authentication',
    'Lockout duration (minutes)',
    z.number().int().min(1).max(1440),
    15,
  ),

  'invitation.responseWindowHours': def(
    'Allocation',
    'Default invitation response deadline (hours)',
    z.number().int().min(1).max(168),
    24,
  ),
  'allocation.requireSeparateApprover': def(
    'Allocation',
    'Proposal creator may not approve own proposal',
    z.boolean(),
    true,
  ),
  'matching.weights': def('Allocation', 'Matching score weights (must sum to 1)', matchingWeightsSchema, {
    skill: 0.25,
    distance: 0.2,
    experience: 0.15,
    rating: 0.15,
    reliability: 0.15,
    companyHistory: 0.05,
    workload: 0.05,
  }),
  'matching.maxRadiusKm': def(
    'Allocation',
    'Hard upper bound for matching radius (km)',
    z.number().min(1).max(500),
    50,
  ),
  'matching.overridableRules': def(
    'Allocation',
    'Hard-filter rules that may be overridden with justification',
    z.array(z.enum(['DISTANCE', 'EXPERIENCE', 'CATEGORY'])),
    ['DISTANCE'],
  ),

  'tax.supplier': def(
    'Tax & billing',
    'Supplier details printed on quotations and invoices; the state code decides CGST+SGST or IGST',
    z.object({
      legalName: z.string().min(2).max(150),
      gstin: z
        .string()
        .regex(/^(\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z])?$/, 'Enter a valid GSTIN or leave it empty'),
      stateCode: z.string().regex(/^\d{2}$/),
      address: z.string().min(2).max(300),
    }),
    { legalName: 'Bijli Wala Services Pvt Ltd', gstin: '', stateCode: '27', address: 'Pune, Maharashtra' },
  ),
  'tax.defaultGstRateBp': def(
    'Tax & billing',
    'Default GST rate for service lines (basis points, 1800 = 18%)',
    z.number().int().min(0).max(2800),
    1800,
  ),
  'tax.defaultSacCode': def(
    'Tax & billing',
    'Default SAC code for manpower services',
    z.string().regex(/^\d{4,8}$/),
    '998519',
  ),
  'quotation.defaultValidityDays': def(
    'Demand',
    'Days a new quotation stays valid',
    z.number().int().min(1).max(90),
    15,
  ),
  'quotation.prefix': def(
    'Demand',
    'Quotation number prefix',
    z
      .string()
      .min(1)
      .max(10)
      .regex(/^[A-Z0-9-]+$/),
    'QT',
  ),
  'enquiry.prefix': def(
    'Demand',
    'Enquiry number prefix',
    z
      .string()
      .min(1)
      .max(10)
      .regex(/^[A-Z0-9-]+$/),
    'ENQ',
  ),
  'job.prefix': def(
    'Demand',
    'Job number prefix',
    z
      .string()
      .min(1)
      .max(10)
      .regex(/^[A-Z0-9-]+$/),
    'JOB',
  ),

  'attendance.geofenceMeters': def(
    'Attendance',
    'Default geofence radius around a site (m)',
    z.number().int().min(25).max(5000),
    200,
  ),
  'attendance.noShowGraceMinutes': def(
    'Attendance',
    'Minutes after shift start before a no-show alert',
    z.number().int().min(5).max(240),
    30,
  ),

  'complaint.slaHours': def(
    'Complaints',
    'Resolution SLA per severity (hours)',
    z.record(z.enum(COMPLAINT_SEVERITIES), z.number().int().min(1).max(720)),
    { LOW: 120, MEDIUM: 72, HIGH: 24, CRITICAL: 4 },
  ),

  'payment.offlineMethodsEnabled': def(
    'Finance',
    'Offline payment methods accepted',
    z.array(z.enum(OFFLINE_METHODS)).min(1),
    ['BANK_TRANSFER', 'NEFT', 'RTGS', 'IMPS', 'CHEQUE', 'UPI_DIRECT', 'OTHER'],
  ),
  'payment.stuckAfterMinutes': def(
    'Finance',
    'Minutes before an unconfirmed online payment is polled',
    z.number().int().min(5).max(1440),
    20,
  ),
  'refund.secondApprovalThresholdPaise': def(
    'Finance',
    'Refunds above this amount need a second approver (paise)',
    z.number().int().min(0),
    1_000_000,
  ),
  'invoice.prefix': def(
    'Finance',
    'Invoice number prefix',
    z
      .string()
      .min(1)
      .max(10)
      .regex(/^[A-Z0-9-]+$/),
    'SC',
  ),
  'creditNote.prefix': def(
    'Finance',
    'Credit-note number prefix',
    z
      .string()
      .min(1)
      .max(10)
      .regex(/^[A-Z0-9-]+$/),
    'SCCN',
  ),

  'notification.channelPriority': def(
    'Notifications',
    'Channel fallback order for transactional messages',
    z.array(z.enum(NOTIFICATION_CHANNELS)).min(1),
    ['WHATSAPP', 'SMS', 'IN_APP'],
  ),
  'notification.quietHours': def(
    'Notifications',
    'Quiet hours (site-local minutes) for non-urgent messages',
    z.object({
      enabled: z.boolean(),
      startMin: z.number().int().min(0).max(1439),
      endMin: z.number().int().min(0).max(1439),
    }),
    { enabled: true, startMin: 21 * 60, endMin: 8 * 60 },
  ),

  'documents.downloadUrlTtlSeconds': def(
    'Documents',
    'Presigned download URL validity (s)',
    z.number().int().min(15).max(600),
    60,
  ),
  'documents.uploadUrlTtlSeconds': def(
    'Documents',
    'Presigned upload URL validity (s)',
    z.number().int().min(60).max(3600),
    300,
  ),
} as const;

export type BusinessConfigKey = keyof typeof BUSINESS_CONFIG;
export type BusinessConfigValue<K extends BusinessConfigKey> = z.infer<(typeof BUSINESS_CONFIG)[K]['schema']>;
export type MatchingWeights = BusinessConfigValue<'matching.weights'>;

export const BUSINESS_CONFIG_KEYS = Object.keys(BUSINESS_CONFIG) as BusinessConfigKey[];

export function isBusinessConfigKey(key: string): key is BusinessConfigKey {
  return Object.prototype.hasOwnProperty.call(BUSINESS_CONFIG, key);
}

export function parseBusinessConfigValue<K extends BusinessConfigKey>(
  key: K,
  value: unknown,
): BusinessConfigValue<K> {
  return BUSINESS_CONFIG[key].schema.parse(value) as BusinessConfigValue<K>;
}
