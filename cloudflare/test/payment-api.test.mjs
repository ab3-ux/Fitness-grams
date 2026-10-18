import test from "node:test";
import assert from "node:assert/strict";
import { createPaymentApi } from "../src/payment-api.mjs";

const ACCESS_KEY = "x".repeat(43);
const ITEM_ID = "00000000-0000-4000-8000-000000000001";
const VARIANT_ID = "00000000-0000-4000-8000-000000000002";
const ORDER_ID = "00000000-0000-4000-8000-000000000003";
const CHECKOUT_ID = "00000000-0000-4000-8000-000000000004";
const ORIGIN = "https://ab3-ux.github.io";

function fixture({ priceCents = 1234, quantity = 10 } = {}) {
  const catalog = [{
    item_id: ITEM_ID,
    product_name: "Produit test",
    product_active: 1,
    variant_id: VARIANT_ID,
    variant_key: VARIANT_ID,
    sku: "FG-001",
    variant_label: "Test",
    price_cents: priceCents,
    visible_online: 1,
    track_inventory: 1,
    quantity
  }];
  const state = {
    catalog,
    orders: new Map(),
    idempotency: new Map(),
    events: new Set(),
    notifications: new Map(),
    reservations: new Map(),
    rateLimits: new Map()
  };

  const repository = {
    async getCatalogVariants(itemIds) {
      return state.catalog.filter(row => itemIds.includes(row.item_id));
    },
    async getOrderByIdempotencyHash(hash) {
      const id = state.idempotency.get(hash);
      return id ? state.orders.get(id) : null;
    },
    async reserveStock(orderId, items, expiresAt) {
      const held = [...state.reservations.values()]
        .filter(reservation => reservation.state === "held");
      for (const item of items.filter(row => row.trackInventory)) {
        const available = state.catalog.find(row => row.variant_id === item.variantId);
        const reserved = held
          .filter(reservation => reservation.variantId === item.variantId)
          .reduce((sum, reservation) => sum + reservation.quantity, 0);
        if (!available || available.quantity - reserved < item.quantity) return false;
      }
      for (const item of items.filter(row => row.trackInventory)) {
        state.reservations.set(`${orderId}:${item.variantId}`, {
          orderId,
          variantId: item.variantId,
          quantity: item.quantity,
          expiresAt,
          state: "held"
        });
      }
      return true;
    },
    async releaseStock(orderId) {
      for (const reservation of state.reservations.values()) {
        if (reservation.orderId === orderId && reservation.state === "held") {
          reservation.state = "released";
        }
      }
    },
    async createOrder(order, items) {
      if (state.idempotency.has(order.idempotencyKeyHash)) {
        throw new Error("unique idempotency key");
      }
      const stored = {
        id: order.id,
        checkout_reference: order.checkoutReference,
        checkout_id: null,
        status: "pending",
        sumup_status: null,
        currency: "EUR",
        subtotal_cents: order.totalCents,
        total_cents: order.totalCents,
        idempotency_key_hash: order.idempotencyKeyHash,
        request_hash: order.requestHash,
        access_token_hash: order.accessTokenHash,
        hosted_checkout_url: null,
        checkout_creation_state: "in_progress",
        last_error_code: null,
        paid_at: null,
        reconciliation_state: "none",
        last_observed_sumup_status: null,
        sumup_status_checked_at: null,
        items
      };
      state.orders.set(stored.id, stored);
      state.idempotency.set(order.idempotencyKeyHash, stored.id);
      return stored;
    },
    async getOrderById(id) {
      return state.orders.get(id) ?? null;
    },
    async getOrderByCheckoutId(id) {
      return [...state.orders.values()].find(order => order.checkout_id === id) ?? null;
    },
    async getOrderByCheckoutReference(reference) {
      return [...state.orders.values()].find(order => order.checkout_reference === reference) ?? null;
    },
    async attachCheckoutByReference(reference, checkout, expectedOrderId) {
      const order = await this.getOrderByCheckoutReference(reference);
      if (!order || order.id !== expectedOrderId || (order.checkout_id && order.checkout_id !== checkout.id)) {
        return false;
      }
      order.checkout_id = checkout.id;
      order.hosted_checkout_url = checkout.hostedCheckoutUrl;
      order.checkout_creation_state = "created";
      return true;
    },
    async hasPendingWebhookNotification(id) {
      return state.notifications.get(id)?.state === "pending";
    },
    async recordWebhookNotification(id, eventType) {
      state.notifications.set(id, { checkout_id: id, event_type: eventType, attempts: 0, state: "pending" });
    },
    async markWebhookProcessed(id) {
      const notification = state.notifications.get(id);
      if (notification) notification.state = "processed";
    },
    async deferWebhook(id, reason) {
      const notification = state.notifications.get(id);
      if (!notification) return;
      notification.attempts += 1;
      notification.last_error = reason;
      if (notification.attempts >= 10) notification.state = "manual_review";
    },
    async markWebhookForManualReview(id, reason) {
      const notification = state.notifications.get(id);
      if (notification) {
        notification.state = "manual_review";
        notification.last_error = reason;
      }
    },
    async consumeRateLimit(key, limit) {
      const count = (state.rateLimits.get(key) ?? 0) + 1;
      state.rateLimits.set(key, count);
      return count <= limit;
    },
    async listDueWebhookNotifications() {
      return [...state.notifications.values()].filter(item => item.state === "pending");
    },
    async listOrdersNeedingReconciliation() {
      return [...state.orders.values()].filter(order => order.reconciliation_state === "required");
    },
    async listOrdersForStatusRefresh() {
      return [...state.orders.values()].filter(order => (
        order.checkout_id && order.status === "pending"
      ));
    },
    async listUncertainOrdersWithoutCheckout() {
      return [...state.orders.values()].filter(order => (
        order.checkout_creation_state === "uncertain" && !order.checkout_id
      ));
    },
    async markOrderForManualReview(id, errorCode) {
      const order = state.orders.get(id);
      order.reconciliation_state = "manual_review";
      order.last_error_code = errorCode;
    },
    async releaseOrphanedExpiredStock() {},
    async cleanupRateLimits() {},
    async updateCheckoutCreation(id, creationState, checkout, errorCode) {
      const order = state.orders.get(id);
      if (checkout?.id) order.checkout_id = checkout.id;
      if (checkout?.hostedCheckoutUrl) order.hosted_checkout_url = checkout.hostedCheckoutUrl;
      order.checkout_creation_state = creationState;
      order.last_error_code = errorCode;
      if (creationState === "failed" && order.status !== "paid") order.status = "failed";
      if (creationState === "failed") await this.releaseStock(id);
      if (creationState === "uncertain") {
        order.reconciliation_state = checkout?.id ? "required" : "manual_review";
      }
      if (creationState === "created" && order.status === "pending") {
        order.reconciliation_state = "resolved";
      }
    },
    async applyVerifiedCheckout(order, checkout, fingerprint) {
      const duplicate = state.events.has(fingerprint);
      state.events.add(fingerprint);
      const transitions = {
        PENDING: "pending",
        PAID: "paid",
        FAILED: "failed",
        DECLINED: "failed",
        CANCELLED: "cancelled",
        CANCELED: "cancelled",
        EXPIRED: "expired"
      };
      const next = transitions[checkout.status];
      if (!next) {
        order.reconciliation_state = ["paid", "failed", "cancelled", "expired", "refunded"].includes(order.status)
          ? "manual_review"
          : "required";
        order.sumup_status = checkout.status;
        order.last_observed_sumup_status = checkout.status;
      } else if (order.status === "pending" || order.status === next) {
        if (order.status === "pending") {
          if (next === "paid") {
            const reservation = state.reservations.get(`${order.id}:${VARIANT_ID}`);
            if (reservation?.state === "held") {
              const variant = state.catalog.find(row => row.variant_id === VARIANT_ID);
              variant.quantity -= reservation.quantity;
              reservation.state = "committed";
            }
          }
          if (["failed", "cancelled", "expired"].includes(next)) {
            for (const reservation of state.reservations.values()) {
              if (reservation.orderId === order.id && reservation.state === "held") {
                reservation.state = "released";
              }
            }
          }
          order.status = next;
        }
        order.sumup_status = checkout.status;
        order.reconciliation_state = "resolved";
        order.last_observed_sumup_status = null;
        order.sumup_status_checked_at = new Date().toISOString();
      } else {
        order.reconciliation_state = "manual_review";
        order.last_observed_sumup_status = checkout.status;
      }
      return { duplicate, status: order.status, reconciled: order.reconciliation_state === "resolved" };
    }
  };

  const calls = [];
  let checkoutResponse = {
    id: CHECKOUT_ID,
    checkout_reference: ORDER_ID,
    amount: 12.34,
    currency: "EUR",
    merchant_code: "MC123",
    status: "PENDING",
    hosted_checkout_url: "https://checkout.sumup.com/pay/test"
  };
  let createResponseStatus = 201;
  let statusResponse = null;
  let fetchFailure = null;
  let onCreate;
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (fetchFailure) throw fetchFailure;
    if (init.method === "POST") {
      if (onCreate) await onCreate();
      return new Response(
        createResponseStatus >= 400 ? '{"error":"declined"}' : JSON.stringify(checkoutResponse),
        { status: createResponseStatus }
      );
    }
    return new Response(JSON.stringify(statusResponse), { status: 200 });
  };

  const api = createPaymentApi({
    createRepository: () => repository,
    fetchImpl,
    createId: () => ORDER_ID
  });
  const env = {
    ALLOWED_ORIGINS: `${ORIGIN},https://www.fitness-grams.com`,
    SUMUP_API_KEY: "test-only-not-a-real-key",
    SUMUP_MERCHANT_CODE: "MC123",
    ORDER_ACCESS_SECRET: "s".repeat(48),
    SUMUP_HOSTED_CHECKOUT_ENABLED: "true",
    SUMUP_RETURN_URL: "https://api.example.test/api/sumup/notification",
    SUMUP_REDIRECT_URL: "https://shop.example.test/return"
  };

  return {
    api,
    env,
    state,
    repository,
    calls,
    setCheckoutResponse(value) {
      checkoutResponse = value;
    },
    setCreateResponseStatus(value) {
      createResponseStatus = value;
    },
    setStatusResponse(value) {
      statusResponse = value;
    },
    setFetchFailure(value) {
      fetchFailure = value;
    },
    setOnCreate(value) {
      onCreate = value;
    }
  };
}

