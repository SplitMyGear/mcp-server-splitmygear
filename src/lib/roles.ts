/**
 * The backend's single-role model (`user.role`), mirrored so tool visibility
 * and handler gating agree with the REST API's guards:
 *
 *   renter | vendor | vendor_owner | vendor_manager | vendor_staff | crm_manager | admin
 *
 * `@Roles(VENDOR)` on the backend admits the WHOLE vendor family; `admin`
 * short-circuits every role gate. Vendor money endpoints (earnings, payouts,
 * Stripe Connect) additionally require an owner/manager seat.
 */
export const VENDOR_FAMILY = ['vendor', 'vendor_owner', 'vendor_manager', 'vendor_staff'] as const;

export function isAdmin(role?: string): boolean {
  return role === 'admin';
}

export function isVendorFamily(role?: string): boolean {
  return !!role && (VENDOR_FAMILY as readonly string[]).includes(role);
}

/** May act as a vendor on listings/bookings (vendor family or admin). */
export function canActAsVendor(role?: string): boolean {
  return isVendorFamily(role) || isAdmin(role);
}

/** May read vendor earnings/payouts/Stripe status (owner or manager seat, or admin). */
export function canViewVendorFinance(role?: string): boolean {
  return role === 'vendor_owner' || role === 'vendor_manager' || isAdmin(role);
}

/** May start Stripe Connect onboarding / request payouts (owner seat or admin). */
export function canManageVendorPayouts(role?: string): boolean {
  return role === 'vendor_owner' || isAdmin(role);
}

/** May create rental bookings (the backend's `@Roles(RENTER)` on POST /bookings). */
export function canBookRentals(role?: string): boolean {
  return role === 'renter' || isAdmin(role);
}
