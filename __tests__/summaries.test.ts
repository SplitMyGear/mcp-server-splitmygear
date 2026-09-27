const mockBackendRequest = jest.fn();
jest.mock('../src/lib/backend-client', () => {
  const actual = jest.requireActual('../src/lib/backend-client');
  return { ...actual, backendRequest: (...args: unknown[]) => mockBackendRequest(...args) };
});

import { DESCRIPTION_PREVIEW_CHARS, ICAL_URL_REDACTED, pageOf, redactListingSecrets, summarizeBooking, summarizeListing } from '../src/tools/summaries';
import { createListing, duplicateListing, listIncomingBookings, listMyListings, setListingPublished, updateListing } from '../src/tools/defs/vendor';
import { applyDynamicPricing } from '../src/tools/defs/pricing-rules';
import { listMyBookings } from '../src/tools/defs/renter';
import { getListingDetails, searchListings } from '../src/tools/defs/discovery';
import type { ToolContext } from '../src/tools/registry';

const T = 'header.payload.sig';
const vendor: ToolContext = { userId: 'v', role: 'vendor_owner', token: T, kind: 'oauth' };
const renter: ToolContext = { userId: 'r', role: 'renter', token: T, kind: 'oauth' };
const anon = { kind: 'operator' } as ToolContext;
const text = (result: { content: Array<{ type: string; text?: string }> }) => result.content[0].text ?? '';

/** A listing shaped like the backend's (field names from a real /listings row, 2026-09-27), with production-sized text. */
function listing(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'l-1',
    name: 'Wilderness Touring Kayak',
    category: 'Kayaking',
    status: 'available',
    moderationStatus: 'approved',
    isHidden: false,
    instantBook: true,
    pricePerDay: '65.00',
    pricePerHour: null,
    depositAmount: '0.00',
    deliveryAvailable: false,
    averageRating: 4.8,
    totalReviews: 12,
    timezone: 'America/Chicago',
    location: 'St. Paul, MN',
    moderationReason: '',
    amenities: [],
    description: 'A stable 16-foot touring kayak.\n\n'.concat('Tracks straight in wind and chop, with two sealed hatches. '.repeat(40)),
    careGuide: { cleaning: 'Rinse with fresh water. '.repeat(30), storage: 'Store upside down. '.repeat(30) },
    imageUrls: Array.from({ length: 8 }, (_, i) => `https://img.example/kayak-${i}.jpg`),
    imageFocalPoints: Array.from({ length: 8 }, () => ({ x: 0.5, y: 0.5 })),
    videoUrls: ['https://video.example/kayak.mp4'],
    addOns: [{ id: 'a1', name: 'Spray skirt', price: '10.00', description: 'Keeps you dry. '.repeat(10) }],
    owner: { id: 'v', storeName: 'Lakeside Rentals', firstName: 'Olivia', lastName: 'Owner', bio: 'We rent boats. '.repeat(40), isVerified: true, averageRating: 4.9, profileImageUrl: 'https://img.example/me.jpg', memberSince: '2026-01-01' },
    ...overrides,
  };
}

function booking(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'b-1',
    status: 'confirmed',
    paymentStatus: 'paid',
    startDate: '2026-10-10',
    endDate: '2026-10-13',
    startTime: null,
    listingId: 'l-1',
    listing: listing(),
    renterId: 'r',
    renter: { id: 'r', firstName: 'Riley', lastName: 'Renter', profileImageUrl: null },
    renterCard: { disclosureTier: 'booked', isIdVerified: true, completedRentals: 3 },
    numberOfGuests: 2,
    bringingPets: false,
    quantity: 1,
    totalPrice: '195.00',
    amountDue: '0.00',
    depositAmount: '0.00',
    pendingExpiresAt: null,
    selectedAddOns: [],
    renterNotes: 'Arriving around 9',
    priceBreakdown: { perUnitBase: '65.00', discountComponents: [{ kind: 'weekly', pct: 0 }], total: '195.00' },
    coverageDetails: { deductible: '250.00', maxCoverage: '2000.00', isLiabilityIncluded: false },
    staySnapshot: null,
    unitSnapshot: null,
    vendor: null,
    ...overrides,
  };
}

