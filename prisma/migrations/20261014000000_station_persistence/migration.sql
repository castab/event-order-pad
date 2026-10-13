CREATE TABLE station (
  id integer PRIMARY KEY CHECK (id = 1),
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  reference_counter bigint NOT NULL DEFAULT 0 CHECK (reference_counter >= 0),
  draft jsonb NOT NULL,
  latest_ticket_id text
);
CREATE TABLE tickets (id text PRIMARY KEY, content jsonb NOT NULL);
CREATE TABLE print_attempts (
  id text PRIMARY KEY,
  ticket_id text NOT NULL REFERENCES tickets(id),
  content jsonb NOT NULL
);
CREATE INDEX print_attempts_ticket_id_idx ON print_attempts(ticket_id);
CREATE TABLE print_dispatches (
  attempt_id text PRIMARY KEY REFERENCES print_attempts(id),
  request jsonb NOT NULL,
  result jsonb,
  completed_at timestamptz(3),
  CHECK ((result IS NULL) = (completed_at IS NULL))
);
ALTER TABLE station ADD CONSTRAINT station_latest_ticket_fk FOREIGN KEY (latest_ticket_id) REFERENCES tickets(id);
