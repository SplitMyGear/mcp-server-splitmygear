/**
 * Fleet tools: the physical units behind a multi-unit listing, their status,
 * asset identity and append-only maintenance log. Visible to the vendor family
 * only (backend: JwtAuthGuard + VendorOrPrivilegedGuard on `/fleet`).
 */
import { z } from 'zod';
import { defineTool, fail, fromResult } from '../registry';
import { fleetTools as fleet } from '../fleet';
import { dateError } from '../_shared';
import { uuid, isoDate, READ, WRITE, WRITE_IDEMPOTENT, DESTRUCTIVE, token } from './common';

/** Mirrors the backend's MAX_UNIT_YEAR (next year's models ship early). */
const MAX_UNIT_YEAR = new Date().getFullYear() + 1;

export const FLEET_UNIT_STATUSES = ['available', 'maintenance', 'retired'] as const;
export const MAINTENANCE_KINDS = ['service', 'repair', 'inspection'] as const;

/** `CreateUnitDto` fields (all optional). */
const unitFields = {
  label: z.string().min(1).max(120).optional().describe('Human-readable name staff use, e.g. "Unit #3" or "Blue Trek".'),
  serialNumber: z.string().min(1).max(120).optional().describe('Serial number or asset tag.'),
  notes: z.string().max(2000).optional().describe('Private notes: damage history, quirks. Renters never see these.'),
  maintenanceIntervalHours: z.number().min(1).max(100000).optional().describe('Rental hours between services; the unit is flagged when its accumulated rental hours reach this.'),
  vin: z.string().min(1).max(32).optional().describe('Vehicle Identification Number (motorized land vehicles).'),
  hin: z.string().min(1).max(32).optional().describe('Hull Identification Number (boats, jet skis, PWC).'),
  registrationNumber: z.string().min(1).max(64).optional().describe('State/DMV registration number, where required.'),
  make: z.string().min(1).max(64).optional(),
  model: z.string().min(1).max(64).optional(),
  year: z.number().int().min(1950).max(MAX_UNIT_YEAR).optional().describe('Model year.'),
  acquisitionValue: z.number().min(0).max(10000000).optional().describe('What the vendor paid for this unit, in USD (insurance/claims basis).'),
};

// ── Reads ────────────────────────────────────────────────────────────────────

export const getFleetSummary = defineTool({
  name: 'get_fleet_summary',
  title: 'Fleet summary',
  description:
    'Overview of the signed-in vendor\'s fleet across all listings: unit counts by status (available, rented, maintenance, retired), utilization rate, ' +
    'revenue from completed bookings, and the units whose rental hours have reached their maintenance interval. Use it to answer "how is my fleet doing" or to find units that need service.',
  access: 'vendor',
  scope: 'listings',
  inputSchema: {},
  annotations: READ,
  handler: async (_args, ctx) => fromResult(await fleet.getFleetSummary(token(ctx))),
});

export const listFleetUnits = defineTool({
  name: 'list_fleet_units',
  title: 'List fleet units',
  description:
    'The physical units behind the vendor\'s listings, each with id, label, serial number, status, asset identity (VIN/HIN/registration, make, model, year), ' +
    'accumulated rental hours, maintenance interval and last maintenance date. Pass listingId for one listing\'s units; omit it to get every listing the vendor owns with its units. ' +
    'Unit ids from here feed update_fleet_unit, delete_fleet_unit, log_unit_maintenance, get_unit_maintenance_history and get_unit_stats.',
  access: 'vendor',
  scope: 'listings',
  inputSchema: {
    listingId: uuid('listing').optional().describe('Restrict to one listing (UUID). Omit for all listings.'),
  },
  annotations: READ,
  handler: async ({ listingId }, ctx) =>
    fromResult(listingId ? await fleet.listUnitsForListing(token(ctx), listingId) : await fleet.listMyUnits(token(ctx))),
});

export const getUnitStats = defineTool({
  name: 'get_unit_stats',
  title: 'Unit stats',
  description:
    'Per-unit performance for one fleet unit: the unit record, completed bookings, total rental days, revenue and whether maintenance is due. ' +
    'Use it to compare units or decide which one to service or retire.',
  access: 'vendor',
  scope: 'listings',
  inputSchema: { unitId: uuid('fleet unit') },
  annotations: READ,
  handler: async ({ unitId }, ctx) => fromResult(await fleet.getUnitStats(token(ctx), unitId)),
});

export const getUnitMaintenanceHistory = defineTool({
  name: 'get_unit_maintenance_history',
  title: 'Unit maintenance history',
  description:
    'The append-only maintenance log of one fleet unit, newest first: kind (service/repair/inspection), description, who logged it, when it was performed, ' +
    'hour-meter reading, cost and attachment URLs. Records are immutable evidence and cannot be edited or deleted.',
  access: 'vendor',
  scope: 'listings',
  inputSchema: { unitId: uuid('fleet unit') },
  annotations: READ,
  handler: async ({ unitId }, ctx) => fromResult(await fleet.getMaintenanceRecords(token(ctx), unitId)),
});

// ── Writes ───────────────────────────────────────────────────────────────────

