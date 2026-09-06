/** Vendor tools: listings, calendar, incoming bookings, experiences hosting, finance. Visible to the vendor family only. */
import { z } from 'zod';
import { defineTool, ok, fail, fromResult } from '../registry';
import { vendorListingTools } from '../vendor-listings';
import { vendorBookingTools } from '../vendor-bookings';
import { vendorFinanceTools } from '../vendor-finance';
import { reviewTools } from '../reviews';
import { experienceTools } from '../experiences';
import { dateRangeError } from '../_shared';
import { uuid, isoDate, pagination, READ, WRITE, WRITE_IDEMPOTENT, DESTRUCTIVE, LISTING_CATEGORIES, CANCELLATION_POLICIES, UNTRUSTED_NOTE, token } from './common';

const listingFields = {
  category: z.enum(LISTING_CATEGORIES).optional(),
  pricePerDay: z.number().min(0).optional(),
  pricePerHour: z.number().min(0).optional(),
  bookingType: z.enum(['daily', 'hourly']).optional(),
  location: z.string().max(200).optional().describe('City / area shown publicly.'),
  address: z.string().max(300).optional().describe('Pickup address (kept private until booked).'),
  generalArea: z.string().max(200).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  imageUrls: z.array(z.string().url().max(2048)).max(20).optional().describe('Publicly reachable image URLs.'),
  make: z.string().max(80).optional(),
  model: z.string().max(80).optional(),
  year: z.number().int().min(1900).max(2100).optional(),
  maxGuests: z.number().int().min(1).max(50).optional(),
  instantBook: z.boolean().optional(),
  requiresIdVerification: z.boolean().optional(),
  cancellationPolicy: z.enum(CANCELLATION_POLICIES).optional(),
  depositAmount: z.number().min(0).optional().describe('Refundable security deposit.'),
  deliveryAvailable: z.boolean().optional(),
  deliveryFee: z.number().min(0).optional(),
  deliveryRadiusMiles: z.number().min(0).optional(),
  leadTimeDays: z.number().int().min(0).optional().describe('Minimum notice before a rental starts.'),
  bufferDays: z.number().int().min(0).optional().describe('Days blocked between rentals.'),
  minRentalDays: z.number().int().min(1).optional(),
  maxRentalDays: z.number().int().min(1).optional(),
  minAge: z.number().int().min(0).optional(),
  estimatedValue: z.number().min(0).optional().describe('Replacement value (drives protection pricing).'),
  weeklyDiscountPct: z.number().min(0).max(100).optional(),
  monthlyDiscountPct: z.number().min(0).max(100).optional(),
  quantity: z.number().int().min(1).max(100).optional().describe('How many identical units you have.'),
};

// ── Listings ─────────────────────────────────────────────────────────────────

export const listMyListings = defineTool({
  name: 'list_my_listings',
  title: 'My listings',
  description: 'All listings owned by the signed-in vendor, including unpublished drafts, with status, price and booking counts.',
  access: 'vendor',
  scope: 'listings',
  inputSchema: {},
  annotations: READ,
  handler: async (_args, ctx) => fromResult(await vendorListingTools.listMyListings(token(ctx))),
});

export const createListing = defineTool({
  name: 'create_listing',
  title: 'Create a listing',
  description:
    'Create a new gear listing for the signed-in vendor. It starts UNPUBLISHED; review it, then call set_listing_published. ' +
    'Required: name, description, category and a price (per day or per hour). Use suggest_listing_price and generate_listing_description to draft good content. ' +
    'Vendor onboarding must be complete (see get_vendor_onboarding_status).',
  access: 'vendor',
  scope: 'listings',
  inputSchema: {
    name: z.string().min(3).max(200),
    description: z.string().min(20).max(5000),
    ...listingFields,
  },
  annotations: WRITE,
  handler: async (args, ctx) => {
    if (args.pricePerDay === undefined && args.pricePerHour === undefined) return fail('Provide pricePerDay (daily gear) or pricePerHour (hourly gear).');
    return fromResult(await vendorListingTools.createListing(token(ctx), args));
  },
});