function checkoutRequest({
  items = [{ id: `sumup-${ITEM_ID}`, variant: VARIANT_ID, qty: 1, price: 0.01 }],
  key = ACCESS_KEY,
  extras = {}
} = {}) {
  return new Request("https://api.example.test/api/checkout", {
    method: "POST",
    headers: {
      Origin: ORIGIN,
      "Content-Type": "application/json",
      "Idempotency-Key": key,
      "CF-Connecting-IP": "192.0.2.10"
    },
    body: JSON.stringify({ items, ...extras })
  });
}

function sumupWebhookRequest(checkoutId = CHECKOUT_ID) {
  return new Request("https://api.example.test/api/sumup/notification", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event_type: "CHECKOUT_STATUS_CHANGED", id: checkoutId })
  });
}

function sumupCheckout(overrides = {}) {
  return {
    id: CHECKOUT_ID,
    checkout_reference: ORDER_ID,
    amount: 12.34,
    currency: "EUR",
    merchant_code: "MC123",
    status: "PENDING",
    ...overrides
  };
}

test("rejects an empty cart without calling SumUp", async () => {
  const f = fixture();
  const response = await f.api(checkoutRequest({ items: [] }), f.env);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "empty_cart");
  assert.equal(f.calls.length, 0);
});

test("rejects an unknown product and an invalid variant", async t => {
  await t.test("unknown product", async () => {
    const f = fixture();
    const response = await f.api(checkoutRequest({
      items: [{ id: "sumup-not-in-d1", variant: VARIANT_ID, qty: 1 }]
    }), f.env);
    assert.equal(response.status, 422);
    assert.equal((await response.json()).error, "product_unavailable");
  });
  await t.test("invalid variant", async () => {
    const f = fixture();
    const response = await f.api(checkoutRequest({
      items: [{ id: `sumup-${ITEM_ID}`, variant: "wrong-variant", qty: 1 }]
    }), f.env);
    assert.equal(response.status, 422);
    assert.equal((await response.json()).error, "variant_unavailable");
  });
});

