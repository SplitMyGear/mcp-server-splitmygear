/** Contract tests for the fleet backend module + tool defs: exact method/path/body/token per call, handler guards. */
export {};

const mockBackendRequest = jest.fn();
jest.mock('../src/lib/backend-client', () => {
  class BackendApiError extends Error {
    status: number;
    constructor(status: number, message: string) { super(message); this.name = 'BackendApiError'; this.status = status; }
  }
  return { BackendApiError, backendRequest: (...args: unknown[]) => mockBackendRequest(...args) };
});

import { fleetTools } from '../src/tools/fleet';
import { fleetTools as fleetDefs, addFleetUnits, listFleetUnits, updateFleetUnit, deleteFleetUnit, logUnitMaintenance, FLEET_UNIT_STATUSES, MAINTENANCE_KINDS } from '../src/tools/defs/fleet';
import { TOOL_SCOPES, type ToolContext } from '../src/tools/registry';
import { z } from 'zod';

const T = 'h.p.s';
const L = '11111111-1111-4111-8111-111111111111';
const U = '22222222-2222-4222-8222-222222222222';
const ctx: ToolContext = { userId: 'u', role: 'vendor', token: T, kind: 'oauth' };
const { BackendApiError } = jest.requireMock('../src/lib/backend-client');

function lastCall() {
  const c = mockBackendRequest.mock.calls[mockBackendRequest.mock.calls.length - 1];
  return { method: c[0], path: c[1], opts: c[2] ?? {} };
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content[0]?.text ?? '';
}

beforeEach(() => {
  mockBackendRequest.mockReset();
  mockBackendRequest.mockResolvedValue({ ok: 1 });
});

describe('fleetTools (backend module)', () => {
  it('reads summary, all units and per-listing units with the token', async () => {
    await fleetTools.getFleetSummary(T);
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/fleet/summary', opts: { token: T } });
    expect(lastCall().opts.body).toBeUndefined();
    await fleetTools.listMyUnits(T);
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/fleet/my-units', opts: { token: T } });
    await fleetTools.listUnitsForListing(T, L);
    expect(lastCall()).toMatchObject({ method: 'GET', path: `/fleet/listings/${L}/units`, opts: { token: T } });
  });

  it('creates single and bulk units sending only DTO fields', async () => {
    await fleetTools.createUnit(T, L, { label: 'Bike #3', serialNumber: 'SN1', vin: undefined, year: 2024, acquisitionValue: 1200.5 });
    expect(lastCall()).toMatchObject({ method: 'POST', path: `/fleet/listings/${L}/units`, opts: { token: T, body: { label: 'Bike #3', serialNumber: 'SN1', year: 2024, acquisitionValue: 1200.5 } } });
    expect(lastCall().opts.body).not.toHaveProperty('vin');
    await fleetTools.createUnitsBulk(T, L, { count: 5, label: 'Kayak' });
    expect(lastCall()).toMatchObject({ method: 'POST', path: `/fleet/listings/${L}/units/bulk`, opts: { token: T, body: { count: 5, label: 'Kayak' } } });
    await fleetTools.createUnitsBulk(T, L, { count: 2, label: undefined });
    expect(lastCall().opts.body).toEqual({ count: 2 });
  });

  it('updates, deletes, logs maintenance, reads history and stats', async () => {
    await fleetTools.updateUnit(T, U, { status: 'maintenance', notes: 'brake squeal', label: undefined });
    expect(lastCall()).toMatchObject({ method: 'PUT', path: `/fleet/units/${U}`, opts: { token: T, body: { status: 'maintenance', notes: 'brake squeal' } } });
    expect(lastCall().opts.body).not.toHaveProperty('label');
    await fleetTools.deleteUnit(T, U);
    expect(lastCall()).toMatchObject({ method: 'DELETE', path: `/fleet/units/${U}`, opts: { token: T } });
    expect(lastCall().opts.body).toBeUndefined();
    await fleetTools.recordMaintenance(T, U, { kind: 'repair', description: 'Replaced chain', hoursReadingAt: 340, cost: 129.99, attachmentUrls: undefined, performedAt: '2026-07-09T14:30:00.000Z' });
    expect(lastCall()).toMatchObject({
      method: 'POST',
      path: `/fleet/units/${U}/maintenance-complete`,
      opts: { token: T, body: { kind: 'repair', description: 'Replaced chain', hoursReadingAt: 340, cost: 129.99, performedAt: '2026-07-09T14:30:00.000Z' } },
    });
    expect(lastCall().opts.body).not.toHaveProperty('attachmentUrls');
    await fleetTools.getMaintenanceRecords(T, U);
    expect(lastCall()).toMatchObject({ method: 'GET', path: `/fleet/units/${U}/maintenance-records`, opts: { token: T } });
    await fleetTools.getUnitStats(T, U);
    expect(lastCall()).toMatchObject({ method: 'GET', path: `/fleet/units/${U}/stats`, opts: { token: T } });
  });

  it('returns an error Result (never throws) when the backend rejects', async () => {
    mockBackendRequest.mockRejectedValueOnce(new BackendApiError(409, 'Unit has booking history. Retire it instead'));
    expect(await fleetTools.deleteUnit(T, U)).toEqual({ ok: false, error: 'Unit has booking history. Retire it instead', status: 409 });
    mockBackendRequest.mockRejectedValueOnce(new Error('net'));
    expect((await fleetTools.getFleetSummary(T)).ok).toBe(false);
  });
});

