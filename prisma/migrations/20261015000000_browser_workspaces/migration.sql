CREATE TABLE workspaces (
  id text PRIMARY KEY,
  cookie_id text UNIQUE,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  draft jsonb NOT NULL,
  latest_ticket_id text REFERENCES tickets(id)
);
INSERT INTO workspaces (id, revision, draft, latest_ticket_id)
SELECT 'legacy', revision,
  CASE WHEN draft->>'submittedTicketId' IS NOT NULL THEN draft ELSE draft - 'reference' END,
  latest_ticket_id FROM station;
-- A station-less upgrade can still contain ticket history.
INSERT INTO workspaces (id, draft)
SELECT 'legacy', '{"name":"","servings":[],"editor":{"flavors":[],"container":"","toppings":[]}}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM workspaces) AND EXISTS (SELECT 1 FROM tickets);
ALTER TABLE tickets ADD COLUMN workspace_id text;
UPDATE tickets SET workspace_id = 'legacy';
ALTER TABLE tickets ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE tickets ADD CONSTRAINT tickets_workspace_fk FOREIGN KEY (workspace_id) REFERENCES workspaces(id);
INSERT INTO station (id, draft) VALUES
(1, '{"name":"","servings":[],"editor":{"flavors":[],"container":"","toppings":[]}}'::jsonb)
ON CONFLICT DO NOTHING;
UPDATE station SET reference_counter = GREATEST(reference_counter,
  COALESCE((SELECT MAX((content->>'reference')::bigint) FROM tickets), 0),
  COALESCE((SELECT MAX((order_jsonb->>'reference')::bigint) FROM order_events), 0));
ALTER TABLE station DROP CONSTRAINT station_latest_ticket_fk;
ALTER TABLE station DROP COLUMN revision, DROP COLUMN draft, DROP COLUMN latest_ticket_id;
