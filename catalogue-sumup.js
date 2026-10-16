
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
    const searchable = [product.name, product.category, product.description, product.sku].filter(Boolean).join(" ");
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
      const category = document.createElement("div");
      category.className = "eyebrow";
      category.textContent = product.category;
      info.append(category);
    }

    const title = document.createElement("h3");
    title.textContent = product.name;
    info.append(title);

    if (product.description) {
      const description = document.createElement("p");
      description.textContent = product.description;
      info.append(description);
    }

    if (product.sku) {
      const reference = document.createElement("p");
      reference.className = "small";
      reference.textContent = `Référence : ${product.sku}`;
      info.append(reference);
    }

    const bottom = document.createElement("div");
    bottom.className = "product-bottom";
    const price = document.createElement("span");
    price.className = "price";
    price.textContent = product.price === null ? "Prix indisponible" : formatPrice(product.price);
    const add = document.createElement("button");
    add.type = "button";
    add.className = "btn primary";
    add.textContent = product.price === null ? "Indisponible" : "Ajouter +";
    add.disabled = product.price === null;
    add.addEventListener("click", () => {
      if (product.price === null) return;
      const row = cart.find(item => item.id === product.id);
      if (row) {
        if (row.qty >= 99) return;
        row.qty++;
      } else {
        cart.push({ id: product.id, variant: product.sku || "", qty: 1 });
      }
      save();
      toast("Article ajouté à ta sélection");
    });
    bottom.append(price, add);

    const detail = document.createElement("button");
    detail.type = "button";
    detail.className = "detail";
    detail.textContent = "Voir le détail";
    detail.addEventListener("click", () => {
      document.getElementById("detail-title").textContent = product.name;
      document.getElementById("detail-copy").textContent = product.description || "Aucune description disponible.";
      document.getElementById("detail-dialog").showModal();
    });
    info.append(bottom, detail);
    card.append(picture, info);
    grid.append(card);
  });
}

function renderCatalogueCart() {
  cart = cart.filter(row => products.some(product => product.id === row.id && product.price !== null));
  const items = document.getElementById("cart-items");
  items.replaceChildren();
  let total = 0;
  let count = 0;

  cart.forEach(row => {
    const product = products.find(item => item.id === row.id);
    total += product.price * row.qty;
    count += row.qty;
    const line = document.createElement("div");
    line.className = "cart-line";
    const name = document.createElement("strong");
    name.textContent = product.name;
    line.append(name);
    if (product.sku) {
      const reference = document.createElement("div");
      reference.className = "small";
      reference.textContent = `Réf. ${product.sku} · ${formatPrice(product.price)}`;
      line.append(reference);
    } else {
      const price = document.createElement("div");
      price.className = "small";
      price.textContent = formatPrice(product.price);
      line.append(price);
    }

    const controls = document.createElement("div");
    [-1, 1].forEach(delta => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "btn";
      button.textContent = delta === 1 ? "+" : "−";
      button.setAttribute("aria-label", `${delta === 1 ? "Augmenter" : "Diminuer"} la quantité de ${product.name}`);
      button.addEventListener("click", () => {
        row.qty += delta;
        cart = cart.filter(item => item.qty > 0);
        save();
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
      save();
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

async function loadSumUpCatalogue() {
  try {
    const response = await fetch(catalogueJsonUrl);
    if (!response.ok) throw new Error("Catalogue indisponible");
    const source = await response.json();
    if (!Array.isArray(source)) throw new Error("Format du catalogue invalide");

    const seen = new Set();
    products = source.reduce((result, item, index) => {
      if (!item || item.visibleOnline !== true || typeof item.name !== "string" || !item.name.trim()) return result;

      const name = item.name.trim();
      const category = typeof item.category === "string" ? item.category.trim() : "";
      const sku = typeof item.sku === "string" && item.sku.trim() ? item.sku.trim() : "";
      const price = typeof item.price === "number" && Number.isFinite(item.price) && item.price >= 0 ? item.price : null;
      const identity = item.sumupVariantId || item.sumupItemId || sku || `${normalizeText(name)}|${normalizeText(category)}|${price}`;
      if (seen.has(identity)) return result;
      seen.add(identity);

      let image = "";
      if (typeof item.image === "string" && item.image.trim()) {
        try {
          const imageUrl = new URL(item.image, document.baseURI);
          if (imageUrl.protocol === "https:" || imageUrl.protocol === "http:") image = imageUrl.href;
        } catch {}
      }

      result.push({
        id: `sumup-${identity || index}`,
        name,
        category,
        description: typeof item.description === "string" ? item.description.trim() : "",
        price,
        image,
        sku
      });
      return result;
    }, []);

    categoryLabels.clear();
    categoryLabels.set("all", "Tout le catalogue");
    [...new Set(products.map(product => product.category).filter(Boolean))].forEach(value => {
      categoryLabels.set(value, value);
    });
    category = "all";
    document.getElementById("source-label").textContent = "Export statique SumUp";
    document.getElementById("demo-notice").textContent = "Catalogue issu d’un export statique SumUp · Paiement non disponible";
    renderCategories = renderCatalogueCategories;
    render = renderCatalogueProducts;
    renderCart = renderCatalogueCart;
    document.getElementById("search").oninput = renderCatalogueProducts;
    document.getElementById("sort").onchange = renderCatalogueProducts;
    renderCatalogueCategories();
    renderCatalogueProducts();
    renderCatalogueCart();
  } catch {
    products = [];
    categoryLabels.clear();
    categoryLabels.set("all", "Tout le catalogue");
    document.getElementById("source-label").textContent = "Catalogue indisponible";
    document.getElementById("demo-notice").textContent = "Impossible de charger l’export statique SumUp.";
    renderCategories = renderCatalogueCategories;
    render = renderCatalogueProducts;
    renderCart = renderCatalogueCart;
    document.getElementById("search").oninput = renderCatalogueProducts;
    document.getElementById("sort").onchange = renderCatalogueProducts;
    renderCatalogueCategories();
    renderCatalogueProducts();
    renderCatalogueCart();
  }
}

document.addEventListener("DOMContentLoaded", loadSumUpCatalogue);
