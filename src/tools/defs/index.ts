/** Every tool the server can expose, in listing order. The registry filters by principal and granted scopes. */
import type { ZodRawShape } from 'zod';
import type { ToolDef } from '../registry';
import { discoveryTools } from './discovery';
import { discoveryExtrasTools } from './discovery-extras';
import { renterTools } from './renter';
import { bookingVerificationTools } from './booking-verification';
import { accountSecurityTools } from './account-security';
import { vendorOnboardingTools } from './vendor-onboarding';
import { filesTools } from './files';
import { trustTools } from './trust';
import { serviceTools } from './services';
import { vendorTools } from './vendor';
import { pricingRulesTools } from './pricing-rules';
import { fleetTools } from './fleet';
import { calendarFeedTools } from './calendar-feeds';
import { routeTools } from './routes';
import { complianceTools } from './compliance';
import { messageTemplateTools } from './message-templates';
import { vendorExtrasTools } from './vendor-extras';

const widen = (defs: ReadonlyArray<unknown>): ToolDef<ZodRawShape>[] => defs as ToolDef<ZodRawShape>[];

export const ALL_TOOLS: ReadonlyArray<ToolDef<ZodRawShape>> = [
  // Public discovery
  ...widen(discoveryTools),
  ...widen(discoveryExtrasTools),
  // Signed-in users (renters and vendors alike)
  ...widen(renterTools),
  ...widen(bookingVerificationTools),
  ...widen(accountSecurityTools),
  ...widen(vendorOnboardingTools),
  ...widen(filesTools),
  ...widen(trustTools),
  ...widen(serviceTools),
  // Vendors
  ...widen(vendorTools),
  ...widen(pricingRulesTools),
  ...widen(fleetTools),
  ...widen(calendarFeedTools),
  ...widen(routeTools),
  ...widen(complianceTools),
  ...widen(messageTemplateTools),
  ...widen(vendorExtrasTools),
];

const names = ALL_TOOLS.map((t) => t.name);
const duplicates = names.filter((n, i) => names.indexOf(n) !== i);
if (duplicates.length) throw new Error(`Duplicate MCP tool names: ${duplicates.join(', ')}`);
