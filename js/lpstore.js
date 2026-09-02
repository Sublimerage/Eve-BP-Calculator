'use strict';

// =============================================================================================
// LP Store Calculator
// =============================================================================================
// Ranks every offer in a Faction Warfare loyalty point store by ISK profit per LP spent, so the
// player can see what's actually worth their LP without weighing standing/access requirements
// themselves (those are ignored entirely here - see the corp list note below).
//
// Two offer shapes exist in the ESI response, and this file treats them very differently:
//   - "direct" offers hand over a finished, market-sellable item (ammo, implants, skillbooks, ...).
//     Their value is pure market arithmetic: what the item sells for, minus what the ISK cost and
//     required_items cost to acquire.
//   - "bpc" offers hand over a Blueprint Copy instead of a finished item (recognizable because the
//     offer's own type_id IS a blueprint, not a product - see isBlueprintOffer()). Their value is
//     what building that BPC out actually nets, which means running the same recursive recipe tree
//     pipeline (js/tree.js) the main Calculator and Invention pages already use, under whatever
//     production preset (system/structure/rigs) is currently active - this page has no station
//     picker of its own, exactly like js/invention.js.
//
// Every ESI offer field (isk_cost, lp_cost, required_items) is a flat, static number with no
// tier/standing/participation component anywhere in the schema - confirmed by pulling real offer
// data during development, not assumed. That's why standing is never factored in here: it doesn't
// change the price, only whether you're currently allowed to buy it, which is the player's own
// problem to solve in-game.
// =============================================================================================

// Verified directly against ESI (GET /corporations/{id}/, one at a time) during development - NOT
// hand-typed off a wiki. The 4 main FW warzone corps, one per empire. Worth calling out: the real
// Gallente corp is "Federal Defense Union" (US spelling) - ESI's /universe/ids/ name search also
// resolves a similarly-named but unrelated PLAYER corp, "Federal Defence Union" (British spelling,
// id 98351639, a single-member corp with a chat-log bio) if you search the wrong spelling. This
// list's ids were confirmed via direct corporation lookups, not name search, to avoid that trap.
const FW_WARZONE_CORPS = [
  { corpId: 1000179, corpName: '24th Imperial Crusade', faction: 'Amarr Empire', factionId: 500003, color: '#e0c168' },
  { corpId: 1000180, corpName: 'State Protectorate', faction: 'Caldari State', factionId: 500001, color: '#5b9bd5' },
  { corpId: 1000181, corpName: 'Federal Defense Union', faction: 'Gallente Federation', factionId: 500004, color: '#6fbf73' },
  { corpId: 1000182, corpName: 'Tribal Liberation Force', faction: 'Minmatar Republic', factionId: 500002, color: '#c85a4a' }
];
window.FW_WARZONE_CORPS = FW_WARZONE_CORPS;

let _lpOffersCache = {};      // corpId -> raw ESI offers array
let _lpRankedResults = [];    // last computed, sorted evaluation results
let _lpActiveCorpId = null;
let _lpIsLoading = false;
let _lpTypeFilter = 'all';    // 'all' | 'direct' | 'bpc'
let _lpSortKey = 'iskPerLp';
let _lpSortDir = -1;          // -1 desc, 1 asc
let _lpExpandedOfferIds = new Set();
let _lpResolvedNames = {};    // typeId -> name, for anything eve_db.js's EVE_ITEMS doesn't have
let _lpShoppingList = [];     // {typeId, name, qty, mode: 'sell'|'buy'} - required items the player still needs to go acquire

// --- Item names -----------------------------------------------------------------------------
// eve_db.js's local EVE_ITEMS snapshot doesn't cover every type in the game (SOE/vanity clothing,
// some deadspace variants, etc.) - real LP store offers can and do reference those. Rather than
// showing "Item 4158" forever, anything missing gets resolved live via ESI's /universe/names/
// (works for any category, not just items - one POST per store, id -> name only, no icon/market
// data) and cached here for the rest of the session.

function getLPItemName(typeId) {
  return (window.EVE_ITEMS && window.EVE_ITEMS[typeId]) || _lpResolvedNames[typeId] || `Item ${typeId}`;
}
window.getLPItemName = getLPItemName;

async function resolveMissingItemNames(typeIds) {
  const missing = [...new Set(typeIds)].filter(id => !(window.EVE_ITEMS && window.EVE_ITEMS[id]) && !_lpResolvedNames[id]);
  if (!missing.length) return;
  const chunks = [];
  for (let i = 0; i < missing.length; i += 500) chunks.push(missing.slice(i, i + 500));
  await Promise.all(chunks.map(async (chunk) => {
    try {
      const res = await fetch('https://esi.evetech.net/latest/universe/names/?datasource=tranquility', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(chunk)
      });
      if (!res.ok) return;
      const data = await res.json();
      (data || []).forEach(entry => { _lpResolvedNames[entry.id] = entry.name; });
    } catch (e) { console.warn('[LP Store] Failed to resolve names for', chunk, e); }
  }));
}

