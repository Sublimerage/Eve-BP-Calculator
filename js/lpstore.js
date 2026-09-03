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
let _lpOfferByOutputTypeId = {}; // typeId -> [offers], built per corp load, drives the inspector's "Acquire via LP" option

// --- Build inspector state (isolate an offer -> live interactive tree/list, replacing the ranked
//     list - see the plan's "Why not reuse the Calculator's card canvas directly" for why this is
//     a purpose-built renderer rather than a straight reuse of js/app.js's card canvas) ----------
let _lpInspectedResult = null;      // the ranked-result object currently isolated, or null (list view when null)
let _lpInspectedRoot = null;        // live tree root (real for BPC offers, synthetic flat root for direct-sell offers)
let _lpInspectedTargetQty = 1;      // adjustable run/acquisition count, defaults to the offer's own quantity
let _lpAcquireViaLPTypeIds = new Set(); // typeIds currently set to "acquire via LP" instead of build/buy
let _lpInspectorCollapsedIds = new Set(); // instanceIds of nodes whose children are hidden in the inspector list

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

// Sum of an offer's required_items priced at Jita sell (cost to acquire them right now) - shared
// by the two eval functions below AND the inspector's "Acquire via LP" cost walk, so there's one
// place this convention lives.
function requiredItemsMarketCost(offer) {
  let total = 0;
  (offer.required_items || []).forEach(r => {
    total += ((window.priceCache[r.type_id] || {}).sell || 0) * r.quantity;
  });
  return total;
}

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

    // Index every offer by what it grants - drives the inspector's "Acquire via LP" option (a
    // component is offerable that way only if it matches something THIS store actually sells;
    // see the plan's scope note on why cross-corp matching isn't done here).
    _lpOfferByOutputTypeId = {};
    offers.forEach(o => {
      if (!_lpOfferByOutputTypeId[o.type_id]) _lpOfferByOutputTypeId[o.type_id] = [];
      _lpOfferByOutputTypeId[o.type_id].push(o);
    });

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

// =================================================================================================
// Build Inspector - isolate one offer into a live, interactive tree/list that replaces the ranked
// list entirely. Every toggle below (build/buy/LP-acquire per component, buy channel, target qty)
// recomputes and re-renders instantly with no network beyond what a newly-revealed subtree needs.
//
// Deliberately NOT a reuse of the Calculator's own pan-zoom card canvas (js/app.js
// renderTreeDiagram/createNodeCard) - that system is driven by recalculate() (js/app.js:1591),
// which reads/writes ~15 index.html-specific DOM ids and is triggered by handlers wired to that
// exact DOM, and both js/app.js and js/lpstore.js assign window.onload directly, so loading both
// scripts on one page would have the second clobber the first's init outright. What IS reused: the
// underlying tree/pricing primitives (buildRecursiveRecipeTree, scaleTreeQuantities,
// calculateTreeNodeCost's sibling functions calculateNodeJobFee/calculateTotalBuildSeconds) and the
// exact same override objects the Calculator itself uses (buildSelfOverrides, customBuyModes,
// customMEOverrides/TEOverrides - js/config.js) - a component toggled here behaves identically to
// toggling it in the Calculator, just rendered into a nested list instead of a card canvas.
// =================================================================================================

let _lpLeafInstanceCounter = 0;

// A required_item (direct-sell offer) or turn-in item has no blueprint of its own to build in the
// vast majority of real cases (tags, insignias, decoder-style items) - these render as buy/LP-only
// leaves. isBuildingSelf is always false; there's deliberately no Build option wired for them (see
// the plan's scope note - a fast-follow, not core to what was asked for).
function buildLPLeafNode(typeId, qtyNeeded) {
  return {
    instanceId: `lp-leaf-${++_lpLeafInstanceCounter}`, typeId, productTypeId: typeId,
    name: getLPItemName(typeId), productName: getLPItemName(typeId),
    qtyNeeded, runsNeeded: 1, batchYield: 1, depth: 1,
    isBuildingSelf: false, isReaction: false, recipe: null, children: [],
    customME: 0, customTE: 0, jobEIV: 0, unitEIV: 0
  };
}

