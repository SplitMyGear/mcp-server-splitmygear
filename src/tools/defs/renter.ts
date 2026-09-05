/** Signed-in user tools: profile, notifications, rental + experience bookings, reviews, favorites, messaging. */
import { z } from 'zod';
import { defineTool, ok, fail, fromResult } from '../registry';
import { accountTools } from '../account';
import { bookingTools } from '../bookings';
import { reviewTools } from '../reviews';
import { favoriteTools } from '../favorites';
import { messagingTools } from '../messaging';
import { experienceTools } from '../experiences';
import { listingTools } from '../listings';
import { contentTools } from '../content';
import { dateRangeError } from '../_shared';
import { uuid, isoDate, pagination, READ, WRITE, WRITE_IDEMPOTENT, DESTRUCTIVE, PROTECTION_PLANS, UNTRUSTED_NOTE, token } from './common';

// ── Account ──────────────────────────────────────────────────────────────────

export const getMyProfile = defineTool({
  name: 'get_my_profile',
  title: 'Who am I',
  description:
    'The signed-in Splitt account: id, name, email, role (renter / vendor family / admin), vendor onboarding status and profile fields. ' +
    'Call this first when you need to know who you are acting as or which tools apply.',
  access: 'user',
  scope: 'profile',
  inputSchema: {},
  annotations: READ,
  handler: async (_args, ctx) => fromResult(await accountTools.getMyProfile(token(ctx)), (profile) => ({ principal: { userId: ctx.userId, role: ctx.role, authenticatedVia: ctx.kind }, profile })),
});

export const updateMyProfile = defineTool({
  name: 'update_my_profile',
  title: 'Update my profile',
  description: 'Update the signed-in user\'s profile. Only the fields you pass are changed. Vendors may also set their store name/description and business phone/address.',
  access: 'user',
  scope: 'profile',
  inputSchema: {
    firstName: z.string().min(1).max(100).optional(),
    lastName: z.string().min(1).max(100).optional(),
    phone: z.string().max(40).optional(),
    bio: z.string().max(1000).optional(),
    profileImageUrl: z.string().url().max(2048).optional(),
    dateOfBirth: z.string().max(40).optional().describe('ISO date; must be 13+.'),
    storeName: z.string().max(120).optional().describe('Vendors only.'),
    storeDescription: z.string().max(2000).optional().describe('Vendors only.'),
    businessPhone: z.string().max(40).optional().describe('Vendors only.'),
    businessAddress: z.string().max(300).optional().describe('Vendors only.'),
  },
  annotations: WRITE_IDEMPOTENT,
  handler: async (args, ctx) => {
    if (Object.values(args).every((v) => v === undefined)) return fail('Pass at least one field to update.');
    return fromResult(await accountTools.updateMyProfile(token(ctx), args));
  },
});

export const getVendorOnboardingStatus = defineTool({
  name: 'get_vendor_onboarding_status',
  title: 'Vendor onboarding status',
  description: 'Where the signed-in user is in the become-a-vendor pipeline (not_started → applied → profile → Stripe → waiver → admin review → active) and what to do next at https://go-splitt.com/vendor/onboarding.',
  access: 'user',
  scope: 'profile',
  inputSchema: {},
  annotations: READ,
  handler: async (_args, ctx) => fromResult(await accountTools.getVendorOnboardingStatus(token(ctx))),
});

export const listNotifications = defineTool({
  name: 'list_notifications',
  title: 'List notifications',
  description: 'The signed-in user\'s in-app notifications (booking updates, messages, payouts…), newest first.',
  access: 'user',
  scope: 'profile',
  inputSchema: { ...pagination },
  annotations: READ,
  handler: async ({ limit, offset }, ctx) => fromResult(await accountTools.listNotifications(token(ctx), limit ?? 25, offset ?? 0)),
});

