import { assertBalanced } from '../core/finance/ledger.service';
import { FakePaymentGateway, hmacHex } from '../core/finance/payment-gateway';
import { LocalDiskDriver } from '../core/storage/storage.service';
import { buildTree, slugify } from './catalog/catalog.module';
import { sniffMime } from './documents/documents.service';
import { eligibilityOf, professionalGaps, type ProfessionalDoc } from './professionals/professionals.module';
import { refundTaxShare, rejectionRefundAmount } from './registrations/payments.service';

describe('file signature sniffing', () => {
  it.each([
    ['%PDF-1.7 rest', 'application/pdf'],
    ['\xff\xd8\xff\xe0', 'image/jpeg'],
    ['\x89PNG\r\n\x1a\n', 'image/png'],
    ['RIFF\0\0\0\0WEBPVP8 ', 'image/webp'],
    ['MZ\x90\0', null],
    ['<html>', null],
  ])('%j -> %s', (head, mime) => {
    expect(sniffMime(Buffer.from(head, 'latin1'))).toBe(mime);
  });
});

describe('ledger', () => {
  it('accepts balanced journals and rejects everything else', () => {
    expect(() =>
      assertBalanced([
        { account: 'BANK', debitPaise: 100 },
        { account: 'REGISTRATION_REVENUE', creditPaise: 100 },
      ]),
    ).not.toThrow();
    expect(() =>
      assertBalanced([
        { account: 'BANK', debitPaise: 100 },
        { account: 'REGISTRATION_REVENUE', creditPaise: 99 },
      ]),
    ).toThrow(/does not balance/);
    expect(() =>
      assertBalanced([
        { account: 'BANK', debitPaise: 1.5 },
        { account: 'GST_OUTPUT', creditPaise: 1.5 },
      ]),
    ).toThrow();
    expect(() =>
      assertBalanced([
        { account: 'BANK', debitPaise: 5, creditPaise: 5 },
        { account: 'GST_OUTPUT', creditPaise: 0 },
      ]),
    ).toThrow();
    expect(() =>
      assertBalanced([
        { account: 'BANK', debitPaise: 0 },
        { account: 'GST_OUTPUT', creditPaise: 0 },
      ]),
    ).toThrow();
  });
});

describe('refund maths', () => {
  it('applies the plan policy', () => {
    expect(rejectionRefundAmount(118_000, { onRejection: 'FULL' })).toBe(118_000);
    expect(rejectionRefundAmount(118_000, { onRejection: 'PARTIAL', partialPct: 80 })).toBe(94_400);
    expect(rejectionRefundAmount(118_000, { onRejection: 'NONE' })).toBe(0);
  });

  it('splits GST proportionally, half-up', () => {
    expect(refundTaxShare(118_000, 18_000, 118_000)).toBe(18_000);
    expect(refundTaxShare(59_000, 18_000, 118_000)).toBe(9_000);
    expect(refundTaxShare(1, 18_000, 118_000)).toBe(0);
    expect(refundTaxShare(100, 0, 0)).toBe(0);
  });
});

describe('fake payment gateway', () => {
  it('signs checkout results and webhooks the way Razorpay does', async () => {
    const gw = new FakePaymentGateway();
    const { orderId } = await gw.createOrder({
      amountPaise: 500,
      receipt: 'r',
      notes: { domain: 'REGISTRATION', paymentId: 'p' },
    });
    const checkout = gw.checkoutResult(orderId);
    expect(
      gw.verifyCheckoutSignature(orderId, checkout.razorpay_payment_id, checkout.razorpay_signature),
    ).toBe(true);
    expect(gw.verifyCheckoutSignature(orderId, 'pay_other', checkout.razorpay_signature)).toBe(false);
    const order = gw.orders.get(orderId);
    if (!order) throw new Error('missing');
    const hook = gw.webhook('payment.captured', order, checkout.razorpay_payment_id);
    expect(gw.verifyWebhookSignature(hook.body, hook.signature)).toBe(true);
    expect(
      gw.verifyWebhookSignature(Buffer.from(hook.body.toString().replace('500', '501')), hook.signature),
    ).toBe(false);
    expect(hmacHex('k', 'a')).toHaveLength(64);
  });
});

describe('local storage driver', () => {
  const driver = new LocalDiskDriver('/tmp/sc-unit', 'secret-secret-secret-secret-secret');

  it('only accepts server-generated keys inside the storage root', () => {
    expect(() => driver.pathFor('clean/0123456789abcdef01234567')).not.toThrow();
    expect(() => driver.pathFor('../etc/passwd')).toThrow();
    expect(() => driver.pathFor('clean/../../x')).toThrow();
  });

  it('verifies signatures and expiry', () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    const sig = driver.sign('get', 'clean/0123456789abcdef01234567', exp, 'a.pdf');
    expect(driver.verify('get', 'clean/0123456789abcdef01234567', exp, sig, 'a.pdf')).toBe(true);
    expect(driver.verify('put', 'clean/0123456789abcdef01234567', exp, sig, 'a.pdf')).toBe(false);
    expect(driver.verify('get', 'clean/0123456789abcdef01234567', exp - 120, sig, 'a.pdf')).toBe(false);
  });
});

describe('catalogue helpers', () => {
  it('slugifies names and nests categories', () => {
    expect(slugify('  HVAC & Air-Conditioning ')).toBe('hvac-air-conditioning');
    const tree = buildTree([
      { id: 'a', name: 'A', slug: 'a', parentId: null, level: 1, displayOrder: 0, isActive: true },
      { id: 'b', name: 'B', slug: 'b', parentId: 'a', level: 2, displayOrder: 0, isActive: true },
      { id: 'c', name: 'C', slug: 'c', parentId: 'missing', level: 2, displayOrder: 0, isActive: true },
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.children?.map((c) => c.id)).toEqual(['b']);
  });
});

describe('professional rules', () => {
  const base = { languages: [], skills: [], status: 'DRAFT' } as unknown as ProfessionalDoc;

  it('lists every missing profile section', () => {
    expect(professionalGaps(base)).toEqual([
      'Date of birth',
      'Address',
      'Work location and travel radius',
      'Years of experience',
      'Government ID',
      'Skills',
      'Languages',
    ]);
  });

  it('is matchable only when approved with a verified skill', () => {
    const skills = [{ skillId: 'x', verification: 'VERIFIED' }] as unknown as ProfessionalDoc['skills'];
    expect(eligibilityOf({ status: 'APPROVED', skills }).isMatchable).toBe(true);
    expect(eligibilityOf({ status: 'SUSPENDED', skills }).isMatchable).toBe(false);
    expect(eligibilityOf({ status: 'APPROVED', skills: [] }).isMatchable).toBe(false);
  });
});
