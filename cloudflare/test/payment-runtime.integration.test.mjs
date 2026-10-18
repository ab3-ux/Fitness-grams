import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { createD1PaymentRepository } from "../src/payment-adapters.mjs";
import { createPaymentApi } from "../src/payment-api.mjs";
import { runPaymentReconciliation } from "../src/payment-reconciliation.mjs";
import { createPaymentStagingWorker } from "../src/payment-staging-worker.mjs";

const ITEM_ID = "00000000-0000-4000-8000-000000000001";
const VARIANT_ID = "00000000-0000-4000-8000-000000000002";
const ORDER_ID = "00000000-0000-4000-8000-000000000003";
const CHECKOUT_ID = "00000000-0000-4000-8000-000000000004";
const EARLY_CHECKOUT_ID = "00000000-0000-4000-8000-000000000005";
const ORIGIN = "https://ab3-ux.github.io";
const API_KEY_FIXTURE = "not-a-real-sumup-key";

const repository = createD1PaymentRepository(env.DB);

function orderDetails(id = ORDER_ID) {
  return {
    id,
    checkoutReference: id,
    totalCents: 1250,
    idempotencyKeyHash: `${id}-idempotency`,
    requestHash: `${id}-request`,
    accessTokenHash: `${id}-access`
  };
}

function itemDetails(quantity = 1) {
  return {
    itemId: ITEM_ID,
    variantId: VARIANT_ID,
    sku: "FG-001",
    productName: "Runtime test item",
    variantLabel: "Small",
    quantity,
    unitPriceCents: 1250,
    lineTotalCents: quantity * 1250,
    trackInventory: true
  };
}

function sumupCheckout(overrides = {}) {
  return {
    id: CHECKOUT_ID,
    checkout_reference: ORDER_ID,
    amount: 12.5,
    currency: "EUR",
    merchant_code: "MC_TEST_FIXTURE",
    status: "PENDING",
    hosted_checkout_url: "https://checkout.sumup.com/test-fixture",
    ...overrides
  };
}

function createEnvironment() {
  return {
    ALLOWED_ORIGINS: ORIGIN,
    SUMUP_API_KEY: API_KEY_FIXTURE,
    SUMUP_MERCHANT_CODE: "MC_TEST_FIXTURE",
    ORDER_ACCESS_SECRET: "test-only-order-access-secret-not-a-credential",
    SUMUP_HOSTED_CHECKOUT_ENABLED: "true",
    SUMUP_RETURN_URL: "https://api.example.test/api/sumup/notification",
    SUMUP_REDIRECT_URL: "https://shop.example.test/payment-return"
  };
}

function makeFakeSumupFetch({
  checkout = sumupCheckout(),
  transportError = null,
  onCreate = null
} = {}) {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.origin !== "https://api.sumup.com") {
      throw new Error(`Blocked unexpected test transport target: ${url.origin}`);
    }
    calls.push({ url: url.href, method: init.method || "GET" });
    if (transportError) throw transportError;
    if (init.method === "POST") {
      if (onCreate) await onCreate();
      return Response.json(checkout, { status: 201 });
    }
    return Response.json(checkout);
  };
  return { calls, fetchImpl };
}

function createApi(fetchImpl) {
  return createPaymentApi({
    createRepository: () => repository,
    fetchImpl,
    createId: () => ORDER_ID
  });
}

function checkoutRequest() {
  return new Request("https://payment-test.example/api/checkout", {
    method: "POST",
    headers: {
      Origin: ORIGIN,
      "Content-Type": "application/json",
      "Idempotency-Key": "runtime-test-idempotency-key-00001",
      "CF-Connecting-IP": "192.0.2.20"
    },
    body: JSON.stringify({
      items: [{ id: ITEM_ID, variant: VARIANT_ID, qty: 1, price: 0.01 }],
      total: 0.01
    })
  });
}

function notificationRequest(checkoutId = CHECKOUT_ID) {
  return new Request("https://payment-test.example/api/sumup/notification", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      event_type: "CHECKOUT_STATUS_CHANGED",
      id: checkoutId
    })
  });
}