describe('summarizeBooking', () => {
  it('keeps the booking fields, reduces the embedded listing to what identifies it, and drops the detail records', () => {
    const row = summarizeBooking(booking()) as Record<string, unknown>;
    expect(row.listing).toEqual({ id: 'l-1', name: 'Wilderness Touring Kayak', category: 'Kayaking', timezone: 'America/Chicago' });
    for (const gone of ['priceBreakdown', 'coverageDetails', 'staySnapshot', 'unitSnapshot', 'vendor']) expect(row).not.toHaveProperty(gone);
    expect(row).toMatchObject({
      id: 'b-1',
      status: 'confirmed',
      paymentStatus: 'paid',
      startDate: '2026-10-10',
      endDate: '2026-10-13',
      totalPrice: '195.00',
      renter: { id: 'r', firstName: 'Riley', lastName: 'Renter', profileImageUrl: null },
      renterCard: { disclosureTier: 'booked', isIdVerified: true, completedRentals: 3 },
      renterNotes: 'Arriving around 9',
    });
  });

  it('drops empty values but keeps false and 0, which are answers', () => {
    const row = summarizeBooking(booking({ quantity: 0 })) as Record<string, unknown>;
    expect(row).not.toHaveProperty('startTime');
    expect(row).not.toHaveProperty('pendingExpiresAt');
    expect(row).not.toHaveProperty('selectedAddOns');
    expect(row.bringingPets).toBe(false);
    expect(row.quantity).toBe(0);
  });

  it('passes fields it does not know through unchanged', () => {
    expect(summarizeBooking(booking({ newBackendField: { a: 1 } }))).toHaveProperty('newBackendField', { a: 1 });
  });

  it('omits the listing when the booking carries none, and leaves non-objects alone', () => {
    expect(summarizeBooking(booking({ listing: null }))).not.toHaveProperty('listing');
    expect(summarizeBooking('not a booking')).toBe('not a booking');
    expect(summarizeBooking(null)).toBeNull();
  });

  it('is a fraction of the full row', () => {
    const full = JSON.stringify(booking()).length;
    const summary = JSON.stringify(summarizeBooking(booking())).length;
    expect(summary / full).toBeLessThan(0.15);
  });
});

