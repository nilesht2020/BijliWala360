/**
 * Minimal PDF 1.4 writer for business documents (quotations now, invoices in Phase 7).
 * Uses the standard Helvetica fonts (no embedding), A4 pages and an automatic cursor with page
 * breaks. Text is WinAnsi; characters outside Latin-1 are replaced, so callers write "Rs." for ₹.
 * Kept dependency-free on purpose (decision T-12: documents are generated server-side).
 */

const PAGE_W = 595.28;
const PAGE_H = 841.89;
export const MARGIN = 48;

type Font = 'regular' | 'bold';

export interface Column {
  header: string;
  width: number;
  align?: 'left' | 'right';
}

function escapeText(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 63;
    const c = code > 255 || (code < 32 && code !== 9) ? '?' : ch;
    out += c === '\\' || c === '(' || c === ')' ? `\\${c}` : c;
  }
  return out;
}

/** Approximate Helvetica advance width (good enough for wrapping and right alignment). */
export function textWidth(value: string, size: number, font: Font = 'regular'): number {
  let units = 0;
  for (const ch of value) {
    if ("il.,:;|!'`".includes(ch)) units += 278;
    else if ('ftrjI() '.includes(ch)) units += ch === ' ' ? 278 : 333;
    else if ('mwMW%@'.includes(ch)) units += 889;
    else if (ch >= 'A' && ch <= 'Z') units += 667;
    else if (ch >= '0' && ch <= '9') units += 556;
    else units += 556;
  }
  return (units / 1000) * size * (font === 'bold' ? 1.05 : 1);
}

export function wrapText(value: string, size: number, maxWidth: number, font: Font = 'regular'): string[] {
  const lines: string[] = [];
  for (const paragraph of value.split(/\r?\n/)) {
    let current = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = current ? `${current} ${word}` : word;
      if (textWidth(candidate, size, font) <= maxWidth || !current) current = candidate;
      else {
        lines.push(current);
        current = word;
      }
    }
    lines.push(current);
  }
  return lines;
}

export class SimplePdf {
  private readonly pages: string[][] = [];
  private ops: string[] = [];
  y = PAGE_H - MARGIN;
  readonly width = PAGE_W - 2 * MARGIN;

  constructor(private readonly footer?: string) {
    this.newPage();
  }

  newPage(): void {
    this.ops = [];
    this.pages.push(this.ops);
    this.y = PAGE_H - MARGIN;
  }

  /** Starts a new page when fewer than `height` points remain above the bottom margin. */
  ensure(height: number): void {
    if (this.y - height < MARGIN + 20) this.newPage();
  }

  text(x: number, y: number, value: string, size = 10, font: Font = 'regular', gray = 0): void {
    const f = font === 'bold' ? 'F2' : 'F1';
    this.ops.push(
      `${gray} g BT /${f} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${escapeText(value)}) Tj ET 0 g`,
    );
  }

  textRight(xRight: number, y: number, value: string, size = 10, font: Font = 'regular'): void {
    this.text(xRight - textWidth(value, size, font), y, value, size, font);
  }

  line(x1: number, y1: number, x2: number, y2: number, gray = 0.75): void {
    this.ops.push(
      `${gray} G 0.5 w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S 0 G`,
    );
  }

  fillRect(x: number, y: number, w: number, h: number, gray: number): void {
    this.ops.push(`${gray} g ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f 0 g`);
  }

  /** Writes a wrapped paragraph at the cursor and moves the cursor down. */
  paragraph(value: string, size = 10, font: Font = 'regular', indent = 0): void {
    const lh = size * 1.35;
    for (const l of wrapText(value, size, this.width - indent, font)) {
      this.ensure(lh);
      this.text(MARGIN + indent, this.y - size, l, size, font);
      this.y -= lh;
    }
  }

  gap(points: number): void {
    this.y -= points;
  }

  heading(value: string): void {
    this.ensure(30);
    this.gap(6);
    this.text(MARGIN, this.y - 11, value, 11, 'bold');
    this.y -= 16;
    this.line(MARGIN, this.y, MARGIN + this.width, this.y);
    this.gap(6);
  }

  /** Label/value pairs in two columns. */
  keyValues(rows: Array<[string, string]>, size = 9): void {
    const lh = size * 1.5;
    for (const [k, v] of rows) {
      const lines = wrapText(v, size, this.width - 130);
      this.ensure(lh * lines.length);
      this.text(MARGIN, this.y - size, k, size, 'bold', 0.3);
      lines.forEach((l, i) => this.text(MARGIN + 130, this.y - size - i * lh, l, size));
      this.y -= lh * lines.length;
    }
  }

  table(columns: Column[], rows: string[][], size = 8.5): void {
    const lh = size * 1.4;
    const drawHeader = () => {
      this.ensure(lh + 6);
      this.fillRect(MARGIN, this.y - lh - 2, this.width, lh + 4, 0.93);
      let x = MARGIN + 4;
      for (const c of columns) {
        if (c.align === 'right') this.textRight(x + c.width - 8, this.y - size - 1, c.header, size, 'bold');
        else this.text(x, this.y - size - 1, c.header, size, 'bold');
        x += c.width;
      }
      this.y -= lh + 6;
    };
    drawHeader();
    for (const row of rows) {
      const cells = row.map((v, i) => wrapText(v, size, (columns[i]?.width ?? 40) - 8));
      const height = Math.max(...cells.map((c) => c.length)) * lh + 4;
      if (this.y - height < MARGIN + 20) {
        this.newPage();
        drawHeader();
      }
      let x = MARGIN + 4;
      cells.forEach((lines, i) => {
        const c = columns[i] as Column;
        lines.forEach((l, j) => {
          const ty = this.y - size - j * lh;
          if (c.align === 'right') this.textRight(x + c.width - 8, ty, l, size);
          else this.text(x, ty, l, size);
        });
        x += c.width;
      });
      this.y -= height;
      this.line(MARGIN, this.y + 1, MARGIN + this.width, this.y + 1, 0.88);
    }
  }

  toBuffer(): Buffer {
    const total = this.pages.length;
    if (this.footer)
      this.pages.forEach((ops, i) => {
        ops.push(
          `0.45 g BT /F1 7.5 Tf ${MARGIN} 26 Td (${escapeText(this.footer as string)}) Tj ET 0 g`,
          `0.45 g BT /F1 7.5 Tf ${(PAGE_W - MARGIN - 40).toFixed(2)} 26 Td (${escapeText(`Page ${i + 1} of ${total}`)}) Tj ET 0 g`,
        );
      });

    const objects: string[] = [];
    const add = (body: string) => {
      objects.push(body);
      return objects.length;
    };
    const catalogId = add(''); // placeholder, filled below
    const pagesId = add('');
    const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const pageIds: number[] = [];
    for (const ops of this.pages) {
      const stream = ops.join('\n');
      const contentId = add(
        `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
      );
      pageIds.push(
        add(
          `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
            `/Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${contentId} 0 R >>`,
        ),
      );
    }
    objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
    objects[pagesId - 1] =
      `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

    let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
    const offsets: number[] = [];
    objects.forEach((body, i) => {
      offsets.push(Buffer.byteLength(out, 'latin1'));
      out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = Buffer.byteLength(out, 'latin1');
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
    out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
  }
}
