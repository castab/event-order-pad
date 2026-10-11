import PDFDocument from 'pdfkit';
import { formatTicket } from '../src/lib/tickets/format';
import type { OrderTicket } from '../src/lib/tickets/ticket';

const mm = 72 / 25.4;
export function receiptLayout(ticket: OrderTicket, reprint: boolean) {
  const lines = formatTicket(ticket, reprint, 36);
  const sizes = lines.map((line) =>
    line.role === 'reference'
      ? 16
      : line.role === 'heading' || line.role === 'reprint'
        ? 13
        : 9,
  );
  const heightMm = Math.ceil(
    (12 + sizes.reduce((sum, size) => sum + size + 4, 0)) / mm,
  );
  if (heightMm > 2000)
    throw new Error('Ticket exceeds the 2000 mm receipt limit.');
  return { lines, sizes, heightMm };
}

/** Embedded local font, one receipt page, no HTML or external assets. */
export async function receiptPdf(
  ticket: OrderTicket,
  reprint: boolean,
  font: string,
  heightMm: number,
): Promise<Buffer> {
  const layout = receiptLayout(ticket, reprint);
  if (heightMm < layout.heightMm)
    throw new Error('Paper is too short for this ticket.');
  const doc = new PDFDocument({
    size: [72 * mm, heightMm * mm],
    margin: 0,
    font,
    compress: true,
    info: { Title: 'Preparation ticket' },
  });
  const chunks: Buffer[] = [];
  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  let y = 6;
  layout.lines.forEach((line, index) => {
    const size = layout.sizes[index];
    doc.fontSize(size);
    // Fit large headings/references without losing or wrapping characters.
    const width = doc.widthOfString(line.text);
    if (width > 72 * mm - 8) doc.fontSize((size * (72 * mm - 8)) / width);
    doc.text(line.text || ' ', 4, y, { lineBreak: false });
    y += size + 4;
  });
  doc.end();
  return finished;
}
