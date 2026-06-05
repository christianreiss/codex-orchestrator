import nodemailer, { type Transporter } from 'nodemailer';
import type { Env } from '../env.js';

interface LogLike {
  warn: (obj: Record<string, unknown>, msg?: string) => void;
}

/**
 * Thin wrapper around nodemailer. Configured from SMTP_* env vars; if
 * SMTP_HOST is unset the mailer becomes a structured-log adapter that prints the
 * message subject + recipients to the request logger but never connects to a
 * real server (handy for dev + tests). Production overrides this by setting
 * SMTP_HOST/PORT/etc.
 */

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  from?: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<{ delivered: boolean; preview?: string }>;
}

class NoopMailer implements Mailer {
  constructor(private readonly logger?: LogLike) {}

  async send(message: MailMessage): Promise<{ delivered: boolean; preview?: string }> {
    this.logger?.warn(
      { to: message.to, subject: message.subject },
      'SMTP not configured — email body suppressed (set SMTP_HOST to send)',
    );
    return { delivered: false, preview: message.text };
  }
}

class SmtpMailer implements Mailer {
  private readonly defaultFrom: string;
  constructor(
    private readonly transporter: Transporter,
    defaultFrom: string,
  ) {
    this.defaultFrom = defaultFrom;
  }

  async send(message: MailMessage): Promise<{ delivered: boolean; preview?: string }> {
    await this.transporter.sendMail({
      from: message.from ?? this.defaultFrom,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    return { delivered: true };
  }
}

export function createMailer(env: Env, logger?: LogLike): Mailer {
  if (!env.SMTP_HOST || env.SMTP_HOST.trim() === '') {
    return new NoopMailer(logger);
  }
  const transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT ?? 587,
    secure: env.SMTP_SECURE,
    auth:
      env.SMTP_USERNAME && env.SMTP_PASSWORD
        ? { user: env.SMTP_USERNAME, pass: env.SMTP_PASSWORD }
        : undefined,
  });
  return new SmtpMailer(transporter, env.SMTP_FROM ?? env.SMTP_USERNAME ?? 'codex-orchestrator@localhost');
}