function isolateOffer(offerId) {
  const result = _lpRankedResults.find(r => r.offer.offer_id === offerId);
  if (!result) return;

  _lpInspectedResult = result;
  _lpInspectedTargetQty = result.offerType === 'bpc' ? (result.bpcCopies || 1) : (result.offer.quantity || 1);

  // Fresh inspection - clear every per-component override so nothing bleeds in from a previously
  // isolated offer that happened to share a component typeId (mirrors js/app.js selectItem's own
  // reset when loading a genuinely new item, preserveView=false branch).
  window.buildSelfOverrides = {};
  window.customBuyModes = {};
  window.customMEOverrides = {};
  window.customTEOverrides = {};
  _lpAcquireViaLPTypeIds = new Set();
  _lpInspectorCollapsedIds = new Set();

  const listArea = document.getElementById('lpstore-results-area');
  const inspector = document.getElementById('lpstore-inspector');
  if (listArea) listArea.classList.add('hidden');
  if (inspector) inspector.classList.remove('hidden');

  rebuildLPInspectorTree();
}
window.isolateOffer = isolateOffer;

function exitLPInspector() {
  _lpInspectedResult = null;
  _lpInspectedRoot = null;
  const listArea = document.getElementById('lpstore-results-area');
  const inspector = document.getElementById('lpstore-inspector');
  if (inspector) inspector.classList.add('hidden');
  if (listArea) listArea.classList.remove('hidden');
}
window.exitLPInspector = exitLPInspector;

// Full rebuild pass - needed whenever the target quantity changes or a Build toggle reveals a
// subtree that hasn't been fetched yet. Cheap per-component toggles (buy channel, Acquire via LP)
// skip this entirely and just recompute+rerender - see setLPNodeSource.
async function rebuildLPInspectorTree() {
  const result = _lpInspectedResult;
  if (!result) return;
  const offer = result.offer;

  if (result.offerType === 'bpc') {
    const recipe = window.recipeMap[offer.type_id];
    const batchYield = recipe.productQtyPerRun || 1;
    const runs = Math.max(1, _lpInspectedTargetQty);

    const priorRootProduct = window.recipeTreeRootProductTypeId;
    window.recipeTreeRootProductTypeId = result.outputTypeId;
    let root;
    try {
      root = await window.buildRecursiveRecipeTree(parseInt(offer.type_id), getLPItemName(offer.type_id), runs, 0, 6, new Set(), null);
    } finally {
      window.recipeTreeRootProductTypeId = priorRootProduct;
    }
    if (!root) { _lpInspectedRoot = null; renderLPInspector(); return; }

    root.runsNeeded = runs;
    root.qtyNeeded = runs * batchYield;
    const structureType = window.getActiveStructureType ? window.getActiveStructureType() : { meBonus: 1.0, costBonus: 5.0 };
    const facility = structureType.meBonus / 100;
    if (typeof window.scaleTreeQuantities === 'function') window.scaleTreeQuantities(root, facility);

    const allTypeIds = new Set();
    if (typeof window.collectAllTypeIds === 'function') window.collectAllTypeIds(root, allTypeIds);
    allTypeIds.add(result.outputTypeId);
    await window.fetchMarketPrices(Array.from(allTypeIds));

    _lpInspectedRoot = root;
  } else {
    // Direct-sell offer - nothing to build, just what you turn in to redeem it. A synthetic flat
    // root lets the same row renderer and cost walk handle both offer types with no fork.
    const qty = Math.max(1, _lpInspectedTargetQty);
    const batches = Math.ceil(qty / (offer.quantity || 1));
    const children = (offer.required_items || []).map(ri => buildLPLeafNode(ri.type_id, ri.quantity * batches));
    await window.fetchMarketPrices(children.map(c => c.typeId));
    _lpInspectedRoot = {
      instanceId: 'lp-root', typeId: offer.type_id, productTypeId: offer.type_id,
      name: result.outputName, productName: result.outputName,
      qtyNeeded: qty, runsNeeded: batches, batchYield: offer.quantity || 1,
      depth: 0, isBuildingSelf: true, isReaction: false, recipe: null,
      children, customME: 0, customTE: 0, jobEIV: 0, unitEIV: 0, isDirectSellRoot: true
    };
  }

  renderLPInspector();
}
window.rebuildLPInspectorTree = rebuildLPInspectorTree;

function setLPInspectorTargetQty(value) {
  const qty = Math.max(1, parseInt(value) || 1);
  _lpInspectedTargetQty = qty;
  rebuildLPInspectorTree();
}
window.setLPInspectorTargetQty = setLPInspectorTargetQty;

