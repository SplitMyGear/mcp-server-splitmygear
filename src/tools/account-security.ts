/**
 * Account security + preferences for the signed-in user: two-factor status,
 * active sessions, sign-out-everywhere, the GDPR/CCPA data export,
 * notification + email preference centres, Terms of Service status, email
 * verification resend, and read-only KYC (identity verification) state.
 *
 * Every call forwards the caller's own backend JWT; the backend derives the
 * user from it (all routes are JwtAuthGuard-only, no role guard). Only DTO
 * fields are ever sent (the backend's global ValidationPipe rejects undeclared
 * fields with a 400), so bodies are built with `compact()`.
 *
 * Deliberately NOT here (they need a password or a one-time code typed by the
 * user in the Splitt UI): account deletion, password change/reset, 2FA
 * enrol/disable, passkey add/remove, and the KYC document upload (a browser
 * direct-to-Blob flow).
 */
import { call, compact, type Result } from './_shared';

export const NOTIFICATION_CATEGORIES = ['BOOKING_REMINDER', 'REVIEW_REQUEST', 'LISTING_INQUIRY', 'PRICE_ALERT', 'NEW_MESSAGE'] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/** Body for PUT /notification-preferences (UpdateNotificationPreferenceDto). */
export interface NotificationPreferenceUpdate {
  category: NotificationCategory;
  emailEnabled?: boolean;
  inAppEnabled?: boolean;
  pushEnabled?: boolean;
}

/** Body for PUT /email-preferences (UpdateEmailPreferencesDto). */
export interface EmailPreferencesUpdate {
  marketingEmails?: boolean;
  productUpdateEmails?: boolean;
  profilingOptOut?: boolean;
}

export interface DataExportOptions {
  /** Return only counts + approximate size instead of the full payload. */
  summaryOnly?: boolean;
  /** Restrict the full payload to these top-level sections. */
  sections?: string[];
}

/**
 * The export fans out across many tables server-side; give it more headroom
 * than the default 15s while staying inside the function's 30s budget.
 */
const DATA_EXPORT_TIMEOUT_MS = 20_000;

/** Top-level keys of the export that are metadata rather than data sections. */
const EXPORT_META_KEYS = new Set(['exportedAt', 'format', 'userId', 'counts']);

function approxJsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
  } catch {
    return 0;
  }
}

function summariseExport(data: Record<string, unknown>) {
  const sections: Record<string, { items: number | null; approxBytes: number }> = {};
  for (const [key, value] of Object.entries(data)) {
    if (EXPORT_META_KEYS.has(key)) continue;
    sections[key] = { items: Array.isArray(value) ? value.length : null, approxBytes: approxJsonBytes(value) };
  }
  return {
    exportedAt: data.exportedAt ?? null,
    format: data.format ?? null,
    approxTotalBytes: approxJsonBytes(data),
    counts: data.counts ?? null,
    sections,
  };
}

export const accountSecurityTools = {
  // ── Security ─────────────────────────────────────────────────────────────

  getTwoFactorStatus(token: string) {
    return call('GET', '/auth/2fa/status', { token });
  },

  listSessions(token: string) {
    return call<{ sessions?: unknown[] }>('GET', '/auth/sessions', { token });
  },

  /** 2FA state + active sessions in one read; partial failures are reported, not fatal. */
  async getSecurityStatus(token: string): Promise<Result<unknown>> {
    const [twoFactor, sessions] = await Promise.all([
      call('GET', '/auth/2fa/status', { token }),
      call<{ sessions?: unknown[] }>('GET', '/auth/sessions', { token }),
    ]);
    if (!twoFactor.ok && !sessions.ok) return twoFactor;
    return {
      ok: true as const,
      data: {
        twoFactor: twoFactor.ok ? twoFactor.data : null,
        sessions: sessions.ok ? sessions.data?.sessions ?? sessions.data : null,
        errors: [twoFactor.ok ? null : `twoFactor: ${twoFactor.error}`, sessions.ok ? null : `sessions: ${sessions.error}`].filter(Boolean),
      },
    };
  },

  /** Revokes every refresh token of the user (all devices, including this connection). */
  signOutAllSessions(token: string) {
    return call<{ message?: string }>('POST', '/auth/logout-all', { token, body: {} });
  },

  // ── Privacy / data export ────────────────────────────────────────────────

  async exportMyData(token: string, options: DataExportOptions = {}): Promise<Result<unknown>> {
    const result = await call<Record<string, unknown>>('GET', '/users/me/data-export', { token, timeoutMs: DATA_EXPORT_TIMEOUT_MS });
    if (!result.ok) return result;
    const data = result.data && typeof result.data === 'object' ? result.data : {};
    const summary = summariseExport(data);
    if (options.summaryOnly) return { ok: true as const, data: { summary, availableSections: Object.keys(summary.sections) } };
    if (options.sections && options.sections.length > 0) {
      const wanted = new Set(options.sections);
      const picked: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(data)) {
        if (EXPORT_META_KEYS.has(key) || wanted.has(key)) picked[key] = value;
      }
      const missing = options.sections.filter((s) => !(s in data));
      return { ok: true as const, data: { summary, ...picked, ...(missing.length ? { unknownSections: missing } : {}) } };
    }
    return { ok: true as const, data: { summary, ...data } };
  },

  // ── Preference centres ───────────────────────────────────────────────────

  getNotificationPreferences(token: string) {
    return call('GET', '/notification-preferences', { token });
  },

  setNotificationPreference(token: string, update: NotificationPreferenceUpdate) {
    return call('PUT', '/notification-preferences', { token, body: compact(update) });
  },

  getEmailPreferences(token: string) {
    return call('GET', '/email-preferences', { token });
  },

  setEmailPreferences(token: string, update: EmailPreferencesUpdate) {
    return call('PUT', '/email-preferences', { token, body: compact(update) });
  },

  // ── Terms of Service + email verification ────────────────────────────────

  getTermsStatus(token: string) {
    return call('GET', '/users/tos-status', { token });
  },

  /** Records assent to the CURRENT ToS version (server-authoritative; no body). */
  acceptTerms(token: string) {
    return call('POST', '/users/accept-terms', { token, body: {} });
  },

  resendVerificationEmail(token: string) {
    return call<{ success?: boolean; message?: string }>('POST', '/users/resend-verification', { token, body: {} });
  },

  // ── Identity verification (KYC), read-only ───────────────────────────────

  getVerificationStatus(token: string) {
    return call('GET', '/verifications/status', { token });
  },

  listMyVerifications(token: string) {
    return call('GET', '/verifications/my-verifications', { token });
  },

  /** Aggregate flags + per-document detail (rejection reasons, expiry) in one read. */
  async getIdentityVerificationStatus(token: string): Promise<Result<unknown>> {
    const [status, verifications] = await Promise.all([
      call('GET', '/verifications/status', { token }),
      call('GET', '/verifications/my-verifications', { token }),
    ]);
    if (!status.ok) return status;
    return {
      ok: true as const,
      data: {
        status: status.data,
        verifications: verifications.ok ? verifications.data : null,
        errors: verifications.ok ? [] : [`verifications: ${verifications.error}`],
      },
    };
  },
};
