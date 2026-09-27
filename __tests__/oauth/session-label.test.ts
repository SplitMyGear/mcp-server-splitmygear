import { sanitizeUserAgent } from '../../src/lib/oauth/backend-auth';

// SPLIT-1603: the backend stores this as the session's user agent, and the user's
// Splitt sessions list reads it to show "Claude, via the Splitt MCP" next to Revoke.
describe('sanitizeUserAgent: the label a user sees on an assistant session', () => {
  it('appends the MCP and the client name to the relayed browser user agent', () => {
    expect(sanitizeUserAgent('Mozilla/5.0 (Macintosh)', 'Claude')).toBe('Mozilla/5.0 (Macintosh) (via splitt-mcp; Claude)');
  });

  it('labels a session without a browser user agent by the MCP and client alone', () => {
    expect(sanitizeUserAgent(undefined, 'ChatGPT')).toBe('splitt-mcp; ChatGPT');
    expect(sanitizeUserAgent('   ', 'ChatGPT')).toBe('splitt-mcp; ChatGPT');
  });

  it('keeps the old label when no client name is known', () => {
    expect(sanitizeUserAgent('TestBrowser/1')).toBe('TestBrowser/1 (via splitt-mcp)');
    expect(sanitizeUserAgent(undefined)).toBe('splitt-mcp');
  });

  it('never lets a self-registered client name break out of the label or pose as something else', () => {
    // Anyone can register a client with any name (dynamic registration).
    expect(sanitizeUserAgent('UA', 'Evil) (via go-splitt.com; Support')).toBe('UA (via splitt-mcp; Evil via go-splitt.com Support)');
    expect(sanitizeUserAgent('UA', 'Café‮\u0000Bot')).toBe('UA (via splitt-mcp; CafBot)');
    expect(sanitizeUserAgent('UA', '((( )))')).toBe('UA (via splitt-mcp)');
  });

  it('bounds the client name to 40 characters and collapses whitespace', () => {
    const label = sanitizeUserAgent('UA', `A${'b'.repeat(80)}   c`);
    expect(label).toBe(`UA (via splitt-mcp; A${'b'.repeat(39)})`);
    expect(sanitizeUserAgent('UA', 'Claude    Code')).toBe('UA (via splitt-mcp; Claude Code)');
  });
});
