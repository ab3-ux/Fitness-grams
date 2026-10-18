import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { createD1PaymentRepository } from "../src/payment-adapters.mjs";

const ITEM_ID = "00000000-0000-4000-8000-000000000001";
const VARIANT_ID = "00000000-0000-4000-8000-000000000002";
const ORDER_A = "00000000-0000-4000-8000-000000000003";
const ORDER_B = "00000000-0000-4000-8000-000000000004";
const CHECKOUT_ID = "00000000-0000-4000-8000-000000000005";
const CHECKOUT_IDS = [
  CHECKOUT_ID,
  "00000000-0000-4000-8000-000000000006",
  "00000000-0000-4000-8000-000000000007",
  "00000000-0000-4000-8000-000000000008"
];

class LocalD1 {
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    const database = this.database;
    const statementFor = parameters => ({
          async first() {
            return database.prepare(sql).get(...parameters) ?? null;
          },
          async all() {
            return { results: database.prepare(sql).all(...parameters) };
          },
          async run() {
            return this.runSync();
          },
          runSync() {
            const result = database.prepare(sql).run(...parameters);
            return { meta: { changes: Number(result.changes) } };
          }
        });
    return {
      bind(...parameters) {
        return statementFor(parameters);
      },
      run() {
        return statementFor([]).run();
      },
      runSync() {
        return statementFor([]).runSync();
      }
    };
  }

  async batch(statements) {
    this.database.exec("BEGIN");
    try {
      const results = statements.map(statement => statement.runSync());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

async function createLocalRepository(quantity = 1) {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const filename of [
    "0001_initial_schema.sql",
    "0002_payment_api_safety.sql",
    "0003_payment_reliability.sql"
  ]) {
    database.exec(await readFile(new URL(`../migrations/${filename}`, import.meta.url), "utf8"));
  }
  database.prepare(`
    INSERT INTO catalog_products (sumup_item_id, name, is_active)
    VALUES (?, 'Product', 1)
  `).run(ITEM_ID);
  database.prepare(`
    INSERT INTO catalog_variants (
      variant_key, sumup_item_id, sumup_variant_id, label, price_cents,
      visible_online, track_inventory, quantity
    ) VALUES ('variant', ?, ?, 'Small', 1250, 1, 1, ?)
  `).run(ITEM_ID, VARIANT_ID, quantity);

  const d1 = new LocalD1(database);
  const repository = createD1PaymentRepository(d1);
  return { database, repository };
}

function order(id) {
  return {
    id,
    checkoutReference: id,
    totalCents: 1250,
    idempotencyKeyHash: `${id}-key`,
    requestHash: `${id}-request`,
    accessTokenHash: `${id}-token`
  };
}

function trackedItem(quantity = 1) {
  return {
    itemId: ITEM_ID,
    variantId: VARIANT_ID,
    sku: "FG-001",
    productName: "Product",
    variantLabel: "Small",
    quantity,
    unitPriceCents: 1250,
    lineTotalCents: 1250 * quantity,
    trackInventory: true
  };
}

test("migrations 0001-0003 apply and the D1 adapter serializes stock reservations", async () => {
  const { database, repository } = await createLocalRepository(1);
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const item = trackedItem();

  const [first, second] = await Promise.all([
    repository.reserveStock(ORDER_A, [item], expiresAt),
    repository.reserveStock(ORDER_B, [item], expiresAt)
  ]);
  assert.equal([first, second].filter(Boolean).length, 1);

  const winnerId = first ? ORDER_A : ORDER_B;
  const winner = order(winnerId);
  await repository.createOrder(winner, [item]);
  await repository.updateCheckoutCreation(
    winnerId,
    "created",
    { id: CHECKOUT_ID, hostedCheckoutUrl: null },
    null
  );

  const verifiedCheckout = {
    id: CHECKOUT_ID,
    checkout_reference: winnerId,
    amount: 12.5,
    currency: "EUR",
    merchant_code: "MC123",
    status: "PAID"
  };
  const firstApplication = await repository.applyVerifiedCheckout(
    await repository.getOrderById(winnerId),
    verifiedCheckout,
    "event-paid"
  );
  assert.equal(firstApplication.status, "paid");
  assert.equal(firstApplication.reconciled, true);
  assert.equal(database.prepare(
    "SELECT quantity FROM catalog_variants WHERE sumup_variant_id = ?"
  ).get(VARIANT_ID).quantity, 0);
  assert.equal(database.prepare(
    "SELECT state FROM stock_reservations WHERE order_id = ?"
  ).get(winnerId).state, "committed");

  const duplicateApplication = await repository.applyVerifiedCheckout(
    await repository.getOrderById(winnerId),
    verifiedCheckout,
    "event-paid"
  );
  assert.equal(duplicateApplication.duplicate, true);
  assert.equal(database.prepare(
    "SELECT quantity FROM catalog_variants WHERE sumup_variant_id = ?"
  ).get(VARIANT_ID).quantity, 0);
  database.close();
});

test("D1 notification inbox retries duplicate delivery and expires orphan reservations", async () => {
  const { database, repository } = await createLocalRepository();
  await repository.recordWebhookNotification(CHECKOUT_ID, "CHECKOUT_STATUS_CHANGED");
  await repository.recordWebhookNotification(CHECKOUT_ID, "CHECKOUT_STATUS_CHANGED");
  assert.equal(await repository.hasPendingWebhookNotification(CHECKOUT_ID), true);
  assert.equal((await repository.listDueWebhookNotifications()).length, 1);

  await repository.reserveStock(
    ORDER_B,
    [trackedItem()],
    new Date(Date.now() - 60_000).toISOString()
  );
  await repository.releaseOrphanedExpiredStock();
  assert.equal(database.prepare(
    "SELECT state FROM stock_reservations WHERE order_id = ?"
  ).get(ORDER_B).state, "expired");
  database.close();
});

test("D1 adapter applies known terminal states and quarantines unknown or conflicting states", async () => {
  const { database, repository } = await createLocalRepository();
  const cases = [
    { id: ORDER_A, checkoutId: CHECKOUT_IDS[0], sumupStatus: "FAILED", expected: "failed" },
    { id: ORDER_B, checkoutId: CHECKOUT_IDS[1], sumupStatus: "CANCELLED", expected: "cancelled" },
    {
      id: "00000000-0000-4000-8000-000000000009",
      checkoutId: CHECKOUT_IDS[2],
      sumupStatus: "EXPIRED",
      expected: "expired"
    },
    {
      id: "00000000-0000-4000-8000-000000000010",
      checkoutId: CHECKOUT_IDS[3],
      sumupStatus: "NEW_SUMUP_STATE",
      expected: "pending"
    }
  ];

  for (const entry of cases) {
    await repository.createOrder(order(entry.id), []);
    await repository.updateCheckoutCreation(
      entry.id,
      "created",
      { id: entry.checkoutId, hostedCheckoutUrl: null },
      null
    );
    const checkout = {
      id: entry.checkoutId,
      checkout_reference: entry.id,
      amount: 12.5,
      currency: "EUR",
      merchant_code: "MC123",
      status: entry.sumupStatus
    };
    const first = await repository.applyVerifiedCheckout(
      await repository.getOrderById(entry.id),
      checkout,
      `event-${entry.sumupStatus}`
    );
    assert.equal(first.status, entry.expected);
    assert.equal(first.reconciled, entry.sumupStatus !== "NEW_SUMUP_STATE");
    if (entry.sumupStatus === "NEW_SUMUP_STATE") {
      assert.equal((await repository.getOrderById(entry.id)).reconciliation_state, "required");
      continue;
    }
    const conflict = await repository.applyVerifiedCheckout(
      await repository.getOrderById(entry.id),
      { ...checkout, status: "PAID" },
      `event-conflict-${entry.sumupStatus}`
    );
    assert.equal(conflict.status, entry.expected);
    assert.equal(conflict.reconciled, false);
    assert.equal((await repository.getOrderById(entry.id)).reconciliation_state, "manual_review");
  }
  database.close();
});
