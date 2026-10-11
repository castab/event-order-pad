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
    for (const [name, value] of [
      ['PageType', 'Variable0'],
      ['DocCutType', 'PartialCutDoc1'],
      ['PageCutType', 'NoCutPage0'],
    ]) {
      if (
        !options.split('\n').some(
          (line) =>
            line.startsWith(`${name}/`) &&
            line
              .split(/\s+/)
              .map((token) => token.replace(/^\*/, ''))
              .includes(value),
        )
      )
        throw new Error(
          'CUPS queue needs the Star TSP100 Cutter driver and variable-length/partial-cut options.',
        );
    }
    return options;
  }
  async prepare(
    heightMm: number,
  ): Promise<{ media: string; heightMm: number }> {
    const options = await this.check();
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
    return { media: sizes[0].media, heightMm: sizes[0].numbers[1] };
  }
  async submit(pdf: Buffer, media: string, attemptId: string): Promise<string> {
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
        '-o',
        'PageType=Variable0',
        '-o',
        'PageCutType=NoCutPage0',
        '-o',
        'DocCutType=PartialCutDoc1',
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
