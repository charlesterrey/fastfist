#!/usr/bin/env python3
"""
FastFist — scraper du menu Burger King France.

Récupère, pour chaque restaurant BK France :
  * la fiche restaurant (nom, adresse, coordonnées) via l'API publique du store-locator,
  * le catalogue complet avec prix (produits seuls, menus M/L/XL, menus enfants,
    Bon et Pas Cher, offres…) depuis le stockage public utilisé par burgerking.fr,
et, une fois pour toute la France :
  * les valeurs nutritionnelles (kcal, protéines) depuis les pages /carte du site.

Sortie (dossier data/bk/) :
  restaurants.json     liste des restos + clé du fichier de prix
  catalog.json         métadonnées partagées (produits, menus, étapes de menus, catégories)
  prices/<hash>.json   grille de prix d'un ou plusieurs restos (dédupliquée)
  stats.json           min / médiane / max France par produit et par menu

Aucune dépendance externe : python3 scraper/bk.py [--limit N] [--workers N]
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import hashlib
import json
import os
import re
from collections import defaultdict

from common import ROOT, MAX_PRICE, fetch, fetch_json, norm, num, classify, pieces, write_outputs

SITE = "https://www.burgerking.fr"
API = "https://webapi.burgerking.fr/blossom/api/v13"
STORAGE = "https://ecoceabkstorageprdnorth.blob.core.windows.net"
OUT = os.path.join(ROOT, "data", "bk")


# --------------------------------------------------------------------------- nutrition
def rsc_payload(html: str) -> str:
    """Concatène les chunks RSC (self.__next_f.push) d'une page Next.js."""
    parts = []
    for m in re.finditer(r'self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)', html):
        try:
            parts.append(json.loads('"' + m.group(1) + '"'))
        except json.JSONDecodeError:
            pass
    return "".join(parts)


def enclosing_object(t: str, pos: int):
    """Position de l'accolade ouvrante de l'objet JSON qui contient `pos`."""
    depth = 0
    i = pos
    while i > 0:
        i -= 1
        c = t[i]
        if c == "}":
            depth += 1
        elif c == "{":
            if depth == 0:
                return i
            depth -= 1
    return None


def scrape_nutrition() -> tuple[dict, dict, dict]:
    """Retourne ({plu: {kcal, prot}}, {routeId: …}, {nom_normalisé: …})."""
    print("→ nutrition : pages /carte")
    home = fetch(SITE + "/carte") or ""
    slugs = sorted(set(re.findall(r'/carte/([a-z0-9-]+)(?=["\\/?])', home)))
    pages = [SITE + "/carte"] + [f"{SITE}/carte/{s}" for s in slugs]
    by_plu, by_route, by_name = {}, {}, {}
    for url in pages:
        html = fetch(url)
        if not html:
            continue
        t = rsc_payload(html)
        dec = json.JSONDecoder()
        for m in re.finditer(r'"nutrition":\[', t):
            start = enclosing_object(t, m.start())
            if start is None:
                continue
            try:
                obj, _ = dec.raw_decode(t, start)
            except json.JSONDecodeError:
                continue
            if "/img/menu/" in str(obj.get("image", "")) or "content" in obj:
                continue  # fiche d'un menu complet, pas d'un produit
            nut = {x.get("item", "").rsplit(".", 1)[-1]: num(x.get("portion")) for x in obj.get("nutrition", []) if isinstance(x, dict)}
            if nut.get("energy") is None:
                continue
            val = {"kcal": nut["energy"], "prot": nut.get("protein")}
            if obj.get("plu"):
                by_plu.setdefault(str(obj["plu"]), val)
            if obj.get("routeId"):
                by_route.setdefault(obj["routeId"], val)
            if obj.get("name"):
                by_name.setdefault(norm(obj["name"]), val)
    print(f"  {len(by_plu)} produits avec valeurs nutritionnelles")
    return by_plu, by_route, by_name


# --------------------------------------------------------------------------- catalogue
def walk_categories(cat: dict):
    """Ensemble des produits / menus réellement visibles (rattachés à une catégorie)."""
    prod_cats, menu_cats = defaultdict(set), defaultdict(set)
    for c in cat.get("categories", []):
        for it in c.get("items", []):
            if it.get("type") == "PRODUCT":
                prod_cats[it["key"]].add(c["code"])
            elif it.get("type") == "MENU":
                menu_cats[it["key"]].add(c["code"])
    return prod_cats, menu_cats