export const markNotificationsRead = defineTool({
  name: 'mark_notifications_read',
  title: 'Mark notifications read',
  description: 'Mark one notification (by id) or all notifications as read.',
  access: 'user',
  scope: 'profile',
  inputSchema: { notificationId: z.string().uuid().optional().describe('Omit to mark ALL notifications read.') },
  annotations: WRITE_IDEMPOTENT,
  handler: async ({ notificationId }, ctx) =>
    fromResult(notificationId ? await accountTools.markNotificationRead(token(ctx), notificationId) : await accountTools.markAllNotificationsRead(token(ctx))),
});

export const getUnreadCounts = defineTool({
  name: 'get_unread_counts',
  title: 'Unread counts',
  description: 'How many unread chat messages (total and per conversation) and unread notifications the signed-in user has. Cheap; good for "anything new?".',
  access: 'user',
  scope: 'profile',
  inputSchema: {},
  annotations: READ,
  handler: async (_args, ctx) => ok(await accountTools.getUnreadCounts(token(ctx))),
});

// ── Rental bookings ──────────────────────────────────────────────────────────

export const createBooking = defineTool({
  name: 'create_booking',
  title: 'Book gear',
  description:
    'Create a rental booking for the signed-in renter. Splitt prices it server-side (same as get_booking_quote) and creates a DRAFT that is only confirmed once paid. ' +
    'By default this also opens Stripe Checkout and returns `paymentUrl`; give that link to the renter to complete payment (never collect card details yourself). ' +
    'Check availability first. Vendors cannot book rentals.',
  access: 'renter',
  scope: 'bookings',
  inputSchema: {
    listingId: uuid('listing'),
    checkIn: isoDate('Rental start date'),
    checkOut: isoDate('Rental end date'),
    protectionPlan: z.enum(PROTECTION_PLANS).optional().describe('Damage-protection plan (default none). Can be changed with set_booking_protection before paying.'),
    quantity: z.number().int().min(1).max(10).optional().describe('Units of this listing (default 1).'),
    numberOfGuests: z.number().int().min(1).max(200).optional(),
    selectedAddOns: z.array(z.object({ name: z.string().max(80), quantity: z.number().int().min(1).max(50) })).max(30).optional(),
    deliveryRequested: z.boolean().optional().describe('Ask for delivery (only if the listing offers it).'),
    promoCode: z.string().max(40).optional(),
    bringingPets: z.boolean().optional(),
    withPaymentLink: z.boolean().optional().default(true).describe('Also open Stripe Checkout and return paymentUrl (default true).'),
  },
  annotations: WRITE,
  handler: async (args, ctx) => {
    const err = dateRangeError(args.checkIn, args.checkOut);
    if (err) return fail(err);
    const result = await bookingTools.createBooking({ ...args, token: token(ctx) });
    if (!result.success) return fail(result.error ?? 'Failed to create booking');
    return ok({
      booking: result.booking,
      quote: result.quote,
      paymentUrl: result.paymentUrl,
      paymentError: result.paymentError,
      nextStep: result.paymentUrl
        ? 'Send the renter to paymentUrl to pay; the booking confirms automatically after payment.'
        : 'Use get_payment_link to open Stripe Checkout when the renter is ready to pay.',
    });
  },
});

export const getPaymentLink = defineTool({
  name: 'get_payment_link',
  title: 'Get payment link',
  description: 'Open (or re-open) Stripe Checkout for an unpaid rental booking and return the URL the renter must visit to pay. Only the booking\'s renter can do this.',
  access: 'renter',
  scope: 'bookings',
  inputSchema: { bookingId: uuid('booking') },
  annotations: WRITE_IDEMPOTENT,
  handler: async ({ bookingId }, ctx) => fromResult(await bookingTools.createCheckoutSession(bookingId, token(ctx)), (d) => ({ paymentUrl: d.checkoutUrl, sessionId: d.sessionId })),
});

export const setBookingProtection = defineTool({
  name: 'set_booking_protection',
  title: 'Set protection plan',
  description: 'Choose the damage-protection plan (none / basic / standard / premier) on a booking before it is paid. Returns the updated booking and total.',
  access: 'user',
  scope: 'bookings',
  inputSchema: { bookingId: uuid('booking'), plan: z.enum(PROTECTION_PLANS) },
  annotations: WRITE_IDEMPOTENT,
  handler: async ({ bookingId, plan }, ctx) => fromResult(await bookingTools.setProtectionPlan(bookingId, plan, token(ctx))),
});

