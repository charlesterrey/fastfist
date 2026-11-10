#!/usr/bin/env python3
"""
FastFist — scraper du menu Quick France.

Utilise l'API publique de quick.fr (celle de la commande en ligne) :
  * /api/restaurants                       liste des restos
  * /api/category/v2/<slug>/products       produits vendus seuls (prix par resto)
  * /api/product/menu/ et /menus-enfants/  menus avec étapes, choix, suppléments, tailles M / L
Valeurs nutritionnelles : PDF officiel « Déclaration nutritionnelle » (nécessite `pdftotext`, paquet poppler-utils).

Sortie : data/quick/ (même format que data/bk/).
    python3 scraper/quick.py [--limit N] [--workers N]
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import difflib
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
from collections import defaultdict

from common import ROOT, fetch, fetch_json, norm, num, classify, pieces, write_outputs

SITE = "https://www.quick.fr"
OUT = os.path.join(ROOT, "data", "quick")
SKIP_CATS = {"enCeMoment", "menu", "menus-enfants"}
QUICK_ROLE = {"burgers": "plat", "salades": "plat", "boissons-chaudes": "boisson", "boissons-froides": "boisson",
              "desserts": "dessert", "frites": "accomp", "sauces": "sauce"}


def cents(x) -> int:
    return int(round(float(x) * 100)) if x is not None else 0


def spec(item: dict):
    """(prix, supplément en menu, disponible) d'un produit ou d'un menu, version click & collect."""
    specs = item.get("product_specs") or item.get("menu_specs") or []
    if not specs:
        return None, 0, False
    s = specs[0]
    cc = s.get("clickAndCollectSpecs") or {}
    price = cc.get("priceTTC", s.get("price"))
    sup = cc.get("menuExtraPriceTTC", s.get("menuExtraPriceTTC", 0)) or 0
    ok = s.get("active", True) and s.get("available", True) and cc.get("available", True) is not False
    return price, sup, ok


def step_type(step: dict) -> str:
    n = norm(step.get("name", ""))
    for kw, t in (("burger", "BURGER"), ("salade", "BURGER"), ("accompagnement", "SIDE"), ("boisson", "DRINK"),
                  ("dessert", "SWEET"), ("patisserie", "SWEET"), ("cadeau", "TOY"), ("jouet", "TOY")):
        if kw in n:
            return t
    return {1: "BURGER", 2: "SIDE", 3: "DRINK", 4: "SWEET", 5: "TOY"}.get(step.get("step_type"), "OTHER")


def menu_family(name: str, kids: bool) -> str:
    n = norm(name)
    if kids:
        return "Enfants"
    if re.search(r"\b\d+ ?(e|eur|euros?)\b|formule", n) or "€" in name:
        return "Formules & petits prix"
    return "Menus"


# --------------------------------------------------------------------------- nutrition (PDF)
def scrape_nutrition() -> dict:
    """{nom_normalisé: {kcal, prot}} depuis le PDF officiel. Vide si pdftotext absent."""
    if not shutil.which("pdftotext"):
        print("  ! pdftotext absent (apt install poppler-utils) : pas de valeurs nutritionnelles Quick")
        return {}
    html = fetch(SITE + "/produits/burgers/giant") or ""
    m = re.search(r'https://assets\.quick\.fr/[^"\\]*[Nn]utritionnelle[^"\\]*\.pdf', html)
    if not m:
        print("  ! PDF nutritionnel introuvable")
        return {}
    pdf = fetch(m.group(0), binary=True)
    if not pdf:
        return {}
    with tempfile.TemporaryDirectory() as d:
        src, dst = os.path.join(d, "n.pdf"), os.path.join(d, "n.txt")
        with open(src, "wb") as fh:
            fh.write(pdf)
        subprocess.run(["pdftotext", "-layout", src, dst], check=True)
        text = open(dst, encoding="utf-8", errors="replace").read()
    out = {}
    for line in text.splitlines():
        parts = [p.strip() for p in re.split(r"\s{2,}", line.strip()) if p.strip()]
        if len(parts) < 10 or re.match(r"^[\d\s,.<]+$", parts[0]):
            continue
        name = re.sub(r"\(\*+\)", "", parts[0]).strip()
        vals = [num(p.replace(" ", "")) for p in parts[1:]]
        if sum(v is not None for v in vals[:9]) < 9:
            continue
        # colonnes par portion : poids, kJ, kcal, lipides, AGS, glucides, sucres, protéines, sel, fibres
        out.setdefault(norm(name), {"kcal": vals[2], "prot": vals[7], "_canon": canon(name)})
    print(f"  {len(out)} produits dans la déclaration nutritionnelle")
    return out


FILLER = {"bacon de poulet", "lavazza", "lesieur squeeze", "pre emballe", "100 gr", "with coca cola"}
SYNONYMS = [(r"\bcoca cola sans sucres?\b", "coca zero"), (r"\bcoca cola cherry zero sucres?\b", "coca cherry sans sucre"),
            (r"\bfuzetea\b", "fuze tea"), (r"\bdouble cheese$", "double cheeseburger"), (r"^giant$", "giant original"),
            (r"\bsupplement\b", ""), (r"\bnappage\b", ""), (r"\bcheessy\b", "cheesy"), (r"\btrois\b", "trio"),
            (r"\bfrappe caramel espresso\b", "frappe caramel expresso"), (r"\bqreative cheesy donut\b", "qreative cheesy"),
            (r"\bkitkat\b", "kit kat"), (r"\bpane de raclette\b", "supl raclette")]
DROP = {"cup", "dosette", "accompagnement", "cannette", "eau", "plate", "petillante", "boisson", "de", "la", "le", "les", "au", "et", "a"}


def canon(name: str) -> tuple[frozenset, frozenset]:
    """(mots significatifs, tailles/quantités) d'un nom de produit, pour rapprocher boutique et PDF."""
    n = norm(name)
    for f in FILLER:
        n = n.replace(f, " ")
    for pat, rep in SYNONYMS:
        n = re.sub(pat, rep, n)
    qty = set(re.findall(r"\b(\d+) ?cl\b", n))
    qty |= {"x" + q for q in re.findall(r"\(par (\d+)\)", n) + re.findall(r"\bx ?(\d+)\b", n)}
    n = re.sub(r"\(par \d+\)|\bx ?\d+\b|\b\d+ ?cl\b|[()]", " ", n)
    words = {w.rstrip("s") if len(w) > 3 else w for w in n.split() if w not in DROP}
    return frozenset(words), frozenset(qty)


