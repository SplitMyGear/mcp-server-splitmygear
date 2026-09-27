/** Contract tests for the account-security backend module + tool defs: exact method/path/body/token per call. */
export {};

const mockBackendRequest = jest.fn();
jest.mock('../src/lib/backend-client', () => {
  class BackendApiError extends Error {
    status: number;
    constructor(status: number, message: string) { super(message); this.name = 'BackendApiError'; this.status = status; }
  }
  return { BackendApiError, backendRequest: (...args: unknown[]) => mockBackendRequest(...args) };
});

import { z } from 'zod';
import { accountSecurityTools, NOTIFICATION_CATEGORIES } from '../src/tools/account-security';
import { accountSecurityTools as accountSecurityDefs, setNotificationPreference, setEmailPreferences, signOutAllSessions, exportMyData } from '../src/tools/defs/account-security';
import { TOOL_SCOPES, type ToolContext } from '../src/tools/registry';

const T = 'h.p.s';
const ctx: ToolContext = { userId: 'u1', role: 'renter', token: T, kind: 'oauth' };
const { BackendApiError } = jest.requireMock('../src/lib/backend-client');

function lastCall() {
  const c = mockBackendRequest.mock.calls[mockBackendRequest.mock.calls.length - 1];
  return { method: c[0], path: c[1], opts: c[2] ?? {} };
}

function calls() {
  return mockBackendRequest.mock.calls.map((c) => ({ method: c[0], path: c[1], opts: c[2] ?? {} }));
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((c) => c.text ?? '').join('\n');
}

beforeEach(() => {
  mockBackendRequest.mockReset();
  mockBackendRequest.mockResolvedValue({ ok: 1 });
});

