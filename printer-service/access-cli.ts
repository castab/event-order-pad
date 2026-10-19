import { createOrderDatabase } from './order-database';
import {
  assertPrintPlatform,
  parseDatabaseUrl,
  parseFont,
  parsePrintMode,
} from './config';
import { decideSignIn, manageAccess, printAccessSlip } from './access-admin';
import { Cups } from './cups';
import { PdfOutput } from './output';
import { accessExpiry } from './receipt';
import { formatAccessCode } from '../src/lib/auth/model';

let database: ReturnType<typeof createOrderDatabase> | undefined;
try {
  const args = process.argv.slice(2);
  const noPrint = args.includes('--no-print');
  const [command, ...extra] = args.filter((arg) => arg !== '--no-print');
  const deciding = command === 'approve' || command === 'deny';
  if (
    !command ||
    (deciding
      ? extra.length !== 1 || !/^\d{4}$/.test(extra[0])
      : extra.length) ||
    (noPrint && command !== 'mint')
  )
    throw new Error(
      'Usage: npm run access -- <mint [--no-print]|status|revoke|requests|approve <number>|deny <number>>',
    );
  const printMode = parsePrintMode(process.env.ORDER_PAD_PRINT_MODE);
  database = createOrderDatabase(parseDatabaseUrl(process.env.DATABASE_URL));
  if (deciding) {
    const decision = await decideSignIn(
      database,
      { match: extra[0] },
      command === 'approve' ? 'approve' : 'deny',
    );
    if (decision.kind === 'gone') {
      console.error(
        `No device is waiting with number ${extra[0]}. It may have cancelled, timed out or been decided already, or the code changed. Run \`npm run access -- requests\`.`,
      );
      process.exitCode = 1;
    } else
      console.log(
        decision.kind === 'approved'
          ? `Approved ${decision.device} (${decision.match}). It is signed in until the code ends.`
          : `Denied ${decision.device} (${decision.match}). It returns to the sign-in screen.`,
      );
  } else {
    const result = await manageAccess(
      database,
      command === 'requests' ? 'status' : command,
    );
    if (result.kind === 'status' && command === 'requests')
      console.log(
        result.requests.length
          ? result.requests
              .map(
                (r) =>
                  `${r.match}  ${r.device}, asked ${accessExpiry(r.requestedAt)}, waits until ${accessExpiry(r.expiresAt)}`,
              )
              .join('\n') +
              '\nApprove only the number shown on the device: `npm run access -- approve <number>`.'
          : 'No devices are waiting for approval.',
      );
    else if (result.kind === 'minted') {
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
            `The slip didn’t print: ${(error as Error).message} The code above still works, so write it down for staff.`,
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
          ? `An access code is active until ${accessExpiry(result.expiresAt)} (${result.expiresAt.toISOString()}) with ${result.sessions} signed-in device session(s) and ${result.requests.length} waiting for approval.`
          : 'No access code is active. Run `npm run access -- mint`.',
      );
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await database?.$disconnect();
}
