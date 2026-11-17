import { Global, Injectable, Logger, Module } from '@nestjs/common';

/**
 * Provider-agnostic channel adapters (SRS §11.3-11.4, ARCHITECTURE T-15). Concrete vendors
 * (e.g. MSG91, Meta Cloud API, SES) are added as further implementations at integration time.
 */
export interface SendResult {
  providerMessageId: string;
}

export interface SmsMessage {
  to: string;
  body: string;
  dltTemplateId?: string;
}

export interface WhatsAppMessage {
  to: string;
  templateName: string;
  language: string;
  params: string[];
}

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
}

export interface SmsProvider {
  send(message: SmsMessage): Promise<SendResult>;
}
export interface WhatsAppProvider {
  send(message: WhatsAppMessage): Promise<SendResult>;
}
export interface EmailProvider {
  send(message: EmailMessage): Promise<SendResult>;
}

export const SMS_PROVIDER = Symbol('SMS_PROVIDER');
export const WHATSAPP_PROVIDER = Symbol('WHATSAPP_PROVIDER');
export const EMAIL_PROVIDER = Symbol('EMAIL_PROVIDER');

const mask = (to: string) => (to.length > 4 ? `${'*'.repeat(to.length - 4)}${to.slice(-4)}` : to);

/** Development adapters: log instead of sending. Message bodies are only logged outside production. */
@Injectable()
export class ConsoleSmsProvider implements SmsProvider {
  private readonly logger = new Logger('SMS');
  private seq = 0;
  readonly sent: SmsMessage[] = [];

  async send(message: SmsMessage): Promise<SendResult> {
    this.sent.push(message);
    this.logger.log(`to=${mask(message.to)} body="${message.body}"`);
    this.seq += 1;
    return { providerMessageId: `console-sms-${Date.now()}-${this.seq}` };
  }
}

@Injectable()
export class ConsoleWhatsAppProvider implements WhatsAppProvider {
  private readonly logger = new Logger('WhatsApp');
  private seq = 0;
  readonly sent: WhatsAppMessage[] = [];

  async send(message: WhatsAppMessage): Promise<SendResult> {
    this.sent.push(message);
    this.logger.log(
      `to=${mask(message.to)} template=${message.templateName} params=${JSON.stringify(message.params)}`,
    );
    this.seq += 1;
    return { providerMessageId: `console-wa-${Date.now()}-${this.seq}` };
  }
}

@Injectable()
export class ConsoleEmailProvider implements EmailProvider {
  private readonly logger = new Logger('Email');
  private seq = 0;
  readonly sent: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<SendResult> {
    this.sent.push(message);
    this.logger.log(`to=${message.to} subject="${message.subject}"`);
    this.seq += 1;
    return { providerMessageId: `console-email-${Date.now()}-${this.seq}` };
  }
}

@Global()
@Module({
  providers: [
    { provide: SMS_PROVIDER, useClass: ConsoleSmsProvider },
    { provide: WHATSAPP_PROVIDER, useClass: ConsoleWhatsAppProvider },
    { provide: EMAIL_PROVIDER, useClass: ConsoleEmailProvider },
  ],
  exports: [SMS_PROVIDER, WHATSAPP_PROVIDER, EMAIL_PROVIDER],
})
export class ChannelsModule {}
