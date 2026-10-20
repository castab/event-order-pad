import { systemHost } from './ops/system';
import { Updater } from './ops/updater';

const usage =
  'Usage: order-pad-ops <status|check|idle|update [--now]|apply <tag> [--now] [--initial] [--allow-manual-migrations]|rollback|unblock>';
const flags = new Set([
  '--now',
  '--initial',
  '--allow-manual-migrations',
  '--dry-run',
]);
try {
  const args = process.argv.slice(2);
  const given = args.filter((arg) => arg.startsWith('--'));
  const [command, ...rest] = args.filter((arg) => !arg.startsWith('--'));
  const allowed: Record<string, string[]> = {
    status: [],
    check: [],
    idle: [],
    update: ['--now', '--dry-run'],
    apply: ['--now', '--initial', '--allow-manual-migrations'],
    rollback: [],
    unblock: [],
  };
  if (
    !(command in allowed) ||
    given.some(
      (flag) => !flags.has(flag) || !allowed[command].includes(flag),
    ) ||
    rest.length !== (command === 'apply' ? 1 : 0)
  )
    throw new Error(usage);
  const updater = new Updater(systemHost);
  const has = (flag: string) => given.includes(flag);
  if (command === 'status') console.log(await updater.status());
  else if (command === 'check')
    await updater.update({ now: true, dryRun: true });
  else if (command === 'idle') {
    const idle = await updater.idleNow();
    console.log(idle ? 'The station is idle.' : 'The station is in use.');
    if (!idle) process.exitCode = 2;
  } else if (command === 'update') {
    if (
      (await updater.update({
        now: has('--now'),
        dryRun: has('--dry-run'),
      })) === 'outside-window'
    )
      console.log('Outside the update window.');
  } else if (command === 'apply')
    await updater.apply(rest[0], {
      now: has('--now'),
      initial: has('--initial'),
      allowManual: has('--allow-manual-migrations'),
    });
  else if (command === 'rollback') await updater.rollback();
  else await updater.unblock();
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
