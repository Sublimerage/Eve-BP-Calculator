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
//
// A BPC offer's "Isolate" button hands off to the Calculator's OWN tree canvas and Bill of
// Materials sidebar (js/app.js, also loaded on this page) rather than a lookalike rebuild - see
// isolateOffer() below and the plan this was built from for why. The one new capability that adds
// - acquiring a component via this store's own LP offer instead of building or buying it - is a
// small guarded addition to js/app.js's createNodeCard and js/optimizers.js's
// calculateTreeNodeCost, inert everywhere except when window.__lpOfferByOutputTypeId has a match.
// =============================================================================================

// Verified directly against ESI (GET /corporations/{id}/, one at a time) during development - NOT
// hand-typed off a wiki. The 4 main FW warzone corps, one per empire. Worth calling out: the real
// Gallente corp is "Federal Defense Union" (US spelling) - ESI's /universe/ids/ name search also
// resolves a similarly-named but unrelated PLAYER corp, "Federal Defence Union" (British spelling,
// id 98351639, a single-member corp with a chat-log bio) if you search the wrong spelling. This
// list's ids were confirmed via direct corporation lookups, not name search, to avoid that trap.
//
// Pirate faction stores added the same way - verified via ESI's own /universe/factions/ endpoint,
// which carries each faction's own corporation_id directly (no name-search trap possible), then
// confirmed each one actually has a real loyalty store by fetching its offers live.
const FW_WARZONE_CORPS = [
  { corpId: 1000179, corpName: '24th Imperial Crusade', faction: 'Amarr Empire', factionId: 500003, color: '#e0c168', group: 'Faction Warfare' },
  { corpId: 1000180, corpName: 'State Protectorate', faction: 'Caldari State', factionId: 500001, color: '#5b9bd5', group: 'Faction Warfare' },
  { corpId: 1000181, corpName: 'Federal Defense Union', faction: 'Gallente Federation', factionId: 500004, color: '#6fbf73', group: 'Faction Warfare' },
  { corpId: 1000182, corpName: 'Tribal Liberation Force', faction: 'Minmatar Republic', factionId: 500002, color: '#c85a4a', group: 'Faction Warfare' },
  { corpId: 1000437, corpName: 'Commando Guri', faction: 'Guristas Pirates', factionId: 500010, color: '#e8c14a', group: 'Pirate Faction' },
  { corpId: 1000436, corpName: 'Malakim Zealots', faction: 'Angel Cartel', factionId: 500011, color: '#e05a5a', group: 'Pirate Faction' },
  { corpId: 1000134, corpName: 'Blood Raiders', faction: 'Blood Raider Covenant', factionId: 500012, color: '#a03030', group: 'Pirate Faction' },
  { corpId: 1000162, corpName: 'True Power', faction: "Sansha's Nation", factionId: 500019, color: '#c04ac0', group: 'Pirate Faction' },
  { corpId: 1000135, corpName: 'Serpentis Corporation', faction: 'Serpentis', factionId: 500020, color: '#4ac084', group: 'Pirate Faction' }
];
window.FW_WARZONE_CORPS = FW_WARZONE_CORPS;

let _lpOffersCache = {};      // corpId -> raw ESI offers array
let _lpRankedResults = [];    // last computed, sorted evaluation results
let _lpActiveCorpId = null;
let _lpIsLoading = false;
let _lpTypeFilter = 'all';    // 'all' | 'direct' | 'bpc'
let _lpCategoryFilter = 'all'; // 'all' | 'favorites' | a numeric SDE category id (string) | 'other'
let _lpSearchQuery = '';      // free-text filter against the offer's own output item name

// Favorited offers - keyed by offer_id (the same identifier isolateOffer/toggleLPOfferExpanded
// already address rows by), not typeId, since CCP can and does offer the same item through several
// distinct offer_id combos (see the ranked-list row comment on requiredItemsSummary) - favoriting
// one shouldn't silently favorite the others. Loaded eagerly (not inside the load listener) since
// it's a synchronous localStorage read with no page dependency, same as any other simple persisted
// preference.
let _lpFavoriteOfferIds = new Set();
try {
  _lpFavoriteOfferIds = new Set(JSON.parse(localStorage.getItem('eve_lpstore_favorites') || '[]'));
} catch (e) { /* corrupt/old value - start fresh rather than fail the whole page */ }

function saveLPFavorites() {
  localStorage.setItem('eve_lpstore_favorites', JSON.stringify([..._lpFavoriteOfferIds]));
}

function toggleLPFavorite(offerId) {
  if (_lpFavoriteOfferIds.has(offerId)) _lpFavoriteOfferIds.delete(offerId);
  else _lpFavoriteOfferIds.add(offerId);
  saveLPFavorites();
  renderLPCategoryBar(); // favorites count badge
  renderLPStoreTable();  // star fill + (if currently viewing the Favorites filter) list membership
}
window.toggleLPFavorite = toggleLPFavorite;

// Icon + label config for the category filter bar (js/lpstore.js renderLPCategoryBar) - one source
// of truth for id/label/icon, walked to both render the buttons and (via LP_CATEGORY_LABELS below,
// kept as the id->label lookup other code already uses) resolve a typeId's own category.
const LP_CATEGORY_FILTERS = [
  { id: 'all', label: 'All', icon: 'grid' },
  { id: 'favorites', label: 'Favorites', icon: 'star' },
  { id: '6', label: 'Ships', icon: 'rocket' },
  { id: '7', label: 'Modules', icon: 'gear' },
  { id: '8', label: 'Ammo', icon: 'ammo' },
  { id: '18', label: 'Drones', icon: 'drone' },
  { id: '20', label: 'Implants', icon: 'cpu' },
  { id: '16', label: 'Skillbooks', icon: 'book' },
  { id: '91', label: 'SKINs', icon: 'layers' },
  { id: '9', label: 'Blueprints', icon: 'file-text' },
  { id: 'other', label: 'Other', icon: 'package' }
];

