-- A correct access code only asks to sign in. The token's session row exists
-- once the station approves the request, so a found slip alone grants nothing.
CREATE TABLE sign_in_requests (
  token_hash TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE,
  code_id TEXT NOT NULL REFERENCES access_codes(id) ON DELETE CASCADE,
  browser_hash TEXT NOT NULL, match_number TEXT NOT NULL CHECK (match_number ~ '^[0-9]{4}$'),
  device TEXT NOT NULL, ip_hash TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
  created_at TIMESTAMPTZ(3) NOT NULL, expires_at TIMESTAMPTZ(3) NOT NULL,
  decided_at TIMESTAMPTZ(3), CHECK (expires_at > created_at)
);
-- Staff read the number aloud, so no two waiting devices share one.
CREATE UNIQUE INDEX sign_in_requests_pending_match_idx ON sign_in_requests (match_number)
  WHERE status = 'pending';
CREATE INDEX sign_in_requests_code_id_idx ON sign_in_requests(code_id);
CREATE INDEX sign_in_requests_browser_hash_idx ON sign_in_requests(browser_hash);
CREATE INDEX sign_in_requests_expires_at_idx ON sign_in_requests(expires_at);
