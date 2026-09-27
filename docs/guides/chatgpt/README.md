# Splitt in ChatGPT: vendor guide

`splitt-chatgpt-vendor-guide.pdf` is an 11-page guide for Splitt vendors: how to connect ChatGPT (and, on page 10, Claude) to their Splitt account through this MCP server, what they can ask it to do, who on a team can do what, how they stay in control, and what to do when something goes wrong. It follows the house style of the Google Things to do guide (SPLIT-1581, `splitmygear-frontend/content/vendor-resources/google-things-to-do/`).

## Status: MCP 2.0 is live; three items before this guide goes to vendors

MCP 2.0 (OAuth sign-in and role-aware vendor tools) has been live at `https://mcp-server-splitmygear.vercel.app/api/mcp` since 2026-09-27: release v2.0.0, PR #45, which superseded #34, #40 and #43. ChatGPT, Claude and Claude Code connect with the vendor's own Splitt login and see production go-splitt.com data.

**Send this guide to vendors once items 6 to 8 below are done.**

### Launch checklist

1. **Done (2026-09-27): MCP 2.0 shipped with its production settings.** Signing key, public URL, relay key and the shared store are set, and the sign-in fixes from #43 shipped with it (see [Sign-in blockers](#sign-in-blockers-found-before-launch-fixed-and-shipped-in-20)).
2. **Done: ChatGPT's and Claude's redirects are allowed, and nothing else.** The allow-list pins the documented callbacks: `chatgpt.com/connector_platform_oauth_redirect`, `chatgpt.com/connector/oauth/{id}` and `claude.ai/api/mcp/auth_callback`. Claude Code signs in through a loopback address on any port.
3. **Done: the MCP serves production** (SPLIT-1502). go-splitt.com accounts sign in, and a token from any other backend is refused.
4. **Done: Continue with Google.** The production backend accepts the MCP sign-in page as a Google return address. Apple sign-in is not configured on the backend: on 2026-09-27 `GET /api/v1/auth/providers` returned `{"google":true,"apple":false}` and the live sign-in page rendered one social button, Google. The guide shows Google only.
5. **Done: rate limit tier `beta`.** That is 50 requests and 500 tool calls a minute per account, well above a normal ChatGPT or Claude session.
6. **Open: connect a real vendor account from ChatGPT and from Claude**, and walk the guide page by page:
   - create the connection;
   - sign in with a password, with two-step verification and with Google;
   - run a read, confirm a write, then disconnect.

   Everything except the human sign-in has been exercised: the exact ChatGPT, Claude and Claude Code registration and redirect flows in a real browser against the real backend code, an LLM running a vendor's day through the tools, and read-only checks on production.
7. **Open: re-check ChatGPT's click-paths** against the live UI while doing item 6:
   - Settings › Security and login › Developer mode
   - chatgpt.com/plugins › +
   - \+ › Developer mode or More in a chat

   These come from OpenAI's help center, developer docs and cookbook as of September 2026, and OpenAI renames these menus often.
8. **Open: team seats (SPLIT-1602).** Managers and staff see none of their shop's listings or bookings today, because the backend scopes every vendor read to the caller's own id. That holds in ChatGPT, in Claude and in the vendor dashboard alike. The guide's "Manager or staff" rows describe the intended behaviour. Until SPLIT-1602 ships, hold the guide or tell vendors to connect with the owner login.

### Sign-in blockers found before launch (fixed and shipped in 2.0)

PR #43 fixed all three, following the fixes below, with tests that fail when a fix is reverted, and made the token endpoint re-check the redirect-host allow-list. It shipped inside #45. Kept here as the record of what a real browser caught. The findings as first recorded:

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

- **No real ChatGPT or Claude session yet** (checklist item 6). The protocol side is covered in a real browser against the real backend code:
  - dynamic client registration with each client's own request body (2.0 does not advertise Client ID Metadata Documents);
  - the pinned callbacks, with RFC 9207 `iss` on every redirect (ChatGPT needs it for its stable callback);
  - `resource` as the bare origin or `/api/mcp`, PKCE, and refresh with a grace window.
- **Team seats see an empty shop** (SPLIT-1602, checklist item 8).
- **Legacy `vendor` role gets no payout tools.** Accounts with the plain `vendor` role, as opposed to `vendor_owner`, get the vendor tools but not the owner-only payout tools. The guide tells owners they can see earnings and payouts.
- **Two tool descriptions overstated access** (fixed; shipped in 2.0). `get_vendor_earnings` and `get_vendor_payouts` said "owner/manager seats", but the registry limits them to the owner seat. The guide follows the code.

## What each claim rests on

| Claim in the guide | Source |
|---|---|
| Sign-in page text, consent card, 2FA step, error messages, 10-minute page expiry, 10 failures per 10 minutes | `main`: `src/lib/oauth/pages.ts`, `authorize.ts`, `backend-auth.ts`, `throttle.ts` |
| The twelve kinds of access (verbatim) | `main`: `src/lib/oauth/scopes.ts` |
| Owner-only earnings and payouts; staff get 403 on pricing rules; settings every seat can change | `main`: `src/lib/roles.ts`, `src/tools/registry.ts`, `src/tools/defs/pricing-rules.ts`, `vendor-extras.ts` |
| Example prompts (every one maps to a real tool) | `main`: `docs/mcp-tools.md` |
| Reads run straight away, writes wait for confirmation | Every 2.0 tool sets `readOnlyHint`/`destructiveHint` (`src/tools/defs/common.ts`); ChatGPT honours `readOnlyHint` and confirms write actions by default (OpenAI developer mode docs) |
| Host cancellation refunds the renter in full; weather cancellations excluded from the reliability penalty | backend `booking.service.ts` (host-cancel refund), `booking.entity.ts` (`cancellationReason`) |
| Declined reschedule cancels with a full refund | `main`: `propose_booking_reschedule` description |
| Password reset signs you out everywhere; vendor approval revokes sessions | backend `user.service.ts` (SPLIT-708), `vendor-onboarding.service.ts` |
| Messaging only people you have booked with or talked to | backend `chat.service.ts` |
| Access renews in the background; about 15-minute access tokens; 30-day refresh | ADR 0002, backend `token.service.ts`, `refresh-token.service.ts` |
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

The two sign-in screenshots (`assets/signin.png`, `assets/otp.png`) are the server's own `renderLoginPage`/`renderOtpPage` output, captured with Chromium. To refresh them after a sign-in page change, run this from a checkout of `main` with `npm install --no-save tsx`:

```ts
// .render/render-pages.ts   (npx tsx --tsconfig tsconfig.json .render/render-pages.ts)
import { writeFileSync } from 'node:fs';
import { renderLoginPage, renderOtpPage } from '@/lib/oauth/pages';
import { TOOL_SCOPES } from '@/lib/oauth/scopes';

writeFileSync('.render/signin.html', renderLoginPage({
  requestToken: 'preview', clientName: 'ChatGPT', verified: true, loopback: false,
  redirectUri: 'https://chatgpt.com/connector_platform_oauth_redirect',
  scopes: [...TOOL_SCOPES], scopesRequested: true, providers: ['google'],
}));
writeFileSync('.render/otp.html', renderOtpPage({ challengeToken: 'preview', maskedEmail: 'l***@lakesideride.co' }));
```

Then screenshot the `<main>` element of each page at a 448 px wide viewport and 2.5x device scale. If the card layout changes, move the numbered markers on page 5 (`top: …%` in `guide.html`).
