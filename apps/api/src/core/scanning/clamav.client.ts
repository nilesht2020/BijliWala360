import { Global, Logger, Module } from '@nestjs/common';
import { Socket } from 'node:net';
import { Readable } from 'node:stream';
import { AppConfig } from '../config/app-config';

export type ScanResult = { clean: true } | { clean: false; signature: string };

export const VIRUS_SCANNER = Symbol('VIRUS_SCANNER');

export interface VirusScanner {
  readonly enabled: boolean;
  scan(content: Buffer): Promise<ScanResult>;
}

/** Parses a clamd INSTREAM reply such as "stream: OK" or "stream: Eicar-Signature FOUND". */
export function parseClamdReply(reply: string): ScanResult {
  const text = reply.replace(/\0/g, '').trim();
  if (/:\s*OK$/.test(text)) return { clean: true };
  const found = /:\s*(.+)\s+FOUND$/.exec(text);
  if (found?.[1]) return { clean: false, signature: found[1] };
  throw new Error(`Unexpected clamd reply: ${text}`);
}

/** Minimal clamd INSTREAM client (no external dependency). */
export class ClamAvScanner implements VirusScanner {
  readonly enabled = true;

  constructor(
    private readonly host: string,
    private readonly port: number,
  ) {}

  scan(content: Buffer, timeoutMs = 60_000): Promise<ScanResult> {
    const stream = Readable.from(content);
    return new Promise<ScanResult>((resolve, reject) => {
      const socket = new Socket();
      let reply = '';
      const fail = (err: Error) => {
        socket.destroy();
        stream.destroy();
        reject(err);
      };
      socket.setTimeout(timeoutMs, () => fail(new Error('clamd scan timed out')));
      socket.on('error', fail);
      socket.on('data', (chunk) => {
        reply += chunk.toString('utf8');
      });
      socket.on('end', () => {
        try {
          resolve(parseClamdReply(reply));
        } catch (err) {
          reject(err as Error);
        }
      });
      socket.connect(this.port, this.host, () => {
        socket.write('zINSTREAM\0');
        stream.on('data', (chunk: Buffer) => {
          const size = Buffer.alloc(4);
          size.writeUInt32BE(chunk.length, 0);
          socket.write(size);
          socket.write(chunk);
        });
        stream.on('end', () => socket.write(Buffer.alloc(4))); // zero-length chunk terminates the stream
        stream.on('error', fail);
      });
    });
  }
}

/**
 * Development scanner when ClamAV is not available (SCANNER=none; refused in production).
 * It still rejects the EICAR test signature so the malware path can be exercised.
 */
export class NoopScanner implements VirusScanner {
  readonly enabled = false;
  private readonly logger = new Logger('NoopScanner');

  async scan(content: Buffer): Promise<ScanResult> {
    if (content.includes(Buffer.from('EICAR-STANDARD-ANTIVIRUS-TEST-FILE'))) {
      return { clean: false, signature: 'Eicar-Test-Signature' };
    }
    this.logger.debug('Virus scanning disabled (SCANNER=none)');
    return { clean: true };
  }
}

@Global()
@Module({
  providers: [
    {
      provide: VIRUS_SCANNER,
      inject: [AppConfig],
      useFactory: (config: AppConfig): VirusScanner =>
        config.env.SCANNER === 'clamav'
          ? new ClamAvScanner(config.env.CLAMAV_HOST, config.env.CLAMAV_PORT)
          : new NoopScanner(),
    },
  ],
  exports: [VIRUS_SCANNER],
})
export class ScanningModule {}