export const addFleetUnits = defineTool({
  name: 'add_fleet_units',
  title: 'Add fleet units',
  description:
    'Add physical units to one of the vendor\'s listings. New units start as available and increase the listing\'s bookable capacity. ' +
    'count=1 (default) creates one unit with any of the identity fields (label, serialNumber, VIN/HIN, make, model, year, acquisitionValue, notes, maintenanceIntervalHours). ' +
    'count>1 creates that many identical stubs labeled "<label> 1", "<label> 2"... (label defaults to "Unit"); identity fields are not allowed in bulk mode, set them afterwards with update_fleet_unit. ' +
    'A listing is capped at 200 units. Returns the created unit(s).',
  access: 'vendor',
  scope: 'listings',
  inputSchema: {
    listingId: uuid('listing'),
    count: z.number().int().min(1).max(50).optional().describe('How many units to add (1 to 50, default 1). More than 1 switches to bulk mode.'),
    ...unitFields,
  },
  annotations: WRITE,
  handler: async ({ listingId, count, ...unit }, ctx) => {
    const n = count ?? 1;
    if (n > 1) {
      const { label, ...identity } = unit;
      const extra = Object.entries(identity).filter(([, v]) => v !== undefined).map(([k]) => k);
      if (extra.length) return fail(`Bulk mode (count > 1) only accepts label as a prefix. Remove ${extra.join(', ')} or add units one at a time (count = 1) and set fields with update_fleet_unit.`);
      return fromResult(await fleet.createUnitsBulk(token(ctx), listingId, { count: n, label }), (units) => ({
        created: Array.isArray(units) ? units.length : n,
        units,
      }));
    }
    return fromResult(await fleet.createUnit(token(ctx), listingId, unit));
  },
});

export const updateFleetUnit = defineTool({
  name: 'update_fleet_unit',
  title: 'Update fleet unit',
  description:
    'Change one fleet unit: set status to "maintenance" or "retired" to pull it from bookable capacity, or back to "available"; or edit its label, serial number, notes, ' +
    'maintenance interval and asset identity (VIN/HIN, registration, make, model, year, acquisitionValue). Only the fields you pass change. ' +
    'The "rented" status is managed by bookings and cannot be set here. Retiring keeps the unit and its history; use delete_fleet_unit only for units created by mistake.',
  access: 'vendor',
  scope: 'listings',
  inputSchema: {
    unitId: uuid('fleet unit'),
    status: z.enum(FLEET_UNIT_STATUSES).optional().describe('available: bookable; maintenance: temporarily out of service; retired: permanently out of service.'),
    ...unitFields,
  },
  annotations: WRITE_IDEMPOTENT,
  handler: async ({ unitId, ...rest }, ctx) => {
    if (Object.values(rest).every((v) => v === undefined)) return fail('Pass at least one field to update (status, label, serialNumber, notes, ...).');
    return fromResult(await fleet.updateUnit(token(ctx), unitId, rest));
  },
});

export const deleteFleetUnit = defineTool({
  name: 'delete_fleet_unit',
  title: 'Delete fleet unit',
  description:
    'Permanently remove a fleet unit from its listing. Splitt refuses (409) if the unit has ever been booked, is currently rented, or has maintenance records; ' +
    'retire it with update_fleet_unit(status="retired") instead. Only use this for never-used units added by mistake, and confirm with the user first.',
  access: 'vendor',
  scope: 'listings',
  inputSchema: { unitId: uuid('fleet unit') },
  annotations: DESTRUCTIVE,
  handler: async ({ unitId }, ctx) => fromResult(await fleet.deleteUnit(token(ctx), unitId), () => ({ deleted: true, unitId })),
});

export const logUnitMaintenance = defineTool({
  name: 'log_unit_maintenance',
  title: 'Log unit maintenance',
  description:
    'Record that a fleet unit was serviced, repaired or inspected. Appends an immutable maintenance record (who, when, what, hour-meter reading, cost, receipt URLs), ' +
    'updates the unit\'s last-maintenance date and sets its status back to "available". Records cannot be edited or deleted afterwards, so confirm the details with the user before logging. ' +
    'performedAt defaults to now and cannot be in the future. Returns the updated unit and the new record.',
  access: 'vendor',
  scope: 'listings',
  inputSchema: {
    unitId: uuid('fleet unit'),
    kind: z.enum(MAINTENANCE_KINDS).describe('service: routine scheduled servicing; repair: fixing a fault or damage; inspection: safety/condition check with no parts work.'),
    description: z.string().min(1).max(2000).describe('What was done, e.g. "Replaced air filter and spark plugs; topped up coolant."'),
    hoursReadingAt: z.number().int().min(0).max(10000000).optional().describe('Hour-meter or odometer reading at the time of service.'),
    cost: z.number().min(0).max(10000000).optional().describe('Parts and labor cost in USD (up to 2 decimals).'),
    attachmentUrls: z
      .array(z.string().url().startsWith('https://').max(2048))
      .max(20)
      .optional()
      .describe('HTTPS URLs of receipts or photos already uploaded to Splitt (Splitt upload-host URLs only; other hosts are rejected).'),
    performedAt: isoDate('When the work was performed').optional().describe('ISO date/time the work was performed; defaults to now. Must not be in the future.'),
  },
  annotations: WRITE,
  handler: async ({ unitId, ...input }, ctx) => {
    if (!input.description.trim()) return fail('description must not be blank.');
    if (input.cost !== undefined && Math.round(input.cost * 100) !== input.cost * 100) return fail('cost may have at most 2 decimal places.');
    if (input.performedAt !== undefined) {
      const err = dateError('performedAt', input.performedAt);
      if (err) return fail(err);
      if (new Date(input.performedAt).getTime() > Date.now() + 60_000) return fail('performedAt cannot be in the future.');
    }
    return fromResult(await fleet.recordMaintenance(token(ctx), unitId, { ...input, description: input.description.trim() }));
  },
});

export const fleetTools = [
  getFleetSummary,
  listFleetUnits,
  getUnitStats,
  getUnitMaintenanceHistory,
  addFleetUnits,
  updateFleetUnit,
  deleteFleetUnit,
  logUnitMaintenance,
];
