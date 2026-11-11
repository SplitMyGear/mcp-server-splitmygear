/**
 * SPLIT-1887: a public read tool forwards the user's token (and so gets the
 * OWNER view: tax address, unpublished listings, moderation state) only when
 * the connection was granted the matching resource scope. A `read`-only grant
 * is answered anonymously, exactly like the operator key.
 *
 * The backend is mocked to behave like the real OptionalJwtAuthGuard routes:
 * the owner's private fields come back only when a token is sent.
 */
export {};

const mockBackendRequest = jest.fn();
jest.mock('@/lib/backend-client', () => {
  class BackendApiError extends Error {
    status: number;
    constructor(status: number, message: string) { super(message); this.name = 'BackendApiError'; this.status = status; }
  }
  return { BackendApiError, backendRequest: (...args: unknown[]) => mockBackendRequest(...args), backendBaseUrl: () => 'http://backend.test/api/v1' };
});

import { getListingDetails, getExperienceDetails } from '../src/tools/defs/discovery';
import { listListingRoutes } from '../src/tools/defs/routes';
import { ALL_TOOLS } from '../src/tools/defs';
import { ownerViewToken, type ToolContext, type ToolScope } from '../src/tools/registry';

const LISTING = '00000200-0000-0000-0000-0000000000d1';
const EXPERIENCE = '00000200-0000-0000-0000-000000000c01';
const USER_JWT = 'header.payload.sig';

const PRIVATE_LISTING_FIELDS = { taxAddressLine1: '1 Home St', taxCity: 'Austin', taxState: 'TX', taxPostalCode: '78701', moderationStatus: 'approved', isTest: true };

const notFound = (message: string) => {
  const { BackendApiError } = jest.requireMock('@/lib/backend-client') as { BackendApiError: new (status: number, message: string) => Error };
  return Promise.reject(new BackendApiError(404, message));
};

function ownerAware(_method: string, path: string, options: { token?: string } = {}) {
  const owner = typeof options.token === 'string' && options.token.length > 0;
  if (path === `/rentals/${LISTING}`) {
    // An unpublished listing: the owner sees it with private fields, anyone else gets 404.
    if (!owner) return notFound('Not found');
    return Promise.resolve({ id: LISTING, name: 'Tent', ...PRIVATE_LISTING_FIELDS });
  }
  if (path === `/rentals/${LISTING}/routes`) {
    if (!owner) return notFound('Listing not found');
    return Promise.resolve({ routes: [{ id: 'r1', source: 'library' }] });
  }
  if (path === `/packages/${EXPERIENCE}`) {
    const experience = { id: EXPERIENCE, title: 'Paddle', status: 'active', ...(owner ? { moderationStatus: 'pending', moderationReason: 'x' } : {}) };
    return Promise.resolve({ success: true, experience });
  }
  return Promise.resolve({ schedules: [] });
}

function ctx(scopes: ToolScope[] | undefined, kind: ToolContext['kind'] = 'oauth'): ToolContext {
  return { userId: 'vendor-1', role: 'vendor', token: USER_JWT, kind, scopes };
}

/** The `token` option of every backend call made so far. */
const forwardedTokens = () => mockBackendRequest.mock.calls.map((c) => (c[2] as { token?: string } | undefined)?.token);
const text = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((c) => c.text ?? '').join('');

describe('public read tools forward the user token only with the resource scope (SPLIT-1887)', () => {
  beforeEach(() => {
    mockBackendRequest.mockReset();
    mockBackendRequest.mockImplementation(ownerAware);
  });

  it('get_listing_details on a read-only grant calls the backend anonymously and returns no private fields', async () => {
    const result = await getListingDetails.handler({ listingId: LISTING }, ctx(['read']));
    expect(forwardedTokens()).toEqual([undefined]);
    expect(result.isError).toBe(true);
    expect(text(result)).not.toMatch(/taxAddressLine1|moderationStatus|isTest/);
  });

  it('get_listing_details with the listings scope forwards the token and returns the owner view', async () => {
    const result = await getListingDetails.handler({ listingId: LISTING }, ctx(['read', 'listings']));
    expect(forwardedTokens()).toEqual([USER_JWT]);
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain('taxAddressLine1');
  });

  it('get_experience_details on a read-only grant is anonymous; with experiences it is the owner view', async () => {
    const anon = await getExperienceDetails.handler({ experienceId: EXPERIENCE }, ctx(['read']));
    expect(forwardedTokens().every((t) => t === undefined)).toBe(true);
    expect(text(anon)).not.toContain('moderationStatus');

    mockBackendRequest.mockClear();
    const owner = await getExperienceDetails.handler({ experienceId: EXPERIENCE }, ctx(['read', 'experiences']));
    expect(forwardedTokens()[0]).toBe(USER_JWT);
    expect(text(owner)).toContain('moderationStatus');
  });

  it('a listings grant does not unlock the experience owner view (scopes are per resource)', async () => {
    await getExperienceDetails.handler({ experienceId: EXPERIENCE }, ctx(['read', 'listings']));
    expect(forwardedTokens().every((t) => t === undefined)).toBe(true);
  });

  it('list_listing_routes on a read-only grant is anonymous; with listings it is the owner view', async () => {
    const anon = await listListingRoutes.handler({ listingId: LISTING }, ctx(['read']));
    expect(forwardedTokens()).toEqual([undefined]);
    expect(anon.isError).toBe(true);

    mockBackendRequest.mockClear();
    const owner = await listListingRoutes.handler({ listingId: LISTING }, ctx(['read', 'listings']));
    expect(forwardedTokens()).toEqual([USER_JWT]);
    expect(owner.isError).toBeFalsy();
  });

  it('a verified raw backend JWT (every scope) and the operator key (no token) behave as before', async () => {
    await getListingDetails.handler({ listingId: LISTING }, ctx(undefined, 'jwt'));
    expect(forwardedTokens()).toEqual([USER_JWT]);
    expect(ownerViewToken({ kind: 'operator', scopes: ['read'] }, 'listings')).toBeUndefined();
  });

  it('no public tool forwards ctx.token except through ownerViewToken', () => {
    const offenders = ALL_TOOLS.filter((def) => def.access === 'public')
      .filter((def) => /ctx\.token|token\)\(ctx\)|\btoken\(ctx\)/.test(def.handler.toString()))
      .map((def) => def.name);
    expect(offenders).toEqual([]);
  });
});