describe('summarizeListing', () => {
  it('replaces long text and media with a preview and counts, under names that cannot be mistaken for the full value', () => {
    const row = summarizeListing(listing()) as Record<string, unknown>;
    for (const gone of ['description', 'careGuide', 'imageUrls', 'imageFocalPoints', 'videoUrls', 'addOns']) expect(row).not.toHaveProperty(gone);
    expect(row).toMatchObject({ imageCount: 8, firstImageUrl: 'https://img.example/kayak-0.jpg', videoCount: 1, addOnCount: 1 });
    const preview = row.descriptionPreview as string;
    expect(preview.startsWith('A stable 16-foot touring kayak. Tracks straight')).toBe(true);
    expect(preview).not.toMatch(/\n/);
    expect(preview.length).toBeLessThanOrEqual(DESCRIPTION_PREVIEW_CHARS);
    expect(preview.endsWith('…')).toBe(true);
  });

  it('keeps the vendor as a short identity, never the profile', () => {
    expect((summarizeListing(listing()) as Record<string, unknown>).owner).toEqual({
      id: 'v',
      storeName: 'Lakeside Rentals',
      firstName: 'Olivia',
      isVerified: true,
      averageRating: 4.9,
    });
  });

  it('keeps every scalar a list is scanned for, including false', () => {
    expect(summarizeListing(listing())).toMatchObject({
      id: 'l-1',
      name: 'Wilderness Touring Kayak',
      category: 'Kayaking',
      status: 'available',
      moderationStatus: 'approved',
      isHidden: false,
      instantBook: true,
      pricePerDay: '65.00',
      depositAmount: '0.00',
      deliveryAvailable: false,
      averageRating: 4.8,
      totalReviews: 12,
      location: 'St. Paul, MN',
    });
  });

  it('keeps a short description whole and never cuts a character in half', () => {
    expect(summarizeListing(listing({ description: '  Two-person   tent.  ' }))).toHaveProperty('descriptionPreview', 'Two-person tent.');
    const emoji = '🛶'.repeat(DESCRIPTION_PREVIEW_CHARS + 5);
    const preview = (summarizeListing(listing({ description: emoji })) as Record<string, unknown>).descriptionPreview as string;
    expect(Array.from(preview).every((ch) => ch === '🛶' || ch === '…')).toBe(true);
  });

  it('adds nothing for missing media or description', () => {
    const row = summarizeListing(listing({ description: null, imageUrls: [], videoUrls: null, addOns: [], owner: null })) as Record<string, unknown>;
    for (const gone of ['descriptionPreview', 'imageCount', 'firstImageUrl', 'videoCount', 'addOnCount', 'owner']) expect(row).not.toHaveProperty(gone);
  });

  it('is a fraction of the full row', () => {
    const full = JSON.stringify(listing()).length;
    expect(JSON.stringify(summarizeListing(listing())).length / full).toBeLessThan(0.25);
  });
});

describe('pageOf', () => {
  const rows = [{ status: 'pending' }, { status: 'confirmed' }, { status: 'pending' }];
  it('filters the page by status and names the list', () => {
    expect(pageOf('bookings', rows, { limit: 50, offset: 0, status: 'pending' }, (r) => r)).toEqual({ count: 2, bookings: [{ status: 'pending' }, { status: 'pending' }] });
  });
  it('says where the next page starts when this one came back full, since a status filter cannot see it', () => {
    expect(pageOf('bookings', rows, { limit: 3, offset: 6, status: 'pending' }, (r) => r)).toMatchObject({ count: 2, nextOffset: 9 });
    expect(pageOf('bookings', rows, { limit: 4, offset: 0 }, (r) => r)).not.toHaveProperty('nextOffset');
  });
  it('treats a non-list answer as an empty page', () => {
    expect(pageOf('bookings', { unexpected: true }, { limit: 50, offset: 0 }, (r) => r)).toEqual({ count: 0, bookings: [] });
  });
});

describe('list tools return summary rows', () => {
  beforeEach(() => mockBackendRequest.mockReset());

  it('list_incoming_bookings summarizes each booking and pages', async () => {
    mockBackendRequest.mockResolvedValueOnce([booking(), booking({ id: 'b-2', status: 'pending' })]);
    const result = await listIncomingBookings.handler({ limit: 2, offset: 0, status: 'pending' }, vendor);
    expect(mockBackendRequest).toHaveBeenCalledWith('GET', '/bookings/for-my-listings?limit=2&offset=0', expect.objectContaining({ token: T }));
    const body = JSON.parse(text(result));
    expect(body).toMatchObject({ count: 1, nextOffset: 2 });
    expect(body.bookings[0]).toMatchObject({ id: 'b-2', listing: { id: 'l-1', name: 'Wilderness Touring Kayak' } });
    expect(body.bookings[0]).not.toHaveProperty('priceBreakdown');
  });

  it('list_my_bookings summarizes the renter\'s bookings', async () => {
    mockBackendRequest.mockResolvedValueOnce([booking()]);
    const body = JSON.parse(text(await listMyBookings.handler({ limit: 50, offset: 0 }, renter)));
    expect(body.count).toBe(1);
    expect(body.bookings[0].listing).toEqual({ id: 'l-1', name: 'Wilderness Touring Kayak', category: 'Kayaking', timezone: 'America/Chicago' });
  });

  it('list_my_listings summarizes each listing', async () => {
    mockBackendRequest.mockResolvedValueOnce([listing()]);
    const body = JSON.parse(text(await listMyListings.handler({}, vendor)));
    expect(body[0]).toMatchObject({ id: 'l-1', imageCount: 8 });
    expect(body[0]).not.toHaveProperty('description');
  });

  it('search_listings summarizes each match', async () => {
    mockBackendRequest.mockResolvedValueOnce({ data: [listing()] });
    const body = JSON.parse(text(await searchListings.handler({ query: 'kayak' }, anon)));
    expect(body.count).toBe(1);
    expect(body.listings[0]).toMatchObject({ id: 'l-1', owner: { storeName: 'Lakeside Rentals' } });
    expect(body.listings[0]).not.toHaveProperty('careGuide');
  });
});

