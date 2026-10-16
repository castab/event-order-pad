import PDFDocument from 'pdfkit';
import {
  formatTicket,
  prepTicketLayout,
  pixelsPerMm,
} from '../src/lib/tickets/format';
import { parseTicket, type OrderTicket } from '../src/lib/tickets/ticket';
import { formatAccessCode } from '../src/lib/auth/model';

const mm = 72 / 25.4;
const px = mm / pixelsPerMm;
export function receiptLayout(ticket: OrderTicket, reprint: boolean) {
  const valid = parseTicket(ticket);
  return {
    ...prepTicketLayout(valid, reprint),
    lines: formatTicket(valid, reprint, 36),
  };
}

/** Embedded configured font, one receipt page, and shared HTML/PDF geometry. */
export async function receiptPdf(
  ticket: OrderTicket,
  reprint: boolean,
  font: string,
  heightMm: number,
): Promise<Buffer> {
  const layout = receiptLayout(ticket, reprint);
  if (!Number.isFinite(heightMm) || heightMm < layout.heightMm)
    throw new Error('Paper is too short for this ticket.');
  const doc = new PDFDocument({
    size: [72 * mm, heightMm * mm],
    margin: 0,
    font,
    compress: true,
    info: { Title: 'Prep ticket' },
  });
  const chunks: Buffer[] = [];
  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  for (const node of layout.nodes) {
    doc.save();
    if (node.kind === 'box') {
      if (!node.width)
        doc
          .moveTo(node.x * px, node.y * px)
          .lineTo(node.x * px, (node.y + node.height) * px)
          .lineWidth(node.stroke * px)
          .stroke('black');
      else {
        doc.rect(node.x * px, node.y * px, node.width * px, node.height * px);
        if (node.filled) doc.fill('black');
        else doc.lineWidth(node.stroke * px).stroke('black');
      }
    } else if (node.kind === 'rule') {
      if (node.dashed) doc.dash(8 * px, { space: 5 * px });
      doc
        .moveTo(node.x * px, node.y * px)
        .lineTo((node.x + node.width) * px, node.y * px)
        .lineWidth(node.stroke * px)
        .stroke('black');
    } else {
      doc.fontSize(node.size * px);
      const actualWidth = doc.widthOfString(node.text);
      if (actualWidth > node.width * px)
        doc.fontSize((node.size * px * node.width * px) / actualWidth);
      doc.fillColor(node.inverse ? 'white' : 'black');
      doc.strokeColor(node.inverse ? 'white' : 'black').lineWidth(0.5 * px);
      const width = doc.widthOfString(node.text);
      const x =
        node.x * px +
        (node.align === 'center'
          ? (node.width * px - width) / 2
          : node.align === 'right'
            ? node.width * px - width
            : 0);
      doc.text(node.text, x, node.y * px, {
        lineBreak: false,
        stroke: node.bold,
        fill: true,
      });
    }
    doc.restore();
  }
  doc.end();
  return finished;
}

export const accessSlipHeightMm = 60;
export const accessExpiry = (expiresAt: Date) =>
  expiresAt.toLocaleString('en-US', {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
/** A short slip staff can post at the counter; it is not an order ticket. */
export async function accessCodePdf(
  code: string,
  expiresAt: Date,
  font: string,
  heightMm = accessSlipHeightMm,
): Promise<Buffer> {
  const width = 72 * mm;
  const doc = new PDFDocument({
    size: [width, heightMm * mm],
    margin: 0,
    font,
    compress: true,
    info: { Title: 'Access code' },
  });
  const chunks: Buffer[] = [];
  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  const line = (text: string, y: number, size: number) => {
    doc.fontSize(size);
    if (doc.widthOfString(text) > width - 8 * mm)
      doc.fontSize((size * (width - 8 * mm)) / doc.widthOfString(text));
    doc.text(text, (width - doc.widthOfString(text)) / 2, y * mm, {
      lineBreak: false,
    });
  };
  line('ORDER PAD ACCESS CODE', 6, 11);
  line(formatAccessCode(code), 18, 30);
  line(`Valid until ${accessExpiry(expiresAt)}`, 36, 11);
  line('Minting a new code ends this one.', 46, 9);
  doc.end();
  return finished;
}
