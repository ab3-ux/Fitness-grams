const orderColumns = `
  id, checkout_reference, checkout_id, status, sumup_status, currency,
  subtotal_cents, total_cents, idempotency_key_hash, request_hash,
  access_token_hash, hosted_checkout_url, checkout_creation_state,
  last_error_code, paid_at, reconciliation_state,
  last_observed_sumup_status, sumup_status_checked_at, created_at, updated_at
`;

const TERMINAL_ORDER_STATUSES = new Set([
  "paid",
  "failed",
  "cancelled",
  "expired",
  "refunded"
]);

const STATUS_MAP = new Map([
  ["PAID", "paid"],
  ["FAILED", "failed"],
  ["DECLINED", "failed"],
  ["CANCELLED", "cancelled"],
  ["CANCELED", "cancelled"],
  ["EXPIRED", "expired"],
  ["PENDING", "pending"]
]);

export function createD1PaymentRepository(db) {
  if (!db || typeof db.prepare !== "function" || typeof db.batch !== "function") {
    throw new TypeError("A Cloudflare D1 binding is required.");
  }

  return {
    async getCatalogVariants(itemIds) {
      if (!itemIds.length) return [];
      const placeholders = itemIds.map(() => "?").join(", ");
      const result = await db.prepare(`
        SELECT
          p.sumup_item_id AS item_id,
          p.name AS product_name,
          p.is_active AS product_active,
          v.sumup_variant_id AS variant_id,
          v.variant_key,
          v.sku,
          v.label AS variant_label,
          v.price_cents,
          v.visible_online,
          v.track_inventory,
          v.quantity
        FROM catalog_products AS p
        JOIN catalog_variants AS v ON v.sumup_item_id = p.sumup_item_id
        WHERE p.sumup_item_id IN (${placeholders})
      `).bind(...itemIds).all();
      return result.results;
    },

    getOrderByIdempotencyHash(hash) {
      return db.prepare(`
        SELECT ${orderColumns}
        FROM orders
        WHERE idempotency_key_hash = ?
      `).bind(hash).first();
    },

    async reserveStock(orderId, items, expiresAt) {
      const trackedItems = items.filter(item => item.trackInventory);
      const statements = [
        db.prepare(`
          UPDATE stock_reservations
          SET state = 'expired', updated_at = CURRENT_TIMESTAMP
          WHERE state = 'held'
            AND julianday(expires_at) <= julianday('now')
            AND NOT EXISTS (
              SELECT 1 FROM orders WHERE orders.id = stock_reservations.order_id
            )
        `)
      ];

      for (const item of trackedItems) {
        statements.push(db.prepare(`
          INSERT INTO stock_reservations (
            order_id, sumup_variant_id, quantity, expires_at, state
          )
          SELECT ?, v.sumup_variant_id, ?, ?, 'held'
          FROM catalog_variants AS v
          JOIN catalog_products AS p ON p.sumup_item_id = v.sumup_item_id
          WHERE v.sumup_variant_id = ?
            AND p.is_active = 1
            AND v.visible_online = 1
            AND v.track_inventory = 1
            AND v.quantity IS NOT NULL
            AND v.quantity - COALESCE((
              SELECT SUM(active.quantity)
              FROM stock_reservations AS active
              WHERE active.sumup_variant_id = v.sumup_variant_id
                AND active.state = 'held'
                AND julianday(active.expires_at) > julianday('now')
            ), 0) >= ?
          ON CONFLICT (order_id, sumup_variant_id) DO NOTHING
        `).bind(orderId, item.quantity, expiresAt, item.variantId, item.quantity));
      }

      if (statements.length === 1) return true;
      const results = await db.batch(statements);
      const reservationsCreated = results.slice(1).every(
        result => result?.meta?.changes === 1
      );
      if (!reservationsCreated) await this.releaseStock(orderId);
      return reservationsCreated;
    },

    async releaseStock(orderId) {
      await db.prepare(`
        UPDATE stock_reservations
        SET state = 'released', updated_at = CURRENT_TIMESTAMP
        WHERE order_id = ? AND state = 'held'
      `).bind(orderId).run();
    },

    async releaseOrphanedExpiredStock() {
      await db.prepare(`
        UPDATE stock_reservations
        SET state = 'expired', updated_at = CURRENT_TIMESTAMP
        WHERE state = 'held'
          AND julianday(expires_at) <= julianday('now')
          AND NOT EXISTS (
            SELECT 1 FROM orders WHERE orders.id = stock_reservations.order_id
          )
      `).run();
    },

    async createOrder(order, items) {
      const statements = [
        db.prepare(`
          INSERT INTO orders (
            id, checkout_reference, status, currency, subtotal_cents, total_cents,
            idempotency_key_hash, request_hash, access_token_hash,
            checkout_creation_state
          ) VALUES (?, ?, 'pending', 'EUR', ?, ?, ?, ?, ?, 'in_progress')
        `).bind(
          order.id,
          order.checkoutReference,
          order.totalCents,
          order.totalCents,
          order.idempotencyKeyHash,
          order.requestHash,
          order.accessTokenHash
        )
      ];

      for (const item of items) {
        statements.push(db.prepare(`
          INSERT INTO order_items (
            order_id, sumup_item_id, sumup_variant_id, sku, product_name,
            variant_label, quantity, unit_price_cents, line_total_cents
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          order.id,
          item.itemId,
          item.variantId,
          item.sku,
          item.productName,
          item.variantLabel,
          item.quantity,
          item.unitPriceCents,
          item.lineTotalCents
        ));
      }

      await db.batch(statements);
      return this.getOrderByIdempotencyHash(order.idempotencyKeyHash);
    },

    getOrderById(id) {
      return db.prepare(`
        SELECT ${orderColumns}
        FROM orders
        WHERE id = ?
      `).bind(id).first();
    },

    getOrderByCheckoutId(checkoutId) {
      return db.prepare(`
        SELECT ${orderColumns}
        FROM orders
        WHERE checkout_id = ?
      `).bind(checkoutId).first();
    },

    hasPendingWebhookNotification(checkoutId) {
      return db.prepare(`
        SELECT 1 AS pending
        FROM pending_sumup_notifications
        WHERE checkout_id = ? AND state = 'pending'
      `).bind(checkoutId).first().then(Boolean);
    },

    async markWebhookForManualReview(checkoutId, errorCode) {
      await db.prepare(`
        UPDATE pending_sumup_notifications
        SET state = 'manual_review',
            last_error = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE checkout_id = ?
      `).bind(errorCode, checkoutId).run();
    },

    getOrderByCheckoutReference(reference) {
      return db.prepare(`
        SELECT ${orderColumns}
        FROM orders
        WHERE checkout_reference = ?
      `).bind(reference).first();
    },

    async attachCheckoutByReference(reference, checkout, expectedOrderId) {
      const result = await db.prepare(`
        UPDATE orders
        SET checkout_id = ?,
            hosted_checkout_url = COALESCE(?, hosted_checkout_url),
            checkout_creation_state = 'created',
            reconciliation_state = 'resolved',
            last_error_code = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE checkout_reference = ?
          AND id = ?
          AND (checkout_id IS NULL OR checkout_id = ?)
          AND status = 'pending'
      `).bind(
        checkout.id,
        checkout.hostedCheckoutUrl ?? null,
        reference,
        expectedOrderId,
        checkout.id
      ).run();
      return result.meta?.changes === 1;
    },

    async updateCheckoutCreation(id, state, checkout, errorCode) {
      await db.prepare(`
        UPDATE orders
        SET checkout_id = COALESCE(?, checkout_id),
            hosted_checkout_url = COALESCE(?, hosted_checkout_url),
            checkout_creation_state = ?,
            last_error_code = ?,
            status = CASE
              WHEN ? = 'failed' AND status = 'pending' THEN 'failed'
              ELSE status
            END,
            reconciliation_state = CASE
              WHEN ? = 'uncertain' AND ? IS NULL THEN 'manual_review'
              WHEN ? = 'uncertain' THEN 'required'
              WHEN ? = 'created' THEN 'resolved'
              ELSE reconciliation_state
            END,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
          AND checkout_creation_state IN ('in_progress', 'uncertain', 'created', 'failed')
      `).bind(
        checkout?.id ?? null,
        checkout?.hostedCheckoutUrl ?? null,
        state,
        errorCode ?? null,
        state,
        state,
        checkout?.id ?? null,
        state,
        state,
        id
      ).run();
    },

    async recordWebhookNotification(checkoutId, eventType) {
      await db.prepare(`
        INSERT INTO pending_sumup_notifications (
          checkout_id, event_type, state, attempts, next_attempt_at,
          last_error, received_at, updated_at
        ) VALUES (?, ?, 'pending', 0, CURRENT_TIMESTAMP, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT (checkout_id) DO UPDATE SET
          event_type = excluded.event_type,
          state = 'pending',
          attempts = 0,
          next_attempt_at = CURRENT_TIMESTAMP,
          last_error = NULL,
          received_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      `).bind(checkoutId, eventType).run();
    },

    listDueWebhookNotifications(limit = 25) {
      return db.prepare(`
        SELECT checkout_id, event_type, attempts
        FROM pending_sumup_notifications
        WHERE state = 'pending'
          AND julianday(next_attempt_at) <= julianday('now')
        ORDER BY next_attempt_at, received_at
        LIMIT ?
      `).bind(limit).all().then(result => result.results);
    },

    async markWebhookProcessed(checkoutId) {
      await db.prepare(`
        UPDATE pending_sumup_notifications
        SET state = 'processed', last_error = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE checkout_id = ?
      `).bind(checkoutId).run();
    },

    async deferWebhook(checkoutId, errorCode) {
      await db.prepare(`
        UPDATE pending_sumup_notifications
        SET attempts = attempts + 1,
            state = CASE WHEN attempts >= 9 THEN 'manual_review' ELSE 'pending' END,
            next_attempt_at = datetime(
              'now',
              '+' || MIN(3600, 30 * (1 << MIN(attempts, 6))) || ' seconds'
            ),
            last_error = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE checkout_id = ? AND state = 'pending'
      `).bind(errorCode, checkoutId).run();
    },

    listOrdersNeedingReconciliation(limit = 25) {
      return db.prepare(`
        SELECT ${orderColumns}
        FROM orders
        WHERE checkout_id IS NOT NULL
          AND reconciliation_state = 'required'
        ORDER BY updated_at
        LIMIT ?
      `).bind(limit).all().then(result => result.results);
    },

    listOrdersForStatusRefresh(limit = 25) {
      return db.prepare(`
        SELECT ${orderColumns}
        FROM orders
        WHERE checkout_id IS NOT NULL
          AND status = 'pending'
          AND (
            sumup_status_checked_at IS NULL
            OR julianday(sumup_status_checked_at) <= julianday('now', '-5 minutes')
          )
        ORDER BY COALESCE(sumup_status_checked_at, created_at)
        LIMIT ?
      `).bind(limit).all().then(result => result.results);
    },

    listUncertainOrdersWithoutCheckout(limit = 25) {
      return db.prepare(`
        SELECT ${orderColumns}
        FROM orders
        WHERE checkout_creation_state = 'uncertain'
          AND checkout_id IS NULL
          AND reconciliation_state <> 'manual_review'
        ORDER BY updated_at
        LIMIT ?
      `).bind(limit).all().then(result => result.results);
    },

    async markOrderForManualReview(id, errorCode) {
      await db.prepare(`
        UPDATE orders
        SET reconciliation_state = 'manual_review',
            last_error_code = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status <> 'paid'
      `).bind(errorCode, id).run();
    },

    async applyVerifiedCheckout(order, checkout, eventFingerprint) {
      const rawStatus = typeof checkout.status === "string"
        ? checkout.status.trim().toUpperCase()
        : "";
      const nextStatus = STATUS_MAP.get(rawStatus);
      const statements = [
        db.prepare(`
          INSERT OR IGNORE INTO sumup_webhook_events (
            event_fingerprint, checkout_id, event_type, verified_status
          ) VALUES (?, ?, 'CHECKOUT_STATUS_CHANGED', ?)
        `).bind(eventFingerprint, checkout.id, rawStatus || "UNKNOWN")
      ];

      if (!nextStatus) {
        statements.push(db.prepare(`
          UPDATE orders
          SET sumup_status = ?,
              last_observed_sumup_status = ?,
              reconciliation_state = CASE
                WHEN status IN ('paid', 'failed', 'cancelled', 'expired', 'refunded')
                  THEN 'manual_review'
                ELSE 'required'
              END,
              sumup_status_checked_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(rawStatus || "UNKNOWN", rawStatus || "UNKNOWN", order.id));
        const results = await db.batch(statements);
        return { duplicate: results[0]?.meta?.changes === 0, status: order.status, reconciled: false };
      }

      statements.push(db.prepare(`
        UPDATE orders
        SET status = CASE WHEN status = 'pending' THEN ? ELSE status END,
            sumup_status = CASE
              WHEN status = 'pending' OR status = ? THEN ?
              ELSE sumup_status
            END,
            paid_at = CASE
              WHEN status = 'pending' AND ? = 'paid' THEN COALESCE(paid_at, CURRENT_TIMESTAMP)
              ELSE paid_at
            END,
            reconciliation_state = CASE
              WHEN status = 'pending' OR status = ? THEN 'resolved'
              ELSE 'manual_review'
            END,
            last_observed_sumup_status = CASE
              WHEN status = 'pending' OR status = ? THEN NULL
              ELSE ?
            END,
            sumup_status_checked_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(
        nextStatus,
        nextStatus,
        rawStatus,
        nextStatus,
        nextStatus,
        nextStatus,
        rawStatus,
        order.id
      ));

      const results = await db.batch(statements);
      const updatedOrder = await this.getOrderById(order.id);
      return {
        duplicate: results[0]?.meta?.changes === 0,
        status: updatedOrder?.status ?? order.status,
        reconciled: updatedOrder?.reconciliation_state === "resolved"
      };
    },

    async consumeRateLimit(bucketKey, limit, windowSeconds, now = Date.now()) {
      const windowStartedAt = Math.floor(now / (windowSeconds * 1000)) * windowSeconds;
      const result = await db.prepare(`
        INSERT INTO payment_rate_limits (bucket_key, window_started_at, request_count)
        VALUES (?, ?, 1)
        ON CONFLICT (bucket_key) DO UPDATE SET
          request_count = CASE
            WHEN payment_rate_limits.window_started_at = excluded.window_started_at
              THEN payment_rate_limits.request_count + 1
            ELSE 1
          END,
          window_started_at = excluded.window_started_at,
          updated_at = CURRENT_TIMESTAMP
        RETURNING request_count
      `).bind(bucketKey, windowStartedAt).first();
      return Number(result?.request_count) <= limit;
    },

    async cleanupRateLimits(olderThanEpoch) {
      await db.prepare(`
        DELETE FROM payment_rate_limits
        WHERE window_started_at < ?
      `).bind(olderThanEpoch).run();
    }
  };
}

export function sumupStatusTransition(currentStatus, rawStatus) {
  const normalized = typeof rawStatus === "string" ? rawStatus.trim().toUpperCase() : "";
  const nextStatus = STATUS_MAP.get(normalized);
  if (!nextStatus) return { kind: "unknown", normalized: normalized || "UNKNOWN" };

  if (currentStatus === "pending" || currentStatus === nextStatus) {
    return { kind: "apply", status: nextStatus, normalized };
  }
  if (TERMINAL_ORDER_STATUSES.has(currentStatus)) {
    return { kind: "manual_review", status: currentStatus, normalized };
  }
  return { kind: "manual_review", status: currentStatus, normalized };
}
