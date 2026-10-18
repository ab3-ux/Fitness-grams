import { createD1PaymentRepository, sumupStatusTransition } from "./payment-adapters.mjs";

const SUMUP_API_URL = "https://api.sumup.com";
const MAX_BODY_BYTES = 16 * 1024;
const MAX_ITEMS = 50;
const MAX_QUANTITY = 99;
const CHECKOUT_TIMEOUT_MS = 10_000;
const RESERVATION_TTL_MS = 20 * 60 * 1000;
const TRACKING_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RATE_LIMITS = Object.freeze({
  checkout: { count: 12, seconds: 60 },
  order: { count: 60, seconds: 60 },
  notification: { count: 120, seconds: 60 },
  sumup: { count: 120, seconds: 60 }
});

function getAllowedOrigins(env) {
  return new Set(
    (env.ALLOWED_ORIGINS || "")
      .split(",")
      .map(value => value.trim())
      .filter(Boolean)
  );
}

function jsonResponse(body, status, headers) {
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(JSON.stringify(body), { status, headers });
}

function emptyResponse(status, headers) {
  headers.set("Cache-Control", "no-store");
  return new Response(null, { status, headers });
}

function requestHeaders(request, env) {
  const headers = new Headers({ Vary: "Origin" });
  const origin = request.headers.get("Origin");
  const allowed = !origin || getAllowedOrigins(env).has(origin);
  if (origin && allowed) headers.set("Access-Control-Allow-Origin", origin);
  return { headers, allowed };
}

function isHttpsUrl(value) {
  if (typeof value !== "string" || !value) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function deriveOrderAccessToken(idempotencyKey, secret) {
  if (typeof secret !== "string" || secret.length < 32) {
    throw new Error("order_access_secret_not_configured");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`fitness-grams-order-access:${idempotencyKey}`)
  );
  return encodeBase64Url(new Uint8Array(signature));
}

function normalizeItemId(value) {
  if (typeof value !== "string" || value.length > 128) return null;
  const id = value.startsWith("sumup-") ? value.slice("sumup-".length) : value;
  return id.length > 0 && id.length <= 128 ? id : null;
}

function parseCart(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "invalid_body" };
  }
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return { error: "empty_cart" };
  }
  if (body.items.length > MAX_ITEMS) return { error: "too_many_items" };

  const quantities = new Map();
  for (const row of body.items) {
    const itemId = normalizeItemId(row?.id);
    const variantId = typeof row?.variant === "string" && row.variant.length <= 128
      ? row.variant
      : null;
    if (!itemId || !variantId) return { error: "invalid_item" };
    if (!Number.isInteger(row.qty) || row.qty < 1 || row.qty > MAX_QUANTITY) {
      return { error: "invalid_quantity" };
    }
    const key = `${itemId}\u0000${variantId}`;
    const quantity = (quantities.get(key)?.quantity ?? 0) + row.qty;
    if (quantity > MAX_QUANTITY) return { error: "invalid_quantity" };
    quantities.set(key, { itemId, variantId, quantity });
  }

  return {
    items: [...quantities.values()].sort((first, second) => (
      first.itemId.localeCompare(second.itemId)
      || first.variantId.localeCompare(second.variantId)
    ))
  };
}

function safeOrder(order) {
  return {
    id: order.id,
    status: order.status,
    currency: order.currency,
    total: order.total_cents / 100,
    checkoutUrl: order.hosted_checkout_url || null,
    checkoutReady: order.checkout_creation_state === "created"
  };
}

function withTrackingToken(order, token) {
  return { ...safeOrder(order), trackingToken: token };
}

function toCheckoutAmount(cents) {
  return Number((cents / 100).toFixed(2));
}

function isSafeHostedCheckoutUrl(value) {
  if (!isHttpsUrl(value)) return false;
  const hostname = new URL(value).hostname;
  return hostname === "checkout.sumup.com" || hostname.endsWith(".sumup.com");
}

