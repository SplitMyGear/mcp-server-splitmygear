/**
 * Booking handoff verification tools (both parties of a rental booking):
 * condition photos at pickup/return, the structured inspection checklist, and
 * the QR/NFC handoff token. All `user` access; the backend checks that the
 * caller is the booking's renter or the listing owner on every call.
 */
import { z } from 'zod';
import { defineTool, fail, fromResult } from '../registry';
import {
  bookingVerificationTools as verificationApi,
  decodePhotos,
  HANDOFF_TYPES,
  MAX_BATCH_BYTES,
  MAX_PHOTO_BASE64_CHARS,
  MAX_PHOTOS_PER_UPLOAD,
  PHOTO_MIME_TYPES,
} from '../booking-verification';
import { uuid, READ, WRITE, WRITE_IDEMPOTENT, UNTRUSTED_NOTE, token } from './common';

const handoffType = z.enum(HANDOFF_TYPES).describe('Which handoff stage: PICKUP (departure, gear leaves the vendor) or RETURN (gear comes back).');

const photoSchema = z.object({
  base64: z
    .string()
    .min(16)
    .max(MAX_PHOTO_BASE64_CHARS)
    .describe('The image bytes, base64-encoded (a data:image/...;base64, prefix is fine). Max 3 MB decoded.'),
  filename: z.string().max(120).optional().describe('Optional name, e.g. "front-left.jpg".'),
  contentType: z.enum(PHOTO_MIME_TYPES).optional().describe('Optional; must match the actual image bytes when given.'),
});

const PHOTO_RULES = `JPEG, PNG or WebP only (convert HEIC first), at most ${MAX_PHOTOS_PER_UPLOAD} photos and ${MAX_BATCH_BYTES / (1024 * 1024)} MB of image data (after decoding) per call; downscale large phone photos first.`;

interface VerificationRowLike {
  id?: string;
  bookingId?: string;
  type?: string;
  status?: string;
  isAuthentic?: boolean;
  imageKeys?: unknown[];
  verifiedAt?: string;
  checklistSubmittedAt?: string | null;
  completedAt?: string | null;
}

/** The raw row carries EXIF dumps and private blob keys; return only what the model needs. */
function summariseVerification(row: unknown) {
  const v = (row ?? {}) as VerificationRowLike;
  return {
    verificationId: v.id,
    bookingId: v.bookingId,
    type: v.type,
    status: v.status,
    isAuthentic: v.isAuthentic,
    totalPhotos: Array.isArray(v.imageKeys) ? v.imageKeys.length : 0,
    verifiedAt: v.verifiedAt ?? null,
    checklistSubmittedAt: v.checklistSubmittedAt ?? null,
    completedAt: v.completedAt ?? null,
  };
}

// ── Reads ────────────────────────────────────────────────────────────────────

export const getBookingVerification = defineTool({
  name: 'get_booking_verification',
  title: 'Booking verification records',
  description:
    'The pickup and return verification records of a rental booking the signed-in user is party to (renter or listing owner): status per stage, condition photos as signed URLs that expire after about 15 minutes (re-call for fresh links), who uploaded each photo and when, the submitted inspection checklist with readings (fuel, hours, battery, odometer) and completion timestamps. ' +
    'Use it to review handoff evidence before a deposit release, dispute or claim, or to check what is still missing. ' +
    UNTRUSTED_NOTE,
  access: 'user',
  scope: 'bookings',
  inputSchema: { bookingId: uuid('booking') },
  annotations: READ,
  handler: async ({ bookingId }, ctx) =>
    fromResult(await verificationApi.getVerifications(token(ctx), bookingId), (rows) => ({
      count: Array.isArray(rows) ? rows.length : 0,
      verifications: rows,
    })),
});

export const getInspectionChecklistTemplate = defineTool({
  name: 'get_inspection_checklist_template',
  title: 'Inspection checklist template',
  description:
    'The starter inspection checklist for a booking, chosen from the listing category (e-bikes, watercraft, ATVs or a generic list): each item has a label plus server-owned required / requiresPhoto flags. ' +
    'Call it before submit_inspection_checklist so the labels match; required items need a value or ok flag, and requiresPhoto items need a photoUrl, before the inspection can be completed. Party-only.',
  access: 'user',
  scope: 'bookings',
  inputSchema: { bookingId: uuid('booking') },
  annotations: READ,
  handler: async ({ bookingId }, ctx) => fromResult(await verificationApi.getChecklistTemplate(token(ctx), bookingId)),
});

export const getInspectionCompletion = defineTool({
  name: 'get_inspection_completion',
  title: 'Inspection completion status',
  description:
    'Whether the departure (pickup) and return inspections of a booking have been completed, as { departureCompleted, returnCompleted, requiredInspectionMissing }. ' +
    'Cheap check for "is the handoff paperwork done?"; a missing inspection weakens any later deposit or damage claim. Party-only.',
  access: 'user',
  scope: 'bookings',
  inputSchema: { bookingId: uuid('booking') },
  annotations: READ,
  handler: async ({ bookingId }, ctx) => fromResult(await verificationApi.getInspectionCompletion(token(ctx), bookingId)),
});

// ── Checklist ────────────────────────────────────────────────────────────────