// One handler for every component's source toggle - 'build' needs a real rebuild (to fetch that
// node's own children); the other three are pure local state changes, so they skip straight to a
// synchronous recompute+rerender with no network at all.
function setLPNodeSource(typeId, source) {
  delete window.buildSelfOverrides[typeId];
  delete window.customBuyModes[typeId];
  _lpAcquireViaLPTypeIds.delete(typeId);

  if (source === 'build') {
    window.buildSelfOverrides[typeId] = true;
    rebuildLPInspectorTree();
    return;
  }

  window.buildSelfOverrides[typeId] = false;
  if (source === 'buy-sell') window.customBuyModes[typeId] = 'sell';
  else if (source === 'buy-buy') window.customBuyModes[typeId] = 'buy';
  else if (source === 'lp') _lpAcquireViaLPTypeIds.add(typeId);

  if (_lpInspectedRoot && typeof window.syncTreeBuildStates === 'function') {
    window.syncTreeBuildStates(_lpInspectedRoot);
  }
  renderLPInspector();
}
window.setLPNodeSource = setLPNodeSource;

function toggleLPInspectorNodeCollapse(instanceId) {
  if (_lpInspectorCollapsedIds.has(instanceId)) _lpInspectorCollapsedIds.delete(instanceId);
  else _lpInspectorCollapsedIds.add(instanceId);
  renderLPInspector();
}
window.toggleLPInspectorNodeCollapse = toggleLPInspectorNodeCollapse;

// The one genuinely new calculation this feature needs - no existing function knows about
// "acquire via LP" as a third cost source alongside build/buy. Job fees and build time are NOT
// computed here; they're read off the existing shared functions once, on the whole tree, after
// this walk has set isBuildingSelf=false on any LP-acquired node (calculateNodeJobFee/
// calculateTotalBuildSeconds both already bail out immediately for a non-building node - config.js/
// optimizers.js - so that exclusion falls out for free instead of needing to be reimplemented).
function computeLPInspectorCost(node) {
  if (!node) return { iskCost: 0, lpCost: 0 };

  const matchOffers = _lpOfferByOutputTypeId[node.productTypeId || node.typeId];
  if (_lpAcquireViaLPTypeIds.has(node.typeId) && matchOffers && matchOffers.length) {
    const offer = matchOffers.slice().sort((a, b) => a.lp_cost - b.lp_cost)[0];
    const batches = Math.ceil(node.qtyNeeded / (offer.quantity || 1));
    node.isBuildingSelf = false;
    node._lpAcquiredOffer = offer;
    node._lpAcquiredBatches = batches;
    node._lpCost = { iskCost: batches * (offer.isk_cost + requiredItemsMarketCost(offer)), lpCost: batches * offer.lp_cost };
    return node._lpCost;
  }
  node._lpAcquiredOffer = null;

  if (node.isBuildingSelf && node.children && node.children.length > 0) {
    let iskCost = 0, lpCost = 0;
    node.children.forEach(child => {
      const c = computeLPInspectorCost(child);
      iskCost += c.iskCost; lpCost += c.lpCost;
    });
    node._lpCost = { iskCost, lpCost };
    return node._lpCost;
  }

  // Market buy - same convention calculateTreeNodeCost (js/optimizers.js) uses, reused via
  // getNodePriceStrategy so a per-node buy-order override behaves identically to the Calculator.
  const strategy = window.getNodePriceStrategy ? window.getNodePriceStrategy(node) : 'sell';
  const productTypeId = node.productTypeId || node.typeId;
  const prices = window.priceCache[productTypeId] || { sell: 0, buy: 0 };
  const { brokerFee } = window.getActiveFeeInputs ? window.getActiveFeeInputs() : { brokerFee: 0.01 };
  let unitPrice = strategy === 'sell' ? (prices.sell || 0) : (prices.buy || 0);
  if (strategy === 'buy') unitPrice = unitPrice * (1 + brokerFee);
  node._lpCost = { iskCost: unitPrice * node.qtyNeeded, lpCost: 0 };
  return node._lpCost;
}

// Flattens every current leaf (market-bought or LP-acquired) for the "Components Needed" panel and
// for feeding the existing Shopping List with what a live-configured build actually still needs.
function getLPInspectorComponentsList(node, out) {
  out = out || [];
  if (!node) return out;
  if (node._lpAcquiredOffer || !node.isBuildingSelf || !node.children || !node.children.length) {
    if (node.depth > 0) out.push(node);
    return out;
  }
  node.children.forEach(child => getLPInspectorComponentsList(child, out));
  return out;
}