describe('fleet tool defs', () => {
  it('exports the fleet tool set with docs, access, scope and annotations on every def', () => {
    expect(fleetDefs.map((t) => t.name)).toEqual([
      'get_fleet_summary',
      'list_fleet_units',
      'get_unit_stats',
      'get_unit_maintenance_history',
      'add_fleet_units',
      'update_fleet_unit',
      'delete_fleet_unit',
      'log_unit_maintenance',
    ]);
    for (const t of fleetDefs) {
      expect(t.name).toMatch(/^[a-z_]+$/);
      expect(t.access).toBe('vendor');
      expect(t.scope).toBe('listings');
      expect(TOOL_SCOPES).toContain(t.scope);
      expect(t.title.length).toBeGreaterThan(2);
      expect(t.description.length).toBeGreaterThan(40);
      expect(t.description).not.toMatch(/\u2014/);
      expect(t.annotations).toHaveProperty('readOnlyHint');
    }
    expect(fleetDefs.find((t) => t.name === 'delete_fleet_unit')?.annotations.destructiveHint).toBe(true);
    expect(fleetDefs.filter((t) => t.annotations.readOnlyHint).map((t) => t.name)).toEqual(['get_fleet_summary', 'list_fleet_units', 'get_unit_stats', 'get_unit_maintenance_history']);
    expect(FLEET_UNIT_STATUSES).not.toContain('rented');
    expect(MAINTENANCE_KINDS).toEqual(['service', 'repair', 'inspection']);
  });

  it('input schemas enforce UUID path params, https-only attachments, vendor-settable statuses, year ceiling and bulk cap', () => {
    const m = z.object(logUnitMaintenance.inputSchema);
    expect(m.safeParse({ unitId: U, kind: 'service', description: 'x', attachmentUrls: ['https://a.public.blob.vercel-storage.com/f.pdf'] }).success).toBe(true);
    expect(m.safeParse({ unitId: U, kind: 'service', description: 'x', attachmentUrls: ['http://evil.example/f.pdf'] }).success).toBe(false);
    expect(m.safeParse({ unitId: 'not-a-uuid', kind: 'service', description: 'x' }).success).toBe(false);
    expect(m.safeParse({ unitId: U, kind: 'overhaul', description: 'x' }).success).toBe(false);
    const u = z.object(updateFleetUnit.inputSchema);
    expect(u.safeParse({ unitId: U, status: 'rented' }).success).toBe(false);
    expect(u.safeParse({ unitId: U, status: 'retired', year: new Date().getFullYear() + 1 }).success).toBe(true);
    expect(u.safeParse({ unitId: U, year: new Date().getFullYear() + 2 }).success).toBe(false);
    const a = z.object(addFleetUnits.inputSchema);
    expect(a.safeParse({ listingId: L, count: 51 }).success).toBe(false);
    expect(a.safeParse({ listingId: 'nope', count: 1 }).success).toBe(false);
    expect(a.safeParse({ listingId: L }).success).toBe(true);
    expect(z.object(listFleetUnits.inputSchema).safeParse({}).success).toBe(true);
    expect(z.object(deleteFleetUnit.inputSchema).safeParse({ unitId: 'x' }).success).toBe(false);
  });

  it('list_fleet_units routes to per-listing or all-listings', async () => {
    await listFleetUnits.handler({ listingId: L }, ctx);
    expect(lastCall()).toMatchObject({ method: 'GET', path: `/fleet/listings/${L}/units`, opts: { token: T } });
    await listFleetUnits.handler({}, ctx);
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/fleet/my-units', opts: { token: T } });
  });

  it('add_fleet_units: single create with identity fields, bulk with count, and refuses identity fields in bulk', async () => {
    await addFleetUnits.handler({ listingId: L, label: 'Blue Trek', serialNumber: 'SN-1', year: 2024 }, ctx);
    expect(lastCall()).toMatchObject({ method: 'POST', path: `/fleet/listings/${L}/units`, opts: { token: T, body: { label: 'Blue Trek', serialNumber: 'SN-1', year: 2024 } } });
    expect(lastCall().opts.body).not.toHaveProperty('count');

    mockBackendRequest.mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    const bulk = await addFleetUnits.handler({ listingId: L, count: 3, label: 'Kayak' }, ctx);
    expect(lastCall()).toMatchObject({ method: 'POST', path: `/fleet/listings/${L}/units/bulk`, opts: { token: T, body: { count: 3, label: 'Kayak' } } });
    expect(JSON.parse(text(bulk))).toMatchObject({ created: 3 });

    const calls = mockBackendRequest.mock.calls.length;
    const refused = await addFleetUnits.handler({ listingId: L, count: 2, serialNumber: 'SN-9' }, ctx);
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/serialNumber/);
    expect(mockBackendRequest.mock.calls.length).toBe(calls);
  });

  it('update_fleet_unit requires a field and forwards status changes', async () => {
    const empty = await updateFleetUnit.handler({ unitId: U }, ctx);
    expect(empty.isError).toBe(true);
    expect(mockBackendRequest).not.toHaveBeenCalled();
    await updateFleetUnit.handler({ unitId: U, status: 'retired' }, ctx);
    expect(lastCall()).toMatchObject({ method: 'PUT', path: `/fleet/units/${U}`, opts: { token: T, body: { status: 'retired' } } });
  });

  it('delete_fleet_unit maps success and surfaces the backend 409 hint', async () => {
    const okRes = await deleteFleetUnit.handler({ unitId: U }, ctx);
    expect(JSON.parse(text(okRes))).toEqual({ deleted: true, unitId: U });
    mockBackendRequest.mockRejectedValueOnce(new BackendApiError(409, 'Unit has booking history. Retire it instead'));
    const conflict = await deleteFleetUnit.handler({ unitId: U }, ctx);
    expect(conflict.isError).toBe(true);
    expect(text(conflict)).toMatch(/^Conflict: Unit has booking history/);
  });

  it('log_unit_maintenance validates locally, trims, and forwards the DTO body', async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect((await logUnitMaintenance.handler({ unitId: U, kind: 'service', description: 'Oil change', performedAt: future }, ctx)).isError).toBe(true);
    expect((await logUnitMaintenance.handler({ unitId: U, kind: 'service', description: 'Oil change', performedAt: 'not-a-date' }, ctx)).isError).toBe(true);
    expect((await logUnitMaintenance.handler({ unitId: U, kind: 'service', description: '   ' }, ctx)).isError).toBe(true);
    expect((await logUnitMaintenance.handler({ unitId: U, kind: 'service', description: 'x', cost: 12.345 }, ctx)).isError).toBe(true);
    expect(mockBackendRequest).not.toHaveBeenCalled();

    await logUnitMaintenance.handler(
      { unitId: U, kind: 'inspection', description: '  Annual safety check  ', hoursReadingAt: 12, cost: 0, attachmentUrls: ['https://x.public.blob.vercel-storage.com/r.pdf'], performedAt: '2026-01-05' },
      ctx,
    );
    expect(lastCall()).toMatchObject({
      method: 'POST',
      path: `/fleet/units/${U}/maintenance-complete`,
      opts: { token: T, body: { kind: 'inspection', description: 'Annual safety check', hoursReadingAt: 12, cost: 0, attachmentUrls: ['https://x.public.blob.vercel-storage.com/r.pdf'], performedAt: '2026-01-05' } },
    });
    expect(Object.keys(lastCall().opts.body).sort()).toEqual(['attachmentUrls', 'cost', 'description', 'hoursReadingAt', 'kind', 'performedAt']);
  });
});
