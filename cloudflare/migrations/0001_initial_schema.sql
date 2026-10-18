CREATE TABLE IF NOT EXISTS catalog_products (
  sumup_item_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  image_url TEXT,
  is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
  synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS catalog_variants (
  variant_key TEXT PRIMARY KEY,
  sumup_item_id TEXT NOT NULL,
  sumup_variant_id TEXT UNIQUE,
  sku TEXT,
  label TEXT NOT NULL DEFAULT '',
  options_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(options_json) AND json_type(options_json) = 'array'),
  price_cents INTEGER CHECK (price_cents IS NULL OR price_cents >= 0),
  visible_online INTEGER NOT NULL DEFAULT 0 CHECK (visible_online IN (0, 1)),
  track_inventory INTEGER NOT NULL DEFAULT 0 CHECK (track_inventory IN (0, 1)),
  quantity INTEGER CHECK (quantity IS NULL OR quantity >= 0),
  synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (sumup_item_id)
    REFERENCES catalog_products (sumup_item_id)
    ON UPDATE CASCADE
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_catalog_products_active
  ON catalog_products (is_active);
CREATE INDEX IF NOT EXISTS idx_catalog_variants_item
  ON catalog_variants (sumup_item_id);
CREATE INDEX IF NOT EXISTS idx_catalog_variants_online
  ON catalog_variants (visible_online);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  checkout_reference TEXT NOT NULL UNIQUE,
  checkout_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'paid', 'failed', 'cancelled', 'expired', 'refunded')),
  sumup_status TEXT,
  currency TEXT NOT NULL DEFAULT 'EUR' CHECK (currency = 'EUR'),
  subtotal_cents INTEGER NOT NULL CHECK (subtotal_cents >= 0),
  total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_orders_status_created
  ON orders (status, created_at);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL,
  sumup_item_id TEXT NOT NULL,
  sumup_variant_id TEXT,
  sku TEXT,
  product_name TEXT NOT NULL,
  variant_label TEXT NOT NULL DEFAULT '',
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
  line_total_cents INTEGER NOT NULL CHECK (line_total_cents >= 0),
  FOREIGN KEY (order_id)
    REFERENCES orders (id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_order_items_order
  ON order_items (order_id);
