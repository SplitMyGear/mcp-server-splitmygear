/**
 * SPLIT-1909 / SPLIT-1924: final, money-moving answers are completed in the web
 * app, never by the agent.
 *
 * Some of the text that would prompt a final action (a charge or claim
 * description, chat messages, listing copy) is written by someone else, and
 * some MCP clients auto-approve tools, so a prompt-injected message could
 * trigger it with no confirmation outside the chat. The tool therefore makes no
 * backend write: it hands back a link and the person completes it. This is the
 * same rule that already governs payments.
 */
import { ok } from './registry';
import { isVendorFamily } from '@/lib/roles';

export const SITE_URL = 'https://go-splitt.com';

/** The shared "nothing was done, open this link" result. */
export function confirmInWebApp(confirmUrl: string, message: string) {
  return ok({ requiresUserConfirmation: true, confirmUrl, message });
}

/**
 * The page where the caller can cancel one rental booking. A vendor cancels
 * from the vendor bookings list (there is no cancel on /vendor/bookings/<id>);
 * a renter from the role-aware list. `?b=` opens the list on that booking and
 * highlights it. Any role that is not clearly a vendor falls back to the renter
 * list, which is where an admin acting as a renter lands too.
 */
export function bookingConfirmUrl(role: string | undefined, bookingId: string): string {
  const base = isVendorFamily(role) ? '/vendor/bookings' : '/bookings';
  return `${SITE_URL}${base}?b=${encodeURIComponent(bookingId)}`;
}
