import { stateNameOf } from '@bijliwala/contracts';
import { MARGIN, SimplePdf } from '../../core/pdf/simple-pdf';
import type { SiteDoc } from '../companies/companies.module';
import type { QuotationDoc } from './quotations.module';

const UNIT: Record<string, string> = { HOUR: 'hour', DAY: 'day', MONTH: 'month', FIXED: 'job' };
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DUE: Record<string, string> = {
  ON_ACCEPT: 'on acceptance',
  ON_START: 'on start of work',
  ON_COMPLETION: 'on completion',
  DATE: 'on',
};

/** "Rs. 1,23,456.00" — the PDF base fonts have no rupee glyph. */
export function rupees(paise: number): string {
  return `Rs. ${new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(paise / 100)}`;
}

function time(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function pct(bp: number): string {
  return `${(bp / 100).toFixed(bp % 100 === 0 ? 0 : 2)}%`;
}

export interface QuotationPdfInput {
  q: QuotationDoc;
  companyName: string;
  companyGstin?: string;
  site: SiteDoc | undefined;
  supplier: { legalName: string; gstin: string; stateCode: string; address: string };
  skillName: (skillId: string) => string;
}

export function renderQuotationPdf({
  q,
  companyName,
  companyGstin,
  site,
  supplier,
  skillName,
}: QuotationPdfInput): Buffer {
  const pdf = new SimplePdf(`${q.quotationNo} v${q.version} · ${supplier.legalName}`);

  // Header band
  pdf.fillRect(0, 841.89 - 92, 595.28, 92, 0.12);
  pdf.text(MARGIN, 841.89 - 44, 'QUOTATION', 22, 'bold', 1);
  pdf.text(
    MARGIN,
    841.89 - 64,
    `${q.quotationNo}  ·  Version ${q.version}${q.status === 'DRAFT' ? '  ·  DRAFT' : ''}`,
    10,
    'regular',
    0.85,
  );
  pdf.textRight(595.28 - MARGIN, 841.89 - 40, supplier.legalName, 11, 'bold');
  pdf.text(595.28 - MARGIN - 220, 841.89 - 56, supplier.address.slice(0, 60), 8.5, 'regular', 0.85);
  if (supplier.gstin)
    pdf.text(595.28 - MARGIN - 220, 841.89 - 68, `GSTIN ${supplier.gstin}`, 8.5, 'regular', 0.85);
  pdf.y = 841.89 - 92 - 18;

  const addr = q.billingAddress;
  pdf.keyValues([
    ['Date', (q.sentAt ?? q.createdAt).toISOString().slice(0, 10)],
    ['Valid until', q.validUntil],
    ['Bill to', `${companyName}${companyGstin ? ` (GSTIN ${companyGstin})` : ''}`],
    [
      'Billing address',
      [addr.line1, addr.line2, addr.city, `${addr.state} ${addr.pincode}`].filter(Boolean).join(', '),
    ],
    ['Place of supply', `${stateNameOf(q.placeOfSupplyStateCode) ?? ''} (${q.placeOfSupplyStateCode})`],
    ['Work site', site ? `${site.name}, ${site.address.city}` : '-'],
    [
      'Schedule',
      `${q.schedule.startDate} to ${q.schedule.endDate}, ${q.schedule.weekdays.map((d) => DAYS[d]).join(' ')}, ` +
        `${time(q.schedule.shift.startMin)}-${time(q.schedule.shift.endMin)}`,
    ],
  ]);

  pdf.heading('Services');
  pdf.table(
    [
      { header: '#', width: 22 },
      { header: 'Description', width: 150 },
      { header: 'SAC', width: 46 },
      { header: 'Quantity', width: 86 },
      { header: 'Rate', width: 72, align: 'right' },
      { header: 'Taxable', width: 82, align: 'right' },
      { header: 'GST', width: 40, align: 'right' },
    ],
    q.lines.map((l, i) => [
      String(i + 1),
      `${l.description}${skillName(l.skillId.toHexString()) ? ` (${skillName(l.skillId.toHexString())})` : ''}`,
      l.sacCode,
      `${l.headcount} x ${l.quantity} ${UNIT[l.unit] ?? l.unit}`,
      `${rupees(l.ratePaise)}/${UNIT[l.unit] ?? l.unit}`,
      rupees(l.taxablePaise),
      pct(l.gstRateBp),
    ]),
  );

  // Totals block (right aligned)
  const right = MARGIN + pdf.width;
  const rows: Array<[string, number, boolean?]> = [['Subtotal', q.subtotalPaise]];
  if (q.discountPaise > 0) rows.push(['Discount', -q.discountPaise]);
  rows.push(['Taxable value', q.taxablePaise]);
  if (q.tax.type === 'INTRA') {
    rows.push(['CGST', q.tax.cgstPaise], ['SGST', q.tax.sgstPaise]);
  } else rows.push(['IGST', q.tax.igstPaise]);
  rows.push(['Total', q.totalPaise, true]);
  pdf.gap(8);
  for (const [label, amount, strong] of rows) {
    pdf.ensure(16);
    const font = strong ? 'bold' : 'regular';
    pdf.textRight(right - 110, pdf.y - 10, label, strong ? 11 : 9.5, font);
    pdf.textRight(
      right,
      pdf.y - 10,
      amount < 0 ? `- ${rupees(-amount)}` : rupees(amount),
      strong ? 11 : 9.5,
      font,
    );
    pdf.y -= strong ? 18 : 14;
  }

  pdf.heading('Payment terms');
  const terms: string[] = [];
  if (q.paymentTerms.advancePct > 0) terms.push(`Advance of ${q.paymentTerms.advancePct}% on acceptance.`);
  for (const m of q.paymentTerms.milestones)
    terms.push(
      `${m.label}: ${m.pct}% ${DUE[m.due] ?? ''}${m.due === 'DATE' && m.dueDate ? ` ${m.dueDate}` : ''}.`,
    );
  if (terms.length === 0) terms.push('As per the credit period agreed with Bijli Wala.');
  for (const t of terms) pdf.paragraph(`-  ${t}`, 9.5);

  if (q.terms.trim()) {
    pdf.heading('Terms and conditions');
    pdf.paragraph(q.terms, 9);
  }

  pdf.gap(14);
  pdf.paragraph(
    'This quotation is generated electronically. Accept or reject it in the Bijli Wala company portal. ' +
      'Amounts are in Indian Rupees; GST is charged as shown above.',
    8,
  );
  return pdf.toBuffer();
}
