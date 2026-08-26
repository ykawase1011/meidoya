-- 0003: split the outbox claim lease out of available_at.
--
-- available_at used to carry two incompatible meanings: "retry no earlier
-- than" while the row is pending, and "the claim expires at" while it is
-- sending. The claim query read both with the same predicate, so a dispatch
-- that ran longer than its lease was re-claimed by the next pass and the
-- message was posted twice. Lease expiry now lives in its own column and is
-- only ever consulted for `sending` rows.
--
-- claim_token identifies WHICH worker holds the current lease. A worker whose
-- lease expired (and whose row was handed to somebody else) can no longer mark
-- that row sent or reschedule it: its token no longer matches.

ALTER TABLE notification_outbox ADD COLUMN lease_expires_at INTEGER;
ALTER TABLE notification_outbox ADD COLUMN claim_token TEXT;

-- Rows stranded in `sending` by a pre-migration process kept their lease in
-- available_at; carry it over so they are neither lost nor stolen early.
UPDATE notification_outbox
   SET lease_expires_at = available_at
 WHERE status = 'sending' AND lease_expires_at IS NULL;

-- The reclaim half of the claim query: expired leases only.
CREATE INDEX IF NOT EXISTS outbox_lease_idx
  ON notification_outbox(lease_expires_at)
  WHERE status = 'sending';
