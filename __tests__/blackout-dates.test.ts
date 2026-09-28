/**
 * SPLIT-1606: blackout dates are inclusive at the tool boundary. Found in the
 * 2026-09-28 staging run with a real claude.ai client: "block March 1 to
 * March 2" stored [Mar 1, Mar 2) and left March 2 bookable, because the backend's
 * endDate is exclusive and the tool forwarded the last day unchanged.
 */
import type { ToolContext } from '../src/tools/registry';
import { isoDay, shiftDay, toInclusiveBlackout } from '../src/tools/blackout-dates';

const mockBackendRequest = jest.fn();
jest.mock('../src/lib/backend-client', () => {
  class BackendApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = 'BackendApiError';
      this.status = status;
    }
  }
  return { BackendApiError, backendRequest: (...args: unknown[]) => mockBackendRequest(...args) };
});

import { addBlackoutDates, listBlackoutDates } from '../src/tools/defs/vendor';

const LISTING = '11111111-1111-4111-8111-111111111111';
const ctx: ToolContext = { userId: 'u', role: 'vendor_owner', token: 'T', kind: 'oauth' };
const text = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((c) => c.text ?? '').join('');
const data = (r: { content: Array<{ type: string; text?: string }> }) => JSON.parse(text(r));

beforeEach(() => mockBackendRequest.mockReset());

describe('isoDay', () => {
  it.each([
    ['2028-03-02', '2028-03-02'],
    ['2028-03-02T00:00:00.000Z', '2028-03-02'],
    // As written: a vendor's local timestamp is not shifted to another UTC day.
    ['2028-03-02T23:30:00-05:00', '2028-03-02'],
    ['2028-02-29', '2028-02-29'],
  ])('%s → %s', (value, day) => expect(isoDay(value)).toBe(day));

  it.each(['2026-02-30', '2027-02-29', '2026-13-01', 'July 4, 2026', '', 20260704, null, undefined])('%p is not a day', (value) => {
    expect(isoDay(value)).toBeNull();
  });
});

describe('shiftDay', () => {
  it.each([
    ['2028-03-01', 1, '2028-03-02'],
    ['2028-02-28', 1, '2028-02-29'],
    ['2027-02-28', 1, '2027-03-01'],
    ['2027-12-31', 1, '2028-01-01'],
    ['2028-03-01', -1, '2028-02-29'],
    ['2028-01-01', -1, '2027-12-31'],
  ])('%s %+d → %s', (day, n, out) => expect(shiftDay(day, n)).toBe(out));
});

describe('toInclusiveBlackout', () => {
  it('turns a stored whole-day [start, end) into first and last blocked day, keeping the other fields', () => {
    expect(toInclusiveBlackout({ id: 'b1', startDate: '2028-03-01', endDate: '2028-03-03', type: 'unavailable', reason: 'r' })).toEqual({
      id: 'b1',
      startDate: '2028-03-01',
      endDate: '2028-03-02',
      type: 'unavailable',
      reason: 'r',
    });
    expect(toInclusiveBlackout({ startDate: '2028-03-01T00:00:00.000Z', endDate: '2028-03-02T00:00:00.000Z' })).toMatchObject({ endDate: '2028-03-01' });
  });

  it('returns timed holds, zero-width legacy rows and non-rows as stored', () => {
    const timed = { startDate: '2028-03-01', endDate: '2028-03-01', startTime: '09:00', endTime: '11:00' };
    expect(toInclusiveBlackout(timed)).toBe(timed);
    // A timed hold across midnight ends ON its endDate (02:00): shifting it would lose a day.
    const overnight = { startDate: '2028-03-01', endDate: '2028-03-02', startTime: '22:00', endTime: '02:00' };
    expect(toInclusiveBlackout(overnight)).toBe(overnight);
    const zeroWidth = { startDate: '2028-03-01', endDate: '2028-03-01' };
    expect(toInclusiveBlackout(zeroWidth)).toBe(zeroWidth);
    expect(toInclusiveBlackout(null)).toBeNull();
    const list = [{ startDate: '2028-03-01', endDate: '2028-03-02' }];
    expect(toInclusiveBlackout(list)).toBe(list);
  });
});