// --- Offer fetch --------------------------------------------------------------------------

async function fetchLPStoreOffers(corpId) {
  if (_lpOffersCache[corpId]) return _lpOffersCache[corpId];
  const res = await fetch(`https://esi.evetech.net/latest/loyalty/stores/${corpId}/offers/?datasource=tranquility`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`ESI returned HTTP ${res.status} for corp ${corpId}`);
  const offers = await res.json();
  _lpOffersCache[corpId] = offers;
  return offers;
}
window.fetchLPStoreOffers = fetchLPStoreOffers;

// An offer is a BPC offer when its own type_id resolves to a recipe AND that recipe's
// blueprintTypeID is the offer's type_id itself (recipeMap is keyed by BOTH blueprint and product
// ids - see js/config.js buildPrepackedIndexes - so this check is what tells the two apart).
function isBlueprintOffer(offer) {
  const recipe = window.recipeMap && window.recipeMap[offer.type_id];
  return !!(recipe && parseInt(recipe.blueprintTypeID) === parseInt(offer.type_id));
}

// --- Per-offer evaluation ------------------------------------------------------------------

async function evaluateDirectSellOffer(offer) {
  const ids = [offer.type_id, ...offer.required_items.map(r => r.type_id)];
  await window.fetchMarketPrices(ids);

  // Cost side: what it takes to ACQUIRE the required items right now - the Jita sell/instant-buy
  // price, same convention the rest of the app uses for "cost to get a material in hand".
  // Revenue side: Jita sell price too (this app's existing convention for "what an output is
  // worth" - see js/invention.js's bpcValue calc, matched here rather than diverging), net of
  // sales tax and broker fee so it's an apples-to-apples number with the BPC path below, which
  // already deducts both. Both sides assume you're buying/selling at Jita specifically (same
  // station fetchMarketPrices always uses) - not wherever you'd actually be standing in the
  // warzone.
  const { salesTax, brokerFee } = window.getActiveFeeInputs ? window.getActiveFeeInputs() : { salesTax: 0.036, brokerFee: 0.01 };
  const outputPrice = (window.priceCache[offer.type_id] || {}).sell || 0;
  const grossRevenue = outputPrice * offer.quantity;
  const revenue = grossRevenue * (1 - salesTax - brokerFee);

  let requiredItemsCost = 0;
  offer.required_items.forEach(r => {
    requiredItemsCost += ((window.priceCache[r.type_id] || {}).sell || 0) * r.quantity;
  });

  const cost = offer.isk_cost + requiredItemsCost;
  const profit = revenue - cost;

  return {
    offer, offerType: 'direct',
    outputTypeId: offer.type_id, outputName: getLPItemName(offer.type_id),
    outputQty: offer.quantity,
    revenue, cost, requiredItemsCost, profit,
    lpCost: offer.lp_cost, iskCost: offer.isk_cost,
    iskPerLp: offer.lp_cost > 0 ? profit / offer.lp_cost : null,
    buildSeconds: 0, bpcCopies: 0
  };
}