export const updateListing = defineTool({
  name: 'update_listing',
  title: 'Update a listing',
  description: 'Change any fields of one of the vendor\'s listings (only the fields you pass are changed). Use get_listing_details to see current values.',
  access: 'vendor',
  scope: 'listings',
  inputSchema: {
    listingId: uuid('listing'),
    name: z.string().min(3).max(200).optional(),
    description: z.string().min(20).max(5000).optional(),
    ...listingFields,
  },
  annotations: WRITE_IDEMPOTENT,
  handler: async ({ listingId, ...rest }, ctx) => {
    if (Object.values(rest).every((v) => v === undefined)) return fail('Pass at least one field to update.');
    return fromResult(await vendorListingTools.updateListing(listingId, token(ctx), rest));
  },
});

export const setListingPublished = defineTool({
  name: 'set_listing_published',
  title: 'Publish / unpublish listing',
  description: 'Make a listing live and bookable (published=true) or hide it from search (published=false). Existing bookings are unaffected.',
  access: 'vendor',
  scope: 'listings',
  inputSchema: { listingId: uuid('listing'), published: z.boolean() },
  annotations: WRITE_IDEMPOTENT,
  handler: async ({ listingId, published }, ctx) => fromResult(await vendorListingTools.setPublished(listingId, published, token(ctx))),
});

export const deleteListing = defineTool({
  name: 'delete_listing',
  title: 'Delete a listing',
  description: 'Permanently delete one of the vendor\'s listings. Prefer set_listing_published(false) to hide it. Confirm with the user first.',
  access: 'vendor',
  scope: 'listings',
  inputSchema: { listingId: uuid('listing') },
  annotations: DESTRUCTIVE,
  handler: async ({ listingId }, ctx) => fromResult(await vendorListingTools.deleteListing(listingId, token(ctx)), () => ({ deleted: true, listingId })),
});

export const duplicateListing = defineTool({
  name: 'duplicate_listing',
  title: 'Duplicate a listing',
  description: 'Copy a listing into a new unpublished draft (handy for similar items).',
  access: 'vendor',
  scope: 'listings',
  inputSchema: { listingId: uuid('listing') },
  annotations: WRITE,
  handler: async ({ listingId }, ctx) => fromResult(await vendorListingTools.duplicateListing(listingId, token(ctx))),
});

export const generateListingDraft = defineTool({
  name: 'generate_listing_draft',
  title: 'AI listing draft',
  description: 'Have Splitt\'s AI draft a complete listing (title, description, specs, category, price guidance) from a short gear description. Review, then pass the fields to create_listing.',
  access: 'vendor',
  scope: 'listings',
  inputSchema: {
    gearType: z.string().min(2).max(120).describe('e.g. "4-person backpacking tent", "gravel bike 56cm".'),
    brand: z.string().max(120).optional(),
    model: z.string().max(120).optional(),
    year: z.number().int().min(1900).max(2100).optional(),
    location: z.string().max(200).optional(),
    features: z.array(z.string().max(120)).max(30).optional(),
    vendorNotes: z.string().max(2000).optional().describe('Anything else the copy should mention.'),
  },
  annotations: READ,
  handler: async (args, ctx) => fromResult(await vendorListingTools.generateListingDraft(token(ctx), args)),
});

export const getListingPerformance = defineTool({
  name: 'get_listing_performance',
  title: 'Listing performance',
  description: 'Views, bookings, revenue and conversion per listing for the signed-in vendor (optionally for a date range).',
  access: 'vendor',
  scope: 'listings',
  inputSchema: { startDate: z.string().optional().describe('ISO date.'), endDate: z.string().optional().describe('ISO date.') },
  annotations: READ,
  handler: async ({ startDate, endDate }, ctx) => fromResult(await vendorListingTools.getListingPerformance(token(ctx), startDate, endDate)),
});

// ── Calendar ─────────────────────────────────────────────────────────────────