test("rejects an excessive quantity and unavailable stock", async t => {
  await t.test("over the per-line maximum", async () => {
    const f = fixture();
    const response = await f.api(checkoutRequest({
      items: [{ id: ITEM_ID, variant: VARIANT_ID, qty: 100 }]
    }), f.env);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "invalid_quantity");
  });
  await t.test("over available stock", async () => {
    const f = fixture({ quantity: 1 });
    const response = await f.api(checkoutRequest({
      items: [{ id: ITEM_ID, variant: VARIANT_ID, qty: 2 }]
    }), f.env);
    assert.equal(response.status, 422);
    assert.equal((await response.json()).error, "insufficient_stock");
  });
});

test("recalculates amount from D1 and ignores forged browser prices and totals", async () => {
  const f = fixture({ priceCents: 1234 });
  f.setCheckoutResponse({
    id: CHECKOUT_ID,
    checkout_reference: ORDER_ID,
    amount: 24.68,
    currency: "EUR",
    merchant_code: "MC123",
    status: "PENDING",
    hosted_checkout_url: "https://checkout.sumup.com/pay/test"
  });
  const response = await f.api(checkoutRequest({
    items: [{ id: `sumup-${ITEM_ID}`, variant: VARIANT_ID, qty: 2, price: 0.01 }],
    extras: { total: 0.02, amount: 0.02 }
  }), f.env);
  assert.equal(response.status, 201);
  assert.equal(f.state.orders.get(ORDER_ID).total_cents, 2468);
  const createCall = f.calls.find(call => call.init.method === "POST");
  const payload = JSON.parse(createCall.init.body);
  assert.equal(payload.amount, 24.68);
  assert.equal(payload.currency, "EUR");
  assert.equal(payload.checkout_reference, ORDER_ID);
  assert.equal(payload.hosted_checkout.enabled, true);
  assert.match(createCall.init.headers.Authorization, /^Bearer /);
  const body = await response.json();
  assert.equal(body.total, 24.68);
  assert.equal(body.checkoutUrl, "https://checkout.sumup.com/pay/test");
});