async function evaluateBpcOffer(offer) {
  const recipe = window.recipeMap[offer.type_id];
  const productTypeId = parseInt(recipe.productTypeID);
  const batchYield = recipe.productQtyPerRun || 1;
  // ESI's offer schema has no field for the granted BPC's run count - FW LP store blueprints are,
  // as a long-standing EVE mechanic, always single-run copies, so each unit of offer.quantity is
  // treated as exactly 1 run. Called out in the UI (see renderLPStoreResults) rather than silently
  // assumed, since it's the one number here ESI itself can't confirm.
  const runs = offer.quantity;

  const priorRootProduct = window.recipeTreeRootProductTypeId;
  window.recipeTreeRootProductTypeId = productTypeId;
  let root;
  try {
    root = await window.buildRecursiveRecipeTree(parseInt(offer.type_id), getLPItemName(offer.type_id), runs, 0, 6, new Set(), null);
  } finally {
    window.recipeTreeRootProductTypeId = priorRootProduct;
  }
  if (!root) return null;

  root.runsNeeded = runs;
  root.qtyNeeded = runs * batchYield;

  const structureType = window.getActiveStructureType ? window.getActiveStructureType() : { meBonus: 1.0, costBonus: 5.0 };
  const facility = structureType.meBonus / 100;
  if (typeof window.scaleTreeQuantities === 'function') window.scaleTreeQuantities(root, facility);

  const allTypeIds = new Set();
  if (typeof window.collectAllTypeIds === 'function') window.collectAllTypeIds(root, allTypeIds);
  offer.required_items.forEach(r => allTypeIds.add(r.type_id));
  allTypeIds.add(productTypeId);
  await window.fetchMarketPrices(Array.from(allTypeIds));

  const materialCost = typeof window.calculateTreeNodeCost === 'function' ? window.calculateTreeNodeCost(root) : 0;

  const { facilityTax, sccSurcharge, salesTax, brokerFee } = window.getActiveFeeInputs ? window.getActiveFeeInputs() : { facilityTax: 0.01, sccSurcharge: 0.04, salesTax: 0.036, brokerFee: 0.01 };
  const structureRoleBonus = structureType.costBonus / 100;
  let jobFee = 0;
  if (typeof window.calculateNodeEIV === 'function' && typeof window.calculateNodeJobFee === 'function') {
    window.calculateNodeEIV(root);
    jobFee = window.calculateNodeJobFee(root, facilityTax, sccSurcharge, structureRoleBonus);
  }

  let requiredItemsCost = 0;
  offer.required_items.forEach(r => {
    requiredItemsCost += ((window.priceCache[r.type_id] || {}).sell || 0) * r.quantity;
  });

  const outputPrice = (window.priceCache[productTypeId] || {}).sell || 0;
  const grossRevenue = outputPrice * root.qtyNeeded;
  const revenue = grossRevenue * (1 - salesTax - brokerFee);

  const cost = offer.isk_cost + requiredItemsCost + materialCost + jobFee;
  const profit = revenue - cost;
  const buildSeconds = typeof window.calculateTotalBuildSeconds === 'function' ? window.calculateTotalBuildSeconds(root) : 0;

  return {
    offer, offerType: 'bpc',
    outputTypeId: productTypeId, outputName: getLPItemName(productTypeId),
    outputQty: root.qtyNeeded,
    revenue, cost, requiredItemsCost, materialCost, jobFee, profit,
    lpCost: offer.lp_cost, iskCost: offer.isk_cost,
    iskPerLp: offer.lp_cost > 0 ? profit / offer.lp_cost : null,
    buildSeconds, bpcCopies: offer.quantity, blueprintTypeId: offer.type_id
  };
}

// --- Orchestration -------------------------------------------------------------------------

async function loadAndRankLPStore(corpId) {
  corpId = parseInt(corpId);
  _lpActiveCorpId = corpId;
  localStorage.setItem('eve_lpstore_last_corp', String(corpId));
  _lpIsLoading = true;
  _lpExpandedOfferIds = new Set();
  renderLPStoreState();

  try {
    const offers = await fetchLPStoreOffers(corpId);

    // Cheap upfront pre-warm: every flat (non-recursive) type_id every offer touches, in one
    // batched call, before any per-offer work starts. fetchMarketPrices no-ops on already-cached
    // ids, so the per-offer eval calls below effectively become free for anything covered here -
    // this just avoids one round trip per offer for prices every offer needs anyway. Name
    // resolution rides along the same collected id set, so anything eve_db.js doesn't know (see
    // resolveMissingItemNames above) gets a real name before a single row renders.
    const flatIds = new Set();
    offers.forEach(o => { flatIds.add(o.type_id); (o.required_items || []).forEach(r => flatIds.add(r.type_id)); });
    await Promise.all([
      window.fetchMarketPrices(Array.from(flatIds)),
      resolveMissingItemNames(Array.from(flatIds))
    ]);

    // buildRecursiveRecipeTree is fully local (recipeMap/EVE_RECIPES, already loaded from
    // eve_db.js - see js/tree.js fetchBlueprintData) - no network happens inside it, so building
    // every BPC offer's tree in parallel here is safe and fast.
    const evaluations = await Promise.all(offers.map(offer => {
      const evalFn = isBlueprintOffer(offer) ? evaluateBpcOffer : evaluateDirectSellOffer;
      return evalFn(offer).catch(e => {
        console.warn('[LP Store] Failed to evaluate offer', offer.offer_id, offer.type_id, e);
        return null;
      });
    }));

    _lpRankedResults = evaluations.filter(Boolean);
  } catch (e) {
    console.error('[LP Store] Failed to load store:', e);
    _lpRankedResults = [];
    _lpIsLoading = false;
    renderLPStoreState(e);
    return;
  }

  _lpIsLoading = false;
  renderLPStoreState();
}
window.loadAndRankLPStore = loadAndRankLPStore;

function selectLPStoreCorp(corpIdStr) {
  if (!corpIdStr) return;
  loadAndRankLPStore(corpIdStr);
}
window.selectLPStoreCorp = selectLPStoreCorp;

function setLPStoreTypeFilter(filter) {
  _lpTypeFilter = filter;
  renderLPStoreState();
}
window.setLPStoreTypeFilter = setLPStoreTypeFilter;

function setLPStoreSort(key) {
  if (_lpSortKey === key) {
    _lpSortDir *= -1;
  } else {
    _lpSortKey = key;
    _lpSortDir = -1;
  }
  renderLPStoreState();
}
window.setLPStoreSort = setLPStoreSort;