export const submitInspectionChecklist = defineTool({
  name: 'submit_inspection_checklist',
  title: 'Submit inspection checklist',
  description:
    'Save or finalise the structured handoff inspection for one stage (PICKUP or RETURN) of a booking the signed-in user is party to. ' +
    'Pass the items from get_inspection_checklist_template with the observed value / ok flag / note; where the template requires a photo, first upload it with upload_file (folder "inspections") and pass the returned url as photoUrl. ' +
    'With complete=false (default) the checklist is saved as a draft and can be resubmitted. With complete=true Splitt checks every required item and photo, marks the inspection COMPLETED and locks it (later edits need support), so confirm the readings with the user first. ' +
    'Only allowed inside the stage window: pickup from 24h before the rental start to the end of the last day; return from the start to 48h after the last day.',
  access: 'user',
  scope: 'bookings',
  inputSchema: {
    bookingId: uuid('booking'),
    type: handoffType,
    checklist: z
      .array(
        z.object({
          label: z.string().min(1).max(200).describe('Item label, ideally exactly as in the template.'),
          value: z.string().max(500).optional().describe('Observed reading or condition, e.g. "half", "1,234 hrs", "scratch on left panel".'),
          ok: z.boolean().optional().describe('Pass/fail flag for the item.'),
          note: z.string().max(1000).optional(),
          photoUrl: z.string().url().max(2048).optional().describe('URL returned by upload_file with folder "inspections" (Splitt storage only; other hosts are rejected).'),
        }),
      )
      .min(1)
      .max(40),
    complete: z.boolean().optional().describe('true to finalise and lock the inspection (default false = save draft).'),
  },
  annotations: WRITE_IDEMPOTENT,
  handler: async ({ bookingId, type, checklist, complete }, ctx) =>
    fromResult(await verificationApi.submitChecklist(token(ctx), bookingId, { type, checklist, complete }), (row) => {
      const summary = summariseVerification(row);
      return {
        ...summary,
        inspectionCompleted: summary.status === 'COMPLETED',
        nextStep: summary.status === 'COMPLETED' ? 'The inspection is finalised and locked.' : 'Draft saved; resubmit with complete=true once every required item and photo is filled in.',
      };
    }),
});

// ── Condition photos ─────────────────────────────────────────────────────────

export const uploadHandoffPhotos = defineTool({
  name: 'upload_handoff_photos',
  title: 'Upload condition photos',
  description:
    'Attach condition photos to the PICKUP or RETURN stage of a booking the signed-in user is party to (renter or vendor). ' +
    'The photos are the evidence Splitt relies on for deposit releases, damage claims and disputes: take them at the handoff, showing every side of the gear and any existing damage. ' +
    PHOTO_RULES +
    ' Repeated calls append to the same stage (nothing is replaced), so do not resend photos already uploaded. For a single checklist-item photo use upload_file (folder "inspections") instead. ' +
    'Splitt reads EXIF data, hashes each file and stores it privately; returns the stage status and photo count.',
  access: 'user',
  scope: 'bookings',
  inputSchema: {
    bookingId: uuid('booking'),
    type: handoffType,
    photos: z.array(photoSchema).min(1).max(MAX_PHOTOS_PER_UPLOAD).describe(`1 to ${MAX_PHOTOS_PER_UPLOAD} photos.`),
  },
  annotations: WRITE,
  handler: async ({ bookingId, type, photos }, ctx) => {
    const decoded = decodePhotos(photos);
    if (!decoded.ok) return fail(decoded.error);
    return fromResult(await verificationApi.uploadHandoffPhotos(token(ctx), bookingId, type, decoded.photos), (row) => ({
      ...summariseVerification(row),
      photosUploadedNow: decoded.photos.length,
      nextStep: 'Photos are stored privately as deposit/claims evidence. Use get_booking_verification to view them (signed URLs).',
    }));
  },
});

// ── QR / NFC handoff ─────────────────────────────────────────────────────────

export const createHandoffToken = defineTool({
  name: 'create_handoff_token',
  title: 'Create handoff token',
  description:
    'Mint a short-lived (15 minute) handoff token for the PICKUP or RETURN of an active booking the signed-in user is party to. ' +
    'Show it to the other party as a QR code or NFC payload at the physical handoff; they redeem it with verify_handoff_token (the Splitt app scanner does the same), which records the handoff and marks the stage verified. ' +
    'The token is a bearer secret: display it only to the counterparty in person, never message or post it. Each call mints a new token; completed or cancelled bookings are refused.',
  access: 'user',
  scope: 'bookings',
  inputSchema: { bookingId: uuid('booking'), type: handoffType },
  annotations: WRITE,
  handler: async ({ bookingId, type }, ctx) =>
    fromResult(await verificationApi.createHandoffToken(token(ctx), bookingId, type), (d) => ({
      token: d?.token,
      type,
      expiresInMinutes: 15,
      nextStep: 'Render the token as a QR code for the other party to scan; they call verify_handoff_token with it.',
    })),
});

export const verifyHandoffToken = defineTool({
  name: 'verify_handoff_token',
  title: 'Verify handoff token',
  description:
    'Redeem a handoff token scanned from the other party\'s QR code / NFC tag to confirm the gear changed hands. ' +
    'Splitt checks the signature and expiry, that the caller is the booking\'s counterparty (you cannot scan your own token), then marks the stage PICKUP_VERIFIED or RETURN_VERIFIED and records who scanned and when. ' +
    'Only call it once the user has physically received or handed over the gear; it is part of the deposit and claims record. Returns { success, bookingId, type, message }.',
  access: 'user',
  scope: 'bookings',
  inputSchema: {
    token: z.string().min(20).max(4096).describe('The handoff token exactly as scanned (a signed token string, not a booking id).'),
  },
  annotations: WRITE_IDEMPOTENT,
  handler: async ({ token: handoffToken }, ctx) => fromResult(await verificationApi.verifyHandoffToken(token(ctx), handoffToken)),
});

/** Registry export (the integrator spreads this into defs/index.ts). */
export const bookingVerificationTools = [
  getBookingVerification,
  getInspectionChecklistTemplate,
  getInspectionCompletion,
  submitInspectionChecklist,
  uploadHandoffPhotos,
  createHandoffToken,
  verifyHandoffToken,
];
