-- Each access code now admits one device. Shared codes and their sessions end
-- here, so every device signs in once more with a code of its own.
UPDATE access_codes SET revoked_at = now() WHERE revoked_at IS NULL;
DELETE FROM auth_sessions;

-- Several unused codes may be out at once; each must be redeemed within its window.
DROP INDEX access_codes_single_active_idx;
ALTER TABLE access_codes RENAME COLUMN expires_at TO redeem_by;
ALTER INDEX access_codes_expires_at_idx RENAME TO access_codes_redeem_by_idx;
ALTER TABLE access_codes ADD COLUMN redeemed_at TIMESTAMPTZ(3),
  ADD CHECK (redeemed_at IS NULL OR redeemed_at < redeem_by);

-- A code opens at most one session, ever: a used code stays used after sign-out.
ALTER TABLE auth_sessions ADD COLUMN device TEXT NOT NULL;
DROP INDEX auth_sessions_code_id_idx;
CREATE UNIQUE INDEX auth_sessions_code_id_key ON auth_sessions(code_id);
