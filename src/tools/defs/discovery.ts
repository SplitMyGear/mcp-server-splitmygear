/** Public discovery tools: search, details, availability, pricing, reviews. Available to every principal. */
import { z } from 'zod';
import { defineTool, ok, fail, fromResult } from '../registry';
import { listingTools } from '../listings';
import { pricingTools } from '../pricing';
import { reviewTools } from '../reviews';
import { bookingTools } from '../bookings';
import { experienceTools } from '../experiences';
import { BackendApiError } from '@/lib/backend-client';
import { dateRangeError } from '../_shared';
import { uuid, isoDate, READ, LISTING_CATEGORIES, PROTECTION_PLANS, UNTRUSTED_NOTE } from './common';

export const searchListings = defineTool({
  name: 'search_listings',
  title: 'Search gear rentals',
  description:
    'Search Splitt gear rentals (tents, bikes, kayaks, skis, RVs, cameras…) by natural-language query and/or filters. ' +
    'Returns matching listings with id, name, category, price per day, location and rating. ' +
    'Use `query` for plain English ("lightweight 2-person tent near Seattle under $40/day"); combine with structured filters to narrow. ' +
    'Follow up with get_listing_details for full info and check_availability / get_booking_quote before booking. ' +
    UNTRUSTED_NOTE,
  access: 'public',
  scope: 'read',
  inputSchema: {
    query: z.string().max(500).optional().describe('Natural-language search (semantic). Optional.'),
    location: z.string().max(200).optional().describe('City, neighbourhood or area to search in.'),
    category: z.enum(LISTING_CATEGORIES).optional().describe('Canonical Title-Case category (see the splitmygear://categories resource).'),
    checkIn: z.string().optional().describe('Rental start date (ISO); only return gear free for these dates.'),
    checkOut: z.string().optional().describe('Rental end date (ISO).'),
    guests: z.number().int().min(1).max(200).optional().describe('Party size (for stays / capacity-limited gear).'),
    minPrice: z.number().min(0).optional().describe('Minimum price per day.'),
    maxPrice: z.number().min(0).optional().describe('Maximum price per day.'),
  },
  annotations: READ,
  handler: async (args) => {
    if (args.checkIn && args.checkOut) {
      const err = dateRangeError(args.checkIn, args.checkOut);
      if (err) return fail(err);
    }
    const results = await listingTools.searchListings(args);
    return ok({ count: results.length, listings: results });
  },
});

export const getListingDetails = defineTool({
  name: 'get_listing_details',
  title: 'Get listing details',
  description:
    'Full details for one listing: description, pricing (per day/hour, deposit, delivery, discounts), cancellation policy, ' +
    'location, images, add-ons, owner and rating. Signed-in owners also see their private fields. ' + UNTRUSTED_NOTE,
  access: 'public',
  scope: 'read',
  inputSchema: { listingId: uuid('listing') },
  annotations: READ,
  handler: async ({ listingId }, ctx) => {
    const listing = await listingTools.getListingDetails(listingId, ctx.token);
    if (!listing) return fail(`Listing ${listingId} was not found (it may be unpublished).`);
    // An owner's iCal subscription URL is a bearer secret: keep it out of transcripts.
    const { icalUrl, ...safe } = listing as Record<string, unknown> & { icalUrl?: unknown };
    return ok(icalUrl ? { ...safe, icalUrl: '[redacted: manage calendar feeds in the Splitt dashboard]' } : safe);
  },
});

export const checkAvailability = defineTool({
  name: 'check_availability',
  title: 'Check availability',
  description: 'Check whether a listing is free for a date range. Returns available:true/false with a short reason. Use before creating a booking.',
  access: 'public',
  scope: 'read',
  inputSchema: {
    listingId: uuid('listing'),
    checkIn: isoDate('Rental start date'),
    checkOut: isoDate('Rental end date'),
    guests: z.number().int().min(1).max(200).optional().default(1).describe('Party size (default 1).'),
  },
  annotations: READ,
  handler: async ({ listingId, checkIn, checkOut, guests }) => {
    const err = dateRangeError(checkIn, checkOut);
    if (err) return fail(err);
    return ok(await listingTools.checkAvailability(listingId, checkIn, checkOut, guests));
  },
});

export const getListingCalendar = defineTool({
  name: 'get_listing_calendar',
  title: 'Get availability calendar',
  description: 'Day-by-day availability for a listing over a window (max 92 days); use it to suggest alternative dates when the requested ones are taken.',
  access: 'public',
  scope: 'read',
  inputSchema: { listingId: uuid('listing'), from: isoDate('Window start'), to: isoDate('Window end') },
  annotations: READ,
  handler: async ({ listingId, from, to }) => {
    const err = dateRangeError(from, to, 92);
    if (err) return fail(err);
    try {
      return ok(await listingTools.getAvailabilityCalendar(listingId, from, to));
    } catch (error) {
      return fail(error instanceof BackendApiError ? error.message : 'Could not load the calendar');
    }
  },
});

