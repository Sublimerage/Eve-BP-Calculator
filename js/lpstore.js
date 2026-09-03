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
let _lpOfferByOutputTypeId = {}; // typeId -> [offers], built per corp load - also mirrored onto
                                  // window.__lpOfferByOutputTypeId so js/app.js and js/optimizers.js
                                  // (loaded before this file, no direct access to this module's own
                                  // variables) can see it too.
let _lpIsolatedResult = null; // the ranked-result currently isolated in the canvas view, or null

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
  ['viewport', 'bom-sidebar', 'lpstore-calc-stat-strip', 'lpstore-inspector-extra-stats'].forEach(id => document.getElementById(id)?.classList.remove('hidden'));

  const nameEl = document.getElementById('lpstore-inspector-name');
  if (nameEl) nameEl.textContent = result.outputName;

  if (result.offerType === 'bpc') {
    // selectItem (js/app.js) is the Calculator's own "load this blueprint" entry point - it resets
    // every build/buy/ME/TE override, builds the real recipe tree, fetches prices, and calls
    // recalculate() itself. Runs are set to this offer's own quantity afterward, same pattern
    // js/app.js's own loadBlueprintIntoCalculator uses for a real owned BPC.
    window.selectItem(result.blueprintTypeId, getLPItemName(result.blueprintTypeId), false).then(async () => {
      window.globalRuns = result.bpcCopies || 1;
      await window.fetchMarketPrices((result.offer.required_items || []).map(r => r.type_id));
      injectLPRedemptionNodes(window.recipeTreeRoot, result.offer);
      if (typeof window.recalculate === 'function') window.recalculate();
    });
  } else {
    isolateDirectSellOffer(result);
  }
}
window.isolateOffer = isolateOffer;

// No blueprint exists for a direct-sell offer, so selectItem() doesn't apply - this builds a
// synthetic root in the exact shape selectItem() would have produced (same fields recalculate()/
// createNodeCard() read), with isBuildingSelf:true so its children (the required_items, injected
// below) actually render and get summed into the cost - "as if we're building it", per the request
// this was built from, even though there's no manufacturing job behind it (recipe stays null, so
// calculateNodeJobFee/calculateTotalBuildSeconds both naturally contribute 0 - no special-casing
// needed there). batchYield is this offer's own quantity-per-redemption and globalRuns starts at 1
// redemption, so the existing qtyNeeded = batchYield * runs math (recalculate(), unmodified) falls
// out correctly with no new formula.
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
  injectLPRedemptionNodes(window.recipeTreeRoot, offer);
  if (typeof window.recalculate === 'function') window.recalculate();
}

function exitLPInspector() {
  _lpIsolatedResult = null;
  ['viewport', 'bom-sidebar', 'lpstore-calc-stat-strip', 'lpstore-inspector-extra-stats'].forEach(id => document.getElementById(id)?.classList.add('hidden'));
  document.getElementById('lpstore-main-area')?.classList.remove('hidden');
}
window.exitLPInspector = exitLPInspector;

// How many times the isolated offer is being redeemed, given the current run count - the unit
// "runs" means differs by offer type (see isolateDirectSellOffer's own note), so this is the one
// place that distinction is resolved, shared by the redemption-node sync below and the stat strip.
function getLPRedemptionBatches(result) {
  const runs = window.globalRuns || 1;
  if (result.offerType === 'bpc') return Math.ceil(runs / (result.offer.quantity || 1));
  return runs; // direct-sell root: "runs" already directly means "times redeemed"
}

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

