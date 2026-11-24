import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http as mswHttp, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DocumentViewerHost } from '@/components/document-viewer';
import { openPdf } from '@/features/demand/api';
import { openDocument } from '@/features/providers/api';

const base = '/api/v1';
const ok = (data: unknown) => HttpResponse.json({ data });

const server = setupServer(
  mswHttp.get(`${base}/documents/doc-pdf/download-url`, () =>
    ok({ url: '/files/a.pdf?sig=1', mime: 'application/pdf', fileName: 'aadhaar.pdf' }),
  ),
  mswHttp.get(`${base}/documents/doc-img/download-url`, () =>
    ok({ url: '/files/b.png?sig=2', mime: 'image/png', fileName: 'photo.png' }),
  ),
  mswHttp.get(`${base}/documents/missing/download-url`, () =>
    HttpResponse.json(
      { success: false, error: { code: 'NOT_FOUND', message: 'Document not found.' } },
      { status: 404 },
    ),
  ),
  mswHttp.get(`${base}/quotations/q1/pdf-url`, () => ok({ url: '/files/q1.pdf?sig=3' })),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('DocumentViewerHost', () => {
  it('shows a PDF document inside the app in a dialog', async () => {
    render(<DocumentViewerHost />);
    act(() => openDocument('doc-pdf', 'Aadhaar'));
    const dialog = await screen.findByRole('dialog');
    const frame = await screen.findByTitle('aadhaar.pdf');
    expect(frame.tagName).toBe('IFRAME');
    expect(frame).toHaveAttribute('src', '/files/a.pdf?sig=1#toolbar=0&navpanes=0');
    expect(dialog).toHaveTextContent('aadhaar.pdf');

    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('shows images as an image, not a frame', async () => {
    render(<DocumentViewerHost />);
    act(() => openDocument('doc-img'));
    const img = await screen.findByRole('img', { name: 'photo.png' });
    expect(img).toHaveAttribute('src', '/files/b.png?sig=2');
    act(() => screen.getByRole('button', { name: 'Close' }).click());
  });

  it('shows quotation PDFs using the given title', async () => {
    render(<DocumentViewerHost />);
    act(() => openPdf('/quotations/q1/pdf-url', 'QT-0001 · v1'));
    const frame = await screen.findByTitle('QT-0001 · v1');
    expect(frame).toHaveAttribute('src', '/files/q1.pdf?sig=3#toolbar=0&navpanes=0');
    act(() => screen.getByRole('button', { name: 'Close' }).click());
  });

  it('reports a file that cannot be loaded', async () => {
    render(<DocumentViewerHost />);
    act(() => openDocument('missing'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Document not found.');
    act(() => screen.getByRole('button', { name: 'Close' }).click());
  });
});