export const listBlackoutDates = defineTool({
  name: 'list_blackout_dates',
  title: 'List blackout dates',
  description: 'Dates the vendor has blocked on a listing (maintenance, personal use…), each with an id for remove_blackout_date.',
  access: 'vendor',
  scope: 'listings',
  inputSchema: { listingId: uuid('listing') },
  annotations: READ,
  handler: async ({ listingId }, ctx) => fromResult(await vendorListingTools.listBlackoutDates(listingId, token(ctx))),
});

export const addBlackoutDates = defineTool({
  name: 'add_blackout_dates',
  title: 'Block dates',
  description: 'Block a date range on a listing so it cannot be booked. Existing confirmed bookings in the range are not cancelled.',
  access: 'vendor',
  scope: 'listings',
  inputSchema: {
    listingId: uuid('listing'),
    startDate: isoDate('First blocked day'),
    endDate: isoDate('Last blocked day'),
    reason: z.string().max(200).optional(),
  },
  annotations: WRITE,
  handler: async ({ listingId, ...input }, ctx) => {
    if (Number.isNaN(new Date(input.startDate).getTime()) || Number.isNaN(new Date(input.endDate).getTime())) return fail('Dates must be ISO dates such as 2026-07-04.');
    if (new Date(input.endDate).getTime() < new Date(input.startDate).getTime()) return fail('endDate must be on or after startDate.');
    return fromResult(await vendorListingTools.addBlackoutDates(listingId, token(ctx), input));
  },
});

export const removeBlackoutDate = defineTool({
  name: 'remove_blackout_date',
  title: 'Unblock dates',
  description: 'Remove a blackout entry (by its id from list_blackout_dates) so those dates become bookable again.',
  access: 'vendor',
  scope: 'listings',
  inputSchema: { blackoutId: uuid('blackout entry') },
  annotations: DESTRUCTIVE,
  handler: async ({ blackoutId }, ctx) => fromResult(await vendorListingTools.removeBlackoutDate(blackoutId, token(ctx)), () => ({ removed: true, blackoutId })),
});

// ── Incoming bookings ────────────────────────────────────────────────────────

export const listIncomingBookings = defineTool({
  name: 'list_incoming_bookings',
  title: 'Bookings on my listings',
  description: 'Rental bookings renters have made on the signed-in vendor\'s listings (upcoming, active, overdue, completed), with renter, dates, status and payout amounts. Filter by status client-side.',
  access: 'vendor',
  scope: 'vendor_bookings',
  inputSchema: {
    ...pagination,
    status: z.enum(['pending', 'confirmed', 'cancelled', 'completed', 'rejected']).optional(),
  },
  annotations: READ,
  handler: async ({ limit, offset, status }, ctx) =>
    fromResult(await vendorBookingTools.listIncomingBookings(token(ctx), limit ?? 50, offset ?? 0), (bookings) => {
      const list = Array.isArray(bookings) ? bookings : [];
      const filtered = status ? list.filter((b) => (b as { status?: string })?.status === status) : list;
      return { count: filtered.length, bookings: filtered };
    }),
});

export const setBookingReturnStatus = defineTool({
  name: 'set_booking_return_status',
  title: 'Mark returned / overdue',
  description: 'Flag a rental as NOT returned on time (returned=false, optional note; starts the overdue process) or clear the flag once the gear is back (returned=true).',
  access: 'vendor',
  scope: 'vendor_bookings',
  inputSchema: { bookingId: uuid('booking'), returned: z.boolean(), note: z.string().max(500).optional() },
  annotations: WRITE_IDEMPOTENT,
  handler: async ({ bookingId, returned, note }, ctx) => fromResult(await vendorBookingTools.setReturnStatus(bookingId, returned, token(ctx), note)),
});

export const proposeBookingReschedule = defineTool({
  name: 'propose_booking_reschedule',
  title: 'Propose new dates',
  description: 'Propose different dates for a booking on the vendor\'s listing. The renter is notified and can accept (price is re-settled) or decline (booking cancels with full refund).',
  access: 'vendor',
  scope: 'vendor_bookings',
  inputSchema: { bookingId: uuid('booking'), startDate: isoDate('Proposed start'), endDate: isoDate('Proposed end'), note: z.string().max(500).optional() },
  annotations: WRITE,
  handler: async ({ bookingId, ...input }, ctx) => {
    const err = dateRangeError(input.startDate, input.endDate);
    if (err) return fail(err);
    return fromResult(await vendorBookingTools.proposeReschedule(bookingId, token(ctx), input));
  },
});