function toggleLPOfferExpanded(offerId) {
  if (_lpExpandedOfferIds.has(offerId)) _lpExpandedOfferIds.delete(offerId);
  else _lpExpandedOfferIds.add(offerId);
  renderLPStoreState();
}
window.toggleLPOfferExpanded = toggleLPOfferExpanded;

// --- Send a BPC offer to the Calculator's own tree ---------------------------------------------
// Reuses the Calculator's existing ?build= shared-link format (js/app.js applySharedBuildFromUrl)
// rather than inventing a second hand-off mechanism - this is the exact same link the Invention
// page's "send to Calculator" button already builds (js/invention.js sendInventionRowToCalculator).
// No me/te means the Calculator opens the blueprint as an unresearched ME0/TE0 copy, which is what
// an LP store BPC actually is - the player can dial in real ME/TE themselves once there if their
// eventual redeemed copy differs. Runs come from this offer's own quantity (assumed 1 run/BPC -
// see evaluateBpcOffer's own note on that assumption), so the Calculator opens already scaled to
// what THIS offer would actually produce, not a default of 1.
function sendLPOfferToCalculator(offerId) {
  const result = _lpRankedResults.find(r => r.offer.offer_id === offerId);
  if (!result || result.offerType !== 'bpc') return;
  const state = { id: result.blueprintTypeId, name: getLPItemName(result.blueprintTypeId), runs: result.bpcCopies };
  const encoded = btoa(encodeURIComponent(JSON.stringify(state)));
  window.location.href = `index.html?build=${encoded}`;
}
window.sendLPOfferToCalculator = sendLPOfferToCalculator;

// --- Shopping list (required items still needing to be acquired) --------------------------------
// A deliberately lightweight, standalone list - NOT a Ledger job. These are plain market purchases
// with no build step of their own, so folding them into the Ledger's job model (which assumes a
// blueprint/materials/runs) would mean teaching that already-intricate system a whole new kind of
// "job" for no real benefit. This lives entirely on this page, persisted so it survives a reload.

function loadLPShoppingList() {
  _lpShoppingList = window.safeParseJSON(localStorage.getItem('eve_lpstore_shopping_list'), []);
}

function saveLPShoppingList() {
  localStorage.setItem('eve_lpstore_shopping_list', JSON.stringify(_lpShoppingList));
}

function addOfferRequiredItemsToShoppingList(offerId) {
  const result = _lpRankedResults.find(r => r.offer.offer_id === offerId);
  if (!result || !result.offer.required_items.length) return;
  result.offer.required_items.forEach(ri => {
    const existing = _lpShoppingList.find(x => x.typeId === ri.type_id);
    if (existing) existing.qty += ri.quantity;
    else _lpShoppingList.push({ typeId: ri.type_id, name: getLPItemName(ri.type_id), qty: ri.quantity, mode: 'sell' });
  });
  saveLPShoppingList();
  renderLPShoppingList();
  if (typeof window.showToast === 'function') window.showToast('Added to shopping list.', 'success');
}
window.addOfferRequiredItemsToShoppingList = addOfferRequiredItemsToShoppingList;

function setLPShoppingItemMode(typeId, mode) {
  const item = _lpShoppingList.find(x => x.typeId === typeId);
  if (!item) return;
  item.mode = mode;
  saveLPShoppingList();
  renderLPShoppingList();
}
window.setLPShoppingItemMode = setLPShoppingItemMode;

function setLPShoppingItemQty(typeId, qty) {
  const item = _lpShoppingList.find(x => x.typeId === typeId);
  if (!item) return;
  item.qty = Math.max(1, parseInt(qty) || 1);
  saveLPShoppingList();
  renderLPShoppingList();
}
window.setLPShoppingItemQty = setLPShoppingItemQty;

function removeLPShoppingItem(typeId) {
  _lpShoppingList = _lpShoppingList.filter(x => x.typeId !== typeId);
  saveLPShoppingList();
  renderLPShoppingList();
}
window.removeLPShoppingItem = removeLPShoppingItem;

function clearLPShoppingList() {
  _lpShoppingList = [];
  saveLPShoppingList();
  renderLPShoppingList();
}
window.clearLPShoppingList = clearLPShoppingList;

function copyLPShoppingListMultibuy(btn) {
  const text = _lpShoppingList.map(i => `${i.name}\t${i.qty}`).join('\n');
  if (typeof window.copyToClipboardWithFeedback === 'function') window.copyToClipboardWithFeedback(text, btn);
}
window.copyLPShoppingListMultibuy = copyLPShoppingListMultibuy;

