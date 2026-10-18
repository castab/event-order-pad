-- Shared shift access codes replace personal accounts, passwords and passkeys.
CREATE TABLE access_codes (
  id TEXT PRIMARY KEY, code_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ(3) NOT NULL, expires_at TIMESTAMPTZ(3) NOT NULL,
  revoked_at TIMESTAMPTZ(3), CHECK (expires_at > created_at)
);
-- At most one code can be active; minting revokes the previous code first.
CREATE UNIQUE INDEX access_codes_single_active_idx ON access_codes ((true))
  WHERE revoked_at IS NULL;
CREATE INDEX access_codes_expires_at_idx ON access_codes(expires_at);

-- Workspaces follow the browser cookie alone, so drafts and pending attempts
-- survive code rotations. Browsers that had one account keep that workspace;
-- the rest stay in `workspaces` as untouched archives.
CREATE TABLE access_workspaces (
  browser_hash TEXT PRIMARY KEY, workspace_key TEXT NOT NULL UNIQUE
);
INSERT INTO access_workspaces (browser_hash, workspace_key)
SELECT browser_hash, MIN(workspace_key) FROM auth_workspaces
GROUP BY browser_hash HAVING COUNT(*) = 1;

DROP TABLE auth_workspaces;
DROP TABLE auth_sessions;
DROP TABLE auth_passkeys;
DROP TABLE auth_challenges;
DROP TABLE auth_tokens;
DROP TABLE auth_users;

CREATE TABLE auth_sessions (
  token_hash TEXT PRIMARY KEY, code_id TEXT NOT NULL REFERENCES access_codes(id),
  authenticated_at TIMESTAMPTZ(3) NOT NULL, expires_at TIMESTAMPTZ(3) NOT NULL
);
CREATE INDEX auth_sessions_code_id_idx ON auth_sessions(code_id);
CREATE INDEX auth_sessions_expires_at_idx ON auth_sessions(expires_at);

-- Historical rows keep user_id; new rows record the access code instead.
ALTER TABLE auth_events ADD COLUMN code_id TEXT;