async function clearDatabase() {
  for (const table of [
    "pending_sumup_notifications",
    "sumup_webhook_events",
    "payment_rate_limits",
    "stock_reservations",
    "order_items",
    "orders",
    "catalog_variants",
    "catalog_products"
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare(`
    INSERT INTO catalog_products (sumup_item_id, name, is_active)
    VALUES (?, 'Runtime test product', 1)
  `).bind(ITEM_ID).run();
  await env.DB.prepare(`
    INSERT INTO catalog_variants (
      variant_key, sumup_item_id, sumup_variant_id, label, price_cents,
      visible_online, track_inventory, quantity
    ) VALUES ('runtime-small', ?, ?, 'Small', 1250, 1, 1, 2)
  `).bind(ITEM_ID, VARIANT_ID).run();
}

async function createPendingOrder(id = ORDER_ID, checkoutId = null) {
  await repository.createOrder(orderDetails(id), []);
  if (checkoutId) {
    await repository.updateCheckoutCreation(
      id,
      "created",
      { id: checkoutId, hostedCheckoutUrl: null },
      null
    );
  }
}

beforeAll(async () => {
  vi.stubGlobal("fetch", async () => {
    throw new Error("Real outbound network access is disabled in runtime tests.");
  });
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  await clearDatabase();
});

describe("Cloudflare Workers runtime and D1 integration", () => {
  it("applies the complete migration chain and rejects invalid stock through D1 constraints", async () => {
    const tables = await env.DB.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN (
        'catalog_products', 'catalog_variants', 'orders', 'order_items',
        'pending_sumup_notifications', 'stock_reservations', 'payment_rate_limits'
      )
    `).all();
    expect(tables.results.map(row => row.name).sort()).toEqual([
      "catalog_products",
      "catalog_variants",
      "order_items",
      "orders",
      "payment_rate_limits",
      "pending_sumup_notifications",
      "stock_reservations"
    ]);

    await expect(env.DB.prepare(`
      UPDATE catalog_variants SET quantity = -1 WHERE sumup_variant_id = ?
    `).bind(VARIANT_ID).run()).rejects.toThrow();
  });

  it("rolls back a failed D1 batch and enforces reservation limits atomically", async () => {
    await expect(repository.createOrder(orderDetails(), [{
      ...itemDetails(),
      quantity: 100,
      lineTotalCents: 125000
    }])).rejects.toThrow();
    expect(await repository.getOrderById(ORDER_ID)).toBeNull();

    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const [first, second] = await Promise.all([
      repository.reserveStock("reservation-a", [itemDetails(2)], expiresAt),
      repository.reserveStock("reservation-b", [itemDetails(2)], expiresAt)
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(await env.DB.prepare(`
      SELECT SUM(quantity) AS reserved FROM stock_reservations WHERE state = 'held'
    `).first()).toMatchObject({ reserved: 2 });
  });

  it("does not reserve stock when its quantity is unknown", async () => {
    await env.DB.prepare(`
      UPDATE catalog_variants SET quantity = NULL WHERE sumup_variant_id = ?
    `).bind(VARIANT_ID).run();
    const reserved = await repository.reserveStock(
      ORDER_ID,
      [itemDetails()],
      new Date(Date.now() + 60_000).toISOString()
    );
    expect(reserved).toBe(false);
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM stock_reservations"
    ).first()).toMatchObject({ count: 0 });
  });

  it.each([
    ["PAID", "paid", "committed", 1],
    ["FAILED", "failed", "released", 2],
    ["CANCELLED", "cancelled", "released", 2],
    ["EXPIRED", "expired", "released", 2]
  ])("applies %s once and keeps the corresponding D1 stock transition", async (
    sumupStatus,
    orderStatus,
    reservationState,
    remainingQuantity
  ) => {
    const checkoutId = CHECKOUT_ID;
    await repository.reserveStock(
      ORDER_ID,
      [itemDetails()],
      new Date(Date.now() + 60_000).toISOString()
    );
    await repository.createOrder(orderDetails(), [itemDetails()]);
    await repository.updateCheckoutCreation(
      ORDER_ID,
      "created",
      { id: checkoutId, hostedCheckoutUrl: null },
      null
    );
    const checkout = sumupCheckout({ status: sumupStatus });
    const applied = await repository.applyVerifiedCheckout(
      await repository.getOrderById(ORDER_ID),
      checkout,
      `runtime-${sumupStatus}`
    );
    expect(applied.status).toBe(orderStatus);
    expect(await env.DB.prepare(
      "SELECT state FROM stock_reservations WHERE order_id = ?"
    ).bind(ORDER_ID).first()).toMatchObject({ state: reservationState });
    expect(await env.DB.prepare(
      "SELECT quantity FROM catalog_variants WHERE sumup_variant_id = ?"
    ).bind(VARIANT_ID).first()).toMatchObject({ quantity: remainingQuantity });

    const repeated = await repository.applyVerifiedCheckout(
      await repository.getOrderById(ORDER_ID),
      checkout,
      `runtime-${sumupStatus}`
    );
    expect(repeated.duplicate).toBe(true);
    expect(await env.DB.prepare(
      "SELECT quantity FROM catalog_variants WHERE sumup_variant_id = ?"
    ).bind(VARIANT_ID).first()).toMatchObject({ quantity: remainingQuantity });
  });

  it("deduplicates repeated notifications and verifies payment using the fake SumUp transport", async () => {
    await repository.reserveStock(
      ORDER_ID,
      [itemDetails()],
      new Date(Date.now() + 60_000).toISOString()
    );
    await repository.createOrder(orderDetails(), [itemDetails()]);
    await repository.updateCheckoutCreation(
      ORDER_ID,
      "created",
      { id: CHECKOUT_ID, hostedCheckoutUrl: null },
      null
    );
    const transport = makeFakeSumupFetch({
      checkout: sumupCheckout({ status: "PAID" })
    });
    const api = createApi(transport.fetchImpl);

    const first = await api(notificationRequest(), createEnvironment());
    const second = await api(notificationRequest(), createEnvironment());
    expect(first.status).toBe(204);
    expect(second.status).toBe(204);
    expect(transport.calls).toHaveLength(2);
    expect(transport.calls.every(call => call.url.startsWith("https://api.sumup.com/"))).toBe(true);
    expect(await repository.getOrderById(ORDER_ID)).toMatchObject({ status: "paid" });
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM sumup_webhook_events"
    ).first()).toMatchObject({ count: 1 });
    expect(await env.DB.prepare(
      "SELECT state FROM pending_sumup_notifications WHERE checkout_id = ?"
    ).bind(CHECKOUT_ID).first()).toMatchObject({ state: "processed" });
  });

  it("recovers a notification delivered before the checkout ID is stored", async () => {
    let api;
    let earlyNotification;
    const transport = makeFakeSumupFetch({
      checkout: sumupCheckout({
        id: EARLY_CHECKOUT_ID,
        status: "PAID"
      }),
      onCreate: async () => {
        earlyNotification = await api(notificationRequest(EARLY_CHECKOUT_ID), createEnvironment());
      }
    });
    api = createApi(transport.fetchImpl);

    const response = await api(checkoutRequest(), createEnvironment());
    expect(response.status).toBe(201);
    expect(earlyNotification.status).toBe(204);
    expect(await repository.getOrderById(ORDER_ID)).toMatchObject({
      checkout_id: EARLY_CHECKOUT_ID,
      status: "paid"
    });
    expect(await env.DB.prepare(
      "SELECT quantity FROM catalog_variants WHERE sumup_variant_id = ?"
    ).bind(VARIANT_ID).first()).toMatchObject({ quantity: 1 });
  });

  it("runs notification reconciliation with real D1 and an injected SumUp transport", async () => {
    await createPendingOrder();
    await repository.recordWebhookNotification(CHECKOUT_ID, "CHECKOUT_STATUS_CHANGED");
    const transport = makeFakeSumupFetch({
      checkout: sumupCheckout({ status: "PAID" })
    });

    const summary = await runPaymentReconciliation(createEnvironment(), {
      repository,
      fetchImpl: transport.fetchImpl
    });

    expect(summary.notificationsProcessed).toBe(1);
    expect(summary.notificationsDeferred).toBe(0);
    expect(transport.calls).toHaveLength(1);
    expect(await repository.getOrderById(ORDER_ID)).toMatchObject({
      checkout_id: CHECKOUT_ID,
      status: "paid"
    });
  });

  it("runs scheduled reconciliation with real D1 and an injected SumUp transport", async () => {
    await createPendingOrder();
    await repository.recordWebhookNotification(CHECKOUT_ID, "CHECKOUT_STATUS_CHANGED");
    const transport = makeFakeSumupFetch({
      checkout: sumupCheckout({ status: "PAID" })
    });
    const worker = createPaymentStagingWorker({
      reconcile: scheduledEnv => runPaymentReconciliation(scheduledEnv, {
        repository,
        fetchImpl: transport.fetchImpl
      })
    });
    let scheduledTask;

    worker.scheduled(
      { cron: "* * * * *" },
      createEnvironment(),
      { waitUntil(task) { scheduledTask = task; } }
    );

    expect(scheduledTask).toBeInstanceOf(Promise);
    const summary = await scheduledTask;
    expect(summary.notificationsProcessed).toBe(1);
    expect(summary.notificationsDeferred).toBe(0);
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls.every(call => call.url.startsWith("https://api.sumup.com/"))).toBe(true);
    expect(await repository.getOrderById(ORDER_ID)).toMatchObject({
      checkout_id: CHECKOUT_ID,
      status: "paid"
    });
  });

  it("keeps transport failures retryable in D1 and never falls back to real fetch", async () => {
    await repository.recordWebhookNotification(CHECKOUT_ID, "CHECKOUT_STATUS_CHANGED");
    const transport = makeFakeSumupFetch({
      transportError: new Error("simulated transport outage")
    });

    const summary = await runPaymentReconciliation(createEnvironment(), {
      repository,
      fetchImpl: transport.fetchImpl
    });
    expect(summary.notificationsDeferred).toBe(1);
    expect(transport.calls).toHaveLength(1);
    expect(await env.DB.prepare(`
      SELECT state, attempts, last_error
      FROM pending_sumup_notifications WHERE checkout_id = ?
    `).bind(CHECKOUT_ID).first()).toMatchObject({
      state: "pending",
      attempts: 1,
      last_error: "simulated transport outage"
    });
  });

  it("marks ambiguous checkout creation uncertain without retrying SumUp", async () => {
    const transport = makeFakeSumupFetch({
      transportError: new Error("simulated create timeout")
    });
    const api = createApi(transport.fetchImpl);

    const first = await api(checkoutRequest(), createEnvironment());
    const second = await api(checkoutRequest(), createEnvironment());
    expect(first.status).toBe(503);
    expect(second.status).toBe(202);
    expect(await repository.getOrderById(ORDER_ID)).toMatchObject({
      checkout_creation_state: "uncertain"
    });
    expect(transport.calls).toHaveLength(1);
  });
});