function renderLPShoppingList() {
  const badge = document.getElementById('lpstore-shopping-count');
  if (badge) badge.textContent = String(_lpShoppingList.length);

  const el = document.getElementById('lpstore-shopping-list-body');
  if (!el) return;

  if (!_lpShoppingList.length) {
    el.innerHTML = `<div class="text-[11px] italic py-3 text-center" style="color:var(--text-mute);">Nothing yet - expand an offer below and add its required items.</div>`;
    return;
  }

  let total = 0;
  const rows = _lpShoppingList.map(item => {
    const priceEntry = window.priceCache && window.priceCache[item.typeId];
    const unitPrice = priceEntry ? (item.mode === 'buy' ? (priceEntry.buy || 0) : (priceEntry.sell || 0)) : 0;
    const lineTotal = unitPrice * item.qty;
    total += lineTotal;
    return `
      <div class="flex items-center gap-2 py-1.5 text-[11px] mono" style="border-bottom:1px solid rgba(255,255,255,0.05);">
        <span class="truncate flex-1 min-w-0" style="color:var(--text);">${window.esc(item.name)}</span>
        <input type="number" min="1" value="${item.qty}" onchange="setLPShoppingItemQty(${item.typeId}, this.value)" class="field-line w-16 text-center p-1 text-[11px]">
        <div class="flex rounded overflow-hidden flex-shrink-0" style="border:1px solid rgba(255,255,255,0.1);">
          <button onclick="setLPShoppingItemMode(${item.typeId}, 'sell')" class="px-1.5 py-1 text-[10px]" style="background:${item.mode === 'sell' ? 'var(--accent)' : 'transparent'}; color:${item.mode === 'sell' ? '#0a1002' : 'var(--text-mute)'};" title="Price at Jita sell/instant-buy">Sell</button>
          <button onclick="setLPShoppingItemMode(${item.typeId}, 'buy')" class="px-1.5 py-1 text-[10px]" style="background:${item.mode === 'buy' ? 'var(--accent)' : 'transparent'}; color:${item.mode === 'buy' ? '#0a1002' : 'var(--text-mute)'};" title="Price at Jita highest buy order (patient buy order, not instant)">Buy</button>
        </div>
        <span class="text-right flex-shrink-0" style="width:80px; color:var(--text-mute);">${Math.round(lineTotal).toLocaleString()}</span>
        <button onclick="removeLPShoppingItem(${item.typeId})" class="flex-shrink-0" style="color:var(--text-mute);" title="Remove">${window.svgIcon ? window.svgIcon('x') : '×'}</button>
      </div>`;
  }).join('');

  el.innerHTML = `
    ${rows}
    <div class="flex items-center justify-between pt-2 mt-1 text-[11px] mono font-bold">
      <span style="color:var(--text-mute);">Total</span>
      <span style="color:var(--accent);">${Math.round(total).toLocaleString()} ISK</span>
    </div>`;
}
window.renderLPShoppingList = renderLPShoppingList;

// --- Rendering -------------------------------------------------------------------------------

function getLPStoreIconUrl(typeId, isBpc) {
  return `https://images.evetech.net/types/${typeId}/${isBpc ? 'bpc' : 'icon'}?size=32`;
}

function renderLPStoreState(err) {
  const emptyState = document.getElementById('lpstore-empty-state');
  const loadingState = document.getElementById('lpstore-loading-state');
  const errorState = document.getElementById('lpstore-error-state');
  const resultsArea = document.getElementById('lpstore-results-area');
  [emptyState, loadingState, errorState, resultsArea].forEach(el => el && el.classList.add('hidden'));

  if (err) {
    if (errorState) { errorState.classList.remove('hidden'); errorState.textContent = `Failed to load this store's offers: ${err.message || err}`; }
    return;
  }
  if (_lpIsLoading) {
    if (loadingState) loadingState.classList.remove('hidden');
    return;
  }
  if (!_lpActiveCorpId) {
    if (emptyState) emptyState.classList.remove('hidden');
    return;
  }
  if (resultsArea) resultsArea.classList.remove('hidden');

  renderLPStoreSummaryTiles();
  renderLPStoreTable();
  // Shopping list prices come from window.priceCache, which just got a fresh batch of entries from
  // this same load - re-render so list items added before this store's prices arrived (or added from
  // a previous corp) don't keep showing a stale/zero price.
  renderLPShoppingList();
}