// One pill-row source toggle, reused for every non-root node. Options offered depend on what's
// actually available for this component: Build only if it has a real recipe (node.recipe, already
// resolved by buildRecursiveRecipeTree - synthetic leaves never get one, see buildLPLeafNode's own
// note on why), LP only if this exact typeId is sold by the currently-loaded store.
function renderLPNodeSourceToggle(node) {
  const typeId = node.typeId;
  const canBuild = !!node.recipe;
  const canLP = !!(_lpOfferByOutputTypeId[node.productTypeId || typeId] && _lpOfferByOutputTypeId[node.productTypeId || typeId].length);
  const isBuild = node.isBuildingSelf && !node._lpAcquiredOffer;
  const isLP = !!node._lpAcquiredOffer;
  const isBuy = !isBuild && !isLP;
  const buyStrategy = window.getNodePriceStrategy ? window.getNodePriceStrategy(node) : 'sell';

  const pill = (active, label, onclick, title) =>
    `<button onclick="${onclick}" title="${title || ''}" class="px-1.5 py-0.5 text-[9px] font-bold" style="background:${active ? 'var(--accent)' : 'transparent'}; color:${active ? '#0a1002' : 'var(--text-mute)'};">${label}</button>`;

  let html = `<div class="flex rounded overflow-hidden flex-shrink-0" style="border:1px solid rgba(255,255,255,0.1);">`;
  if (canBuild) html += pill(isBuild, 'Build', `setLPNodeSource(${typeId}, 'build')`, 'Manufacture this component');
  html += pill(isBuy, 'Buy', `setLPNodeSource(${typeId}, '${buyStrategy === 'buy' ? 'buy-buy' : 'buy-sell'}')`, 'Buy on the market');
  if (canLP) html += pill(isLP, 'LP', `setLPNodeSource(${typeId}, 'lp')`, 'Acquire via this store\'s own LP offer instead of building or buying it');
  html += `</div>`;

  if (isBuy) {
    html += `
      <div class="flex rounded overflow-hidden flex-shrink-0 ml-1" style="border:1px solid rgba(255,255,255,0.1);">
        ${pill(buyStrategy === 'sell', 'S', `setLPNodeSource(${typeId}, 'buy-sell')`, 'Jita sell / instant-buy price')}
        ${pill(buyStrategy === 'buy', 'B', `setLPNodeSource(${typeId}, 'buy-buy')`, 'Jita highest buy order (patient, not instant)')}
      </div>`;
  }
  return html;
}

function renderLPInspectorNode(node) {
  if (!node) return '';
  const isRoot = node.depth === 0;
  const hasChildren = node.isBuildingSelf && !node._lpAcquiredOffer && node.children && node.children.length > 0;
  const collapsed = _lpInspectorCollapsedIds.has(node.instanceId);
  const productTypeId = node.productTypeId || node.typeId;
  const cost = node._lpCost || { iskCost: 0, lpCost: 0 };
  const isBpc = node.recipe && parseInt(node.recipe.blueprintTypeID) === parseInt(node.typeId);
  const iconUrl = getLPStoreIconUrl(productTypeId, false);

  const collapseToggle = hasChildren
    ? `<button onclick="toggleLPInspectorNodeCollapse('${node.instanceId}')" class="flex-shrink-0" style="color:var(--text-mute); width:14px;" title="${collapsed ? 'Expand' : 'Collapse'}">${collapsed ? '▸' : '▾'}</button>`
    : `<span style="width:14px;" class="flex-shrink-0"></span>`;

  const costLabel = cost.lpCost > 0
    ? `${Math.round(cost.lpCost).toLocaleString()} LP${cost.iskCost > 0 ? ` + ${Math.round(cost.iskCost).toLocaleString()} ISK` : ''}`
    : `${Math.round(cost.iskCost).toLocaleString()} ISK`;

  let html = `
    <div class="lp-mat-row flex items-center gap-2 mono text-[11px] py-1 px-1.5 rounded" style="padding-left:${8 + node.depth * 18}px;">
      ${collapseToggle}
      <img src="${iconUrl}" alt="" class="w-5 h-5 rounded flex-shrink-0" loading="lazy" onerror="window.handleLPIconLoadError(this);">
      <span class="truncate flex-1 min-w-0" style="color:${isRoot ? 'var(--accent)' : 'var(--text);'} ${isRoot ? 'font-weight:bold;' : ''}">${window.esc(node.productName || node.name)}</span>
      <span class="flex-shrink-0" style="color:var(--text-mute); width:70px; text-align:right;">×${Math.round(node.qtyNeeded).toLocaleString()}</span>
      ${!isRoot ? renderLPNodeSourceToggle(node) : (isBpc ? `<span class="text-[9px] mono px-1.5 py-0.5 rounded flex-shrink-0" style="background:rgba(192,132,252,0.15); color:#c084fc;">BPC</span>` : '')}
      <span class="flex-shrink-0 text-right font-bold" style="width:150px; color:${node._lpAcquiredOffer ? '#c084fc' : 'var(--text);'}">${costLabel}</span>
    </div>`;

  if (hasChildren && !collapsed) {
    html += node.children.map(renderLPInspectorNode).join('');
  }
  return html;
}