def match_nutrition(name: str, table: dict):
    w, q = canon(name)
    best, best_score = None, 0.0
    for key, val in table.items():
        kw, kq = val["_canon"]
        if q != kq:  # tailles / nombre de pièces doivent correspondre exactement
            continue
        inter = len(w & kw)
        if not inter:
            continue
        score = inter / len(w | kw)
        if w <= kw or kw <= w:
            score += 0.3
        if score > best_score:
            best, best_score = val, score
    return best if best_score >= 0.75 else None


# --------------------------------------------------------------------------- restos
def fetch_restaurant(fr: str, cat_slugs: list):
    alone = {}
    for slug in cat_slugs:
        items = fetch_json(f"{SITE}/api/category/v2/{slug}/products?restaurant={fr}")
        if not isinstance(items, list):
            continue
        for it in items:
            alone.setdefault(str(it["id"]), (it, set()))[1].add(slug)
    menus = []
    for path, kids in (("menu", False), ("menus-enfants", True)):
        d = fetch_json(f"{SITE}/api/product/{path}/?restaurant={fr}")
        if not d:
            continue
        d = d.get("data", d)
        for m in (d.get("products", []) if isinstance(d, dict) else d):
            menus.append((m, kids or bool(m.get("kids_menu"))))
    return alone, menus