function renderLPStoreSummaryTiles() {
  const el = document.getElementById('lpstore-summary-tiles');
  if (!el) return;
  const total = _lpRankedResults.length;
  const profitable = _lpRankedResults.filter(r => r.profit > 0).length;
  const best = _lpRankedResults.filter(r => r.iskPerLp !== null).sort((a, b) => b.iskPerLp - a.iskPerLp)[0];
  const bpcCount = _lpRankedResults.filter(r => r.offerType === 'bpc').length;

  el.innerHTML = `
    <div class="lp-card p-3">
      <div class="text-[10px] uppercase tracking-wider" style="color:var(--text-mute);">Total Offers</div>
      <div class="text-xl font-bold mono text-white">${total}</div>
    </div>
    <div class="lp-card p-3">
      <div class="text-[10px] uppercase tracking-wider" style="color:var(--text-mute);">Profitable</div>
      <div class="text-xl font-bold mono" style="color:var(--accent);">${profitable}</div>
    </div>
    <div class="lp-card p-3">
      <div class="text-[10px] uppercase tracking-wider" style="color:var(--text-mute);">Blueprint Offers</div>
      <div class="text-xl font-bold mono text-white">${bpcCount}</div>
    </div>
    <div class="lp-card p-3">
      <div class="text-[10px] uppercase tracking-wider" style="color:var(--text-mute);">Best ISK / LP</div>
      <div class="text-xl font-bold mono" style="color:var(--accent);">${best ? Math.round(best.iskPerLp).toLocaleString() : '—'}</div>
    </div>
  `;
}

function sortIndicator(key) {
  if (_lpSortKey !== key) return '';
  return _lpSortDir === -1 ? ' ▼' : ' ▲';
}