export const withdrawRescheduleProposal = defineTool({
  name: 'withdraw_reschedule_proposal',
  title: 'Withdraw reschedule proposal',
  description: 'Withdraw a pending reschedule proposal on a booking; the original dates stand.',
  access: 'vendor',
  scope: 'vendor_bookings',
  inputSchema: { bookingId: uuid('booking') },
  annotations: WRITE_IDEMPOTENT,
  handler: async ({ bookingId }, ctx) => fromResult(await vendorBookingTools.withdrawReschedule(bookingId, token(ctx)), () => ({ withdrawn: true, bookingId })),
});

export const setBookingVendorNotes = defineTool({
  name: 'set_booking_vendor_notes',
  title: 'Private booking notes',
  description: 'Set (or clear with an empty string) the vendor\'s private notes on a booking. Renters never see these.',
  access: 'vendor',
  scope: 'vendor_bookings',
  inputSchema: { bookingId: uuid('booking'), vendorNotes: z.string().max(2000) },
  annotations: WRITE_IDEMPOTENT,
  handler: async ({ bookingId, vendorNotes }, ctx) => fromResult(await vendorBookingTools.setVendorNotes(bookingId, token(ctx), vendorNotes.trim() ? vendorNotes : null)),
});

export const respondToReview = defineTool({
  name: 'respond_to_review',
  title: 'Respond to a review',
  description: 'Post, edit or delete the vendor\'s public response to a review on their listing. ' + UNTRUSTED_NOTE,
  access: 'vendor',
  scope: 'reviews',
  inputSchema: {
    reviewId: uuid('review'),
    action: z.enum(['create', 'update', 'delete']),
    response: z.string().max(2000).optional().describe('Required for create/update.'),
  },
  annotations: WRITE_IDEMPOTENT,
  handler: async ({ reviewId, action, response }, ctx) => {
    if (action === 'delete') return fromResult(await reviewTools.deleteReviewResponse(token(ctx), reviewId), () => ({ deleted: true, reviewId }));
    if (!response?.trim()) return fail('response text is required.');
    return fromResult(await reviewTools.respondToReview(token(ctx), reviewId, response, action));
  },
});

// ── Finance & dashboard ──────────────────────────────────────────────────────

export const getVendorDashboard = defineTool({
  name: 'get_vendor_dashboard',
  title: 'Vendor dashboard',
  description: 'Key metrics for the signed-in vendor: active listings, bookings, revenue, occupancy and a revenue series (optionally for a date range).',
  access: 'vendor',
  scope: 'finance',
  inputSchema: { startDate: z.string().optional(), endDate: z.string().optional() },
  annotations: READ,
  handler: async ({ startDate, endDate }, ctx) => fromResult(await vendorFinanceTools.getDashboard(token(ctx), startDate, endDate)),
});

export const getVendorEarnings = defineTool({
  name: 'get_vendor_earnings',
  title: 'Earnings',
  description: 'Lifetime and pending earnings, fees and available balance for the vendor (owner/manager seats).',
  access: 'vendor_finance',
  scope: 'finance',
  inputSchema: {},
  annotations: READ,
  handler: async (_args, ctx) => fromResult(await vendorFinanceTools.getEarnings(token(ctx))),
});

export const getVendorPayouts = defineTool({
  name: 'get_vendor_payouts',
  title: 'Payouts',
  description: 'Payout history (amount, fee, net, status, dates) and upcoming scheduled payouts for the vendor (owner/manager seats).',
  access: 'vendor_finance',
  scope: 'finance',
  inputSchema: {},
  annotations: READ,
  handler: async (_args, ctx) => fromResult(await vendorFinanceTools.getPayouts(token(ctx))),
});

