import { createOrderDatabase } from './order-database';
import {
  assertPrintPlatform,
  parseDatabaseUrl,
  parseFont,
  parsePrintMode,
} from './config';
import { manageAccess, printAccessSlip } from './access-admin';
import { Cups } from './cups';
import { PdfOutput } from './output';
import { accessExpiry } from './receipt';
import { formatAccessCode } from '../src/lib/auth/model';

let database: ReturnType<typeof createOrderDatabase> | undefined;
try {
  const args = process.argv.slice(2);
  const noPrint = args.includes('--no-print');
  const [command, ...extra] = args.filter((arg) => arg !== '--no-print');
  if (!command || extra.length || (noPrint && command !== 'mint'))
    throw new Error(
      'Usage: npm run access -- <mint [--no-print]|status|revoke>',
    );
  const printMode = parsePrintMode(process.env.ORDER_PAD_PRINT_MODE);
  database = createOrderDatabase(parseDatabaseUrl(process.env.DATABASE_URL));
  const result = await manageAccess(database, command);
  if (result.kind === 'minted') {
    console.log(
      `Access code: ${formatAccessCode(result.code)}\nValid until: ${accessExpiry(result.expiresAt)} (${result.expiresAt.toISOString()})\nThe previous code and every device signed in with it have been signed out.`,
    );
    if (!noPrint) {
      // The code is already valid; a slip failure only means staff copy it by hand.
      try {
        assertPrintPlatform(printMode);
        const font = parseFont(process.env.ORDER_PAD_FONT, printMode);
        const output =
          printMode === 'pdf'
            ? new PdfOutput(
                process.env.ORDER_PAD_PDF_DIR ?? '.receipt-pdfs',
                font,
              )
            : new Cups(process.env.ORDER_PAD_QUEUE ?? 'OrderPad');
        const job = await printAccessSlip(
          output,
          result.code,
          result.expiresAt,
          font,
        );
        console.log(
          printMode === 'pdf'
            ? `Slip saved as ${job}.`
            : `Slip submitted to the printer (${job}).`,
        );
      } catch (error) {
        console.error(
          `The slip did not print: ${(error as Error).message} The code above is valid; write it down for staff.`,
        );
        process.exitCode = 1;
      }
    }
  } else if (result.kind === 'revoked')
    console.log(
      result.revoked
        ? 'The access code is void and every device signed in with it has been signed out.'
        : 'No access code was active.',
    );
  else
    console.log(
      result.expiresAt
        ? `An access code is active until ${accessExpiry(result.expiresAt)} (${result.expiresAt.toISOString()}) with ${result.sessions} signed-in device session(s).`
        : 'No access code is active. Run `npm run access -- mint`.',
    );
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await database?.$disconnect();
}