test("SumUp create failures are not blindly retried with the same idempotency key", async t => {
  await t.test("definitive API rejection", async () => {
    const f = fixture();
    f.setCreateResponseStatus(400);
    const first = await f.api(checkoutRequest(), f.env);
    assert.equal(first.status, 502);
    assert.equal((await first.json()).error, "checkout_creation_failed");
    const second = await f.api(checkoutRequest(), f.env);
    assert.equal(second.status, 409);
    assert.equal(f.calls.filter(call => call.init.method === "POST").length, 1);
  });
  await t.test("ambiguous network failure", async () => {
    const f = fixture();
    f.setFetchFailure(new Error("simulated network timeout"));
    const response = await f.api(checkoutRequest(), f.env);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, "checkout_creation_uncertain");
    const retry = await f.api(checkoutRequest(), f.env);
    assert.equal(retry.status, 202);
    assert.equal(f.calls.filter(call => call.init.method === "POST").length, 1);
  });
});

test("does not create an untrackable checkout without a configured HTTPS notification URL", async () => {
  const f = fixture();
  delete f.env.SUMUP_RETURN_URL;
  const response = await f.api(checkoutRequest(), f.env);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "payment_service_not_configured");
  assert.equal(f.calls.length, 0);
});

test("does not return a non-SumUp URL as a hosted checkout", async () => {
  const f = fixture();
  f.setCheckoutResponse({
    id: CHECKOUT_ID,
    checkout_reference: ORDER_ID,
    amount: 12.34,
    currency: "EUR",
    merchant_code: "MC123",
    status: "PENDING",
    hosted_checkout_url: "https://attacker.example/pay"
  });
  const response = await f.api(checkoutRequest(), f.env);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "checkout_creation_uncertain");
  assert.equal(f.state.orders.get(ORDER_ID).checkout_creation_state, "uncertain");
});

test("reuses an identical idempotent checkout and rejects a changed cart", async () => {
  const f = fixture();
  const first = await f.api(checkoutRequest(), f.env);
  const second = await f.api(checkoutRequest(), f.env);
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(f.calls.filter(call => call.init.method === "POST").length, 1);

  const changed = await f.api(checkoutRequest({
    items: [{ id: ITEM_ID, variant: VARIANT_ID, qty: 2 }]
  }), f.env);
  assert.equal(changed.status, 409);
  assert.equal((await changed.json()).error, "idempotency_key_reused");
});

test("order tracking requires the returned bearer token", async () => {
  const f = fixture();
  const checkoutResponse = await f.api(checkoutRequest(), f.env);
  const { trackingToken } = await checkoutResponse.json();

  const withoutToken = await f.api(new Request(
    `https://api.example.test/api/orders/${ORDER_ID}`,
    { headers: { Origin: ORIGIN } }
  ), f.env);
  assert.equal(withoutToken.status, 404);

  const withToken = await f.api(new Request(
    `https://api.example.test/api/orders/${ORDER_ID}`,
    { headers: { Origin: ORIGIN, Authorization: `Bearer ${trackingToken}` } }
  ), f.env);
  assert.equal(withToken.status, 200);
  assert.deepEqual(Object.keys(await withToken.json()).sort(), [
    "checkoutReady", "checkoutUrl", "currency", "id", "status", "total"
  ]);
});