export const listMyBookings = defineTool({
  name: 'list_my_bookings',
  title: 'List my bookings',
  description: 'Rental bookings the signed-in user made as a renter (status, dates, listing, price, deposit/verification state). Vendors: use list_incoming_bookings for bookings on your listings.',
  access: 'user',
  scope: 'bookings',
  inputSchema: {
    ...pagination,
    status: z.enum(['pending', 'confirmed', 'cancelled', 'completed', 'rejected']).optional().describe('Filter by status (client-side).'),
  },
  annotations: READ,
  handler: async ({ limit, offset, status }, ctx) =>
    fromResult(await bookingTools.listMyBookings(token(ctx), limit ?? 50, offset ?? 0), (bookings) => {
      const list = Array.isArray(bookings) ? bookings : [];
      const filtered = status ? list.filter((b) => (b as { status?: string })?.status === status) : list;
      return { count: filtered.length, bookings: filtered };
    }),
});

export const getBookingStatus = defineTool({
  name: 'get_booking_status',
  title: 'Get booking',
  description: 'Full details and current status of one booking (renter, vendor or admin only).',
  access: 'user',
  scope: 'bookings',
  inputSchema: { bookingId: uuid('booking') },
  annotations: READ,
  handler: async ({ bookingId }, ctx) => {
    const result = await bookingTools.getBookingStatus(bookingId, token(ctx));
    return result.success ? ok(result.booking) : fail(result.error ?? 'Failed to fetch booking');
  },
});

export const getBookingHistory = defineTool({
  name: 'get_booking_history',
  title: 'Booking timeline',
  description: 'Status-change timeline for a booking (who changed what, when).',
  access: 'user',
  scope: 'bookings',
  inputSchema: { bookingId: uuid('booking') },
  annotations: READ,
  handler: async ({ bookingId }, ctx) => fromResult(await bookingTools.getHistory(bookingId, token(ctx))),
});

export const previewCancellation = defineTool({
  name: 'preview_cancellation',
  title: 'Preview cancellation refund',
  description: 'What the renter would get back if they cancelled now, per the listing\'s cancellation policy. Always show this before cancel_booking.',
  access: 'user',
  scope: 'bookings',
  inputSchema: { bookingId: uuid('booking') },
  annotations: READ,
  handler: async ({ bookingId }, ctx) => fromResult(await bookingTools.previewCancellation(bookingId, token(ctx))),
});

export const cancelBooking = defineTool({
  name: 'cancel_booking',
  title: 'Cancel booking',
  description:
    'Cancel a rental booking. Renters get the policy-based refund (see preview_cancellation first and confirm with the user). ' +
    'Vendors may cancel bookings on their listings; passing reason "severe_weather" records a weather cancellation.',
  access: 'user',
  scope: 'bookings',
  inputSchema: {
    bookingId: uuid('booking'),
    reason: z.enum(['severe_weather']).optional().describe('Vendor/admin only.'),
  },
  annotations: DESTRUCTIVE,
  handler: async ({ bookingId, reason }, ctx) => {
    const result = await bookingTools.cancelBooking(bookingId, token(ctx), reason);
    return result.success ? ok({ message: result.message, booking: result.booking }) : fail(result.error ?? 'Failed to cancel booking');
  },
});

export const respondToRescheduleProposal = defineTool({
  name: 'respond_to_reschedule_proposal',
  title: 'Respond to reschedule proposal',
  description: 'Accept or decline new dates a vendor proposed for the renter\'s booking. Declining CANCELS the booking with a full refund; confirm with the user first.',
  access: 'user',
  scope: 'bookings',
  inputSchema: { bookingId: uuid('booking'), action: z.enum(['accept', 'decline']) },
  annotations: DESTRUCTIVE,
  handler: async ({ bookingId, action }, ctx) => fromResult(await bookingTools.respondToRescheduleProposal(bookingId, action, token(ctx))),
});

