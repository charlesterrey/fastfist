/* FastFist — moteur de calcul (aucune dépendance au DOM, testable sous Node). */
(function (root) {
  "use strict";

  const SIZE_IDX = { S: 1, M: 2, L: 3, XL: 4 };
  const ROLE_LABEL = {
    plat: "Burgers & plats", poulet: "Poulet (nuggets, tenders…)", accomp: "Accompagnements",
    dessert: "Desserts", boisson: "Boissons", sauce: "Sauces", jouet: "Jouets", autre: "Autres",
    menu: "Menus", enfant: "Menus enfants",
  };
  const FAMILY_ORDER = ["Bon et Pas Cher", "Menus", "Enfants", "Offres du moment"];

  function norm(s) {
    return (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
      .replace(/[®™*.]/g, "").replace(/[^a-z0-9()]+/g, " ").replace(/\s+/g, " ").trim();
  }

  function menuFamily(meta, categories) {
    const c = meta.cats || [];
    if (c.includes("cc-king-deal")) return "Bon et Pas Cher";
    if (meta.kids || c.includes("cc-menusenfants")) return "Enfants";
    if (c.includes("cc-menu")) return "Menus";
    if (c.includes("cc-bonsplans")) return "Offres du moment";
    const named = c.map((k) => (categories[k] || "").trim()).filter((n) => n && n !== "Accueil");
    return named[0] || "Autres";
  }

  /* ------------------------------------------------------------------ modèle */
  function buildModel(catalog, grid) {
    const products = new Map();
    for (const [plu, pr] of Object.entries(grid.p)) {
      const meta = catalog.products[plu];
      if (!meta) continue;
      products.set(plu, {
        plu, n: meta.n, role: meta.role || "autre", img: meta.img || "",
        kcal: meta.kcal ?? null, prot: meta.prot ?? null, pcs: meta.pcs || 0,
        price: pr[0], sup: pr, alone: (meta.cats || []).length > 0, cats: meta.cats || [],
      });
    }
    // prix à la carte : article vendu seul portant le même nom (même resto)
    const aloneByName = new Map();
    for (const p of products.values()) {
      if (!p.alone || p.price <= 0) continue;
      const k = norm(p.n);
      if (!aloneByName.has(k) || aloneByName.get(k) > p.price) aloneByName.set(k, p.price);
    }
    for (const p of products.values()) {
      if (p.alone && p.price > 0) { p.ref = p.price; p.refApprox = false; }
      else if (aloneByName.has(norm(p.n))) { p.ref = aloneByName.get(norm(p.n)); p.refApprox = false; }
      else { p.ref = Math.max(0, p.price); p.refApprox = p.role !== "jouet"; }
      p.burgers = p.role === "plat" ? 1 : 0;
    }

    const menus = [];
    for (const [key, z] of Object.entries(grid.m)) {
      const [mid, size, price, sids] = z;
      const meta = catalog.menus[mid];
      if (!meta || !(meta.cats || []).length) continue; // menu non affiché sur le site
      const steps = [];
      let broken = false;
      for (const sid of sids) {
        const [type, def, ids] = catalog.steps[sid];
        const opts = ids.map((i) => products.get(i)).filter(Boolean);
        if (!opts.length) { if (type !== "TOY" && type !== "GIFT") broken = true; continue; }
        const d = products.get(def) || opts[0];
        steps.push({ type, def: d, opts });
      }
      if (broken || !steps.length) continue;
      menus.push({
        key, mid, n: meta.n, img: meta.img || "", kids: !!meta.kids,
        fam: menuFamily(meta, catalog.categories), size, price, steps,
      });
    }
    const sizeOrder = { S: 0, M: 1, L: 2, XL: 3 };
    menus.sort((a, b) => a.n.localeCompare(b.n, "fr") || sizeOrder[a.size] - sizeOrder[b.size]);
    return { products, menus };
  }

  function supOf(p, size) {
    const v = p.sup[SIZE_IDX[size] || 2] || 0;
    return v >= 50000 ? 0 : v;
  }

  /* --------------------------------------------------------- configuration menu */
  // Choisit une option par étape selon le mode : default | value | kcal | prot | burgers | pcs
  function configure(ms, mode) {
    const size = ms.size;
    const opt = (o) => ({ p: o, sup: supOf(o, size), ref: o.ref || 0, kcal: o.kcal || 0, prot: o.prot || 0 });
    let pick;
    if (mode === "default") {
      pick = ms.steps.map((s) => opt(s.def));
    } else if (mode === "value") {
      pick = ms.steps.map((s) => best(s.opts.map(opt), (x) => (x.p.refApprox && x.ref >= ms.price * 0.75 ? 0 : x.ref) - x.sup, (x) => x.kcal));
    } else if (mode === "burgers" || mode === "pcs") {
      const f = mode === "burgers" ? (x) => x.p.burgers : (x) => x.p.pcs;
      pick = ms.steps.map((s) => best(s.opts.map(opt), (x) => f(x) * 1e6 - x.sup, (x) => x.kcal));
    } else {
      // maximise Σw / (prix + Σsup) — Dinkelbach
      const w = (x) => x[mode];
      const opts = ms.steps.map((s) => s.opts.map(opt));
      pick = opts.map((os) => best(os, (x) => w(x) - 0 * x.sup, (x) => -x.sup));
      for (let it = 0; it < 20; it++) {
        const lam = sum(pick, w) / Math.max(1, ms.price + sum(pick, (x) => x.sup));
        const next = opts.map((os) => best(os, (x) => w(x) - lam * x.sup, (x) => x.ref - x.sup));
        if (next.every((x, i) => x.p === pick[i].p)) break;
        pick = next;
      }
    }
    return summarize(ms, pick, mode);
  }

  function summarize(ms, pick, mode) {
    const paid = ms.price + sum(pick, (x) => x.sup);
    // Un élément non vendu seul dont le prix catalogue dépasse ~le prix du menu (ex. Baby Burgers :
    // chaque mini-burger porte le prix de la boîte) n'a pas de prix à la carte fiable.
    pick = pick.map((x) => x.p.refApprox && x.ref >= ms.price * 0.75 ? { ...x, ref: null } : x);
    const unknown = pick.some((x) => x.ref == null);
    const ref = unknown ? null : sum(pick, (x) => x.ref);
    const kc = sum(pick, (x) => x.kcal);
    const items = pick.map((x, i) => ({
      ...x, step: ms.steps[i],
      alloc: ref > 0 ? (paid * x.ref) / ref : kc > 0 ? (paid * x.kcal) / kc : paid / pick.length,
      marginal: ref == null ? null : paid - (ref - x.ref),
    }));
    return {
      ms, mode, items, paid, ref,
      saving: ref == null ? null : ref - paid,
      savingPct: ref > 0 ? (ref - paid) / ref : null,
      kcal: kc, prot: sum(pick, (x) => x.prot),
      burgers: sum(pick, (x) => x.p.burgers), pcs: sum(pick, (x) => x.p.pcs),
      approx: pick.some((x) => x.p.refApprox), unknown,
    };
  }

  function best(arr, f, tie) {
    let b = arr[0], bv = f(b), bt = tie(b);
    for (let i = 1; i < arr.length; i++) {
      const v = f(arr[i]);
      if (v > bv + 1e-9 || (Math.abs(v - bv) <= 1e-9 && tie(arr[i]) > bt)) { b = arr[i]; bv = v; bt = tie(b); }
    }
    return b;
  }
  function sum(a, f) { let s = 0; for (const x of a) s += f(x); return s; }

  /* ------------------------------------------------------------------ offres */
  // Toutes les offres achetables : produits vendus seuls + menus (configurés selon `mode`)
  function offers(model, mode) {
    const out = [];
    for (const p of model.products.values()) {
      if (!p.alone || p.price <= 0 || p.role === "jouet") continue;
      out.push({
        kind: "product", id: "p" + p.plu, label: p.n, role: p.role, img: p.img, price: p.price,
        kcal: p.kcal || 0, prot: p.prot || 0, value: p.ref, burgers: p.burgers, pcs: p.pcs,
        hasNut: p.kcal != null, product: p,
      });
    }
    for (const ms of model.menus) {
      const cfg = configure(ms, mode === "value" ? "value" : mode);
      out.push({
        kind: "menu", id: "m" + ms.key, label: `${ms.n} (${ms.size})`, role: ms.kids ? "enfant" : "menu",
        img: ms.img, price: cfg.paid, kcal: cfg.kcal, prot: cfg.prot, value: cfg.ref || 0,
        burgers: cfg.burgers, pcs: cfg.pcs, hasNut: true, cfg, fam: ms.fam,
      });
    }
    return out;
  }

  /* ------------------------------------------------------- sac à dos borné */
  // Retourne une fonction solve(budgetCents) / reach(target) basée sur une seule DP.
  function knapsack(items, objective, maxQty, capCents) {
    const vals = items.map((o) => objective === "value" ? o.value : o[objective]);
    const expanded = [];
    items.forEach((o, i) => {
      if (o.price <= 0 || o.price > capCents || !(vals[i] > 0)) return;
      for (let q = 0; q < maxQty; q++) expanded.push(i);
    });
    const B = capCents, n = expanded.length;
    const dp = new Float64Array(B + 1);
    const take = new Uint8Array(n * (B + 1));
    for (let k = 0; k < n; k++) {
      const i = expanded[k], w = items[i].price, v = vals[i] + 1e-7 * (items[i].kcal || 0);
      const base = k * (B + 1);
      for (let c = B; c >= w; c--) {
        const cand = dp[c - w] + v;
        if (cand > dp[c] + 1e-9) { dp[c] = cand; take[base + c] = 1; }
      }
    }
    function pickAt(c) {
      const qty = new Map();
      for (let k = n - 1; k >= 0; k--) {
        if (take[k * (B + 1) + c]) {
          const i = expanded[k];
          qty.set(i, (qty.get(i) || 0) + 1);
          c -= items[i].price;
        }
      }
      return [...qty.entries()].map(([i, q]) => ({ o: items[i], q }));
    }
    function result(c) {
      // plus petit coût atteignant le même optimum
      let cmin = c;
      while (cmin > 0 && dp[cmin - 1] >= dp[c] - 1e-6) cmin--;
      const lines = pickAt(cmin);
      return { lines, ...totals(lines) };
    }
    return {
      budget(cents) { return result(Math.min(B, Math.max(0, Math.floor(cents)))); },
      target(t) {
        for (let c = 0; c <= B; c++) if (dp[c] + 1e-6 >= t) return result(c);
        return null;
      },
    };
  }

  function totals(lines) {
    const t = { price: 0, kcal: 0, prot: 0, value: 0, burgers: 0, pcs: 0, count: 0 };
    for (const { o, q } of lines) {
      t.price += o.price * q; t.kcal += o.kcal * q; t.prot += o.prot * q;
      t.value += o.value * q; t.burgers += o.burgers * q; t.pcs += o.pcs * q; t.count += q;
    }
    return t;
  }

  const api = { buildModel, configure, offers, knapsack, norm, ROLE_LABEL, FAMILY_ORDER, supOf };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Engine = api;
})(typeof window !== "undefined" ? window : globalThis);
