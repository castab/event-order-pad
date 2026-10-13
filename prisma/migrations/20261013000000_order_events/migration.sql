CREATE TABLE "order_events" (
    "event_id" BIGSERIAL PRIMARY KEY,
    "order_id" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "event_type" TEXT NOT NULL CHECK ("event_type" IN ('submitted', 'completed', 'reopened')),
    "order_jsonb" JSONB NOT NULL,
    CONSTRAINT "order_events_ticket_identity" CHECK (
        jsonb_typeof("order_jsonb") = 'object'
        AND "order_jsonb" ? 'id'
        AND "order_jsonb"->>'id' = "order_id"
    )
);
CREATE INDEX "order_events_latest_idx" ON "order_events" ("order_id", "event_id" DESC);
CREATE UNIQUE INDEX "order_events_one_submission" ON "order_events" ("order_id") WHERE "event_type" = 'submitted';
