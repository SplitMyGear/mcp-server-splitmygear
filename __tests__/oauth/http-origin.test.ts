/**
 * isSameOriginPost: the same-origin gate on the hosted sign-in form.
 * `Origin: null` is what a browser sends for its own form POST under a
 * `no-referrer` policy; it passes only when the browser also says the request
 * is same-origin (Sec-Fetch-Site cannot be set by page script).
 */
import { isSameOriginPost } from '../../src/lib/oauth/http';

const URL_ = 'https://mcp.test/oauth/authorize';
const post = (headers: Record<string, string>) => new Request(URL_, { method: 'POST', headers });

describe('isSameOriginPost', () => {
  it('accepts the real origin, and non-browser clients that send neither header', () => {
    expect(isSameOriginPost(post({ origin: 'https://mcp.test', 'sec-fetch-site': 'same-origin' }))).toBe(true);
    expect(isSameOriginPost(post({ origin: 'https://MCP.test' }))).toBe(true);
    expect(isSameOriginPost(post({}))).toBe(true);
  });

  it('accepts Origin: null only when the browser vouches same-origin', () => {
    expect(isSameOriginPost(post({ origin: 'null', 'sec-fetch-site': 'same-origin' }))).toBe(true);
    expect(isSameOriginPost(post({ origin: 'null' }))).toBe(false); // no browser assertion
    expect(isSameOriginPost(post({ origin: 'null', 'sec-fetch-site': 'none' }))).toBe(false);
    expect(isSameOriginPost(post({ origin: 'null', 'sec-fetch-site': 'same-site' }))).toBe(false);
    expect(isSameOriginPost(post({ origin: 'null', 'sec-fetch-site': 'cross-site' }))).toBe(false); // sandboxed frame, data: URL
  });

  it('refuses other origins whatever Sec-Fetch-Site claims', () => {
    expect(isSameOriginPost(post({ origin: 'https://attacker.example', 'sec-fetch-site': 'same-origin' }))).toBe(false);
    expect(isSameOriginPost(post({ origin: 'https://attacker.example' }))).toBe(false);
    expect(isSameOriginPost(post({ 'sec-fetch-site': 'cross-site' }))).toBe(false);
    expect(isSameOriginPost(post({ origin: 'https://mcp.test.attacker.example', 'sec-fetch-site': 'same-origin' }))).toBe(false);
  });
});
