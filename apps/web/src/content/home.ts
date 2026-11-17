/**
 * Static marketing content for the home page.
 *
 * PLACEHOLDER: every entry below is sample copy. Replace it with real delivered projects,
 * real client testimonials (with their permission) and real blog posts before going live.
 */

export type DeliveredProject = {
  title: string;
  sector: string;
  location: string;
  headcount: number;
  duration: string;
  summary: string;
  kind: 'staffing' | 'maintenance' | 'housekeeping' | 'security';
};

export const DELIVERED_PROJECTS: DeliveredProject[] = [
  {
    title: 'Plant shutdown maintenance crew',
    sector: 'Manufacturing',
    location: 'Pune',
    headcount: 42,
    duration: '3 weeks',
    summary: 'Electricians, fitters and helpers staffed for an annual shutdown, finished a day early.',
    kind: 'maintenance',
  },
  {
    title: 'Office campus housekeeping',
    sector: 'IT park',
    location: 'Bengaluru',
    headcount: 28,
    duration: 'Ongoing',
    summary: 'Daily housekeeping across three towers with shift-wise attendance on the dashboard.',
    kind: 'housekeeping',
  },
  {
    title: 'Warehouse security rollout',
    sector: 'Logistics',
    location: 'Gurugram',
    headcount: 16,
    duration: '6 months',
    summary: 'Verified guards deployed 24x7 across two warehouses within ten days of the order.',
    kind: 'security',
  },
];

export type Testimonial = {
  quote: string;
  name: string;
  role: string;
  rating: number;
};

export const TESTIMONIALS: Testimonial[] = [
  {
    quote:
      'We needed twenty technicians at short notice. Every one arrived verified and on time, and invoicing matched attendance exactly.',
    name: 'Facilities Head',
    role: 'Manufacturing plant',
    rating: 5,
  },
  {
    quote: 'Having attendance, invoices and replacements in one place saved my team hours every week.',
    name: 'Admin Manager',
    role: 'Corporate office',
    rating: 5,
  },
  {
    quote: 'The quotation was clear up front and there were no surprises at month end.',
    name: 'Operations Lead',
    role: 'Logistics company',
    rating: 4,
  },
];

export type BlogPost = {
  title: string;
  excerpt: string;
  category: string;
  date: string;
  readMinutes: number;
};

export const BLOG_POSTS: BlogPost[] = [
  {
    title: 'How to plan staffing for a plant shutdown',
    excerpt: 'A checklist for headcount, skills and safety briefings so your shutdown runs to schedule.',
    category: 'Guides',
    date: '2026-10-28',
    readMinutes: 6,
  },
  {
    title: 'What verification should a contract worker have?',
    excerpt: 'Identity, documents, background checks and skill proof: what to ask for and why.',
    category: 'Compliance',
    date: '2026-10-12',
    readMinutes: 4,
  },
  {
    title: 'Individual professionals or vendors: which fits your site?',
    excerpt: 'When to hire specialists directly and when a vendor team is the better choice.',
    category: 'Hiring',
    date: '2026-09-30',
    readMinutes: 5,
  },
];
