# Splitt in ChatGPT: vendor guide

`splitt-chatgpt-vendor-guide.pdf` is a 10-page guide for Splitt vendors: how to connect ChatGPT to their Splitt account through this MCP server, what they can ask it to do, who on a team can do what, how they stay in control, and what to do when something goes wrong. It follows the house style of the Google Things to do guide (SPLIT-1581, `splitmygear-frontend/content/vendor-resources/google-things-to-do/`).

## Status: describes MCP 2.0, not what production runs today

The guide documents the **MCP 2.0** server (OAuth sign-in and role-aware vendor tools: draft PR #40, successor of #34, tracked in SPLIT-1420). Production still runs 1.0, which accepts only the operator `x-api-key` or a raw backend JWT. ChatGPT cannot connect to 1.0 at all. Its custom connections (developer mode) support OAuth or no authentication, and OpenAI's docs say ChatGPT cannot present custom API keys or headers.

**Do not send this guide to vendors until every item below is done.**

### Launch checklist

1. **Fix the two sign-in blockers, then ship MCP 2.0** (PR #40) with its operator settings from SPLIT-1420: `MCP_OAUTH_SIGNING_KEY`, `MCP_PUBLIC_URL=https://mcp-server-splitmygear.vercel.app`, `MCP_BFF_RELAY_KEY` and the Upstash store. The blockers are listed under [Confirmed blockers](#confirmed-blockers-in-20s-sign-in). As 2.0 stands, no one can finish a password sign-in in Chrome, from ChatGPT or any other client.
2. **Allow ChatGPT's redirect host.** Add `chatgpt.com` to `MCP_OAUTH_ALLOWED_REDIRECT_HOSTS`. ChatGPT redirects to `https://chatgpt.com/connector_platform_oauth_redirect` (or `https://chatgpt.com/connector/oauth/{callback_id}`). Without that host, `/oauth/register` refuses ChatGPT's dynamic client registration and no vendor can connect. The README example list (`claude.ai,.claude.com,cursor.com`) does not include it.
3. **Point the MCP at production** (SPLIT-1502). With `BACKEND_API_URL` unset, the server talks to the staging backend, so real go-splitt.com vendor logins are rejected. Set it together with `MCP_BACKEND_JWT_SECRET`.
4. **Google and Apple buttons.** Set `SOCIAL_AUTH_RETURN_ORIGINS=https://mcp-server-splitmygear.vercel.app/oauth/social/callback` on the production backend. Until then the sign-in page shows no social buttons, and the guide's Google/Apple lines don't apply.
5. **Rate limit tier.** When `MCP_RATE_LIMIT_TIER` is unset, a vendor gets 10 requests a minute. `initialize`, `tools/list` and every tool call each count as a request, so a normal ChatGPT session can hit that. The guide's troubleshooting page covers the 429 either way.
6. **Test end to end in ChatGPT in Chrome** before sending the guide. Create the connection, sign in with a password, with two-step verification and with Google, confirm a write action, then disconnect. See also [Known risks](#known-risks).
7. **Re-check ChatGPT's click-paths** against the live UI:
   - Settings › Security and login › Developer mode
   - chatgpt.com/plugins › +
   - \+ › Developer mode or More in a chat

   These come from OpenAI's help center, developer docs and cookbook as of September 2026, and OpenAI renames these menus often.

### Confirmed blockers in 2.0's sign-in

Tested on 2026-09-26 against the 2.0 branch (head `66b9869`) running locally with a mocked backend. The browser was Chromium 141 through Playwright 1.56.1, in both headless and full builds, and the redirect target `chatgpt.com` was served locally. Both blockers hit every OAuth client, not just ChatGPT.

1. **Every password sign-in is refused with 403 "Blocked".**
   - The sign-in pages send `Referrer-Policy: no-referrer` (`src/lib/oauth/pages.ts`, and globally in `next.config.js`). Per the Fetch spec, the browser then sends `Origin: null` on the form POST.
   - `isSameOriginPost` (`src/lib/oauth/http.ts`) rejects any Origin that does not match, so the backend login is never called.
   - Fix: treat `Origin: null` as absent when `Sec-Fetch-Site: same-origin` is present, or serve the sign-in pages with `Referrer-Policy: same-origin`.
2. **The last redirect back to the app is blocked.** This shows once the Origin check is passed.
   - `form-action 'self'` in the sign-in page CSP makes Chromium abort the 302 to `https://chatgpt.com/...`. The console shows: `Refused to send form data to '…/oauth/authorize' because it violates the following Content Security Policy directive: "form-action 'self'"`.
   - The vendor is left on the filled-in form with no error, and the authorization code is lost.
   - Fix: send `form-action 'self' <origin of the validated redirect_uri>` on the login and two-step pages. With `https://chatgpt.com` added, the redirect landed and the code exchanged for a token carrying all 12 scopes.
3. **`offline_access` and `openid` are rejected.** `/oauth/authorize` redirects back with `error=invalid_scope`, even when these are mixed with valid scopes. If ChatGPT asks for either, sign-in fails. Ignoring these standard scopes would be safer.

Google or Apple sign-in without two-step verification does not submit a form, so blockers 1 and 2 should not affect it. It was not tested.

### Known risks

- **The ChatGPT flow is untested.** 2.0 has never been exercised end to end from ChatGPT itself. The branch documents Claude, Cursor, Windsurf and the MCP Inspector, and does not mention ChatGPT.
  - ChatGPT uses dynamic client registration, because 2.0 does not advertise Client ID Metadata Documents.
  - It must send `resource` exactly equal to `<MCP_PUBLIC_URL>/api/mcp`.
- **Legacy `vendor` role gets no payout tools.** Accounts with the plain `vendor` role, as opposed to `vendor_owner`, get the vendor tools but not the owner-only payout tools. The guide tells owners they can see earnings and payouts.
- **Two tool descriptions overstate access.** `get_vendor_earnings` and `get_vendor_payouts` say "owner/manager seats", but the registry limits them to the owner seat. The guide follows the code.

## What each claim rests on

| Claim in the guide | Source |
|---|---|
| Sign-in page text, consent card, 2FA step, error messages, 10-minute page expiry, 10 failures per 10 minutes | 2.0 branch: `src/lib/oauth/pages.ts`, `authorize.ts`, `backend-auth.ts`, `throttle.ts` |
| The twelve kinds of access (verbatim) | 2.0 branch: `src/lib/oauth/scopes.ts` |
| Owner-only earnings and payouts; staff get 403 on pricing rules; settings every seat can change | 2.0 branch: `src/lib/roles.ts`, `src/tools/registry.ts`, `src/tools/defs/pricing-rules.ts`, `vendor-extras.ts` |
| Example prompts (every one maps to a real tool) | 2.0 branch: `docs/mcp-tools.md` |
| Reads run straight away, writes wait for confirmation | Every 2.0 tool sets `readOnlyHint`/`destructiveHint` (`src/tools/defs/common.ts`); ChatGPT honours `readOnlyHint` and confirms write actions by default (OpenAI developer mode docs) |
| Host cancellation refunds the renter in full; weather cancellations excluded from the reliability penalty | backend `booking.service.ts` (host-cancel refund), `booking.entity.ts` (`cancellationReason`) |
| Declined reschedule cancels with a full refund | 2.0 branch: `propose_booking_reschedule` description |
| Password reset signs you out everywhere; vendor approval revokes sessions | backend `user.service.ts` (SPLIT-708), `vendor-onboarding.service.ts` |
| Messaging only people you have booked with or talked to | backend `chat.service.ts` |
| Access renews in the background; about 15-minute access tokens; 30-day refresh | ADR 0002 (2.0 branch), backend `token.service.ts`, `refresh-token.service.ts` |
| ChatGPT plans, developer mode location, Plugins page, OAuth only, Lockdown Mode conflict | OpenAI Help Center "Developer mode and MCP apps in ChatGPT", developers.openai.com developer mode and auth docs, OpenAI cookbook (2026-09-12) |

## Rebuild

```bash
cd docs/guides/chatgpt/source
npm install                     # fonts + Playwright 1.56.1 (npx playwright install chromium if needed)
npm run build                   # writes ../splitt-chatgpt-vendor-guide.pdf
pip install pypdf pypdfium2 pillow
python3 check_pdf.py            # embedded fonts, no soft masks, page images in ./pages/
```

`guide.html` is the whole document; `guide.css` holds the print design. Pages are fixed Letter-size sections, so after any copy change, look at every page image for overflow into the footer. The CSS has **no blurred shadows, filters or masks**: Skia writes a blurred `box-shadow` as a luminosity soft mask, and Apple PDFKit (Preview, iOS Files) paints its bounding box grey (frontend #844). `check_pdf.py` fails if one appears. The cover's darkening is baked into `assets/cover.jpg`, which is the go-splitt.com hero photo `public/hero/camping.jpg` cropped to Letter.

The two sign-in screenshots (`assets/login-requested.png`, `assets/otp.png`) are the 2.0 branch's own `renderLoginPage`/`renderOtpPage` output, captured with Chromium. To refresh them after a sign-in page change, run this from a 2.0 checkout with `npm install --no-save tsx`:

```ts
// .render/render-pages.ts   (npx tsx --tsconfig tsconfig.json .render/render-pages.ts)
import { writeFileSync } from 'node:fs';
import { renderLoginPage, renderOtpPage } from '@/lib/oauth/pages';
import { TOOL_SCOPES } from '@/lib/oauth/scopes';

writeFileSync('.render/login-requested.html', renderLoginPage({
  requestToken: 'preview', clientName: 'ChatGPT', verified: true,
  redirectUri: 'https://chatgpt.com/connector_platform_oauth_redirect',
  scopes: [...TOOL_SCOPES], scopesRequested: true, providers: ['google', 'apple'],
}));
writeFileSync('.render/otp.html', renderOtpPage({ challengeToken: 'preview', maskedEmail: 'l***@lakesideride.co' }));
```

Then screenshot the `<main>` element of each page at a 448 px wide viewport and 2.5x device scale. If the card layout changes, move the numbered markers on page 5 (`top: …%` in `guide.html`).
