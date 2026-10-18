ALTER TABLE orders ADD COLUMN idempotency_key_hash TEXT;
ALTER TABLE orders ADD COLUMN request_hash TEXT;
ALTER TABLE orders ADD COLUMN access_token_hash TEXT;
ALTER TABLE orders ADD COLUMN hosted_checkout_url TEXT;
ALTER TABLE orders ADD COLUMN checkout_creation_state TEXT NOT NULL DEFAULT 'not_started'
  CHECK (checkout_creation_state IN ('not_started', 'in_progress', 'created', 'failed', 'uncertain'));
ALTER TABLE orders ADD COLUMN last_error_code TEXT;
ALTER TABLE orders ADD COLUMN paid_at TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_idempotency_key_hash
  ON orders (idempotency_key_hash);

CREATE TABLE IF NOT EXISTS sumup_webhook_events (
  event_fingerprint TEXT PRIMARY KEY,
  checkout_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  verified_status TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (checkout_id)
    REFERENCES orders (checkout_id)
    ON UPDATE CASCADE
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sumup_webhook_events_checkout
  ON sumup_webhook_events (checkout_id, processed_at);
