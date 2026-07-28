/**
 * Unit coverage for createMailer's transport selection and message shaping.
 * The reset-mail path (AdminPasswordService) depends on a blank SMTP_HOST
 * degrading to the no-op adapter that never leaks the body, and on the SMTP
 * side defaulting port/auth/from exactly as documented.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const nodemailerMock = vi.hoisted(() => ({
  createTransport: vi.fn(),
}));

vi.mock('nodemailer', () => ({ default: nodemailerMock, ...nodemailerMock }));

import { createMailer } from '../../../src/services/mailer.js';
import type { Env } from '../../../src/env.js';

function makeEnv(overrides: Partial<Env> = {}): Env {
  return { SMTP_SECURE: false, ...overrides } as unknown as Env;
}

const sendMail = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  sendMail.mockResolvedValue({ messageId: 'test' });
  nodemailerMock.createTransport.mockReturnValue({ sendMail });
});

describe('createMailer without SMTP_HOST', () => {
  it.each([
    ['unset', undefined],
    ['whitespace-only', '   '],
  ])('degrades to the no-op mailer when SMTP_HOST is %s', async (_label, host) => {
    const logger = { warn: vi.fn() };
    const mailer = createMailer(makeEnv({ SMTP_HOST: host }), logger);

    const result = await mailer.send({
      to: 'admin@example.com',
      subject: 'Reset your password',
      text: 'https://example.com/reset?token=secret-token',
    });

    expect(result).toEqual({ delivered: false, preview: 'https://example.com/reset?token=secret-token' });
    expect(nodemailerMock.createTransport).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.lastCall?.[0]).toEqual({ to: 'admin@example.com', subject: 'Reset your password' });
    expect(JSON.stringify(logger.warn.mock.lastCall)).not.toContain('secret-token');
  });

  it('works without a logger', async () => {
    const mailer = createMailer(makeEnv());
    await expect(mailer.send({ to: 'a@b.c', subject: 's', text: 't' })).resolves.toEqual({
      delivered: false,
      preview: 't',
    });
  });
});

describe('createMailer with SMTP_HOST', () => {
  it('defaults the port to 587 and omits auth when credentials are absent', () => {
    createMailer(makeEnv({ SMTP_HOST: 'smtp.example.com' }));

    expect(nodemailerMock.createTransport).toHaveBeenCalledWith({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      auth: undefined,
    });
  });

  it('passes the configured port and secure flag through', () => {
    createMailer(makeEnv({ SMTP_HOST: 'smtp.example.com', SMTP_PORT: 465, SMTP_SECURE: true }));

    expect(nodemailerMock.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'smtp.example.com', port: 465, secure: true }),
    );
  });

  it.each([
    ['only a username', { SMTP_USERNAME: 'user@example.com' }],
    ['only a password', { SMTP_PASSWORD: 'hunter2' }],
  ])('leaves auth undefined with %s', (_label, creds) => {
    createMailer(makeEnv({ SMTP_HOST: 'smtp.example.com', ...creds }));

    expect(nodemailerMock.createTransport).toHaveBeenCalledWith(expect.objectContaining({ auth: undefined }));
  });

  it('sets auth when both username and password are present', () => {
    createMailer(
      makeEnv({ SMTP_HOST: 'smtp.example.com', SMTP_USERNAME: 'user@example.com', SMTP_PASSWORD: 'hunter2' }),
    );

    expect(nodemailerMock.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ auth: { user: 'user@example.com', pass: 'hunter2' } }),
    );
  });

  it('forwards the message to the transporter and reports delivery', async () => {
    const mailer = createMailer(makeEnv({ SMTP_HOST: 'smtp.example.com', SMTP_FROM: 'noreply@example.com' }));

    const result = await mailer.send({
      to: 'admin@example.com',
      subject: 'Reset your password',
      text: 'plain body',
      html: '<p>html body</p>',
    });

    expect(result).toEqual({ delivered: true });
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail).toHaveBeenCalledWith({
      from: 'noreply@example.com',
      to: 'admin@example.com',
      subject: 'Reset your password',
      text: 'plain body',
      html: '<p>html body</p>',
    });
  });
});

describe('createMailer from-address precedence', () => {
  async function sentFrom(env: Partial<Env>, from?: string): Promise<unknown> {
    const mailer = createMailer(makeEnv({ SMTP_HOST: 'smtp.example.com', ...env }));
    await mailer.send({ to: 'admin@example.com', subject: 's', text: 't', from });
    return sendMail.mock.lastCall?.[0].from;
  }

  it('prefers SMTP_FROM over SMTP_USERNAME', async () => {
    await expect(
      sentFrom({ SMTP_FROM: 'noreply@example.com', SMTP_USERNAME: 'user@example.com' }),
    ).resolves.toBe('noreply@example.com');
  });

  it('falls back to SMTP_USERNAME when SMTP_FROM is unset', async () => {
    await expect(sentFrom({ SMTP_USERNAME: 'user@example.com' })).resolves.toBe('user@example.com');
  });

  it("falls back to 'codex-orchestrator@localhost' when neither is set", async () => {
    await expect(sentFrom({})).resolves.toBe('codex-orchestrator@localhost');
  });

  it('lets a per-message from override the configured default', async () => {
    await expect(
      sentFrom({ SMTP_FROM: 'noreply@example.com', SMTP_USERNAME: 'user@example.com' }, 'ops@example.com'),
    ).resolves.toBe('ops@example.com');
  });
});
