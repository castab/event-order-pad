import { createOrderDatabase } from './order-database';
import {
  assertPrintPlatform,
  parseDatabaseUrl,
  parseFont,
  parsePrintMode,
} from './config';
import {
  accessStatus,
  mintCodes,
  printAccessSlip,
  revokeAccess,
} from './access-admin';
import { Cups } from './cups';
import { PdfOutput } from './output';
import { accessExpiry } from './receipt';
import { formatAccessCode, MINT_LIMIT } from '../src/lib/auth/model';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
let database: ReturnType<typeof createOrderDatabase> | undefined;
try {
  const args = process.argv.slice(2);
  const noPrint = args.includes('--no-print');
  const [command, ...extra] = args.filter((arg) => arg !== '--no-print');
  if (
    !['mint', 'status', 'revoke'].includes(command) ||
    (command === 'mint'
      ? extra.length > 1 || (extra.length === 1 && !/^\d+$/.test(extra[0]))
      : extra.length || noPrint)
  )
    throw new Error(
      `Usage: npm run access -- <mint [1-${MINT_LIMIT}] [--no-print]|status|revoke>`,
    );
  const printMode = parsePrintMode(process.env.ORDER_PAD_PRINT_MODE);
  database = createOrderDatabase(parseDatabaseUrl(process.env.DATABASE_URL));
  if (command === 'mint') {
    const codes = await mintCodes(database, Number(extra[0] ?? 1));
    console.log(
      `${plural(codes.length, 'access code')}, each for one device, to use by ${accessExpiry(codes[0].redeemBy)} (${codes[0].redeemBy.toISOString()}):\n` +
        codes.map((c) => `  ${formatAccessCode(c.code)}`).join('\n'),
    );
    if (!noPrint) {
      // The codes are already valid; a slip failure only means staff copy one by hand.
      let output;
      let font = '';
      try {
        assertPrintPlatform(printMode);
        font = parseFont(process.env.ORDER_PAD_FONT, printMode);
        output =
          printMode === 'pdf'
            ? new PdfOutput(
                process.env.ORDER_PAD_PDF_DIR ?? '.receipt-pdfs',
                font,
              )
            : new Cups(process.env.ORDER_PAD_QUEUE ?? 'OrderPad');
      } catch (error) {
        console.error(
          `No slips printed: ${(error as Error).message} The codes above still work, so write them down for staff.`,
        );
        process.exitCode = 1;
      }
      for (const { code, redeemBy } of output ? codes : []) {
        try {
          const job = await printAccessSlip(output!, code, redeemBy, font);
          console.log(
            printMode === 'pdf'
              ? `Slip for ${formatAccessCode(code)} saved as ${job}.`
              : `Slip for ${formatAccessCode(code)} submitted to the printer (${job}).`,
          );
        } catch (error) {
          console.error(
            `The slip for ${formatAccessCode(code)} didn’t print: ${(error as Error).message} The code still works, so write it down for staff.`,
          );
          process.exitCode = 1;
        }
      }
    }
  } else if (command === 'revoke') {
    const result = await revokeAccess(database, 'all');
    console.log(
      result.kind === 'revoked' && (result.voided || result.signedOut)
        ? `Voided ${plural(result.voided, 'unused code')} and signed out ${plural(result.signedOut, 'device')}.`
        : 'No codes were unused and no devices were signed in, so nothing changed.',
    );
  } else {
    const { unused, devices } = await accessStatus(database);
    console.log(
      [
        unused.length
          ? `${plural(unused.length, 'unused code')}:\n` +
            unused
              .map(
                (c) =>
                  `  minted ${accessExpiry(c.createdAt)}, use by ${accessExpiry(c.redeemBy)}`,
              )
              .join('\n')
          : 'No unused codes. Run `npm run access -- mint`.',
        devices.length
          ? `${plural(devices.length, 'signed-in device')}:\n` +
            devices
              .map(
                (d) =>
                  `  ${d.device}, signed in ${accessExpiry(d.signedInAt)}, until ${accessExpiry(d.expiresAt)}`,
              )
              .join('\n')
          : 'No devices are signed in.',
      ].join('\n'),
    );
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await database?.$disconnect();
}
