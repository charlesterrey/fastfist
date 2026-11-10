"""Code partagé par les scrapers FastFist (HTTP, normalisation, classification, écriture des données)."""
from __future__ import annotations

import gzip
import json
import os
import re
import statistics
import sys
import time
import urllib.error
import urllib.request
import zlib
from collections import defaultdict
from datetime import datetime, timezone

UA = "Mozilla/5.0 (X11; Linux x86_64) FastFist/1.0 (+menu price comparator)"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAX_PRICE = 50000  # au-delà : prix "bidon" (ex. 99999) => produit ignoré


# --------------------------------------------------------------------------- HTTP
def fetch(url: str, retries: int = 4, binary: bool = False):
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Encoding": "gzip"})
            with urllib.request.urlopen(req, timeout=30) as r:
                raw = r.read()
                enc = (r.headers.get("Content-Encoding") or "").lower()
            if enc == "gzip" or raw[:2] == b"\x1f\x8b":
                raw = gzip.decompress(raw)
            elif enc == "deflate":
                raw = zlib.decompress(raw)
            return raw if binary else raw.decode("utf-8")
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            last = e
        except Exception as e:  # réseau
            last = e
        time.sleep(1.5 * (2 ** attempt))
    print(f"  ! échec {url}: {last}", file=sys.stderr)
    return None


def fetch_json(url: str):
    t = fetch(url)
    return json.loads(t) if t else None


def num(s):
    if s is None:
        return None
    s = str(s).replace(",", ".").strip()
    if s.startswith("<"):
        return 0.0
    try:
        return float(s)
    except ValueError:
        return None


# --------------------------------------------------------------------------- classification
def norm(s: str) -> str:
    s = s.lower()
    for a, b in (("é", "e"), ("è", "e"), ("ê", "e"), ("à", "a"), ("ô", "o"), ("ï", "i"), ("û", "u"), ("ü", "u"), ("ö", "o")):
        s = s.replace(a, b)
    s = re.sub(r"[®™*]", "", s)
    s = re.sub(r"[^a-z0-9()]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


DRINK_CATS = ("cafes", "thes", "coca", "sprite", "fanta", "fuzetea", "oasis", "vittel", "red-bull")
DESSERT_CATS = ("king-fusion", "king-sundae", "patisserie", "ice-burger")


def classify(name: str, cats: set, steps: set) -> str:
    n = norm(name)
    if "order-n2-sauces" in cats or n.startswith("sauce") or "pack de 6 sauces" in n:
        return "sauce"
    if steps & {"TOY", "GIFT"} or n in ("rien du tout", "bonbons", "sucre"):
        return "jouet"
    if "DRINK" in steps or any(any(dc in c for dc in DRINK_CATS) for c in cats) or re.search(r"\(\d+ ?cl\)", n) or n.startswith(("the ", "cafe", "expresso", "double expresso", "nectar")):
        return "boisson"
    if re.search(r"nugget|tender|kingbox|chicken dips|wings|quickbox", n):
        return "poulet"
    if re.search(r"frites?\b|fries|rustique|onion rings|chili cheese|cheesy donut|carotte|petite salade", n):
        return "accomp"
    if "SWEET" in steps or any(any(dc in c for dc in DESSERT_CATS) for c in cats) or re.search(r"sundae|fusion|muffin|donut|cookie|pom ?potes|yaourt|ice burger|pommes a croquer|crousty sucre", n):
        return "dessert"
    if "BURGER" in steps or cats & {"cc-burger", "order-n2-petits-burgers", "order-n2-king-tortillas", "order-n2-king-wraps", "n2-cbk", "cc-salades"} or re.search(r"burger|whopper|king|wrap|tortilla|bowl|master|steakhouse|cbk|chicken|fish|cheese", n):
        return "plat"
    return "autre"


def pieces(name: str):
    n = norm(name)
    nums = [int(a or b) for a, b in re.findall(r"\(\s*(\d+)\s*\)|x\s*(\d+)\b", n)]
    if "kingbox" in n:
        tot = sum(int(x) for x in re.findall(r"\b(\d+)\b", n))
        return tot or None
    if re.search(r"nugget|tender|onion rings|chili cheese|dips|wings|cheesy donut", n) and nums:
        return nums[0]
    return None


# --------------------------------------------------------------------------- écriture
def write_outputs(out: str, restaurants: list, grids: dict, shared: dict, steps: list):
    """Écrit restaurants.json, catalog.json, stats.json et prices/<hash>.json dans `out`."""
    os.makedirs(os.path.join(out, "prices"), exist_ok=True)
    # --- stats France (par produit et par taille de menu)
    rest_by_grid = defaultdict(list)
    for r in restaurants:
        rest_by_grid[r["grid"]].append(r["id"])
    pvals, mvals = defaultdict(list), defaultdict(list)
    for h, body in grids.items():
        g = json.loads(body)
        n = len(rest_by_grid[h])
        for plu, pr in g["p"].items():
            pvals[plu] += [(pr[0], rid) for rid in rest_by_grid[h]]
        for zplu, z in g["m"].items():
            mvals[zplu] += [(z[2], rid) for rid in rest_by_grid[h]]

    def summarize(vals):
        vs = sorted(vals)
        prices = [v for v, _ in vs]
        cheapest = [rid for v, rid in vs if v == prices[0]][:10]
        return {"min": prices[0], "med": statistics.median(prices), "max": prices[-1], "n": len(prices), "cheap": cheapest}

    stats = {
        "p": {k: summarize(v) for k, v in pvals.items() if v},
        "m": {k: summarize(v) for k, v in mvals.items() if v},
    }

    # --- indice de prix par resto (100 = médiane France) sur les produits vendus seuls et présents partout
    common = [plu for plu, st in stats["p"].items()
              if st["n"] >= 0.9 * len(restaurants) and shared["products"].get(plu, {}).get("cats")]
    idx_by_grid = {}
    for h, body in grids.items():
        g = json.loads(body)
        ratios = [g["p"][plu][0] / stats["p"][plu]["med"] for plu in common if plu in g["p"] and stats["p"][plu]["med"]]
        idx_by_grid[h] = round(100 * sum(ratios) / len(ratios), 1) if ratios else None
    for r in restaurants:
        r["idx"] = idx_by_grid.get(r["grid"])

    # --- écriture
    for f in os.listdir(os.path.join(out, "prices")):
        if f.endswith(".json") and f[:-5] not in grids:
            os.remove(os.path.join(out, "prices", f))
    for h, body in grids.items():
        with open(os.path.join(out, "prices", h + ".json"), "w", encoding="utf-8") as fh:
            fh.write(body)

    restaurants.sort(key=lambda r: (r["city"], r["name"]))
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    def dump(name, obj):
        with open(os.path.join(out, name), "w", encoding="utf-8") as fh:
            json.dump(obj, fh, ensure_ascii=False, separators=(",", ":"), sort_keys=True)

    dump("restaurants.json", {"updated": now, "restaurants": restaurants})
    dump("catalog.json", {"updated": now, "products": shared["products"], "menus": shared["menus"],
                          "categories": shared["categories"], "steps": steps})
    dump("stats.json", {"updated": now, **stats})
    print(f"✓ {len(restaurants)} restos, {len(grids)} grilles de prix distinctes, "
          f"{len(shared['products'])} produits, {len(shared['menus'])} menus, {len(steps)} étapes")
