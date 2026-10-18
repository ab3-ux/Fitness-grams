# API de paiement SumUp (préparée, non activée)

Ces fichiers ajoutent une API isolée sans changer le Worker actif ni les pages
du site. `src/payment-api.mjs` expose un handler, et
`src/payment-adapters.mjs` son adaptateur Cloudflare D1. Tant qu’ils ne sont pas
importés par `src/index.js`, les routes décrites ci-dessous ne sont pas
accessibles. Aucun checkout n’est créé par les tests : les requêtes SumUp y
sont simulées.

## Audit du schéma antérieur

La migration `0001_initial_schema.sql` possède déjà les lignes de commande,
une référence SumUp unique et les montants en centimes. Elle ne stocke
toutefois ni empreinte d’idempotence ni secret d’accès au suivi, ni état de
création SumUp/URL Hosted Checkout, ni historique dédupliqué des notifications.
La migration additive `0002_payment_api_safety.sql` ajoute ces colonnes et la
table `sumup_webhook_events`. `0003_payment_reliability.sql` ajoute une file
d’attente durable pour les notifications, les états de rapprochement, les
réservations de stock, le rate limiting D1 et les triggers atomiques de
décompte/libération. Les migrations 0001–0003 sont testées ensemble sur une
base SQLite locale ; aucune migration n’a été exécutée sur D1.

Le catalogue actuel contient 63 lignes. Les lignes sans prix ou sans
`sumupVariantId` sont conservées dans D1, mais le handler les refuse comme
facturables.

## Routes préparées

- `POST /api/checkout` accepte `{ "items": [{ "id": "sumup-<item-id>",
  "variant": "<sumup-variant-id>", "qty": 1 }] }` et un header
  `Idempotency-Key`. Les prix et montants supplémentaires envoyés par le
  navigateur sont ignorés. Le serveur relit les variantes visibles/actives
  dans D1, vérifie stock et quantité, puis calcule le total en centimes.
- La clé d’idempotence doit être aléatoire (au moins 32 caractères base64url) et
  conservée par le navigateur pour les retries. Seul son SHA-256 est conservé
  en D1. Le suivi emploie un bearer token distinct, dérivé par HMAC avec le
  secret serveur `ORDER_ACCESS_SECRET`, et renvoyé avec la réponse initiale.
  Ne jamais enregistrer ces valeurs dans une URL ou un journal.
- Un retry avec la même clé et le même panier réutilise la commande. Une même clé avec
  un panier différent retourne `409`. Si la requête externe échoue de façon
  ambiguë, la création est `uncertain` et aucun second checkout n’est créé
  automatiquement. Si aucun ID de checkout n’est connu, SumUp ne documente pas
  ici de recherche par référence : la commande passe en revue manuelle, sans
  tentative automatique de recréation.
- `GET /api/orders/:id` ne révèle que l’identifiant, l’état, le total/devise et
  l’URL SumUp éventuelle, et renvoie `404` sans bearer valide.
- `POST /api/sumup/notification` attend
  `{"event_type":"CHECKOUT_STATUS_CHANGED","id":"<checkout-id>"}`. L’événement
  n’est pas considéré comme preuve : le Worker l’enregistre d’abord dans la
  file D1, puis demande à SumUp le checkout canonique. Si la notification arrive
  avant l’enregistrement local de l’ID, le rapprochement tente la référence
  unique de commande et vérifie le checkout authentifié avant de le lier. Seuls
  un identifiant,
  une référence, un montant, une devise et un marchand correspondants sont
  pris en compte. Un checkout `PAID` vérifié fait passer la commande à `paid`.
  Les états inconnus ne sont jamais interprétés comme `PENDING` ou `PAID` : ils
  sont mis en rapprochement. Les transitions incohérentes avec un état terminal
  sont mises en revue manuelle.

La documentation SumUp décrit le callback comme un POST avec `event_type` et
`id`, sans fournir de signature documentée sur cette page. La notification
sert donc uniquement de signal pour effectuer une lecture authentifiée de
l’API. SumUp recommande d’acquitter les notifications inconnues en 2xx et
retente les échecs avec délais ; les erreurs de lecture API entraînent donc une
réponse 503, tandis que l’événement est déjà durablement en file D1 pour une
reprise par le runner de rapprochement. Les callbacks répétés sont dédoublonnés
par empreinte du checkout et de son état canonique vérifié.

## Stocks, transitions et limitation

- D1 réserve atomiquement le stock suivi avant la création du checkout. Un
  trigger D1 décrémente la quantité au passage vérifié de `pending` à `paid`;
  `failed`, `cancelled` et `expired` libèrent la réservation. Les transitions
  terminales ne sont pas réouvertes par un callback ultérieur.
- Le délai d’expiration de 20 minutes ne libère que les réservations orphelines
  sans commande. Une commande dont un checkout SumUp peut exister conserve son
  stock jusqu’à une vérification terminale ou une décision manuelle : relâcher
  le stock sur un simple délai risquerait une survente.
- Le catalogue synchronisé doit alimenter `quantity` depuis une source
  d’inventaire fiable. Si la quantité est inconnue, ne pas activer
  `track_inventory` : aucune quantité n’est inventée et aucune réservation
  n’est simulée. La synchronisation des quantités D1 avec le stock SumUp reste
  une opération métier à définir et valider avant production.
