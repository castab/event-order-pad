import {
  access,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

/** The dispatch journal owns retries and claims; outputs only perform one send. */
export interface PrintOutput {
  readonly mode?: 'cups' | 'pdf';
  readonly queue: string;
  check(): Promise<unknown>;
  waitUntilIdle(): Promise<void>;
  prepare(heightMm: number): Promise<{
    media: string;
    heightMm: number;
    jobOptions: string[];
  }>;
  submit(
    pdf: Buffer,
    media: string,
    attemptId: string,
    jobOptions: string[],
  ): Promise<string>;
}

export class PdfOutput implements PrintOutput {
  readonly mode = 'pdf' as const;
  readonly queue = 'PDF files';
  readonly directory: string;
  constructor(
    directory: string,
    private readonly font: string,
  ) {
    this.directory = resolve(directory);
  }
  async check(): Promise<void> {
    if (!this.font || !/\.ttf$/i.test(this.font))
      throw new Error(
        'PDF mode requires ORDER_PAD_FONT pointing to a readable TTF file.',
      );
    await access(this.font, constants.R_OK);
    if (!(await stat(this.font)).isFile())
      throw new Error('ORDER_PAD_FONT must be a readable TTF file.');
    await mkdir(this.directory, { recursive: true });
    await access(this.directory, constants.R_OK | constants.W_OK);
  }
  async waitUntilIdle(): Promise<void> {}
  async prepare(heightMm: number) {
    if (!Number.isFinite(heightMm) || heightMm <= 0 || heightMm > 2000)
      throw new Error(
        'No suitable receipt size: height must be within 2000 mm.',
      );
    await this.check();
    return { media: 'pdf', heightMm: Math.max(30, heightMm), jobOptions: [] };
  }
  private path(attemptId: string): string {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(attemptId))
      throw new Error('Invalid attempt ID.');
    return resolve(this.directory, `${attemptId}.pdf`);
  }
  async submit(
    pdf: Buffer,
    _media: string,
    attemptId: string,
  ): Promise<string> {
    const destination = this.path(attemptId);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      // Do not replace an artifact belonging to an existing attempt.
      try {
        await access(destination);
        throw new Error('Receipt PDF already exists.');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(pdf);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, destination);
      return `${attemptId}.pdf`;
    } finally {
      await rm(temporary, { force: true });
    }
  }
  async read(attemptId: string): Promise<Buffer> {
    return readFile(this.path(attemptId));
  }
}
