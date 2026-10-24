import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { request } from 'node:http';
import { parseDatabaseUrl } from '../config';
import { createOrderDatabase } from '../order-database';
import { activity, appliedMigrations } from './activity';
import type { Host, RunOptions } from './updater';

function run(
  program: string,
  args: string[],
  { cwd, env, stdout, inherit, timeoutMs = 120000 }: RunOptions = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const file = stdout ? openSync(stdout, 'wx', 0o600) : undefined;
    const child = spawn(program, args, {
      cwd,
      shell: false,
      env: { ...process.env, ...env, LC_ALL: 'C' },
      stdio: [
        'ignore',
        file ?? (inherit ? 'inherit' : 'pipe'),
        inherit ? 'inherit' : 'pipe',
      ],
    });
    if (file !== undefined) closeSync(file);
    let output = '';
    let errors = '';
    let failure: Error | undefined;
    const timer = setTimeout(() => {
      failure = new Error(`${program} timed out.`);
      child.kill('SIGTERM');
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => {
      output += chunk.toString();
      if (output.length > 1048576) {
        failure = new Error(`${program} printed too much output.`);
        child.kill('SIGTERM');
      }
    });
    child.stderr?.on('data', (chunk) => {
      errors = (errors + chunk.toString()).slice(-2000);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (failure || code !== 0)
        reject(
          failure ??
            new Error(
              `${program} exited with ${code}${errors.trim() ? `: ${errors.trim()}` : ''}`,
            ),
        );
      else resolve(output);
    });
  });
}

async function withDatabase<T>(
  url: string,
  use: (database: ReturnType<typeof createOrderDatabase>) => Promise<T>,
): Promise<T> {
  const database = createOrderDatabase(parseDatabaseUrl(url));
  try {
    return await use(database);
  } finally {
    await database.$disconnect();
  }
}

/** The public auth config answers only after startup reached a migrated database. */
function probe(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/auth/config',
        // Cloudflare mode requires the tunnel's client header even on loopback.
        headers: { Host: `127.0.0.1:${port}`, 'CF-Connecting-IP': '127.0.0.1' },
        timeout: 5000,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
    req.end();
  });
}

export const systemHost: Host = {
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log: (message) => console.log(message),
  fetch: (input, init) => fetch(input, init),
  run,
  activity: (url) => withDatabase(url, activity),
  appliedMigrations: (url) => withDatabase(url, appliedMigrations),
  probe,
};