export const getPersonalizedRecommendations = defineTool({
  name: 'get_personalized_recommendations',
  title: 'Recommendations for me',
  description: 'Gear recommendations based on the signed-in user\'s booking history and interests.',
  access: 'user',
  scope: 'read',
  inputSchema: { limit: z.number().int().min(1).max(50).optional().default(5) },
  annotations: READ,
  handler: async ({ limit }, ctx) => ok(await listingTools.getPersonalizedRecommendations(token(ctx), limit)),
});

// ── Experiences (guest side) ─────────────────────────────────────────────────

export const bookExperience = defineTool({
  name: 'book_experience',
  title: 'Book an experience',
  description:
    'Reserve spots on an experience (optionally a specific schedule slot from get_experience_details) for the signed-in user. ' +
    'Returns the booking and, by default, a Stripe Checkout `paymentUrl` for the guest to pay.',
  access: 'user',
  scope: 'bookings',
  inputSchema: {
    experienceId: uuid('experience'),
    scheduleId: z.string().uuid().optional().describe('A schedule slot id from get_experience_details.'),
    guests: z.number().int().min(1).max(50).describe('Number of adult guests.'),
    children: z.number().int().min(0).max(50).optional(),
    guestNotes: z.string().max(1000).optional(),
    isPrivateGroup: z.boolean().optional(),
    withPaymentLink: z.boolean().optional().default(true),
  },
  annotations: WRITE,
  handler: async (args, ctx) => {
    const result = await experienceTools.bookExperience({ ...args, token: token(ctx) });
    return result.success ? ok(result) : fail(result.error ?? 'Failed to book experience');
  },
});

export const listMyExperienceBookings = defineTool({
  name: 'list_my_experience_bookings',
  title: 'My experience bookings',
  description: 'Experience/tour bookings the signed-in user made as a guest.',
  access: 'user',
  scope: 'bookings',
  inputSchema: {},
  annotations: READ,
  handler: async (_args, ctx) => fromResult(await experienceTools.listMyExperienceBookings(token(ctx))),
});

export const getExperienceBooking = defineTool({
  name: 'get_experience_booking',
  title: 'Get experience booking',
  description: 'Details of one experience booking (guest or host).',
  access: 'user',
  scope: 'bookings',
  inputSchema: { bookingId: uuid('experience booking') },
  annotations: READ,
  handler: async ({ bookingId }, ctx) => fromResult(await experienceTools.getExperienceBooking(bookingId, token(ctx))),
});

export const cancelExperienceBooking = defineTool({
  name: 'cancel_experience_booking',
  title: 'Cancel experience booking',
  description: 'Cancel an experience booking (guest, or host for bookings on their experiences). Confirm with the user first.',
  access: 'user',
  scope: 'bookings',
  inputSchema: { bookingId: uuid('experience booking') },
  annotations: DESTRUCTIVE,
  handler: async ({ bookingId }, ctx) => fromResult(await experienceTools.transitionExperienceBooking(bookingId, 'cancel', token(ctx))),
});

// ── Reviews ──────────────────────────────────────────────────────────────────

export const createReview = defineTool({
  name: 'create_review',
  title: 'Write a review',
  description:
    'Leave a review after a completed rental: type "listing" (renter reviews the gear/vendor; pass listingId) or "user" (vendor reviews the renter; pass reviewedUserId). ' +
    'Rating 1–5 plus an optional comment. Eligibility (a completed booking) is checked by Splitt.',
  access: 'user',
  scope: 'reviews',
  inputSchema: {
    type: z.enum(['listing', 'user']),
    listingId: z.string().uuid().optional(),
    reviewedUserId: z.string().uuid().optional(),
    rating: z.number().int().min(1).max(5),
    comment: z.string().max(2000).optional(),
  },
  annotations: WRITE,
  handler: async (args, ctx) => {
    if (args.type === 'listing' && !args.listingId) return fail('listingId is required for a listing review.');
    if (args.type === 'user' && !args.reviewedUserId) return fail('reviewedUserId is required for a user review.');
    return fromResult(await reviewTools.createReview(token(ctx), args));
  },
});

