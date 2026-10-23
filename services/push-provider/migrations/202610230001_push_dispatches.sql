-- Private provider receipt ledger. Additive only; never expose this schema to PostgREST.
CREATE SCHEMA IF NOT EXISTS push_provider;
REVOKE ALL ON SCHEMA push_provider FROM PUBLIC;
CREATE TABLE IF NOT EXISTS push_provider.dispatches (
    operation_key TEXT PRIMARY KEY CHECK(length(operation_key) BETWEEN 20 AND 200),
    request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
    platform TEXT NOT NULL CHECK(platform IN ('ios','android')),
    notification_id UUID NOT NULL,
    provider_request_id UUID NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK(status IN ('prepared','dispatching','accepted','rejected','ambiguous')),
    claim_id UUID,
    lease_until BIGINT,
    provider_message_id TEXT CHECK(length(provider_message_id) <= 256),
    provider_code TEXT CHECK(length(provider_code) <= 80),
    retryable BOOLEAN NOT NULL DEFAULT FALSE,
    token_invalid BOOLEAN NOT NULL DEFAULT FALSE,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    dispatched_at BIGINT,
    CHECK(status <> 'accepted' OR provider_message_id IS NOT NULL),
    CHECK((status = 'prepared') OR claim_id IS NULL)
);
ALTER TABLE push_provider.dispatches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON push_provider.dispatches FROM PUBLIC;
-- Provision a dedicated owner/service database role with USAGE and table
-- SELECT/INSERT/UPDATE. Do not grant anon/authenticated roles or API schema access.