export const getStripeConnectStatus = defineTool({
  name: 'get_stripe_connect_status',
  title: 'Stripe Connect status',
  description: 'Whether the vendor\'s Stripe Connect payout account is set up and what (if anything) Stripe still requires.',
  access: 'vendor_finance',
  scope: 'finance',
  inputSchema: {},
  annotations: READ,
  handler: async (_args, ctx) => fromResult(await vendorFinanceTools.getStripeConnectStatus(token(ctx))),
});

export const startStripeConnectOnboarding = defineTool({
  name: 'start_stripe_connect_onboarding',
  title: 'Set up payouts (Stripe)',
  description: 'Get a Stripe-hosted onboarding link for the vendor owner to connect or finish their payout account. Give the URL to the user to open in a browser.',
  access: 'vendor_owner',
  scope: 'finance',
  inputSchema: {},
  annotations: WRITE_IDEMPOTENT,
  handler: async (_args, ctx) => fromResult(await vendorFinanceTools.startStripeConnectOnboarding(token(ctx)), (d) => ({ onboardingUrl: d?.url ?? d })),
});

// ── Experiences (host side) ──────────────────────────────────────────────────

export const listMyExperiences = defineTool({
  name: 'list_my_experiences',
  title: 'My experiences',
  description: 'Experiences/tours the signed-in vendor hosts, including drafts and archived ones.',
  access: 'vendor',
  scope: 'experiences',
  inputSchema: {},
  annotations: READ,
  handler: async (_args, ctx) => fromResult(await experienceTools.listMyExperiences(token(ctx))),
});

const experienceFields = {
  shortDescription: z.string().max(300).optional(),
  category: z.enum(['tours', 'food', 'outdoor', 'arts', 'fitness', 'wellness', 'music', 'sports', 'workshop', 'photography', 'other']).optional(),
  minGuests: z.number().int().min(1).optional(),
  maxGuests: z.number().int().min(1).optional(),
  pricePerChild: z.number().min(0).optional(),
  location: z.string().max(200).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  meetingPoint: z.string().max(300).optional(),
  whatsIncluded: z.array(z.string().max(120)).max(30).optional(),
  whatToBring: z.array(z.string().max(120)).max(30).optional(),
  requirements: z.string().max(2000).optional(),
  cancellationPolicy: z.string().max(500).optional(),
  imageUrls: z.array(z.string().url().max(2048)).max(20).optional(),
};

export const createExperience = defineTool({
  name: 'create_experience',
  title: 'Create an experience',
  description: 'Create a hosted experience (tour, class, guided trip) as a draft. Add schedule slots with add_experience_schedule, then set_experience_status(publish).',
  access: 'vendor',
  scope: 'experiences',
  inputSchema: {
    title: z.string().min(3).max(200),
    description: z.string().min(20).max(5000),
    duration: z.number().min(0.25).describe('Length of the experience.'),
    durationUnit: z.enum(['minutes', 'hours', 'days']),
    pricePerPerson: z.number().min(0),
    ...experienceFields,
  },
  annotations: WRITE,
  handler: async (args, ctx) => fromResult(await experienceTools.createExperience(token(ctx), args)),
});

export const updateExperience = defineTool({
  name: 'update_experience',
  title: 'Update an experience',
  description: 'Change fields of an experience the vendor hosts (only the fields you pass change).',
  access: 'vendor',
  scope: 'experiences',
  inputSchema: {
    experienceId: uuid('experience'),
    title: z.string().min(3).max(200).optional(),
    description: z.string().min(20).max(5000).optional(),
    duration: z.number().min(0.25).optional(),
    durationUnit: z.enum(['minutes', 'hours', 'days']).optional(),
    pricePerPerson: z.number().min(0).optional(),
    ...experienceFields,
  },
  annotations: WRITE_IDEMPOTENT,
  handler: async ({ experienceId, ...rest }, ctx) => {
    if (Object.values(rest).every((v) => v === undefined)) return fail('Pass at least one field to update.');
    return fromResult(await experienceTools.updateExperience(experienceId, token(ctx), rest));
  },
});

