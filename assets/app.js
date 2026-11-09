/* FastFist — interface. */
(function () {
  "use strict";
  const E = window.Engine;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  const CHAINS = [
    { id: "bk", name: "Burger King", short: "BK", icon: "👑" },
    { id: "quick", name: "Quick", short: "Quick", icon: "⚡" },
  ];
  const state = {
    chain: "bk", data: {}, grids: {},
    catalog: null, stats: null, restaurants: [], resto: null, model: null,
    crit: "kcal", tab: "top", userPos: null,
    sort: { top: ["ratio", 1], menus: ["savingPct", -1], produits: ["kcalPerEuro", 1] },
  };

  /* ------------------------------------------------------------ formatage */
  const eur = (c) => c == null || !isFinite(c) ? "—" : (c / 100).toLocaleString("fr-FR", { style: "currency", currency: "EUR" });
  const n0 = (x) => x == null || !isFinite(x) ? "—" : Math.round(x).toLocaleString("fr-FR");
  const n1 = (x) => x == null || !isFinite(x) ? "—" : x.toLocaleString("fr-FR", { maximumFractionDigits: 1 });
  const pct = (x) => !isFinite(x) ? "—" : (x * 100).toLocaleString("fr-FR", { maximumFractionDigits: 0 }) + " %";
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const img = (u, cls = "thumb") => u
    ? `<img class="${cls}" loading="lazy" alt="" src="${esc(u)}${u.includes("medias.burgerking.fr") ? "?w=96&org_if_sml=1" : ""}" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'${cls} ph',textContent:'🍔'}))">`
    : `<span class="${cls} ph">🍔</span>`;
  const per1000 = (price, kcal) => kcal > 0 ? (price * 1000) / kcal : Infinity; // centimes / 1000 kcal
  const per10g = (price, prot) => prot > 0 ? (price * 10) / prot : Infinity;
  const STEP_LABEL = { BURGER: "Plat", SIDE: "Accomp.", DRINK: "Boisson", SWEET: "Dessert", TOY: "Jouet", GIFT: "Cadeau", OTHER: "Bonus", NONE: "Élément" };
  const CRIT = {
    kcal: { label: "€ / 1000 kcal", short: "kcal", ratio: (o) => per1000(o.price, o.kcal), fmt: (v) => eur(v) },
    prot: { label: "€ / 10 g prot.", short: "prot", ratio: (o) => per10g(o.price, o.prot), fmt: (v) => eur(v) },
    value: { label: "Économie vs carte", short: "value", ratio: (o) => o.value > 0 ? o.price / o.value : Infinity, fmt: (v) => isFinite(v) ? pct(1 - v) : "—" },
  };

  /* ------------------------------------------------------------ chargement */
  async function getJSON(u) {
    const r = await fetch(u, { cache: "no-cache" });
    if (!r.ok) throw new Error(u + " → " + r.status);
    return r.json();
  }

  async function loadChain(id) {
    if (!state.data[id]) {
      const base = `data/${id}/`;
      const [rs, cat, st] = await Promise.all([getJSON(base + "restaurants.json"), getJSON(base + "catalog.json"), getJSON(base + "stats.json")]);
      rs.restaurants.forEach((r) => (r.chain = id));
      state.data[id] = { restaurants: rs.restaurants, catalog: cat, stats: st, updated: rs.updated };
    }
    return state.data[id];
  }

  async function loadGrid(chain, r) {
    const key = chain + "/" + r.grid;
    if (!state.grids[key]) state.grids[key] = getJSON(`data/${chain}/prices/${r.grid}.json`);
    return state.grids[key];
  }

  const chainName = (id) => (CHAINS.find((c) => c.id === id) || {}).name || id;
  const saved = (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } };
  const save = (k, v) => { try { localStorage.setItem(k, v); } catch (_) { /* stockage indisponible */ } };

  async function init() {
    const hash = new URLSearchParams(location.hash.slice(1));
    const wanted = hash.get("c") || saved("ff-chain") || "bk";
    $("#chain-seg").innerHTML = CHAINS.map((c) => `<button type="button" data-chain="${c.id}">${c.icon} ${esc(c.name)}</button>`).join("");
    bindUI();
    try {
      await switchChain(CHAINS.some((c) => c.id === wanted) ? wanted : "bk", hash.get("r"));
    } catch (e) {
      $("#resto-current").innerHTML = `<span class="err">Impossible de charger les données (${esc(e.message)}). Lance les scrapers (<code>scraper/bk.py</code>, <code>scraper/quick.py</code>) puis sers le dossier en HTTP.</span>`;
    }
  }

  async function switchChain(id, restoId) {
    const d = await loadChain(id);
    state.chain = id;
    state.restaurants = d.restaurants;
    state.catalog = d.catalog;
    state.stats = d.stats;
    save("ff-chain", id);
    $$("#chain-seg button").forEach((b) => b.classList.toggle("on", b.dataset.chain === id));
    $("#resto-search").placeholder = `Resto ${chainName(id)} : ville, code postal, nom…`;
    $("#updated").textContent = `Prix ${chainName(id)} relevés le ` + new Date(d.updated).toLocaleString("fr-FR", { dateStyle: "long", timeStyle: "short" });
    // par défaut : resto mémorisé, sinon le plus proche du resto précédent (autre chaîne), sinon Paris
    const prev = state.resto;
    const first = d.restaurants.find((r) => r.id === restoId) || d.restaurants.find((r) => r.id === saved("ff-resto-" + id))
      || (prev && prev.lat && nearestIn(d.restaurants, prev, 1)[0])
      || d.restaurants.find((r) => /paris/i.test(r.city)) || d.restaurants[0];
    await selectResto(first.id);
  }

  async function selectResto(id) {
    const r = state.restaurants.find((x) => x.id === id);
    if (!r) return;
    $("#resto-current").innerHTML = `Chargement de ${esc(r.name)}…`;
    const grid = await loadGrid(state.chain, r);
    state.resto = r;
    state.model = E.buildModel(state.catalog, grid);
    save("ff-resto-" + state.chain, id);
    history.replaceState(null, "", `#c=${state.chain}&r=${encodeURIComponent(id)}`);
    const idx = r.idx ? ` · indice prix <b class="${r.idx > 103 ? "bad" : r.idx < 100 ? "good" : ""}">${n1(r.idx)}</b>` : "";
    $("#resto-current").innerHTML = `📍 <b>${esc(chainName(state.chain))} ${esc(r.name)}</b> <span class="muted">${esc(r.address)}</span>${idx}`;
    $("#resto-search").value = "";
    fillFamilySelect();
    renderAll();
  }

  /* ------------------------------------------------------------ UI */
  function bindUI() {
    $$(".tabs [role=tab]").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
    $$("#chain-seg button").forEach((b) => b.addEventListener("click", () => { if (b.dataset.chain !== state.chain) switchChain(b.dataset.chain); }));
    $$("#crit-seg button").forEach((b) => b.addEventListener("click", () => {
      state.crit = b.dataset.crit;
      $$("#crit-seg button").forEach((x) => x.classList.toggle("on", x === b));
      state.sort.top = ["ratio", 1];
      renderTop();
    }));
    $("#top-filter").addEventListener("change", renderTop);
    ["#menu-search", "#menu-family", "#menu-config"].forEach((s) => $(s).addEventListener("input", renderMenus));
    ["#prod-search", "#prod-role"].forEach((s) => $(s).addEventListener("input", renderProducts));

    // recherche resto
    const input = $("#resto-search"), list = $("#resto-results");
    input.addEventListener("input", () => {
      const q = E.norm(input.value);
      if (!q) { list.hidden = true; return; }
      const hits = state.restaurants.filter((r) => E.norm(`${r.name} ${r.city} ${r.cp} ${r.address}`).includes(q)).slice(0, 12);
      list.innerHTML = hits.map((r) => `<li role="option" data-id="${r.id}"><b>${esc(r.name)}</b> <span class="muted">${esc(r.cp)} ${esc(r.city)}</span></li>`).join("")
        || `<li class="muted">Aucun resto trouvé</li>`;
      list.hidden = false;
    });
    list.addEventListener("click", (e) => {
      const li = e.target.closest("li[data-id]");
      if (li) { list.hidden = true; selectResto(li.dataset.id); }
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { const li = $("li[data-id]", list); if (li) { list.hidden = true; selectResto(li.dataset.id); } }
      if (e.key === "Escape") list.hidden = true;
    });
    document.addEventListener("click", (e) => { if (!e.target.closest(".resto-picker")) list.hidden = true; });
    $("#geo-btn").addEventListener("click", geolocate);

    // optimiseur
    const roles = [["menu", "Menus", true], ["enfant", "Menus enfants", true], ["plat", "Burgers & plats", true], ["poulet", "Poulet", true],
      ["accomp", "Accompagnements", true], ["dessert", "Desserts", true], ["boisson", "Boissons", false], ["sauce", "Sauces", false], ["autre", "Autres", true]];
    $("#o-roles").innerHTML = roles.map(([k, l, on]) => `<label><input type="checkbox" value="${k}" ${on ? "checked" : ""}> ${l}</label>`).join("");
    $$("#optim-mode button").forEach((b) => b.addEventListener("click", () => {
      $$("#optim-mode button").forEach((x) => x.classList.toggle("on", x === b));
      const target = b.dataset.mode === "target";
      $("#f-budget").hidden = target;
      $("#f-target").hidden = !target;
    }));
    $("#o-obj").addEventListener("change", () => {
      const defaults = { kcal: 2000, prot: 100, burgers: 4, pcs: 30, value: 2000 };
      $("#o-target").value = defaults[$("#o-obj").value];
    });
    $("#optim-form").addEventListener("submit", (e) => { e.preventDefault(); runOptim(); });
  }

  function showTab(t) {
    state.tab = t;
    $$(".tabs [role=tab]").forEach((b) => b.setAttribute("aria-selected", b.dataset.tab === t));
    $$(".tab-panel").forEach((p) => (p.hidden = p.id !== "tab-" + t));
    if (t === "france") renderFrance();
    if (t === "duel") renderDuel();
  }

  function geolocate() {
    if (!navigator.geolocation) return alert("Géolocalisation indisponible");
    $("#geo-btn").textContent = "📍 …";
    navigator.geolocation.getCurrentPosition((pos) => {
      $("#geo-btn").textContent = "📍 Près de moi";
      state.userPos = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      const near = nearest(state.userPos, 1)[0];
      if (near) selectResto(near.id);
      renderFrance();
    }, () => { $("#geo-btn").textContent = "📍 Près de moi"; alert("Position refusée"); });
  }

  function dist(a, b) {
    const R = 6371, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function nearestIn(list, pos, k) {
    return list.filter((r) => r.lat).map((r) => ({ ...r, d: dist(pos, r) })).sort((a, b) => a.d - b.d).slice(0, k);
  }
  function nearest(pos, k) { return nearestIn(state.restaurants, pos, k); }

  function fillFamilySelect() {
    const fams = [...new Set(state.model.menus.map((m) => m.fam))].sort((a, b) => {
      const ia = E.FAMILY_ORDER.indexOf(a), ib = E.FAMILY_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b, "fr");
    });
    const sel = $("#menu-family"), cur = sel.value;
    sel.innerHTML = `<option value="">Toutes les familles</option>` + fams.map((f) => `<option ${f === cur ? "selected" : ""}>${esc(f)}</option>`).join("");
    const roles = [...new Set([...state.model.products.values()].filter((p) => p.alone).map((p) => p.role))];
    const rs = $("#prod-role"), rc = rs.value;
    rs.innerHTML = `<option value="">Toutes catégories</option>` + roles.map((r) => `<option value="${r}" ${r === rc ? "selected" : ""}>${esc(E.ROLE_LABEL[r] || r)}</option>`).join("");
  }

  function renderAll() {
    renderTop(); renderMenus(); renderProducts();
    if (state.tab === "france") renderFrance();
    if (state.tab === "duel") renderDuel();
    $("#optim-result").innerHTML = `<p class="muted">Choisis un budget ou un objectif puis lance l'optimisation.</p>`;
  }

  /* ------------------------------------------------------------ tables triables */
  function sortable(table, key, cols, rows, rowHtml, extra) {
    const [sk, sd] = state.sort[key];
    const col = cols.find((c) => c.k === sk) || cols[0];
    rows.sort((a, b) => {
      const va = col.v(a), vb = col.v(b);
      if (typeof va === "string") return sd * va.localeCompare(vb, "fr");
      const fa = isFinite(va) ? va : sd * 1e15, fb = isFinite(vb) ? vb : sd * 1e15;
      return sd * (fa - fb);
    });
    table.innerHTML = `<thead><tr>${cols.map((c) => `<th data-k="${c.k}" class="${c.num ? "num" : ""} ${c.k === sk ? (sd > 0 ? "asc" : "desc") : ""}" ${c.title ? `title="${esc(c.title)}"` : ""}>${c.h}</th>`).join("")}</tr></thead>`
      + `<tbody>${rows.map(rowHtml).join("") || `<tr><td colspan="${cols.length}" class="muted">Rien à afficher</td></tr>`}</tbody>`;
    $$("th", table).forEach((th) => th.addEventListener("click", () => {
      const k = th.dataset.k;
      state.sort[key] = [k, state.sort[key][0] === k ? -state.sort[key][1] : (cols.find((c) => c.k === k).dir || 1)];
      extra();
    }));
  }

  /* ------------------------------------------------------------ TOP */
  function renderTop() {
    const crit = CRIT[state.crit];
    const all = E.offers(state.model, state.crit).filter((o) => o.price > 0);
    const filter = $("#top-filter").value;
    const shown = all.filter((o) => filter === "all" || (filter === "menu" && o.kind === "menu") || (filter === "product" && o.kind === "product")
      || (filter === "nodrink" && !["boisson", "sauce", "dessert"].includes(o.role))
      || (filter === "nosauce" && !["boisson", "sauce"].includes(o.role)));
    shown.forEach((o) => (o.ratio = crit.ratio(o)));

    // podium
    const prods = [...state.model.products.values()].filter((p) => p.alone && p.price > 0);
    const burgers = prods.filter((p) => p.role === "plat");
    const cheapBurger = burgers.sort((a, b) => a.price - b.price)[0];
    const kcalAll = all.filter((o) => o.kcal > 0 && !["boisson", "sauce"].includes(o.role)).map((o) => ({ ...o, r: per1000(o.price, o.kcal) })).sort((a, b) => a.r - b.r);
    const protAll = all.filter((o) => o.prot > 0 && !["sauce"].includes(o.role)).map((o) => ({ ...o, r: per10g(o.price, o.prot) })).sort((a, b) => a.r - b.r);
    const menuCfgs = state.model.menus.map((ms) => E.configure(ms, "value"));
    const bestSaving = menuCfgs.filter((c) => c.ref > 0 && !c.approx).sort((a, b) => b.savingPct - a.savingPct)[0];
    const perBurger = menuCfgs.map((c) => E.configure(c.ms, "burgers")).filter((c) => c.burgers >= 1)
      .map((c) => ({ c, r: c.paid / c.burgers })).sort((a, b) => a.r - b.r)[0];
    const chicken = all.filter((o) => o.pcs > 0 && (o.role === "poulet" || o.kind === "menu"))
      .map((o) => ({ ...o, r: o.price / o.pcs })).sort((a, b) => a.r - b.r)[0];

    const card = (icon, title, big, what, sub, onclick) => `<article class="card ${onclick ? "click" : ""}" ${onclick ? `data-go="${esc(onclick)}"` : ""}>
      <div class="card-h"><span class="ico">${icon}</span>${title}</div>
      <div class="big">${big}</div><div class="what">${what}</div><div class="sub">${sub}</div></article>`;
    const cards = [];
    if (kcalAll[0]) cards.push(card("🔥", "Ce qui cale le plus pour pas cher", eur(kcalAll[0].r) + "<small> / 1000 kcal</small>",
      esc(kcalAll[0].label), `${eur(kcalAll[0].price)} · ${n0(kcalAll[0].kcal)} kcal${kcalAll[0].cfg ? " · " + cfgShort(kcalAll[0].cfg) : ""}`, kcalAll[0].kind === "menu" ? kcalAll[0].label : ""));
    if (cheapBurger) cards.push(card("🍔", "Burger seul le moins cher", eur(cheapBurger.price), esc(cheapBurger.n),
      `${n0(cheapBurger.kcal)} kcal · ${eur(per1000(cheapBurger.price, cheapBurger.kcal))} / 1000 kcal`));
    if (perBurger) cards.push(card("🍔🍔", "Meilleur prix par burger en menu", eur(perBurger.r) + "<small> / burger</small>",
      `${esc(perBurger.c.ms.n)} (${perBurger.c.ms.size})`, `${perBurger.c.burgers} burger(s) + le reste pour ${eur(perBurger.c.paid)} · ${cfgShort(perBurger.c)}`, perBurger.c.ms.n));
    if (bestSaving) cards.push(card("💸", "Plus grosse économie vs à la carte", pct(bestSaving.savingPct),
      `${esc(bestSaving.ms.n)} (${bestSaving.ms.size})`, `${eur(bestSaving.paid)} au lieu de ${eur(bestSaving.ref)} → ${eur(bestSaving.saving)} gagnés`, bestSaving.ms.n));
    if (protAll[0]) cards.push(card("💪", "Protéines les moins chères", eur(protAll[0].r) + "<small> / 10 g</small>",
      esc(protAll[0].label), `${eur(protAll[0].price)} · ${n0(protAll[0].prot)} g de protéines`, protAll[0].kind === "menu" ? protAll[0].label : ""));
    if (chicken) cards.push(card("🍗", "Pièce la moins chère", eur(chicken.r) + "<small> / pièce</small>",
      esc(chicken.label), `${chicken.pcs} pièces pour ${eur(chicken.price)}`, chicken.kind === "menu" ? chicken.label : ""));
    $("#podium").innerHTML = cards.join("");
    $$("#podium [data-go]").forEach((c) => c.addEventListener("click", () => {
      $("#menu-search").value = c.dataset.go.replace(/\s*\((S|M|L|XL)\)$/, "");
      $("#menu-family").value = "";
      showTab("menus"); renderMenus();
    }));

    const cols = [
      { k: "label", h: "Offre", v: (o) => o.label },
      { k: "kind", h: "Type", v: (o) => o.kind === "menu" ? o.fam : E.ROLE_LABEL[o.role] || o.role },
      { k: "price", h: "Prix", num: 1, v: (o) => o.price },
      { k: "kcal", h: "kcal", num: 1, dir: -1, v: (o) => o.kcal },
      { k: "prot", h: "Prot. (g)", num: 1, dir: -1, v: (o) => o.prot },
      { k: "value", h: "Valeur carte", num: 1, dir: -1, v: (o) => o.value },
      { k: "ratio", h: crit.label, num: 1, v: (o) => o.ratio },
    ];
    sortable($("#top-table"), "top", cols, shown, (o) => `<tr>
      <td class="namecell">${img(o.img)}<div><b>${esc(o.label)}</b>${o.cfg ? `<div class="muted small">${cfgShort(o.cfg)}</div>` : ""}</div></td>
      <td><span class="badge role-${o.role}">${esc(o.kind === "menu" ? o.fam : E.ROLE_LABEL[o.role] || o.role)}</span></td>
      <td class="num">${eur(o.price)}</td><td class="num">${o.hasNut ? n0(o.kcal) : "—"}</td><td class="num">${o.hasNut ? n0(o.prot) : "—"}</td>
      <td class="num">${eur(o.value)}</td><td class="num hl">${crit.fmt(o.ratio)}</td></tr>`, renderTop);
  }

  function cfgShort(cfg) {
    return cfg.items.filter((x) => x.p.role !== "jouet").map((x) => esc(x.p.n) + (x.sup > 0 ? ` <span class="sup">+${eur(x.sup)}</span>` : "")).join(" · ");
  }

  /* ------------------------------------------------------------ MENUS */
  function renderMenus() {
    if (!state.model) return;
    const q = E.norm($("#menu-search").value), fam = $("#menu-family").value, mode = $("#menu-config").value;
    const rows = state.model.menus.filter((m) => (!fam || m.fam === fam) && (!q || E.norm(m.n).includes(q)))
      .map((ms) => E.configure(ms, mode));
    const st = state.stats.m;
    const cols = [
      { k: "n", h: "Menu", v: (c) => c.ms.n },
      { k: "size", h: "Taille", v: (c) => c.ms.size },
      { k: "paid", h: "Prix", num: 1, v: (c) => c.paid },
      { k: "ref", h: "À la carte", num: 1, dir: -1, v: (c) => c.ref ?? -Infinity, title: "Somme des prix des éléments achetés séparément" },
      { k: "savingPct", h: "Économie", num: 1, dir: -1, v: (c) => c.savingPct ?? -Infinity },
      { k: "kcal", h: "kcal", num: 1, dir: -1, v: (c) => c.kcal },
      { k: "eurKcal", h: "€/1000 kcal", num: 1, v: (c) => per1000(c.paid, c.kcal) },
      { k: "burgerUnit", h: "Coût du plat", num: 1, v: (c) => mainItem(c)?.alloc ?? Infinity, title: "Coût unitaire du burger/plat principal dans ce menu (prorata)" },
    ];
    sortable($("#menu-table"), "menus", cols, rows, (c) => {
      const main = mainItem(c), s = st[c.ms.key];
      return `<tr class="menu-row" data-key="${esc(c.ms.key)}">
        <td class="namecell">${img(c.ms.img)}<div><b>${esc(c.ms.n)}</b> <span class="badge">${esc(c.ms.fam)}</span><div class="muted small">${cfgShort(c)}</div></div></td>
        <td>${c.ms.size}</td>
        <td class="num">${eur(c.paid)}${s ? `<div class="muted small" title="Médiane France">méd. ${eur(s.med)}</div>` : ""}</td>
        <td class="num">${eur(c.ref)}${c.approx ? ' <span class="badge warn" title="Au moins un élément non vendu seul : prix catalogue utilisé">≈</span>' : ""}</td>
        <td class="num ${c.saving == null ? "" : c.saving > 0 ? "good" : "bad"}">${c.saving == null ? '<span class="muted" title="Éléments non vendus seuls : pas de prix à la carte">n.c.</span>' : `${pct(c.savingPct)}<div class="small">${eur(c.saving)}</div>`}</td>
        <td class="num">${n0(c.kcal)}</td><td class="num">${eur(per1000(c.paid, c.kcal))}</td>
        <td class="num hl">${main ? eur(main.alloc) : "—"}${main && main.ref != null ? `<div class="muted small">seul ${eur(main.ref)}</div>` : ""}</td></tr>
        <tr class="detail" data-for="${esc(c.ms.key)}" hidden><td colspan="8">${menuDetail(c)}</td></tr>`;
    }, renderMenus);
    $$("#menu-table .menu-row").forEach((tr) => tr.addEventListener("click", () => {
      const d = $(`#menu-table tr.detail[data-for="${CSS.escape(tr.dataset.key)}"]`);
      d.hidden = !d.hidden; tr.classList.toggle("open", !d.hidden);
    }));
    if (rows.length === 1) { const d = $("#menu-table tr.detail"); if (d) { d.hidden = false; } }
  }

  function mainItem(c) {
    return c.items.find((x) => x.step.type === "BURGER") || c.items.find((x) => x.p.role === "plat") || c.items[0];
  }

  function menuDetail(c) {
    const size = c.ms.size;
    const rows = c.items.map((x) => {
      const others = x.step.opts.slice().sort((a, b) => (b.ref - E.supOf(b, size)) - (a.ref - E.supOf(a, size)));
      return `<tr>
        <td><span class="badge">${STEP_LABEL[x.step.type] || x.step.type}</span></td>
        <td class="namecell">${img(x.p.img, "thumb sm")}<b>${esc(x.p.n)}</b></td>
        <td class="num">${x.ref == null ? '<span class="muted">non vendu seul</span>' : eur(x.ref) + (x.p.refApprox ? ' <span class="badge warn" title="Non vendu seul : prix catalogue">≈</span>' : "")}</td>
        <td class="num">${x.sup ? (x.sup > 0 ? "+" : "") + eur(x.sup) : "—"}</td>
        <td class="num hl">${eur(x.alloc)}</td>
        <td class="num">${x.marginal == null ? "—" : eur(x.marginal)}</td>
        <td class="num">${x.p.kcal != null ? n0(x.p.kcal) : "—"}</td>
        <td><details><summary>${x.step.opts.length} choix</summary><ul class="opts">${others.map((o) => {
          const sp = E.supOf(o, size);
          return `<li class="${o === x.p ? "chosen" : ""}">${esc(o.n)} <span class="muted">carte ${eur(o.ref)}${sp ? ` · suppl. ${eur(sp)}` : ""}${o.kcal != null ? ` · ${n0(o.kcal)} kcal` : ""}</span></li>`;
        }).join("")}</ul></details></td></tr>`;
    }).join("");
    return `<div class="detail-box">
      <div class="detail-sum">Tu paies <b>${eur(c.paid)}</b> (menu ${eur(c.ms.price)}${c.paid !== c.ms.price ? ` + suppléments ${eur(c.paid - c.ms.price)}` : ""})
      ${c.ref == null ? `· certains éléments ne sont pas vendus seuls, le coût unitaire est réparti au prorata des calories`
        : `pour <b>${eur(c.ref)}</b> de produits à la carte → <b class="${c.saving >= 0 ? "good" : "bad"}">${c.saving >= 0 ? "tu gagnes" : "tu perds"} ${eur(Math.abs(c.saving))}</b>`}
      · ${n0(c.kcal)} kcal · ${n0(c.prot)} g prot.</div>
      <table class="data inner"><thead><tr><th>Étape</th><th>Élément</th><th class="num">Prix seul</th><th class="num">Suppl.</th>
      <th class="num" title="Prix payé réparti au prorata des prix à la carte">Coût unitaire</th>
      <th class="num" title="Ce que cet élément te coûte en plus si tu achetais tout le reste à la carte">Coût marginal</th>
      <th class="num">kcal</th><th>Options</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  /* ------------------------------------------------------------ PRODUITS */
  function renderProducts() {
    if (!state.model) return;
    const q = E.norm($("#prod-search").value), role = $("#prod-role").value;
    const st = state.stats.p, R = state.restaurants;
    const rows = [...state.model.products.values()].filter((p) => p.alone && p.price > 0 && (!role || p.role === role) && (!q || E.norm(p.n).includes(q)));
    const cols = [
      { k: "n", h: "Produit", v: (p) => p.n },
      { k: "role", h: "Catégorie", v: (p) => E.ROLE_LABEL[p.role] || p.role },
      { k: "price", h: "Prix", num: 1, v: (p) => p.price },
      { k: "fr", h: "vs France", num: 1, v: (p) => st[p.plu] ? p.price / st[p.plu].med : Infinity, title: "Écart à la médiane France" },
      { k: "kcal", h: "kcal", num: 1, dir: -1, v: (p) => p.kcal ?? -1 },
      { k: "kcalPerEuro", h: "€/1000 kcal", num: 1, v: (p) => per1000(p.price, p.kcal) },
      { k: "prot", h: "Prot. (g)", num: 1, dir: -1, v: (p) => p.prot ?? -1 },
      { k: "protEur", h: "€/10 g prot.", num: 1, v: (p) => per10g(p.price, p.prot) },
      { k: "pcs", h: "€/pièce", num: 1, v: (p) => p.pcs ? p.price / p.pcs : Infinity },
    ];
    sortable($("#prod-table"), "produits", cols, rows, (p) => {
      const s = st[p.plu];
      const cheap = s ? s.cheap.slice(0, 3).map((id) => R.find((r) => r.id === id)?.name).filter(Boolean).join(", ") : "";
      const diff = s ? p.price / s.med - 1 : null;
      return `<tr><td class="namecell">${img(p.img)}<b>${esc(p.n)}</b></td>
        <td><span class="badge role-${p.role}">${esc(E.ROLE_LABEL[p.role] || p.role)}</span></td>
        <td class="num">${eur(p.price)}</td>
        <td class="num ${diff > 0.02 ? "bad" : diff < -0.02 ? "good" : ""}" title="${s ? `Min ${eur(s.min)} (${esc(cheap)}) · méd. ${eur(s.med)} · max ${eur(s.max)}` : ""}">${diff == null ? "—" : (diff > 0 ? "+" : "") + pct(diff)}<div class="muted small">${s ? `min ${eur(s.min)}` : ""}</div></td>
        <td class="num">${n0(p.kcal)}</td><td class="num hl">${eur(per1000(p.price, p.kcal))}</td>
        <td class="num">${n1(p.prot)}</td><td class="num">${eur(per10g(p.price, p.prot))}</td>
        <td class="num">${p.pcs ? eur(p.price / p.pcs) + `<div class="muted small">${p.pcs} pcs</div>` : "—"}</td></tr>`;
    }, renderProducts);
  }

  /* ------------------------------------------------------------ OPTIMISEUR */
  function runOptim() {
    const obj = $("#o-obj").value;
    const maxQty = Math.max(1, Math.min(10, +$("#o-max").value || 1));
    const roles = new Set($$("#o-roles input:checked").map((i) => i.value));
    const targetMode = $("#optim-mode .on").dataset.mode === "target";
    const cfgMode = obj === "value" ? "value" : obj;
    const items = E.offers(state.model, cfgMode).filter((o) => roles.has(o.role));
    const budget = Math.round((+$("#o-budget").value || 0) * 100);
    const cap = targetMode ? 10000 : Math.min(10000, budget);
    const t0 = performance.now();
    const ks = E.knapsack(items, obj, maxQty, cap);
    const unit = { kcal: " kcal", prot: " g de protéines", burgers: " burgers/plats", pcs: " pièces", value: "" }[obj];
    let target = +$("#o-target").value || 0;
    if (obj === "value") target = Math.round(target * 100);
    const res = targetMode ? ks.target(target) : ks.budget(budget);
    const ms = Math.round(performance.now() - t0);
    if (!res || !res.lines.length) {
      $("#optim-result").innerHTML = `<p class="err">Aucune combinaison trouvée ${targetMode ? "sous 100 € — objectif trop élevé ?" : "dans ce budget."}</p>`;
      return;
    }
    const fmtObj = (v) => obj === "value" ? eur(v) : n0(v) + unit;
    res.lines.sort((a, b) => b.o.price * b.q - a.o.price * a.q);
    $("#optim-result").innerHTML = `
      <h2>${targetMode ? `${fmtObj(target)} pour ${eur(res.price)}` : `${fmtObj(obj === "value" ? res.value : res[obj])} pour ${eur(res.price)}`}</h2>
      <div class="kpis">
        <div><b>${eur(res.price)}</b><span>total</span></div>
        <div><b>${n0(res.kcal)}</b><span>kcal</span></div>
        <div><b>${n0(res.prot)} g</b><span>protéines</span></div>
        <div><b>${res.burgers}</b><span>burgers/plats</span></div>
        <div><b>${eur(res.value)}</b><span>valeur à la carte</span></div>
        <div><b>${eur(per1000(res.price, res.kcal))}</b><span>/ 1000 kcal</span></div>
      </div>
      <table class="data"><thead><tr><th>Qté</th><th>Article</th><th class="num">Prix</th><th class="num">kcal</th><th class="num">Prot.</th></tr></thead><tbody>
      ${res.lines.map(({ o, q }) => `<tr><td><b>${q}×</b></td><td class="namecell">${img(o.img)}<div><b>${esc(o.label)}</b>${o.cfg ? `<div class="muted small">${cfgShort(o.cfg)}</div>` : ""}</div></td>
        <td class="num">${eur(o.price * q)}</td><td class="num">${n0(o.kcal * q)}</td><td class="num">${n0(o.prot * q)}</td></tr>`).join("")}
      </tbody></table>
      <p class="muted small">Optimum exact (sac à dos borné, ${items.length} offres, ${ms} ms). Les menus sont pris dans leur version maxée pour l'objectif choisi.</p>`;
  }

  /* ------------------------------------------------------------ DUEL */
  function keyMetrics(model) {
    const all = E.offers(model, "kcal").filter((o) => o.price > 0);
    const food = all.filter((o) => !["boisson", "sauce"].includes(o.role));
    const burgers = [...model.products.values()].filter((p) => p.alone && p.price > 0 && p.role === "plat").sort((a, b) => a.price - b.price);
    const kcal = food.filter((o) => o.kcal > 0).map((o) => ({ o, v: per1000(o.price, o.kcal) })).sort((a, b) => a.v - b.v)[0];
    const prot = all.filter((o) => o.prot > 0 && o.role !== "sauce").map((o) => ({ o, v: per10g(o.price, o.prot) })).sort((a, b) => a.v - b.v)[0];
    const perBurger = model.menus.map((ms) => E.configure(ms, "burgers")).filter((c) => c.burgers >= 1)
      .map((c) => ({ c, v: c.paid / c.burgers })).sort((a, b) => a.v - b.v)[0];
    const cheapMenu = model.menus.filter((ms) => !ms.kids).map((ms) => E.configure(ms, "default")).sort((a, b) => a.paid - b.paid)[0];
    const ten = E.knapsack(food, "kcal", 3, 1000).budget(1000);
    const cheese = [...model.products.values()].find((p) => p.alone && /^cheeseburger$/i.test(p.n));
    const nugget = all.filter((o) => o.pcs > 0 && o.role === "poulet").map((o) => ({ o, v: o.price / o.pcs })).sort((a, b) => a.v - b.v)[0];
    return [
      { k: "Burger seul le moins cher", v: burgers[0]?.price, show: (m) => `<b>${eur(m.v)}</b><span class="muted">${esc(burgers[0]?.n || "")}</span>` },
      { k: "Cheeseburger", v: cheese?.price, show: (m) => `<b>${eur(m.v)}</b>` },
      { k: "Menu adulte le moins cher", v: cheapMenu?.paid, show: (m) => `<b>${eur(m.v)}</b><span class="muted">${esc(cheapMenu ? cheapMenu.ms.n + " (" + cheapMenu.ms.size + ")" : "")}</span>` },
      { k: "Meilleur prix par burger (en menu)", v: perBurger?.v, show: (m) => `<b>${eur(m.v)}</b><span class="muted">${esc(perBurger ? perBurger.c.ms.n + " (" + perBurger.c.ms.size + ")" : "")}</span>` },
      { k: "Ce qui cale le plus : € / 1000 kcal", v: kcal?.v, show: (m) => `<b>${eur(m.v)}</b><span class="muted">${esc(kcal?.o.label || "")}</span>` },
      { k: "Protéines : € / 10 g", v: prot?.v, show: (m) => `<b>${eur(m.v)}</b><span class="muted">${esc(prot?.o.label || "")}</span>` },
      { k: "Pièce de poulet la moins chère", v: nugget?.v, show: (m) => `<b>${eur(m.v)}</b><span class="muted">${esc(nugget?.o.label || "")}</span>` },
      { k: "Avec 10 € : calories max", v: ten.kcal, higher: true, show: (m) => `<b>${n0(m.v)} kcal</b><span class="muted">${esc(ten.lines.map((l) => l.q + "× " + l.o.label).join(" + "))} — ${eur(ten.price)}</span>` },
    ];
  }

  async function renderDuel() {
    const box = $("#duel");
    if (!state.resto) return;
    box.innerHTML = `<p class="muted">Chargement du duel…</p>`;
    const sides = [{ chain: state.chain, r: state.resto, model: state.model, d: 0 }];
    const missing = [];
    for (const c of CHAINS) {
      if (c.id === state.chain) continue;
      try {
        const data = await loadChain(c.id);
        const near = state.resto.lat ? nearestIn(data.restaurants, state.resto, 1)[0] : null;
        if (!near) continue;
        const model = E.buildModel(data.catalog, await loadGrid(c.id, near));
        sides.push({ chain: c.id, r: near, model, d: near.d });
      } catch (e) { missing.push(c.name); }
    }
    const mets = sides.map((s) => keyMetrics(s.model));
    const wins = sides.map(() => 0);
    const rows = mets[0].map((row, i) => {
      const vals = mets.map((m) => m[i].v);
      const ok = vals.filter((v) => v != null && isFinite(v));
      const best = ok.length > 1 ? (row.higher ? Math.max(...ok) : Math.min(...ok)) : null;
      const cells = mets.map((m, si) => {
        const v = m[i].v, win = best != null && v === best && ok.filter((x) => x === best).length === 1;
        if (win) wins[si]++;
        return `<td class="${win ? "win" : ""}">${v == null || !isFinite(v) ? '<span class="muted">—</span>' : m[i].show(m[i])}</td>`;
      }).join("");
      return `<tr><td class="metric">${esc(row.k)}</td>${cells}</tr>`;
    }).join("");
    const head = sides.map((s) => `<th>${esc(chainName(s.chain))}<small>${esc(s.r.name)}${s.d ? ` · à ${n1(s.d)} km` : " · ton resto"}</small></th>`).join("");
    const leader = Math.max(...wins);
    const score = sides.map((s, i) => `${esc(chainName(s.chain))} ${wins[i]}`).join(" – ");
    box.innerHTML = sides.length < 2 ? `<p class="muted">Aucun resto d'une autre chaîne trouvé.</p>`
      : `<p class="score">Score : ${score} ${wins.filter((w) => w === leader).length === 1 ? "→ " + esc(chainName(sides[wins.indexOf(leader)].chain)) + " gagne 🏆" : "→ égalité"}</p>
         <div class="duel"><table><thead><tr><th></th>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
    $("#duel-missing").textContent = "McDonald's et KFC ne sont pas comparés : leurs sites bloquent la récupération automatique des prix." + (missing.length ? ` Données indisponibles : ${missing.join(", ")}.` : "");
  }

  /* ------------------------------------------------------------ FRANCE */
  function renderFrance() {
    const R = state.restaurants.filter((r) => r.idx);
    const sorted = [...R].sort((a, b) => a.idx - b.idx);
    const li = (r) => `<li><button class="link" data-id="${r.id}">${esc(r.name)}</button> <span class="muted">${esc(r.city)}</span> <b class="${r.idx > 103 ? "bad" : r.idx < 100 ? "good" : ""}">${n1(r.idx)}</b>${r.d != null ? ` <span class="muted">${n1(r.d)} km</span>` : ""}</li>`;
    $("#cheap-restos").innerHTML = sorted.slice(0, 15).map(li).join("");
    $("#pricey-restos").innerHTML = sorted.slice(-15).reverse().map(li).join("");
    if (state.userPos) {
      const near = nearest(state.userPos, 15).filter((r) => r.idx).sort((a, b) => a.idx - b.idx);
      $("#near-restos").innerHTML = near.map(li).join("");
      $("#near-title").hidden = $("#near-restos").hidden = false;
    }
    const rank = sorted.findIndex((r) => r.id === state.resto.id) + 1;
    const st = state.stats.p, P = state.catalog.products;
    const spread = Object.entries(st).filter(([plu, s]) => P[plu]?.cats?.length && P[plu].role === "plat" && s.n > R.length * 0.5)
      .map(([plu, s]) => ({ n: P[plu].n, s, gap: s.max - s.min })).sort((a, b) => b.gap - a.gap)[0];
    const cheese = Object.entries(st).filter(([plu, s]) => P[plu]?.cats?.length && /^cheeseburger$/i.test(P[plu].n)).map(([, s]) => s)[0];
    const cards = [
      `<article class="card"><div class="card-h"><span class="ico">📍</span>Ton resto</div><div class="big">${rank ? rank + "<small>e / " + sorted.length + "</small>" : "—"}</div><div class="what">${esc(state.resto.name)}</div><div class="sub">indice ${n1(state.resto.idx)} (100 = médiane France)</div></article>`,
      `<article class="card"><div class="card-h"><span class="ico">🏪</span>Restos analysés</div><div class="big">${state.restaurants.length}</div><div class="what">grilles de prix toutes différentes</div><div class="sub">${Object.keys(st).length} produits suivis</div></article>`,
    ];
    if (cheese) cards.push(`<article class="card"><div class="card-h"><span class="ico">🧀</span>Cheeseburger en France</div><div class="big">${eur(cheese.min)} → ${eur(cheese.max)}</div><div class="what">médiane ${eur(cheese.med)}</div><div class="sub">le moins cher : ${esc(state.restaurants.find((r) => r.id === cheese.cheap[0])?.name || "")}</div></article>`);
    if (spread) cards.push(`<article class="card"><div class="card-h"><span class="ico">📈</span>Plus gros écart de prix</div><div class="big">${eur(spread.gap)}</div><div class="what">${esc(spread.n)}</div><div class="sub">de ${eur(spread.s.min)} à ${eur(spread.s.max)}</div></article>`);
    $("#france-cards").innerHTML = cards.join("");
    $$("#tab-france button.link").forEach((b) => b.addEventListener("click", () => { selectResto(b.dataset.id); showTab("top"); window.scrollTo(0, 0); }));
  }

  init();
})();