test("webhook status is obtained from SumUp and pending or declined states are not paid", async t => {
  await t.test("pending", async () => {
    const f = fixture();
    await f.api(checkoutRequest(), f.env);
    f.setStatusResponse(sumupCheckout({ status: "PENDING" }));
    const response = await f.api(sumupWebhookRequest(), f.env);
    assert.equal(response.status, 204);
    assert.equal(f.state.orders.get(ORDER_ID).status, "pending");
    const getCall = f.calls.find(call => call.init.method === "GET");
    assert.match(getCall.init.headers.Authorization, /^Bearer /);
  });
  await t.test("declined", async () => {
    const f = fixture();
    await f.api(checkoutRequest(), f.env);
    f.setStatusResponse(sumupCheckout({ status: "FAILED" }));
    const response = await f.api(sumupWebhookRequest(), f.env);
    assert.equal(response.status, 204);
    assert.equal(f.state.orders.get(ORDER_ID).status, "failed");
  });
  await t.test("SumUp lookup failure requests webhook retry", async () => {
    const f = fixture();
    await f.api(checkoutRequest(), f.env);
    f.setFetchFailure(new Error("simulated status lookup timeout"));
    const response = await f.api(sumupWebhookRequest(), f.env);
    assert.equal(response.status, 503);
  });
  await t.test("cancelled", async () => {
    const f = fixture();
    await f.api(checkoutRequest(), f.env);
    f.setStatusResponse(sumupCheckout({ status: "CANCELLED" }));
    await f.api(sumupWebhookRequest(), f.env);
    assert.equal(f.state.orders.get(ORDER_ID).status, "cancelled");
  });
});

test("confirms only a canonical SumUp checkout matching id, reference, amount, and currency", async t => {
  for (const [name, override] of [
    ["wrong id", { id: "another-checkout" }],
    ["wrong reference", { checkout_reference: "another-order" }],
    ["wrong amount", { amount: 12.33 }],
    ["wrong currency", { currency: "GBP" }],
    ["wrong merchant", { merchant_code: "MC999" }]
  ]) {
    await t.test(name, async () => {
      const f = fixture();
      await f.api(checkoutRequest(), f.env);
      f.setStatusResponse(sumupCheckout({ ...override, status: "PAID" }));
      await f.api(sumupWebhookRequest(), f.env);
      assert.equal(f.state.orders.get(ORDER_ID).status, "pending");
    });
  }

  const f = fixture();
  await f.api(checkoutRequest(), f.env);
  f.setStatusResponse(sumupCheckout({ status: "PAID" }));
  const response = await f.api(sumupWebhookRequest(), f.env);
  assert.equal(response.status, 204);
  assert.equal(f.state.orders.get(ORDER_ID).status, "paid");
});

test("repeated notifications are idempotent and a paid order cannot be downgraded", async () => {
  const f = fixture();
  await f.api(checkoutRequest(), f.env);
  f.setStatusResponse(sumupCheckout({ status: "PAID" }));
  await f.api(sumupWebhookRequest(), f.env);
  const eventCount = f.state.events.size;
  await f.api(sumupWebhookRequest(), f.env);
  assert.equal(f.state.events.size, eventCount);

  f.setStatusResponse(sumupCheckout({ status: "FAILED" }));
  await f.api(sumupWebhookRequest(), f.env);
  assert.equal(f.state.orders.get(ORDER_ID).status, "paid");
});

test("an early notification is durably reconciled by checkout reference", async () => {
  const f = fixture();
  f.setStatusResponse(sumupCheckout({ status: "PAID" }));
  let notificationResponse;
  f.setOnCreate(async () => {
    notificationResponse = await f.api(sumupWebhookRequest(), f.env);
  });

  const response = await f.api(checkoutRequest(), f.env);
  assert.equal(response.status, 201);
  assert.equal(notificationResponse.status, 204);
  assert.equal(f.state.orders.get(ORDER_ID).checkout_id, CHECKOUT_ID);
  assert.equal(f.state.orders.get(ORDER_ID).status, "paid");
  assert.equal(f.state.reservations.get(`${ORDER_ID}:${VARIANT_ID}`).state, "committed");
  assert.equal(f.state.catalog[0].quantity, 9);
  assert.equal(f.state.notifications.get(CHECKOUT_ID).state, "processed");
});