async function readJson(request) {
  const contentLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return { error: "request_too_large" };
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    return { error: "request_too_large" };
  }
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { error: "invalid_json" };
  }
}

function bearerToken(request) {
  const match = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(
    request.headers.get("Authorization") || ""
  );
  return match?.[1] ?? null;
}

function sumupStatus(checkout) {
  return typeof checkout?.status === "string" ? checkout.status.trim().toUpperCase() : "";
}

function matchesExpectedCheckout(order, checkout, env, { allowMissingId = false } = {}) {
  if (!checkout || typeof checkout !== "object") return false;
  if (!allowMissingId && checkout.id !== order.checkout_id) return false;
  if (allowMissingId && typeof checkout.id !== "string") return false;
  if (checkout.checkout_reference !== order.checkout_reference) return false;
  if (checkout.currency !== order.currency || order.currency !== "EUR") return false;
  if (!Number.isFinite(checkout.amount) || Math.round(checkout.amount * 100) !== order.total_cents) {
    return false;
  }
  if (checkout.merchant_code !== env.SUMUP_MERCHANT_CODE) return false;
  return Boolean(sumupStatus(checkout));
}

function makeSumupClient(fetchImpl, repository) {
  async function assertSumupRateAvailable() {
    const allowed = await repository.consumeRateLimit(
      "sumup:global",
      RATE_LIMITS.sumup.count,
      RATE_LIMITS.sumup.seconds
    );
    if (!allowed) {
      const error = new Error("sumup_rate_limit_reached");
      error.code = "sumup_rate_limit_reached";
      error.status = 429;
      throw error;
    }
  }

  return {
    async createCheckout(env, order) {
      const payload = {
        checkout_reference: order.checkout_reference,
        amount: toCheckoutAmount(order.total_cents),
        currency: "EUR",
        merchant_code: env.SUMUP_MERCHANT_CODE,
        description: `Fitness-Grams commande ${order.id}`
      };

      if (!isHttpsUrl(env.SUMUP_RETURN_URL)) throw new Error("invalid_sumup_return_url");
      payload.return_url = env.SUMUP_RETURN_URL;
      if (env.SUMUP_REDIRECT_URL) {
        if (!isHttpsUrl(env.SUMUP_REDIRECT_URL)) throw new Error("invalid_sumup_redirect_url");
        payload.redirect_url = env.SUMUP_REDIRECT_URL;
      }
      if (env.SUMUP_HOSTED_CHECKOUT_ENABLED === "true") {
        payload.hosted_checkout = { enabled: true };
      }

      await assertSumupRateAvailable();
      const response = await fetchImpl(`${SUMUP_API_URL}/v0.1/checkouts`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.SUMUP_API_KEY}`,
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(CHECKOUT_TIMEOUT_MS)
      });
      const responseBody = await response.json().catch(() => null);
      if (!response.ok) {
        const error = new Error("sumup_create_failed");
        error.status = response.status;
        throw error;
      }
      return responseBody;
    },

    async getCheckout(env, checkoutId) {
      await assertSumupRateAvailable();
      const response = await fetchImpl(
        `${SUMUP_API_URL}/v0.1/checkouts/${encodeURIComponent(checkoutId)}`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${env.SUMUP_API_KEY}`,
            Accept: "application/json"
          },
          signal: AbortSignal.timeout(CHECKOUT_TIMEOUT_MS)
        }
      );
      if (!response.ok) {
        const error = new Error("sumup_status_lookup_failed");
        error.status = response.status;
        throw error;
      }
      return response.json();
    }
  };
}

async function clientRateLimitKey(request, route, repository) {
  const ipAddress = request.headers.get("CF-Connecting-IP") || "unknown";
  return `${route}:${await sha256(ipAddress)}`;
}

async function consumeClientRateLimit(request, route, repository) {
  const rate = RATE_LIMITS[route];
  const key = await clientRateLimitKey(request, route, repository);
  return repository.consumeRateLimit(key, rate.count, rate.seconds);
}