// Renders into #lpstore-category-bar (top of the ranked-offers card, lpstore.html) - called on
// initial load, on every setLPStoreCategoryFilter, and on toggleLPFavorite (for the count badge).
// Deliberately separate from renderLPStoreTable: switching the active pill doesn't need the whole
// (potentially large) table to re-render, only itself and the table's own filter pass.
function renderLPCategoryBar() {
  const el = document.getElementById('lpstore-category-bar');
  if (!el) return;
  el.innerHTML = LP_CATEGORY_FILTERS.map(f => {
    const active = _lpCategoryFilter === f.id;
    const badge = f.id === 'favorites' && _lpFavoriteOfferIds.size
      ? `<span class="mono" style="margin-left:5px; opacity:0.75;">${_lpFavoriteOfferIds.size}</span>`
      : '';
    return `<button onclick="setLPStoreCategoryFilter('${f.id}')" class="lp-pill${active ? ' active' : ''}" title="${window.esc(f.label)}">${window.svgIcon(f.icon)}${window.esc(f.label)}${badge}</button>`;
  }).join('');
}
window.renderLPCategoryBar = renderLPCategoryBar;
let _lpItemCategoryCache = {}; // typeId -> category id, resolved live (see resolveLPItemCategories)
let _lpSortKey = 'iskPerLp';
let _lpSortDir = -1;          // -1 desc, 1 asc
let _lpExpandedOfferIds = new Set();
let _lpResolvedNames = {};    // typeId -> name, for anything eve_db.js's EVE_ITEMS doesn't have
let _lpOfferByOutputTypeId = {}; // typeId -> [offers], built per corp load - also mirrored onto
                                  // window.__lpOfferByOutputTypeId so js/app.js and js/optimizers.js
                                  // (loaded before this file, no direct access to this module's own
                                  // variables) can see it too.
let _lpIsolatedResult = null; // the ranked-result currently isolated in the canvas view, or null
let _lpSavedCalculatorState = null; // snapshot of the Calculator's own last-saved state - see the
                                     // isolate-state-bleed note below.

// --- Don't let isolating an offer here overwrite what the Calculator restores on ITS OWN next
//     load ---------------------------------------------------------------------------------------
// js/app.js's recalculate() unconditionally calls its own saveActiveState() at the end, which
// persists window.currentProduct/globalRuns/buildSelfOverrides/etc. to a handful of localStorage
// keys - that's exactly right on index.html (the Calculator IS supposed to remember what you were
// last building), but recalculate() is the same shared function this page calls too, so isolating
// an LP offer here was silently overwriting the Calculator's own saved session with this page's own
// temporary one. saveActiveState isn't window-bound (a bare in-module call inside recalculate()),
// so it can't be intercepted directly - instead, the Calculator's real values are snapshotted once
// on load (before this page ever isolates anything) and re-written back immediately after every
// recalculate() this page triggers, undoing that particular side effect without touching app.js at
// all. The live, in-memory session (window.recipeTreeRoot etc.) is completely unaffected - only
// what a FUTURE fresh load of index.html would read back.
const CALCULATOR_STATE_KEYS = ['eve_active_product', 'eve_build_self_overrides', 'eve_custom_buy_modes', 'eve_custom_me_overrides', 'eve_custom_te_overrides', 'eve_global_runs', 'eve_root_sell_strategy', 'eve_root_custom_price'];

function snapshotCalculatorState() {
  const snap = {};
  CALCULATOR_STATE_KEYS.forEach(k => { snap[k] = localStorage.getItem(k); });
  return snap;
}

function restoreCalculatorState(snap) {
  if (!snap) return;
  CALCULATOR_STATE_KEYS.forEach(k => {
    if (snap[k] === null) localStorage.removeItem(k);
    else localStorage.setItem(k, snap[k]);
  });
}

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

// --- Item categories (Ships / Modules / Ammo / Implants / Skillbooks / SKINs / Drones / ...) ----
// eve_db.js's own EVE_GROUP_IDS/EVE_CATEGORIES tables turned out NOT to be item classification data
// at all when checked against real ESI output (they're keyed the same way but hold universe/
// location groupings - "Region", "Constellation", "Corporation" - a leftover from a different
// feature) - confirmed by cross-checking a handful of known items (a ship, a module, a SKIN) and
// finding the local table's answer didn't match ESI's. So this resolves categories live instead,
// same live-fallback philosophy as resolveMissingItemNames above: /universe/types/{id}/ for a
// type's group_id (no batch endpoint exists for this one, so these run individually but in
// parallel), then /universe/groups/{id}/ for that group's category_id - cached at both levels so a
// second store sharing common groups (most module/ammo groups repeat across corps) doesn't refetch.
const LP_CATEGORY_LABELS = { 6: 'Ships', 7: 'Modules', 8: 'Ammo & Charges', 9: 'Blueprints (other)', 16: 'Skillbooks', 18: 'Drones', 20: 'Implants', 91: 'SKINs' };
let _lpGroupCategoryCache = {}; // groupId -> categoryId

function getLPItemCategory(typeId) {
  return _lpItemCategoryCache[typeId]; // undefined until resolved - callers treat that as "unknown yet", not "other"
}

