CREATE TABLE auth_users (
  id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE,
  password_hash TEXT, enabled BOOLEAN NOT NULL DEFAULT true,
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (username ~ '^[a-z0-9._-]{3,32}$')
);
CREATE TABLE auth_sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES auth_users(id),
  version INTEGER NOT NULL, authenticated_at TIMESTAMPTZ(3) NOT NULL,
  expires_at TIMESTAMPTZ(3) NOT NULL
);
CREATE INDEX auth_sessions_user_id_idx ON auth_sessions(user_id);
CREATE INDEX auth_sessions_expires_at_idx ON auth_sessions(expires_at);
CREATE TABLE auth_passkeys (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES auth_users(id),
  public_key BYTEA NOT NULL, counter BIGINT NOT NULL CHECK (counter >= 0),
  transports TEXT[] NOT NULL, device_type TEXT NOT NULL, backed_up BOOLEAN NOT NULL,
  name TEXT NOT NULL, created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX auth_passkeys_user_id_idx ON auth_passkeys(user_id);
CREATE TABLE auth_challenges (
  token_hash TEXT PRIMARY KEY, browser_hash TEXT NOT NULL, session_hash TEXT,
  user_id TEXT, version INTEGER,
  kind TEXT NOT NULL CHECK (kind IN ('login', 'register', 'reauth')),
  challenge TEXT NOT NULL, expires_at TIMESTAMPTZ(3) NOT NULL
);
CREATE INDEX auth_challenges_expires_at_idx ON auth_challenges(expires_at);
CREATE TABLE auth_tokens (
  token_hash TEXT PRIMARY KEY, username TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('invite', 'recover')), user_id TEXT,
  expires_at TIMESTAMPTZ(3) NOT NULL, UNIQUE (kind, username)
);
CREATE INDEX auth_tokens_expires_at_idx ON auth_tokens(expires_at);
CREATE TABLE auth_rates (
  key TEXT PRIMARY KEY, count INTEGER NOT NULL CHECK (count >= 0),
  expires_at TIMESTAMPTZ(3) NOT NULL
);
CREATE INDEX auth_rates_expires_at_idx ON auth_rates(expires_at);
CREATE TABLE auth_events (
  id BIGSERIAL PRIMARY KEY, kind TEXT NOT NULL, user_id TEXT, ip_hash TEXT,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX auth_events_created_at_idx ON auth_events(created_at);
CREATE TABLE auth_workspaces (
  user_id TEXT NOT NULL REFERENCES auth_users(id), browser_hash TEXT NOT NULL,
  workspace_key TEXT NOT NULL UNIQUE, PRIMARY KEY (user_id, browser_hash)
);