// scaleTreeQuantities (js/tree.js) only touches a child whose typeId appears in the PARENT's own
// recipe.materials - a redemption-requirement node never matches that (it isn't a build material),
// so its qtyNeeded is never touched by the Calculator's own recompute and has to be kept in sync
// here instead, run BEFORE the wrapped recalculate() below so cost/BOM/cards all see the right
// number on the same pass, not one render behind.
function syncLPRedemptionNodes() {
  if (!_lpIsolatedResult || !window.recipeTreeRoot) return;
  const batches = getLPRedemptionBatches(_lpIsolatedResult);
  (window.recipeTreeRoot.children || []).forEach(child => {
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
    syncLPRedemptionNodes();
    const result = original.apply(this, args);
    renderLPExtraStats();
    return result;
  };
  wrapped.__lpWrapped = true;
  window.recalculate = wrapped;
}

// The Calculator's own stat strip has no concept of LP - this adds the numbers unique to this page
// alongside it, without touching the Calculator's own stats at all. Only the offer's flat isk_cost/
// lp_cost (no typeId, can't be a tree node) needs adding on top here now - required_items are real
// tree children at this point, so window.recipeTreeRoot.calculatedCost (materials + job fee, the
// Calculator's own unmodified figure) already includes them.
function renderLPExtraStats() {
  const el = document.getElementById('lpstore-inspector-extra-stats');
  if (!el) return;
  if (!_lpIsolatedResult || !window.recipeTreeRoot) { el.innerHTML = ''; return; }

  const result = _lpIsolatedResult;
  const offer = result.offer;
  const batches = getLPRedemptionBatches(result);
  const flatIskCost = batches * offer.isk_cost;
  const flatLpCost = batches * offer.lp_cost;
  const acquiredLpCost = window.__lpSpentThisRecalc || 0;

  const totalIskCost = (window.recipeTreeRoot.calculatedCost || 0) + flatIskCost;
  const totalLpCost = acquiredLpCost + flatLpCost;

  // recalculate() already computed net sell revenue net of tax/broker (outputMarketValue is the
  // gross figure it derived that from) - profit is redone here against totalIskCost (which the
  // Calculator's own netProfitSell doesn't know about) rather than reused directly.
  const { salesTax, brokerFee } = window.getActiveFeeInputs ? window.getActiveFeeInputs() : { salesTax: 0.036, brokerFee: 0.01 };
  const grossRevenue = window.recipeTreeRoot.outputMarketValue || 0;
  const netRevenue = grossRevenue * (1 - salesTax - brokerFee);
  const profit = netRevenue - totalIskCost;
  const iskPerLp = totalLpCost > 0 ? profit / totalLpCost : null;
  const profitColor = profit > 0 ? 'var(--accent)' : 'var(--red-400, #f87171)';

  const tile = (label, value, color, title) => `
    <div class="lp-card p-3" ${title ? `title="${window.esc(title)}"` : ''}>
      <div class="text-[10px] uppercase tracking-wider" style="color:var(--text-mute);">${label}</div>
      <div class="text-lg font-bold mono" style="color:${color || 'var(--text)'};">${value}</div>
    </div>`;

  el.innerHTML = `
    ${tile('Total ISK Cost', Math.round(totalIskCost).toLocaleString(), null, 'Build materials + required redemption items (both shown as cards below) + job install fee + the flat ISK portion of redeeming this offer')}
    ${tile('Redemption Fee (flat)', `${Math.round(flatIskCost).toLocaleString()} ISK + ${flatLpCost.toLocaleString()} LP`, null, 'The pure ISK/LP portion of redeeming this offer, on top of the required items shown as purple cards in the tree below (those are already counted in Total ISK Cost).')}
    ${tile('Total LP Spent', totalLpCost.toLocaleString(), null, 'Redemption LP + any component set to "Acquire via LP" in the tree')}
    ${tile('LP-Aware Profit', Math.round(profit).toLocaleString(), profitColor, 'Net sell revenue minus build materials, required redemption items, job fee, and the flat redemption fee')}
    ${tile('ISK / LP', iskPerLp === null ? '—' : Math.round(iskPerLp).toLocaleString(), profitColor)}
  `;
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
    // offer_id, not a data glitch). Previously only visible after a click, which read as duplicate
    // junk.
    const requiredItemsSummary = offer.required_items.length
      ? offer.required_items.map(r2 => `${r2.quantity}x ${window.esc(getLPItemName(r2.type_id))}`).join(', ')
      : (offer.isk_cost > 0 ? 'ISK + LP only' : 'LP only');

    // Isolate opens the real Calculator canvas for ANY offer now - a BPC gets its actual recipe
    // tree, a direct-sell item gets a synthetic root standing in for "the item you receive" (see
    // isolateDirectSellOffer) - either way its required_items render as real (purple) cards too.
    const isolateBtn = `<button onclick="event.stopPropagation(); isolateOffer(${offer.offer_id});" class="icon-btn flex-shrink-0" style="width:26px;height:26px;" title="Isolate: open this offer in the Calculator's own tree view">${window.svgIcon ? window.svgIcon('expand', { style: 'width:13px;height:13px;' }) : '⤢'}</button>`;

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
  select.innerHTML = '<option value="">— Choose a warzone LP store —</option>' +
    FW_WARZONE_CORPS.map(c => `<option value="${c.corpId}" style="color:${c.color}; font-weight:bold;">${window.esc(c.faction)} — ${window.esc(c.corpName)}</option>`).join('');
}

// addEventListener rather than a plain `window.onload =` assignment - js/app.js (also loaded on
// this page, for the real tree canvas/BOM sidebar) registers its own load handler the same way;
// a raw assignment here would silently clobber it. js/app.js's own onload already covers
// buildPrepackedIndexes, handleEsiSSOCallback, loadSavedSystem, and fetchAdjustedPrices (its
// listener registers first, since app.js's <script> tag comes before this one) - only this page's
// own setup is repeated here.
window.addEventListener('load', async () => {
  populateLPStoreCorpSelect();
  loadSharedTaxSettingsForLPStore();
  renderLPStoreActiveStationLabel();
  renderLPStoreState();
  installLPRecalculateHook();

  const lastCorp = localStorage.getItem('eve_lpstore_last_corp');
  const select = document.getElementById('lpstore-corp-select');
  if (lastCorp && select) {
    select.value = lastCorp;
    loadAndRankLPStore(lastCorp);
  }
});