describe('accountSecurityTools (backend module)', () => {
  it('reads 2FA status and sessions individually', async () => {
    await accountSecurityTools.getTwoFactorStatus(T);
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/auth/2fa/status', opts: { token: T } });
    expect(lastCall().opts.body).toBeUndefined();
    await accountSecurityTools.listSessions(T);
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/auth/sessions', opts: { token: T } });
  });

  it('merges 2FA status + sessions, tolerating one side failing', async () => {
    mockBackendRequest.mockImplementation(async (_m: string, path: string) => {
      if (path === '/auth/2fa/status') return { enabled: true, passkeys: [] };
      if (path === '/auth/sessions') return { sessions: [{ id: 's1', userAgent: 'ua' }] };
      throw new Error(`unexpected ${path}`);
    });
    expect(await accountSecurityTools.getSecurityStatus(T)).toEqual({
      ok: true,
      data: { twoFactor: { enabled: true, passkeys: [] }, sessions: [{ id: 's1', userAgent: 'ua' }], errors: [] },
    });
    expect(calls().every((c) => c.opts.token === T)).toBe(true);

    mockBackendRequest.mockImplementation(async (_m: string, path: string) => {
      if (path === '/auth/2fa/status') return { enabled: false };
      throw new BackendApiError(500, 'sessions down');
    });
    expect(await accountSecurityTools.getSecurityStatus(T)).toEqual({
      ok: true,
      data: { twoFactor: { enabled: false }, sessions: null, errors: ['sessions: sessions down'] },
    });

    mockBackendRequest.mockRejectedValue(new BackendApiError(401, 'expired'));
    expect(await accountSecurityTools.getSecurityStatus(T)).toEqual({ ok: false, error: 'expired', status: 401 });
  });

  it('signs out everywhere with an empty POST body', async () => {
    mockBackendRequest.mockResolvedValue({ message: 'All sessions revoked successfully' });
    expect(await accountSecurityTools.signOutAllSessions(T)).toEqual({ ok: true, data: { message: 'All sessions revoked successfully' } });
    expect(lastCall()).toMatchObject({ method: 'POST', path: '/auth/logout-all', opts: { token: T, body: {} } });
  });

  describe('exportMyData', () => {
    const payload = {
      exportedAt: '2026-09-05T00:00:00.000Z',
      format: 'splitt-dsar-v1',
      userId: 'u1',
      counts: { bookings: 2, pageViews: 1 },
      profile: { id: 'u1', email: 'a@b.c' },
      bookings: [{ id: 'b1' }, { id: 'b2' }],
      pageViews: [{ id: 'p1' }],
      interestProfile: null,
    };

    it('GETs with an extended timeout and returns summary + full payload by default', async () => {
      mockBackendRequest.mockResolvedValue(payload);
      const res = await accountSecurityTools.exportMyData(T);
      expect(lastCall()).toMatchObject({ method: 'GET', path: '/users/me/data-export', opts: { token: T, timeoutMs: 20_000 } });
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error('unreachable');
      const data = res.data as Record<string, unknown>;
      expect(data.bookings).toEqual(payload.bookings);
      expect(data.profile).toEqual(payload.profile);
      const summary = data.summary as { counts: unknown; sections: Record<string, { items: number | null; approxBytes: number }>; approxTotalBytes: number };
      expect(summary.counts).toEqual(payload.counts);
      expect(summary.sections.bookings).toEqual({ items: 2, approxBytes: expect.any(Number) });
      expect(summary.sections.profile.items).toBeNull();
      expect(summary.sections).not.toHaveProperty('counts');
      expect(summary.approxTotalBytes).toBeGreaterThan(0);
    });

    it('summaryOnly returns counts + section names without the data', async () => {
      mockBackendRequest.mockResolvedValue(payload);
      const res = await accountSecurityTools.exportMyData(T, { summaryOnly: true });
      expect(res).toMatchObject({ ok: true, data: { availableSections: ['profile', 'bookings', 'pageViews', 'interestProfile'] } });
      if (!res.ok) throw new Error('unreachable');
      expect(res.data).not.toHaveProperty('bookings');
    });

    it('sections filters the payload and reports unknown names', async () => {
      mockBackendRequest.mockResolvedValue(payload);
      const res = await accountSecurityTools.exportMyData(T, { sections: ['bookings', 'nope'] });
      expect(res).toMatchObject({ ok: true, data: { bookings: payload.bookings, exportedAt: payload.exportedAt, unknownSections: ['nope'] } });
      if (!res.ok) throw new Error('unreachable');
      expect(res.data).not.toHaveProperty('profile');
      expect(res.data).not.toHaveProperty('pageViews');
    });

    it('export_my_data refuses a scoped connection (the export spans every scope) and serves a full grant', async () => {
      const partial = await exportMyData.handler({ summaryOnly: true }, { ...ctx, scopes: ['profile', 'bookings'] });
      expect(partial.isError).toBe(true);
      expect(text(partial)).toContain('full-access connection');
      expect(mockBackendRequest).not.toHaveBeenCalled();

      mockBackendRequest.mockResolvedValue(payload);
      const everyScope = await exportMyData.handler({ summaryOnly: true }, { ...ctx, scopes: [...TOOL_SCOPES] });
      expect(everyScope.isError).toBeUndefined();
      const unrestricted = await exportMyData.handler({ summaryOnly: true }, ctx);
      expect(unrestricted.isError).toBeUndefined();
      expect(mockBackendRequest).toHaveBeenCalledTimes(2);
    });

    it('propagates backend errors (e.g. the 3/min throttle)', async () => {
      mockBackendRequest.mockRejectedValue(new BackendApiError(429, 'ThrottlerException: Too Many Requests'));
      expect(await accountSecurityTools.exportMyData(T)).toEqual({ ok: false, error: 'ThrottlerException: Too Many Requests', status: 429 });
    });
  });

  it('reads and updates notification preferences with DTO fields only', async () => {
    await accountSecurityTools.getNotificationPreferences(T);
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/notification-preferences', opts: { token: T } });
    await accountSecurityTools.setNotificationPreference(T, { category: 'NEW_MESSAGE', emailEnabled: false, inAppEnabled: undefined, pushEnabled: undefined });
    expect(lastCall()).toMatchObject({ method: 'PUT', path: '/notification-preferences', opts: { token: T, body: { category: 'NEW_MESSAGE', emailEnabled: false } } });
    expect(lastCall().opts.body).not.toHaveProperty('inAppEnabled');
    expect(lastCall().opts.body).not.toHaveProperty('pushEnabled');
    expect(NOTIFICATION_CATEGORIES).toEqual(['BOOKING_REMINDER', 'REVIEW_REQUEST', 'LISTING_INQUIRY', 'PRICE_ALERT', 'NEW_MESSAGE']);
  });

  it('reads and updates email preferences with DTO fields only', async () => {
    await accountSecurityTools.getEmailPreferences(T);
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/email-preferences', opts: { token: T } });
    await accountSecurityTools.setEmailPreferences(T, { marketingEmails: false, profilingOptOut: true, productUpdateEmails: undefined });
    expect(lastCall()).toMatchObject({ method: 'PUT', path: '/email-preferences', opts: { token: T, body: { marketingEmails: false, profilingOptOut: true } } });
    expect(lastCall().opts.body).toEqual({ marketingEmails: false, profilingOptOut: true });
  });

  it('terms status, accept terms (no body fields), resend verification', async () => {
    await accountSecurityTools.getTermsStatus(T);
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/users/tos-status', opts: { token: T } });
    await accountSecurityTools.acceptTerms(T);
    expect(lastCall()).toMatchObject({ method: 'POST', path: '/users/accept-terms', opts: { token: T, body: {} } });
    await accountSecurityTools.resendVerificationEmail(T);
    expect(lastCall()).toMatchObject({ method: 'POST', path: '/users/resend-verification', opts: { token: T, body: {} } });
  });

  it('reads KYC status and per-document summaries, merged', async () => {
    await accountSecurityTools.getVerificationStatus(T);
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/verifications/status', opts: { token: T } });
    await accountSecurityTools.listMyVerifications(T);
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/verifications/my-verifications', opts: { token: T } });

    mockBackendRequest.mockImplementation(async (_m: string, path: string) => {
      if (path === '/verifications/status') return { verified: false, pending: true };
      if (path === '/verifications/my-verifications') return [{ id: 'v1', status: 'PENDING_REVIEW' }];
      throw new Error(`unexpected ${path}`);
    });
    expect(await accountSecurityTools.getIdentityVerificationStatus(T)).toEqual({
      ok: true,
      data: { status: { verified: false, pending: true }, verifications: [{ id: 'v1', status: 'PENDING_REVIEW' }], errors: [] },
    });

    mockBackendRequest.mockImplementation(async (_m: string, path: string) => {
      if (path === '/verifications/status') return { verified: true };
      throw new BackendApiError(500, 'boom');
    });
    expect(await accountSecurityTools.getIdentityVerificationStatus(T)).toEqual({
      ok: true,
      data: { status: { verified: true }, verifications: null, errors: ['verifications: boom'] },
    });

    mockBackendRequest.mockRejectedValue(new BackendApiError(403, 'no'));
    expect(await accountSecurityTools.getIdentityVerificationStatus(T)).toEqual({ ok: false, error: 'no', status: 403 });
  });
});