def process(alone: dict, menus: list, shared: dict, step_ids: dict):
    prices, mgrid = {}, {}

    def add_product(it: dict, cats=(), st=None):
        pid = str(it["id"])
        price, sup, ok = spec(it)
        if not ok or price is None:
            return False
        if pid not in prices:
            s = cents(sup)
            prices[pid] = [cents(price), s, s, s, s]
        meta = shared["products"].setdefault(pid, {"n": it.get("name", pid).strip(), "r": it.get("slug", ""),
                                                   "img": it.get("image", ""), "cats": [], "st": []})
        meta["cats"] = sorted(set(meta["cats"]) | set(cats))
        if st:
            meta["st"] = sorted(set(meta["st"]) | {st})
        return True

    for it, cats in alone.values():
        add_product(it, cats)

    def steps_of(steps):
        sids = []
        for s in steps or []:
            t = step_type(s)
            ids = [str(p["id"]) for p in s.get("products", []) if add_product(p, st=t)]
            if not ids:
                continue
            d = str(s.get("defaultId") or ids[0])
            key = json.dumps([t, d if d in ids else ids[0], ids], ensure_ascii=False)
            if key not in step_ids:
                step_ids[key] = len(step_ids)
            sids.append(step_ids[key])
        return sids

    for m, kids in menus:
        mid = str(m["id"])
        price, _, ok = spec(m)
        if not ok:
            continue
        cc = ((m.get("menu_specs") or [{}])[0].get("clickAndCollectSpecs") or {})
        by_size = cc.get("priceBySize") or {"M": price}
        name = m.get("name", mid).strip()
        shared["menus"].setdefault(mid, {"n": name, "img": m.get("image", ""), "kids": kids,
                                         "cats": ["menus-enfants" if kids else "menu"], "fam": menu_family(name, kids)})
        if by_size.get("M") is not None:
            mgrid[f"{mid}-M"] = [mid, "M", cents(by_size["M"]), steps_of(m.get("steps"))]
        if by_size.get("L") is not None and (m.get("xlSteps") or by_size["L"] != by_size.get("M")):
            mgrid[f"{mid}-L"] = [mid, "L", cents(by_size["L"]), steps_of(m.get("xlSteps") or m.get("steps"))]
    return {"p": prices, "m": mgrid}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--workers", type=int, default=8)
    args = ap.parse_args()

    print("→ Quick : liste des restaurants")
    rs = (fetch_json(f"{SITE}/api/restaurants?pagination[limit]=-1") or {}).get("data", [])
    rs = [r["attributes"] for r in rs if r.get("attributes", {}).get("fr")]
    if args.limit:
        rs = rs[: args.limit]
    cats = [c["slug"] for c in (fetch_json(f"{SITE}/api/category/v2") or []) if c.get("slug") not in SKIP_CATS]
    print(f"  {len(rs)} restaurants, catégories : {', '.join(cats)}")

    shared = {"products": {}, "menus": {}, "categories": {c: c.replace("-", " ").capitalize() for c in cats}}
    step_ids: dict[str, int] = {}
    restaurants, grids = [], {}
    with cf.ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(fetch_restaurant, r["fr"], cats): r for r in rs}
        for i, fut in enumerate(cf.as_completed(futs), 1):
            r = futs[fut]
            if i % 25 == 0:
                print(f"  {i}/{len(rs)}")
            alone, menus = fut.result()
            if not alone and not menus:
                continue
            grid = process(alone, menus, shared, step_ids)
            if not grid["p"]:
                continue
            body = json.dumps(grid, sort_keys=True, separators=(",", ":"))
            h = hashlib.sha1(body.encode()).hexdigest()[:10]
            grids[h] = body
            restaurants.append({
                "id": r["fr"], "name": r.get("name", r["fr"]).strip(),
                "address": " ".join(x for x in (r.get("address1"), r.get("address2"), r.get("postalCode"), r.get("city")) if x),
                "cp": r.get("postalCode", ""), "city": (r.get("city") or "").title(),
                "lat": r.get("lat"), "lng": r.get("lng"), "url": r.get("slug", ""),
                "status": r.get("status", ""), "grid": h,
            })

    print("→ Quick : nutrition")
    table = scrape_nutrition()
    for pid, meta in shared["products"].items():
        nut = match_nutrition(meta["n"], table)
        if nut:
            meta["kcal"], meta["prot"] = nut["kcal"], nut["prot"]
        if re.search(r"volvic|badoit|\beau\b", norm(meta["n"])):
            meta["kcal"], meta["prot"] = 0.0, 0.0
        role = next((QUICK_ROLE[c] for c in meta["cats"] if c in QUICK_ROLE), None)
        meta["role"] = role or classify(meta["n"], set(meta["cats"]), set(meta["st"]))
        if role == "plat" and re.search(r"petite salade|tomatoes|carotte|kiri", norm(meta["n"])):
            meta["role"] = "accomp"
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
