/** File uploads: attach evidence or photos to Splitt storage, then reference the returned URL from another tool. */
import { z } from 'zod';
import { defineTool, fromResult } from '../registry';
import { filesApi, MAX_BASE64_CHARS, MAX_UPLOAD_BYTES, UPLOAD_CONTENT_TYPES, UPLOAD_FOLDERS } from '../files';
import { WRITE, token } from './common';

const FOLDER_NEXT_STEP: Record<(typeof UPLOAD_FOLDERS)[number], string> = {
  disputes: 'Pass this url in open_dispute evidenceUrls.',
  claims: 'Pass this url as the fileUrl of a photo / receipt_pdf evidence item in file_damage_claim, respond_to_claim or add_claim_evidence.',
  'incidental-charges': 'Pass this url as an evidence item url in file_incidental_charge.',
  inspections: 'Pass this url to the booking inspection / verification tool.',
  listings: 'Pass this url in create_listing or update_listing imageUrls.',
  insurance: 'Pass this url as the documentUrl of the vendor insurance policy tool.',
  'profile-photos': 'Pass this url as profileImageUrl in update_my_profile.',
  general: 'Reference this url from the tool that needs it.',
};

export const uploadFile = defineTool({
  name: 'upload_file',
  title: 'Upload a file',
  description:
    'Upload a photo or PDF to Splitt storage for the signed-in user and return its URL. Use it to attach evidence to a dispute, damage claim or ' +
    'incidental charge, or to add listing / profile photos, then pass the returned url to the relevant tool. ' +
    'The folder must match where the file will be used: dispute evidence goes to "disputes", damage-claim evidence to "claims", incidental-charge evidence to ' +
    '"incidental-charges" (these are stored privately and are only accepted by that process); listing photos to "listings", profile photos to "profile-photos". ' +
    `Accepts JPEG, PNG, WebP, GIF or PDF up to ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB, sent as base64. Only upload files the user has provided and asked to attach; never fabricate evidence.`,
  access: 'user',
  scope: 'files',
  inputSchema: {
    folder: z.enum(UPLOAD_FOLDERS).describe('Where the file will be used; evidence folders are private and process-specific.'),
    contentType: z.enum(UPLOAD_CONTENT_TYPES).describe('Real type of the file; the content is checked against it.'),
    base64: z.string().min(1).max(MAX_BASE64_CHARS).describe('The file content encoded as base64 (a data: URL prefix is tolerated).'),
    filename: z.string().max(120).optional().describe('Original file name, for reference only; the extension is set from contentType.'),
  },
  annotations: WRITE,
  handler: async ({ folder, contentType, base64, filename }, ctx) =>
    fromResult(await filesApi.uploadFile(token(ctx), { folder, contentType, base64, filename }), (file) => ({
      url: file.url,
      key: file.key,
      thumbnailUrl: file.thumbnailUrl,
      folder,
      nextStep: FOLDER_NEXT_STEP[folder],
    })),
});

export const filesTools = [uploadFile];