describe('accountSecurityTools (defs)', () => {
  const EXPECTED_NAMES = [
    'get_security_status',
    'sign_out_all_sessions',
    'export_my_data',
    'get_notification_preferences',
    'set_notification_preference',
    'get_email_preferences',
    'set_email_preferences',
    'get_terms_status',
    'accept_terms',
    'resend_verification_email',
    'get_identity_verification_status',
  ];

  it('exports every tool with access, scope, docs and annotations', () => {
    expect(accountSecurityDefs.map((t) => t.name)).toEqual(EXPECTED_NAMES);
    for (const t of accountSecurityDefs) {
      expect(t.access).toBe('user');
      expect(t.scope).toBe('profile');
      expect(TOOL_SCOPES).toContain(t.scope);
      expect(t.title.length).toBeGreaterThan(2);
      expect(t.description.length).toBeGreaterThan(40);
      expect(t.description).not.toMatch(/\u2014/); // no em-dashes in model-facing text (SPLIT-1331)
      expect(t.name).toMatch(/^[a-z_]+$/);
      expect(typeof t.annotations.readOnlyHint).toBe('boolean');
      expect(typeof t.handler).toBe('function');
      // Every param has a description so the model knows what to send.
      for (const [key, schema] of Object.entries(t.inputSchema)) {
        expect((schema as z.ZodTypeAny).description ?? key).toBeTruthy();
      }
    }
  });

  it('marks reads read-only and sign-out destructive', () => {
    const byName = Object.fromEntries(accountSecurityDefs.map((t) => [t.name, t]));
    for (const n of ['get_security_status', 'export_my_data', 'get_notification_preferences', 'get_email_preferences', 'get_terms_status', 'get_identity_verification_status']) {
      expect(byName[n].annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    }
    expect(byName.sign_out_all_sessions.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(byName.sign_out_all_sessions.description).toMatch(/confirm/i);
    for (const n of ['set_notification_preference', 'set_email_preferences', 'accept_terms']) {
      expect(byName[n].annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    }
    expect(byName.resend_verification_email.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
    expect(byName.accept_terms.description).toMatch(/explicitly/);
    expect(byName.get_identity_verification_status.description).toMatch(/out of scope/);
  });

  it('set_* handlers require at least one field and forward only what was passed', async () => {
    const noFlags = await setNotificationPreference.handler({ category: 'PRICE_ALERT' }, ctx);
    expect(noFlags.isError).toBe(true);
    expect(mockBackendRequest).not.toHaveBeenCalled();

    mockBackendRequest.mockResolvedValue({ success: true, preference: { category: 'PRICE_ALERT', pushEnabled: false } });
    const res = await setNotificationPreference.handler({ category: 'PRICE_ALERT', pushEnabled: false }, ctx);
    expect(res.isError).toBeUndefined();
    expect(lastCall()).toMatchObject({ method: 'PUT', path: '/notification-preferences', opts: { token: T, body: { category: 'PRICE_ALERT', pushEnabled: false } } });
    expect(z.object(setNotificationPreference.inputSchema).safeParse({ category: 'BOGUS', emailEnabled: true }).success).toBe(false);

    mockBackendRequest.mockClear();
    const noEmailFields = await setEmailPreferences.handler({}, ctx);
    expect(noEmailFields.isError).toBe(true);
    expect(mockBackendRequest).not.toHaveBeenCalled();
    await setEmailPreferences.handler({ productUpdateEmails: true }, ctx);
    expect(lastCall()).toMatchObject({ method: 'PUT', path: '/email-preferences', opts: { token: T, body: { productUpdateEmails: true } } });
  });

  it('sign_out_all_sessions surfaces the backend message and the reconnect note', async () => {
    mockBackendRequest.mockResolvedValue({ message: 'All sessions revoked successfully' });
    const res = await signOutAllSessions.handler({}, ctx);
    expect(res.isError).toBeUndefined();
    expect(JSON.parse(text(res))).toMatchObject({ signedOutEverywhere: true, message: 'All sessions revoked successfully' });
    expect(lastCall()).toMatchObject({ method: 'POST', path: '/auth/logout-all', opts: { token: T } });
  });

  it('export_my_data maps a 401 to the reconnect hint', async () => {
    mockBackendRequest.mockRejectedValue(new BackendApiError(401, 'jwt expired'));
    const res = await exportMyData.handler({ summaryOnly: true }, ctx);
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/Reconnect/);
  });
});