export function createPaymentApi({
  createRepository = env => createD1PaymentRepository(env.DB),
  fetchImpl = globalThis.fetch,
  createId = () => crypto.randomUUID()
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required.");

  return async function handlePaymentApi(request, env) {
    const { headers, allowed } = requestHeaders(request, env);
    const origin = request.headers.get("Origin");
    if (!allowed) return jsonResponse({ error: "origin_not_allowed" }, 403, headers);

    if (request.method === "OPTIONS") {
      headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type, Idempotency-Key");
      headers.set("Access-Control-Max-Age", "86400");
      return emptyResponse(204, headers);
    }

    const url = new URL(request.url);
    try {
      const repository = createRepository(env);
      const sumup = makeSumupClient(fetchImpl, repository);

      if (request.method === "POST" && url.pathname === "/api/checkout") {
        if (!await consumeClientRateLimit(request, "checkout", repository)) {
          return jsonResponse({ error: "rate_limit_exceeded" }, 429, headers);
        }
        return await createCheckout(
          request,
          env,
          repository,
          sumup,
          headers,
          createId
        );
      }
      if (request.method === "POST" && url.pathname === "/api/sumup/notification") {
        if (!await consumeClientRateLimit(request, "notification", repository)) {
          return emptyResponse(429, headers);
        }
        return await handleNotification(request, env, repository, sumup, headers);
      }
      const orderMatch = /^\/api\/orders\/([0-9a-f-]{36})$/i.exec(url.pathname);
      if (request.method === "GET" && orderMatch) {
        if (!TRACKING_ID_PATTERN.test(orderMatch[1])) {
          return jsonResponse({ error: "order_not_found" }, 404, headers);
        }
        if (!await consumeClientRateLimit(request, "order", repository)) {
          return jsonResponse({ error: "rate_limit_exceeded" }, 429, headers);
        }
        return await getOrder(request, repository, headers, orderMatch[1]);
      }
      return jsonResponse({ error: "not_found" }, 404, headers);
    } catch (error) {
      console.error("Payment API request failed", {
        path: url.pathname,
        error: error instanceof Error ? error.message : "unknown_error"
      });
      return jsonResponse({ error: "service_unavailable" }, 503, headers);
    }
  };
}

async function createCheckout(request, env, repository, sumup, headers, createId) {
  if (request.headers.get("Content-Type")?.split(";")[0].trim() !== "application/json") {
    return jsonResponse({ error: "application_json_required" }, 415, headers);
  }
  if (
    !env.SUMUP_API_KEY
    || !env.SUMUP_MERCHANT_CODE
    || !isHttpsUrl(env.SUMUP_RETURN_URL)
    || typeof env.ORDER_ACCESS_SECRET !== "string"
    || env.ORDER_ACCESS_SECRET.length < 32
  ) {
    return jsonResponse({ error: "payment_service_not_configured" }, 503, headers);
  }

  const idempotencyKey = request.headers.get("Idempotency-Key") || "";
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(idempotencyKey)) {
    return jsonResponse({ error: "valid_idempotency_key_required" }, 400, headers);
  }

  const parsed = await readJson(request);
  if (parsed.error) {
    return jsonResponse(
      { error: parsed.error },
      parsed.error === "request_too_large" ? 413 : 400,
      headers
    );
  }
  const cart = parseCart(parsed.value);
  if (cart.error) return jsonResponse({ error: cart.error }, 400, headers);

  const idempotencyHash = await sha256(idempotencyKey);
  const requestHash = await sha256(JSON.stringify(cart.items));
  const accessToken = await deriveOrderAccessToken(idempotencyKey, env.ORDER_ACCESS_SECRET);
  const accessTokenHash = await sha256(accessToken);
  const existing = await repository.getOrderByIdempotencyHash(idempotencyHash);
  if (existing) {
    if (existing.request_hash !== requestHash) {
      return jsonResponse({ error: "idempotency_key_reused" }, 409, headers);
    }
    if (existing.checkout_creation_state === "created") {
      return jsonResponse(withTrackingToken(existing, accessToken), 200, headers);
    }
    if (existing.checkout_creation_state === "failed") {
      return jsonResponse({ error: "checkout_creation_failed", orderId: existing.id }, 409, headers);
    }
    return jsonResponse(
      { ...withTrackingToken(existing, accessToken), retryable: false },
      202,
      headers
    );
  }

  const itemIds = [...new Set(cart.items.map(item => item.itemId))];
  const catalogRows = await repository.getCatalogVariants(itemIds);
  const preparedItems = [];
  let totalCents = 0;

  for (const requested of cart.items) {
    const productRows = catalogRows.filter(row => row.item_id === requested.itemId);
    if (!productRows.length || !productRows.some(row => row.product_active === 1)) {
      return jsonResponse({ error: "product_unavailable" }, 422, headers);
    }
    const variant = productRows.find(row => row.variant_id === requested.variantId);
    if (!variant || variant.product_active !== 1 || variant.visible_online !== 1) {
      return jsonResponse({ error: "variant_unavailable" }, 422, headers);
    }
    if (!variant.variant_id || !Number.isSafeInteger(variant.price_cents) || variant.price_cents < 0) {
      return jsonResponse({ error: "variant_not_billable" }, 422, headers);
    }
    if (variant.track_inventory === 1 && (
      !Number.isInteger(variant.quantity) || variant.quantity < requested.quantity
    )) {
      return jsonResponse({ error: "insufficient_stock" }, 422, headers);
    }

    const lineTotalCents = variant.price_cents * requested.quantity;
    if (!Number.isSafeInteger(lineTotalCents)) {
      return jsonResponse({ error: "amount_out_of_range" }, 422, headers);
    }
    totalCents += lineTotalCents;
    if (!Number.isSafeInteger(totalCents) || totalCents <= 0) {
      return jsonResponse({ error: "amount_out_of_range" }, 422, headers);
    }
    preparedItems.push({
      itemId: requested.itemId,
      variantId: variant.variant_id,
      sku: variant.sku,
      productName: variant.product_name,
      variantLabel: variant.variant_label,
      quantity: requested.quantity,
      unitPriceCents: variant.price_cents,
      lineTotalCents,
      trackInventory: variant.track_inventory === 1
    });
  }

  const orderId = createId();
  const expiresAt = new Date(Date.now() + RESERVATION_TTL_MS).toISOString();
  if (!await repository.reserveStock(orderId, preparedItems, expiresAt)) {
    return jsonResponse({ error: "insufficient_stock" }, 409, headers);
  }

  const order = {
    id: orderId,
    checkoutReference: orderId,
    totalCents,
    idempotencyKeyHash: idempotencyHash,
    requestHash,
    accessTokenHash
  };

  let created;
  try {
    created = await repository.createOrder(order, preparedItems);
  } catch (error) {
    await repository.releaseStock(orderId);
    const racedOrder = await repository.getOrderByIdempotencyHash(idempotencyHash);
    if (!racedOrder) throw error;
    if (racedOrder.request_hash !== requestHash) {
      return jsonResponse({ error: "idempotency_key_reused" }, 409, headers);
    }
    return jsonResponse(
      { ...withTrackingToken(racedOrder, accessToken), retryable: false },
      racedOrder.checkout_creation_state === "created" ? 200 : 202,
      headers
    );
  }

  try {
    const checkout = await sumup.createCheckout(env, created);
    const validCheckout = (
      checkout
      && typeof checkout.id === "string"
      && checkout.checkout_reference === created.checkout_reference
      && checkout.currency === "EUR"
      && Number.isFinite(checkout.amount)
      && Math.round(checkout.amount * 100) === totalCents
      && checkout.merchant_code === env.SUMUP_MERCHANT_CODE
      && sumupStatusTransition("pending", sumupStatus(checkout)).kind === "apply"
    );
    if (!validCheckout) {
      await repository.updateCheckoutCreation(
        orderId,
        "uncertain",
        typeof checkout?.id === "string"
          ? { id: checkout.id, hostedCheckoutUrl: null }
          : null,
        "invalid_sumup_create_response"
      );
      return jsonResponse({ error: "checkout_creation_uncertain", orderId }, 503, headers);
    }

    const hostedCheckoutUrl = checkout.hosted_checkout_url || null;
    if (
      env.SUMUP_HOSTED_CHECKOUT_ENABLED === "true"
      && !isSafeHostedCheckoutUrl(hostedCheckoutUrl)
    ) {
      await repository.updateCheckoutCreation(
        orderId,
        "uncertain",
        { id: checkout.id, hostedCheckoutUrl: null },
        "invalid_hosted_checkout_url"
      );
      return jsonResponse({ error: "checkout_creation_uncertain", orderId }, 503, headers);
    }
    if (hostedCheckoutUrl && !isSafeHostedCheckoutUrl(hostedCheckoutUrl)) {
      await repository.updateCheckoutCreation(
        orderId,
        "uncertain",
        { id: checkout.id, hostedCheckoutUrl: null },
        "invalid_hosted_checkout_url"
      );
      return jsonResponse({ error: "checkout_creation_uncertain", orderId }, 503, headers);
    }

    await repository.updateCheckoutCreation(
      orderId,
      "created",
      { id: checkout.id, hostedCheckoutUrl },
      null
    );
    const savedOrder = await repository.getOrderById(orderId);
    if (await repository.hasPendingWebhookNotification(checkout.id)) {
      try {
        await processStoredNotification(checkout.id, "CHECKOUT_STATUS_CHANGED", env, repository, sumup);
      } catch (error) {
        console.error("Early SumUp notification remains queued", {
          orderId,
          error: error instanceof Error ? error.message : "unknown_error"
        });
      }
    }
    return jsonResponse(withTrackingToken(savedOrder, accessToken), 201, headers);
  } catch (error) {
    if (error?.code === "sumup_rate_limit_reached") {
      await repository.updateCheckoutCreation(
        orderId,
        "failed",
        null,
        "sumup_rate_limit_exceeded"
      );
      return jsonResponse({ error: "sumup_rate_limit_exceeded", orderId }, 429, headers);
    }
    const definiteFailure = Number.isInteger(error?.status)
      && error.status >= 400
      && error.status < 500;
    await repository.updateCheckoutCreation(
      orderId,
      definiteFailure ? "failed" : "uncertain",
      null,
      definiteFailure ? "sumup_rejected_checkout" : "sumup_checkout_outcome_unknown"
    );
    return jsonResponse(
      {
        error: definiteFailure ? "checkout_creation_failed" : "checkout_creation_uncertain",
        orderId
      },
      definiteFailure ? 502 : 503,
      headers
    );
  }
}

