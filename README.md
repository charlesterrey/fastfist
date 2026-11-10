# ✊🍔 FastFist — Gratte les fast-foods

Page HTML qui récupère **le menu complet de Burger King et de Quick France, resto par resto**, et calcule
les meilleures façons d'avoir un repas qui cale pour pas cher.

| Chaîne | Restos | Source |
|---|---|---|
| 👑 Burger King | ~635 | catalogue public de la commande en ligne + fiches nutrition du site |
| ⚡ Quick | 200 | API publique de quick.fr + déclaration nutritionnelle (PDF) |
| McDonald's, KFC | — | non inclus : leurs sites bloquent la récupération automatique (captcha / anti-bot) |

## Le site

**https://charlesterrey.github.io/fastfist/** : site statique (HTML + JS vanilla, aucune dépendance), clair / sombre, pensé mobile d'abord.

| Page | Contenu |
|---|---|
| 🏆 **Bons plans** | Le resto en un coup d'œil : « avec 5 / 10 / 15 €, tu manges… » (optimum exact), les 8 meilleurs plans (ce qui cale le plus, burger le moins cher, prix par burger en menu, plus grosse économie, protéines, poulet, menus enfant / adulte les moins chers), top calories par euro, menus qui font économiser, produits à moins de 3 €. |
| 🍟 **Menus** | Tous les menus en cartes (familles, recherche, tri), en composition par défaut ou « maxée » (valeur, calories, protéines). La fiche d'un menu montre **le coût unitaire de chaque élément**, le coût marginal et la répartition du prix, et permet de **changer chaque choix** (tout se recalcule, suppléments compris), de changer de taille et de comparer au reste de la France. |
| 🧾 **Carte** | Tous les produits seuls : prix, écart à la médiane France, kcal, €/1000 kcal, protéines, €/pièce. La fiche produit montre **son vrai prix dans chaque menu** et les restos où il est le moins cher. |
| 💶 **Budget** | Optimiseur en direct : un budget, ou un objectif (kcal, protéines, burgers, pièces, valeur), donne la commande optimale. Catégories autorisées, quantité max par article, commande copiable. |
| ⚔️ **Duel** | Ton resto face au resto le plus proche de l'autre chaîne, sur 9 critères, avec un score. |
| 🇫🇷 **France** | Indice de prix de chaque resto, classements, les moins chers autour de toi (géolocalisation). |

Chaque page, resto et fiche a son propre lien (partageable). Raccourcis : `/` pour changer de resto, `Échap` pour fermer un panneau.

## Données

Un scraper par chaîne (Python 3, aucune dépendance ; `pdftotext` pour la nutrition Quick) :

- `scraper/bk.py` : liste des restos BK (store-locator), catalogue complet de chaque resto (prix seuls, menus
  par taille, étapes et choix, suppléments), valeurs nutritionnelles depuis les pages `/carte`.
- `scraper/quick.py` : liste des restos Quick, produits par catégorie et menus (M / L, enfants) avec
  suppléments via l'API de quick.fr, nutrition depuis la déclaration nutritionnelle officielle.
- `scraper/common.py` : HTTP, classification des produits, statistiques et écriture.

Chaque scraper écrit dans `data/<chaîne>/` (`bk`, `quick`) :

```
restaurants.json     liste des restos + indice de prix + clé de leur grille de prix
catalog.json         produits (nom, rôle, kcal, protéines, pièces), menus, étapes de menus
prices/<hash>.json   grille de prix d'un resto (produits + menus)
stats.json           min / médiane / max France par produit et par menu
```

Une GitHub Action (`.github/workflows/scrape.yml`) relance le scrape tous les jours et commit les
nouveaux prix.

## Lancer en local

```bash
python3 scraper/bk.py              # ~3-4 min pour tous les restos BK (--limit 20 pour tester)
python3 scraper/quick.py           # ~3 min pour Quick (apt install poppler-utils pour la nutrition)
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

Projet perso non officiel, sans aucun lien avec Burger King® ni Quick®. Les prix sont ceux de la commande en
ligne au moment du relevé ; en caisse, en livraison ou avec les coupons de l'appli, ils peuvent différer.
