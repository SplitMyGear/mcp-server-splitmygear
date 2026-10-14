/** Contract tests for the Gear Guide tool defs and client (SPLIT-1741): mocked fetch layer, no live calls. */
export {};

import { z } from 'zod';

const mockBackendRequest = jest.fn();
jest.mock('../src/lib/backend-client', () => {
  class BackendApiError extends Error {
    status: number;
    constructor(status: number, message: string) { super(message); this.name = 'BackendApiError'; this.status = status; }
  }
  return { BackendApiError, backendRequest: (...args: unknown[]) => mockBackendRequest(...args) };
});

import {
  gearGuideTools,
  listGearGuideTopics,
  askGearGuide,
  gearGuideStatus,
  addGearGuideNote,
  listGearGuideGaps,
  answerGearGuideGap,
  uploadGearManual,
} from '../src/tools/defs/gear-guide';
import { ALL_TOOLS } from '../src/tools/defs';
import { isToolVisible, hasScope } from '../src/tools/registry';
import { topicSlugFrom, noteTitle } from '../src/tools/gear-guide';

const T = 'h.p.s';
const B = '11111111-1111-4111-8111-111111111111';
const L = '22222222-2222-4222-8222-222222222222';
const G = '33333333-3333-4333-8333-333333333333';
const M = '44444444-4444-4444-8444-444444444444';
const vendor = { token: T, role: 'vendor' };
const renter = { token: T, role: 'renter' };
const { BackendApiError } = jest.requireMock('../src/lib/backend-client');

const calls = () => mockBackendRequest.mock.calls.map((c) => ({ method: c[0], path: c[1], opts: c[2] ?? {} }));
const text = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((c) => c.text ?? '').join('\n');
const parse = (def: { inputSchema: z.ZodRawShape }, input: unknown) => z.object(def.inputSchema).strict().safeParse(input);

beforeEach(() => {
  mockBackendRequest.mockReset();
  mockBackendRequest.mockResolvedValue({ ok: 1 });
});

describe('registration', () => {
  it('exposes the seven tools in ALL_TOOLS under existing scopes', () => {
    expect(gearGuideTools.map((t) => t.name)).toEqual([
      'list_gear_guide_topics',
      'ask_gear_guide',
      'gear_guide_status',
      'add_gear_guide_note',
      'list_gear_guide_gaps',
      'answer_gear_guide_gap',
      'upload_gear_manual',
    ]);
    for (const t of gearGuideTools) expect(ALL_TOOLS).toContain(t);
    expect(gearGuideTools.filter((t) => t.scope === 'bookings').map((t) => t.name)).toEqual(['list_gear_guide_topics', 'ask_gear_guide']);
    expect(gearGuideTools.filter((t) => t.scope === 'listings')).toHaveLength(5);
  });

  it('renter tools are for signed-in users, vendor tools for the vendor family only', () => {
    expect(isToolVisible(listGearGuideTopics.access, {})).toBe(false);
    expect(isToolVisible(askGearGuide.access, renter)).toBe(true);
    expect(isToolVisible(gearGuideStatus.access, renter)).toBe(false);
    expect(isToolVisible(gearGuideStatus.access, vendor)).toBe(true);
    expect(hasScope({ token: T, scopes: ['read'] }, 'bookings')).toBe(false);
  });

  it('annotations: reads are read-only, writes are not', () => {
    for (const t of [listGearGuideTopics, gearGuideStatus, listGearGuideGaps, uploadGearManual]) expect(t.annotations.readOnlyHint).toBe(true);
    for (const t of [askGearGuide, addGearGuideNote, answerGearGuideGap]) {
      expect(t.annotations.readOnlyHint).toBe(false);
      expect(t.annotations.destructiveHint).toBe(false);
    }
  });

  it('upload_gear_manual says plainly that it does not upload', () => {
    expect(uploadGearManual.description).toMatch(/Does NOT upload/);
  });
});