function renderLPInspector() {
  const header = document.getElementById('lpstore-inspector-header');
  const summaryEl = document.getElementById('lpstore-inspector-summary');
  const rowsEl = document.getElementById('lpstore-inspector-rows');
  const result = _lpInspectedResult;
  if (!header || !summaryEl || !rowsEl || !result) return;

  const isBpc = result.offerType === 'bpc';
  const iconUrl = getLPStoreIconUrl(result.outputTypeId, isBpc);
  header.innerHTML = `
    <button onclick="exitLPInspector()" class="btn-glass btn-glass-muted px-2.5 py-1.5 text-[11px] flex items-center gap-1.5 flex-shrink-0">${window.svgIcon ? window.svgIcon('collapse') : '←'} Back to List</button>
    <img src="${iconUrl}" alt="" class="w-8 h-8 rounded flex-shrink-0" loading="lazy" onerror="window.handleLPIconLoadError(this);">
    <span class="font-bold text-white truncate flex-1 min-w-0">${window.esc(result.outputName)}</span>
    ${isBpc ? `<button onclick="sendLPOfferToCalculator(${result.offer.offer_id})" class="btn-glass px-2.5 py-1.5 text-[11px] flex-shrink-0" title="Open this blueprint in the main Calculator's own tree for full optimization and Add to Ledger.">Open in Calculator →</button>` : ''}
  `;

  const root = _lpInspectedRoot;
  if (!root) {
    summaryEl.innerHTML = '';
    rowsEl.innerHTML = `<div class="text-center py-10 italic" style="color:var(--text-mute);">Could not build this item's recipe tree.</div>`;
    return;
  }

  const { iskCost: treeIskCost, lpCost: acquiredLpCost } = computeLPInspectorCost(root);

  if (typeof window.calculateNodeEIV === 'function') window.calculateNodeEIV(root);
  const { facilityTax, sccSurcharge, salesTax, brokerFee } = window.getActiveFeeInputs ? window.getActiveFeeInputs() : { facilityTax: 0.01, sccSurcharge: 0.04, salesTax: 0.036, brokerFee: 0.01 };
  const structureType = window.getActiveStructureType ? window.getActiveStructureType() : { costBonus: 5.0 };
  const structureRoleBonus = structureType.costBonus / 100;
  const jobFee = (isBpc && typeof window.calculateNodeJobFee === 'function') ? window.calculateNodeJobFee(root, facilityTax, sccSurcharge, structureRoleBonus) : 0;
  const buildSeconds = (isBpc && typeof window.calculateTotalBuildSeconds === 'function') ? window.calculateTotalBuildSeconds(root) : 0;

  const offer = result.offer;
  const batches = Math.ceil(_lpInspectedTargetQty / (offer.quantity || 1));
  // The root offer's OWN redemption cost (getting the BPC, or the direct-sell item, in hand at
  // all) - not part of the material tree, since the tree only represents what's needed to BUILD a
  // BPC's product. For a direct-sell offer the required_items ARE the tree (see
  // rebuildLPInspectorTree's synthetic root), so only the flat isk_cost portion is added here for
  // that case, to avoid double-counting.
  const rootIskCost = batches * offer.isk_cost + (isBpc ? batches * requiredItemsMarketCost(offer) : 0);
  const rootLpCost = batches * offer.lp_cost;

  const totalIskCost = treeIskCost + jobFee + rootIskCost;
  const totalLpCost = acquiredLpCost + rootLpCost;

  const outputPrice = (window.priceCache[result.outputTypeId] || {}).sell || 0;
  const outputQty = isBpc ? (root.qtyNeeded || 0) : _lpInspectedTargetQty;
  const grossRevenue = outputPrice * outputQty;
  const revenue = grossRevenue * (1 - salesTax - brokerFee);
  const profit = revenue - totalIskCost;
  const iskPerLp = totalLpCost > 0 ? profit / totalLpCost : null;
  const profitColor = profit > 0 ? 'var(--accent)' : 'var(--red-400, #f87171)';

  const tile = (label, value, color) => `
    <div class="lp-card p-3">
      <div class="text-[10px] uppercase tracking-wider" style="color:var(--text-mute);">${label}</div>
      <div class="text-lg font-bold mono" style="color:${color || 'var(--text)'};">${value}</div>
    </div>`;

  summaryEl.innerHTML = `
    <div class="lp-row flex items-end gap-2">
      <div class="flex-1">
        <label class="lp-label mb-1 block">Target Quantity</label>
        <input type="number" min="1" value="${_lpInspectedTargetQty}" onchange="setLPInspectorTargetQty(this.value)" class="field-line field-editable w-full text-center font-bold mono">
      </div>
      <button onclick="addLPInspectorComponentsToShoppingList()" class="btn-glass btn-glass-muted px-2.5 py-2 text-[11px] flex-shrink-0">+ Add Components to Shopping List</button>
    </div>
    <div class="grid grid-cols-2 md:grid-cols-3 gap-2.5">
      ${tile('Total ISK Cost', Math.round(totalIskCost).toLocaleString())}
      ${tile('Total LP Cost', totalLpCost.toLocaleString())}
      ${tile('Est. Revenue', Math.round(revenue).toLocaleString())}
      ${tile('Est. Profit', Math.round(profit).toLocaleString(), profitColor)}
      ${tile('ISK / LP', iskPerLp === null ? '—' : Math.round(iskPerLp).toLocaleString(), profitColor)}
      ${tile('Est. Build Time', buildSeconds > 0 ? window.formatDurationCompact(buildSeconds) : '—')}
    </div>`;

  rowsEl.innerHTML = renderLPInspectorNode(root);
}
window.renderLPInspector = renderLPInspector;

