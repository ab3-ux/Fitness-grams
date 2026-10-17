const catalogueJsonUrl = new URL(
  "./fitness-grams-produits-sumup.json",
  document.currentScript.src
);
const categoryLabels = new Map([["all", "Tout le catalogue"]]);
const normalizeText = value => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const formatPrice = value => new Intl.NumberFormat("fr-FR", {
  style: "currency",
  currency: "EUR"
}).format(value);
const validImageUrl = value => {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const url = new URL(value, document.baseURI);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
  } catch {
    return "";
  }
};
const optionLabel = options => options
  .filter(option => option.value)
  .map(option => option.name ? `${option.name} : ${option.value}` : option.value)
  .join(" · ");

function selectedVariant(product, key) {
  return product.variants.find(variant => variant.key === key) || product.variants[0];
}

function quantityInCart(product, variant) {
  return cart
    .filter(row => row.id === product.id && row.variant === variant.key)
    .reduce((total, row) => total + row.qty, 0);
}

function variantAvailability(variant) {
  if (!variant.trackInventory) return { available: true, remaining: Infinity, label: "" };
  if (!Number.isInteger(variant.quantity) || variant.quantity < 0) {
    return { available: false, remaining: 0, label: "Stock indisponible" };
  }
  if (variant.quantity === 0) {
    return { available: false, remaining: 0, label: "Épuisé" };
  }
  return {
    available: true,
    remaining: variant.quantity,
    label: `En stock : ${variant.quantity}`
  };
}

function renderCatalogueCategories() {
  const nav = document.getElementById("categories");
  nav.replaceChildren();
  categoryLabels.forEach((label, key) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.setAttribute("aria-pressed", String(category === key));
    button.addEventListener("click", () => {
      category = key;
      renderCatalogueCategories();
      renderCatalogueProducts();
    });
    nav.append(button);
  });
}