export const listMyReviews = defineTool({
  name: 'list_my_reviews',
  title: 'My reviews',
  description: 'Reviews the signed-in user has written (editable with update_review / delete_review).',
  access: 'user',
  scope: 'reviews',
  inputSchema: {},
  annotations: READ,
  handler: async (_args, ctx) => fromResult(await reviewTools.listMyReviews(token(ctx))),
});

export const updateReview = defineTool({
  name: 'update_review',
  title: 'Edit my review',
  description: 'Change the rating and/or comment of a review the signed-in user wrote.',
  access: 'user',
  scope: 'reviews',
  inputSchema: { reviewId: uuid('review'), rating: z.number().int().min(1).max(5).optional(), comment: z.string().max(2000).optional() },
  annotations: WRITE_IDEMPOTENT,
  handler: async ({ reviewId, rating, comment }, ctx) => {
    if (rating === undefined && comment === undefined) return fail('Pass a new rating and/or comment.');
    return fromResult(await reviewTools.updateReview(token(ctx), reviewId, { rating, comment }));
  },
});

export const deleteReview = defineTool({
  name: 'delete_review',
  title: 'Delete my review',
  description: 'Permanently delete a review the signed-in user wrote. Confirm with the user first.',
  access: 'user',
  scope: 'reviews',
  inputSchema: { reviewId: uuid('review') },
  annotations: DESTRUCTIVE,
  handler: async ({ reviewId }, ctx) => fromResult(await reviewTools.deleteReview(token(ctx), reviewId), () => ({ deleted: true, reviewId })),
});

// ── Favorites ────────────────────────────────────────────────────────────────

export const listFavorites = defineTool({
  name: 'list_favorites',
  title: 'My favorites',
  description: 'Listings the signed-in user has saved to their wishlist.',
  access: 'user',
  scope: 'favorites',
  inputSchema: {},
  annotations: READ,
  handler: async (_args, ctx) => fromResult(await favoriteTools.list(token(ctx)), (d) => d?.favorites ?? d),
});

export const toggleFavorite = defineTool({
  name: 'toggle_favorite',
  title: 'Save / unsave listing',
  description: 'Add a listing to the signed-in user\'s favorites, or remove it if already saved. Returns isFavorite.',
  access: 'user',
  scope: 'favorites',
  inputSchema: { listingId: uuid('listing') },
  annotations: WRITE_IDEMPOTENT,
  handler: async ({ listingId }, ctx) => fromResult(await favoriteTools.toggle(token(ctx), listingId)),
});

// ── Messaging ────────────────────────────────────────────────────────────────

export const getConversations = defineTool({
  name: 'get_conversations',
  title: 'List conversations',
  description: 'The signed-in user\'s chat conversations (with vendors or renters), most recent first, with participants and unread state. ' + UNTRUSTED_NOTE,
  access: 'user',
  scope: 'messaging',
  inputSchema: {},
  annotations: READ,
  handler: async (_args, ctx) => ok(await messagingTools.getConversations(token(ctx))),
});

export const getConversationMessages = defineTool({
  name: 'get_conversation_messages',
  title: 'Read a conversation',
  description: 'Messages in one of the signed-in user\'s conversations, oldest first. Pass `since` (ISO timestamp) to fetch only newer messages. ' + UNTRUSTED_NOTE,
  access: 'user',
  scope: 'messaging',
  inputSchema: { conversationId: uuid('conversation'), since: z.string().optional().describe('ISO timestamp cursor.') },
  annotations: READ,
  handler: async ({ conversationId, since }, ctx) => fromResult(await messagingTools.getMessages(conversationId, token(ctx), since)),
});

