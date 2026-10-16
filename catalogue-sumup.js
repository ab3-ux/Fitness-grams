
document.addEventListener("DOMContentLoaded", async () => {
  const grid = document.getElementById("products-grid");
  if (!grid) return;

  try {
    const response = await fetch("./fitness-grams-produits-sumup.json");
    if (!response.ok) throw new Error("Erreur catalogue");

    const products = await response.json();
    const visibles = products.filter(
      p => p.visibleOnline === true && p.price !== null
    );

    grid.replaceChildren();

    visibles.forEach(p => {
      const card = document.createElement("article");
      card.className = "product-card";

      const title = document.createElement("h3");
      title.textContent = p.name;
      card.appendChild(title);

      const price = document.createElement("p");
      price.textContent = Number(p.price).toLocaleString("fr-FR", {
        style: "currency",
        currency: "EUR"
      });
      card.appendChild(price);

      if (p.image) {
        const img = document.createElement("img");
        img.src = p.image;
        img.alt = p.name;
        img.loading = "lazy";
        img.style.maxWidth = "100%";
        card.prepend(img);
      }

      grid.appendChild(card);
    });
  } catch (error) {
    grid.textContent = "Impossible de charger les produits SumUp.";
  }
});