describe('list_gear_guide_topics', () => {
  it('forwards the JWT to the booking topics route', async () => {
    mockBackendRequest.mockResolvedValue({ topics: [] });
    const r = await listGearGuideTopics.handler({ bookingId: B }, renter);
    expect(r.isError).toBeFalsy();
    expect(calls()[0]).toEqual({ method: 'GET', path: `/gear-guide/bookings/${B}/topics`, opts: { token: T } });
  });
  it('passes a 403 through', async () => {
    mockBackendRequest.mockRejectedValue(new BackendApiError(403, 'Not your booking'));
    const r = await listGearGuideTopics.handler({ bookingId: B }, renter);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('Not allowed for this account: Not your booking');
  });
  it('rejects a non-uuid id and extra fields', () => {
    expect(parse(listGearGuideTopics, { bookingId: 'nope' }).success).toBe(false);
    expect(parse(listGearGuideTopics, { bookingId: B, extra: 1 }).success).toBe(false);
    expect(parse(listGearGuideTopics, { bookingId: B }).success).toBe(true);
  });
});

describe('ask_gear_guide', () => {
  it('posts stream=false with a fresh Idempotency-Key per call and returns the structured answer', async () => {
    const answer = {
      answer: 'Prime the pump first.',
      steps: [{ text: 'Open the valve' }],
      warnings: ['Never run it dry.'],
      sources: [{ origin: 'manual', title: 'Manual p.4' }],
      confidence: 'high',
      handoff: false,
    };
    mockBackendRequest.mockResolvedValue(answer);
    const r1 = await askGearGuide.handler({ bookingId: B, question: 'How do I start it?' }, renter);
    await askGearGuide.handler({ bookingId: B, question: 'How do I start it?' }, renter);
    const [c1, c2] = calls();
    expect(c1.method).toBe('POST');
    expect(c1.path).toBe(`/gear-guide/bookings/${B}/ask?stream=false`);
    expect(c1.opts.token).toBe(T);
    expect(c1.opts.body).toEqual({ question: 'How do I start it?' });
    expect(c1.opts.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(c2.opts.headers['Idempotency-Key']).not.toBe(c1.opts.headers['Idempotency-Key']);
    expect(c1.opts.timeoutMs).toBeGreaterThan(15_000);
    const out = JSON.parse(text(r1));
    expect(out.warnings).toEqual(['Never run it dry.']);
    expect(out.sources[0].origin).toBe('manual');
    expect(out.confidence).toBe('high');
    expect(out.handoff).toBe(false);
  });
  it('forwards sessionId and locale only when given', async () => {
    await askGearGuide.handler({ bookingId: B, question: 'q', sessionId: G, locale: 'es' }, renter);
    expect(calls()[0].opts.body).toEqual({ question: 'q', sessionId: G, locale: 'es' });
  });
  it('passes a 403 and a 409 through', async () => {
    mockBackendRequest.mockRejectedValueOnce(new BackendApiError(403, 'Gear Guide is off'));
    expect(text(await askGearGuide.handler({ bookingId: B, question: 'q' }, renter))).toContain('Not allowed for this account: Gear Guide is off');
    mockBackendRequest.mockRejectedValueOnce(new BackendApiError(409, 'GEAR_GUIDE_REQUEST_IN_PROGRESS'));
    expect(text(await askGearGuide.handler({ bookingId: B, question: 'q' }, renter))).toContain('Conflict');
  });
  it('validates: question length and trim, locale shape, uuids', () => {
    expect(parse(askGearGuide, { bookingId: B, question: '' }).success).toBe(false);
    expect(parse(askGearGuide, { bookingId: B, question: '   ' }).success).toBe(false);
    expect(parse(askGearGuide, { bookingId: B, question: 'x'.repeat(1001) }).success).toBe(false);
    expect(parse(askGearGuide, { bookingId: B, question: 'x'.repeat(1000) }).success).toBe(true);
    expect(parse(askGearGuide, { bookingId: B, question: 'q', locale: 'english-please' }).success).toBe(false);
    expect(parse(askGearGuide, { bookingId: B, question: 'q', sessionId: 'x' }).success).toBe(false);
    expect(parse(askGearGuide, { bookingId: 'x', question: 'q' }).success).toBe(false);
  });
  it('the description tells the model to pass warnings through verbatim', () => {
    expect(askGearGuide.description).toMatch(/warnings to the user verbatim/);
  });
});

describe('gear_guide_status', () => {
  it('reads settings, the listing, then the model and its build, with the JWT', async () => {
    mockBackendRequest.mockImplementation(async (_m: string, path: string) => {
      if (path.endsWith('/settings')) return { enabled: true };
      if (path === `/listings/${L}`) return { id: L, gearModelId: M };
      if (path.endsWith('/build')) return { state: 'published' };
      return { id: M, make: 'Yamaha' };
    });
    const out = JSON.parse(text(await gearGuideStatus.handler({ listingId: L }, vendor)));
    expect(out.settings).toEqual({ enabled: true });
    expect(out.model).toEqual({ id: M, make: 'Yamaha' });
    expect(out.build).toEqual({ state: 'published' });
    const paths = calls().map((c) => c.path);
    expect(paths).toEqual(expect.arrayContaining([`/gear-guide/listings/${L}/settings`, `/gear-guide/models/${M}`, `/gear-guide/models/${M}/build`]));
    for (const c of calls()) expect(c.opts.token).toBe(T);
  });
  it('a listing with no linked model has null model and build', async () => {
    mockBackendRequest.mockImplementation(async (_m: string, path: string) => (path.endsWith('/settings') ? { enabled: false } : { id: L, gearModelId: null }));
    const out = JSON.parse(text(await gearGuideStatus.handler({ listingId: L }, vendor)));
    expect(out).toEqual({ settings: { enabled: false }, model: null, build: null });
  });
  it('passes a 403 through (not the listing owner)', async () => {
    mockBackendRequest.mockRejectedValue(new BackendApiError(403, 'Not your listing'));
    const r = await gearGuideStatus.handler({ listingId: L }, vendor);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('Not allowed for this account: Not your listing');
  });
  it('rejects a bad id', () => expect(parse(gearGuideStatus, { listingId: 'x' }).success).toBe(false));
});

describe('add_gear_guide_note', () => {
  it('creates a listing-scope DRAFT fact with a derived title and a valid slug', async () => {
    await addGearGuideNote.handler({ listingId: L, text: 'The starboard cleat is loose.\nTie off on the port side.' }, vendor);
    const c = calls()[0];
    expect(c.method).toBe('POST');
    expect(c.path).toBe(`/gear-guide/listings/${L}/items`);
    expect(c.opts.token).toBe(T);
    expect(c.opts.body).toMatchObject({
      kind: 'fact',
      title: 'The starboard cleat is loose.',
      bodyMd: 'The starboard cleat is loose.\nTie off on the port side.',
      status: 'draft',
    });
    expect(c.opts.body.topicSlug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(c.opts.body.topicSlug.length).toBeLessThanOrEqual(80);
  });
  it('publishes only when asked', async () => {
    await addGearGuideNote.handler({ listingId: L, text: 'Gate code changes monthly.', publish: true }, vendor);
    expect(calls()[0].opts.body.status).toBe('published');
  });
  it('passes a 403 and a 400 through', async () => {
    mockBackendRequest.mockRejectedValueOnce(new BackendApiError(403, 'Not your listing'));
    expect(text(await addGearGuideNote.handler({ listingId: L, text: 'abc' }, vendor))).toContain('Not allowed');
    mockBackendRequest.mockRejectedValueOnce(new BackendApiError(400, 'bodyMd too long'));
    expect((await addGearGuideNote.handler({ listingId: L, text: 'abc' }, vendor)).isError).toBe(true);
  });
  it('validates text length and extra fields', () => {
    expect(parse(addGearGuideNote, { listingId: L, text: 'ab' }).success).toBe(false);
    expect(parse(addGearGuideNote, { listingId: L, text: 'x'.repeat(8001) }).success).toBe(false);
    expect(parse(addGearGuideNote, { listingId: L, text: 'abc', status: 'published' }).success).toBe(false);
  });
  it('helpers: slug and title edge cases', () => {
    expect(topicSlugFrom('Water-heater bypass!!', 'ab12')).toBe('water-heater-bypass-ab12');
    expect(topicSlugFrom('!!!', 'ab12')).toBe('note-ab12');
    expect(topicSlugFrom('x'.repeat(200), 'ab12').length).toBeLessThanOrEqual(80);
    expect(noteTitle('x'.repeat(300)).length).toBeLessThanOrEqual(80);
  });
});

describe('list_gear_guide_gaps', () => {
  it('defaults to the backend default and filters by status', async () => {
    await listGearGuideGaps.handler({ listingId: L }, vendor);
    expect(calls()[0]).toEqual({ method: 'GET', path: `/gear-guide/listings/${L}/gaps`, opts: { token: T } });
    await listGearGuideGaps.handler({ listingId: L, status: 'answered' }, vendor);
    expect(calls()[1].path).toBe(`/gear-guide/listings/${L}/gaps?status=answered`);
  });
  it('passes a 403 through and validates the status', async () => {
    mockBackendRequest.mockRejectedValue(new BackendApiError(403, 'no'));
    expect((await listGearGuideGaps.handler({ listingId: L }, vendor)).isError).toBe(true);
    expect(parse(listGearGuideGaps, { listingId: L, status: 'closed' }).success).toBe(false);
  });
});

describe('answer_gear_guide_gap', () => {
  it('posts title and answer to the gap route with the JWT', async () => {
    await answerGearGuideGap.handler({ listingId: L, gapId: G, title: 'Where is the gate code?', answer: 'On the lockbox.' }, vendor);
    expect(calls()[0]).toEqual({
      method: 'POST',
      path: `/gear-guide/listings/${L}/gaps/${G}/answer`,
      opts: { token: T, body: { title: 'Where is the gate code?', answer: 'On the lockbox.' } },
    });
  });
  it('passes a 404 and a 403 through', async () => {
    mockBackendRequest.mockRejectedValueOnce(new BackendApiError(404, 'Gap not found'));
    expect(text(await answerGearGuideGap.handler({ listingId: L, gapId: G, title: 't', answer: 'a' }, vendor))).toContain('Not found');
    mockBackendRequest.mockRejectedValueOnce(new BackendApiError(403, 'Not your listing'));
    expect(text(await answerGearGuideGap.handler({ listingId: L, gapId: G, title: 't', answer: 'a' }, vendor))).toContain('Not allowed');
  });
  it('validates ids and length caps', () => {
    const ok = { listingId: L, gapId: G, title: 't', answer: 'a' };
    expect(parse(answerGearGuideGap, ok).success).toBe(true);
    expect(parse(answerGearGuideGap, { ...ok, gapId: 'x' }).success).toBe(false);
    expect(parse(answerGearGuideGap, { ...ok, title: 'x'.repeat(201) }).success).toBe(false);
    expect(parse(answerGearGuideGap, { ...ok, answer: 'x'.repeat(4001) }).success).toBe(false);
    expect(parse(answerGearGuideGap, { ...ok, answer: '' }).success).toBe(false);
  });
});

describe('upload_gear_manual', () => {
  it('uploads nothing: GETs build and manuals only, and returns the editor link', async () => {
    mockBackendRequest.mockImplementation(async (_m: string, path: string) => (path.endsWith('/build') ? { state: 'no_manual' } : { manuals: [], attestationText: 'I may share this' }));
    const out = JSON.parse(text(await uploadGearManual.handler({ modelId: M, listingId: L }, vendor)));
    expect(out.uploaded).toBe(false);
    expect(out.editorUrl).toBe(`https://go-splitt.com/vendor/listings/${L}/edit#gear-guide`);
    expect(out.build).toEqual({ state: 'no_manual' });
    expect(out.manuals.attestationText).toBe('I may share this');
    for (const c of calls()) {
      expect(c.method).toBe('GET');
      expect(c.opts.token).toBe(T);
    }
    expect(calls().map((c) => c.path).sort()).toEqual([`/gear-guide/models/${M}/build`, `/gear-guide/models/${M}/manuals`]);
  });
  it('without a listing the link goes to the vendor listings page', async () => {
    const out = JSON.parse(text(await uploadGearManual.handler({ modelId: M }, vendor)));
    expect(out.editorUrl).toBe('https://go-splitt.com/vendor/listings');
  });
  it('passes a 403 through', async () => {
    mockBackendRequest.mockRejectedValue(new BackendApiError(403, 'Not your model'));
    const r = await uploadGearManual.handler({ modelId: M }, vendor);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('Not allowed');
  });
  it('rejects a non-uuid model id', () => expect(parse(uploadGearManual, { modelId: 'x' }).success).toBe(false));
});
