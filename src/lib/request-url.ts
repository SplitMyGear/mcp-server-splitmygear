/**
 * The URL a request was made to, exactly as the client sent it.
 *
 * Next.js hands every route handler a NextRequest, and its `url` and `nextUrl`
 * replace the first loopback address found ANYWHERE in the URL, query string
 * included, with "localhost" (REGEX_LOCALHOST_HOSTNAME in
 * next/dist/server/web/next-url.js). On a public host that first address is
 * usually a query parameter, so `redirect_uri=http://127.0.0.1:PORT/callback`
 * reached /oauth/authorize as `http://localhost:PORT/callback`: a client that
 * registered only 127.0.0.1, the form RFC 8252 §8.3 recommends, was refused,
 * and one that registered both was sent back to an address it had not asked
 * for. A `state` holding a loopback URL came back altered too.
 *
 * The Fetch API's own `url` getter returns the URL the request was built
 * with, before that rewrite. Read request URLs through this function, never
 * through `request.url` or `nextUrl`.
 */
const fetchRequestUrl = Object.getOwnPropertyDescriptor(Request.prototype, 'url')?.get;

export function requestUrl(request: Request): URL {
  const raw: unknown = fetchRequestUrl ? fetchRequestUrl.call(request) : request.url;
  return new URL(typeof raw === 'string' ? raw : request.url);
}
