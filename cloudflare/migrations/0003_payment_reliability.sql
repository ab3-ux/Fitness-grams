ALTER TABLE orders ADD COLUMN reconciliation_state TEXT NOT NULL DEFAULT 'none'
  CHECK (reconciliation_state IN ('none', 'required', 'manual_review', 'resolved'));
ALTER TABLE orders ADD COLUMN last_observed_sumup_status TEXT;
ALTER TABLE orders ADD COLUMN sumup_status_checked_at TEXT;

CREATE TABLE IF NOT EXISTS pending_sumup_notifications (
  checkout_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'processed', 'manual_review')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_error TEXT,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pending_sumup_notifications_due
  ON pending_sumup_notifications (state, next_attempt_at);

CREATE TABLE IF NOT EXISTS stock_reservations (
  order_id TEXT NOT NULL,
  sumup_variant_id TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  expires_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'held'
    CHECK (state IN ('held', 'committed', 'released', 'expired')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (order_id, sumup_variant_id),
  FOREIGN KEY (sumup_variant_id)
    REFERENCES catalog_variants (sumup_variant_id)
    ON UPDATE CASCADE
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_stock_reservations_active
  ON stock_reservations (sumup_variant_id, state, expires_at);
CREATE INDEX IF NOT EXISTS idx_stock_reservations_order
  ON stock_reservations (order_id, state);

CREATE TABLE IF NOT EXISTS payment_rate_limits (
  bucket_key TEXT PRIMARY KEY,
  window_started_at INTEGER NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count >= 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER IF NOT EXISTS trg_orders_paid_stock_guard
BEFORE UPDATE OF status ON orders
WHEN NEW.status = 'paid' AND OLD.status <> 'paid'
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM stock_reservations AS r
    JOIN catalog_variants AS v ON v.sumup_variant_id = r.sumup_variant_id
    WHERE r.order_id = OLD.id
      AND r.state = 'held'
      AND (v.quantity IS NULL OR v.quantity < r.quantity)
  ) THEN RAISE(ABORT, 'reserved stock no longer matches catalog inventory') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_orders_paid_commit_stock
AFTER UPDATE OF status ON orders
WHEN NEW.status = 'paid' AND OLD.status <> 'paid'
BEGIN
  UPDATE catalog_variants
  SET quantity = quantity - (
    SELECT r.quantity
    FROM stock_reservations AS r
    WHERE r.order_id = NEW.id
      AND r.sumup_variant_id = catalog_variants.sumup_variant_id
      AND r.state = 'held'
  )
  WHERE sumup_variant_id IN (
    SELECT sumup_variant_id
    FROM stock_reservations
    WHERE order_id = NEW.id AND state = 'held'
  );

  UPDATE stock_reservations
  SET state = 'committed', updated_at = CURRENT_TIMESTAMP
  WHERE order_id = NEW.id AND state = 'held';
END;

CREATE TRIGGER IF NOT EXISTS trg_orders_terminal_release_stock
AFTER UPDATE OF status ON orders
WHEN NEW.status IN ('failed', 'cancelled', 'expired')
  AND OLD.status = 'pending'
BEGIN
  UPDATE stock_reservations
  SET state = 'released', updated_at = CURRENT_TIMESTAMP
  WHERE order_id = NEW.id AND state = 'held';
END;