function renderCatalogueProducts() {
  const query = normalizeText(document.getElementById("search").value.trim());
  const sort = document.getElementById("sort").value;
  const list = products.filter(product => {
    const matchesCategory = category === "all" || product.category === category;
    const searchable = [
      product.name,
      product.category,
      product.description,
      ...product.variants.flatMap(variant => [
        variant.sku,
        variant.label,
        ...variant.options.map(option => option.value)
      ])
    ].filter(Boolean).join(" ");
    return matchesCategory && normalizeText(searchable).includes(query);
  });
  if (sort !== "featured") {
    list.sort((first, second) => {
      if (first.price === null) return second.price === null ? 0 : 1;
      if (second.price === null) return -1;
      return sort === "asc" ? first.price - second.price : second.price - first.price;
    });
  }
  const grid = document.getElementById("products");
  grid.replaceChildren();
  document.getElementById("result-count").textContent = `${list.length} produit${list.length > 1 ? "s" : ""}`;
  document.getElementById("empty").hidden = list.length > 0;
  list.forEach(product => {
    const card = document.createElement("article");
    card.className = "product";
    const picture = document.createElement("div");
    picture.className = "picture";
    if (product.image) {
      const image = document.createElement("img");
      image.src = product.image;
      image.alt = product.name;
      image.loading = "lazy";
      image.onerror = () => picture.replaceChildren(document.createTextNode("Image indisponible"));
      picture.append(image);
    } else {
      picture.append(document.createTextNode("Image indisponible"));
    }

    const info = document.createElement("div");
    info.className = "info";
    if (product.category) {
      const categoryElement = document.createElement("div");
      categoryElement.className = "eyebrow";
      categoryElement.textContent = product.category;
      info.append(categoryElement);
    }
    const title = document.createElement("h3");
    title.textContent = product.name;
    info.append(title);
    if (product.description) {
      const description = document.createElement("p");
      description.textContent = product.description;
      info.append(description);
    }

    let variantSelect;
    if (product.variants.length > 1) {
      variantSelect = document.createElement("select");
      variantSelect.className = "variant-select";
      variantSelect.setAttribute("aria-label", `Choisir une déclinaison de ${product.name}`);
      product.variants.forEach(variant => {
        const option = document.createElement("option");
        option.value = variant.key;
        option.textContent = variant.label;
        if (!variantAvailability(variant).available) {
          option.disabled = true;
          option.textContent += ` — ${variantAvailability(variant).label}`;
        }
        variantSelect.append(option);
      });
      const availableVariant = product.variants.find(variant => (
        variant.price !== null && variantAvailability(variant).available
      ));
      if (availableVariant) variantSelect.value = availableVariant.key;
      info.append(variantSelect);
    }

    const reference = document.createElement("p");
    reference.className = "small";
    info.append(reference);
    const availabilityElement = document.createElement("p");
    availabilityElement.className = "small";
    info.append(availabilityElement);

    const bottom = document.createElement("div");
    bottom.className = "product-bottom";
    const priceGroup = document.createElement("div");
    const price = document.createElement("span");
    price.className = "price";
    const regularPrice = document.createElement("del");
    regularPrice.className = "price-old";
    regularPrice.hidden = true;
    priceGroup.append(price, regularPrice);
    const add = document.createElement("button");
    add.type = "button";
    add.className = "btn primary";
    bottom.append(priceGroup, add);

    const updateVariantDisplay = () => {
      const variant = selectedVariant(product, variantSelect?.value);
      if (!variant) return;
      if (variantSelect) variantSelect.value = variant.key;
      price.textContent = variant.price === null ? "Prix indisponible" : formatPrice(variant.price);
      const hasDiscount = variant.price !== null
        && variant.regularPrice !== null
        && variant.regularPrice > variant.price;
      regularPrice.hidden = !hasDiscount;
      regularPrice.textContent = hasDiscount ? formatPrice(variant.regularPrice) : "";
      reference.textContent = [
        variant.sku ? `Référence : ${variant.sku}` : ""
      ].filter(Boolean).join(" · ");
      const availability = variantAvailability(variant);
      const inCart = quantityInCart(product, variant);
      availabilityElement.textContent = availability.label;
      const canAdd = variant.price !== null && availability.available && inCart < availability.remaining && inCart < 99;
      add.disabled = !canAdd;
      if (variant.price === null) add.textContent = "Prix indisponible";
      else if (!availability.available) add.textContent = availability.label;
      else if (inCart >= availability.remaining) add.textContent = "Limite de stock atteinte";
      else if (inCart >= 99) add.textContent = "Quantité maximale";
      else add.textContent = "Ajouter +";
    };

    variantSelect?.addEventListener("change", updateVariantDisplay);
    add.addEventListener("click", () => {
      const variant = selectedVariant(product, variantSelect?.value);
      if (!variant || variant.price === null) return;
      const availability = variantAvailability(variant);
      const inCart = quantityInCart(product, variant);
      if (!availability.available || inCart >= availability.remaining || inCart >= 99) {
        updateVariantDisplay();
        return;
      }
      const row = cart.find(item => item.id === product.id && item.variant === variant.key);
      if (row) row.qty++;
      else cart.push({ id: product.id, variant: variant.key, qty: 1 });
      saveCatalogueCart();
      updateVariantDisplay();
      toast("Article ajouté à ta sélection");
    });
    updateVariantDisplay();

    const detail = document.createElement("button");
    detail.type = "button";
    detail.className = "detail";
    detail.textContent = "Voir le détail";
    detail.addEventListener("click", () => {
      const variant = selectedVariant(product, variantSelect?.value);
      document.getElementById("detail-title").textContent = product.name;
      document.getElementById("detail-copy").textContent = product.description || "Aucune description disponible.";
      if (variant?.label) {
        document.getElementById("detail-copy").textContent += `\n\nDéclinaison : ${variant.label}`;
      }
      document.getElementById("detail-dialog").showModal();
    });
    info.append(bottom, detail);
    card.append(picture, info);
    grid.append(card);
  });
}

function findCartVariant(row) {
  const product = products.find(item => item.id === row.id);
  if (product) {
    const variant = product.variants.find(item => (
      item.key === row.variant || item.sku === row.variant || item.sumupVariantId === row.variant
    ));
    if (variant) return { product, variant };
  }

  return products.reduce((match, item) => {
    if (match) return match;
    const variant = item.variants.find(candidate => (
      candidate.legacyId === row.id
      && (candidate.sku === row.variant || candidate.key === row.variant || row.variant === "")
    ));
    return variant ? { product: item, variant } : null;
  }, null);
}

