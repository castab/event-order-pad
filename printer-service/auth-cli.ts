import { createOrderDatabase } from './order-database';
import { parseDatabaseUrl } from './config';
import { manageAccount } from './auth-admin';

async function hiddenPassword(): Promise<string> {
  if (!process.stdin.isTTY)
    throw new Error(
      'Bootstrap requires an interactive terminal. Passwords are never accepted as arguments.',
    );
  process.stdout.write('Password (15–128 characters): ');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error?: Error) => {
      process.stdin.off('data', read);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const read = (chunk: string) => {
      for (const character of chunk) {
        if (character === '\u0003' || character === '\u0004')
          return finish(new Error('Cancelled.'));
        if (character === '\r' || character === '\n') return finish();
        if (character === '\u007f' || character === '\b')
          value = Array.from(value).slice(0, -1).join('');
        else if (character >= ' ' && Array.from(value).length < 129)
          value += character;
      }
    };
    process.stdin.on('data', read);
  });
}
let database: ReturnType<typeof createOrderDatabase> | undefined;
try {
  const [command, username, ...extra] = process.argv.slice(2);
  if (!command || extra.length)
    throw new Error(
      'Usage: npm run auth -- <bootstrap|invite|recover|disable|enable|list|revoke> [username]',
    );
  const origin = new URL(process.env.ORDER_PAD_ORIGIN ?? '');
  if (
    origin.protocol !== 'https:' ||
    origin.pathname !== '/' ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash
  )
    throw new Error('Set ORDER_PAD_ORIGIN to the root HTTPS origin.');
  database = createOrderDatabase(parseDatabaseUrl(process.env.DATABASE_URL));
  const password = command === 'bootstrap' ? await hiddenPassword() : undefined;
  const result = await manageAccount(database, command, username, password);
  if (Array.isArray(result)) console.table(result);
  else if ('token' in result && result.token && result.expiresAt) {
    console.log(
      `User: ${result.username}\nExpires: ${result.expiresAt.toISOString()}\nToken: ${result.token}\nURL: ${origin.origin}/${command === 'invite' ? 'enroll' : 'recover'}/#${result.token}`,
    );
  } else console.log(`Account operation completed for ${result.username}.`);
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await database?.$disconnect();
}