describe('listing secrets never reach a transcript', () => {
  const FEED = 'https://calendar.example/ical/secret-token-123.ics';
  beforeEach(() => mockBackendRequest.mockReset());

  it('redactListingSecrets replaces the iCal URL with a note, drops an empty one, and reaches a wrapped listing', () => {
    expect(redactListingSecrets({ id: 'l-1', icalUrl: FEED })).toEqual({ id: 'l-1', icalUrl: ICAL_URL_REDACTED });
    expect(redactListingSecrets({ id: 'l-1', icalUrl: null })).toEqual({ id: 'l-1' });
    expect(redactListingSecrets({ id: 'l-1' })).toEqual({ id: 'l-1' });
    expect(redactListingSecrets({ applied: 3, listing: { id: 'l-1', icalUrl: FEED } })).toEqual({ applied: 3, listing: { id: 'l-1', icalUrl: ICAL_URL_REDACTED } });
    expect(redactListingSecrets([{ icalUrl: FEED }])).toEqual([{ icalUrl: FEED }]); // not a listing record: untouched
  });

  it('summary rows carry the note, never the URL', () => {
    expect(summarizeListing(listing({ icalUrl: FEED }))).toHaveProperty('icalUrl', ICAL_URL_REDACTED);
  });

  const cases: Array<[string, () => Promise<{ content: Array<{ type: string; text?: string }> }>]> = [
    ['list_my_listings', async () => listMyListings.handler({}, vendor)],
    ['get_listing_details', async () => getListingDetails.handler({ listingId: '00000000-0000-4000-8000-000000000001' }, vendor)],
    ['create_listing', async () => createListing.handler({ name: 'Kayak', description: 'A stable touring kayak for lakes.', pricePerDay: 65 }, vendor)],
    ['update_listing', async () => updateListing.handler({ listingId: '00000000-0000-4000-8000-000000000001', pricePerDay: 70 }, vendor)],
    ['set_listing_published', async () => setListingPublished.handler({ listingId: '00000000-0000-4000-8000-000000000001', published: true }, vendor)],
    ['duplicate_listing', async () => duplicateListing.handler({ listingId: '00000000-0000-4000-8000-000000000001' }, vendor)],
    ['apply_dynamic_pricing', async () => applyDynamicPricing.handler({ listingId: '00000000-0000-4000-8000-000000000001' }, vendor)],
    ['apply_dynamic_pricing (bulk)', async () => applyDynamicPricing.handler({ listingId: '00000000-0000-4000-8000-000000000001', bulk: true }, vendor)],
  ];
  it.each(cases)('%s answers without the iCal URL', async (name, run) => {
    const record = listing({ icalUrl: FEED });
    const reply = name === 'list_my_listings' ? [record] : name.endsWith('(bulk)') ? { applied: 1, listing: record } : record;
    mockBackendRequest.mockResolvedValue(reply);
    const out = text(await run());
    expect(out).not.toContain('secret-token-123');
    expect(out).toContain(ICAL_URL_REDACTED);
  });
});
