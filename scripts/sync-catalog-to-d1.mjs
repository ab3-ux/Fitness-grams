import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const defaultCatalogPath = join(repositoryRoot, "fitness-grams-produits-sumup.json");
const configPath = join(repositoryRoot, "cloudflare", "wrangler.toml");
const allowedOptions = new Set(["--remote", "--local", "--dry-run"]);
const options = new Set(process.argv.slice(2));

if ([...options].some(option => !allowedOptions.has(option))) {
  throw new Error("Options acceptées : --remote ou --local, et éventuellement --dry-run.");
}

if (options.has("--remote") === options.has("--local")) {
  throw new Error("Choisissez explicitement une seule cible : --remote ou --local.");
}

const catalog = JSON.parse(await readFile(defaultCatalogPath, "utf8"));
if (!Array.isArray(catalog) || catalog.length === 0) {
  throw new Error("Le fichier catalogue doit contenir un tableau non vide.");
}

const products = new Map();
const variants = [];
const seenVariantIds = new Set();

for (const [index, item] of catalog.entries()) {
  if (!item || typeof item.sumupItemId !== "string" || !item.sumupItemId.trim()) {
    throw new Error(`Ligne catalogue ${index + 1} sans sumupItemId valide.`);
  }
  if (typeof item.name !== "string" || !item.name.trim()) {
    throw new Error(`Ligne catalogue ${index + 1} sans nom valide.`);
  }

  const itemId = item.sumupItemId.trim();
  const variantId = typeof item.sumupVariantId === "string" && item.sumupVariantId.trim()
    ? item.sumupVariantId.trim()
    : null;
  if (variantId && seenVariantIds.has(variantId)) {
    throw new Error(`Identifiant de variante dupliqué : ${variantId}`);
  }
  if (variantId) seenVariantIds.add(variantId);

  const priceCents = typeof item.price === "number" && Number.isFinite(item.price) && item.price >= 0
    ? Math.round(item.price * 100)
    : null;
  if (
    priceCents !== null
    && Math.abs(item.price * 100 - priceCents) > 1e-7
  ) {
    throw new Error(`Le prix doit avoir au plus deux décimales à la ligne ${index + 1}.`);
  }
  if (priceCents !== null && !Number.isSafeInteger(priceCents)) {
    throw new Error(`Prix hors limites à la ligne catalogue ${index + 1}.`);
  }

  let product = products.get(itemId);
  if (!product) {
    product = {
      sumupItemId: itemId,
      name: item.name.trim(),
      category: typeof item.category === "string" ? item.category.trim() : "",
      description: typeof item.description === "string" ? item.description : "",
      imageUrl: typeof item.image === "string" && item.image.trim() ? item.image.trim() : null,
      isActive: false
    };
    products.set(itemId, product);
  }
  product.isActive ||= item.visibleOnline === true;

  variants.push({
    variantKey: variantId || `unmapped:${itemId}:${index + 1}`,
    sumupItemId: itemId,
    sumupVariantId: variantId,
    sku: typeof item.sku === "string" && item.sku.trim() ? item.sku.trim() : null,
    label: typeof item.sku === "string" && item.sku.trim()
      ? item.sku.trim()
      : `Déclinaison ${index + 1}`,
    priceCents,
    visibleOnline: item.visibleOnline === true,
    trackInventory: item.trackInventory === true,
    quantity: Number.isInteger(item.quantity) && item.quantity >= 0 ? item.quantity : null
  });
}

const sqlString = value => value === null
  ? "NULL"
  : `'${String(value).replaceAll("'", "''")}'`;
const sqlInteger = value => value === null ? "NULL" : String(value);
const syncAt = new Date().toISOString();
const statements = [];

for (const product of products.values()) {
  statements.push(
    `INSERT INTO catalog_products ` +
    `(sumup_item_id, name, category, description, image_url, is_active, synced_at) VALUES (` +
    `${sqlString(product.sumupItemId)}, ${sqlString(product.name)}, ${sqlString(product.category)}, ` +
    `${sqlString(product.description)}, ${sqlString(product.imageUrl)}, ${Number(product.isActive)}, ` +
    `${sqlString(syncAt)}) ON CONFLICT(sumup_item_id) DO UPDATE SET ` +
    "name = excluded.name, category = excluded.category, description = excluded.description, " +
    "image_url = excluded.image_url, is_active = excluded.is_active, synced_at = excluded.synced_at;"
  );
}

for (const variant of variants) {
  statements.push(
    `INSERT INTO catalog_variants ` +
    `(variant_key, sumup_item_id, sumup_variant_id, sku, label, price_cents, visible_online, ` +
    `track_inventory, quantity, synced_at) VALUES (` +
    `${sqlString(variant.variantKey)}, ${sqlString(variant.sumupItemId)}, ` +
    `${sqlString(variant.sumupVariantId)}, ${sqlString(variant.sku)}, ${sqlString(variant.label)}, ` +
    `${sqlInteger(variant.priceCents)}, ${Number(variant.visibleOnline)}, ` +
    `${Number(variant.trackInventory)}, ${sqlInteger(variant.quantity)}, ${sqlString(syncAt)}) ` +
    "ON CONFLICT(variant_key) DO UPDATE SET " +
    "sumup_item_id = excluded.sumup_item_id, sumup_variant_id = excluded.sumup_variant_id, " +
    "sku = excluded.sku, label = excluded.label, price_cents = excluded.price_cents, " +
    "visible_online = excluded.visible_online, track_inventory = excluded.track_inventory, " +
    "quantity = excluded.quantity, synced_at = excluded.synced_at;"
  );
}

statements.push(
  `UPDATE catalog_products SET is_active = 0 WHERE synced_at <> ${sqlString(syncAt)};`,
  `UPDATE catalog_variants SET visible_online = 0 WHERE synced_at <> ${sqlString(syncAt)};`
);
const sql = `${statements.join("\n")}\n`;

if (options.has("--dry-run")) {
  console.error(`Catalogue valide : ${products.size} articles, ${variants.length} variantes.`);
  console.error(`SQL préparé : ${Buffer.byteLength(sql)} octets. Aucune base modifiée.`);
  process.stdout.write(sql);
  process.exit(0);
}

const tempFile = join(tmpdir(), `fitness-grams-catalog-${randomUUID()}.sql`);
await writeFile(tempFile, sql, { mode: 0o600 });

try {
  const target = options.has("--remote") ? "--remote" : "--local";
  const result = spawnSync(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      "fitness-grams-commerce",
      target,
      "--file",
      tempFile,
      "--config",
      configPath
    ],
    { cwd: repositoryRoot, stdio: "inherit" }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Wrangler a quitté avec le code ${result.status ?? "inconnu"}.`);
  }
} finally {
  await unlink(tempFile);
}
