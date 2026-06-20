-- SPLIT-373 — durable, shared, race-safe rate-limit store for the MCP server.
--
-- This is the EXACT DDL applied to the Supabase project (dtmqmkhsjdngydpaafip)
-- via the Supabase MCP `apply_migration` on 2026-06-20. The MCP has no TypeORM
-- runner, so this file is a checked-in record of the applied schema (the source
-- of truth is the live database / Supabase `migrations` table); apply it with
-- the Supabase MCP / dashboard if recreating the store.
--
-- Replaces the per-instance in-memory Map in src/middleware/rate-limit.ts, which
-- enforced no real limit across Vercel lambdas. Conventions mirror existing
-- tables (lead / login_attempt): snake_case table, camelCase columns,
-- `timestamp without time zone` default now(). RLS is enabled deny-by-default
-- (the MCP connects with the service-role key, which bypasses RLS).

-- Migration 1: split373_mcp_rate_limit ---------------------------------------

CREATE TABLE IF NOT EXISTS public.mcp_rate_limit (
  "clientId"    character varying NOT NULL,
  "windowStart" timestamp without time zone NOT NULL,
  count         integer NOT NULL DEFAULT 0,
  "expiresAt"   timestamp without time zone NOT NULL,
  "createdAt"   timestamp without time zone NOT NULL DEFAULT now(),
  CONSTRAINT mcp_rate_limit_pkey PRIMARY KEY ("clientId", "windowStart")
);

-- Lets a cheap background/lazy delete reclaim expired rows by range scan.
CREATE INDEX IF NOT EXISTS "IDX_mcp_rate_limit_expiresAt"
  ON public.mcp_rate_limit ("expiresAt");

-- Deny-by-default RLS. The MCP connects with the service-role key, which
-- BYPASSES RLS, so no policies are needed; this only blocks the anon/auth
-- roles (clean security advisor), matching the project convention.
ALTER TABLE public.mcp_rate_limit ENABLE ROW LEVEL SECURITY;

-- Atomic increment-and-return within a SINGLE statement (race-safe across
-- concurrent lambdas). Computes the fixed window from the request time so all
-- instances bucket into the same row; ON CONFLICT increments the existing
-- counter. Returns the NEW count for this window.
--   p_client_id : caller identity (userId | ip | x-forwarded-for | 'anonymous')
--   p_window_ms : window size in milliseconds
-- SECURITY DEFINER so it runs as the function owner (postgres) regardless of
-- the calling role; search_path pinned to defeat search-path hijacking.
CREATE OR REPLACE FUNCTION public.mcp_rate_limit_hit(
  p_client_id character varying,
  p_window_ms integer
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now          timestamp without time zone := now();
  v_window_start timestamp without time zone;
  v_expires_at   timestamp without time zone;
  v_count        integer;
BEGIN
  -- Floor "now" to the start of the current fixed window so every instance
  -- shares the same bucket. epoch(now) / window_seconds, truncated.
  v_window_start := to_timestamp(
    floor(extract(epoch FROM v_now) / (p_window_ms / 1000.0))
      * (p_window_ms / 1000.0)
  ) AT TIME ZONE 'UTC';
  v_expires_at := v_window_start + make_interval(secs => p_window_ms / 1000.0);

  INSERT INTO public.mcp_rate_limit AS r ("clientId", "windowStart", count, "expiresAt")
  VALUES (p_client_id, v_window_start, 1, v_expires_at)
  ON CONFLICT ("clientId", "windowStart")
  DO UPDATE SET count = r.count + 1
  RETURNING count INTO v_count;

  RETURN v_count;
END;
$$;

-- Migration 2: split373_mcp_rate_limit_revoke_anon_exec ----------------------
-- Lock the SECURITY DEFINER function to the service role only, removing the
-- PostgREST /rest/v1/rpc/ attack surface (anon could otherwise pump the table).
REVOKE ALL ON FUNCTION public.mcp_rate_limit_hit(character varying, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mcp_rate_limit_hit(character varying, integer) FROM anon;
REVOKE ALL ON FUNCTION public.mcp_rate_limit_hit(character varying, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_rate_limit_hit(character varying, integer) TO service_role;
