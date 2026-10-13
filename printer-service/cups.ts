import { spawn } from 'node:child_process';

export type Command = (
  program: string,
  args: string[],
  input?: Buffer,
) => Promise<string>;

export const command: Command = (program, args, input) =>
  new Promise((resolve, reject) => {
    const child = spawn(`/usr/bin/${program}`, args, {
      shell: false,
      env: { ...process.env, LC_ALL: 'C' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let failure: Error | undefined;
    const timer = setTimeout(() => {
      failure = new Error('Command timed out.');
      child.kill('SIGTERM');
    }, 30000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (output.length > 65536) {
        failure = new Error('Command output exceeded limit.');
        child.kill('SIGTERM');
      }
    });
    child.stderr.resume();
    child.stdin.on('error', () => {
      /* close/error handles failed submission */
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (failure || code !== 0)
        reject(failure ?? new Error('CUPS command failed.'));
      else resolve(output);
    });
    child.stdin.end(input);
  });

export class Cups {
  constructor(
    readonly queue: string,
    private run: Command = command,
  ) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(queue))
      throw new Error('Invalid CUPS queue name.');
  }
  async check(): Promise<string> {
    const status = await this.run('lpstat', [
      '-h',
      'localhost:631',
      '-p',
      this.queue,
      '-a',
      this.queue,
      '-v',
      this.queue,
    ]);
    if (/disabled|not accepting/i.test(status))
      throw new Error('CUPS queue is disabled or rejecting jobs.');
    if (!/usb:\/\//i.test(status))
      throw new Error('Select a local USB CUPS queue.');
    const options = await this.run('lpoptions', [
      '-h',
      'localhost:631',
      '-p',
      this.queue,
      '-l',
    ]);
    this.installedJobOptions(options);
    return options;
  }
  private installedJobOptions(options: string): string[] {
    const jobOptions: string[] = [];
    for (const [name, supported] of [
      ['PageType', ['0Variable', 'Variable0']],
      ['DocCutType', ['1PartialCutDoc', 'PartialCutDoc1']],
      ['PageCutType', ['0NoCutPage', 'NoCutPage0']],
    ] as const) {
      const line = options
        .split('\n')
        .find((line) => line.startsWith(`${name}/`));
      const choices =
        line
          ?.slice(line.indexOf(':') + 1)
          .trim()
          .split(/\s+/)
          .map((token) => token.replace(/^\*/, '')) ?? [];
      const value = supported.find((value) => choices.includes(value));
      if (!value)
        throw new Error(
          'CUPS queue needs the Star TSP100 Cutter driver and variable-length/partial-cut options.',
        );
      jobOptions.push('-o', `${name}=${value}`);
    }
    return jobOptions;
  }
  async waitUntilIdle(
    now = () => Date.now(),
    pause = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms)),
  ): Promise<void> {
    const deadline = now() + 30000;
    while (
      (
        await this.run('lpstat', ['-h', 'localhost:631', '-o', this.queue])
      ).trim()
    ) {
      if (now() >= deadline)
        throw new Error(
          'A CUPS job is still pending after 30 seconds. Inspect or cancel it before deliberately reprinting.',
        );
      await pause(Math.min(1000, deadline - now()));
    }
  }

  async prepare(
    heightMm: number,
  ): Promise<{ media: string; heightMm: number; jobOptions: string[] }> {
    if (!Number.isFinite(heightMm) || heightMm <= 0 || heightMm > 2000)
      throw new Error(
        'No suitable receipt size: height must be within 2000 mm.',
      );
    const options = await this.check();
    const jobOptions = this.installedJobOptions(options);
    if (
      (
        await this.run('lpstat', ['-h', 'localhost:631', '-o', this.queue])
      ).trim()
    )
      throw new Error(
        'A CUPS job is still pending. Inspect or cancel it before sending another ticket.',
      );
    const line = options
      .split('\n')
      .find((line) => line.startsWith('PageSize/'));
    const values =
      line
        ?.slice(line.indexOf(':') + 1)
        .trim()
        .split(/\s+/)
        .map((value) => value.replace(/^\*/, '')) ?? [];
    if (values.includes('Custom'))
      return {
        media: `Custom.72x${Math.max(30, heightMm)}mm`,
        heightMm: Math.max(30, heightMm),
        jobOptions,
      };
    const sizes = values
      .map((media) => ({
        media,
        numbers: media.match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [],
      }))
      .filter(
        (size) =>
          size.numbers.length === 2 &&
          size.numbers[0] === 72 &&
          size.numbers[1] >= heightMm &&
          size.numbers[1] <= 2000,
      )
      .sort((a, b) => a.numbers[1] - b.numbers[1]);
    if (!sizes.length)
      throw new Error('No suitable 72 mm receipt size in this CUPS driver.');
    return { media: sizes[0].media, heightMm: sizes[0].numbers[1], jobOptions };
  }
  async submit(
    pdf: Buffer,
    media: string,
    attemptId: string,
    jobOptions: string[],
  ): Promise<string> {
    const output = await this.run(
      'lp',
      [
        '-h',
        'localhost:631',
        '-d',
        this.queue,
        '-n',
        '1',
        '-t',
        `OrderPad-${attemptId}`,
        '-o',
        `media=${media}`,
        '-o',
        'orientation-requested=3',
        ...jobOptions,
        '-',
      ],
      pdf,
    );
    const match = output.match(/request id is ([A-Za-z0-9_-]+-\d+) /);
    if (!match || !match[1].startsWith(`${this.queue}-`))
      throw new Error('CUPS submission result was unrecognized.');
    return match[1];
  }
}
