import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { DataTable } from '@/components/data-table/data-table';
import { FileUpload, type FileUploadApi } from '@/components/forms/file-upload';
import { MoneyInput, OtpInput, PhoneInput } from '@/components/forms/inputs';
import { StatusBadge } from '@/components/layout/page-parts';

function OtpHarness({ onComplete }: { onComplete: (v: string) => void }) {
  const [value, setValue] = useState('');
  return <OtpInput value={value} onChange={setValue} onComplete={onComplete} />;
}

describe('OtpInput', () => {
  it('advances focus while typing and reports completion', async () => {
    const onComplete = vi.fn();
    render(<OtpHarness onComplete={onComplete} />);
    await userEvent.click(screen.getByLabelText('Digit 1'));
    await userEvent.keyboard('482913');
    expect(onComplete).toHaveBeenCalledWith('482913');
    expect(screen.getByLabelText('Digit 6')).toHaveValue('3');
  });

  it('accepts a pasted code and ignores non-digits', async () => {
    const onComplete = vi.fn();
    render(<OtpHarness onComplete={onComplete} />);
    await userEvent.click(screen.getByLabelText('Digit 1'));
    await userEvent.paste('12-34 56');
    expect(onComplete).toHaveBeenCalledWith('123456');
  });

  it('typing into a later box appends instead of leaving gaps', async () => {
    const onComplete = vi.fn();
    render(<OtpHarness onComplete={onComplete} />);
    await userEvent.click(screen.getByLabelText('Digit 4'));
    await userEvent.keyboard('7');
    expect(screen.getByLabelText('Digit 1')).toHaveValue('7');
    expect(screen.getByLabelText('Digit 4')).toHaveValue('');
  });

  it('backspace clears the previous digit', async () => {
    const onComplete = vi.fn();
    render(<OtpHarness onComplete={onComplete} />);
    await userEvent.click(screen.getByLabelText('Digit 1'));
    await userEvent.keyboard('12{Backspace}{Backspace}');
    expect(screen.getByLabelText('Digit 1')).toHaveValue('');
  });
});

describe('MoneyInput', () => {
  it('emits integer paise and normalises on blur', async () => {
    const onChange = vi.fn();
    render(<MoneyInput value={null} onChange={onChange} aria-describedby="x" />);
    const input = screen.getByRole('textbox');
    await userEvent.type(input, '1,250.5');
    expect(onChange).toHaveBeenLastCalledWith(125050);
    await userEvent.tab();
    expect(input).toHaveValue('1250.50');
  });

  it('ignores letters', async () => {
    const onChange = vi.fn();
    render(<MoneyInput value={null} onChange={onChange} />);
    await userEvent.type(screen.getByRole('textbox'), 'abc');
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('PhoneInput', () => {
  it('emits E.164 for Indian mobiles', async () => {
    const onChange = vi.fn();
    function Harness() {
      const [v, setV] = useState('');
      return (
        <PhoneInput
          value={v}
          onChange={(next) => {
            setV(next);
            onChange(next);
          }}
        />
      );
    }
    render(<Harness />);
    await userEvent.type(screen.getByRole('textbox'), '98123 45678');
    expect(onChange).toHaveBeenLastCalledWith('+919812345678');
  });
});

describe('StatusBadge', () => {
  it('renders a humanised label with a tone', () => {
    render(<StatusBadge status="PENDING_APPROVAL" />);
    const badge = screen.getByText('Pending approval');
    expect(badge).toHaveAttribute('data-status', 'PENDING_APPROVAL');
    expect(badge.className).toContain('text-warning');
  });
});

describe('FileUpload', () => {
  const file = (type = 'application/pdf', size = 1024) =>
    new File([new Uint8Array(size)], 'pan.pdf', { type });

  it('runs intent -> PUT -> complete and reports the document id', async () => {
    const calls: string[] = [];
    const api: FileUploadApi = {
      requestIntent: vi.fn(async () => {
        calls.push('intent');
        return { documentId: 'doc-1', uploadUrl: 'https://storage.test/x', headers: {} };
      }),
      putFile: vi.fn(async () => {
        calls.push('put');
      }),
      complete: vi.fn(async () => {
        calls.push('complete');
      }),
    };
    const onUploaded = vi.fn();
    render(
      <FileUpload accept={['application/pdf']} maxSizeBytes={5_000_000} api={api} onUploaded={onUploaded} />,
    );
    await userEvent.upload(screen.getByTestId('file-input'), file());
    await waitFor(() => expect(onUploaded).toHaveBeenCalledWith('doc-1', expect.any(File)));
    expect(calls).toEqual(['intent', 'put', 'complete']);
    expect(screen.getByText('pan.pdf uploaded')).toBeInTheDocument();
  });

  it('rejects oversized files before calling the API', async () => {
    const api: FileUploadApi = { requestIntent: vi.fn(), complete: vi.fn() };
    render(<FileUpload accept={['application/pdf']} maxSizeBytes={100} api={api} onUploaded={vi.fn()} />);
    await userEvent.upload(screen.getByTestId('file-input'), file('application/pdf', 1000));
    expect(await screen.findByText(/File is too large/)).toBeInTheDocument();
    expect(api.requestIntent).not.toHaveBeenCalled();
  });

  it('shows the server error when the upload fails', async () => {
    const api: FileUploadApi = {
      requestIntent: vi.fn(async () => {
        throw new Error('This file type is not allowed for PAN.');
      }),
      complete: vi.fn(),
    };
    render(
      <FileUpload accept={['application/pdf']} maxSizeBytes={5_000_000} api={api} onUploaded={vi.fn()} />,
    );
    await userEvent.upload(screen.getByTestId('file-input'), file());
    expect(await screen.findByText('This file type is not allowed for PAN.')).toBeInTheDocument();
  });
});

describe('DataTable', () => {
  const columns = [{ accessorKey: 'name', header: 'Name' }];

  it('renders rows and paginates', async () => {
    const onPageChange = vi.fn();
    render(
      <MemoryRouter>
        <DataTable
          columns={columns}
          data={[{ name: 'Alpha' }, { name: 'Beta' }]}
          meta={{ page: 1, pageSize: 2, total: 5 }}
          onPageChange={onPageChange}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('1–2 of 5')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(onPageChange).toHaveBeenCalledWith(2);
  });

  it('shows the empty state and loading skeleton', () => {
    const { rerender } = render(
      <MemoryRouter>
        <DataTable
          columns={columns}
          data={[]}
          meta={{ page: 1, pageSize: 20, total: 0 }}
          onPageChange={vi.fn()}
          emptyTitle="No jobs"
        />
      </MemoryRouter>,
    );
    expect(screen.getByText('No jobs')).toBeInTheDocument();
    rerender(
      <MemoryRouter>
        <DataTable columns={columns} data={undefined} meta={undefined} isLoading onPageChange={vi.fn()} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('table-loading')).toBeInTheDocument();
  });
});