async function getOrder(request, repository, headers, orderId) {
  const token = bearerToken(request);
  if (!token) return jsonResponse({ error: "order_not_found" }, 404, headers);
  const order = await repository.getOrderById(orderId);
  if (!order || order.access_token_hash !== await sha256(token)) {
    return jsonResponse({ error: "order_not_found" }, 404, headers);
  }
  return jsonResponse(safeOrder(order), 200, headers);
}

function notificationEventFingerprint(eventType, checkoutId) {
  return sha256(`${eventType}\u0000${checkoutId}`);
}

async function processStoredNotification(checkoutId, eventType, env, repository, sumup) {
  const checkout = await sumup.getCheckout(env, checkoutId);
  if (
    !checkout
    || typeof checkout.id !== "string"
    || checkout.id !== checkoutId
    || checkout.merchant_code !== env.SUMUP_MERCHANT_CODE
    || typeof checkout.checkout_reference !== "string"
  ) {
    await repository.deferWebhook(checkoutId, "invalid_sumup_checkout_lookup");
    return { processed: false, retry: true };
  }

  let order = await repository.getOrderByCheckoutId(checkout.id);
  if (!order) {
    order = await repository.getOrderByCheckoutReference(checkout.checkout_reference);
    if (!order || !matchesExpectedCheckout(order, checkout, env, { allowMissingId: true })) {
      await repository.deferWebhook(checkoutId, "unmatched_sumup_checkout_reference");
      return { processed: false, retry: true };
    }
    const attached = await repository.attachCheckoutByReference(
      checkout.checkout_reference,
      { id: checkout.id, hostedCheckoutUrl: checkout.hosted_checkout_url ?? null },
      order.id
    );
    if (!attached) {
      await repository.deferWebhook(checkoutId, "checkout_reference_already_linked");
      return { processed: false, retry: true };
    }
    order = await repository.getOrderByCheckoutId(checkout.id);
  }

  if (!matchesExpectedCheckout(order, checkout, env)) {
    await repository.deferWebhook(checkoutId, "sumup_checkout_mismatch");
    return { processed: false, retry: true };
  }

  const transition = sumupStatusTransition(order.status, sumupStatus(checkout));
  const fingerprint = await notificationEventFingerprint(eventType, checkoutId);
  const result = await repository.applyVerifiedCheckout(order, checkout, fingerprint);
  await repository.markWebhookProcessed(checkoutId);
  return { processed: true, transition, result };
}