function renderLPStoreTable() {
  const el = document.getElementById('lpstore-table-container');
  if (!el) return;

  let rows = _lpRankedResults.slice();
  if (_lpTypeFilter !== 'all') rows = rows.filter(r => r.offerType === _lpTypeFilter);
  rows.sort((a, b) => {
    const av = a[_lpSortKey], bv = b[_lpSortKey];
    const an = (av === null || av === undefined) ? -Infinity : av;
    const bn = (bv === null || bv === undefined) ? -Infinity : bv;
    return (an - bn) * _lpSortDir;
  });

  if (!rows.length) {
    el.innerHTML = `<div class="text-center py-10 italic" style="color:var(--text-mute);">No offers match this filter.</div>`;
    return;
  }

  const rowsHTML = rows.map(r => {
    const offer = r.offer;
    const isBpc = r.offerType === 'bpc';
    const iconUrl = getLPStoreIconUrl(r.outputTypeId, isBpc);
    const profitColor = r.profit > 0 ? 'var(--accent)' : 'var(--red-400, #f87171)';
    const iskPerLpDisplay = r.iskPerLp === null ? '—' : Math.round(r.iskPerLp).toLocaleString();
    const expanded = _lpExpandedOfferIds.has(offer.offer_id);
    // onerror is chained twice: /icon -> /render (covers most things, e.g. blueprints only have a
    // render, not an icon) -> finally hide the broken-image box entirely rather than show it, for
    // the handful of type_ids (SOE/vanity clothing, oddities) with neither.
    const iconFallback = `this.onerror=function(){this.style.visibility='hidden';}; this.src='https://images.evetech.net/types/${r.outputTypeId}/render?size=32';`;

    const typeBadge = isBpc
      ? `<span class="text-[9px] mono px-1.5 py-0.5 rounded flex-shrink-0" style="background:rgba(192,132,252,0.15); color:#c084fc;" title="Redeeming this offer grants a Blueprint Copy - value shown is what building it out nets, not the BPC's own resale value.">BPC</span>`
      : `<span class="text-[9px] mono px-1.5 py-0.5 rounded flex-shrink-0" style="background:rgba(56,189,248,0.15); color:#38bdf8;">ITEM</span>`;

    // Visible without expanding - the actual reason two rows can share an item name (CCP offers
    // the same reward through several different LP/ISK/item combinations; each is a distinct
    // offer_id, not a data glitch - see resolveMissingItemNames's neighbor note in js/lpstore.js
    // dev notes). Previously only visible after a click, which read as duplicate junk.
    const requiredItemsSummary = offer.required_items.length
      ? offer.required_items.map(r2 => `${r2.quantity}x ${window.esc(getLPItemName(r2.type_id))}`).join(', ')
      : (offer.isk_cost > 0 ? 'ISK + LP only' : 'LP only');

    let detailHTML = '';
    if (expanded) {
      const addToListBtn = offer.required_items.length
        ? `<button onclick="event.stopPropagation(); addOfferRequiredItemsToShoppingList(${offer.offer_id});" class="btn-glass btn-glass-muted px-2.5 py-1 text-[10px]">+ Add Required Items to Shopping List</button>`
        : '';
      const buildBtn = isBpc
        ? `<button onclick="event.stopPropagation(); sendLPOfferToCalculator(${offer.offer_id});" class="btn-glass px-2.5 py-1 text-[10px]" title="Opens this blueprint in the main Calculator's tree, scaled to ${r.bpcCopies} run${r.bpcCopies === 1 ? '' : 's'}, so you can optimize the build and Add to Ledger from there.">Build This BPC →</button>`
        : '';
      detailHTML = `
        <tr class="lp-detail-row">
          <td colspan="7" class="px-3 pb-3">
            <div class="rounded-md p-3 text-[11px] mono" style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.06);">
              <div class="grid grid-cols-2 gap-x-6 gap-y-1.5">
                <div><span style="color:var(--text-mute);">ISK Cost:</span> ${Math.round(offer.isk_cost).toLocaleString()} ISK</div>
                <div><span style="color:var(--text-mute);">LP Cost:</span> ${offer.lp_cost.toLocaleString()} LP</div>
                <div><span style="color:var(--text-mute);">Required Items (at Jita sell):</span> ${Math.round(r.requiredItemsCost).toLocaleString()} ISK</div>
                <div><span style="color:var(--text-mute);">Grants:</span> ${r.outputQty.toLocaleString()}x ${window.esc(r.outputName)}</div>
                ${isBpc ? `<div><span style="color:var(--text-mute);">Material Cost to Build:</span> ${Math.round(r.materialCost).toLocaleString()} ISK</div>` : ''}
                ${isBpc ? `<div><span style="color:var(--text-mute);">Job Install Fee:</span> ${Math.round(r.jobFee).toLocaleString()} ISK</div>` : ''}
                ${isBpc ? `<div><span style="color:var(--text-mute);">Build Time:</span> ${r.buildSeconds > 0 ? window.formatDurationCompact(r.buildSeconds) : 'no time data'}</div>` : ''}
                ${isBpc ? `<div><span style="color:var(--text-mute);">BPCs Granted:</span> ${r.bpcCopies} (assumed 1 run each - see note below)</div>` : ''}
              </div>
              <div class="mt-2 pt-2" style="border-top:1px solid rgba(255,255,255,0.06); color:var(--text-mute);">
                Turned in: ${requiredItemsSummary}
              </div>
              ${(addToListBtn || buildBtn) ? `<div class="mt-2.5 pt-2.5 flex gap-2" style="border-top:1px solid rgba(255,255,255,0.06);">${buildBtn}${addToListBtn}</div>` : ''}
            </div>
          </td>
        </tr>`;
    }

    return `
      <tr class="lp-store-row cursor-pointer" onclick="toggleLPOfferExpanded(${offer.offer_id})" title="Click for a full cost/value breakdown">
        <td class="py-1.5">
          <div class="flex items-center gap-2 min-w-0">
            <img src="${iconUrl}" alt="" class="w-6 h-6 rounded flex-shrink-0" loading="lazy" onerror="${iconFallback}">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-1.5">
                <span class="truncate font-semibold text-white">${window.esc(r.outputName)}</span>
                ${typeBadge}
              </div>
              <div class="truncate text-[10px]" style="color:var(--text-mute);">${requiredItemsSummary}</div>
            </div>
          </div>
        </td>
        <td class="text-right mono">${offer.lp_cost.toLocaleString()}</td>
        <td class="text-right mono">${Math.round(r.cost).toLocaleString()}</td>
        <td class="text-right mono">${Math.round(r.revenue).toLocaleString()}</td>
        <td class="text-right mono font-bold" style="color:${profitColor};">${Math.round(r.profit).toLocaleString()}</td>
        <td class="text-right mono font-bold" style="color:${profitColor};">${iskPerLpDisplay}</td>
        <td class="text-right" style="color:var(--text-mute);">${isBpc && r.buildSeconds > 0 ? window.formatDurationCompact(r.buildSeconds) : '—'}</td>
      </tr>
      ${detailHTML}`;
  }).join('');

  el.innerHTML = `
    <table class="lp-table text-xs mono w-full">
      <thead>
        <tr>
          <th>Item</th>
          <th class="text-right cursor-pointer" onclick="setLPStoreSort('lpCost')">LP Cost${sortIndicator('lpCost')}</th>
          <th class="text-right cursor-pointer" onclick="setLPStoreSort('cost')" title="ISK cost + required items, all priced at Jita sell/instant-buy - plus material cost and job install fee for BPC offers.">Total Cost${sortIndicator('cost')}</th>
          <th class="text-right cursor-pointer" onclick="setLPStoreSort('revenue')" title="Output priced at Jita sell, net of your Sales Tax and Broker Fee settings (left sidebar).">Est. Value${sortIndicator('revenue')}</th>
          <th class="text-right cursor-pointer" onclick="setLPStoreSort('profit')">Est. Profit${sortIndicator('profit')}</th>
          <th class="text-right cursor-pointer" onclick="setLPStoreSort('iskPerLp')" title="Estimated ISK profit per LP spent - the ranking metric.">ISK / LP${sortIndicator('iskPerLp')}</th>
          <th class="text-right">Build Time</th>
        </tr>
      </thead>
      <tbody>${rowsHTML}</tbody>
    </table>
  `;
}

// --- Shared tax/fee settings (same pattern + localStorage key as js/invention.js, kept in sync
//     across pages since app.js isn't loaded here) --------------------------------------------

