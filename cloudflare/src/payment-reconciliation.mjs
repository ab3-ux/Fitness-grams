import {
  createD1PaymentRepository
} from "./payment-adapters.mjs";
import {
  reconcileOrderWithCheckout,
  reconcilePendingNotification
} from "./payment-api.mjs";

const MAX_BATCH_SIZE = 25;
const MAX_EXECUTIONS_PER_MINUTE = 120;

export async function runPaymentReconciliation(
  env,
  {
    repository = createD1PaymentRepository(env.DB),
    fetchImpl = globalThis.fetch,
    now = Date.now()
  } = {}
) {
  const runAllowed = await repository.consumeRateLimit(
    "reconciliation:global",
    MAX_EXECUTIONS_PER_MINUTE,
    60,
    now
  );
  if (!runAllowed) {
    return { skipped: true, reason: "rate_limit_exceeded" };
  }

  const summary = {
    notificationsProcessed: 0,
    notificationsDeferred: 0,
    ordersReconciled: 0,
    ordersNeedingReview: 0
  };

  await repository.releaseOrphanedExpiredStock();

  const notifications = await repository.listDueWebhookNotifications(MAX_BATCH_SIZE);
  for (const notification of notifications) {
    try {
      const result = await reconcilePendingNotification(
        notification,
        env,
        repository,
        fetchImpl
      );
      if (result.processed) summary.notificationsProcessed += 1;
      else summary.notificationsDeferred += 1;
    } catch (error) {
      summary.notificationsDeferred += 1;
      console.error("Queued SumUp notification reconciliation failed", {
        checkoutId: notification.checkout_id,
        error: error instanceof Error ? error.message : "unknown_error"
      });
    }
  }

  const pendingOrders = await repository.listOrdersForStatusRefresh(MAX_BATCH_SIZE);
  const ordersNeedingReconciliation = await repository.listOrdersNeedingReconciliation(
    MAX_BATCH_SIZE
  );
  const ordersById = new Map(
    [...pendingOrders, ...ordersNeedingReconciliation].map(order => [order.id, order])
  );

  for (const order of ordersById.values()) {
    try {
      const result = await reconcileOrderWithCheckout(order, env, repository, fetchImpl);
      if (result.reconciled) summary.ordersReconciled += 1;
      else if (result.manualReview) summary.ordersNeedingReview += 1;
    } catch (error) {
      console.error("SumUp order status reconciliation failed", {
        orderId: order.id,
        error: error instanceof Error ? error.message : "unknown_error"
      });
    }
  }

  const uncertainOrders = await repository.listUncertainOrdersWithoutCheckout(MAX_BATCH_SIZE);
  for (const order of uncertainOrders) {
    await repository.markOrderForManualReview(
      order.id,
      "no_documented_checkout_lookup_by_reference"
    );
    summary.ordersNeedingReview += 1;
  }

  await repository.cleanupRateLimits(Math.floor(now / 1000) - 2 * 60 * 60);
  return summary;
}