- Les limites D1 sont appliquées par client et une limite globale protège les
  appels sortants SumUp. L’adresse client vient du Worker Cloudflare et est
  hachée avant stockage. CORS limite les origines navigateur mais n’authentifie
  pas les appels.
- Les statuts inconnus, les résultats ambigus de création sans ID de checkout
  et les conflits d’états terminaux nécessitent une revue manuelle. Il n’existe
  pas de réconciliation automatique par référence sans endpoint SumUp confirmé.

## Hosted Checkout SumUp

L’option suit le champ officiel `hosted_checkout: { enabled: true }`, et la
réponse n’est redirigeable que si SumUp retourne une URL HTTPS sous
`sumup.com`. Elle est conditionnée à
`SUMUP_HOSTED_CHECKOUT_ENABLED=true` ; le défaut est de ne pas demander Hosted
Checkout. La compatibilité du compte marchand n’est pas connue à ce stade et
doit être vérifiée dans son environnement SumUp. `SUMUP_RETURN_URL` doit être
l’URL HTTPS de la future route de notification. `SUMUP_REDIRECT_URL` est un
retour UX facultatif, jamais une preuve de paiement.

Sources officielles consultées :

- [Créer un checkout](https://developer.sumup.com/api/checkouts/create)
- [Hosted Checkout](https://developer.sumup.com/online-payments/checkouts/hosted-checkout)
- [Webhooks SumUp](https://developer.sumup.com/online-payments/webhooks)
- [Payment Widget](https://developer.sumup.com/online-payments/checkouts/card-widget)

## Configuration future (ne pas exécuter sans autorisation)

Variables publiques Worker :

- `SUMUP_MERCHANT_CODE` : identifiant de marchand, non-secret.
- `SUMUP_HOSTED_CHECKOUT_ENABLED` : `false` tant que l’éligibilité Hosted
  Checkout du compte n’est pas confirmée.
- `SUMUP_RETURN_URL` : URL HTTPS de la route callback lorsqu’elle sera déployée.
- `SUMUP_REDIRECT_URL` : URL HTTPS de la page de retour facultative.
- `ALLOWED_ORIGINS` : origines navigateur exactes séparées par virgules.

Secret Cloudflare uniquement :

- `SUMUP_API_KEY` : à définir avec `wrangler secret put` uniquement après
  approbation. Ne jamais l’ajouter au dépôt, aux variables `vars`, au frontend
  ou aux logs.
- `ORDER_ACCESS_SECRET` : secret aléatoire d’au moins 32 caractères, également
  conservé exclusivement comme secret Worker ; il signe les jetons de suivi.

Avant activation, un changement explicite de `cloudflare/src/index.js` sera
nécessaire pour router `/api/*` vers le handler et créer le repository D1.
Il n’est ni réalisé ni proposé comme patch dans cette étape ; l’endpoint
`/health` actuel reste seul actif.

## Tests locaux

Avec Node.js 22.5+ (`node:test` et `node:sqlite`) :

```sh
node --test cloudflare/test/payment-api.test.mjs cloudflare/test/payment-adapters.test.mjs
```

Les mocks couvrent : panier vide, produit/variante inconnus, quantité maximale
et stock, prix falsifié, recalcul en D1, erreurs et résultat incertain de
SumUp, idempotence, suivi autorisé, états pending/failed/cancelled/expired,
statuts inconnus, callback précoce et répété, état terminal, rate limiting et
CORS. Le test adaptateur applique localement les migrations 0001–0003 et exerce
la réservation concurrente, la confirmation idempotente du stock et la file de
notifications.

Validation de syntaxe sans accès réseau :

```sh
node --check cloudflare/src/payment-api.mjs
node --check cloudflare/src/payment-adapters.mjs
node --check cloudflare/src/payment-reconciliation.mjs
node --check cloudflare/test/payment-api.test.mjs
node --check cloudflare/test/payment-adapters.test.mjs
```

Ces commandes n’accèdent pas à une base distante et ne font aucun paiement.
Les tests n’appellent pas SumUp et ne vérifient ni l’éligibilité réelle du
marchand, ni les quotas Cloudflare, ni la sémantique de concurrence de D1
hébergé au-delà du contrat local testé.

## Limites à résoudre avant production

- Le mécanisme de réservation est préparé, mais reste inactif tant que les
  migrations ne sont pas approuvées/appliquées et que le module n’est pas activé.
  La politique de synchronisation de quantité avec SumUp reste à définir.
- Pas de taxes, frais de port, coordonnées de livraison, email de confirmation,
  remboursement, facture ou règles métier de traitement de commande.
- La page de retour et le suivi n’existent pas encore ; aucune page frontend
  n’est modifiée dans cette étape.
- Le nombre maximal d’articles par panier et la limite de quantité par ligne
  sont 50 et 99 dans le handler ; ajustables seulement par décision métier.
- Les quotas Cloudflare demeurent ceux du compte (Workers Free : 100 000
  requêtes/jour et 10 ms CPU/invocation ; D1 Free : 5 millions de lignes
  lues/jour, 100 000 écrites/jour, 5 Go, selon la documentation consultée).

**Arrêt volontaire :** le runner n’est pas raccordé à un Cron Trigger et le
module n’est pas importé par `src/index.js`. Les opérations distantes, les
migrations D1, les secrets réels, le déploiement, la publication et les
paiements demeurent désactivés.