def process(rid: str, cat: dict, shared: dict, step_ids: dict):
    """Met à jour les métadonnées partagées et renvoie la grille de prix compacte du resto."""
    prod_cats, menu_cats = walk_categories(cat)
    P, M = cat.get("products", {}), cat.get("menus", {})

    step_types = defaultdict(set)
    for m in M.values():
        for z in m.get("sizes", {}).values():
            for s in z.get("steps", []):
                for pid in s.get("productIds", []):
                    step_types[pid].add(s.get("stepType", "NONE"))

    prices = {}
    for plu, p in P.items():
        pr = p.get("prices") or {}
        alone = pr.get("alone") or 0
        if alone >= MAX_PRICE or not p.get("active", True):
            continue
        prices[plu] = [alone, pr.get("s", 0), pr.get("m", 0), pr.get("l", 0), pr.get("xl", 0)]
        meta = shared["products"].setdefault(plu, {
            "n": p.get("name", plu).strip(),
            "r": p.get("routeId", ""),
            "img": p.get("image", ""),
            "cats": [], "st": [],
        })
        meta["cats"] = sorted(set(meta["cats"]) | prod_cats.get(plu, set()))
        meta["st"] = sorted(set(meta["st"]) | step_types.get(plu, set()))

    menus = {}
    for mid, m in M.items():
        if not m.get("active", True):
            continue
        meta = shared["menus"].setdefault(mid, {
            "n": m.get("name", mid).strip(),
            "img": m.get("image", ""),
            "kids": bool(m.get("kidsMenu")),
            "cats": [],
        })
        meta["cats"] = sorted(set(meta["cats"]) | menu_cats.get(mid, set()))
        for zplu, z in m.get("sizes", {}).items():
            price = z.get("price")
            if price is None or price >= MAX_PRICE:
                continue
            sids = []
            for s in z.get("steps", []):
                key = json.dumps([s.get("stepType", "NONE"), s.get("defaultId"), s.get("productIds", [])], ensure_ascii=False)
                if key not in step_ids:
                    step_ids[key] = len(step_ids)
                sids.append(step_ids[key])
            menus[zplu] = [mid, z.get("size", "M"), price, sids]

    for c in cat.get("categories", []):
        shared["categories"].setdefault(c["code"], c.get("name", c["code"]).strip())

    return {"v": cat.get("version"), "p": prices, "m": menus}


# --------------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="ne traiter que N restos (debug)")
    ap.add_argument("--workers", type=int, default=12)
    args = ap.parse_args()

    print("→ liste des restaurants")
    sl = fetch_json(API + "/public/store-locator")
    markers = sl["markers"]
    if args.limit:
        markers = markers[: args.limit]
    print(f"  {len(markers)} restaurants")

    def one(mk):
        rid = mk["id"]
        info = fetch_json(f"{API}/public/store-locator/{rid}") or {}
        cat = fetch_json(f"{STORAGE}/catalog/catalog.{rid}.V2.json")
        return mk, info, cat

    shared = {"products": {}, "menus": {}, "categories": {}}
    step_ids: dict[str, int] = {}
    restaurants, grids = [], {}
    done = 0
    with cf.ThreadPoolExecutor(max_workers=args.workers) as ex:
        for mk, info, cat in ex.map(one, markers):
            done += 1
            if done % 50 == 0:
                print(f"  {done}/{len(markers)}")
            if not cat or not cat.get("products"):
                continue
            grid = process(mk["id"], cat, shared, step_ids)
            body = json.dumps({"p": grid["p"], "m": grid["m"]}, sort_keys=True, separators=(",", ":"))
            h = hashlib.sha1(body.encode()).hexdigest()[:10]
            grids[h] = body
            addr = info.get("addressFull", "")
            cps = list(re.finditer(r"\b(\d{5})\b", addr))
            cp_code = cps[-1].group(1) if cps else ""
            city = addr[cps[-1].end():].strip(" -,").title() if cps else ""
            restaurants.append({
                "id": mk["id"],
                "name": (info.get("name") or mk["id"]).strip(),
                "address": addr,
                "cp": cp_code,
                "city": city,
                "lat": mk.get("lat"), "lng": mk.get("lng"),
                "url": info.get("pageUrl", ""),
                "status": info.get("statusType", ""),
                "grid": h,
            })

    # --- nutrition & enrichissement des métadonnées
    by_plu, by_route, by_name = scrape_nutrition()
    for plu, meta in shared["products"].items():
        nut = by_plu.get(plu) or by_route.get(meta["r"]) or by_name.get(norm(meta["n"]))
        if nut and re.search(r"pom ?potes|yaourt|carotte|pommes a croquer", norm(meta["n"])) and nut["kcal"] > 300:
            nut = None  # fiche BK manifestement erronée (ex. compote à 1107 kcal)
        if nut:
            meta["kcal"] = nut["kcal"]
            meta["prot"] = nut["prot"]
        if re.search(r"vittel|perrier|\beau\b", norm(meta["n"])):
            meta["kcal"], meta["prot"] = 0.0, 0.0  # eau : la fiche BK de la Perrier est erronée (210 kcal)
        meta["role"] = classify(meta["n"], set(meta["cats"]), set(meta["st"]))
        pc = pieces(meta["n"])
        if pc:
            meta["pcs"] = pc
        del meta["st"]

    steps = [None] * len(step_ids)
    for k, i in step_ids.items():
        steps[i] = json.loads(k)
    write_outputs(OUT, restaurants, grids, shared, steps)


if __name__ == "__main__":
    main()