test("SumUp terminal statuses release stock and cannot be changed by later callbacks", async t => {
  for (const [sumupStatus, expectedStatus] of [
    ["FAILED", "failed"],
    ["CANCELLED", "cancelled"],
    ["EXPIRED", "expired"]
  ]) {
    await t.test(sumupStatus, async () => {
      const f = fixture();
      await f.api(checkoutRequest(), f.env);
      f.setStatusResponse(sumupCheckout({ status: sumupStatus }));
      const response = await f.api(sumupWebhookRequest(), f.env);
      assert.equal(response.status, 204);
      assert.equal(f.state.orders.get(ORDER_ID).status, expectedStatus);
      assert.equal(f.state.reservations.get(`${ORDER_ID}:${VARIANT_ID}`).state, "released");

      f.setStatusResponse(sumupCheckout({ status: "PAID" }));
      await f.api(sumupWebhookRequest(), f.env);
      assert.equal(f.state.orders.get(ORDER_ID).status, expectedStatus);
      assert.equal(f.state.orders.get(ORDER_ID).reconciliation_state, "manual_review");
    });
  }
});

test("unknown SumUp statuses are not accepted as terminal payment states", async () => {
  const f = fixture();
  await f.api(checkoutRequest(), f.env);
  f.setStatusResponse(sumupCheckout({ status: "NEW_SUMUP_STATE" }));

  const response = await f.api(sumupWebhookRequest(), f.env);
  assert.equal(response.status, 204);
  assert.equal(f.state.orders.get(ORDER_ID).status, "pending");
  assert.equal(f.state.orders.get(ORDER_ID).reconciliation_state, "required");
  assert.equal(f.state.orders.get(ORDER_ID).last_observed_sumup_status, "NEW_SUMUP_STATE");
});

test("D1-style stock reservations serialize competing orders", async () => {
  const f = fixture({ quantity: 1 });
  const item = {
    variantId: VARIANT_ID,
    quantity: 1,
    trackInventory: true
  };
  const results = await Promise.all([
    f.repository.reserveStock("order-a", [item], new Date(Date.now() + 60_000).toISOString()),
    f.repository.reserveStock("order-b", [item], new Date(Date.now() + 60_000).toISOString())
  ]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal([...f.state.reservations.values()].filter(row => row.state === "held").length, 1);
});

test("checkout rate limit rejects excess requests", async () => {
  const f = fixture();
  let response;
  for (let attempt = 0; attempt < 13; attempt += 1) {
    response = await f.api(checkoutRequest({ items: [] }), f.env);
  }
  assert.equal(response.status, 429);
  assert.equal(f.calls.length, 0);
});

test("SumUp API rate limit blocks the outbound request and releases its reservation", async () => {
  const f = fixture();
  f.state.rateLimits.set("sumup:global", 120);
  const response = await f.api(checkoutRequest(), f.env);
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error, "sumup_rate_limit_exceeded");
  assert.equal(f.calls.length, 0);
  assert.equal(f.state.orders.get(ORDER_ID).status, "failed");
  assert.equal(f.state.reservations.get(`${ORDER_ID}:${VARIANT_ID}`).state, "released");
});

test("CORS allows configured origins only and preflight advertises required headers", async t => {
  await t.test("allowed origin", async () => {
    const f = fixture();
    const response = await f.api(new Request("https://api.example.test/api/unknown", {
      headers: { Origin: ORIGIN }
    }), f.env);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  });
  await t.test("blocked origin", async () => {
    const f = fixture();
    const response = await f.api(new Request("https://api.example.test/api/checkout", {
      method: "OPTIONS",
      headers: { Origin: "https://attacker.example" }
    }), f.env);
    assert.equal(response.status, 403);
    assert.equal(response.headers.has("Access-Control-Allow-Origin"), false);
  });
  await t.test("allowed preflight", async () => {
    const f = fixture();
    const response = await f.api(new Request("https://api.example.test/api/checkout", {
      method: "OPTIONS",
      headers: { Origin: ORIGIN }
    }), f.env);
    assert.equal(response.status, 204);
    assert.match(response.headers.get("Access-Control-Allow-Headers"), /Idempotency-Key/);
    assert.match(response.headers.get("Access-Control-Allow-Headers"), /Authorization/);
  });
});