// Deliberately NOT awaited by callers on the critical path - kicked off in the background after the
// ranked list already has something to show, since a few hundred individual ESI calls (however
// parallel) shouldn't hold up the numbers players actually came for. Re-renders the table once done
// so the category filter (and any category-dependent display) picks up the real values.
async function resolveLPItemCategories(typeIds) {
  const missingTypes = [...new Set(typeIds)].filter(id => _lpItemCategoryCache[id] === undefined);
  if (!missingTypes.length) return;

  const groupIdByType = {};
  await Promise.all(missingTypes.map(async (id) => {
    try {
      const res = await fetch(`https://esi.evetech.net/latest/universe/types/${id}/?datasource=tranquility`, { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      if (data && data.group_id !== undefined) groupIdByType[id] = data.group_id;
    } catch (e) { /* leave uncategorized rather than fail the whole batch */ }
  }));

  const missingGroups = [...new Set(Object.values(groupIdByType))].filter(gid => _lpGroupCategoryCache[gid] === undefined);
  await Promise.all(missingGroups.map(async (gid) => {
    try {
      const res = await fetch(`https://esi.evetech.net/latest/universe/groups/${gid}/?datasource=tranquility`, { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      _lpGroupCategoryCache[gid] = (data && data.category_id !== undefined) ? data.category_id : null;
    } catch (e) { _lpGroupCategoryCache[gid] = null; }
  }));

  missingTypes.forEach(id => {
    const gid = groupIdByType[id];
    _lpItemCategoryCache[id] = (gid !== undefined && _lpGroupCategoryCache[gid] != null) ? _lpGroupCategoryCache[gid] : null;
  });

  renderLPStoreState();
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

// Sum of an offer's required_items priced at Jita sell (cost to acquire them right now) - shared
// by the ranked-list evaluation below AND the isolated-canvas LP stat strip, so there's one place
// this convention lives.
function requiredItemsMarketCost(offer) {
  let total = 0;
  (offer.required_items || []).forEach(r => {
    total += ((window.priceCache[r.type_id] || {}).sell || 0) * r.quantity;
  });
  return total;
}
window.requiredItemsMarketCost = requiredItemsMarketCost;

// An offer is a BPC offer when its own type_id resolves to a recipe AND that recipe's
// blueprintTypeID is the offer's type_id itself (recipeMap is keyed by BOTH blueprint and product
// ids - see js/config.js buildPrepackedIndexes - so this check is what tells the two apart).
function isBlueprintOffer(offer) {
  const recipe = window.recipeMap && window.recipeMap[offer.type_id];
  return !!(recipe && parseInt(recipe.blueprintTypeID) === parseInt(offer.type_id));
}

// --- Per-offer evaluation (drives the ranked list) ------------------------------------------

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

  const requiredItemsCost = requiredItemsMarketCost(offer);
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
  // treated as exactly 1 run. Called out in the UI rather than silently assumed, since it's the
  // one number here ESI itself can't confirm.
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

  const requiredItemsCost = requiredItemsMarketCost(offer);

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

    // Index every offer by what it grants - drives the isolated canvas's "Acquire via LP" option
    // (js/app.js createNodeCard / js/optimizers.js calculateTreeNodeCost read this via
    // window.__lpOfferByOutputTypeId, since they're loaded before this file and can't see its
    // module-local variables directly). A component is offerable that way only if it matches
    // something THIS store actually sells - cross-corp matching is a possible future enhancement,
    // not done here.
    _lpOfferByOutputTypeId = {};
    offers.forEach(o => {
      if (!_lpOfferByOutputTypeId[o.type_id]) _lpOfferByOutputTypeId[o.type_id] = [];
      _lpOfferByOutputTypeId[o.type_id].push(o);
    });
    window.__lpOfferByOutputTypeId = _lpOfferByOutputTypeId;

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

  // Fire-and-forget - see resolveLPItemCategories's own note on why this doesn't block the render
  // above. Classifies by outputTypeId, which for a BPC offer is already the PRODUCT it builds (a
  // ship BPC resolves to "Ships" the same as a direct-sell ship would, not a separate "Blueprints"
  // bucket), so one Category filter covers both offer types uniformly.
  resolveLPItemCategories(_lpRankedResults.map(r => r.outputTypeId));
}
window.loadAndRankLPStore = loadAndRankLPStore;

function selectLPStoreCorp(corpIdStr) {
  if (!corpIdStr) return;
  loadAndRankLPStore(corpIdStr);
}
window.selectLPStoreCorp = selectLPStoreCorp;

function setLPStoreTypeFilter(filter) {
  _lpTypeFilter = filter;
  ['all', 'direct', 'bpc'].forEach(f => {
    const btn = document.getElementById(`btn-lpstore-type-${f}`);
    if (btn) btn.className = `lp-pill${f === filter ? ' active' : ''} flex-1 text-center`;
  });
  renderLPStoreState();
}
window.setLPStoreTypeFilter = setLPStoreTypeFilter;

function setLPStoreCategoryFilter(catId) {
  _lpCategoryFilter = catId;
  renderLPCategoryBar();
  renderLPStoreTable(); // filtering only - no need to re-render the summary tiles above it
}
window.setLPStoreCategoryFilter = setLPStoreCategoryFilter;

function setLPStoreSearch(query) {
  _lpSearchQuery = (query || '').trim();
  renderLPStoreTable(); // filtering only - no need to re-render the summary tiles above it
}
window.setLPStoreSearch = setLPStoreSearch;

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

// =================================================================================================
// Isolate: hand off to the Calculator's own tree canvas + Bill of Materials sidebar (js/app.js,
// also loaded on this page) rather than a separate lookalike UI - the exact same floating cards
// connected by lines, the exact same BOM panel, that the Calculator already has. Works for BOTH
// offer types now: a BPC offer isolates via the Calculator's own selectItem() (a real recipe tree);
// a direct-sell offer gets a synthetic root built the same shape selectItem() would produce, since
// there's no blueprint to hand it - "as if we're building it" per the request this was built from.
//
// Either way, the offer's own required_items (what you turn in to REDEEM it - a separate thing from
// a BPC's own build materials) are injected as extra root-level children, so they show up as real
// cards connected by lines instead of only a lump sum in the stat strip. They're visually distinct
// (isRedemptionRequirement flag - purple card accent + purple line, js/app.js createNodeCard /
// drawConnectingLinesForTree) so it's obvious at a glance which cards are "build this" vs "turn
// this in".
// =================================================================================================

function isolateOffer(offerId) {
  const result = _lpRankedResults.find(r => r.offer.offer_id === offerId);
  if (!result) return;
  if (typeof window.selectItem !== 'function') {
    console.error('[LP Store] window.selectItem is unavailable - is js/app.js loaded on this page?');
    return;
  }

  _lpIsolatedResult = result;

  // #lpstore-main-area is hidden as a whole (not just its inner results div) - it's a flex sibling
  // of #viewport in .content-row, and leaving it visible-but-empty would still claim flex-1 space
  // alongside the canvas.
  document.getElementById('lpstore-main-area')?.classList.add('hidden');
  ['viewport', 'bom-sidebar', 'lpstore-calc-stat-strip'].forEach(id => document.getElementById(id)?.classList.remove('hidden'));

  const nameEl = document.getElementById('lpstore-inspector-name');
  if (nameEl) nameEl.textContent = result.outputName;

  if (result.offerType === 'bpc') {
    // selectItem (js/app.js) is the Calculator's own "load this blueprint" entry point - it resets
    // every build/buy/ME/TE override, builds the real recipe tree, fetches prices, and calls
    // recalculate() itself (which runs ensureLPRedemptionNodesPresent below via the recalculate
    // hook - nothing else needs doing here). Runs start at exactly 1 redemption's worth (offer.
    // quantity blueprint runs), same pattern js/app.js's own loadBlueprintIntoCalculator uses for a
    // real owned BPC.
    window.selectItem(result.blueprintTypeId, getLPItemName(result.blueprintTypeId), false).then(async () => {
      window.globalRuns = result.bpcCopies || 1;
      await window.fetchMarketPrices((result.offer.required_items || []).map(r => r.type_id));
      if (typeof window.recalculate === 'function') window.recalculate();
    });
  } else {
    isolateDirectSellOffer(result);
  }
}
window.isolateOffer = isolateOffer;

// No blueprint exists for a direct-sell offer, so selectItem() doesn't apply - this builds a
// synthetic root in the exact shape selectItem() would have produced (same fields recalculate()/
// createNodeCard() read), with isBuildingSelf:true so its children (the required_items, injected by
// the recalculate hook below) actually render and get summed into the cost - "as if we're building
// it", per the request this was built from, even though there's no manufacturing job behind it
// (recipe stays null, so calculateNodeJobFee/calculateTotalBuildSeconds both naturally contribute 0
// - no special-casing needed there). batchYield is this offer's own quantity-per-redemption and
// globalRuns starts at 1 redemption, so the existing qtyNeeded = batchYield * runs math
// (recalculate(), unmodified) falls out correctly with no new formula.
async function isolateDirectSellOffer(result) {
  const offer = result.offer;
  window.buildSelfOverrides = {};
  window.customBuyModes = {};
  window.customMEOverrides = {};
  window.customTEOverrides = {};
  window.selectedInstanceId = null;
  window.isolatedInstanceId = null;
  window.collapsedInstanceIds = new Set();
  window.rootSellStrategy = 'market-sell';
  window.rootCustomPrice = 0;
  window.currentProduct = { id: offer.type_id, name: result.outputName };
  window.globalRuns = 1;

  window.recipeTreeRoot = {
    instanceId: ++window.instanceCounter, parentInstanceId: null,
    typeId: offer.type_id, displayTypeId: offer.type_id, productTypeId: offer.type_id,
    name: result.outputName, productName: result.outputName,
    qtyNeeded: offer.quantity || 1, depth: 0, recipe: null, children: [],
    isManufacturable: false, isReaction: false, batchYield: offer.quantity || 1, runsNeeded: 1,
    isBuildingSelf: true, customME: 0, customTE: 0, unitEIV: 0, jobEIV: 0, jobFee: 0
  };

  await window.fetchMarketPrices([offer.type_id, ...(offer.required_items || []).map(r => r.type_id)]);
  if (typeof window.recalculate === 'function') window.recalculate();
}

function exitLPInspector() {
  _lpIsolatedResult = null;
  ['viewport', 'bom-sidebar', 'lpstore-calc-stat-strip'].forEach(id => document.getElementById(id)?.classList.add('hidden'));
  document.getElementById('lp-info-card-col')?.remove();
  document.getElementById('lpstore-main-area')?.classList.remove('hidden');
}
window.exitLPInspector = exitLPInspector;

// How many separate times the isolated offer is being redeemed, given the current run count. The
// relationship between "runs" (window.globalRuns, what the Calculator's own machinery actually
// scales the tree by) and "redemptions" (the number the player actually cares about and edits, see
// onLPRedemptionCountChange) differs by offer type: a BPC redemption grants offer.quantity separate
// 1-run BPCs at once (runs = redemptions * offer.quantity), while a direct-sell redemption's
// synthetic root already treats "runs" as directly meaning "redemptions" (see
// isolateDirectSellOffer). Kept as one exact division (not the old ceil-based guess) because
// onLPRedemptionCountChange is now the only thing that ever sets globalRuns for an isolated offer,
// so it's always an exact multiple.
function getLPRedemptionBatches(result) {
  const runs = window.globalRuns || 1;
  if (result.offerType === 'bpc') return Math.max(1, Math.round(runs / (result.offer.quantity || 1)));
  return runs;
}

// The root card's own "Times Redeemed" input (js/app.js createNodeCard, isLPIsolatedRoot branch)
// calls this instead of the Calculator's normal syncCardRunsToGlobal - redemptions is the number the
// player actually edits, translated to the runs count the rest of the Calculator's machinery expects.
function onLPRedemptionCountChange(e) {
  if (!_lpIsolatedResult) return;
  const redemptions = Math.max(1, parseInt(e.target.value) || 1);
  const offer = _lpIsolatedResult.offer;
  window.globalRuns = _lpIsolatedResult.offerType === 'bpc' ? redemptions * (offer.quantity || 1) : redemptions;
  if (typeof window.recalculate === 'function') window.recalculate();
}
window.onLPRedemptionCountChange = onLPRedemptionCountChange;

// Adds one child node per required_item, in the same shape a real tree node has (so createNodeCard/
// calculateTreeNodeCost/etc. handle them with zero special-casing beyond the isRedemptionRequirement
// flag) - instanceId comes from the SAME global counter tree.js/app.js use for their own nodes
// (config.js's `var instanceCounter` is a live global, not a snapshot), so there's no collision risk.
function injectLPRedemptionNodes(root, offer) {
  if (!root) return;
  root.children = root.children || [];
  (offer.required_items || []).forEach(ri => {
    root.children.push({
      instanceId: ++window.instanceCounter, parentInstanceId: root.instanceId,
      typeId: ri.type_id, displayTypeId: ri.type_id, productTypeId: ri.type_id,
      name: getLPItemName(ri.type_id), productName: getLPItemName(ri.type_id),
      qtyNeeded: ri.quantity, depth: (root.depth || 0) + 1, recipe: null, children: [],
      isManufacturable: false, isReaction: false, batchYield: 1, runsNeeded: 1,
      isBuildingSelf: false, customME: 0, customTE: 0, unitEIV: 0, jobEIV: 0, jobFee: 0,
      isRedemptionRequirement: true, _perBatchQty: ri.quantity
    });
  });
}

// Run before every recalculate() this page triggers (see installLPRecalculateHook) - handles BOTH
// keeping the redemption nodes' quantities in sync with the current redemption count AND
// re-injecting them if they're missing. They go missing whenever js/app.js rebuilds the tree from
// scratch, which happens more often than just the initial isolate: toggling "Build" on ANY
// component deep in the tree (optimizers.js toggleBuildSelf) re-runs selectItem() to fetch that
// component's own children, which throws away and rebuilds the WHOLE tree including the root -
// silently dropping these synthetic nodes if they aren't re-added here every time. Also re-stamps
// isLPIsolatedRoot/_lpRedemptionCount on the root for the same reason (createNodeCard's "Times
// Redeemed" branch needs them present on whatever the CURRENT root object is, not just the first
// one selectItem() ever built).
function ensureLPRedemptionNodesPresent() {
  if (!_lpIsolatedResult || !window.recipeTreeRoot) return;
  const root = window.recipeTreeRoot;
  const result = _lpIsolatedResult;

  root.isLPIsolatedRoot = true;
  root.children = root.children || [];
  const alreadyInjected = root.children.some(c => c.isRedemptionRequirement);
  if (!alreadyInjected) injectLPRedemptionNodes(root, result.offer);

  const batches = getLPRedemptionBatches(result);
  root._lpRedemptionCount = batches;
  root.children.forEach(child => {
    if (child.isRedemptionRequirement) child.qtyNeeded = child._perBatchQty * batches;
  });
}

// Wraps the Calculator's own recalculate() ONCE, on this page only, to sync the redemption nodes
// first and refresh the LP-specific extra stat strip after - every existing trigger for recalculate
// (Build/Buy/LP toggles, runs change, ME/TE edits, tax/fee edits) picks both up automatically, with
// no new wiring needed at any of those call sites.
function installLPRecalculateHook() {
  if (typeof window.recalculate !== 'function' || window.recalculate.__lpWrapped) return;
  const original = window.recalculate;
  const wrapped = function (...args) {
    window.__lpSpentThisRecalc = 0; // calculateTreeNodeCost (js/optimizers.js) accumulates into this
    ensureLPRedemptionNodesPresent();
    const result = original.apply(this, args);
    restoreCalculatorState(_lpSavedCalculatorState); // undo this call's own saveActiveState() - see the note above CALCULATOR_STATE_KEYS
    renderLPExtraStats();
    renderLPStoreActiveStationLabel(); // picks up a structure/preset change made via the sidebar
    return result;
  };
  wrapped.__lpWrapped = true;
  window.recalculate = wrapped;
}

// The Calculator's own stat strip has no concept of LP. Rather than a separate strip of big boxes
// competing for space at the top of the page, this renders as ONE compact card - same glass-card/
// diagram-node styling real tree cards use - in its OWN column appended right after the root
// card's column in #tree-container, so it sits beside the root card (columns lay out left-to-right,
// and the root's column - depth 0 - is always the rightmost existing one, see renderTreeDiagram in
// js/app.js), reading as part of the tree rather than a bolted-on dashboard. Only the offer's flat
// isk_cost/lp_cost (no typeId, can't be a tree node) needs adding on top of the Calculator's own
// figure - required_items are real tree children at this point, so
// window.recipeTreeRoot.calculatedCost (materials + job fee, the Calculator's own unmodified
// number) already includes them.
function renderLPExtraStats() {
  document.getElementById('lp-info-card-col')?.remove();
  if (!_lpIsolatedResult || !window.recipeTreeRoot) return;

  const root = window.recipeTreeRoot;
  const treeContainer = document.getElementById('tree-container');
  const rootCardEl = document.getElementById(`node-card-${root.instanceId}`);
  if (!treeContainer || !rootCardEl) return; // tree hasn't rendered yet this pass

  const result = _lpIsolatedResult;
  const offer = result.offer;
  const batches = getLPRedemptionBatches(result);
  const flatIskCost = batches * offer.isk_cost;
  const flatLpCost = batches * offer.lp_cost;
  const acquiredLpCost = window.__lpSpentThisRecalc || 0;

  const totalIskCost = (root.calculatedCost || 0) + flatIskCost;
  const totalLpCost = acquiredLpCost + flatLpCost;

  // recalculate() already computed net sell revenue net of tax/broker (outputMarketValue is the
  // gross figure it derived that from) - profit is redone here against totalIskCost (which the
  // Calculator's own netProfitSell doesn't know about) rather than reused directly.
  const { salesTax, brokerFee } = window.getActiveFeeInputs ? window.getActiveFeeInputs() : { salesTax: 0.036, brokerFee: 0.01 };
  const grossRevenue = root.outputMarketValue || 0;
  const netRevenue = grossRevenue * (1 - salesTax - brokerFee);
  const profit = netRevenue - totalIskCost;
  const iskPerLp = totalLpCost > 0 ? profit / totalLpCost : null;
  const profitColor = profit > 0 ? 'var(--accent)' : 'var(--red-400, #f87171)';
  const iskPerLpDisplay = iskPerLp === null ? '—' : Math.round(iskPerLp).toLocaleString();

  // A row stacks its value onto its own line (instead of sitting beside the label) once the two
  // combined would realistically overflow this card's width at text-sm mono - keeps the common
  // case (short values) compact while big ISK/LP totals (this is EVE, they get big) never clip
  // past the card edge regardless of magnitude, without ever truncating precision.
  const row = (label, value, color, title) => {
    const stacked = (label.length + value.length) > 34;
    const titleAttr = title ? `title="${window.esc(title)}"` : '';
    const valueSpan = `<span class="font-bold whitespace-nowrap" style="color:${color || 'var(--text)'};">${value}</span>`;
    return stacked
      ? `<div ${titleAttr}>
          <div class="text-slate-400">${label}</div>
          <div class="text-right">${valueSpan}</div>
        </div>`
      : `<div class="flex justify-between items-center gap-3" ${titleAttr}>
          <span class="text-slate-400 flex-shrink-0">${label}</span>
          ${valueSpan}
        </div>`;
  };

  // Same overflow logic as row() above, applied to the two standalone hero numbers: shrink the
  // font in steps as the string gets longer instead of letting it run past the card edge.
  const fitFontSize = (text, sizes) => {
    for (const [maxLen, size] of sizes) {
      if (text.length <= maxLen) return size;
    }
    return sizes[sizes.length - 1][1];
  };
  const profitText = Math.round(profit).toLocaleString() + ' ISK';
  const heroFontSize = fitFontSize(profitText, [[15, '32px'], [18, '26px'], [22, '21px'], [99, '17px']]);
  const iskPerLpFontSize = fitFontSize(iskPerLpDisplay, [[9, '20px'], [13, '16px'], [99, '13px']]);

  const card = document.createElement('div');
  card.id = 'lp-info-card';
  card.className = 'diagram-node glass-card p-3.5 w-[26rem]';
  card.style.borderTopColor = '#c084fc';
  card.innerHTML = `
    <div class="flex items-center gap-1.5 border-b border-[#3a3025] pb-2 mb-2.5">
      <svg viewBox="0 0 24 24" fill="none" stroke="#c084fc" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;flex-shrink:0;"><circle cx="12" cy="8" r="5"/><path d="M8.5 12.5L7 21l5-3 5 3-1.5-8.5"/></svg>
      <span class="font-bold text-sm text-white">LP Store Economics</span>
    </div>
    <div class="text-sm mono space-y-2">
      ${row('Total ISK Cost', Math.round(totalIskCost).toLocaleString() + ' ISK', null, 'Build materials + required redemption items (purple cards) + job install fee + the flat ISK portion of redeeming this offer')}
      ${row('Redemption Fee', `${Math.round(flatIskCost).toLocaleString()} ISK + ${flatLpCost.toLocaleString()} LP`, '#c084fc', 'The flat ISK/LP portion of redeeming this offer - on top of the required items already counted in Total ISK Cost above')}
      ${row('Total LP Spent', `${totalLpCost.toLocaleString()} LP`, '#c084fc', 'Redemption LP + any component set to "Acquire via LP" in the tree')}
    </div>
    <div class="border-t border-[#3a3025] mt-2.5 pt-2.5">
      <div class="text-slate-400 text-xs uppercase tracking-wide" style="font-size:10.5px;" title="Net sell revenue minus build materials, required redemption items, job fee, and the flat redemption fee">LP-Aware Profit</div>
      <div class="hero-num ${profit >= 0 ? 'profit' : 'loss'}" style="font-size:${heroFontSize}; white-space:nowrap;">${profitText}</div>
    </div>
    <div class="border-t border-[#3a3025] mt-2 pt-2 flex justify-between items-center" title="Estimated ISK profit per LP spent">
      <span class="text-slate-300 font-bold text-sm flex-shrink-0">ISK / LP</span>
      <span class="font-bold mono whitespace-nowrap" style="color:${profitColor}; font-size:${iskPerLpFontSize};">${iskPerLpDisplay}</span>
    </div>
  `;

  const col = document.createElement('div');
  col.id = 'lp-info-card-col';
  col.className = 'flex flex-col justify-center';
  col.appendChild(card);
  treeContainer.appendChild(col);
}
window.renderLPExtraStats = renderLPExtraStats;

// --- Rendering: ranked list -------------------------------------------------------------------

function getLPStoreIconUrl(typeId, isBpc) {
  return `https://images.evetech.net/types/${typeId}/${isBpc ? 'bpc' : 'icon'}?size=32`;
}

// Final stage of the icon fallback chain (icon -> render -> this) - swaps a genuinely-imageless
// item (confirmed: SKINs return 404 on both endpoints) for a small inline placeholder instead of
// leaving a broken-image box or hiding it outright.
function handleLPIconLoadError(imgEl) {
  const span = document.createElement('span');
  span.className = 'w-6 h-6 rounded flex items-center justify-center flex-shrink-0';
  span.style.background = 'rgba(255,255,255,0.06)';
  span.style.color = 'var(--text-mute)';
  span.title = 'No image available for this item';
  span.innerHTML = window.svgIcon ? window.svgIcon('package', { style: 'width:14px;height:14px;' }) : '';
  imgEl.replaceWith(span);
}
window.handleLPIconLoadError = handleLPIconLoadError;

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
  // Don't re-show the list if an offer is currently isolated (the canvas view stays up, e.g. across
  // a tax/fee edit that re-triggers loadAndRankLPStore).
  if (resultsArea && !_lpIsolatedResult) resultsArea.classList.remove('hidden');

  renderLPStoreSummaryTiles();
  renderLPStoreTable();
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
  if (_lpSearchQuery) {
    const q = _lpSearchQuery.toLowerCase();
    rows = rows.filter(r => r.outputName && r.outputName.toLowerCase().includes(q));
  }
  if (_lpCategoryFilter === 'favorites') {
    rows = rows.filter(r => _lpFavoriteOfferIds.has(r.offer.offer_id));
  } else if (_lpCategoryFilter !== 'all') {
    rows = rows.filter(r => {
      const cat = getLPItemCategory(r.outputTypeId);
      if (cat === undefined) return true; // not resolved yet - don't hide it, just not filterable yet
      if (_lpCategoryFilter === 'other') return cat === null || !LP_CATEGORY_LABELS[cat];
      return String(cat) === _lpCategoryFilter;
    });
  }
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
    // A BPC offer's icon must come from the BLUEPRINT's own typeId (r.blueprintTypeId, i.e.
    // offer.type_id) - r.outputTypeId is the manufactured PRODUCT's typeId (e.g. the ship itself),
    // which has no /bpc art of its own and would 404/fall through to a wrong or generic image.
    const iconUrl = getLPStoreIconUrl(isBpc ? r.blueprintTypeId : r.outputTypeId, isBpc);
    const profitColor = r.profit > 0 ? 'var(--accent)' : 'var(--red-400, #f87171)';
    const iskPerLpDisplay = r.iskPerLp === null ? '—' : Math.round(r.iskPerLp).toLocaleString();
    const expanded = _lpExpandedOfferIds.has(offer.offer_id);
    // onerror is chained twice: /icon -> /render (covers most things, e.g. blueprints only have a
    // render, not an icon) -> handleLPIconLoadError swaps in a generic SVG placeholder (not hidden
    // - a gap in the row reads as broken, a placeholder reads as "no art for this one"). SKINs
    // (e.g. the FW LP store's own "Penumbral Shadows" SKINs) are the confirmed real case: images.
    // evetech.net has genuinely neither /icon nor /render for them, verified directly via fetch,
    // not just a loading hiccup. A named handler (not an inline outerHTML string) because svgIcon's
    // own markup uses double quotes throughout, which would terminate an inline onerror="..." the
    // moment it appeared.
    const iconFallback = `this.onerror=function(){window.handleLPIconLoadError(this);}; this.src='https://images.evetech.net/types/${r.outputTypeId}/render?size=32';`;

    const typeBadge = isBpc
      ? `<span class="text-[9px] mono px-1.5 py-0.5 rounded flex-shrink-0" style="background:rgba(192,132,252,0.15); color:#c084fc;" title="Redeeming this offer grants a Blueprint Copy - value shown is what building it out nets, not the BPC's own resale value.">BPC</span>`
      : `<span class="text-[9px] mono px-1.5 py-0.5 rounded flex-shrink-0" style="background:rgba(56,189,248,0.15); color:#38bdf8;">ITEM</span>`;

    // Visible without expanding - the actual reason two rows can share an item name (CCP offers
    // the same reward through several different LP/ISK/item combinations; each is a distinct
    // offer_id, not a data glitch). Previously only visible after a click, which read as duplicate
    // junk.
    const requiredItemsSummary = offer.required_items.length
      ? offer.required_items.map(r2 => `${r2.quantity}x ${window.esc(getLPItemName(r2.type_id))}`).join(', ')
      : (offer.isk_cost > 0 ? 'ISK + LP only' : 'LP only');

    // Isolate opens the real Calculator canvas for ANY offer now - a BPC gets its actual recipe
    // tree, a direct-sell item gets a synthetic root standing in for "the item you receive" (see
    // isolateDirectSellOffer) - either way its required_items render as real (purple) cards too.
    const isolateBtn = `<button onclick="event.stopPropagation(); isolateOffer(${offer.offer_id});" class="icon-btn flex-shrink-0" style="width:26px;height:26px;" title="Isolate: open this offer in the Calculator's own tree view">${window.svgIcon ? window.svgIcon('expand', { style: 'width:13px;height:13px;' }) : '⤢'}</button>`;

    // Favorited by offer_id (see the state-var comment above) - filled gold star when favorited,
    // hollow outline otherwise. stopPropagation so starring an offer doesn't also toggle its detail
    // row open.
    const isFav = _lpFavoriteOfferIds.has(offer.offer_id);
    const favBtn = `<button onclick="event.stopPropagation(); toggleLPFavorite(${offer.offer_id});" class="icon-btn flex-shrink-0" style="width:22px;height:22px;" title="${isFav ? 'Remove from Favorites' : 'Add to Favorites'}">${window.svgIcon('star', { style: isFav ? 'fill:#ffd23f; color:#ffd23f;' : 'color:var(--text-mute);' })}</button>`;

    let detailHTML = '';
    if (expanded) {
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
                ${isBpc ? `<div><span style="color:var(--text-mute);">BPCs Granted:</span> ${r.bpcCopies} (assumed 1 run each - see sidebar note)</div>` : ''}
              </div>
              <div class="mt-2 pt-2" style="border-top:1px solid rgba(255,255,255,0.06); color:var(--text-mute);">
                Turned in: ${requiredItemsSummary}
              </div>
              <div class="mt-2.5 pt-2.5" style="border-top:1px solid rgba(255,255,255,0.06);">
                <button onclick="event.stopPropagation(); isolateOffer(${offer.offer_id});" class="btn-glass px-2.5 py-1 text-[10px]">${isBpc ? 'Isolate this BPC →' : 'Isolate this item →'}</button>
              </div>
            </div>
          </td>
        </tr>`;
    }

    return `
      <tr class="lp-store-row cursor-pointer" onclick="toggleLPOfferExpanded(${offer.offer_id})" title="Click for a full cost/value breakdown">
        <td class="py-1.5">
          <div class="flex items-center gap-2 min-w-0">
            ${favBtn}
            <img src="${iconUrl}" alt="" class="w-6 h-6 rounded flex-shrink-0" loading="lazy" onerror="${iconFallback}">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-1.5">
                <span class="truncate font-semibold text-white">${window.esc(r.outputName)}</span>
                ${typeBadge}
              </div>
              <div class="truncate text-[10px]" style="color:var(--text-mute);">${requiredItemsSummary}</div>
            </div>
            ${isolateBtn}
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

// --- Shared tax/fee settings (same pattern + localStorage key as js/invention.js) --------------

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
  // Re-rank the list against the new fees, AND live-refresh the isolated canvas (if any) - the
  // Calculator's own recalculate() already reads these same #facility-tax/etc. ids directly.
  if (_lpActiveCorpId) loadAndRankLPStore(_lpActiveCorpId);
  if (_lpIsolatedResult && typeof window.recalculate === 'function') window.recalculate();
}
window.saveSharedTaxSettingsFromLPStore = saveSharedTaxSettingsFromLPStore;

// Same "currently active station" label pattern as js/invention.js - synthesized from whatever
// system/structure/rigs are currently active in localStorage, since this page has no picker of its
// own (BPC offers are valued under the currently active production preset - change it from the
// Calculator's own Structure controls, which now also live right here since js/app.js is loaded).
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
  const groups = ['Faction Warfare', 'Pirate Faction'];
  const groupsHTML = groups.map(g => {
    const opts = FW_WARZONE_CORPS.filter(c => c.group === g)
      .map(c => `<option value="${c.corpId}" style="color:${c.color}; font-weight:bold;">${window.esc(c.faction)} — ${window.esc(c.corpName)}</option>`)
      .join('');
    return `<optgroup label="${window.esc(g)}">${opts}</optgroup>`;
  }).join('');
  select.innerHTML = '<option value="">— Choose an LP store —</option>' + groupsHTML;
}

// addEventListener rather than a plain `window.onload =` assignment - js/app.js (also loaded on
// this page, for the real tree canvas/BOM sidebar) registers its own load handler the same way;
// a raw assignment here would silently clobber it. js/app.js's own onload already covers
// buildPrepackedIndexes, handleEsiSSOCallback, loadSavedSystem, and fetchAdjustedPrices (its
// listener registers first, since app.js's <script> tag comes before this one) - only this page's
// own setup is repeated here.
window.addEventListener('load', async () => {
  // Snapshot BEFORE anything on this page can touch it (app.js's own onload has already run its
  // synchronous restore of whatever the Calculator last had, since its listener registers first -
  // see the CALCULATOR_STATE_KEYS note above) - this is what gets written back after every
  // recalculate() this page triggers, so isolating an LP offer never survives into index.html's own
  // next load.
  _lpSavedCalculatorState = snapshotCalculatorState();

  populateLPStoreCorpSelect();
  loadSharedTaxSettingsForLPStore();
  renderLPStoreActiveStationLabel();
  if (typeof window.renderProductionPresetDropdown === 'function') window.renderProductionPresetDropdown();
  renderLPCategoryBar();
  renderLPStoreState();
  installLPRecalculateHook();

  const lastCorp = localStorage.getItem('eve_lpstore_last_corp');
  const select = document.getElementById('lpstore-corp-select');
  if (lastCorp && select) {
    select.value = lastCorp;
    loadAndRankLPStore(lastCorp);
  }
});
