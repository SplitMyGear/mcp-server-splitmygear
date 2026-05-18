# MCP (Model Context Protocol) Production-Ready Tasks

Aligned with the **Elite Engineer Mandate** (smg-autoresearch).

## 1. Triple-Layer Testing
- [ ] **Unit Tests**: Write robust Jest tests for every defined MCP tool to ensure correct context generation and API formatting.
- [ ] **Integration Tests**: Verify connections to the primary SplitMyGear backend or Supabase data layers.
- [ ] **E2E Validation**: Test the MCP server from a simulated client (e.g., Claude Desktop) to ensure end-to-end communication and correct LLM instructions.

## 2. Security & Airtight Operations
- [ ] **Input Validation**: Strictly use `zod` for all tool parameter schemas to prevent prompt injection or malformed requests.
- [ ] **Read-Only Enforcement**: Ensure MCP server tools that query the database are strictly read-only, or use highly constrained RBAC for write operations.
- [ ] **Secret Handling**: Verify `OPENROUTER_API_KEY` and other credentials are secure.