export const setExperienceStatus = defineTool({
  name: 'set_experience_status',
  title: 'Publish / archive experience',
  description: 'Publish an experience so guests can book it, or archive it to take it offline.',
  access: 'vendor',
  scope: 'experiences',
  inputSchema: { experienceId: uuid('experience'), action: z.enum(['publish', 'archive']) },
  annotations: WRITE_IDEMPOTENT,
  handler: async ({ experienceId, action }, ctx) => fromResult(await experienceTools.setExperienceStatus(experienceId, action, token(ctx))),
});

export const addExperienceSchedule = defineTool({
  name: 'add_experience_schedule',
  title: 'Add a schedule slot',
  description: 'Add a bookable date/time slot to an experience (capacity and price override optional).',
  access: 'vendor',
  scope: 'experiences',
  inputSchema: {
    experienceId: uuid('experience'),
    date: isoDate('Slot date'),
    startTime: z.string().regex(/^\d{2}:\d{2}$/).describe('HH:MM, 24h.'),
    endTime: z.string().regex(/^\d{2}:\d{2}$/).optional().describe('HH:MM, 24h.'),
    spotsTotal: z.number().int().min(0).max(100).optional(),
    customPrice: z.number().min(0).optional(),
    notes: z.string().max(500).optional(),
  },
  annotations: WRITE,
  handler: async ({ experienceId, ...input }, ctx) => fromResult(await experienceTools.addSchedule(experienceId, token(ctx), input)),
});

export const deleteExperienceSchedule = defineTool({
  name: 'delete_experience_schedule',
  title: 'Remove a schedule slot',
  description: 'Delete a schedule slot from an experience (slots with bookings may be refused by Splitt).',
  access: 'vendor',
  scope: 'experiences',
  inputSchema: { experienceId: uuid('experience'), scheduleId: uuid('schedule slot') },
  annotations: DESTRUCTIVE,
  handler: async ({ experienceId, scheduleId }, ctx) => fromResult(await experienceTools.deleteSchedule(experienceId, scheduleId, token(ctx)), () => ({ deleted: true, scheduleId })),
});

export const listExperienceHostBookings = defineTool({
  name: 'list_experience_host_bookings',
  title: 'Bookings on my experiences',
  description: 'Guest bookings on the experiences the vendor hosts (status, slot, guests, amounts).',
  access: 'vendor',
  scope: 'experiences',
  inputSchema: {},
  annotations: READ,
  handler: async (_args, ctx) => fromResult(await experienceTools.listHostBookings(token(ctx))),
});

export const updateExperienceBookingStatus = defineTool({
  name: 'update_experience_booking_status',
  title: 'Confirm / complete / cancel experience booking',
  description: 'Host actions on an experience booking: confirm a pending one, mark a confirmed one complete, or cancel it (refund handled by Splitt).',
  access: 'vendor',
  scope: 'experiences',
  inputSchema: { bookingId: uuid('experience booking'), action: z.enum(['confirm', 'complete', 'cancel']) },
  annotations: WRITE_IDEMPOTENT,
  handler: async ({ bookingId, action }, ctx) => fromResult(await experienceTools.transitionExperienceBooking(bookingId, action, token(ctx))),
});

export const vendorTools = [
  listMyListings,
  createListing,
  updateListing,
  setListingPublished,
  deleteListing,
  duplicateListing,
  generateListingDraft,
  getListingPerformance,
  listBlackoutDates,
  addBlackoutDates,
  removeBlackoutDate,
  listIncomingBookings,
  setBookingReturnStatus,
  proposeBookingReschedule,
  withdrawRescheduleProposal,
  setBookingVendorNotes,
  respondToReview,
  getVendorDashboard,
  getVendorEarnings,
  getVendorPayouts,
  getStripeConnectStatus,
  startStripeConnectOnboarding,
  listMyExperiences,
  createExperience,
  updateExperience,
  setExperienceStatus,
  addExperienceSchedule,
  deleteExperienceSchedule,
  listExperienceHostBookings,
  updateExperienceBookingStatus,
];