export const getSimilarListings = defineTool({
  name: 'get_similar_listings',
  title: 'Find similar gear',
  description: 'Semantically similar listings to a given one (same kind of gear, nearby price/location). Good for alternatives when something is unavailable.',
  access: 'public',
  scope: 'read',
  inputSchema: { listingId: uuid('listing'), limit: z.number().int().min(1).max(20).optional().default(5) },
  annotations: READ,
  handler: async ({ listingId, limit }) => ok(await listingTools.getSimilarListings(listingId, limit)),
});

export const getListingReviews = defineTool({
  name: 'get_listing_reviews',
  title: 'Get listing reviews',
  description: 'Rating summary and individual reviews for a listing, including any vendor responses. ' + UNTRUSTED_NOTE,
  access: 'public',
  scope: 'read',
  inputSchema: { listingId: uuid('listing') },
  annotations: READ,
  handler: async ({ listingId }) => fromResult(await reviewTools.getListingReviews(listingId)),
});

export const getBookingQuote = defineTool({
  name: 'get_booking_quote',
  title: 'Get a price quote',
  description:
    'Server-authoritative price breakdown for a rental BEFORE booking: nightly rates, discounts, protection premium, add-ons, delivery, fees, deposit and total. ' +
    'No booking is created. Use it to show the renter what they will pay; create_booking uses the same pricing.',
  access: 'public',
  scope: 'read',
  inputSchema: {
    listingId: uuid('listing'),
    startDate: isoDate('Rental start date'),
    endDate: isoDate('Rental end date'),
    quantity: z.number().int().min(1).max(10).optional().describe('Units of this listing (default 1).'),
    numberOfGuests: z.number().int().min(1).max(200).optional(),
    protectionPlan: z.enum(PROTECTION_PLANS).optional().describe('Damage-protection plan to price in.'),
    selectedAddOns: z.array(z.object({ name: z.string().max(80), quantity: z.number().int().min(1).max(50) })).max(30).optional().describe('Add-ons from the listing, by exact name.'),
    deliveryRequested: z.boolean().optional(),
    bringingPets: z.boolean().optional(),
  },
  annotations: READ,
  handler: async (args) => {
    const err = dateRangeError(args.startDate, args.endDate);
    if (err) return fail(err);
    return fromResult(await bookingTools.getQuote(args));
  },
});

export const suggestListingPrice = defineTool({
  name: 'suggest_listing_price',
  title: 'Suggest a listing price',
  description: 'Market-based daily price suggestion for a gear category (optionally in a location): suggested price, market average/median/min/max, competitor count and confidence.',
  access: 'public',
  scope: 'read',
  inputSchema: {
    category: z.enum(LISTING_CATEGORIES).describe('Gear category.'),
    location: z.string().max(200).optional().describe('City/area for a local market read.'),
  },
  annotations: READ,
  handler: async ({ category, location }) => ok(await pricingTools.suggestListingPrice(category, location)),
});

export const analyzeCompetitorPricing = defineTool({
  name: 'analyze_competitor_pricing',
  title: 'Analyze competitor pricing',
  description: "Compare a listing's current price with the local market for its category (average, median, range, suggested price).",
  access: 'public',
  scope: 'read',
  inputSchema: { listingId: uuid('listing') },
  annotations: READ,
  handler: async ({ listingId }) => {
    try {
      return ok(await pricingTools.analyzeCompetitorPricing(listingId));
    } catch (error) {
      return fail(error instanceof BackendApiError ? error.message : 'Could not analyze pricing');
    }
  },
});

export const searchExperiences = defineTool({
  name: 'search_experiences',
  title: 'Search experiences',
  description: 'Browse guided outdoor experiences, tours, workshops and classes on Splitt (optionally by location and category). ' + UNTRUSTED_NOTE,
  access: 'public',
  scope: 'read',
  inputSchema: {
    location: z.string().max(200).optional(),
    category: z.enum(['tours', 'food', 'outdoor', 'arts', 'fitness', 'wellness', 'music', 'sports', 'workshop', 'photography', 'other']).optional(),
  },
  annotations: READ,
  handler: async (args) => {
    const results = await experienceTools.searchExperiences(args);
    return ok({ count: results.length, experiences: results });
  },
});

export const getExperienceDetails = defineTool({
  name: 'get_experience_details',
  title: 'Get experience details',
  description: 'Full details for an experience plus its upcoming schedule slots (scheduleId, date, start time, spots left, price). ' + UNTRUSTED_NOTE,
  access: 'public',
  scope: 'read',
  inputSchema: { experienceId: uuid('experience') },
  annotations: READ,
  handler: async ({ experienceId }) => {
    const details = await experienceTools.getExperienceDetails(experienceId);
    return details ? ok(details) : fail(`Experience ${experienceId} was not found.`);
  },
});

export const discoveryTools = [
  searchListings,
  getListingDetails,
  checkAvailability,
  getListingCalendar,
  getSimilarListings,
  getListingReviews,
  getBookingQuote,
  suggestListingPrice,
  analyzeCompetitorPricing,
  searchExperiences,
  getExperienceDetails,
];
