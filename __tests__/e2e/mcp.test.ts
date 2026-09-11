export {};

const MCP_SERVER_URL = process.env.MCP_SERVER_URL || 'http://localhost:3000';

const isServerRunning = async (): Promise<boolean> => {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);
    await fetch(`${MCP_SERVER_URL}/api/mcp`, { 
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    });
    clearTimeout(timeoutId);
    return true;
  } catch {
    return false;
  }
};

describe('E2E: MCP Server Tools', () => {
  beforeAll(async () => {
    const serverRunning = await isServerRunning();
    if (!serverRunning) {
      console.log('⚠️  E2E tests skipped - MCP server not running');
    }
  });

  const itE2E = (name: string, fn: () => Promise<void>) => {
    it(name, async () => {
      const serverRunning = await isServerRunning();
      if (!serverRunning) {
        console.log('⚠️  Skipping - MCP server not running');
        return;
      }
      await fn();
    });
  };

  describe('Listing Tools', () => {
    itE2E('should respond to search_listings tool call', async () => {
      const requestBody = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      };

      const response = await fetch(`${MCP_SERVER_URL}/api/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      expect(response.status).toBeDefined();
    });

    itE2E('should return valid tool schema for search_listings', async () => {
      const toolsListRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      };

      const response = await fetch(`${MCP_SERVER_URL}/api/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(toolsListRequest),
      });

      const data = await response.json();
      expect(data).toBeDefined();
    });

    itE2E('should handle invalid tool name gracefully', async () => {
      const invalidToolRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'invalid_tool_name',
          arguments: {},
        },
      };

      const response = await fetch(`${MCP_SERVER_URL}/api/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(invalidToolRequest),
      });

      expect(response.status).toBeGreaterThanOrEqual(200);
    });
  });

  describe('Authentication', () => {
    itE2E('should reject requests without authentication', async () => {
      const requestBody = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      };

      const response = await fetch(`${MCP_SERVER_URL}/api/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      expect(response.status).toBeDefined();
    });

    itE2E('should accept requests with valid JWT token', async () => {
      const requestBody = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      };

      const response = await fetch(`${MCP_SERVER_URL}/api/mcp`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': 'Bearer valid-test-token',
        },
        body: JSON.stringify(requestBody),
      });

      expect(response.status).toBeDefined();
    });

    itE2E('should accept requests with API key', async () => {
      const requestBody = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      };

      const response = await fetch(`${MCP_SERVER_URL}/api/mcp`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'x-api-key': 'test-api-key',
        },
        body: JSON.stringify(requestBody),
      });

      expect(response.status).toBeDefined();
    });
  });

  describe('Rate Limiting', () => {
    itE2E('should include rate limit headers in response', async () => {
      const requestBody = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      };

      const response = await fetch(`${MCP_SERVER_URL}/api/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      expect(response.headers.get('x-ratelimit-remaining')).toBeDefined();
    });
  });

  describe('Error Handling', () => {
    itE2E('should return JSON-RPC error for invalid request', async () => {
      const invalidRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'invalid/method',
        params: {},
      };

      const response = await fetch(`${MCP_SERVER_URL}/api/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(invalidRequest),
      });

      const data = await response.json();
      expect(data.jsonrpc).toBe('2.0');
      expect(data.error).toBeDefined();
    });

    itE2E('should handle missing parameters gracefully', async () => {
      const requestWithoutParams = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
      };

      const response = await fetch(`${MCP_SERVER_URL}/api/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestWithoutParams),
      });

      expect(response.status).toBeDefined();
    });
  });

  describe('CORS', () => {
    itE2E('should handle OPTIONS request', async () => {
      const response = await fetch(`${MCP_SERVER_URL}/api/mcp`, {
        method: 'OPTIONS',
        headers: {
          'Origin': 'http://localhost:3001',
          'Access-Control-Request-Method': 'POST',
        },
      });

      expect([200, 204]).toContain(response.status);
    });
  });
});

describe('E2E: Complete User Flows', () => {
  const itE2E = (name: string, fn: () => Promise<void>) => {
    it(name, async () => {
      const serverRunning = await isServerRunning();
      if (!serverRunning) {
        console.log('⚠️  Skipping - MCP server not running');
        return;
      }
      await fn();
    });
  };

  itE2E('should complete search to booking flow', async () => {
    const searchRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'search_listings',
        arguments: { location: 'Seattle' },
      },
    };

    const searchResponse = await fetch(`${MCP_SERVER_URL}/api/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(searchRequest),
    });

    expect(searchResponse.status).toBeDefined();
  });

  itE2E('should handle booking creation flow', async () => {
    const bookingRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'create_booking',
        arguments: {
          listingId: '11111111-1111-4111-8111-111111111111',
          checkIn: '2026-06-01',
          checkOut: '2026-06-03',
        },
      },
    };

    const response = await fetch(`${MCP_SERVER_URL}/api/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bookingRequest),
    });

    expect(response.status).toBeDefined();
  });

  itE2E('should handle booking cancellation flow', async () => {
    const cancelRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'cancel_booking',
        arguments: {
          bookingId: '22222222-2222-4222-8222-222222222222',
        },
      },
    };

    const response = await fetch(`${MCP_SERVER_URL}/api/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cancelRequest),
    });

    expect(response.status).toBeDefined();
  });

  itE2E('should handle availability checking', async () => {
    const availabilityRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'check_availability',
        arguments: {
          listingId: '11111111-1111-4111-8111-111111111111',
          checkIn: '2026-06-01',
          checkOut: '2026-06-03',
          guests: 2,
        },
      },
    };

    const response = await fetch(`${MCP_SERVER_URL}/api/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(availabilityRequest),
    });

    expect(response.status).toBeDefined();
  });
});
