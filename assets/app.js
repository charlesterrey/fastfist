/* FastFist — application (vanilla JS, aucune dépendance). */
(function () {
  "use strict";
  const E = window.Engine;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  const CHAINS = [
    { id: "bk", name: "Burger King", short: "BK" },
    { id: "quick", name: "Quick", short: "QUICK" },
  ];
  const ROUTES = ["plans", "menus", "carte", "budget", "duel", "france", "methode", "plus"];
  const STEP_LABEL = { BURGER: "Plat", SIDE: "Accompagnement", DRINK: "Boisson", SWEET: "Dessert", TOY: "Jouet", GIFT: "Cadeau", OTHER: "Bonus", NONE: "Élément" };
  const ROLE_ICON = { plat: "🍔", poulet: "🍗", accomp: "🍟", dessert: "🍦", boisson: "🥤", sauce: "🫙", jouet: "🧸", autre: "🍽️", menu: "🍱", enfant: "🧒" };
  const FOOD = (o) => !["boisson", "sauce", "jouet"].includes(o.role);

  /* ------------------------------------------------------------ état */
  const UI_DEFAULT = {
    menuMode: "value", menuSort: "saving", menuFam: "", menuQ: "",
    carteRole: "", carteSort: "kcal", carteQ: "",
    obj: "kcal", mode: "budget", budget: 1000, target: 2000, maxQty: 2,
    roles: ["menu", "enfant", "plat", "poulet", "accomp", "dessert", "autre"], heroBudget: 1000,
  };
  const S = {
    chain: "bk", data: {}, values: {}, grids: {}, resto: null, model: null, cache: {},
    route: "plans", userPos: null, detail: null, lastOrder: null, ui: { ...UI_DEFAULT, ...load("ff-ui", {}) },
  };

  function load(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (_) { return d; } }
  function store(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* stockage indisponible */ } }
  const saveUI = () => store("ff-ui", S.ui);

  /* ------------------------------------------------------------ formatage */
  const eur = (c) => c == null || !isFinite(c) ? "—" : (c / 100).toLocaleString("fr-FR", { style: "currency", currency: "EUR" });
  const n0 = (x) => x == null || !isFinite(x) ? "—" : Math.round(x).toLocaleString("fr-FR");
  const n1 = (x) => x == null || !isFinite(x) ? "—" : (+x).toLocaleString("fr-FR", { maximumFractionDigits: 1 });
  const pct = (x) => x == null || !isFinite(x) ? "—" : Math.round(x * 100).toLocaleString("fr-FR") + " %";
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const per1000 = (price, kcal) => kcal > 0 ? (price * 1000) / kcal : Infinity;
  const per10g = (price, prot) => prot > 0 ? (price * 10) / prot : Infinity;
  const chainOf = (id) => CHAINS.find((c) => c.id === id) || { id, name: id, short: id };
  const plural = (n, s, p) => `${n0(n)} ${n > 1 ? (p || s + "s") : s}`;

  function img(u, cls = "thumb", icon = "🍔") {
    if (!u) return `<span class="${cls} ph" aria-hidden="true">${icon}</span>`;
    const src = u.includes("medias.burgerking.fr") ? u + "?w=160&org_if_sml=1" : u;
    return `<img class="${cls}" loading="lazy" decoding="async" alt="" src="${esc(src)}" data-fallback="${icon}">`;
  }
  // image cassée → pictogramme
  document.addEventListener("error", (e) => {
    const t = e.target;
    if (t.tagName === "IMG" && t.dataset.fallback) {
      const s = document.createElement("span");
      s.className = t.className + " ph"; s.textContent = t.dataset.fallback; s.setAttribute("aria-hidden", "true");
      t.replaceWith(s);
    }
  }, true);

  /* ------------------------------------------------------------ données */
  async function getJSON(u) {
    const r = await fetch(u);
    if (!r.ok) throw new Error(`${u} (${r.status})`);
    return r.json();
  }
  function loadChain(id) {
    if (!S.data[id]) {
      S.data[id] = (async () => {
        const b = `data/${id}/`;
        const [rs, cat, st] = await Promise.all([getJSON(b + "restaurants.json"), getJSON(b + "catalog.json"), getJSON(b + "stats.json")]);
        rs.restaurants.forEach((r) => (r.chain = id));
        return (S.values[id] = { restaurants: rs.restaurants, catalog: cat, stats: st, updated: rs.updated });
      })();
      S.data[id].catch(() => { delete S.data[id]; });
    }
    return S.data[id];
  }
  function loadGrid(chain, r) {
    const k = chain + "/" + r.grid;
    return (S.grids[k] ||= getJSON(`data/${chain}/prices/${r.grid}.json`));
  }
  const D = () => S.values[S.chain];

  const memo = (k, fn) => (k in S.cache ? S.cache[k] : (S.cache[k] = fn()));
  const offers = (mode) => memo("off:" + mode, () => E.offers(S.model, mode).filter((o) => o.price > 0));
  const cfgs = (mode) => memo("cfg:" + mode, () => S.model.menus.map((ms) => E.configure(ms, mode)));
  const products = () => memo("prods", () => [...S.model.products.values()].filter((p) => p.alone && p.price > 0 && p.role !== "jouet"));

  /* ------------------------------------------------------------ géo */
  function dist(a, b) {
    const R = 6371, k = Math.PI / 180, dLa = (b.lat - a.lat) * k, dLo = (b.lng - a.lng) * k;
    const h = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * k) * Math.cos(b.lat * k) * Math.sin(dLo / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  const nearestIn = (list, pos, k) => list.filter((r) => r.lat != null).map((r) => ({ r, d: dist(pos, r) })).sort((a, b) => a.d - b.d).slice(0, k);
  const kmTxt = (d) => d < 1 ? `${Math.round(d * 1000)} m` : `${n1(d)} km`;

  /* ------------------------------------------------------------ toast */
  let toastT;
  function toast(msg) {
    const t = $("#toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 2200);
  }

  /* ------------------------------------------------------------ navigation */
  function parseHash() {
    const h = location.hash.replace(/^#\/?/, "");
    const [path, qs] = h.split("?");
    return { route: ROUTES.includes(path) ? path : "plans", q: new URLSearchParams(qs || "") };
  }
  function syncHash() {
    if (!S.resto) return;
    const q = new URLSearchParams({ c: S.chain, r: S.resto.id });
    if (S.detail?.kind === "menu") q.set("m", S.detail.key);
    if (S.detail?.kind === "product") q.set("p", S.detail.plu);
    history.replaceState(null, "", `#/${S.route}?${q}`);
  }
  async function onHash() {
    const { route, q } = parseHash();
    const c = q.get("c"), r = q.get("r");
    if (c && CHAINS.some((x) => x.id === c) && (c !== S.chain || (r && r !== S.resto?.id))) {
      try { await setResto(c, r, { silent: true }); } catch (_) { /* on garde le resto actuel */ }
    }
    closeSheets(true);
    S.route = route;
    render();
    window.scrollTo({ top: 0 });
    if (q.get("m")) openMenu(q.get("m"));
    else if (q.get("p")) openProduct(q.get("p"));
  }

  /* ------------------------------------------------------------ resto */
  async function setResto(chain, id, { silent } = {}) {
    const d = await loadChain(chain);
    let r = d.restaurants.find((x) => x.id === id);
    if (!r) {
      const prev = S.resto;
      r = d.restaurants.find((x) => x.id === load("ff-resto-" + chain, null))
        || (prev && prev.lat != null && nearestIn(d.restaurants, prev, 1)[0]?.r)
        || d.restaurants.find((x) => /^paris/i.test(x.city)) || d.restaurants[0];
    }
    const grid = await loadGrid(chain, r);
    S.chain = chain; S.resto = r; S.model = E.buildModel(d.catalog, grid); S.cache = {}; S.lastOrder = null;
    store("ff-chain", chain); store("ff-resto-" + chain, r.id);
    updateChip();
    if (!silent) { closeSheets(true); render(); toast(`${chainOf(chain).name} ${r.name} sélectionné`); }
  }

  function updateChip() {
    const r = S.resto, d = D();
    $("#chip-chain").textContent = chainOf(S.chain).short;
    $("#chip-name").textContent = r.name;
    $("#chip-sub").textContent = [r.cp, r.city].filter(Boolean).join(" ") + (r.idx ? ` · indice ${n1(r.idx)}` : "");
    $("#updated").textContent = `Prix ${chainOf(S.chain).name} relevés le ${new Date(d.updated).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" })}.`;
    document.title = `FastFist — ${chainOf(S.chain).name} ${r.name}`;
  }

  /* ------------------------------------------------------------ rendu */
  const after = {};
  function render() {
    const alias = ["carte", "france", "methode"].includes(S.route) ? "plus" : S.route;
    $$(".nav [data-route]").forEach((a) => a.classList.toggle("active", a.dataset.route === S.route));
    $$(".tabbar [data-route]").forEach((a) => a.classList.toggle("active", a.dataset.route === alias));
    const view = $("#view");
    const fn = { plans: viewPlans, menus: viewMenus, carte: viewCarte, budget: viewBudget, duel: viewDuel, france: viewFrance, methode: viewMethode, plus: viewPlus }[S.route];
    view.innerHTML = fn();
    view.style.animation = "none"; void view.offsetWidth; view.style.animation = "";
    after[S.route]?.();
    syncHash();
  }

  /* ================================================================ BONS PLANS */
  function bestPlans() {
    return memo("plans", () => {
      const all = offers("kcal"), food = all.filter(FOOD);
      const plans = [];
      const kcal = food.filter((o) => o.kcal > 0).sort((a, b) => per1000(a.price, a.kcal) - per1000(b.price, b.kcal))[0];
      if (kcal) plans.push({ icon: "🔥", tag: "Ce qui cale le plus", value: eur(per1000(kcal.price, kcal.kcal)), unit: "/ 1000 kcal", o: kcal, sub: `${eur(kcal.price)} · ${n0(kcal.kcal)} kcal` });
      const burger = products().filter((p) => p.role === "plat").sort((a, b) => a.price - b.price)[0];
      if (burger) plans.push({ icon: "🍔", tag: "Burger le moins cher", value: eur(burger.price), unit: "", p: burger, sub: `${n0(burger.kcal)} kcal · ${eur(per1000(burger.price, burger.kcal))} / 1000 kcal` });
      const perB = cfgs("burgers").filter((c) => c.burgers >= 1).map((c) => ({ c, v: c.paid / c.burgers })).sort((a, b) => a.v - b.v)[0];
      if (perB) plans.push({ icon: "🍔🍔", tag: "Burger le moins cher en menu", value: eur(perB.v), unit: "/ burger", c: perB.c, sub: `${plural(perB.c.burgers, "burger")} + le reste pour ${eur(perB.c.paid)}` });
      const save = cfgs("value").filter((c) => c.ref > 0 && !c.approx && !c.ms.kids).sort((a, b) => b.savingPct - a.savingPct)[0];
      if (save) plans.push({ icon: "💸", tag: "Plus grosse économie", value: "−" + pct(save.savingPct), unit: "vs à la carte", c: save, sub: `${eur(save.paid)} au lieu de ${eur(save.ref)}` });
      const prot = all.filter((o) => o.prot > 0 && o.role !== "sauce").sort((a, b) => per10g(a.price, a.prot) - per10g(b.price, b.prot))[0];
      if (prot) plans.push({ icon: "💪", tag: "Protéines les moins chères", value: eur(per10g(prot.price, prot.prot)), unit: "/ 10 g", o: prot, sub: `${n0(prot.prot)} g pour ${eur(prot.price)}` });
      const piece = all.filter((o) => o.pcs > 0 && o.role === "poulet").sort((a, b) => a.price / a.pcs - b.price / b.pcs)[0];
      if (piece) plans.push({ icon: "🍗", tag: "Pièce de poulet la moins chère", value: eur(piece.price / piece.pcs), unit: "/ pièce", o: piece, sub: `${piece.pcs} pièces pour ${eur(piece.price)}` });
      const kids = cfgs("kcal").filter((c) => c.ms.kids).sort((a, b) => a.paid - b.paid)[0];
      if (kids) plans.push({ icon: "🧒", tag: "Menu enfant le moins cher", value: eur(kids.paid), unit: "", c: kids, sub: `${n0(kids.kcal)} kcal · ${eur(per1000(kids.paid, kids.kcal))} / 1000 kcal` });
      const cheapMenu = cfgs("default").filter((c) => !c.ms.kids).sort((a, b) => a.paid - b.paid)[0];
      if (cheapMenu) plans.push({ icon: "🪙", tag: "Menu adulte le moins cher", value: eur(cheapMenu.paid), unit: "", c: cheapMenu, sub: `${n0(cheapMenu.kcal)} kcal` });
      return plans;
    });
  }

  function offerAction(o, mode) {
    return o.cfg ? `data-action="menu" data-key="${esc(o.cfg.ms.key)}" data-mode="${esc(mode || o.cfg.mode)}"` : `data-action="product" data-plu="${esc(o.product.plu)}"`;
  }
  function planAction(pl) {
    if (pl.c) return `data-action="menu" data-key="${esc(pl.c.ms.key)}" data-mode="${esc(pl.c.mode)}"`;
    if (pl.p) return `data-action="product" data-plu="${esc(pl.p.plu)}"`;
    return offerAction(pl.o);
  }
  const planLabel = (pl) => pl.c ? `${pl.c.ms.n} (${pl.c.ms.size})` : pl.p ? pl.p.n : pl.o.label;

  function heroBudget(cents) {
    return memo("hero:" + cents, () => {
      const food = offers("kcal").filter((o) => FOOD(o) && o.role !== "dessert");
      return E.knapsack(food, "kcal", 2, cents).budget(cents);
    });
  }

  function viewPlans() {
    const r = S.resto, m = S.model, d = D();
    const plans = bestPlans();
    const b = heroBudget(S.ui.heroBudget);
    const idxTxt = r.idx == null ? "" : r.idx <= 100 ? `${n1(100 - r.idx)} % moins cher que la médiane` : `${n1(r.idx - 100)} % plus cher que la médiane`;
    const top = offers("kcal").filter((o) => FOOD(o) && o.kcal > 0).map((o) => ({ o, v: per1000(o.price, o.kcal) })).sort((a, b) => a.v - b.v).slice(0, 8);
    const savers = cfgs("value").filter((c) => c.ref > 0 && !c.approx).sort((a, b) => b.savingPct - a.savingPct).slice(0, 5);
    const small = products().filter((p) => p.price <= 300 && p.kcal > 0 && FOOD(p)).sort((a, b) => b.kcal - a.kcal).slice(0, 6);
    return `
    <section class="hero">
      <div class="hero-grid">
        <div>
          <div class="eyebrow" style="color:#ffe3d3">${esc(chainOf(S.chain).name)} · ${esc(r.name)}</div>
          <h1>Le max de bouffe,<br>le min d'euros.</h1>
          <p>On a décortiqué ${plural(products().length, "produit")} et ${plural(m.menus.length, "formule")} de ce resto pour trouver ce qui cale vraiment pour pas cher.</p>
          <div class="hero-meta">
            ${idxTxt ? `<span class="hero-pill">${r.idx <= 100 ? "📉" : "📈"} ${idxTxt}</span>` : ""}
            <span class="hero-pill">🕒 Prix du ${new Date(d.updated).toLocaleDateString("fr-FR", { day: "numeric", month: "short" })}</span>
          </div>
        </div>
        <div class="budget-box">
          <h3>Avec ce budget, tu manges…</h3>
          <div class="budget-chips" role="group" aria-label="Budget">
            ${[500, 700, 1000, 1200, 1500, 2000].map((c) => `<button type="button" data-action="hero-budget" data-c="${c}" class="${c === S.ui.heroBudget ? "on" : ""}" aria-pressed="${c === S.ui.heroBudget}">${c / 100} €</button>`).join("")}
          </div>
          ${b && b.lines.length ? `<div class="budget-result">
            <div class="budget-big tnum">${n0(b.kcal)} <small>kcal pour ${eur(b.price)}</small></div>
            <ul class="budget-lines">${b.lines.map(({ o, q }) => `<li><span>${q}× ${esc(o.label)}</span><span class="tnum">${eur(o.price * q)}</span></li>`).join("")}</ul>
          </div>` : `<p>Rien sous ce budget ici.</p>`}
          <a class="budget-cta" href="#/budget">Ajuster dans l'optimiseur →</a>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="section-head"><h2>Les meilleurs plans ici</h2><a href="#/menus">Tous les menus →</a></div>
      <div class="grid grid-4">
        ${plans.map((pl) => `<article class="card click plan" ${planAction(pl)} tabindex="0" role="button">
          <div class="plan-tag"><span class="ico">${pl.icon}</span>${esc(pl.tag)}</div>
          <div>
            <div class="plan-value tnum">${pl.value} <small>${esc(pl.unit)}</small></div>
            <div class="plan-what">${esc(planLabel(pl))}</div>
            <div class="plan-sub">${esc(pl.sub)}</div>
          </div>
          <div class="plan-foot"><span class="muted">Voir le détail</span><span aria-hidden="true">→</span></div>
        </article>`).join("")}
      </div>
    </section>

    <div class="two section">
      <section>
        <div class="section-head"><h2>Top calories par euro</h2><a href="#/carte">Toute la carte →</a></div>
        <div class="card rows">
          ${top.map(({ o, v }) => `<div class="row click" ${offerAction(o, "kcal")} tabindex="0" role="button">
            ${img(o.img, "thumb", ROLE_ICON[o.role])}
            <div style="min-width:0"><div class="row-title">${esc(o.label)}</div><div class="row-sub">${n0(o.kcal)} kcal · ${eur(o.price)}</div>
              <div class="meter"><i style="width:${Math.max(8, (100 * top[0].v) / v).toFixed(0)}%"></i></div></div>
            <div class="row-end"><b>${eur(v)}</b><div class="row-sub">/ 1000 kcal</div></div>
          </div>`).join("")}
        </div>
      </section>
      <section>
        <div class="section-head"><h2>Les menus qui font économiser</h2></div>
        <div class="card rows">
          ${savers.map((c) => `<div class="row click" data-action="menu" data-key="${esc(c.ms.key)}" data-mode="value" tabindex="0" role="button">
            ${img(c.ms.img, "thumb", "🍱")}
            <div style="min-width:0"><div class="row-title">${esc(c.ms.n)} <span class="badge">${c.ms.size}</span></div><div class="row-sub">${eur(c.paid)} au lieu de ${eur(c.ref)}</div>
              <div class="meter good"><i style="width:${(100 * c.savingPct).toFixed(0)}%"></i></div></div>
            <div class="row-end"><b class="good">−${pct(c.savingPct)}</b><div class="row-sub">${eur(c.saving)} gagnés</div></div>
          </div>`).join("")}
        </div>
        ${small.length ? `<div class="section-head" style="margin-top:26px"><h2>À moins de 3 €</h2></div>
        <div class="card rows">${small.map((p) => `<div class="row click" data-action="product" data-plu="${esc(p.plu)}" tabindex="0" role="button">
            ${img(p.img, "thumb", ROLE_ICON[p.role])}
            <div style="min-width:0"><div class="row-title">${esc(p.n)}</div><div class="row-sub">${n0(p.kcal)} kcal · ${eur(per1000(p.price, p.kcal))} / 1000 kcal</div></div>
            <div class="row-end"><b>${eur(p.price)}</b></div></div>`).join("")}</div>` : ""}
      </section>
    </div>`;
  }

  /* ================================================================ MENUS */
  const SHORT_MODE = { default: "Défaut", value: "Valeur", kcal: "Calories", prot: "Protéines" };
  const MODES = [["default", "Par défaut"], ["value", "Maxé valeur"], ["kcal", "Maxé calories"], ["prot", "Maxé protéines"]];
  const MENU_SORTS = {
    saving: ["Plus grosse économie", (c) => -(c.savingPct ?? -9)], price: ["Prix croissant", (c) => c.paid],
    kcal: ["€ / 1000 kcal", (c) => per1000(c.paid, c.kcal)], cal: ["Le plus de calories", (c) => -c.kcal],
    burger: ["Plat le moins cher en menu", (c) => mainItem(c)?.alloc ?? 1e9],
  };
  function mainItem(c) { return c.items.find((x) => x.step.type === "BURGER") || c.items.find((x) => x.p.role === "plat") || c.items[0]; }

  function menuGroups(mode) {
    const groups = new Map();
    for (const c of cfgs(mode)) {
      if (!groups.has(c.ms.mid)) groups.set(c.ms.mid, []);
      groups.get(c.ms.mid).push(c);
    }
    return [...groups.values()];
  }

  function viewMenus() {
    const u = S.ui, q = E.norm(u.menuQ);
    const groups = menuGroups(u.menuMode);
    const fams = {};
    groups.forEach((g) => (fams[g[0].ms.fam] = (fams[g[0].ms.fam] || 0) + 1));
    const famList = Object.keys(fams).sort((a, b) => { const ia = E.FAMILY_ORDER.indexOf(a), ib = E.FAMILY_ORDER.indexOf(b); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b, "fr"); });
    if (u.menuFam && !fams[u.menuFam]) u.menuFam = "";
    const key = MENU_SORTS[u.menuSort] ? u.menuSort : "saving";
    const f = MENU_SORTS[key][1];
    const shown = groups.filter((g) => (!u.menuFam || g[0].ms.fam === u.menuFam) && (!q || E.norm(g[0].ms.n).includes(q)))
      .map((g) => ({ g, rep: [...g].sort((a, b) => f(a) - f(b))[0] }))
      .sort((a, b) => f(a.rep) - f(b.rep));
    return `
    <div class="page-head">
      <div><div class="eyebrow">${plural(S.model.menus.length, "formule")} · ${esc(S.resto.name)}</div><h1>Menus décortiqués</h1>
      <p>Ce que tu paies, ce que ça vaudrait à la carte, et le vrai prix de chaque élément. Ouvre un menu pour changer les choix : tout se recalcule.</p></div>
      <div class="seg" role="group" aria-label="Composition">${MODES.map(([k, l]) => `<button type="button" data-action="menu-mode" data-v="${k}" class="${u.menuMode === k ? "on" : ""}" aria-pressed="${u.menuMode === k}">${l}</button>`).join("")}</div>
    </div>
    <div class="toolbar">
      <input type="search" id="menu-q" placeholder="Chercher un menu…" value="${esc(u.menuQ)}" aria-label="Chercher un menu">
      <select id="menu-sort" aria-label="Trier">${Object.entries(MENU_SORTS).map(([k, [l]]) => `<option value="${k}" ${k === key ? "selected" : ""}>${l}</option>`).join("")}</select>
    </div>
    <div class="chips" role="group" aria-label="Familles" style="margin-bottom:16px">
      <button type="button" class="chip ${!u.menuFam ? "on" : ""}" data-action="menu-fam" data-v="">Tout<span class="count">${groups.length}</span></button>
      ${famList.map((fa) => `<button type="button" class="chip ${u.menuFam === fa ? "on" : ""}" data-action="menu-fam" data-v="${esc(fa)}">${esc(fa)}<span class="count">${fams[fa]}</span></button>`).join("")}
    </div>
    ${shown.length ? `<div class="grid grid-3">${shown.map(({ g, rep: c }) => {
      const main = mainItem(c);
      return `<article class="card click mcard" data-action="menu" data-key="${esc(c.ms.key)}" data-mode="${esc(u.menuMode)}" tabindex="0" role="button">
        ${img(c.ms.img, "thumb", c.ms.kids ? "🧒" : "🍱")}
        <div style="min-width:0">
          <div class="mcard-top"><div class="mcard-name">${esc(c.ms.n)}</div><div class="mcard-price tnum">${eur(c.paid)}</div></div>
          <div class="mcard-items">${c.items.filter((x) => x.p.role !== "jouet").map((x) => esc(x.p.n) + (x.sup > 0 ? ` <b class="bad">+${eur(x.sup)}</b>` : "")).join(" · ")}</div>
          <div class="mcard-stats">
            ${c.savingPct != null ? `<span class="badge ${c.saving > 0 ? "good" : "bad"}">${c.saving > 0 ? "−" : "+"}${pct(Math.abs(c.savingPct))} vs carte</span>` : `<span class="badge">éco. n.c.</span>`}
            <span class="badge">${n0(c.kcal)} kcal</span>
            ${main && main.p.role === "plat" ? `<span class="badge accent" title="Coût unitaire du plat dans ce menu">plat ${eur(main.alloc)}</span>` : ""}
            <span class="sizes" title="Tailles disponibles">${g.map((x) => `<span>${x.ms.size}</span>`).join("")}</span>
          </div>
        </div>
      </article>`;
    }).join("")}</div>` : `<div class="empty card"><b>Aucun menu trouvé</b>Essaie un autre mot ou une autre famille.</div>`}`;
  }
  after.menus = () => {
    $("#menu-q").addEventListener("input", debounce((e) => { S.ui.menuQ = e.target.value; saveUI(); rerenderKeepFocus("#menu-q"); }, 180));
    $("#menu-sort").addEventListener("change", (e) => { S.ui.menuSort = e.target.value; saveUI(); render(); });
  };

  /* ---------- fiche menu */
  function openMenu(key, mode) {
    const ms = S.model.menus.find((m) => m.key === key);
    if (!ms) return;
    const m = mode && mode !== "custom" ? mode : (S.detail?.kind === "menu" && S.detail.mid === ms.mid && S.detail.mode !== "custom" ? S.detail.mode : S.ui.menuMode);
    S.detail = { kind: "menu", key, mid: ms.mid, mode: m, chosen: E.configure(ms, m).items.map((x) => x.p) };
    renderMenuDetail();
    showSheet("detail");
    syncHash();
  }

  function renderMenuDetail() {
    const dt = S.detail, ms = S.model.menus.find((m) => m.key === dt.key);
    const c = E.custom(ms, dt.chosen);
    const sizes = S.model.menus.filter((m) => m.mid === ms.mid);
    const st = D().stats.m[ms.key];
    const main = mainItem(c);
    const total = c.items.reduce((s, x) => s + x.alloc, 0) || 1;
    const cheapName = st ? D().restaurants.find((r) => r.id === st.cheap[0])?.name : "";
    $("#detail-content").innerHTML = `
      <header class="sheet-head" style="padding-bottom:0"><span class="badge accent">${esc(ms.fam)}</span><button class="icon-btn" data-close type="button" aria-label="Fermer">✕</button></header>
      <div class="detail-hero">${img(ms.img, "thumb lg", ms.kids ? "🧒" : "🍱")}
        <div style="min-width:0"><h2 id="detail-title">${esc(ms.n)}</h2>
          ${sizes.length > 1 ? `<div class="seg" style="margin-top:10px" role="group" aria-label="Taille">${sizes.map((x) => `<button type="button" data-action="detail-size" data-key="${esc(x.key)}" class="${x.key === ms.key ? "on" : ""}">${x.size} · ${eur(x.price)}</button>`).join("")}</div>`
          : `<div class="muted" style="margin-top:4px">Taille ${ms.size} · ${eur(ms.price)}</div>`}
        </div>
      </div>
      <div class="sheet-body">
        <div class="seg seg-full" style="margin-top:8px" role="group" aria-label="Composition">
          ${MODES.map(([k, l]) => `<button type="button" data-action="detail-mode" data-v="${k}" class="${dt.mode === k ? "on" : ""}" title="${esc(l)}">${esc(SHORT_MODE[k])}</button>`).join("")}
          ${dt.mode === "custom" ? `<button type="button" class="on" disabled>Perso</button>` : ""}
        </div>

        <div class="kpis" style="margin-top:14px">
          <div class="kpi accent"><b>${eur(c.paid)}</b><span>tu paies${c.paid !== ms.price ? ` (dont ${eur(c.paid - ms.price)} suppl.)` : ""}</span></div>
          <div class="kpi"><b>${c.ref == null ? "n.c." : eur(c.ref)}</b><span>à la carte</span></div>
          <div class="kpi ${c.saving > 0 ? "good" : ""}"><b>${c.saving == null ? "—" : (c.saving >= 0 ? "−" : "+") + pct(Math.abs(c.savingPct))}</b><span>${c.saving == null ? "économie" : c.saving >= 0 ? `${eur(c.saving)} économisés` : `${eur(-c.saving)} perdus`}</span></div>
          <div class="kpi"><b>${n0(c.kcal)}</b><span>kcal · ${eur(per1000(c.paid, c.kcal))} / 1000</span></div>
        </div>

        <div class="detail-section">
          <h3>Où partent tes ${eur(c.paid)}</h3>
          <div class="stack" role="img" aria-label="Répartition du prix entre les éléments">${c.items.map((x) => `<i class="t-${x.step.type}" style="flex:${Math.max(0.02, x.alloc / total)}" title="${esc(x.p.n)} : ${eur(x.alloc)}"></i>`).join("")}</div>
          <div class="legend">${c.items.map((x) => `<span><i class="t-${x.step.type}"></i>${esc(STEP_LABEL[x.step.type] || x.step.type)} ${eur(x.alloc)}</span>`).join("")}</div>
        </div>

        ${main && main.ref ? `<div class="callout ${main.alloc < main.ref ? "good" : ""}" style="margin-top:16px">
          🍔 Dans ce menu, ton <b>${esc(main.p.n)}</b> te revient à <b>${eur(main.alloc)}</b> contre <b>${eur(main.ref)}</b> seul.
          ${main.marginal != null ? (main.marginal <= 0 ? " Si tu achetais le reste à la carte, il serait carrément <b>offert</b>." : ` Si tu achetais le reste à la carte, il ne te coûterait que <b>${eur(main.marginal)}</b> de plus.`) : ""}
        </div>` : ""}
        ${c.unknown ? `<div class="callout warn" style="margin-top:10px">Certains éléments ne sont pas vendus seuls : l'économie n'est pas calculable, et le coût unitaire est réparti selon les calories.</div>` : ""}

        <div class="detail-section">
          <h3>Élément par élément</h3>
          ${c.items.map((x, i) => {
            const opts = [...x.step.opts].sort((a, b) => (b.ref - E.supOf(b, ms.size)) - (a.ref - E.supOf(a, ms.size)));
            return `<div class="item-row">
              <span class="bar t-${x.step.type}"></span>${img(x.p.img, "thumb", ROLE_ICON[x.p.role])}
              <div style="min-width:0">
                <div class="row-title">${esc(x.p.n)}${x.sup > 0 ? ` <span class="badge bad">+${eur(x.sup)}</span>` : x.sup < 0 ? ` <span class="badge good">${eur(x.sup)}</span>` : ""}</div>
                <div class="row-sub">${esc(STEP_LABEL[x.step.type] || "")} · ${x.ref == null ? "non vendu seul" : `seul ${eur(x.ref)}${x.p.refApprox ? " ≈" : ""}`} · ${x.p.kcal != null ? n0(x.p.kcal) + " kcal" : "kcal n.c."}</div>
                ${opts.length > 1 ? `<select data-step="${i}" aria-label="Changer : ${esc(STEP_LABEL[x.step.type] || "élément")}">${opts.map((o) => {
                  const sp = E.supOf(o, ms.size);
                  return `<option value="${esc(o.plu)}" ${o === x.p ? "selected" : ""}>${esc(o.n)}${sp ? ` (${sp > 0 ? "+" : ""}${eur(sp)})` : ""}${o.kcal != null ? ` · ${n0(o.kcal)} kcal` : ""}</option>`;
                }).join("")}</select>` : ""}
              </div>
              <div class="item-cost"><b>${eur(x.alloc)}</b><span class="muted">coût unitaire</span>${x.marginal != null ? `<span class="muted">marginal ${eur(x.marginal)}</span>` : ""}</div>
            </div>`;
          }).join("")}
        </div>

        ${st ? `<div class="detail-section"><h3>Ce menu ailleurs en France</h3>
          <div class="kpis"><div class="kpi good"><b>${eur(st.min)}</b><span>le moins cher${cheapName ? ` (${esc(cheapName)})` : ""}</span></div>
          <div class="kpi"><b>${eur(st.med)}</b><span>prix médian</span></div><div class="kpi"><b>${eur(st.max)}</b><span>le plus cher</span></div></div></div>` : ""}
        <p class="muted small" style="margin-top:18px">Coût unitaire = prix payé réparti au prorata des prix à la carte. Coût marginal = ce que l'élément coûte en plus si tu achetais tout le reste à la carte.</p>
      </div>`;
    $$("#detail-content select[data-step]").forEach((sel) => sel.addEventListener("change", () => {
      const i = +sel.dataset.step, p = S.model.products.get(sel.value);
      S.detail.chosen = [...S.detail.chosen]; S.detail.chosen[i] = p; S.detail.mode = "custom";
      const scroll = $("#detail .sheet-body").scrollTop;
      renderMenuDetail();
      $("#detail .sheet-body").scrollTop = scroll;
    }));
  }

  /* ================================================================ CARTE */
  const CARTE_SORTS = {
    kcal: ["€ / 1000 kcal", (p) => per1000(p.price, p.kcal)], price: ["Prix croissant", (p) => p.price],
    prot: ["€ / 10 g de protéines", (p) => per10g(p.price, p.prot)],
    fr: ["Meilleur prix vs France", (p) => (D().stats.p[p.plu] ? p.price / D().stats.p[p.plu].med : 9)],
    cal: ["Le plus de calories", (p) => -(p.kcal ?? -1)],
  };
  function viewCarte() {
    const u = S.ui, q = E.norm(u.carteQ), all = products();
    const roles = {};
    all.forEach((p) => (roles[p.role] = (roles[p.role] || 0) + 1));
    if (u.carteRole && !roles[u.carteRole]) u.carteRole = "";
    const key = CARTE_SORTS[u.carteSort] ? u.carteSort : "kcal";
    const list = all.filter((p) => (!u.carteRole || p.role === u.carteRole) && (!q || E.norm(p.n).includes(q)))
      .sort((a, b) => CARTE_SORTS[key][1](a) - CARTE_SORTS[key][1](b));
    const st = D().stats.p;
    return `
    <div class="page-head"><div><div class="eyebrow">${plural(all.length, "produit")} vendus seuls · ${esc(S.resto.name)}</div><h1>La carte</h1>
      <p>Chaque produit avec son prix, son écart à la médiane France et ce qu'il rapporte en calories et en protéines par euro.</p></div></div>
    <div class="toolbar">
      <input type="search" id="carte-q" placeholder="Chercher un produit…" value="${esc(u.carteQ)}" aria-label="Chercher un produit">
      <select id="carte-sort" aria-label="Trier">${Object.entries(CARTE_SORTS).map(([k, [l]]) => `<option value="${k}" ${k === key ? "selected" : ""}>${l}</option>`).join("")}</select>
    </div>
    <div class="chips" style="margin-bottom:16px" role="group" aria-label="Catégories">
      <button type="button" class="chip ${!u.carteRole ? "on" : ""}" data-action="carte-role" data-v="">Tout<span class="count">${all.length}</span></button>
      ${Object.keys(roles).sort((a, b) => roles[b] - roles[a]).map((r) => `<button type="button" class="chip ${u.carteRole === r ? "on" : ""}" data-action="carte-role" data-v="${r}">${ROLE_ICON[r] || ""} ${esc(E.ROLE_LABEL[r] || r)}<span class="count">${roles[r]}</span></button>`).join("")}
    </div>
    ${list.length ? `<div class="card rows">${list.map((p) => {
      const s = st[p.plu], diff = s ? p.price / s.med - 1 : null;
      const metric = key === "prot" ? `<b>${eur(per10g(p.price, p.prot))}</b><div class="row-sub">/ 10 g prot.</div>` : `<b>${eur(per1000(p.price, p.kcal))}</b><div class="row-sub">/ 1000 kcal</div>`;
      return `<div class="row click" data-action="product" data-plu="${esc(p.plu)}" tabindex="0" role="button">
        ${img(p.img, "thumb", ROLE_ICON[p.role])}
        <div style="min-width:0"><div class="row-title">${esc(p.n)} <b class="tnum" style="margin-left:4px">${eur(p.price)}</b>
          ${diff != null && Math.abs(diff) > 0.02 ? ` <span class="badge ${diff > 0 ? "bad" : "good"}">${diff > 0 ? "+" : "−"}${pct(Math.abs(diff))} vs France</span>` : ""}</div>
          <div class="row-sub">${p.kcal != null ? n0(p.kcal) + " kcal" : "kcal n.c."}${p.prot != null ? ` · ${n1(p.prot)} g prot.` : ""}${p.pcs ? ` · ${p.pcs} pièces (${eur(p.price / p.pcs)} / pièce)` : ""}</div></div>
        <div class="row-end">${metric}</div>
      </div>`;
    }).join("")}</div>` : `<div class="empty card"><b>Aucun produit trouvé</b>Essaie un autre mot ou une autre catégorie.</div>`}`;
  }
  after.carte = () => {
    $("#carte-q").addEventListener("input", debounce((e) => { S.ui.carteQ = e.target.value; saveUI(); rerenderKeepFocus("#carte-q"); }, 180));
    $("#carte-sort").addEventListener("change", (e) => { S.ui.carteSort = e.target.value; saveUI(); render(); });
  };

  /* ---------- fiche produit */
  function openProduct(plu) {
    const p = S.model.products.get(plu);
    if (!p) return;
    S.detail = { kind: "product", plu };
    const st = D().stats.p[plu], R = D().restaurants;
    const inMenus = [];
    for (const ms of S.model.menus) {
      const i = ms.steps.findIndex((s) => s.opts.includes(p));
      if (i < 0) continue;
      const chosen = E.configure(ms, "value").items.map((x) => x.p);
      chosen[i] = p;
      const c = E.custom(ms, chosen);
      inMenus.push({ c, it: c.items[i] });
    }
    inMenus.sort((a, b) => a.it.alloc - b.it.alloc);
    const cheapest = st ? st.cheap.slice(0, 5).map((id) => R.find((r) => r.id === id)).filter(Boolean) : [];
    $("#detail-content").innerHTML = `
      <header class="sheet-head" style="padding-bottom:0"><span class="badge accent">${ROLE_ICON[p.role] || ""} ${esc(E.ROLE_LABEL[p.role] || p.role)}</span><button class="icon-btn" data-close type="button" aria-label="Fermer">✕</button></header>
      <div class="detail-hero">${img(p.img, "thumb lg", ROLE_ICON[p.role])}<div style="min-width:0"><h2 id="detail-title">${esc(p.n)}</h2><div class="muted" style="margin-top:4px">${esc(chainOf(S.chain).name)} ${esc(S.resto.name)}</div></div></div>
      <div class="sheet-body">
        <div class="kpis">
          <div class="kpi accent"><b>${eur(p.price)}</b><span>prix seul</span></div>
          <div class="kpi"><b>${n0(p.kcal)}</b><span>kcal · ${eur(per1000(p.price, p.kcal))} / 1000</span></div>
          <div class="kpi"><b>${p.prot != null ? n1(p.prot) + " g" : "—"}</b><span>protéines · ${eur(per10g(p.price, p.prot))} / 10 g</span></div>
          ${p.pcs ? `<div class="kpi"><b>${eur(p.price / p.pcs)}</b><span>par pièce (${p.pcs})</span></div>` : ""}
        </div>
        ${inMenus.length ? `<div class="detail-section"><h3>Son vrai prix dans les menus</h3>
          <div class="card rows">${inMenus.slice(0, 8).map(({ c, it }) => `<div class="row click" data-action="menu-from-product" data-key="${esc(c.ms.key)}" data-plu="${esc(p.plu)}" tabindex="0" role="button">
            ${img(c.ms.img, "thumb", "🍱")}<div style="min-width:0"><div class="row-title">${esc(c.ms.n)} <span class="badge">${c.ms.size}</span></div><div class="row-sub">menu à ${eur(c.paid)}</div></div>
            <div class="row-end"><b class="${it.alloc < p.price ? "good" : ""}">${eur(it.alloc)}</b><div class="row-sub">${it.alloc < p.price ? "−" + pct(1 - it.alloc / p.price) : "&nbsp;"}</div></div></div>`).join("")}</div></div>` : ""}
        ${st ? `<div class="detail-section"><h3>Ce produit ailleurs en France</h3>
          <div class="kpis"><div class="kpi good"><b>${eur(st.min)}</b><span>le moins cher</span></div><div class="kpi"><b>${eur(st.med)}</b><span>prix médian</span></div><div class="kpi"><b>${eur(st.max)}</b><span>le plus cher</span></div></div>
          ${cheapest.length ? `<p class="small muted" style="margin:12px 0 6px">Au prix le plus bas chez :</p><div class="chips" style="flex-wrap:wrap">${cheapest.map((r) => `<button type="button" class="chip" data-action="goto-resto" data-chain="${S.chain}" data-id="${esc(r.id)}">📍 ${esc(r.name)}</button>`).join("")}</div>` : ""}
        </div>` : ""}
      </div>`;
    showSheet("detail");
    syncHash();
  }

  /* ================================================================ BUDGET */
  const OBJ = { kcal: ["🔥", "Calories", " kcal"], prot: ["💪", "Protéines", " g de protéines"], burgers: ["🍔", "Burgers", " burgers"], pcs: ["🍗", "Pièces", " pièces"], value: ["💸", "Valeur carte", ""] };
  const ROLE_TOGGLES = [["menu", "Menus"], ["enfant", "Menus enfants"], ["plat", "Burgers"], ["poulet", "Poulet"], ["accomp", "Frites & co"], ["dessert", "Desserts"], ["boisson", "Boissons"], ["sauce", "Sauces"], ["autre", "Autres"]];
  const TARGETS = { kcal: [500, 6000, 50, 2000], prot: [20, 300, 5, 100], burgers: [1, 15, 1, 3], pcs: [4, 80, 1, 20], value: [500, 6000, 50, 2000] };
  const fmtTarget = (v) => S.ui.obj === "value" ? eur(v) : n0(v) + OBJ[S.ui.obj][2];

  function clampTarget() {
    const [a, b, , def] = TARGETS[S.ui.obj];
    if (S.ui.target < a || S.ui.target > b) S.ui.target = def;
  }
  function viewBudget() {
    const u = S.ui;
    clampTarget();
    const [tMin, tMax, tStep] = TARGETS[u.obj];
    return `
    <div class="page-head"><div><div class="eyebrow">Optimiseur · ${esc(S.resto.name)}</div><h1>Ta commande parfaite</h1>
      <p>Donne un budget (ou un objectif) : on calcule la combinaison exacte de produits et de menus qui maximise ce que tu veux, au centime près.</p></div></div>
    <div class="optim">
      <div class="card card-pad optim-controls">
        <div class="seg seg-full" role="group" aria-label="Mode">
          <button type="button" data-action="opt-mode" data-v="budget" class="${u.mode === "budget" ? "on" : ""}">J'ai un budget</button>
          <button type="button" data-action="opt-mode" data-v="target" class="${u.mode === "target" ? "on" : ""}">J'ai un objectif</button>
        </div>
        ${u.mode === "budget"
          ? `<div><div class="field-label"><label for="o-budget">Budget</label><output id="o-budget-out">${eur(u.budget)}</output></div>
            <input type="range" id="o-budget" min="200" max="4000" step="10" value="${u.budget}"></div>`
          : `<div><div class="field-label"><label for="o-target">Objectif</label><output id="o-target-out">${fmtTarget(u.target)}</output></div>
            <input type="range" id="o-target" min="${tMin}" max="${tMax}" step="${tStep}" value="${u.target}"></div>`}
        <div><div class="field-label"><span>${u.mode === "budget" ? "Maximiser" : "Atteindre au moins"}</span></div>
          <div class="toggles">${Object.entries(OBJ).map(([k, [i, l]]) => `<button type="button" class="chip ${u.obj === k ? "on" : ""}" data-action="opt-obj" data-v="${k}" aria-pressed="${u.obj === k}">${i} ${l}</button>`).join("")}</div></div>
        <div><div class="field-label"><span>Max par article</span></div>
          <div class="stepper"><button type="button" data-action="opt-qty" data-v="-1" aria-label="Moins">−</button><span id="o-qty" aria-live="polite">${u.maxQty}</span><button type="button" data-action="opt-qty" data-v="1" aria-label="Plus">+</button></div></div>
        <div><div class="field-label"><span>Autorisés</span></div>
          <div class="toggles">${ROLE_TOGGLES.map(([k, l]) => `<button type="button" class="chip ${u.roles.includes(k) ? "on" : ""}" data-action="opt-role" data-v="${k}" aria-pressed="${u.roles.includes(k)}">${l}</button>`).join("")}</div></div>
      </div>
      <div class="card card-pad" id="optim-result" aria-live="polite"></div>
    </div>`;
  }
  function runOptim() {
    const u = S.ui, box = $("#optim-result");
    if (!box) return;
    const roles = [...u.roles].sort();
    const cap = u.mode === "budget" ? u.budget : 6000;
    const t0 = performance.now();
    const items = offers(u.obj === "value" ? "value" : u.obj).filter((o) => roles.includes(o.role));
    const ks = memo(`ks:${u.obj}:${u.maxQty}:${roles}:${cap}`, () => E.knapsack(items, u.obj, u.maxQty, cap));
    const res = u.mode === "budget" ? ks.budget(u.budget) : ks.target(u.target);
    const ms = Math.round(performance.now() - t0);
    if (!res || !res.lines.length) {
      box.innerHTML = `<div class="empty"><b>${u.mode === "budget" ? "Rien dans ce budget" : "Objectif impossible sous 60 €"}</b>${u.mode === "budget" ? "Augmente le budget" : "Baisse l'objectif"} ou autorise plus de catégories.</div>`;
      S.lastOrder = null;
      return;
    }
    const goal = u.obj === "value" ? res.value : res[u.obj];
    res.lines.sort((a, b) => b.o.price * b.q - a.o.price * a.q);
    box.innerHTML = `
      <div class="order-total"><h2>${u.obj === "value" ? eur(goal) + " de produits" : n0(goal) + OBJ[u.obj][2]}<br><span class="muted" style="font-size:.6em">pour ${eur(res.price)}${u.mode === "budget" && res.price < u.budget ? ` · il te reste ${eur(u.budget - res.price)}` : ""}</span></h2>
        <button type="button" class="btn btn-soft" data-action="copy-order">📋 Copier la commande</button></div>
      <div class="kpis" style="margin:16px 0 8px">
        <div class="kpi accent"><b>${eur(res.price)}</b><span>total</span></div>
        <div class="kpi"><b>${n0(res.kcal)}</b><span>kcal</span></div>
        <div class="kpi"><b>${n0(res.prot)} g</b><span>protéines</span></div>
        <div class="kpi"><b>${res.burgers}</b><span>burgers</span></div>
        <div class="kpi good"><b>${eur(res.value)}</b><span>valeur à la carte</span></div>
      </div>
      <div>${res.lines.map(({ o, q }) => `<div class="order-line">
        <span class="qty">${q}×</span>${img(o.img, "thumb", ROLE_ICON[o.role])}
        <div style="min-width:0"><div class="row-title">${esc(o.label)}</div>${o.cfg ? `<div class="row-sub">${o.cfg.items.filter((x) => x.p.role !== "jouet").map((x) => esc(x.p.n) + (x.sup > 0 ? ` (+${eur(x.sup)})` : "")).join(" · ")}</div>` : `<div class="row-sub">${n0(o.kcal)} kcal · ${n0(o.prot)} g prot.</div>`}</div>
        <div class="row-end"><b>${eur(o.price * q)}</b>${q > 1 ? `<div class="row-sub">${eur(o.price)} pièce</div>` : ""}</div>
      </div>`).join("")}</div>
      <p class="muted small" style="margin-top:14px">Optimum exact parmi ${plural(items.length, "offre")} (sac à dos borné, ${ms} ms). Les menus sont pris dans leur composition la plus rentable pour ton objectif.</p>`;
    S.lastOrder = res;
  }
  after.budget = () => {
    runOptim();
    const live = debounce(runOptim, 40);
    const b = $("#o-budget"), t = $("#o-target");
    b?.addEventListener("input", () => { S.ui.budget = +b.value; $("#o-budget-out").textContent = eur(S.ui.budget); saveUI(); live(); });
    t?.addEventListener("input", () => { S.ui.target = +t.value; $("#o-target-out").textContent = fmtTarget(S.ui.target); saveUI(); live(); });
  };

  /* ================================================================ DUEL */
  function keyMetrics(model) {
    const all = E.offers(model, "kcal").filter((o) => o.price > 0), food = all.filter(FOOD);
    const prods = [...model.products.values()].filter((p) => p.alone && p.price > 0);
    const burgers = prods.filter((p) => p.role === "plat").sort((a, b) => a.price - b.price);
    const kcal = food.filter((o) => o.kcal > 0).map((o) => ({ o, v: per1000(o.price, o.kcal) })).sort((a, b) => a.v - b.v)[0];
    const prot = all.filter((o) => o.prot > 0 && o.role !== "sauce").map((o) => ({ o, v: per10g(o.price, o.prot) })).sort((a, b) => a.v - b.v)[0];
    const perB = model.menus.map((ms) => E.configure(ms, "burgers")).filter((c) => c.burgers >= 1).map((c) => ({ c, v: c.paid / c.burgers })).sort((a, b) => a.v - b.v)[0];
    const cheapMenu = model.menus.filter((ms) => !ms.kids).map((ms) => E.configure(ms, "default")).sort((a, b) => a.paid - b.paid)[0];
    const ten = E.knapsack(food.filter((o) => o.role !== "dessert"), "kcal", 2, 1000).budget(1000);
    const cheese = prods.find((p) => /^cheeseburger$/i.test(p.n));
    const piece = all.filter((o) => o.pcs > 0 && o.role === "poulet").map((o) => ({ o, v: o.price / o.pcs })).sort((a, b) => a.v - b.v)[0];
    const fries = prods.find((p) => /^moyennes? frites?$/.test(E.norm(p.n)));
    return [
      { k: "Burger le moins cher", v: burgers[0]?.price, txt: burgers[0]?.n },
      { k: "Cheeseburger", v: cheese?.price },
      { k: "Moyenne frite", v: fries?.price },
      { k: "Menu adulte le moins cher", v: cheapMenu?.paid, txt: cheapMenu && `${cheapMenu.ms.n} (${cheapMenu.ms.size})` },
      { k: "Prix par burger en menu", v: perB?.v, txt: perB && `${perB.c.ms.n} (${perB.c.ms.size})` },
      { k: "€ / 1000 kcal (le mieux)", v: kcal?.v, txt: kcal?.o.label },
      { k: "€ / 10 g de protéines", v: prot?.v, txt: prot?.o.label },
      { k: "Pièce de poulet", v: piece?.v, txt: piece?.o.label },
      { k: "Avec 10 €, calories max", v: ten.kcal || null, higher: true, unit: "kcal", txt: ten.lines.map((l) => `${l.q}× ${l.o.label}`).join(" + ") },
    ];
  }
  function viewDuel() {
    return `<div class="page-head"><div><div class="eyebrow">Duel</div><h1>Qui gratte le mieux ?</h1>
      <p>Ton resto face au resto le plus proche de l'autre chaîne. Mêmes données, mêmes calculs. McDonald's, KFC et O'Tacos ne sont pas comparés : leurs prix ne sont pas publics.</p></div></div>
      <div id="duel-body"><div class="sk" style="height:320px"></div></div>`;
  }
  after.duel = async () => {
    const me = S.resto;
    const sides = [{ chain: S.chain, r: me, model: S.model, d: 0 }];
    for (const c of CHAINS) {
      if (c.id === S.chain) continue;
      try {
        const d = await loadChain(c.id);
        const near = me.lat != null ? nearestIn(d.restaurants, me, 1)[0] : null;
        if (near) sides.push({ chain: c.id, r: near.r, d: near.d, model: E.buildModel(d.catalog, await loadGrid(c.id, near.r)) });
      } catch (_) { /* chaîne indisponible */ }
    }
    const box = $("#duel-body");
    if (!box || S.route !== "duel" || S.resto !== me) return;
    if (sides.length < 2) { box.innerHTML = `<div class="empty card"><b>Pas d'adversaire trouvé</b>Aucun resto d'une autre chaîne n'est référencé.</div>`; return; }
    const mets = sides.map((s) => keyMetrics(s.model));
    const wins = sides.map(() => 0);
    const rows = mets[0].map((row, i) => {
      const ok = mets.map((m) => m[i].v).filter((v) => v != null && isFinite(v));
      const best = ok.length > 1 ? (row.higher ? Math.max(...ok) : Math.min(...ok)) : null;
      const unique = best != null && ok.filter((v) => v === best).length === 1;
      return `<div class="duel-row"><div class="duel-metric">${esc(row.k)}</div>${mets.map((m, si) => {
        const x = m[i], win = unique && x.v === best;
        if (win) wins[si]++;
        return `<div class="duel-cell ${win ? "win" : ""}">${x.v == null || !isFinite(x.v) ? `<b class="muted">—</b><span class="muted">pas proposé</span>` : `<b>${x.unit ? n0(x.v) + " " + x.unit : eur(x.v)}</b>${x.txt ? `<span class="muted">${esc(x.txt)}</span>` : ""}`}</div>`;
      }).join("")}</div>`;
    }).join("");
    const lead = Math.max(...wins), solo = wins.filter((w) => w === lead).length === 1;
    box.innerHTML = `
      <div class="duel-head">
        ${sides.map((s, i) => `${i ? `<div class="duel-vs">VS</div>` : ""}<div class="card duel-side ${solo && wins[i] === lead ? "winner" : ""}">
          <div class="chain">${esc(chainOf(s.chain).name)}</div><div class="muted small">${esc(s.r.name)}${s.d ? ` · à ${kmTxt(s.d)}` : " · ton resto"}</div>
          <div class="score">${wins[i]}</div>${solo && wins[i] === lead ? `<div class="badge accent" style="margin-top:8px">🏆 Vainqueur</div>` : ""}
          ${i ? `<div style="margin-top:12px"><button type="button" class="btn btn-ghost" data-action="goto-resto" data-chain="${s.chain}" data-id="${esc(s.r.id)}">Passer sur ce resto</button></div>` : ""}
        </div>`).join("")}
      </div>
      ${solo ? "" : `<div class="callout" style="margin-bottom:14px">Égalité parfaite. Départage-les avec l'optimiseur 😉</div>`}
      <div class="card">${rows}</div>`;
  };

  /* ================================================================ FRANCE */
  function viewFrance() {
    const d = D(), R = d.restaurants.filter((r) => r.idx);
    const sorted = [...R].sort((a, b) => a.idx - b.idx);
    const pos = new Map(sorted.map((r, i) => [r.id, i + 1]));
    const rank = pos.get(S.resto.id);
    const minI = sorted[0]?.idx || 100, maxI = sorted[sorted.length - 1]?.idx || 100;
    const line = (r, extra = "") => `<div class="row click" data-action="goto-resto" data-chain="${S.chain}" data-id="${esc(r.id)}" tabindex="0" role="button">
      <span class="rank">${pos.get(r.id)}</span>
      <div style="min-width:0"><div class="row-title">${esc(r.name)}${r.id === S.resto.id ? ` <span class="badge accent">ton resto</span>` : ""}</div><div class="row-sub">${esc([r.cp, r.city].filter(Boolean).join(" "))}${extra}</div>
        <div class="meter ${r.idx <= 100 ? "good" : ""}"><i style="width:${(8 + (92 * (r.idx - minI)) / Math.max(1, maxI - minI)).toFixed(0)}%"></i></div></div>
      <div class="row-end"><b class="${r.idx > 103 ? "bad" : r.idx < 100 ? "good" : ""}">${n1(r.idx)}</b><div class="row-sub">indice</div></div></div>`;
    const near = S.userPos ? nearestIn(R, S.userPos, 20).sort((a, b) => a.r.idx - b.r.idx) : [];
    const st = d.stats.p, P = d.catalog.products;
    const cheese = Object.entries(st).find(([plu]) => P[plu]?.cats?.length && /^cheeseburger$/i.test(P[plu].n))?.[1];
    const spread = Object.entries(st).filter(([plu, s]) => P[plu]?.cats?.length && P[plu].role === "plat" && s.n > R.length * 0.5)
      .map(([plu, s]) => ({ n: P[plu].n, s })).sort((a, b) => (b.s.max - b.s.min) - (a.s.max - a.s.min))[0];
    return `
    <div class="page-head"><div><div class="eyebrow">${esc(chainOf(S.chain).name)} · ${plural(d.restaurants.length, "resto")}</div><h1>Le classement France</h1>
      <p>Indice 100 = prix médian de la chaîne, sur les produits vendus seuls présents dans au moins 90 % des restos.</p></div>
      <button type="button" class="btn btn-soft" data-action="geo">📍 Les moins chers autour de moi</button></div>
    <div class="grid grid-4">
      <div class="card plan"><div class="plan-tag">📍 Ton resto</div><div><div class="plan-value">${rank || "—"}<small> / ${sorted.length}</small></div><div class="plan-what">${esc(S.resto.name)}</div><div class="plan-sub">indice ${n1(S.resto.idx)}</div></div></div>
      ${cheese ? `<div class="card plan"><div class="plan-tag">🧀 Cheeseburger</div><div><div class="plan-value">${eur(cheese.min)}<small> → ${eur(cheese.max)}</small></div><div class="plan-what">médiane ${eur(cheese.med)}</div><div class="plan-sub">selon le resto</div></div></div>` : ""}
      ${spread ? `<div class="card plan"><div class="plan-tag">📈 Plus gros écart</div><div><div class="plan-value">${eur(spread.s.max - spread.s.min)}</div><div class="plan-what">${esc(spread.n)}</div><div class="plan-sub">de ${eur(spread.s.min)} à ${eur(spread.s.max)}</div></div></div>` : ""}
      <div class="card plan"><div class="plan-tag">🏪 Restos suivis</div><div><div class="plan-value">${n0(d.restaurants.length)}</div><div class="plan-what">${plural(Object.keys(st).length, "produit")} suivis</div><div class="plan-sub">une grille de prix par resto</div></div></div>
    </div>
    ${near.length ? `<section class="section"><div class="section-head"><h2>Autour de toi, du moins cher au plus cher</h2></div>
      <div class="card rows">${near.map(({ r, d: km }) => line(r, ` · ${kmTxt(km)}`)).join("")}</div></section>` : ""}
    <div class="two section">
      <section><div class="section-head"><h2>Les 15 moins chers</h2></div><div class="card rows">${sorted.slice(0, 15).map((r) => line(r)).join("")}</div></section>
      <section><div class="section-head"><h2>Les 15 plus chers</h2><span class="muted small">aéroports, gares, autoroutes…</span></div><div class="card rows">${sorted.slice(-15).reverse().map((r) => line(r)).join("")}</div></section>
    </div>`;
  }

  /* ================================================================ MÉTHODE / PLUS */
  function viewMethode() {
    return `<div class="page-head"><div><div class="eyebrow">Méthode</div><h1>Comment on calcule</h1><p>Tout est calculé dans ton navigateur, à partir des prix publics de la commande en ligne de chaque resto.</p></div></div>
    <div class="prose">
      <h2>D'où viennent les prix</h2>
      <p>Chaque jour, un robot relève le catalogue complet de chaque restaurant <b>Burger King</b> (≈ 635) et <b>Quick</b> (200) : produits seuls, menus par taille, menus enfants, formules, et les suppléments facturés quand tu prends une option premium. Les calories et protéines viennent des fiches nutritionnelles officielles. Les prix changent d'un resto à l'autre — parfois du simple au double.</p>
      <h2>Coût unitaire</h2>
      <p>Le prix que tu paies pour un menu (suppléments compris) est réparti entre ses éléments <b>au prorata de leur prix à la carte</b>. Menu à 9 € avec un burger à 7 €, des frites à 3,40 € et une boisson à 2,70 € (13,10 € à la carte) : le burger te revient à 9 × 7 / 13,10 = <b>4,81 €</b>.</p>
      <p>Le <b>coût marginal</b>, c'est ce que l'élément te coûte en plus si tu achetais tout le reste à la carte. Quand il est négatif, l'élément est littéralement offert.</p>
      <h2>Versions « maxées »</h2>
      <p>À chaque étape d'un menu, on choisit automatiquement l'option la plus rentable : la plus chère à la carte (« valeur »), ou la combinaison qui maximise les calories ou les protéines par euro, suppléments compris (algorithme de Dinkelbach, résultat exact).</p>
      <h2>Optimiseur</h2>
      <p>Un problème de sac à dos borné, résolu par programmation dynamique au centime près, sur tous les produits seuls et menus du resto. C'est l'optimum exact, pas une approximation.</p>
      <h2>Questions fréquentes</h2>
      <div class="faq">
        <details><summary>Pourquoi pas McDonald's, KFC ou O'Tacos ?</summary><p>Leurs prix ne sont pas publics : sites protégés contre les robots, ou prix réservés à l'appli connectée. On ne contourne pas ces protections.</p></details>
        <details><summary>Les prix sont-ils ceux de la caisse ?</summary><p>Ce sont ceux de la commande en ligne et des bornes du resto. En caisse, en livraison ou avec les coupons de l'appli, ils peuvent différer.</p></details>
        <details><summary>Pourquoi certains produits sont à 0 kcal ?</summary><p>Quelques produits n'ont pas de fiche nutritionnelle publiée (surtout des boissons et des glaces chez Quick) : ils comptent pour 0 kcal, ce qui les défavorise dans les classements calories.</p></details>
        <details><summary>Que veulent dire « ≈ » et « n.c. » ?</summary><p>« ≈ » : l'élément n'est pas vendu seul, on utilise son prix catalogue. « n.c. » : impossible d'estimer un prix à la carte fiable (ex. boîtes de mini-burgers), l'économie n'est donc pas calculée.</p></details>
        <details><summary>Je peux partager un plan ?</summary><p>Oui : chaque page, chaque resto et chaque fiche a son propre lien. Bouton partage en haut à droite, ou copie l'adresse.</p></details>
        <details><summary>C'est officiel ?</summary><p>Non. FastFist est un projet indépendant, sans aucun lien avec Burger King® ou Quick®. Les marques appartiennent à leurs propriétaires.</p></details>
      </div>
      <p class="muted small" style="margin-top:20px">Raccourcis : <code>/</code> pour changer de resto, <code>Échap</code> pour fermer un panneau.</p>
    </div>`;
  }
  function viewPlus() {
    return `<div class="page-head"><div><h1>Plus</h1></div></div>
      <div class="card more-list">
        <a href="#/carte"><span>🧾</span><div>La carte<small>Tous les produits seuls, triés par rapport calories/prix</small></div></a>
        <a href="#/france"><span>🇫🇷</span><div>Classement France<small>Les restos les moins chers, près de chez toi</small></div></a>
        <a href="#/methode"><span>❓</span><div>Méthode & FAQ<small>Comment on calcule tout ça</small></div></a>
        <a href="#" data-action="theme"><span>🌓</span><div>Thème clair / sombre<small>Bascule l'apparence</small></div></a>
        <a href="https://github.com/charlesterrey/fastfist"><span>💻</span><div>Code source<small>Sur GitHub</small></div></a>
      </div>`;
  }

  /* ================================================================ PANNEAUX */
  let lastFocus = null;
  function showSheet(id) {
    if ($("#" + id).hidden) lastFocus = document.activeElement;
    ["picker", "detail"].filter((x) => x !== id).forEach((x) => { $("#" + x).hidden = true; $(`#${x}-backdrop`).hidden = true; });
    $("#" + id).hidden = false; $(`#${id}-backdrop`).hidden = false;
    document.body.classList.add("locked");
    setTimeout(() => (id === "picker" ? $("#picker-q") : $("#detail [data-close]"))?.focus({ preventScroll: true }), 30);
  }
  function closeSheets(quiet) {
    const wasOpen = !$("#picker").hidden || !$("#detail").hidden;
    ["picker", "detail"].forEach((id) => { $("#" + id).hidden = true; $(`#${id}-backdrop`).hidden = true; });
    document.body.classList.remove("locked");
    if (S.detail) { S.detail = null; syncHash(); }
    if (wasOpen && !quiet) lastFocus?.focus?.({ preventScroll: true });
  }

  /* ---------- sélecteur de resto */
  let pickerChain = null;
  async function openPicker() {
    pickerChain = S.chain;
    $("#picker-q").value = "";
    renderPickerChains();
    showSheet("picker");
    await renderPicker();
  }
  function renderPickerChains() {
    $("#picker-chains").innerHTML = CHAINS.map((c) => `<button type="button" role="tab" data-chain="${c.id}" class="${c.id === pickerChain ? "on" : ""}" aria-selected="${c.id === pickerChain}">${esc(c.name)}</button>`).join("");
  }
  async function renderPicker() {
    const chain = pickerChain;
    let d;
    try { d = await loadChain(chain); } catch (_) { $("#picker-list").innerHTML = `<li class="picker-empty">Données indisponibles.</li>`; return; }
    if (chain !== pickerChain) return;
    const q = E.norm($("#picker-q").value);
    const ref = S.userPos || (S.resto?.lat != null ? S.resto : null);
    let list;
    if (q) list = d.restaurants.filter((r) => E.norm(`${r.name} ${r.city} ${r.cp} ${r.address}`).includes(q)).slice(0, 50).map((r) => ({ r, d: ref ? dist(ref, r) : null }));
    else if (ref) list = nearestIn(d.restaurants, ref, 30);
    else list = d.restaurants.slice(0, 30).map((r) => ({ r, d: null }));
    $("#picker-list").innerHTML = list.length ? list.map(({ r, d: km }) => `<li role="option" tabindex="0" data-id="${esc(r.id)}" class="${r.id === S.resto?.id && chain === S.chain ? "current" : ""}" aria-selected="${r.id === S.resto?.id && chain === S.chain}">
      <span class="pc">${esc(chainOf(chain).short)}</span>
      <div><div class="pn">${esc(r.name)}</div><div class="ps">${esc([r.cp, r.city].filter(Boolean).join(" "))}</div></div>
      <div class="pe">${km != null ? kmTxt(km) : ""}${r.idx ? `<div class="${r.idx < 100 ? "good" : r.idx > 103 ? "bad" : ""}">indice ${n1(r.idx)}</div>` : ""}</div></li>`).join("")
      : `<li class="picker-empty">Aucun resto ne correspond à « ${esc($("#picker-q").value)} ».</li>`;
    $("#picker-title").textContent = q ? `${list.length} resto${list.length > 1 ? "s" : ""} trouvé${list.length > 1 ? "s" : ""}` : S.userPos ? "Autour de toi" : ref ? "Près de ton resto actuel" : "Choisis ton resto";
  }

  function geolocate(cb) {
    if (!navigator.geolocation) return toast("Géolocalisation indisponible");
    toast("Recherche de ta position…");
    navigator.geolocation.getCurrentPosition((pos) => {
      S.userPos = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      toast("Position trouvée");
      cb?.();
    }, () => toast("Position refusée ou indisponible"), { timeout: 10000, maximumAge: 600000 });
  }

  /* ================================================================ ÉVÉNEMENTS */
  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
  function rerenderKeepFocus(sel) {
    const el = $(sel), pos = el?.selectionStart;
    render();
    const n = $(sel);
    if (n) { n.focus({ preventScroll: true }); try { n.setSelectionRange(pos, pos); } catch (_) { /* rien */ } }
  }

  const actions = {
    "hero-budget": (el) => { S.ui.heroBudget = +el.dataset.c; saveUI(); render(); },
    menu: (el) => openMenu(el.dataset.key, el.dataset.mode),
    "menu-from-product": (el) => {
      const ms = S.model.menus.find((m) => m.key === el.dataset.key), p = S.model.products.get(el.dataset.plu);
      if (!ms) return;
      const chosen = E.configure(ms, "value").items.map((x) => x.p);
      const i = ms.steps.findIndex((s) => s.opts.includes(p)); if (i >= 0) chosen[i] = p;
      S.detail = { kind: "menu", key: ms.key, mid: ms.mid, mode: "custom", chosen };
      renderMenuDetail(); $("#detail .sheet-body").scrollTop = 0; syncHash();
    },
    product: (el) => openProduct(el.dataset.plu),
    "menu-mode": (el) => { S.ui.menuMode = el.dataset.v; saveUI(); render(); },
    "menu-fam": (el) => { S.ui.menuFam = el.dataset.v; saveUI(); render(); },
    "carte-role": (el) => { S.ui.carteRole = el.dataset.v; saveUI(); render(); },
    "detail-size": (el) => openMenu(el.dataset.key, S.detail.mode === "custom" ? "value" : S.detail.mode),
    "detail-mode": (el) => openMenu(S.detail.key, el.dataset.v),
    "opt-mode": (el) => { S.ui.mode = el.dataset.v; saveUI(); render(); },
    "opt-obj": (el) => { S.ui.obj = el.dataset.v; clampTarget(); saveUI(); render(); },
    "opt-qty": (el) => { S.ui.maxQty = Math.max(1, Math.min(6, S.ui.maxQty + +el.dataset.v)); saveUI(); $("#o-qty").textContent = S.ui.maxQty; runOptim(); },
    "opt-role": (el) => {
      const k = el.dataset.v, set = new Set(S.ui.roles);
      set.has(k) ? set.delete(k) : set.add(k);
      S.ui.roles = [...set]; saveUI();
      el.classList.toggle("on", set.has(k)); el.setAttribute("aria-pressed", set.has(k));
      runOptim();
    },
    "copy-order": () => {
      const r = S.lastOrder; if (!r) return;
      const txt = `Ma commande ${chainOf(S.chain).name} ${S.resto.name} — via FastFist\n`
        + r.lines.map(({ o, q }) => `${q}× ${o.label}${o.cfg ? " : " + o.cfg.items.filter((x) => x.p.role !== "jouet").map((x) => x.p.n).join(", ") : ""}`).join("\n")
        + `\nTotal : ${eur(r.price)} · ${n0(r.kcal)} kcal`;
      copy(txt, "Commande copiée");
    },
    "goto-resto": (el) => setResto(el.dataset.chain, el.dataset.id),
    geo: () => geolocate(() => render()),
    theme: () => toggleTheme(),
  };

  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-close]") || e.target.classList.contains("sheet-backdrop")) { e.preventDefault(); closeSheets(); return; }
    const a = e.target.closest("[data-action]");
    if (a && actions[a.dataset.action]) { e.preventDefault(); actions[a.dataset.action](a); }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closeSheets(); return; }
    if ((e.key === "Enter" || e.key === " ") && e.target.matches("[data-action][role=button], .picker-list li[data-id]")) { e.preventDefault(); e.target.click(); return; }
    if (e.key === "/" && !e.target.matches("input, select, textarea")) { e.preventDefault(); openPicker(); }
  });

  function copy(txt, msg) {
    const fallback = () => {
      const ta = Object.assign(document.createElement("textarea"), { value: txt });
      ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.append(ta); ta.select();
      try { document.execCommand("copy"); toast(msg); } catch (_) { toast("Copie impossible"); }
      ta.remove();
    };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(txt).then(() => toast(msg), fallback);
    else fallback();
  }
  function toggleTheme() {
    const cur = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = cur === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("ff-theme", next); } catch (_) { /* rien */ }
    toast(next === "dark" ? "Thème sombre" : "Thème clair");
  }

  /* ================================================================ INIT */
  async function init() {
    $("#resto-chip").addEventListener("click", openPicker);
    $("#share-btn").addEventListener("click", () => copy(location.href, "Lien copié — partage-le !"));
    $("#theme-btn").addEventListener("click", toggleTheme);
    $("#picker-q").addEventListener("input", debounce(renderPicker, 120));
    $("#picker-q").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("#picker-list li[data-id]")?.click(); } });
    $("#picker-chains").addEventListener("click", (e) => { const b = e.target.closest("[data-chain]"); if (!b) return; pickerChain = b.dataset.chain; renderPickerChains(); renderPicker(); });
    $("#picker-geo").addEventListener("click", () => geolocate(renderPicker));
    $("#picker-list").addEventListener("click", (e) => { const li = e.target.closest("li[data-id]"); if (li) setResto(pickerChain, li.dataset.id); });
    window.addEventListener("hashchange", onHash);

    const { route, q } = parseHash();
    const savedChain = load("ff-chain", "bk");
    const chain = CHAINS.some((c) => c.id === q.get("c")) ? q.get("c") : CHAINS.some((c) => c.id === savedChain) ? savedChain : "bk";
    try {
      await setResto(chain, q.get("r"), { silent: true });
    } catch (err) {
      $("#view").innerHTML = `<div class="empty card"><b>Impossible de charger les données</b>${esc(err.message)}<br>Lance <code>python3 scraper/bk.py</code> et <code>python3 scraper/quick.py</code>, puis sers le dossier en HTTP.</div>`;
      return;
    }
    S.route = route;
    render();
    if (q.get("m")) openMenu(q.get("m"));
    else if (q.get("p")) openProduct(q.get("p"));
    CHAINS.forEach((c) => loadChain(c.id).catch(() => {})); // précharge pour le sélecteur et le duel
  }
  init();
})();
