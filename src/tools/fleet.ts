/**
 * Fleet inventory: the physical units behind a multi-unit listing (SPLIT-1005,
 * SPLIT-723 asset identity, SPLIT-748 append-only maintenance log). Thin
 * clients of the backend `/fleet` routes; the backend's VendorOrPrivilegedGuard
 * plus the service-level ownership checks decide who may touch which unit.
 * Only DTO-declared fields are ever sent (the backend's global ValidationPipe
 * rejects undeclared fields with a 400), so every body goes through `compact`.
 */
import { call, compact } from './_shared';

/** Vendor-settable unit statuses. `rented` is booking-driven and rejected by the backend. */
export type FleetUnitStatus = 'available' | 'maintenance' | 'retired';

export type MaintenanceKind = 'service' | 'repair' | 'inspection';

/** `CreateUnitDto`: everything optional; a new unit starts `available` server-side. */
export interface FleetUnitInput {
  label?: string;
  serialNumber?: string;
  notes?: string;
  maintenanceIntervalHours?: number;
  vin?: string;
  hin?: string;
  registrationNumber?: string;
  make?: string;
  model?: string;
  year?: number;
  acquisitionValue?: number;
}

/** `UpdateUnitDto`: the create fields plus `status`. */
export interface FleetUnitUpdate extends FleetUnitInput {
  status?: FleetUnitStatus;
}

/** `RecordMaintenanceDto`: one immutable maintenance-log entry. */
export interface MaintenanceRecordInput {
  kind: MaintenanceKind;
  description: string;
  hoursReadingAt?: number;
  cost?: number;
  attachmentUrls?: string[];
  performedAt?: string;
}

export const fleetTools = {
  /** Counts by status, utilization, completed revenue and units past their maintenance interval. */
  getFleetSummary(token: string) {
    return call('GET', '/fleet/summary', { token });
  },

  /** Every listing the vendor owns with its units, in two backend queries (no N+1). */
  listMyUnits(token: string) {
    return call('GET', '/fleet/my-units', { token });
  },

  listUnitsForListing(token: string, listingId: string) {
    return call('GET', `/fleet/listings/${listingId}/units`, { token });
  },

  createUnit(token: string, listingId: string, input: FleetUnitInput) {
    return call('POST', `/fleet/listings/${listingId}/units`, { token, body: compact(input) });
  },

  /** `count` identical stubs labeled `<label> N` (label defaults to "Unit" server-side; fleet capped at 200 units). */
  createUnitsBulk(token: string, listingId: string, input: { count: number; label?: string }) {
    return call('POST', `/fleet/listings/${listingId}/units/bulk`, { token, body: compact(input) });
  },

  updateUnit(token: string, unitId: string, input: FleetUnitUpdate) {
    return call('PUT', `/fleet/units/${unitId}`, { token, body: compact(input) });
  },

  /** 409 from the backend when the unit has booking or maintenance history (retire it instead). */
  deleteUnit(token: string, unitId: string) {
    return call<{ success: true; deletedUnitId: string }>('DELETE', `/fleet/units/${unitId}`, { token });
  },

  /** Appends a record, re-derives `lastMaintenanceAt`, and puts the unit back to `available`. */
  recordMaintenance(token: string, unitId: string, input: MaintenanceRecordInput) {
    return call('POST', `/fleet/units/${unitId}/maintenance-complete`, { token, body: compact(input) });
  },

  /** Append-only history, newest first. */
  getMaintenanceRecords(token: string, unitId: string) {
    return call('GET', `/fleet/units/${unitId}/maintenance-records`, { token });
  },

  getUnitStats(token: string, unitId: string) {
    return call('GET', `/fleet/units/${unitId}/stats`, { token });
  },
};
