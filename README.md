# ✊🍔 FastFist — Gratte le King

Page HTML qui récupère **le menu complet de Burger King France, resto par resto**, et calcule les meilleures
façons d'avoir un repas qui cale pour pas cher.

## Ce que fait la page

| Onglet | Contenu |
|---|---|
| 🏆 **Top gratte** | Les meilleurs plans du resto choisi : ce qui cale le plus par euro (€/1000 kcal), le burger le moins cher, le meilleur prix par burger en menu, la plus grosse économie vs à la carte, les protéines les moins chères, la pièce de poulet la moins chère. Plus un classement de **toutes** les offres (produits seuls + menus en version optimisée). |
| 🍟 **Menus** | Chaque menu (classiques M/L/XL, enfants, Bon et Pas Cher, Baby Burgers, offres…) avec son prix, sa valeur à la carte, l'économie réalisée et, en cliquant dessus, **le coût unitaire de chaque élément** (prix du menu réparti au prorata des prix à la carte) et son coût marginal. Chaque menu peut être affiché en composition par défaut ou en version « maxée » (valeur, calories/€, protéines/€) : le meilleur choix est fait automatiquement à chaque étape, suppléments compris. |
| 🧾 **Produits seuls** | Tous les produits vendus seuls : prix, écart avec la médiane France, kcal, €/1000 kcal, protéines, €/10 g de protéines, €/pièce (nuggets, tenders, onion rings…). |
| 🧮 **Optimiseur** | « J'ai 10 € » → la commande qui maximise les calories / protéines / nombre de burgers / pièces / valeur. Ou « je veux 2000 kcal » → la commande la moins chère pour y arriver. Optimum exact (sac à dos borné, programmation dynamique au centime). |
| 🇫🇷 **France** | Indice de prix de chaque resto (100 = médiane France), les restos les moins chers / plus chers, les moins chers autour de toi. |

Les prix **varient énormément d'un resto à l'autre** (le cheeseburger va du simple au double), d'où le
sélecteur de restaurant (recherche ville / CP / nom, ou géolocalisation).

## Données

`scraper/scrape.py` (Python 3, aucune dépendance) récupère :

- la liste des ~640 restos et leurs fiches (API publique du store-locator de burgerking.fr) ;
- pour chaque resto, le catalogue complet utilisé par la commande en ligne : prix des produits seuls,
  prix des menus par taille, étapes de chaque menu (choix possibles) et suppléments ;
- les valeurs nutritionnelles (kcal, protéines) depuis les pages `/carte` du site.

Il écrit dans `data/` :

```
data/restaurants.json     liste des restos + indice de prix + clé de leur grille de prix
data/catalog.json         produits (nom, rôle, kcal, protéines, pièces), menus, étapes de menus
data/prices/<hash>.json   grille de prix d'un resto (produits + menus)
data/stats.json           min / médiane / max France par produit et par menu
```

Une GitHub Action (`.github/workflows/scrape.yml`) relance le scrape tous les jours et commit les
nouveaux prix.

## Lancer en local

```bash
python3 scraper/scrape.py          # ~3-4 min pour tous les restos (--limit 20 pour tester)
python3 -m http.server 8000        # puis http://localhost:8000
```

La page est 100 % statique (HTML + JS vanilla), elle doit juste être servie en HTTP (pas en `file://`).

## Mise en ligne (GitHub Pages)

Le workflow `.github/workflows/pages.yml` déploie le site à chaque push sur `main`. Il suffit d'activer
**Settings → Pages → Source : GitHub Actions** dans le dépôt.

## Méthode de calcul

- **Prix à la carte d'un élément** = son prix vendu seul dans le même resto. Si l'élément n'existe qu'en
  menu, on utilise son prix catalogue (signalé `≈`), sauf s'il est aberrant (ex. chaque mini-burger d'une
  boîte Baby Burgers porte le prix de la boîte entière) : l'économie est alors « n.c. ».
- **Coût unitaire** dans un menu = (prix du menu + suppléments) × prix à la carte de l'élément / somme des
  prix à la carte. **Coût marginal** = ce que l'élément coûte en plus si on achetait le reste à la carte.
- **Version maxée valeur** : à chaque étape, l'option qui maximise *prix à la carte − supplément*.
- **Version maxée calories/protéines** : la combinaison qui maximise le ratio kcal/€ (ou g/€), résolue
  exactement par l'algorithme de Dinkelbach.

## Avertissement

Projet perso non officiel, sans aucun lien avec Burger King®. Les prix sont ceux de la commande en
ligne au moment du relevé ; en caisse, en livraison ou avec les coupons de l'appli, ils peuvent différer.
