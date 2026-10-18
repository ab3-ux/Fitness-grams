import { runPaymentReconciliation } from "./payment-reconciliation.mjs";

export function createPaymentStagingWorker({
  reconcile = runPaymentReconciliation
} = {}) {
  return {
    scheduled(_controller, env, ctx) {
      ctx.waitUntil(reconcile(env));
    }
  };
}

export default createPaymentStagingWorker();
