import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useCallback, useMemo, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PAGE_SIZE_DEFAULT, type PageMeta } from '@bijliwala/contracts';
import { EmptyState } from '@/components/layout/page-parts';
import { Button } from '@/components/ui/button';
import {
  Card,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/primitives';

/**
 * URL-synced list state (`?page=&pageSize=&<filters>`) so admin lists are shareable and survive
 * reloads (ARCHITECTURE §8.2). Changing a filter resets to page 1.
 */
export function useListParams<F extends string>(filterKeys: readonly F[] = []) {
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number(params.get('page')) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(params.get('pageSize')) || PAGE_SIZE_DEFAULT));
  const filters = useMemo(() => {
    const out: Partial<Record<F, string>> = {};
    for (const key of filterKeys) {
      const v = params.get(key);
      if (v) out[key] = v;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, filterKeys.join(',')]);

  const setPage = useCallback(
    (next: number) =>
      setParams((prev) => {
        const p = new URLSearchParams(prev);
        p.set('page', String(next));
        return p;
      }),
    [setParams],
  );

  const setFilter = useCallback(
    (key: F, value: string | undefined) =>
      setParams((prev) => {
        const p = new URLSearchParams(prev);
        if (value) p.set(key, value);
        else p.delete(key);
        p.set('page', '1');
        return p;
      }),
    [setParams],
  );

  return { page, pageSize, filters, setPage, setFilter };
}

export interface DataTableProps<T> {
  columns: ColumnDef<T, unknown>[];
  data: T[] | undefined;
  meta: PageMeta | undefined;
  isLoading?: boolean;
  onPageChange: (page: number) => void;
  toolbar?: ReactNode;
  emptyTitle?: string;
  emptyDescription?: ReactNode;
  getRowId?: (row: T) => string;
  onRowClick?: (row: T) => void;
  /** Rendered instead of the table below `md` (stacked cards on phones). */
  renderMobileCard?: (row: T) => ReactNode;
}

/** Reusable server-paginated table for every admin/company list. */
export function DataTable<T>({
  columns,
  data,
  meta,
  isLoading,
  onPageChange,
  toolbar,
  emptyTitle = 'Nothing here yet',
  emptyDescription,
  getRowId,
  onRowClick,
  renderMobileCard,
}: DataTableProps<T>) {
  const table = useReactTable({
    data: data ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    pageCount: meta ? Math.max(1, Math.ceil(meta.total / meta.pageSize)) : 1,
    ...(getRowId ? { getRowId: (row: T) => getRowId(row) } : {}),
  });

  const totalPages = meta ? Math.max(1, Math.ceil(meta.total / meta.pageSize)) : 1;
  const from = meta && meta.total > 0 ? (meta.page - 1) * meta.pageSize + 1 : 0;
  const to = meta ? Math.min(meta.page * meta.pageSize, meta.total) : 0;
  const rows = table.getRowModel().rows;

  return (
    <Card className="overflow-hidden">
      {toolbar && (
        <div className="flex flex-col gap-3 border-b p-4 sm:flex-row sm:items-center">{toolbar}</div>
      )}

      {isLoading ? (
        <div className="space-y-2 p-4" data-testid="table-loading">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="p-4">
          <EmptyState title={emptyTitle} description={emptyDescription} className="border-0" />
        </div>
      ) : (
        <>
          {renderMobileCard && (
            <ul className="divide-y md:hidden">
              {rows.map((row) => (
                <li
                  key={row.id}
                  className="p-4"
                  onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                >
                  {renderMobileCard(row.original)}
                </li>
              ))}
            </ul>
          )}
          <div className={renderMobileCard ? 'hidden md:block' : undefined}>
            <Table>
              <TableHeader>
                {table.getHeaderGroups().map((hg) => (
                  <TableRow key={hg.id} className="hover:bg-transparent">
                    {hg.headers.map((header) => (
                      <TableHead key={header.id}>
                        {header.isPlaceholder
                          ? null
                          : flexRender(header.column.columnDef.header, header.getContext())}
                      </TableHead>
                    ))}
                  </TableRow>
                ))}
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow
                    key={row.id}
                    className={onRowClick ? 'cursor-pointer' : undefined}
                    onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id}>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}

      {meta && meta.total > 0 && (
        <div className="flex items-center justify-between gap-2 border-t px-4 py-3 text-sm text-muted-foreground">
          <span className="tabular">
            {from}–{to} of {meta.total}
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="icon"
              aria-label="Previous page"
              disabled={meta.page <= 1}
              onClick={() => onPageChange(meta.page - 1)}
            >
              <ChevronLeft />
            </Button>
            <span className="tabular">
              Page {meta.page} of {totalPages}
            </span>
            <Button
              variant="outline"
              size="icon"
              aria-label="Next page"
              disabled={meta.page >= totalPages}
              onClick={() => onPageChange(meta.page + 1)}
            >
              <ChevronRight />
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