describe('add_blackout_dates', () => {
  it('blocks both days of "March 1 to 2": the backend gets the exclusive end, the result reads inclusive', async () => {
    mockBackendRequest.mockResolvedValue({ id: 'b1', startDate: '2028-03-01', endDate: '2028-03-03', rejectedPendingRequests: 0 });
    const result = await addBlackoutDates.handler({ listingId: LISTING, startDate: '2028-03-01', endDate: '2028-03-02', reason: 'r' }, ctx);

    const [method, path, opts] = mockBackendRequest.mock.calls[0];
    expect([method, path]).toEqual(['POST', `/rentals/${LISTING}/blackout-dates`]);
    expect(opts.body).toEqual({ startDate: '2028-03-01', endDate: '2028-03-03', reason: 'r' });
    expect(result.isError).toBeUndefined();
    expect(data(result)).toMatchObject({ id: 'b1', startDate: '2028-03-01', endDate: '2028-03-02', rejectedPendingRequests: 0 });
  });

  it('accepts a single day (startDate = endDate), which the backend used to refuse', async () => {
    mockBackendRequest.mockResolvedValue({ id: 'b2', startDate: '2028-03-01', endDate: '2028-03-02' });
    const result = await addBlackoutDates.handler({ listingId: LISTING, startDate: '2028-03-01', endDate: '2028-03-01' }, ctx);

    expect(mockBackendRequest.mock.calls[0][2].body).toEqual({ startDate: '2028-03-01', endDate: '2028-03-02' });
    expect(data(result)).toMatchObject({ startDate: '2028-03-01', endDate: '2028-03-01' });
  });

  it('sends plain days when the model passes timestamps, across a month end', async () => {
    mockBackendRequest.mockResolvedValue({ id: 'b3' });
    await addBlackoutDates.handler({ listingId: LISTING, startDate: '2028-02-28T00:00:00Z', endDate: '2028-02-29T00:00:00Z' }, ctx);
    expect(mockBackendRequest.mock.calls[0][2].body).toEqual({ startDate: '2028-02-28', endDate: '2028-03-01' });
  });

  it.each([
    [{ startDate: '2028-03-02', endDate: '2028-03-01' }, 'endDate must be on or after startDate.'],
    [{ startDate: '2026-02-30', endDate: '2026-03-01' }, 'Dates must be ISO dates such as 2026-07-04.'],
    [{ startDate: 'next friday', endDate: '2028-03-01' }, 'Dates must be ISO dates such as 2026-07-04.'],
  ])('refuses %p without calling the backend', async (dates, message) => {
    const result = await addBlackoutDates.handler({ listingId: LISTING, ...dates }, ctx);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(message);
    expect(mockBackendRequest).not.toHaveBeenCalled();
  });
});

describe('list_blackout_dates', () => {
  it('shows each whole-day block with its last blocked day, and timed holds as stored', async () => {
    mockBackendRequest.mockResolvedValue([
      { id: 'b1', startDate: '2028-03-01', endDate: '2028-03-03' },
      { id: 'b2', startDate: '2028-04-10', endDate: '2028-04-10', startTime: '09:00', endTime: '12:00' },
    ]);
    const result = await listBlackoutDates.handler({ listingId: LISTING }, ctx);

    expect(mockBackendRequest.mock.calls[0].slice(0, 2)).toEqual(['GET', `/rentals/${LISTING}/blackout-dates`]);
    expect(data(result)).toEqual([
      { id: 'b1', startDate: '2028-03-01', endDate: '2028-03-02' },
      { id: 'b2', startDate: '2028-04-10', endDate: '2028-04-10', startTime: '09:00', endTime: '12:00' },
    ]);
  });
});
