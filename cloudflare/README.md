# Socle Cloudflare pour Fitness-Grams

Ce dossier prépare un Worker, une liaison D1 et le schéma initial. À ce stade,
le Worker ne propose que `GET /health` et les réponses CORS nécessaires à cette
route. Il ne lit pas la clé SumUp, ne crée pas de checkout et ne modifie pas de
commande. Les pages de boutique et le catalogue statique existants restent
inchangés.

## Fichiers

- `wrangler.toml` : Worker, liaison D1 et origines autorisées.
- `src/index.js` : endpoint de santé uniquement.
- `migrations/0001_initial_schema.sql` : tables `catalog_products`,
  `catalog_variants`, `orders` et `order_items`.
- `../scripts/sync-catalog-to-d1.mjs` : synchronisation manuelle du JSON de
  catalogue actuel vers D1. Elle conserve les prix comme entiers en centimes,
  désactive les références disparues et n’active pas une variante dont le
  catalogue ne fournit pas d’identifiant SumUp. Le script est idempotent ; en
  cas d’erreur de synchronisation, corrigez la cause puis relancez-le. Cette
  synchronisation n’est pas branchée au parcours de commande ni au workflow de
  publication existant.

## Secrets

La clé SumUp n’est ni présente dans le dépôt, ni utilisée par ce Worker.
`SUMUP_API_KEY` est le nom réservé pour la future intégration serveur.
`ORDER_ACCESS_SECRET` sera également nécessaire pour signer les jetons de
suivi des commandes. Les valeurs dans le fichier modèle sont des marqueurs à
remplacer uniquement dans le fichier local ignoré par Git ; n’y inscrivez pas
de clé réelle dans le dépôt.

Pour préparer le développement local, copier le modèle à la racine du dépôt :

```sh
cp .dev.vars.example cloudflare/.dev.vars
```

Wrangler charge `.dev.vars` depuis le même dossier que le fichier de
configuration sélectionné. Avec les commandes de ce dépôt qui utilisent
`--config cloudflare/wrangler.toml`, le fichier local doit donc être
`cloudflare/.dev.vars`. Ne remplacez les marqueurs que dans ce fichier local
ignoré par Git. Pour un futur déploiement, la commande prévue est :

```sh
npx wrangler secret put SUMUP_API_KEY --config cloudflare/wrangler.toml
npx wrangler secret put ORDER_ACCESS_SECRET --config cloudflare/wrangler.toml
```

Ne l’exécutez pas avant d’avoir approuvé et configuré l’étape de paiement.

`wrangler.staging.toml` et `src/payment-staging-worker.mjs` préparent une
configuration isolée pour un futur staging. Le fichier contient uniquement un
marqueur pour l’identifiant D1, aucun domaine de production, et aucun Cron
Trigger. Le Worker actif continue d’utiliser `wrangler.toml` et `src/index.js`.
Le handler planifié et le runner sont testés localement avec Miniflare, D1
locale et un transport SumUp simulé ; ces tests n’activent pas de déclencheur.

## Origines navigateur

`ALLOWED_ORIGINS` est une liste d’origines séparées par des virgules, comparées
exactement (schéma, hôte et port ; sans chemin). La configuration initiale
prévoit :

- `https://ab3-ux.github.io` pour GitHub Pages ;
- `https://www.fitness-grams.com` pour le domaine personnalisé utilisé par le
  site HubSpot.

Si HubSpot sert aussi la page depuis un domaine de prévisualisation ou un autre
domaine personnalisé, ajoutez son origine exacte à `ALLOWED_ORIGINS` après
l’avoir relevée dans la barre d’adresse. N’ajoutez pas `*`. CORS ne remplace
pas l’authentification ni la validation serveur qui seront nécessaires aux
futures routes.

## Configuration et déploiement (à exécuter après validation)

Ces commandes créent des ressources ou déploient du code ; aucune n’a été
exécutée pour préparer ce socle.

1. Installer Wrangler dans l’environnement de travail (ou utiliser `npx`),
   puis s’authentifier :

   ```sh
   npx wrangler login
   ```

2. Créer D1 :

   ```sh
   npx wrangler d1 create fitness-grams-commerce
   ```

3. Copier le `database_id` retourné dans `database_id` de
   `cloudflare/wrangler.toml`, en remplaçant le texte `REPLACE_WITH_D1_DATABASE_ID`.
   Vérifier également `ALLOWED_ORIGINS`.

4. Appliquer le schéma :

   ```sh
   npx wrangler d1 migrations apply fitness-grams-commerce --remote \
     --config cloudflare/wrangler.toml
   ```

5. Synchroniser le catalogue JSON existant dans D1 (opération distincte des
   pages statiques) :

   ```sh
   node scripts/sync-catalog-to-d1.mjs --remote
   ```

   Pour vérifier le JSON et préparer le SQL sans exécuter de commande D1 :

   ```sh
   node scripts/sync-catalog-to-d1.mjs --remote --dry-run
   ```

   Le SQL préparé est envoyé sur la sortie standard ; le résumé est envoyé sur
   la sortie d’erreur. Le mode `--dry-run` ne lance pas Wrangler et ne modifie
   aucune base. D1 n’exécutant pas les fichiers SQL dans une transaction
   explicite, les anciennes entrées ne sont désactivées qu’à la fin du script ;
   si la synchronisation échoue, relancez-la après correction.

6. Déployer uniquement lorsque cela est autorisé :

   ```sh
   npx wrangler deploy --config cloudflare/wrangler.toml
   ```

Après déploiement, l’URL `https://fitness-grams-commerce-api.<sous-domaine>.workers.dev/health`
sert à vérifier que le Worker et D1 répondent. Aucune route de paiement
n’existe encore. Le service n’est pas ajouté au workflow GitHub Actions ni au
déploiement HubSpot.

## Modèle D1

- `catalog_products` : identité SumUp et données d’affichage du produit.
- `catalog_variants` : identifiant SumUp de variante, SKU, prix en centimes,
  visibilité et champs de stock disponibles. Les prix/variantes absents
  restent `NULL` et ne doivent pas devenir facturables par défaut.
- `orders` : référence interne de checkout, identifiants SumUp, statut et
  montants figés en centimes.
- `order_items` : instantané des lignes de commande, de leur libellé et des
  prix unitaires/totaux au moment de la commande.

Les tables de commande sont seulement le schéma de stockage ; aucune route
actuelle n’insère ou ne confirme de commande. Toute confirmation future devra
être fondée sur une vérification serveur du statut auprès de SumUp.

## Coûts et limites à prévoir

Selon les tarifs Cloudflare consultés le 18 octobre 2026, le palier gratuit
Workers inclut jusqu’à 100 000 requêtes par jour et 10 ms de CPU par invocation.
D1 inclut 5 millions de lignes lues par jour, 100 000 lignes écrites par jour
et 5 Go de stockage. L’offre Workers payante a un minimum de 5 USD/mois ; les
tarifs et dépassements sont susceptibles d’évoluer. Le paiement SumUp peut
entraîner des frais de traitement indépendants de Cloudflare, selon le contrat
du compte marchand.

Sources officielles : [tarifs Workers](https://developers.cloudflare.com/workers/platform/pricing/),
[limites Workers](https://developers.cloudflare.com/workers/platform/limits/) et
[tarifs D1](https://developers.cloudflare.com/d1/platform/pricing/).