function renderCatalogueCart() {
  const validRows = [];
  cart.forEach(row => {
    const match = findCartVariant(row);
    if (!match) return;
    const { product, variant } = match;
    const availability = variantAvailability(variant);
    if (variant.price === null || !availability.available) return;
    row.id = product.id;
    row.variant = variant.key;
    row.qty = Math.min(row.qty, availability.remaining, 99);
    if (row.qty > 0) validRows.push(row);
  });
  cart = validRows;

  const items = document.getElementById("cart-items");
  items.replaceChildren();
  let total = 0;
  let count = 0;
  cart.forEach(row => {
    const product = products.find(item => item.id === row.id);
    const variant = selectedVariant(product, row.variant);
    total += variant.price * row.qty;
    count += row.qty;
    const line = document.createElement("div");
    line.className = "cart-line";
    const name = document.createElement("strong");
    name.textContent = product.name;
    line.append(name);
    const details = [
      variant.label,
      variant.sku ? `Réf. ${variant.sku}` : "",
      formatPrice(variant.price)
    ].filter(Boolean);
    const reference = document.createElement("div");
    reference.className = "small";
    reference.textContent = details.join(" · ");
    line.append(reference);

    const controls = document.createElement("div");
    [-1, 1].forEach(delta => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "btn";
      button.textContent = delta === 1 ? "+" : "−";
      button.setAttribute("aria-label", `${delta === 1 ? "Augmenter" : "Diminuer"} la quantité de ${product.name}`);
      const availability = variantAvailability(variant);
      button.disabled = delta === 1
        && (row.qty >= availability.remaining || row.qty >= 99);
      button.addEventListener("click", () => {
        if (delta === 1 && (row.qty >= availability.remaining || row.qty >= 99)) return;
        row.qty += delta;
        cart = cart.filter(item => item.qty > 0);
        saveCatalogueCart();
        renderCatalogueProducts();
      });
      controls.append(button);
      if (delta === -1) {
        const quantity = document.createElement("span");
        quantity.textContent = String(row.qty);
        controls.append(quantity);
      }
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn";
    remove.textContent = "Retirer";
    remove.addEventListener("click", () => {
      cart = cart.filter(item => item !== row);
      saveCatalogueCart();
      renderCatalogueProducts();
    });
    controls.append(remove);
    line.append(controls);
    items.append(line);
  });
  if (cart.length === 0) {
    const empty = document.createElement("p");
    empty.textContent = "Ta sélection est vide.";
    items.append(empty);
  }
  document.getElementById("cart-count").textContent = String(count);
  document.getElementById("cart-total").textContent = `Total indicatif : ${formatPrice(total)}`;
}

function normalizeOptions(item) {
  if (Array.isArray(item.options)) {
    return item.options
      .filter(option => option && typeof option === "object")
      .map(option => ({
        name: typeof option.set === "string" ? option.set.trim() : "",
        value: typeof option.value === "string" ? option.value.trim() : ""
      }))
      .filter(option => option.value);
  }
  return Array.from({ length: 4 }, (_, index) => {
    const number = index + 1;
    const value = typeof item[`option${number}`] === "string" ? item[`option${number}`].trim() : "";
    const name = typeof item[`optionSet${number}`] === "string" ? item[`optionSet${number}`].trim() : "";
    return { name, value };
  }).filter(option => option.value);
}

function normalizeProductRow(item, index) {
  const name = item.name.trim();
  const category = typeof item.category === "string" ? item.category.trim() : "";
  const sku = typeof item.sku === "string" && item.sku.trim() ? item.sku.trim() : "";
  const itemId = typeof item.sumupItemId === "string" && item.sumupItemId.trim()
    ? item.sumupItemId.trim()
    : "";
  const sumupVariantId = typeof item.sumupVariantId === "string" && item.sumupVariantId.trim()
    ? item.sumupVariantId.trim()
    : "";
  const identity = sumupVariantId || itemId || sku || `${normalizeText(name)}|${normalizeText(category)}|${index}`;
  const price = typeof item.price === "number" && Number.isFinite(item.price) && item.price >= 0
    ? item.price
    : null;
  const regularPrice = typeof item.regularPrice === "number"
    && Number.isFinite(item.regularPrice)
    && item.regularPrice >= 0
    ? item.regularPrice
    : null;
  const images = Array.isArray(item.images)
    ? item.images.map(validImageUrl).filter(Boolean)
    : [];
  const image = validImageUrl(item.image) || images[0] || "";
  const options = normalizeOptions(item);
  const label = optionLabel(options)
    || (typeof item.variations === "string" ? item.variations.trim() : "")
    || sku
    || `Déclinaison ${index + 1}`;

  return {
    groupKey: itemId ? `item:${itemId}` : `row:${identity}:${index}`,
    groupId: itemId ? `sumup-${itemId}` : `sumup-${identity}`,
    legacyId: `sumup-${identity}`,
    name,
    category,
    description: typeof item.description === "string" ? item.description.trim() : "",
    image,
    sku,
    price,
    regularPrice,
    trackInventory: item.trackInventory === true,
    quantity: Number.isInteger(item.quantity) && item.quantity >= 0 ? item.quantity : null,
    sumupVariantId,
    options,
    label,
    visible: item.visibleOnline === true,
    isOnSale: item.isOnSale === true
  };
}

function makeVariant(row, index) {
  const key = row.sumupVariantId
    || (row.sku ? `${row.groupKey}:sku:${row.sku}` : `${row.groupKey}:variant:${index}`);
  return {
    key,
    legacyId: row.legacyId,
    sumupVariantId: row.sumupVariantId,
    sku: row.sku,
    options: row.options,
    label: row.label,
    price: row.price,
    regularPrice: row.regularPrice,
    trackInventory: row.trackInventory,
    quantity: row.quantity,
    image: row.image,
    isOnSale: row.isOnSale
  };
}

function buildProducts(source) {
  const groups = new Map();
  const seenVariants = new Map();
  source.forEach((item, index) => {
    if (!item || typeof item.name !== "string" || !item.name.trim()) return;
    const row = normalizeProductRow(item, index);
    if (!row.visible) return;
    const variant = makeVariant(row, index);
    let groupVariants = seenVariants.get(row.groupKey);
    if (!groupVariants) {
      groupVariants = new Set();
      seenVariants.set(row.groupKey, groupVariants);
    }
    if (groupVariants.has(variant.key)) return;
    groupVariants.add(variant.key);
    let product = groups.get(row.groupKey);
    if (!product) {
      product = {
        id: row.groupId,
        name: row.name,
        category: row.category,
        description: row.description,
        image: row.image,
        variants: []
      };
      groups.set(row.groupKey, product);
    }
    if (!product.image && row.image) product.image = row.image;
    product.variants.push(variant);
  });

  return [...groups.values()]
    .filter(product => product.variants.length > 0)
    .map(product => {
      product.price = product.variants.reduce((lowest, variant) => (
        variant.price === null ? lowest : lowest === null ? variant.price : Math.min(lowest, variant.price)
      ), null);
      return product;
    });
}

function restoreCart() {
  try {
    const saved = JSON.parse(localStorage.getItem("fg-demo-selection-v1") || "[]");
    if (Array.isArray(saved)) {
      cart = saved.filter(row => (
        row
        && typeof row.id === "string"
        && typeof row.variant === "string"
        && Number.isInteger(row.qty)
        && row.qty > 0
        && row.qty <= 99
      ));
    }
  } catch {
    cart = [];
  }
}

function saveCatalogueCart() {
  try {
    localStorage.setItem("fg-demo-selection-v1", JSON.stringify(cart));
  } catch {
    toast("Impossible d’enregistrer ta sélection dans ce navigateur.");
  }
  renderCatalogueCart();
}

function activateCatalogueRenderers() {
  renderCategories = renderCatalogueCategories;
  render = renderCatalogueProducts;
  renderCart = renderCatalogueCart;
  document.getElementById("search").oninput = renderCatalogueProducts;
  document.getElementById("sort").onchange = renderCatalogueProducts;
}

async function loadSumUpCatalogue() {
  try {
    const response = await fetch(catalogueJsonUrl);
    if (!response.ok) throw new Error("Catalogue indisponible");
    const source = await response.json();
    if (!Array.isArray(source)) throw new Error("Format du catalogue invalide");
    products = buildProducts(source);
    restoreCart();
    categoryLabels.clear();
    categoryLabels.set("all", "Tout le catalogue");
    [...new Set(products.map(product => product.category).filter(Boolean))].forEach(value => {
      categoryLabels.set(value, value);
    });
    category = "all";
    document.getElementById("source-label").textContent = "Export statique SumUp";
    document.getElementById("demo-notice").textContent = "Catalogue issu d’un export statique SumUp · Paiement non disponible";
    activateCatalogueRenderers();
    renderCatalogueCategories();
    renderCatalogueProducts();
    renderCatalogueCart();
  } catch {
    products = [];
    categoryLabels.clear();
    categoryLabels.set("all", "Tout le catalogue");
    document.getElementById("source-label").textContent = "Catalogue indisponible";
    document.getElementById("demo-notice").textContent = "Impossible de charger l’export statique SumUp.";
    activateCatalogueRenderers();
    renderCatalogueCategories();
    renderCatalogueProducts();
    renderCatalogueCart();
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", loadSumUpCatalogue, { once: true });
} else {
  loadSumUpCatalogue();
}
