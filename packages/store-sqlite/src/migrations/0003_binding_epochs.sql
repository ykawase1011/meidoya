-- Revocation epochs for ingress bindings (04 section 8).
--
-- A scope token carries the epoch of the binding it was issued under, and the
-- Control Plane refuses a token whose epoch is superseded. Keeping the epoch in
-- memory only would make revocation survive exactly as long as the process:
-- restart the daemon and every revoked token would verify again for the rest of
-- its lifetime. This table is what makes a revocation durable.
--
-- `credential_fingerprint` is a salted digest of the binding's session
-- credential, never the credential itself. Rotating the credential file changes
-- the fingerprint, which bumps the epoch on the next boot: a rotated secret
-- cannot leave older sessions alive.

CREATE TABLE binding_epochs (
  binding_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  credential_fingerprint TEXT,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_binding_epochs_workspace ON binding_epochs (workspace_id);