// Reuses the existing standalone Shopping List (see its own section below) - the components list
// is derived from the LIVE tree (whatever's currently toggled to buy or LP), not the raw offer
// data, so it reflects exactly what the current configuration actually still needs to acquire.
function addLPInspectorComponentsToShoppingList() {
  if (!_lpInspectedRoot) return;
  const leaves = getLPInspectorComponentsList(_lpInspectedRoot);
  let added = 0;
  leaves.forEach(node => {
    if (node._lpAcquiredOffer) return; // LP-acquired components are redeemed, not market-bought
    const typeId = node.productTypeId || node.typeId;
    const existing = _lpShoppingList.find(x => x.typeId === typeId);
    if (existing) existing.qty += node.qtyNeeded;
    else _lpShoppingList.push({ typeId, name: getLPItemName(typeId), qty: node.qtyNeeded, mode: 'sell' });
    added++;
  });
  saveLPShoppingList();
  renderLPShoppingList();
  if (typeof window.showToast === 'function') window.showToast(added ? 'Components added to shopping list.' : 'Nothing to add - every component is set to Build or Acquire via LP.', added ? 'success' : 'info');
}
window.addLPInspectorComponentsToShoppingList = addLPInspectorComponentsToShoppingList;

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
        ? `<button onclick="event.stopPropagation(); sendLPOfferToCalculator(${offer.offer_id});" class="btn-glass btn-glass-muted px-2.5 py-1 text-[10px]" title="Opens this blueprint in the main Calculator's tree for full optimization and Add to Ledger.">Open in Calculator →</button>`
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
              <div class="mt-2.5 pt-2.5 flex gap-2" style="border-top:1px solid rgba(255,255,255,0.06);">
                <button onclick="event.stopPropagation(); isolateOffer(${offer.offer_id});" class="btn-glass px-2.5 py-1 text-[10px]" title="Isolate this offer into a full interactive tree - toggle build/buy/LP per component and see ISK/LP update live.">Isolate →</button>
                ${buildBtn}${addToListBtn}
              </div>
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
            <button onclick="event.stopPropagation(); isolateOffer(${offer.offer_id});" class="icon-btn flex-shrink-0" style="width:26px;height:26px;" title="Isolate: open a full interactive build tree for this offer">${window.svgIcon ? window.svgIcon('expand', { style: 'width:13px;height:13px;' }) : '⤢'}</button>
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
