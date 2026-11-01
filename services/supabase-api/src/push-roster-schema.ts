export const pushRosterSchemaStatements: readonly string[] = [
    `CREATE TABLE IF NOT EXISTS notification_dispatch_plans(
        notification_id TEXT PRIMARY KEY REFERENCES notifications(id) ON DELETE CASCADE,
        subject_sha256 TEXT NOT NULL CHECK(subject_sha256 ~ '^[0-9a-f]{64}$'),
        provider_generation TEXT NOT NULL CHECK(provider_generation ~ '^[0-9a-f]{64}$'),
        plan_sha256 TEXT NOT NULL CHECK(plan_sha256 ~ '^[0-9a-f]{64}$'),
        plan_json TEXT NOT NULL CHECK(json_valid(plan_json) AND length(plan_json)<=16384), created_at INTEGER NOT NULL
    )`,
    `CREATE TRIGGER IF NOT EXISTS notification_dispatch_plan_immutable BEFORE UPDATE ON notification_dispatch_plans
        BEGIN SELECT RAISE(ABORT,'notification_dispatch_plan_immutable'); END`,
    `CREATE TABLE IF NOT EXISTS notification_recovered_receipts(
        operation_key TEXT PRIMARY KEY,
        notification_id TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
        plan_sha256 TEXT NOT NULL CHECK(plan_sha256 ~ '^[0-9a-f]{64}$'), device_id TEXT NOT NULL,
        token_sha256 TEXT NOT NULL CHECK(token_sha256 ~ '^[0-9a-f]{64}$'),
        request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
        provider_generation TEXT NOT NULL CHECK(provider_generation ~ '^[0-9a-f]{64}$'),
        status TEXT NOT NULL CHECK(status IN('unstarted','preparing','dispatching','accepted','rejected','ambiguous','cancelled')),
        provider_receipt TEXT,provider_code TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
        CHECK(status<>'accepted' OR provider_receipt IS NOT NULL)
    )`,
    `CREATE INDEX IF NOT EXISTS notification_recovered_notification ON notification_recovered_receipts(notification_id,operation_key)`,
];