async function handleNotification(request, env, repository, sumup, headers) {
  if (request.headers.get("Content-Type")?.split(";")[0].trim() !== "application/json") {
    return emptyResponse(415, headers);
  }
  const parsed = await readJson(request);
  if (parsed.error || !parsed.value || typeof parsed.value !== "object") {
    return emptyResponse(400, headers);
  }

  const { event_type: eventType, id: checkoutId } = parsed.value;
  if (typeof eventType !== "string" || eventType !== "CHECKOUT_STATUS_CHANGED") {
    return emptyResponse(204, headers);
  }
  if (typeof checkoutId !== "string" || checkoutId.length > 128) {
    return emptyResponse(400, headers);
  }

  await repository.recordWebhookNotification(checkoutId, eventType);
  await processStoredNotification(checkoutId, eventType, env, repository, sumup);
  return emptyResponse(204, headers);
}

export async function reconcilePendingNotification(notification, env, repository, fetchImpl = globalThis.fetch) {
  const sumup = makeSumupClient(fetchImpl, repository);
  try {
    return await processStoredNotification(
      notification.checkout_id,
      notification.event_type,
      env,
      repository,
      sumup
    );
  } catch (error) {
    await repository.deferWebhook(
      notification.checkout_id,
      error instanceof Error ? error.message : "sumup_lookup_failed"
    );
    throw error;
  }
}

export async function reconcileOrderWithCheckout(order, env, repository, fetchImpl = globalThis.fetch) {
  if (!order.checkout_id) {
    await repository.markOrderForManualReview(order.id, "no_documented_checkout_id_lookup");
    return { reconciled: false, manualReview: true };
  }

  const sumup = makeSumupClient(fetchImpl, repository);
  const checkout = await sumup.getCheckout(env, order.checkout_id);
  if (!matchesExpectedCheckout(order, checkout, env)) {
    await repository.markOrderForManualReview(order.id, "sumup_checkout_mismatch");
    return { reconciled: false, manualReview: true };
  }

  const transition = sumupStatusTransition(order.status, sumupStatus(checkout));
  const fingerprint = await notificationEventFingerprint(
    "CHECKOUT_STATUS_CHANGED",
    checkout.id
  );
  const result = await repository.applyVerifiedCheckout(order, checkout, fingerprint);
  return { reconciled: result.reconciled, transition };
}
