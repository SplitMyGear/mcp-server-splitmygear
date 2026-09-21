/**
 * Vendor money + dashboard reads. The backend's VendorRoleGuard requires an
 * owner/manager seat for finance reads and the owner seat for Stripe Connect
 * onboarding; the registry mirrors that in tool visibility.
 */
import { call, qs } from './_shared';

export const vendorFinanceTools = {
  getEarnings(token: string) {
    return call('GET', '/vendor/earnings', { token });
  },

  async getPayouts(token: string) {
    const [history, upcoming] = await Promise.all([
      call('GET', '/vendor/payouts', { token }),
      call('GET', '/vendor/upcoming-payouts', { token }),
    ]);
    if (!history.ok && !upcoming.ok) return history;
    return {
      ok: true as const,
      data: {
        payouts: history.ok ? history.data : null,
        upcoming: upcoming.ok ? upcoming.data : null,
        errors: [history.ok ? null : `payouts: ${history.error}`, upcoming.ok ? null : `upcoming: ${upcoming.error}`].filter(Boolean),
      },
    };
  },

  getStripeConnectStatus(token: string) {
    return call('GET', '/vendor/stripe-connect/status', { token });
  },

  /** Returns `{ url }` — the Stripe-hosted onboarding link for the vendor to open. */
  startStripeConnectOnboarding(token: string) {
    return call<{ url?: string }>('POST', '/vendor/stripe-connect/onboard', { token, body: {} });
  },

  async getDashboard(token: string, startDate?: string, endDate?: string) {
    const [dashboard, revenue] = await Promise.all([
      call('GET', '/analytics/dashboard', { token }),
      call('GET', `/analytics/revenue${qs({ startDate, endDate })}`, { token }),
    ]);
    if (!dashboard.ok) return dashboard;
    return { ok: true as const, data: { dashboard: dashboard.data, revenue: revenue.ok ? revenue.data : null } };
  },
};