function loadSharedTaxSettingsForLPStore() {
  try {
    const saved = localStorage.getItem('eve_tax_settings');
    if (!saved) return;
    const settings = window.safeParseJSON(saved, {});
    if (settings.facilityTax !== undefined && document.getElementById('facility-tax')) document.getElementById('facility-tax').value = settings.facilityTax;
    if (settings.sccSurcharge !== undefined && document.getElementById('scc-surcharge')) document.getElementById('scc-surcharge').value = settings.sccSurcharge;
    if (settings.salesTax !== undefined && document.getElementById('sales-tax')) document.getElementById('sales-tax').value = settings.salesTax;
    if (settings.brokerFee !== undefined && document.getElementById('broker-fee')) document.getElementById('broker-fee').value = settings.brokerFee;
  } catch (e) { console.warn('[LP Store] Failed to load saved tax/fee settings - falling back to defaults:', e); }
}
window.loadSharedTaxSettingsForLPStore = loadSharedTaxSettingsForLPStore;

function saveSharedTaxSettingsFromLPStore() {
  try {
    const existingRaw = localStorage.getItem('eve_tax_settings');
    const existing = existingRaw ? window.safeParseJSON(existingRaw, {}) : {};
    existing.facilityTax = document.getElementById('facility-tax')?.value;
    existing.sccSurcharge = document.getElementById('scc-surcharge')?.value;
    existing.salesTax = document.getElementById('sales-tax')?.value;
    existing.brokerFee = document.getElementById('broker-fee')?.value;
    localStorage.setItem('eve_tax_settings', JSON.stringify(existing));
  } catch (e) { console.warn('[LP Store] Failed to save tax/fee settings - they will reset on next reload:', e); }
  if (_lpActiveCorpId) loadAndRankLPStore(_lpActiveCorpId);
}
window.saveSharedTaxSettingsFromLPStore = saveSharedTaxSettingsFromLPStore;

// Same "currently active station" label pattern as js/invention.js - synthesized from whatever
// system/structure/rigs are currently active in localStorage, since this page has no picker of its
// own (BPC offers are valued under the currently active production preset, matching decision made
// with the user - change it from the Calculator, not here).
function renderLPStoreActiveStationLabel() {
  const el = document.getElementById('lpstore-active-station-label');
  if (!el) return;
  const sel = window.safeParseJSON(localStorage.getItem('eve_selected_system'), {});
  const facilityKey = localStorage.getItem('eve_active_facility_key') || 'sotiyo';
  const rig1 = localStorage.getItem('eve_rig_slot_1') || '';
  const rig2 = localStorage.getItem('eve_rig_slot_2') || '';
  const rig3 = localStorage.getItem('eve_rig_slot_3') || '';

  const structureLabel = (window.STRUCTURE_TYPES && window.STRUCTURE_TYPES[facilityKey] && window.STRUCTURE_TYPES[facilityKey].shortLabel) || facilityKey;
  const rigCount = [rig1, rig2, rig3].filter(Boolean).length;
  const rigLabel = rigCount > 0 ? `, ${rigCount} rig${rigCount > 1 ? 's' : ''}` : ', no rigs';
  el.textContent = sel.name ? `${structureLabel} @ ${sel.name}${rigLabel}` : `${structureLabel}${rigLabel}`;
}
window.renderLPStoreActiveStationLabel = renderLPStoreActiveStationLabel;

function populateLPStoreCorpSelect() {
  const select = document.getElementById('lpstore-corp-select');
  if (!select) return;
  select.innerHTML = '<option value="">— Choose a warzone LP store —</option>' +
    FW_WARZONE_CORPS.map(c => `<option value="${c.corpId}" style="color:${c.color}; font-weight:bold;">${window.esc(c.faction)} — ${window.esc(c.corpName)}</option>`).join('');
}

window.onload = async () => {
  if (typeof window.buildPrepackedIndexes === 'function') window.buildPrepackedIndexes();
  populateLPStoreCorpSelect();
  loadSharedTaxSettingsForLPStore();
  renderLPStoreActiveStationLabel();
  loadLPShoppingList();
  renderLPShoppingList();
  renderLPStoreState();

  if (typeof window.handleEsiSSOCallback === 'function') {
    try { await window.handleEsiSSOCallback(); } catch (e) { console.error('SSO callback error:', e); }
  }
  if (typeof window.loadSavedSystem === 'function') {
    try { await window.loadSavedSystem(); } catch (e) { console.warn('[LP Store] SCI load failed:', e); }
  }
  if (typeof window.fetchAdjustedPrices === 'function') {
    try { await window.fetchAdjustedPrices(); } catch (e) { console.warn('[LP Store] Adjusted prices fetch error:', e); }
  }
  renderLPStoreActiveStationLabel();

  const lastCorp = localStorage.getItem('eve_lpstore_last_corp');
  const select = document.getElementById('lpstore-corp-select');
  if (lastCorp && select) {
    select.value = lastCorp;
    loadAndRankLPStore(lastCorp);
  }
};