export const sendMessage = defineTool({
  name: 'send_message',
  title: 'Send a message',
  description:
    'Send a chat message as the signed-in user to another Splitt user (a vendor\'s ownerId from a listing, or a renter from a booking). ' +
    'Reuses the existing conversation with that person, or starts one; pass listingId/bookingId to give the new conversation context. Never send content the user did not ask you to send.',
  access: 'user',
  scope: 'messaging',
  inputSchema: {
    recipientId: uuid('recipient user'),
    content: z.string().min(1).max(5000),
    conversationId: z.string().uuid().optional().describe('Existing conversation to post into (skips lookup).'),
    listingId: z.string().uuid().optional().describe('Listing the conversation is about (new conversations only).'),
    bookingId: z.string().uuid().optional().describe('Booking the conversation is about (new conversations only).'),
  },
  annotations: WRITE,
  handler: async (args, ctx) => {
    const result = await messagingTools.sendMessage({ ...args, token: token(ctx) });
    return result.success ? ok({ conversationId: result.conversationId, message: result.message }) : fail(result.error ?? 'Failed to send message');
  },
});

export const markConversationRead = defineTool({
  name: 'mark_conversation_read',
  title: 'Mark conversation read',
  description: 'Mark every message in a conversation as read for the signed-in user.',
  access: 'user',
  scope: 'messaging',
  inputSchema: { conversationId: uuid('conversation') },
  annotations: WRITE_IDEMPOTENT,
  handler: async ({ conversationId }, ctx) => fromResult(await messagingTools.markConversationRead(conversationId, token(ctx)), () => ({ conversationId, read: true })),
});

export const generateAiMessageDraft = defineTool({
  name: 'generate_ai_message_draft',
  title: 'Draft a message',
  description: 'Have Splitt\'s AI draft a message for the signed-in user to review before sending (e.g. a polite delay notice, a pickup reminder). Nothing is sent.',
  access: 'user',
  scope: 'messaging',
  inputSchema: {
    context: z.string().min(1).max(4000).describe('What the message should say / respond to.'),
    userRole: z.enum(['renter', 'vendor']).describe('Who is writing.'),
    tone: z.string().max(40).optional().default('professional'),
  },
  annotations: READ,
  handler: async ({ context, userRole, tone }, ctx) => ok(await messagingTools.generateAIDraft(context, userRole, tone, token(ctx))),
});

// ── AI content helpers (any signed-in user; the backend gates /ai/* with JWT) ──

export const generateListingDescription = defineTool({
  name: 'generate_listing_description',
  title: 'Generate listing description',
  description: 'AI-written listing description from an item name, category and key features. Returns text for the vendor to review and use in create_listing / update_listing.',
  access: 'user',
  scope: 'listings',
  inputSchema: {
    name: z.string().min(1).max(200),
    category: z.string().max(60),
    keywords: z.array(z.string().max(80)).max(30).describe('Key features / specs.'),
  },
  annotations: READ,
  handler: async ({ name, category, keywords }, ctx) => ok(await contentTools.generateListingDescription(name, category, keywords, token(ctx))),
});

export const improveListingTitle = defineTool({
  name: 'improve_listing_title',
  title: 'Improve listing title',
  description: 'AI-suggested, search-friendly rewrite of a listing title.',
  access: 'user',
  scope: 'listings',
  inputSchema: { currentTitle: z.string().min(1).max(200) },
  annotations: READ,
  handler: async ({ currentTitle }, ctx) => ok(await contentTools.improveListingTitle(currentTitle, token(ctx))),
});

export const renterTools = [
  getMyProfile,
  updateMyProfile,
  getVendorOnboardingStatus,
  listNotifications,
  markNotificationsRead,
  getUnreadCounts,
  createBooking,
  getPaymentLink,
  setBookingProtection,
  listMyBookings,
  getBookingStatus,
  getBookingHistory,
  previewCancellation,
  cancelBooking,
  respondToRescheduleProposal,
  getPersonalizedRecommendations,
  bookExperience,
  listMyExperienceBookings,
  getExperienceBooking,
  cancelExperienceBooking,
  createReview,
  listMyReviews,
  updateReview,
  deleteReview,
  listFavorites,
  toggleFavorite,
  getConversations,
  getConversationMessages,
  sendMessage,
  markConversationRead,
  generateAiMessageDraft,
  generateListingDescription,
  improveListingTitle,
];
