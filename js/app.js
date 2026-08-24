'use strict';

if (window.rootSellStrategy === undefined) window.rootSellStrategy = 'market-sell';
if (window.rootCustomPrice === undefined) window.rootCustomPrice = 0;
if (window.globalRuns === undefined) window.globalRuns = 1;

// (extractBuildTime, calculateAdjustedJobSeconds, calculateTotalBuildSeconds moved to config.js so
// the calculator, ledger, and invention pages can all share the same real time calculation)


// Binds custom card overrides directly to tree node structures before calculations
function syncTreeOverrides(node) {
  if (!node) return;
  const tId = node.typeId;
  const meMap = window.customMEOverrides || {};
  const teMap = window.customTEOverrides || {};
  node.customME = meMap[tId] !== undefined ? meMap[tId] : 0;
  node.customTE = teMap[tId] !== undefined ? teMap[tId] : 0;
  if (node.children) {
    node.children.forEach(syncTreeOverrides);
  }
}

function saveTaxSettings() {
  try {
    // facility-select's value is now the structure key itself (npc/raitaru/azbel/sotiyo) - a structure
    // is one thing at a time, so there's exactly one place this is read from.
    const facilityKey = document.getElementById('facility-select')?.value || 'sotiyo';
    localStorage.setItem('eve_active_facility_key', facilityKey);

    // Rig slot typeIds are written directly by selectRigForSlot() when the user picks one from the
    // search results - just read them back here to include in the settings snapshot.
    const rigSlot1 = localStorage.getItem('eve_rig_slot_1') || '';
    const rigSlot2 = localStorage.getItem('eve_rig_slot_2') || '';
    const rigSlot3 = localStorage.getItem('eve_rig_slot_3') || '';

    const settings = {
      facilityTax: document.getElementById('facility-tax')?.value,
      sccSurcharge: document.getElementById('scc-surcharge')?.value,
      salesTax: document.getElementById('sales-tax')?.value,
      brokerFee: document.getElementById('broker-fee')?.value,
      facilitySelect: facilityKey,
      contractTax: document.getElementById('contract-tax')?.value,
      contractBroker: document.getElementById('contract-broker')?.value,
      rigSlot1: rigSlot1,
      rigSlot2: rigSlot2,
      rigSlot3: rigSlot3
    };
    localStorage.setItem('eve_tax_settings', JSON.stringify(settings));
  } catch (e) {}
}

// Called immediately when the structure-type dropdown changes, so the canonical localStorage key is
// updated right away (saveTaxSettings also does this, but this makes the single-source-of-truth
// intent explicit and keeps it working even if saveTaxSettings' own logic changes later).
function onStructureTypeChange() {
  const facilityKey = document.getElementById('facility-select')?.value || 'sotiyo';
  localStorage.setItem('eve_active_facility_key', facilityKey);
}
window.onStructureTypeChange = onStructureTypeChange;

function loadTaxSettings() {
  try {
    const saved = localStorage.getItem('eve_tax_settings');
    if (saved) {
      const settings = window.safeParseJSON(saved, {});
      if (settings.facilityTax !== undefined && document.getElementById('facility-tax')) document.getElementById('facility-tax').value = settings.facilityTax;
      if (settings.sccSurcharge !== undefined && document.getElementById('scc-surcharge')) document.getElementById('scc-surcharge').value = settings.sccSurcharge;
      if (settings.salesTax !== undefined && document.getElementById('sales-tax')) document.getElementById('sales-tax').value = settings.salesTax;
      if (settings.brokerFee !== undefined && document.getElementById('broker-fee')) document.getElementById('broker-fee').value = settings.brokerFee;
      if (settings.facilitySelect !== undefined && document.getElementById('facility-select')) document.getElementById('facility-select').value = settings.facilitySelect;
      if (settings.contractTax !== undefined && document.getElementById('contract-tax')) document.getElementById('contract-tax').value = settings.contractTax;
      if (settings.contractBroker !== undefined && document.getElementById('contract-broker')) document.getElementById('contract-broker').value = settings.contractBroker;
    }
  } catch (e) {}
}

// Filters the real rig item catalog (pulled from the generated database) as the user types, and
// renders matching results in the dropdown below the search box.
function searchRigSlot(slotNum, query) {
  const resultsEl = document.getElementById(`rig-slot-${slotNum}-results`);
  if (!resultsEl) return;
  const catalog = typeof window.getRigItemCatalog === 'function' ? window.getRigItemCatalog() : [];
  if (catalog.length === 0) {
    resultsEl.innerHTML = `<div class="p-1.5 text-slate-500">No rig data found - regenerate your database (generate_db.py) to enable rig search.</div>`;
    resultsEl.classList.remove('hidden');
    return;
  }
  const q = (query || '').trim().toLowerCase();
  const matches = (q ? catalog.filter(r => r.name.toLowerCase().includes(q)) : catalog).slice(0, 25);
  const noneRow = `<div class="px-1.5 py-1 hover:bg-[#3a4a4c] cursor-pointer text-slate-400 border-b border-[#3a4a4c]/40" onmousedown="selectRigForSlot(${slotNum}, 0, '')">— None —</div>`;
  const matchRows = matches.length > 0
    ? matches.map(r => `<div class="px-1.5 py-1 hover:bg-[#3a4a4c] cursor-pointer border-b border-[#3a4a4c]/20" onmousedown="selectRigForSlot(${slotNum}, ${r.typeId}, '${window.esc(r.name)}')">${window.esc(r.name)}</div>`).join('')
    : `<div class="p-1.5 text-slate-500">No matching rigs found.</div>`;
  resultsEl.innerHTML = noneRow + matchRows;
  resultsEl.classList.remove('hidden');
}
window.searchRigSlot = searchRigSlot;

// Applies a rig selection (or clears it with typeId 0) for the given slot, persists it, and
// recalculates. Uses onmousedown (not onclick) in the results list above so it fires before the
// search input's onblur hides the dropdown.
function selectRigForSlot(slotNum, typeId, name) {
  const inputEl = document.getElementById(`rig-slot-${slotNum}-input`);
  const resultsEl = document.getElementById(`rig-slot-${slotNum}-results`);
  if (inputEl) inputEl.value = typeId ? name : '';
  if (resultsEl) resultsEl.classList.add('hidden');
  localStorage.setItem(`eve_rig_slot_${slotNum}`, typeId ? String(typeId) : '');
  saveTaxSettings();
  recalculate();
}
window.selectRigForSlot = selectRigForSlot;

// Restores each rig slot's search input to show the saved rig's real name (looked up by the stored
// typeId), since the input just displays text - the typeId in localStorage is the actual saved state.
// --- Blueprint Browser ---
let _blueprintBrowserData = [];

async function openBlueprintBrowser() {
  const backdrop = document.getElementById('blueprint-browser-backdrop');
  const drawer = document.getElementById('blueprint-browser-drawer');
  if (backdrop) backdrop.classList.remove('hidden');
  if (drawer) requestAnimationFrame(() => drawer.classList.remove('translate-x-full'));
  if (_blueprintBrowserData.length === 0) {
    await loadBlueprintBrowserData();
  }
}
window.openBlueprintBrowser = openBlueprintBrowser;

function closeBlueprintBrowser() {
  const backdrop = document.getElementById('blueprint-browser-backdrop');
  const drawer = document.getElementById('blueprint-browser-drawer');
  if (drawer) drawer.classList.add('translate-x-full');
  if (backdrop) setTimeout(() => backdrop.classList.add('hidden'), 300);
}
window.closeBlueprintBrowser = closeBlueprintBrowser;

async function loadBlueprintBrowserData() {
  const listEl = document.getElementById('blueprint-browser-list');
  if (listEl) listEl.innerHTML = `<div class="text-slate-500 italic p-4 text-center">Loading your blueprints...</div>`;

  const [charBps, corpBps] = await Promise.all([
    typeof window.fetchCharacterBlueprints === 'function' ? window.fetchCharacterBlueprints() : [],
    typeof window.fetchCorpBlueprints === 'function' ? window.fetchCorpBlueprints() : []
  ]);

  const allBps = [...(charBps || []).map(b => ({ ...b, source: 'Personal' })), ...(corpBps || []).map(b => ({ ...b, source: 'Corp' }))];

  if (allBps.length === 0) {
    if (listEl) listEl.innerHTML = `<div class="text-slate-500 italic p-4 text-center">No blueprints found - make sure you're logged in via EVE SSO, or you may not own any.</div>`;
    return;
  }

  // Resolving which STATION a blueprint is really in (when it's sitting inside a container/can)
  // requires the character's full asset list, since a blueprint's own location_id points at the
  // container itself, not the station - the same hierarchy walk the asset/stock viewer already does.
  if (!window.rawAssetItems || window.rawAssetItems.length === 0) {
    if (listEl) listEl.innerHTML = `<div class="text-slate-500 italic p-4 text-center">Fetching your assets to resolve station/container locations...</div>`;
    if (typeof window.refreshLiveAssets === 'function') {
      try { await window.refreshLiveAssets(); } catch (e) { console.warn('Asset refresh for blueprint browser failed:', e); }
    }
  }

  const itemIdToAssetMap = window.buildItemIdToAssetMap ? window.buildItemIdToAssetMap() : {};
  allBps.forEach(b => {
    const hierarchy = window.resolveItemLocationHierarchy
      ? window.resolveItemLocationHierarchy(b.location_id, itemIdToAssetMap)
      : { rootLocationId: b.location_id, containerId: null };
    b.rootLocationId = hierarchy.rootLocationId;
    b.containerId = hierarchy.containerId;
  });

  // Resolve station/structure names for the root locations, and container names (custom in-game
  // names, if any were set) for anything sitting inside a container - both feed the same reliable
  // resolver/cache the stock viewer uses.
  const rootLocationIds = [...new Set(allBps.map(b => b.rootLocationId))];
  if (typeof window.resolveLocationIds === 'function') {
    await window.resolveLocationIds(rootLocationIds);
  }
  allBps.forEach(b => {
    b.stationName = (window.resolvedLocationNames && window.resolvedLocationNames[b.rootLocationId]) || `Location ${b.rootLocationId}`;
    if (b.containerId) {
      const containerAsset = itemIdToAssetMap[b.containerId];
      const containerTypeName = containerAsset ? (window.TYPE_ID_TO_NAME[containerAsset.type_id] || 'Container') : 'Container';
      const customName = window.resolvedLocationNames && window.resolvedLocationNames[b.containerId];
      b.containerName = customName || `${containerTypeName} (#${String(b.containerId).slice(-5)})`;
    } else {
      b.containerName = null;
    }
    // Category filter needs the PRODUCT's category (Ship/Module/Drone/Ammo/etc), not the blueprint's
    // own category (which is always "Blueprint") - resolve via the already-loaded recipe data.
    const recipe = window.recipeMap && window.recipeMap[b.type_id];
    const productTypeId = (recipe && recipe.productTypeID) || (window.BLUEPRINT_TO_PRODUCT_MAP && window.BLUEPRINT_TO_PRODUCT_MAP[b.type_id]);
    b.productTypeId = productTypeId;
    b.categoryId = (productTypeId && window.EVE_CATEGORIES) ? window.EVE_CATEGORIES[productTypeId] : undefined;
  });

  _blueprintBrowserData = allBps;
  populateBlueprintLocationDropdown();
  filterBlueprintBrowser();
}
window.loadBlueprintBrowserData = loadBlueprintBrowserData;

// Mirrors the calculator's populateLocationDropdown() structure (all/system/station/corp-division/
// container hierarchy with counts) but sourced from blueprint data and targeting its own dropdown -
// a separate element ID since index.html already has #stock-location-filter for general stock, and
// duplicate IDs on the same page would break document.getElementById lookups.
function populateBlueprintLocationDropdown() {
  const filterSelect = document.getElementById('blueprint-location-filter');
  if (!filterSelect) return;
  const currentSystemName = (document.getElementById('system-search')?.value || 'JITA').toUpperCase();
  const currentValue = filterSelect.value || 'all';
  filterSelect.innerHTML = `
    <option value="all" style="color: #38bdf8; background-color: #0a0d0e; font-weight: bold;">All Locations</option>
    <option value="industry_system" style="color: #38bdf8; background-color: #0a0d0e; font-weight: bold;">Current System Only (${currentSystemName})</option>
  `;
  const sagNameMap = {
    'CorpSAG1': window.corpDivisionNames[1] || 'DIVISION 1',
    'CorpSAG2': window.corpDivisionNames[2] || 'DIVISION 2',
    'CorpSAG3': window.corpDivisionNames[3] || 'DIVISION 3',
    'CorpSAG4': window.corpDivisionNames[4] || 'DIVISION 4',
    'CorpSAG5': window.corpDivisionNames[5] || 'DIVISION 5',
    'CorpSAG6': window.corpDivisionNames[6] || 'DIVISION 6',
    'CorpSAG7': window.corpDivisionNames[7] || 'DIVISION 7',
    'CorpDeliveries': 'CORP DELIVERIES'
  };
  const locCounts = {};
  _blueprintBrowserData.forEach(bp => {
    const locId = bp.rootLocationId;
    const locName = bp.stationName || `Location #${locId}`;
    if (!locCounts[locId]) {
      locCounts[locId] = { name: locName, count: 0, corpDivisions: {}, containers: {} };
    }
    locCounts[locId].count += 1;
    if (bp.source === 'Corp' && bp.location_flag && bp.location_flag.startsWith('Corp')) {
      const sagFlag = bp.location_flag;
      if (!locCounts[locId].corpDivisions[sagFlag]) {
        locCounts[locId].corpDivisions[sagFlag] = { name: sagNameMap[sagFlag] || sagFlag, count: 0 };
      }
      locCounts[locId].corpDivisions[sagFlag].count += 1;
    }
    if (bp.containerId) {
      const cId = bp.containerId;
      const cName = bp.containerName || `Container #${cId}`;
      if (!locCounts[locId].containers[cId]) {
        locCounts[locId].containers[cId] = { name: cName, count: 0 };
      }
      locCounts[locId].containers[cId].count += 1;
    }
  });
  for (const [locId, data] of Object.entries(locCounts)) {
    const mainOpt = document.createElement('option');
    mainOpt.value = `loc_${locId}`;
    const numericLocId = parseInt(locId);
    const isUpwellStructure = numericLocId > 1000000000000;
    mainOpt.style.color = isUpwellStructure ? '#f97316' : '#4caf6f';
    mainOpt.style.backgroundColor = '#0a0d0e';
    mainOpt.style.fontWeight = 'bold';
    mainOpt.textContent = `${isUpwellStructure ? '🟧' : '🟩'} ${data.name} (${data.count})`;
    filterSelect.appendChild(mainOpt);
    for (const [sagFlag, sagData] of Object.entries(data.corpDivisions)) {
      const sagOpt = document.createElement('option');
      sagOpt.value = `corpsag_${locId}_${sagFlag}`;
      sagOpt.style.color = '#c084fc';
      sagOpt.style.backgroundColor = '#030405';
      sagOpt.style.fontWeight = 'bold';
      sagOpt.textContent = `  └─ 🟪 Corp: ${sagData.name} (${sagData.count})`;
      filterSelect.appendChild(sagOpt);
    }
    for (const [cId, cData] of Object.entries(data.containers)) {
      const containerOpt = document.createElement('option');
      containerOpt.value = `container_${cId}`;
      containerOpt.style.color = '#f8fafc';
      containerOpt.style.backgroundColor = '#030405';
      containerOpt.textContent = `  └─ 📦 ${cData.name} (${cData.count})`;
      filterSelect.appendChild(containerOpt);
    }
  }
  filterSelect.value = filterSelect.querySelector(`option[value="${currentValue}"]`) ? currentValue : 'all';
}
window.populateBlueprintLocationDropdown = populateBlueprintLocationDropdown;

// Mirrors esi.js's filterLocationDropdownOptions() - text-filters the option list itself, since with
// many locations the dropdown is its own thing to search through.
function filterBlueprintLocationDropdownOptions() {
  const query = (document.getElementById('blueprint-location-search')?.value || '').trim().toUpperCase();
  const filterSelect = document.getElementById('blueprint-location-filter');
  if (!filterSelect) return;
  filterSelect.querySelectorAll('option').forEach(opt => {
    if (opt.value === 'all' || opt.value === 'industry_system') { opt.hidden = false; return; }
    opt.hidden = query.length > 0 && !opt.textContent.toUpperCase().includes(query);
  });
}
window.filterBlueprintLocationDropdownOptions = filterBlueprintLocationDropdownOptions;

// Mirrors esi.js's applyStockLocationFilter() value parsing (all/industry_system/loc_/corpsag_/
// container_) but filters the blueprint list itself rather than building a stock quantity map.
function blueprintMatchesLocationFilter(bp, filterVal, activeSystemName) {
  if (filterVal === 'all') return true;
  if (filterVal === 'industry_system') return (bp.stationName || '').toUpperCase().includes(activeSystemName);
  if (filterVal.startsWith('loc_')) {
    return bp.rootLocationId === parseInt(filterVal.replace('loc_', ''));
  }
  if (filterVal.startsWith('corpsag_')) {
    const parts = filterVal.split('_');
    return bp.rootLocationId === parseInt(parts[1]) && bp.location_flag === parts[2];
  }
  if (filterVal.startsWith('container_')) {
    return bp.containerId === parseInt(filterVal.replace('container_', ''));
  }
  return true;
}

const BLUEPRINT_BROWSER_KNOWN_CATEGORIES = [6, 7, 18, 8, 65, 32]; // Ships, Modules, Drones, Ammo/Charges, Structures, Subsystems

function getCurrentlyFilteredBlueprints() {
  const q = (document.getElementById('blueprint-browser-search')?.value || '').toLowerCase().trim();
  const loc = document.getElementById('blueprint-location-filter')?.value || 'all';
  const activeSystemName = (document.getElementById('system-search')?.value || 'JITA').toUpperCase();
  const useChar = document.getElementById('blueprint-use-char')?.checked ?? true;
  const useCorp = document.getElementById('blueprint-use-corp')?.checked ?? true;
  const typeFilter = document.getElementById('blueprint-type-filter')?.value || 'all';
  const categoryFilter = document.getElementById('blueprint-category-filter')?.value || 'all';

  return _blueprintBrowserData.filter(b => {
    if (b.source === 'Personal' && !useChar) return false;
    if (b.source === 'Corp' && !useCorp) return false;
    const name = (window.TYPE_ID_TO_NAME[b.type_id] || `Type ${b.type_id}`).toLowerCase();
    if (q && !name.includes(q)) return false;
    if (!blueprintMatchesLocationFilter(b, loc, activeSystemName)) return false;
    if (typeFilter === 'bpo' && b.quantity !== -1) return false;
    if (typeFilter === 'bpc' && b.quantity === -1) return false;
    if (categoryFilter !== 'all') {
      if (categoryFilter === 'other') {
        if (BLUEPRINT_BROWSER_KNOWN_CATEGORIES.includes(b.categoryId)) return false;
      } else if (b.categoryId !== parseInt(categoryFilter)) {
        return false;
      }
    }
    return true;
  });
}

function filterBlueprintBrowser() {
  const stackEnabled = document.getElementById('blueprint-stack-toggle')?.checked ?? true;
  const sortByProfit = document.getElementById('blueprint-sort-by-profit')?.checked ?? false;
  const filtered = getCurrentlyFilteredBlueprints();
  renderBlueprintBrowserList(filtered, stackEnabled, sortByProfit);
}
window.filterBlueprintBrowser = filterBlueprintBrowser;

// Groups identical BPOs/BPCs into one displayed entry with a stack count - same type, ME, and TE for
// BPOs; same type, ME, TE, AND runs for BPCs (runs isn't meaningful for a BPO, which never depletes).
// Also correctly folds in blueprints ESI already reports as a pre-stacked group (quantity > 0).
// --- Profit Scanner ---
let _blueprintProfitCache = null; // key -> {profit, iskPerHour, runsUsed, qtyProduced, scannedAt} | null (scan failed) - loaded lazily from localStorage
const BLUEPRINT_PROFIT_CACHE_KEY = 'eve_blueprint_profit_cache';

function getBlueprintProfitCache() {
  if (_blueprintProfitCache === null) {
    _blueprintProfitCache = window.safeParseJSON(localStorage.getItem(BLUEPRINT_PROFIT_CACHE_KEY), {});
  }
  return _blueprintProfitCache;
}

function saveBlueprintProfitCache() {
  try {
    localStorage.setItem(BLUEPRINT_PROFIT_CACHE_KEY, JSON.stringify(_blueprintProfitCache || {}));
  } catch (e) {
    console.warn('[BlueprintScan] Failed to persist profit cache (localStorage may be full):', e);
  }
}

// Renders a compact "Xd Yh ago" style relative time string for the scan-age tooltip.
function formatScanAge(scannedAt) {
  if (!scannedAt) return 'unknown';
  const seconds = Math.max(0, (Date.now() - scannedAt) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h ago`;
}

function getBlueprintProfitCacheKey(bp) {
  const isBPO = bp.quantity === -1;
  return isBPO
    ? `bpo|${bp.type_id}|${bp.material_efficiency}|${bp.time_efficiency}`
    : `bpc|${bp.type_id}|${bp.material_efficiency}|${bp.time_efficiency}|${bp.runs}`;
}

// Manufacturing profit for one blueprint at its REAL owned ME/TE - for a BPC, using its actual
// remaining runs; for a BPO (infinite runs), using 1 run as the representative unit, since ISK/hour
// and per-run profit are what's actually comparable across BPOs and BPCs alike.
async function computeBlueprintManufacturingProfit(bp) {
  if (!bp.productTypeId) return null;
  const runsToUse = (bp.quantity === -1) ? 1 : Math.max(1, bp.runs);

  window.customMEOverrides = window.customMEOverrides || {};
  window.customTEOverrides = window.customTEOverrides || {};
  window.customMEOverrides[bp.type_id] = bp.material_efficiency;
  window.customTEOverrides[bp.type_id] = bp.time_efficiency;
  window.recipeTreeRootProductTypeId = bp.productTypeId;

  const productName = window.TYPE_ID_TO_NAME[bp.productTypeId] || 'Item';
  let root;
  try {
    root = await window.buildRecursiveRecipeTree(bp.type_id, productName + ' Blueprint', runsToUse, 0, 6, new Set(), null);
  } finally {
    window.recipeTreeRootProductTypeId = null;
  }
  if (!root) return null;

  root.runsNeeded = runsToUse;
  root.qtyNeeded = runsToUse * (root.batchYield || 1);
  const facility = (window.getActiveStructureType ? window.getActiveStructureType().meBonus : 1.0) / 100;
  if (typeof window.scaleTreeQuantities === 'function') window.scaleTreeQuantities(root, facility);

  const allTypeIds = new Set();
  if (typeof window.collectAllTypeIds === 'function') window.collectAllTypeIds(root, allTypeIds);
  allTypeIds.add(bp.productTypeId);
  if (typeof window.fetchMarketPrices === 'function') await window.fetchMarketPrices(Array.from(allTypeIds));

  const materialCost = typeof window.calculateTreeNodeCost === 'function' ? window.calculateTreeNodeCost(root) : 0;
  const outputPrices = window.priceCache[bp.productTypeId] || { sell: 0 };
  const grossSell = outputPrices.sell * root.qtyNeeded;
  const profit = grossSell - materialCost;
  const buildSeconds = typeof window.calculateTotalBuildSeconds === 'function' ? window.calculateTotalBuildSeconds(root) : 0;
  const iskPerHour = buildSeconds > 0 ? profit / (buildSeconds / 3600) : null;

  return { profit, iskPerHour, runsUsed: runsToUse, qtyProduced: root.qtyNeeded, scannedAt: Date.now() };
}

async function scanSingleBlueprintProfit(typeId, me, te, runs, quantity, productTypeId, btnEl) {
  const bp = { type_id: typeId, material_efficiency: me, time_efficiency: te, runs: runs, quantity: quantity, productTypeId: productTypeId };
  const key = getBlueprintProfitCacheKey(bp);
  const cache = getBlueprintProfitCache();

  const origContent = btnEl ? btnEl.textContent : null;
  if (btnEl) { btnEl.disabled = true; btnEl.textContent = '⏳'; }
  try {
    cache[key] = await computeBlueprintManufacturingProfit(bp);
  } catch (e) {
    console.warn('[BlueprintScan] Failed for', typeId, e);
    cache[key] = null;
  }
  saveBlueprintProfitCache();
  if (btnEl) { btnEl.disabled = false; btnEl.textContent = origContent; }
  filterBlueprintBrowser();
}
window.scanSingleBlueprintProfit = scanSingleBlueprintProfit;

async function scanBlueprintProfits() {
  const btn = document.getElementById('blueprint-scan-btn');
  if (btn) btn.disabled = true;
  const cache = getBlueprintProfitCache();

  // Scan whatever's currently visible under the active filters, stacked first so identical
  // BPOs/BPCs aren't recomputed redundantly.
  const currentFiltered = getCurrentlyFilteredBlueprints();
  const stackEnabled = document.getElementById('blueprint-stack-toggle')?.checked ?? true;
  const toScan = stackEnabled ? stackBlueprints(currentFiltered) : currentFiltered;

  let done = 0;
  for (const bp of toScan) {
    const key = getBlueprintProfitCacheKey(bp);
    try {
      cache[key] = await computeBlueprintManufacturingProfit(bp);
    } catch (e) {
      console.warn('[BlueprintScan] Failed for', bp.type_id, e);
      cache[key] = null;
    }
    done++;
    if (btn) btn.textContent = `⏳ Scanning ${done}/${toScan.length}...`;
  }
  saveBlueprintProfitCache();

  if (btn) { btn.disabled = false; btn.textContent = '📊 Scan Profit'; }
  filterBlueprintBrowser();
}
window.scanBlueprintProfits = scanBlueprintProfits;

// --- What Can I Build Right Now ---
// Checks a blueprint's DIRECT materials (its own immediate ingredient list, ME-adjusted using the
// same formula the calculator uses elsewhere) against current stock - deliberately not a full
// recursive tree check, since "what can I build right now" means "could I click Build in-game with
// zero shopping trip", not "do I have raw materials for the entire multi-stage supply chain".
function computeBlueprintReadiness(bp) {
  const recipe = window.recipeMap && window.recipeMap[bp.type_id];
  if (!recipe) return null;
  const isReaction = !!(recipe.reactionMaterials && recipe.reactionMaterials.length > 0);
  const materials = isReaction ? recipe.reactionMaterials : recipe.mfgMaterials;
  if (!materials || materials.length === 0) return null;

  const me = bp.material_efficiency || 0;
  const structureType = window.getActiveStructureType ? window.getActiveStructureType() : { meBonus: 0 };
  const facilityBonus = (structureType.meBonus || 0) / 100;
  const rigMEBonus = window.getEffectiveRigBonusForTypeId ? window.getEffectiveRigBonusForTypeId(bp.productTypeId, 'ME') : 0;

  // Per-1-run quantity for each material, then how many WHOLE runs current stock covers for THAT
  // material alone - the true buildable run count is the minimum across all materials (the single
  // most limiting ingredient). This is a close approximation, not perfectly exact in every edge case
  // (the real per-N-runs formula rounds once for the whole batch, not per-run), but well within a
  // rounding error and far more useful than a binary yes/no.
  let maxRunsFromStock = Infinity;
  materials.forEach(m => {
    const baseQty = m.baseQty !== undefined ? m.baseQty : (m.qty || 1);
    const perRunQty = window.calculateInputQuantity
      ? window.calculateInputQuantity(baseQty, 1, me, facilityBonus, isReaction, rigMEBonus)
      : Math.ceil(baseQty);
    const owned = (window.userStockMap && window.userStockMap[m.typeId]) || 0;
    const runsThisAllows = perRunQty > 0 ? Math.floor(owned / perRunQty) : Infinity;
    if (runsThisAllows < maxRunsFromStock) maxRunsFromStock = runsThisAllows;
  });
  if (!isFinite(maxRunsFromStock)) maxRunsFromStock = 0; // no real materials data resolved

  const isBPO = bp.quantity === -1;
  const buildableRuns = isBPO ? maxRunsFromStock : Math.min(maxRunsFromStock, Math.max(1, bp.runs));

  return { buildableRuns, isReaction };
}

let _blueprintReadinessCache = {}; // same cache-key scheme as the profit scanner
let _readinessFilterActive = false;

async function scanBlueprintReadiness() {
  const btn = document.getElementById('blueprint-readiness-btn');
  if (!btn) return;

  // Already showing filtered results - this click means "go back to showing everything", using the
  // already-cached data, no need to rescan since stock hasn't been touched by this action.
  if (_readinessFilterActive) {
    _readinessFilterActive = false;
    btn.textContent = '🧰 What Can I Build Right Now?';
    btn.className = 'w-full px-2.5 py-1.5 bg-emerald-700 hover:bg-emerald-600 text-white font-bold text-[10px] transition';
    filterBlueprintBrowser();
    return;
  }

  btn.disabled = true;
  _blueprintReadinessCache = {}; // stock changes constantly, unlike ME/TE - always fresh, no persistence

  const currentFiltered = getCurrentlyFilteredBlueprints();
  const stackEnabled = document.getElementById('blueprint-stack-toggle')?.checked ?? true;
  const toCheck = stackEnabled ? stackBlueprints(currentFiltered) : currentFiltered;

  if (toCheck.length === 0) {
    btn.disabled = false;
    const originalText = btn.textContent;
    btn.textContent = '⚠ No blueprints match your current filters';
    setTimeout(() => { if (btn) btn.textContent = originalText; }, 3000);
    return;
  }

  toCheck.forEach(bp => {
    const key = getBlueprintProfitCacheKey(bp);
    _blueprintReadinessCache[key] = computeBlueprintReadiness(bp);
  });

  btn.disabled = false;
  const buildableCount = Object.values(_blueprintReadinessCache).filter(r => r && r.buildableRuns > 0).length;
  const checkedCount = Object.values(_blueprintReadinessCache).filter(r => r !== null).length;

  if (buildableCount === 0) {
    const originalText = btn.textContent;
    btn.textContent = checkedCount > 0 ? '⚠ Nothing buildable with current stock' : '⚠ No material data found';
    setTimeout(() => { if (btn) btn.textContent = originalText; }, 4000);
    return;
  }

  _readinessFilterActive = true;
  btn.textContent = `👁 Show All (${buildableCount} Buildable)`;
  btn.className = 'w-full px-2.5 py-1.5 bg-orange-700 hover:bg-orange-600 text-white font-bold text-[10px] transition';
  btn.title = `Showing only the ${buildableCount} of ${checkedCount} checked blueprints you can build right now with current stock - click to show everything again`;
  filterBlueprintBrowser();
}
window.scanBlueprintReadiness = scanBlueprintReadiness;

function stackBlueprints(list) {
  const groups = {};
  const order = [];
  list.forEach(bp => {
    const isBPO = bp.quantity === -1;
    const key = isBPO
      ? `bpo|${bp.type_id}|${bp.material_efficiency}|${bp.time_efficiency}|${bp.rootLocationId}|${bp.containerId || ''}`
      : `bpc|${bp.type_id}|${bp.material_efficiency}|${bp.time_efficiency}|${bp.runs}|${bp.rootLocationId}|${bp.containerId || ''}`;
    const countForThisEntry = (!isBPO && bp.quantity > 0) ? bp.quantity : 1;
    if (!groups[key]) {
      groups[key] = { ...bp, stackCount: 0 };
      order.push(key);
    }
    groups[key].stackCount += countForThisEntry;
  });
  return order.map(key => groups[key]);
}

function renderBlueprintBrowserList(list, stackEnabled, sortByProfit) {
  const listEl = document.getElementById('blueprint-browser-list');
  if (!listEl) return;
  if (list.length === 0) {
    listEl.innerHTML = `<div class="text-slate-500 italic p-4 text-center">No blueprints match your search/filter.</div>`;
    return;
  }

  let processedList = stackEnabled ? stackBlueprints(list) : list;

  // Attach scanned profit data (if any) from the cache, keyed by (type, ME, TE, runs-if-BPC).
  const profitCache = getBlueprintProfitCache();
  processedList = processedList.map(bp => ({
    ...bp,
    _profitResult: profitCache[getBlueprintProfitCacheKey(bp)],
    _readinessResult: _blueprintReadinessCache[getBlueprintProfitCacheKey(bp)]
  }));

  // "What Can I Build" filter mode: only show items with at least 1 buildable run, hiding anything
  // missing components entirely - the point of this mode is "show me what's actually buildable",
  // not a full inventory audit.
  if (_readinessFilterActive) {
    processedList = processedList.filter(bp => bp._readinessResult && bp._readinessResult.buildableRuns > 0);
    if (processedList.length === 0) {
      listEl.innerHTML = `<div class="text-slate-500 italic p-4 text-center">Nothing buildable with current stock under your active filters. Click "Show All" to see everything again.</div>`;
      return;
    }
  }

  const renderRow = (bp, showStationLabel) => {
    const name = window.TYPE_ID_TO_NAME[bp.type_id] || `Type ${bp.type_id}`;
    const isOriginal = bp.quantity === -1;
    const bpImageVariant = isOriginal ? 'bp' : 'bpc';
    const stackBadge = (bp.stackCount && bp.stackCount > 1)
      ? `<span class="text-[9px] font-bold text-orange-300 bg-orange-950/40 border border-orange-700/40 px-1.5 py-0.5 flex-shrink-0" title="${bp.stackCount} identical copies stacked together">x${bp.stackCount}</span>`
      : '';
    const containerBadge = bp.containerName
      ? `<span class="text-[9px] font-bold text-orange-400 bg-orange-950/40 border border-orange-700/40 px-1.5 py-0.5 flex-shrink-0" title="Inside container: ${window.esc(bp.containerName)}">📦 ${window.esc(bp.containerName)}</span>`
      : '';
    const stationBadge = showStationLabel
      ? `<span class="text-[9px] text-slate-500 flex-shrink-0" title="${window.esc(bp.stationName)}">📍 ${window.esc(bp.stationName)}</span>`
      : '';
    let profitBadge = '';
    if (bp._profitResult === null) {
      profitBadge = `<span class="text-xs text-red-400 font-bold flex-shrink-0 whitespace-nowrap" title="Profit scan failed for this item - see console">⚠ scan failed</span>`;
    } else if (bp._profitResult) {
      const p = bp._profitResult;
      const profitColor = p.profit >= 0 ? 'text-green-400' : 'text-red-400';
      profitBadge = `<span class="text-sm font-extrabold ${profitColor} flex-shrink-0 whitespace-nowrap" title="Manufacturing profit for ${p.runsUsed} run${p.runsUsed > 1 ? 's' : ''} (${p.qtyProduced} units)${p.iskPerHour !== null ? `, ${Math.round(p.iskPerHour).toLocaleString()} ISK/hour` : ''} - scanned ${formatScanAge(p.scannedAt)}">${Math.round(p.profit).toLocaleString()} ISK</span>`;
    }
    let readinessBadge = '';
    if (bp._readinessResult === null) {
      readinessBadge = `<span class="text-xs text-slate-500 flex-shrink-0" title="No direct material data found for this blueprint">—</span>`;
    } else if (bp._readinessResult) {
      const r = bp._readinessResult;
      readinessBadge = r.buildableRuns > 0
        ? `<span class="text-xs font-bold text-emerald-300 bg-emerald-950/50 border border-emerald-600/50 px-1.5 py-0.5 flex-shrink-0" title="Current stock covers ${r.buildableRuns.toLocaleString()} full run${r.buildableRuns > 1 ? 's' : ''}">✔ ${r.buildableRuns.toLocaleString()} run${r.buildableRuns > 1 ? 's' : ''}</span>`
        : `<span class="text-xs font-bold text-orange-300 bg-orange-950/50 border border-orange-600/50 px-1.5 py-0.5 flex-shrink-0" title="Not enough stock for even 1 run right now">⚠ 0 runs</span>`;
    }
    return `
      <div class="bg-[#202a2e] border border-[#3a4a4c] hover:border-orange-500 p-2.5 transition space-y-2">
        <div class="flex items-center gap-2 min-w-0">
          <img src="https://images.evetech.net/types/${bp.type_id}/${bpImageVariant}?size=32" class="w-8 h-8 border border-slate-700 bg-[#030405] flex-shrink-0" loading="lazy" title="${isOriginal ? 'Blueprint Original (BPO)' : 'Blueprint Copy (BPC)'}">
          <span class="font-bold text-slate-200 min-w-0">${window.esc(name)}</span>
          ${stackBadge}${readinessBadge}
        </div>
        <div class="flex items-center justify-between gap-3">
          <div class="text-[10px] text-slate-500 truncate flex items-center gap-1.5 min-w-0">
            <span class="flex-shrink-0">${bp.source}${!isOriginal ? ` • Runs: ${bp.runs}` : ''}</span>
            ${containerBadge}${stationBadge}
          </div>
          <div class="flex items-center gap-2 flex-shrink-0">
            ${profitBadge}
            <span class="text-[11px] font-bold text-orange-300 bg-orange-950/50 border border-orange-700/40 px-1.5 py-0.5 whitespace-nowrap">ME ${bp.material_efficiency}%</span>
            <span class="text-[11px] font-bold text-orange-300 bg-orange-950/50 border border-orange-700/40 px-1.5 py-0.5 whitespace-nowrap">TE ${bp.time_efficiency}%</span>
            <button onclick="scanSingleBlueprintProfit(${bp.type_id}, ${bp.material_efficiency}, ${bp.time_efficiency}, ${bp.runs}, ${bp.quantity}, ${bp.productTypeId || 'null'}, this)" class="px-2 py-1 bg-orange-700 hover:bg-orange-600 text-white font-bold text-[10px] transition" title="Scan just this blueprint's profit">📊</button>
            <button onclick="loadBlueprintIntoCalculator(${bp.type_id}, ${bp.material_efficiency}, ${bp.time_efficiency}, ${bp.runs})" class="px-2.5 py-1 bg-orange-700 hover:bg-orange-600 text-white font-bold text-[10px] transition">Load</button>
          </div>
        </div>
      </div>
    `;
  };

  if (sortByProfit) {
    // Flat list, ranked by profit regardless of station - grouping by location doesn't make sense
    // when the whole point is "which of my blueprints is most worth building right now."
    const sorted = [...processedList].sort((a, b) => {
      const av = a._profitResult ? a._profitResult.profit : -Infinity;
      const bv = b._profitResult ? b._profitResult.profit : -Infinity;
      return bv - av;
    });
    const unscannedCount = sorted.filter(bp => bp._profitResult === undefined).length;
    const hint = unscannedCount > 0
      ? `<div class="text-[10px] text-orange-400 italic mb-2 px-1">${unscannedCount} item${unscannedCount > 1 ? 's' : ''} not yet scanned - click "📊 Scan Profit" to include them in the ranking.</div>`
      : '';
    listEl.innerHTML = hint + `<div class="space-y-1.5">${sorted.map(bp => renderRow(bp, true)).join('')}</div>`;
    return;
  }

  // Group by station so blueprints are clearly parented to the station they're actually in, not
  // shown as a flat list.
  const byStation = {};
  processedList.forEach(bp => {
    const key = bp.stationName;
    if (!byStation[key]) byStation[key] = [];
    byStation[key].push(bp);
  });

  // ESI convention: quantity -1 = original (BPO), -2 = copy (BPC); positive quantity = a stack of BPCs.
  listEl.innerHTML = Object.keys(byStation).sort().map(stationName => {
    const rows = byStation[stationName].map(bp => renderRow(bp, false)).join('');
    return `
      <div class="mb-3">
        <div class="text-[10px] font-bold text-orange-300 uppercase tracking-wide mb-1.5 px-1">📍 ${window.esc(stationName)}</div>
        <div class="space-y-1.5">${rows}</div>
      </div>
    `;
  }).join('');
}

function loadBlueprintIntoCalculator(blueprintTypeId, me, te, runs) {
  window.customMEOverrides = window.customMEOverrides || {};
  window.customTEOverrides = window.customTEOverrides || {};
  window.customMEOverrides[blueprintTypeId] = me;
  window.customTEOverrides[blueprintTypeId] = te;

  // BPOs report runs as -1 (unlimited) - only a real BPC has a meaningful fixed run count to carry
  // over. Set before calling selectItem (with preserveView=true, which skips selectItem's own reset
  // of globalRuns) so the tree gets built at the BPC's actual max runs, not the default of 1.
  if (typeof runs === 'number' && runs > 0) {
    window.globalRuns = runs;
    const runsInput = document.getElementById('bp-runs');
    if (runsInput) runsInput.value = runs;
  }

  // The root node's identity (.typeId) ends up being whatever gets passed to selectItem/
  // buildRecursiveRecipeTree - it must be the BLUEPRINT's own type ID here, matching the key the
  // ME/TE overrides above were just set under. Passing the product ID instead (what this used to do)
  // meant the root node's typeId never matched the override key, so it silently fell back to 0/0.
  const productTypeId = (window.BLUEPRINT_TO_PRODUCT_MAP && window.BLUEPRINT_TO_PRODUCT_MAP[blueprintTypeId]) || blueprintTypeId;
  const productName = window.TYPE_ID_TO_NAME[productTypeId] || window.EVE_ITEMS[productTypeId] || `Item ${productTypeId}`;
  const blueprintName = window.EVE_ITEMS[blueprintTypeId] || `${productName} Blueprint`;

  closeBlueprintBrowser();
  if (typeof window.selectItem === 'function') {
    window.selectItem(blueprintTypeId, blueprintName, true);
  }
}
window.loadBlueprintIntoCalculator = loadBlueprintIntoCalculator;

// --- Production Presets (system + structure + rigs) ---
function getProductionPresets() {
  return window.safeParseJSON(localStorage.getItem('eve_production_presets'), {});
}

function renderProductionPresetDropdown() {
  const select = document.getElementById('production-preset-select');
  if (!select) return;
  const presets = getProductionPresets();
  const currentValue = select.value;
  select.innerHTML = `<option value="">— Load a saved production station —</option>` +
    Object.keys(presets).sort().map(name => `<option value="${window.esc(name)}">${window.esc(name)} (${window.esc(presets[name].systemName)}, ${window.esc(presets[name].facilityLabel)})</option>`).join('');
  if (presets[currentValue]) select.value = currentValue;
}
window.renderProductionPresetDropdown = renderProductionPresetDropdown;

function saveProductionPreset() {
  const name = prompt('Name this production station preset (e.g. "Home Sotiyo", "Staging Raitaru"):');
  if (!name || !name.trim()) return;

  const savedSystem = window.safeParseJSON(localStorage.getItem('eve_selected_system'), { id: null, name: 'JITA' });
  const facilityKey = localStorage.getItem('eve_active_facility_key') || 'sotiyo';
  const facilitySelect = document.getElementById('facility-select');
  const facilityLabel = facilitySelect ? (facilitySelect.options[facilitySelect.selectedIndex]?.text || facilityKey) : facilityKey;

  const presets = getProductionPresets();
  presets[name.trim()] = {
    systemId: savedSystem.id,
    systemName: savedSystem.name,
    facilityKey: facilityKey,
    facilityLabel: facilityLabel,
    rig1: localStorage.getItem('eve_rig_slot_1') || '',
    rig2: localStorage.getItem('eve_rig_slot_2') || '',
    rig3: localStorage.getItem('eve_rig_slot_3') || ''
  };
  localStorage.setItem('eve_production_presets', JSON.stringify(presets));
  renderProductionPresetDropdown();
  const select = document.getElementById('production-preset-select');
  if (select) select.value = name.trim();
}
window.saveProductionPreset = saveProductionPreset;

async function loadProductionPreset(name) {
  if (!name) return;
  const presets = getProductionPresets();
  const preset = presets[name];
  if (!preset) return;

  if (preset.systemId && typeof window.selectSolarSystem === 'function') {
    await window.selectSolarSystem(preset.systemId, preset.systemName);
  }

  const facilitySelect = document.getElementById('facility-select');
  if (facilitySelect) {
    facilitySelect.value = preset.facilityKey;
    onStructureTypeChange();
  }

  [1, 2, 3].forEach(slot => {
    const rigTypeId = preset[`rig${slot}`];
    localStorage.setItem(`eve_rig_slot_${slot}`, rigTypeId || '');
  });
  restoreRigSlotInputs();

  if (typeof window.recalculate === 'function') window.recalculate();
}
window.loadProductionPreset = loadProductionPreset;

function deleteProductionPreset() {
  const select = document.getElementById('production-preset-select');
  const name = select?.value;
  if (!name) {
    alert('Select a preset from the dropdown first, then click delete.');
    return;
  }
  if (!confirm(`Delete the "${name}" preset? This can't be undone.`)) return;
  const presets = getProductionPresets();
  delete presets[name];
  localStorage.setItem('eve_production_presets', JSON.stringify(presets));
  renderProductionPresetDropdown();
}
window.deleteProductionPreset = deleteProductionPreset;

function restoreRigSlotInputs() {
  for (let slot = 1; slot <= 3; slot++) {
    const rigTypeId = parseInt(localStorage.getItem(`eve_rig_slot_${slot}`));
    const inputEl = document.getElementById(`rig-slot-${slot}-input`);
    if (inputEl) inputEl.value = (rigTypeId && window.EVE_ITEMS && window.EVE_ITEMS[rigTypeId]) ? window.EVE_ITEMS[rigTypeId] : '';
  }
}

// --- Markets: home market search/selection ---
let _homeMarketSearchToken = 0;
async function searchHomeMarket(query) {
  const resultsEl = document.getElementById('home-market-results');
  if (!resultsEl) return;
  const token = ++_homeMarketSearchToken;
  const q = (query || '').trim();
  if (q.length < 3) {
    resultsEl.innerHTML = `<div class="p-1.5 text-slate-500">Type at least 3 characters...</div>`;
    resultsEl.classList.remove('hidden');
    return;
  }
  resultsEl.innerHTML = `<div class="p-1.5 text-slate-500">Searching...</div>`;
  resultsEl.classList.remove('hidden');
  const matches = await window.searchStationsByName(q);
  if (token !== _homeMarketSearchToken) return; // a newer search superseded this one
  if (matches === null) {
    resultsEl.innerHTML = `<div class="p-1.5 text-orange-400">⚠ Log in via EVE SSO first - station search requires an authenticated character (ESI removed the old public search endpoint).</div>`;
    return;
  }
  if (matches.length === 0) {
    resultsEl.innerHTML = `<div class="p-1.5 text-slate-500">No matching stations found.</div>`;
    return;
  }
  resultsEl.innerHTML = matches.map(m => `
    <div class="px-2 py-1.5 hover:bg-[#3a4a4c] cursor-pointer border-b border-[#3a4a4c]/20" onmousedown="selectHomeMarket(${m.stationId}, '${window.esc(m.stationName)}')">
      ${window.esc(m.stationName)}
    </div>
  `).join('');
}
window.searchHomeMarket = searchHomeMarket;

function selectHomeMarket(stationId, stationName) {
  localStorage.setItem('eve_home_station_id', String(stationId));
  localStorage.setItem('eve_home_station_name', stationName);
  const inputEl = document.getElementById('home-market-input');
  if (inputEl) inputEl.value = stationName;
  const resultsEl = document.getElementById('home-market-results');
  if (resultsEl) resultsEl.classList.add('hidden');
  // Prices already cached are all keyed by typeId only (no per-station distinction), so switching
  // home markets requires clearing them - otherwise stale Jita prices would linger under a new market.
  window.priceCache = {};
  if (window.currentProduct) {
    window.selectItem(window.currentProduct.id, window.currentProduct.name, true);
  }
}
window.selectHomeMarket = selectHomeMarket;

function restoreHomeMarketInput() {
  const inputEl = document.getElementById('home-market-input');
  const savedName = localStorage.getItem('eve_home_station_name');
  if (inputEl) inputEl.value = savedName || 'Jita IV - Moon 4 - Caldari Navy Assembly Plant';
}

// --- Markets: tracked markets management (for Compare Markets) ---
function renderTrackedMarketsList() {
  const listEl = document.getElementById('tracked-markets-list');
  if (!listEl) return;
  const markets = window.getTrackedMarkets ? window.getTrackedMarkets() : [];
  if (markets.length === 0) {
    listEl.innerHTML = `<div class="text-[10px] text-slate-500 italic">Loading default hubs...</div>`;
    return;
  }
  listEl.innerHTML = markets.map(m => `
    <div class="flex items-center justify-between bg-[#030405] border border-[#3a4a4c] px-2 py-1 text-[10px]">
      <span class="text-slate-300 truncate mono">${window.esc(m.stationName)}</span>
      <button onclick="removeTrackedMarketAndRefresh(${m.stationId})" class="text-red-400 hover:text-red-300 font-bold ml-1.5 flex-shrink-0" title="Stop tracking this market">✖</button>
    </div>
  `).join('');
}
window.renderTrackedMarketsList = renderTrackedMarketsList;

function removeTrackedMarketAndRefresh(stationId) {
  window.removeTrackedMarket(stationId);
  renderTrackedMarketsList();
}
window.removeTrackedMarketAndRefresh = removeTrackedMarketAndRefresh;

let _addMarketSearchToken = 0;
async function searchAddMarket(query) {
  const resultsEl = document.getElementById('add-market-results');
  if (!resultsEl) return;
  const token = ++_addMarketSearchToken;
  const q = (query || '').trim();
  if (q.length < 3) {
    resultsEl.innerHTML = `<div class="p-1.5 text-slate-500">Type at least 3 characters...</div>`;
    resultsEl.classList.remove('hidden');
    return;
  }
  resultsEl.innerHTML = `<div class="p-1.5 text-slate-500">Searching...</div>`;
  resultsEl.classList.remove('hidden');
  const matches = await window.searchStationsByName(q);
  if (token !== _addMarketSearchToken) return;
  if (matches === null) {
    resultsEl.innerHTML = `<div class="p-1.5 text-orange-400">⚠ Log in via EVE SSO first - station search requires an authenticated character (ESI removed the old public search endpoint).</div>`;
    return;
  }
  if (matches.length === 0) {
    resultsEl.innerHTML = `<div class="p-1.5 text-slate-500">No matching stations found.</div>`;
    return;
  }
  resultsEl.innerHTML = matches.map(m => `
    <div class="px-2 py-1.5 hover:bg-[#3a4a4c] cursor-pointer border-b border-[#3a4a4c]/20" onmousedown="confirmAddMarket(${m.stationId}, '${window.esc(m.stationName)}')">
      ${window.esc(m.stationName)}
    </div>
  `).join('');
}
window.searchAddMarket = searchAddMarket;

async function confirmAddMarket(stationId, stationName) {
  const resultsEl = document.getElementById('add-market-results');
  const inputEl = document.getElementById('add-market-input');
  if (resultsEl) { resultsEl.innerHTML = `<div class="p-1.5 text-slate-500">Adding...</div>`; }
  const regionInfo = await window.resolveStationRegion(stationId);
  window.addTrackedMarket({
    stationId: stationId,
    stationName: stationName,
    regionId: regionInfo ? regionInfo.regionId : null,
    systemId: regionInfo ? regionInfo.systemId : null
  });
  if (inputEl) inputEl.value = '';
  if (resultsEl) resultsEl.classList.add('hidden');
  renderTrackedMarketsList();
}
window.confirmAddMarket = confirmAddMarket;

// --- Compare Markets panel ---
async function openMarketComparison(e, typeId, itemName) {
  if (e) e.stopPropagation();
  const existing = document.getElementById('market-comparison-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'market-comparison-modal';
  modal.className = 'fixed inset-0 bg-black/80 flex items-center justify-center z-[999] p-4';
  modal.onclick = (evt) => { if (evt.target === modal) modal.remove(); };
  modal.innerHTML = `
    <div class="bg-[#0a0d0e] border border-orange-500/80 p-5 w-full max-w-2xl shadow-2xl text-xs mono">
      <div class="flex justify-between items-center border-b border-[#3a4a4c] pb-3 mb-3">
        <h3 class="text-base font-bold text-orange-300 rajdhani tracking-wider">💹 Compare Markets: ${window.esc(itemName)}</h3>
        <button onclick="document.getElementById('market-comparison-modal').remove()" class="text-slate-400 hover:text-white font-bold text-base">✖</button>
      </div>
      <div id="market-comparison-body" class="text-slate-400">Loading prices and trade volume across tracked markets...</div>
      <div class="text-[10px] text-slate-500 mt-3 leading-relaxed">
        Volume is the average units traded per day over the last 7 days (from EVE's market history) - a low price with very low volume may be hard to actually buy/sell at that price. Sorted by price does NOT mean sorted by "best" - liquidity matters too.
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const results = await window.fetchMarketComparison(typeId);
  const bodyEl = document.getElementById('market-comparison-body');
  if (!bodyEl) return; // modal was closed before the fetch finished

  if (results.length === 0) {
    bodyEl.innerHTML = `<div class="text-slate-500 italic">No tracked markets yet - add some in the sidebar's Markets section.</div>`;
    return;
  }

  const rows = results.map(r => `
    <tr class="border-b border-[#3a4a4c]/40">
      <td class="p-2 text-slate-200">${window.esc(r.stationName)}</td>
      <td class="p-2 text-right text-orange-300 font-bold">${r.sell > 0 ? Math.round(r.sell).toLocaleString() : '—'}</td>
      <td class="p-2 text-right text-orange-300 font-bold">${r.buy > 0 ? Math.round(r.buy).toLocaleString() : '—'}</td>
      <td class="p-2 text-right ${r.avgVolume === null ? 'text-slate-500' : (r.avgVolume < 10 ? 'text-red-400' : r.avgVolume < 100 ? 'text-orange-400' : 'text-green-400')} font-bold">
        ${r.avgVolume === null ? 'Unknown' : r.avgVolume.toLocaleString() + '/day'}
      </td>
    </tr>
  `).join('');

  bodyEl.innerHTML = `
    <table class="w-full text-left border-collapse">
      <thead>
        <tr class="text-slate-400 border-b border-[#3a4a4c] uppercase text-[10px] font-bold">
          <th class="p-2">Market</th>
          <th class="p-2 text-right">Lowest Sell</th>
          <th class="p-2 text-right">Highest Buy</th>
          <th class="p-2 text-right">Avg Daily Volume</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}
window.openMarketComparison = openMarketComparison;


function searchItems(query) {
  const q = query.toLowerCase().trim();
  if (!q) return [];
  const exact = [], starts = [], contains = [];
  for (const [k, v] of Object.entries(window.IDX || {})) {
    // Both checks matter here: the name pattern keeps results to "X Blueprint"/"X Reaction Formula"
    // style entries specifically (recipeMap is dual-indexed by product AND blueprint ID, so without
    // this a plain product name like "Rifter" would show up as a separate duplicate result alongside
    // "Rifter Blueprint" for the exact same recipe). The recipe-existence check catches phantom
    // entries that pass the name pattern but have no real data behind them (e.g. "Synth Drop Booster
    // Reaction" - a different item than the real "...Reaction Formula" that shares part of its name).
    const isBlueprint = k.includes('blueprint') || k.includes('formula') || k.includes('reaction');
    if (!isBlueprint) continue;
    if (!window.recipeMap || !window.recipeMap[v.id]) continue;

    if (k === q) exact.push(v);
    else if (k.startsWith(q)) starts.push(v);
    else if (k.includes(q)) contains.push(v);
  }
  return [...exact, ...starts, ...contains].slice(0, 15);
}

function searchSolarSystemsLocally(query) {
  const q = query.toLowerCase().trim();
  if (!q) return [];
  const exact = [], starts = [], contains = [];
  for (const [k, v] of Object.entries(window.SYSTEM_IDX || {})) {
    if (k === q) exact.push(v);
    else if (k.startsWith(q)) starts.push(v);
    else if (k.includes(q)) contains.push(v);
  }
  return [...exact, ...starts, ...contains].slice(0, 15);
}

async function fetchEsiSystemSearch(query) {
  const q = query.trim();
  if (q.length < 2) return [];
  try {
    const results = [];
    const idsRes = await fetch('https://esi.evetech.net/latest/universe/ids/?datasource=tranquility&language=en', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([q])
    });
    if (idsRes.ok) {
      const idsData = await idsRes.json();
      if (idsData && idsData.systems) {
        idsData.systems.forEach(sys => {
          const item = { id: sys.id, name: sys.name.toUpperCase() };
          window.SYSTEM_IDX[sys.name.toLowerCase()] = item;
          window.systemNameCache[sys.id] = item.name;
          results.push(item);
        });
      }
    }
    return results;
  } catch (err) { return []; }
}

async function fetchEsiSearchResults(query) {
  try {
    if (!query || query.trim().length < 2) return [];
    const data = window.esiCharacterSearch ? await window.esiCharacterSearch(query.trim(), 'inventory_type') : {};
    if (!data.inventory_type || !data.inventory_type.length) return [];
    const ids = data.inventory_type.slice(0, 10);
    const namesRes = await fetch('https://esi.evetech.net/latest/universe/names/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ids)
    });
    if (!namesRes.ok) return [];
    const namesData = await namesRes.json();
    const results = [];
    namesData.forEach(item => {
      const obj = { id: item.id, name: item.name };
      window.IDX[item.name.toLowerCase()] = obj;
      results.push(obj);
    });
    return results;
  } catch (err) { return []; }
}

async function resolveProductIdFromBlueprintNameAsync(blueprintName) {
  const local = window.resolveProductIdFromBlueprintName(blueprintName);
  if (local) return local;
  try {
    let pName = blueprintName.replace(/ Blueprint$/i, '').replace(/ Reaction Formula$/i, '').replace(/ Formula$/i, '').trim();
    const hits = await fetchEsiSearchResults(pName);
    if (hits && hits.length > 0) {
      const match = hits.find(h => h.name.toLowerCase() === pName.toLowerCase());
      if (match) return match.id;
    }
  } catch (e) {}
  return null;
}

const searchInput = document.getElementById('item-search');
const searchResults = document.getElementById('search-results');

if (searchInput) {
  searchInput.addEventListener('input', async () => {
    const q = searchInput.value.trim();
    if (!q) {
      if (searchResults) searchResults.classList.add('hidden');
      return;
    }
    let hits = searchItems(q);
    if (q.length >= 2) {
      const onlineHits = await fetchEsiSearchResults(q);
      const map = new Map();
      hits.forEach(h => map.set(h.id, h));
      onlineHits.forEach(h => map.set(h.id, h));
      hits = Array.from(map.values()).slice(0, 15);
    }
    const safeQ = window.esc(q);
    if (!hits.length) {
      if (searchResults) {
        searchResults.innerHTML = `<div class="p-3 text-slate-400 text-xs italic">No matching items found for "${safeQ}"</div>`;
        searchResults.classList.remove('hidden');
      }
      return;
    }
    if (searchResults) {
      searchResults.innerHTML = hits.map(item => {
        const lowerName = item.name.toLowerCase();
        const isBp = lowerName.includes('blueprint') || lowerName.includes('formula') || lowerName.includes('reaction');
        // Blueprints aren't valid /icon items - show the manufactured product's icon instead.
        const displayIconId = isBp
          ? (window.resolveProductIdFromBlueprintName(item.name) || window.BLUEPRINT_TO_PRODUCT_MAP[item.id] || item.id)
          : item.id;
        return `
        <div class="px-3 py-2 hover:bg-[#3a4a4c] cursor-pointer flex items-center space-x-3 text-xs border-b border-[#3a4a4c]/40"
             onclick="selectItem(${item.id}, '${window.esc(item.name)}')">
          <img src="https://images.evetech.net/types/${displayIconId}/icon?size=32" class="w-6 h-6 " loading="lazy" onerror="this.onerror=null; this.src='https://images.evetech.net/types/${displayIconId}/render?size=32';">
          <span class="font-semibold text-slate-200">${window.esc(item.name)}</span>
        </div>
      `;
      }).join('');
      searchResults.classList.remove('hidden');
    }
  });
}

document.addEventListener('click', (e) => {
  if (searchInput && searchResults && !searchInput.contains(e.target) && !searchResults.contains(e.target)) {
    searchResults.classList.add('hidden');
  }
});

const systemSearchInput = document.getElementById('system-search');
const systemSearchResults = document.getElementById('system-results');

if (systemSearchInput) {
  systemSearchInput.addEventListener('input', async () => {
    const q = systemSearchInput.value.trim();
    if (!q) {
      if (systemSearchResults) systemSearchResults.classList.add('hidden');
      return;
    }
    let hits = searchSolarSystemsLocally(q);
    if (q.length >= 2) {
      const esiHits = await fetchEsiSystemSearch(q);
      const map = new Map();
      hits.forEach(h => map.set(h.id, h));
      esiHits.forEach(h => map.set(h.id, h));
      hits = Array.from(map.values()).slice(0, 10);
    }
    if (!hits.length) {
      if (systemSearchResults) {
        systemSearchResults.innerHTML = `<div class="p-2 text-slate-400 text-xs italic">No matching system found</div>`;
        systemSearchResults.classList.remove('hidden');
      }
      return;
    }
    if (systemSearchResults) {
      systemSearchResults.innerHTML = hits.map(sys => `
        <div class="px-3 py-1.5 hover:bg-[#3a4a4c] cursor-pointer text-xs font-bold text-orange-300 border-b border-[#3a4a4c]/40 mono"
             onclick="window.selectSolarSystem(${sys.id}, '${window.esc(sys.name)}')">
          ${window.esc(sys.name)}
        </div>
      `).join('');
      systemSearchResults.classList.remove('hidden');
    }
  });

  systemSearchInput.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      const q = systemSearchInput.value.trim();
      if (q) { await window.resolveSystemSCI(q); }
    }
  });
}

document.addEventListener('click', (e) => {
  if (systemSearchInput && systemSearchResults && !systemSearchInput.contains(e.target) && !systemSearchResults.contains(e.target)) {
    systemSearchResults.classList.add('hidden');
  }
});

async function selectItem(typeId, name, preserveView = false) {
  if (searchInput) searchInput.value = name;
  if (searchResults) searchResults.classList.add('hidden');
  window.currentProduct = { id: typeId, name };
  if (!preserveView) {
    window.selectedInstanceId = null;
    window.isolatedInstanceId = null;
    window.rootSellStrategy = 'market-sell';
    window.rootCustomPrice = 0;
    window.globalRuns = 1;
    const globalInput = document.getElementById('bp-runs');
    if (globalInput) globalInput.value = 1;

    window.buildSelfOverrides = {};
    window.customBuyModes = {};
    window.customMEOverrides = {};
    window.customTEOverrides = {};
  }

  const lowerName = name.toLowerCase();
  window.recipeTreeRootProductTypeId = null;
  if (lowerName.includes('blueprint') || lowerName.includes('formula') || lowerName.includes('reaction')) {
    const resolvedProductTypeId = await window.resolveProductIdFromBlueprintNameAsync(name);
    if (resolvedProductTypeId) {
      window.recipeTreeRootProductTypeId = resolvedProductTypeId;
    }
  }

  const maxDepth = 10;
  window.recipeTreeRoot = await window.buildRecursiveRecipeTree(typeId, name, 1, 0, maxDepth, new Set(), null);
  recalculate();
  if (!preserveView) { resetPanZoom(); } else { setTimeout(drawConnectingLines, 50); }

  const statusText = document.getElementById('status-text');
  const statusDot = document.getElementById('status-dot');
  if (statusText) statusText.textContent = 'TREE READY | UPDATING MARKET PRICES...';
  if (statusDot) statusDot.className = 'w-2.5 h-2.5 rounded-full bg-orange-400';

  const allTypeIds = new Set();
  window.collectAllTypeIds(window.recipeTreeRoot, allTypeIds);
  window.fetchMarketPrices(Array.from(allTypeIds)).finally(() => {
    if (statusDot) statusDot.className = 'w-2.5 h-2.5 rounded-full bg-green-400';
    if (statusText) statusText.textContent = 'RECIPES & PRICES LOADED';
    recalculate();
  });
}

function collectGlobalDemand(node, demandMap = {}) {
  if (!node) return demandMap;
  const typeId = node.displayTypeId || node.typeId;
  if (!demandMap[typeId]) {
    demandMap[typeId] = { typeId, name: node.name, totalQtyNeeded: 0, isBuildingSelf: node.isBuildingSelf, batchYield: node.batchYield || 1, productTypeId: node.productTypeId, nodes: [] };
  }
  demandMap[typeId].totalQtyNeeded += node.qtyNeeded;
  demandMap[typeId].nodes.push(node);
  if (node.isBuildingSelf && node.children) {
    node.children.forEach(child => { if (child) collectGlobalDemand(child, demandMap); });
  }
  return demandMap;
}

function saveActiveState() {
  try {
    localStorage.setItem('eve_active_product', JSON.stringify(window.currentProduct));
    localStorage.setItem('eve_build_self_overrides', JSON.stringify(window.buildSelfOverrides));
    localStorage.setItem('eve_custom_buy_modes', JSON.stringify(window.customBuyModes));
    localStorage.setItem('eve_custom_me_overrides', JSON.stringify(window.customMEOverrides));
    localStorage.setItem('eve_custom_te_overrides', JSON.stringify(window.customTEOverrides));
    localStorage.setItem('eve_global_runs', window.globalRuns);
    localStorage.setItem('eve_root_sell_strategy', window.rootSellStrategy);
    localStorage.setItem('eve_root_custom_price', window.rootCustomPrice);
  } catch (e) {}
}

function loadSavedState() {
  try {
    window.buildSelfOverrides = window.safeParseJSON(localStorage.getItem('eve_build_self_overrides'), {});
    window.customBuyModes = window.safeParseJSON(localStorage.getItem('eve_custom_buy_modes'), {});
    window.customMEOverrides = window.safeParseJSON(localStorage.getItem('eve_custom_me_overrides'), {});
    window.customTEOverrides = window.safeParseJSON(localStorage.getItem('eve_custom_te_overrides'), {});
    window.globalRuns = parseInt(localStorage.getItem('eve_global_runs')) || 1;
    window.rootSellStrategy = localStorage.getItem('eve_root_sell_strategy') || 'market-sell';
    window.rootCustomPrice = parseFloat(localStorage.getItem('eve_root_custom_price')) || 0;

    const savedProduct = window.safeParseJSON(localStorage.getItem('eve_active_product'), null);
    if (savedProduct && savedProduct.id && savedProduct.name) {
      selectItem(savedProduct.id, savedProduct.name, true);
    } else {
      selectItem(48519, 'Drekavac Blueprint');
    }
  } catch (e) { selectItem(48519, 'Drekavac Blueprint'); }
}

function recalculate() {
  if (!window.recipeTreeRoot) return;
  const activeEl = document.activeElement;
  const activeId = activeEl ? activeEl.id : null;

  syncTreeOverrides(window.recipeTreeRoot);
  const inputVal = Math.max(1, window.globalRuns || 1);

  const salesTax = (parseFloat(document.getElementById('sales-tax')?.value) || 3.6) / 100;
  const brokerFee = (parseFloat(document.getElementById('broker-fee')?.value) || 1.0) / 100;
  const facilityTax = (parseFloat(document.getElementById('facility-tax')?.value) || 1.0) / 100;
  const sccSurcharge = (parseFloat(document.getElementById('scc-surcharge')?.value) || 4.0) / 100;
  const structureType = window.getActiveStructureType ? window.getActiveStructureType() : { costBonus: 5.0, meBonus: 1.0 };
  const structureRoleBonus = structureType.costBonus / 100;

  const contractTaxPercent = parseFloat(document.getElementById('contract-tax')?.value) || 0.5;
  const contractBrokerPercent = parseFloat(document.getElementById('contract-broker')?.value) || 0.5;
  const contractTaxRate = contractTaxPercent / 100;
  const contractBrokerRate = contractBrokerPercent / 100;

  const facility = structureType.meBonus / 100;
  const priceStrategy = document.getElementById('input-price-mode')?.value || 'sell';

  const rootYield = window.recipeTreeRoot.batchYield || 1;
  const rootRunsNeeded = inputVal;
  const totalRootOutputQty = rootYield * inputVal;

  window.recipeTreeRoot.qtyNeeded = totalRootOutputQty;
  window.recipeTreeRoot.runsNeeded = rootRunsNeeded;

  window.scaleTreeQuantities(window.recipeTreeRoot, facility);
  window.calculateNodeEIV(window.recipeTreeRoot);

  const globalDemand = collectGlobalDemand(window.recipeTreeRoot);
  let totalSurplusMaterialValue = 0;

  Object.values(globalDemand).forEach(item => {
    // CORRECTION: Exclude the root node's typeId (both blueprint and product IDs) from surplus credit! [1]
    const rootProductTypeId = window.recipeTreeRoot.productTypeId || window.recipeTreeRoot.typeId;
    if (item.typeId === window.recipeTreeRoot.typeId || item.typeId === rootProductTypeId || item.productTypeId === rootProductTypeId) {
      return;
    }

    if (item.isBuildingSelf && item.batchYield > 1) {
      const runs = Math.ceil(item.totalQtyNeeded / item.batchYield);
      const totalProduced = runs * item.batchYield;
      const netSurplusQty = totalProduced - item.totalQtyNeeded;
      if (netSurplusQty > 0) {
        const productTypeId = item.productTypeId || item.typeId;
        const prices = window.priceCache[productTypeId] || { sell: 0, buy: 0 };
        const unitPrice = prices.sell || prices.buy || window.getEIV(item.typeId) || 0;
        totalSurplusMaterialValue += netSurplusQty * unitPrice;
      }
    }
  });

  let rawMaterialCost = 0;
  if (window.recipeTreeRoot.isBuildingSelf && window.recipeTreeRoot.children && window.recipeTreeRoot.children.length > 0) {
    window.recipeTreeRoot.children.forEach(child => { rawMaterialCost += window.calculateTreeNodeCost(child); });
  } else {
    const rootStrategy = window.getNodePriceStrategy(window.recipeTreeRoot);
    const productTypeId = window.recipeTreeRoot.productTypeId || window.recipeTreeRoot.typeId;
    const prices = window.priceCache[productTypeId] || { sell: 0, buy: 0 };
    let unitPrice = rootStrategy === 'sell' ? prices.sell : prices.buy;
    if (rootStrategy === 'buy') { unitPrice = unitPrice * (1 + brokerFee); }
    const deductModeInput = document.getElementById('deduct-stock-mode');
    const isStockDeductEnabled = deductModeInput ? deductModeInput.value === 'true' : true;
    const stockQty = isStockDeductEnabled ? (window.userStockMap[productTypeId] || window.userStockMap[window.recipeTreeRoot.typeId] || 0) : 0;
    const netRootQty = Math.max(0, totalRootOutputQty - stockQty);
    rawMaterialCost = unitPrice * netRootQty;
  }

  let effectiveMaterialCost = rawMaterialCost;
  let totalJobFees = window.calculateNodeJobFee(window.recipeTreeRoot, facilityTax, sccSurcharge, structureRoleBonus);
  let totalProductionCost = effectiveMaterialCost + totalJobFees;

  const rootProductTypeId = window.recipeTreeRoot.productTypeId || window.recipeTreeRoot.typeId;
  const outputPrices = window.priceCache[rootProductTypeId] || { sell: 0, buy: 0 };
  const selectedStrategy = window.rootSellStrategy || 'market-sell';
  let unitSellPrice = 0;
  let isContractMode = selectedStrategy === 'custom-contract';

  if (selectedStrategy === 'market-sell') { unitSellPrice = outputPrices.sell; }
  else if (selectedStrategy === 'custom-market-sell' || selectedStrategy === 'custom-contract') { unitSellPrice = window.rootCustomPrice || 0; }

  const grossSellRevenue = unitSellPrice * totalRootOutputQty;
  const grossBuyRevenue = outputPrices.buy * totalRootOutputQty;

  window.recipeTreeRoot.calculatedCost = totalProductionCost;
  window.recipeTreeRoot.outputMarketValue = grossSellRevenue;

  let netSellRevenue = grossSellRevenue;
  let netBuyRevenue = grossBuyRevenue * (1 - salesTax);

  if (isContractMode) {
    const cSalesTax = grossSellRevenue * contractTaxRate;
    const cBrokerFee = (grossSellRevenue * contractBrokerRate) + 10000;
    netSellRevenue = grossSellRevenue - cSalesTax - cBrokerFee;
    window.recipeTreeRoot.contractSalesTax = cSalesTax;
    window.recipeTreeRoot.contractBrokerFee = cBrokerFee;
  } else {
    netSellRevenue = grossSellRevenue * (1 - salesTax - brokerFee);
  }

  const profitSell = netSellRevenue + totalSurplusMaterialValue - totalProductionCost;
  const profitBuy = netBuyRevenue + totalSurplusMaterialValue - totalProductionCost;
  
  window.recipeTreeRoot.netProfitSell = profitSell;
  window.recipeTreeRoot.netProfitBuy = profitBuy;

  const roiSell = totalProductionCost > 0 ? ((profitSell / totalProductionCost) * 100).toFixed(1) : 0;
  const roiBuy = totalProductionCost > 0 ? ((profitBuy / totalProductionCost) * 100).toFixed(1) : 0;

  const summaryCostEl = document.getElementById('summary-build-cost');
  if (summaryCostEl) summaryCostEl.textContent = Math.round(totalProductionCost).toLocaleString() + ' ISK';
  const summarySubtextEl = document.getElementById('summary-runs-subtext');
  if (summarySubtextEl) summarySubtextEl.textContent = `Mat: ${Math.round(effectiveMaterialCost).toLocaleString()} + Fee: ${Math.round(totalJobFees).toLocaleString()}`;
  const summarySurplusEl = document.getElementById('summary-surplus-credit');
  if (summarySurplusEl) summarySurplusEl.textContent = Math.round(totalSurplusMaterialValue).toLocaleString() + ' ISK';
  const summaryOutSellEl = document.getElementById('summary-output-sell');
  if (summaryOutSellEl) summaryOutSellEl.textContent = Math.round(netSellRevenue).toLocaleString() + ' ISK';
  const summaryOutBuyEl = document.getElementById('summary-output-buy');
  if (summaryOutBuyEl) {
    if (isContractMode) { summaryOutBuyEl.textContent = 'Net Contract: ' + Math.round(netSellRevenue).toLocaleString() + ' ISK'; }
    else { summaryOutBuyEl.textContent = `Instant Buy: ${Math.round(netBuyRevenue).toLocaleString()} ISK`; }
  }

  const pSellEl = document.getElementById('summary-profit-sell');
  if (pSellEl) {
    pSellEl.textContent = Math.round(profitSell).toLocaleString() + ' ISK';
    pSellEl.className = `text-sm font-bold mt-0.5 mono ${profitSell >= 0 ? 'text-green-400' : 'text-red-500'}`;
  }
  const pSellLabelEl = document.getElementById('summary-profit-sell-label');
  if (pSellLabelEl) { pSellLabelEl.textContent = isContractMode ? 'Net Profit (Contract Output)' : 'Net Profit (Sell Output)'; }

  const roiSellEl = document.getElementById('summary-roi-sell');
  if (roiSellEl) {
    const finalRoi = totalProductionCost > 0 ? ((profitSell / totalProductionCost) * 100).toFixed(1) : 0;
    let label = (window.rootSellStrategy === 'custom-contract') ? 'Contract ROI' : 'Sell ROI';
    roiSellEl.textContent = `${label}: ${finalRoi}%`;
  }

  const pBuyEl = document.getElementById('summary-profit-buy');
  if (pBuyEl) {
    pBuyEl.textContent = Math.round(profitBuy).toLocaleString() + ' ISK';
    pBuyEl.className = `text-sm font-bold mt-0.5 mono ${profitBuy >= 0 ? 'text-green-400' : 'text-red-500'}`;
  }
  const roiBuyEl = document.getElementById('summary-roi-buy');
  if (roiBuyEl) roiBuyEl.textContent = `ROI: ${roiBuy}%`;

  // Total estimated build time across every job actually being manufactured in the tree - read
  // directly by the root card to show its own "Est. Build Time" and "Est. ISK/Hour" lines.
  const totalBuildSeconds = calculateTotalBuildSeconds(window.recipeTreeRoot);
  window.recipeTreeRoot.totalBuildSeconds = totalBuildSeconds;

  if (window.isolatedInstanceId) {
    const isoNode = findNodeByInstanceId(window.recipeTreeRoot, window.isolatedInstanceId);
    if (isoNode) { renderIsolatedDiagram(); } else { window.isolatedInstanceId = null; renderTreeDiagram(window.recipeTreeRoot, priceStrategy, profitSell, roiSell); }
  } else { renderTreeDiagram(window.recipeTreeRoot, priceStrategy, profitSell, roiSell); }
  
  renderBillOfMaterials(window.recipeTreeRoot, brokerFee);
  setTimeout(drawConnectingLines, 50);

  saveActiveState();
  try {
    localStorage.setItem('eve_raw_assets', JSON.stringify(window.rawAssetItems || []));
    localStorage.setItem('eve_resolved_location_names', JSON.stringify(window.resolvedLocationNames || {}));
    localStorage.setItem('eve_corp_division_names', JSON.stringify(window.corpDivisionNames || {}));
    localStorage.setItem('eve_user_stock_map', JSON.stringify(window.userStockMap || {}));
  } catch (err) {}

  if (activeId) {
    const newActiveEl = document.getElementById(activeId);
    if (newActiveEl) {
      newActiveEl.focus();
      const val = newActiveEl.value;
      newActiveEl.value = '';
      newActiveEl.value = val;
    }
  }
}

function renderTreeDiagram(rootNode, priceStrategy, profitSell, roiSell) {
  const container = document.getElementById('tree-container');
  if (!container) return;
  container.innerHTML = '';
  if (!rootNode) return;
  const levels = [];
  function traverse(node) {
    if (!node) return;
    if (!levels[node.depth]) levels[node.depth] = [];
    levels[node.depth].push(node);
    // A collapsed node still renders itself, but its children (and everything beneath them) are
    // hidden from every depth column - this is what actually shrinks a runaway-tall build.
    if (window.collapsedInstanceIds.has(node.instanceId)) return;
    if (node.children) { node.children.forEach(child => { if (child) traverse(child); }); }
  }
  traverse(rootNode);
  levels.reverse().forEach((nodesAtDepth) => {
    const colDiv = document.createElement('div');
    colDiv.className = 'flex flex-col space-y-6 justify-center';
    nodesAtDepth.forEach(node => { if (node) { colDiv.appendChild(createNodeCard(node)); } });
    container.appendChild(colDiv);
  });
  applyNodeHighlightClasses();
}

// Counts every descendant currently hidden beneath a collapsed node, for the "N hidden" badge.
function countDescendants(node) {
  if (!node || !node.children) return 0;
  let count = 0;
  node.children.forEach(child => {
    if (child) count += 1 + countDescendants(child);
  });
  return count;
}

function toggleNodeCollapse(e, instanceId) {
  if (e) e.stopPropagation();
  if (window.collapsedInstanceIds.has(instanceId)) {
    window.collapsedInstanceIds.delete(instanceId);
  } else {
    window.collapsedInstanceIds.add(instanceId);
  }
  if (typeof window.recalculate === 'function') window.recalculate();
}
window.toggleNodeCollapse = toggleNodeCollapse;

// Collapses every node in the current tree that actually has children to hide.
function collapseAllNodes() {
  if (!window.recipeTreeRoot) return;
  function walk(node) {
    if (!node) return;
    if (node.children && node.children.length > 0) {
      window.collapsedInstanceIds.add(node.instanceId);
      node.children.forEach(walk);
    }
  }
  walk(window.recipeTreeRoot);
  if (typeof window.recalculate === 'function') window.recalculate();
}
window.collapseAllNodes = collapseAllNodes;

function expandAllNodes() {
  window.collapsedInstanceIds.clear();
  if (typeof window.recalculate === 'function') window.recalculate();
}
window.expandAllNodes = expandAllNodes;

function createNodeCard(node) {
  const productTypeId = node.productTypeId || node.typeId;
  const prices = window.priceCache[productTypeId] || { sell: 0, buy: 0 };
  const isRoot = node.depth === 0;
  const isIsolated = node.instanceId === window.isolatedInstanceId;
  const deductModeInput = document.getElementById('deduct-stock-mode');
  const isStockDeductEnabled = deductModeInput ? deductModeInput.value === 'true' : true;
  const stockQty = isStockDeductEnabled ? (window.userStockMap[productTypeId] || window.userStockMap[node.typeId] || 0) : 0;

  const card = document.createElement('div');
  card.id = `node-card-${node.instanceId}`;
  card.setAttribute('data-instance-id', node.instanceId);
  card.onclick = (e) => onNodeClick(e, node.instanceId);

  let cardStyle = 'w-64';
  let borderAccent = '';
  if (isRoot) { cardStyle = 'w-80'; }
  else if (!node.isBuildingSelf) { cardStyle = 'w-64'; borderAccent = 'border-left-color:#6b9ee8;'; }
  else if (node.isReaction) { cardStyle = 'w-64'; borderAccent = 'border-left-color:#b98ee8;'; }
  else if (node.batchYield > 1) { cardStyle = 'w-64'; borderAccent = 'border-left-color:#e8c96a;'; }

  const totalProduced = node.runsNeeded * node.batchYield;
  const surplus = totalProduced - node.qtyNeeded;

  // CORRECTION: Strict blueprint path safety check inside the card loop prevents any imageservers 400s
  const cardNameLower = (window.TYPE_ID_TO_NAME[productTypeId] || node.name || '').toLowerCase();
  const isBpOriginal = cardNameLower.includes('blueprint') || cardNameLower.includes('formula') || cardNameLower.includes('reaction');
  const iconUrl = isBpOriginal
    ? `https://images.evetech.net/types/${productTypeId}/bp?size=128`
    : `https://images.evetech.net/types/${productTypeId}/icon?size=128`;

  const unitEIV = node.unitEIV || 0;
  const totalEIV = node.jobEIV || (unitEIV * node.qtyNeeded);
  const formattedUnitEIV = Math.round(unitEIV).toLocaleString() + ' ISK';
  const formattedTotalEIV = Math.round(totalEIV).toLocaleString() + ' ISK';

  const savingsPct = prices.sell > 0 && prices.buy > 0 && prices.sell > prices.buy ? (((prices.sell - prices.buy) / prices.sell) * 100).toFixed(1) : null;
  const currentBuyStrategy = window.getNodePriceStrategy(node);

  let sellStrategyUI = '';
  if (isRoot) {
    const curStrategy = window.rootSellStrategy || 'market-sell';
    const curCustomPrice = window.rootCustomPrice || '';
    const isCustomPriceNeeded = curStrategy === 'custom-market-sell' || curStrategy === 'custom-contract';

    sellStrategyUI = `
      <div class="mb-2 p-1.5 bg-black/30 border border-[var(--accent)]/30 space-y-1.5" onclick="event.stopPropagation()">
        <div class="flex justify-between items-center text-xs mono">
          <span class="text-orange-300 font-bold">Sell Channel:</span>
          <select id="card-sell-strategy" onchange="syncSellStrategy(event)" class="bg-black/40 text-white p-0.5 border border-[#3a4a4c] text-xs outline-none">
            <option value="market-sell" ${curStrategy === 'market-sell' ? 'selected' : ''}>Auto</option>
            <option value="custom-market-sell" ${curStrategy === 'custom-market-sell' ? 'selected' : ''}>Custom Market Sell</option>
            <option value="custom-contract" ${curStrategy === 'custom-contract' ? 'selected' : ''}>Custom Contract</option>
          </select>
        </div>
        ${isCustomPriceNeeded ? `
          <div class="flex flex-col text-xs mono">
            <div class="flex justify-between items-center">
              <span class="text-orange-300 font-bold">Custom Sell Price:</span>
              <div class="flex items-center space-x-1">
                <input type="number" id="card-custom-price" value="${curCustomPrice}" placeholder="Unit Price" onchange="syncCustomPrice(event)" class="w-24 bg-black/40 border border-[#3a4a4c] text-center text-green-400 font-bold p-0.5 outline-none text-xs">
                <span class="text-slate-500 text-xs">ISK</span>
              </div>
            </div>
            <div class="text-xs text-green-400 text-right font-bold mt-1">${Math.round(window.rootCustomPrice || 0).toLocaleString()} ISK</div>
          </div>
        ` : ''}
        <button onclick="addCurrentJobToLedger(event)" class="btn-glass w-full mt-2 py-1.5 text-sm flex items-center justify-center gap-1">➕ ADD TO JOB QUEUE</button>
      </div>
    `;
  }

  let buildTimeUI = '';
  if (node.isBuildingSelf && node.isManufacturable) {
    const baseTime = extractBuildTime(node.recipe);
    const skills = window.safeParseJSON(localStorage.getItem('eve_char_skills'), { industry: 5, advIndustry: 5 });
    const structureType = window.getActiveStructureType ? window.getActiveStructureType() : { shortLabel: 'Sotiyo', teBonus: 30.0 };
    const structureName = structureType.shortLabel;
    const structureTEBonus = `${structureType.teBonus}%`;
    const rigTEBonus = window.getEffectiveRigBonusForTypeId ? window.getEffectiveRigBonusForTypeId(node.productTypeId, 'TE') : 0;

    if (baseTime > 0) {
      const totalSeconds = calculateAdjustedJobSeconds(baseTime, node.customTE, node.runsNeeded, node.isReaction, node.productTypeId, node.recipe.requiredSkills);
      const hoverTitle = `Skill Reductions Applied:\n• Industry Level: ${skills.industry}/5\n• Advanced Industry Level: ${skills.advIndustry}/5\n• Structure Bonus: ${structureName} (${structureTEBonus} TE reduction)${rigTEBonus > 0 ? `\n• Rig Bonus: -${rigTEBonus.toFixed(2)}% TE` : ''}\n• Base SDE Time: ${window.formatDuration(baseTime)}`;

      buildTimeUI = `
        <div class="flex justify-between text-xs text-slate-400 mono cursor-help" title="${window.esc(hoverTitle)}">
          <span>Est. Build Time:</span>
          <span class="text-slate-300 font-semibold">${window.formatDuration(totalSeconds)}</span>
        </div>
      `;
    } else {
      buildTimeUI = `
        <div class="flex justify-between text-xs text-slate-400 mono cursor-help" title="No manufacturing time data found for this blueprint in the local database or Fuzzwork lookup.">
          <span>Est. Build Time:</span>
          <span class="text-slate-500 italic">No Time Data</span>
        </div>
      `;
    }
  }

  card.className = `diagram-node glass-card p-3 shadow-lg transition-all relative ${cardStyle}`;
  if (borderAccent) card.setAttribute('style', borderAccent);
  card.innerHTML = `
    <div class="flex items-center space-x-3 border-b border-[#3a3025] pb-2.5 mb-2.5">
      <img src="${iconUrl}" class="w-10 h-10 rounded border border-slate-700 bg-black/40 flex-shrink-0" onerror="this.onerror=null; this.src='https://images.evetech.net/types/${productTypeId}/icon?size=64';">
      <div class="min-w-0 flex-1">
        <div class="font-bold text-sm text-white truncate flex items-center justify-between">
          <span class="truncate cursor-pointer hover:text-orange-300 hover:underline transition" onclick="copyMaterialNameToClipboard(event, this, '${window.esc(node.productName || node.name.replace(/ Blueprint$/i, '').replace(/ Reaction Formula$/i, '').replace(/ Formula$/i, '').trim()).replace(/'/g, "\\'")}')" title="Click to copy this item's exact name to your clipboard, ready to paste into EVE's search/market">${node.productName || node.name.replace(/ Blueprint$/i, '').replace(/ Reaction Formula$/i, '').replace(/ Formula$/i, '').trim()}</span>
          <div class="flex items-center space-x-1 flex-shrink-0 ml-1">
            ${isRoot ? `
              <div class="relative group inline-block" onclick="event.stopPropagation()">
                <span class="toggle-btn cursor-help" title="Unit EIV: ${formattedUnitEIV} | Total Job EIV: ${formattedTotalEIV}">
                  <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="8.01"/><line x1="12" y1="11" x2="12" y2="16"/></svg>
                  EIV
                </span>
                <div class="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block bg-black/90 border border-[var(--accent)] text-white text-xs p-2 rounded shadow-2xl z-[999] whitespace-nowrap mono pointer-events-none">
                  <div class="text-orange-300 font-bold border-b border-[#3a3025] pb-1 mb-1">Estimated Item Value (EIV)</div>
                  <div class="flex justify-between space-x-4 text-slate-300"><span>Unit EIV:</span> <span class="text-orange-300 font-bold">${formattedUnitEIV}</span></div>
                  <div class="flex justify-between space-x-4 text-slate-300"><span>Total Job EIV:</span> <span class="text-orange-400 font-bold">${formattedTotalEIV}</span></div>
                </div>
              </div>
            ` : ''}
            ${node.children && node.children.length > 0 ? `
              <button onclick="toggleNodeCollapse(event, ${node.instanceId})" class="toggle-btn ${window.collapsedInstanceIds.has(node.instanceId) ? 'toggle-btn-active-accent' : ''}" title="${window.collapsedInstanceIds.has(node.instanceId) ? 'Expand: show inputs again' : 'Collapse: hide inputs'}">
                ${window.collapsedInstanceIds.has(node.instanceId)
                  ? `<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9,18 15,12 9,6"/></svg> +${countDescendants(node)}`
                  : `<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6,9 12,15 18,9"/></svg> Hide`}
              </button>
            ` : ''}
            ${isIsolated ? `
              <button onclick="exitIsolation(event)" class="toggle-btn toggle-btn-active-accent">
                <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                Exit
              </button>
            ` : `
              <button onclick="isolateComponent(event, ${node.instanceId})" class="toggle-btn">
                <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="10.5" cy="10.5" r="6.5"/><line x1="20" y1="20" x2="15.5" y2="15.5"/></svg>
                Isolate
              </button>
            `}
          </div>
        </div>
        <div class="text-sm text-orange-400 mono flex items-center justify-between mt-0.5">
          <span>${isRoot ? 'Output Qty:' : 'Req Qty:'} ${node.qtyNeeded.toLocaleString()} ${node.productName}</span>
          ${stockQty > 0 ? `<span class="text-slate-400 text-xs" title="In Stock in Hangar">Stock: ${stockQty.toLocaleString()}</span>` : ''}
        </div>
        ${stockQty > 0 ? (() => {
          const totalSegs = 10;
          const filledSegs = Math.min(totalSegs, Math.round((stockQty / node.qtyNeeded) * totalSegs));
          return `<div class="seg-bar mt-1.5" title="Stock covers ${Math.min(100, Math.round((stockQty / node.qtyNeeded) * 100))}% of what this needs">${Array.from({length: totalSegs}, (_, i) => `<div class="${i < filledSegs ? 'filled' : ''}"></div>`).join('')}</div>`;
        })() : ''}
        ${node.isBuildingSelf && node.batchYield > 1 ? `<div class="text-orange-300 text-xs mono font-semibold mt-0.5">(${node.runsNeeded} Run${node.runsNeeded > 1 ? 's' : ''} @ ${node.batchYield}/run ${surplus > 0 ? `→ ${surplus} Surplus` : ''})</div>` : ''}
      </div>
    </div>

    <div class="space-y-2.5">
      ${isRoot ? `
        <div class="border-t border-[#3a3025] pt-2.5 flex items-center justify-between text-sm mono" onclick="event.stopPropagation()">
          <span class="text-slate-300 font-bold">Runs:</span>
          <div class="flex items-center space-x-1">
            <input type="number" id="card-bp-runs" value="${node.runsNeeded}" min="1" max="1000000" onchange="syncCardRunsToGlobal(event)" onkeydown="if(event.key==='Enter') this.blur()" class="w-16 bg-black/40 border border-[var(--accent)]/60 rounded text-center text-orange-300 font-bold p-0.5 outline-none">
            <span class="text-slate-400 text-xs">Runs</span>
          </div>
        </div>
      ` : ''}
      ${sellStrategyUI}

      ${(!isRoot && node.isManufacturable) || (!isRoot && (!node.isBuildingSelf || !node.children || node.children.length === 0)) || (node.isBuildingSelf && node.isManufacturable && !node.isReaction) ? `
        <div class="border-t border-[#3a3025] pt-2.5 space-y-2" onclick="event.stopPropagation()">
          ${!isRoot && node.isManufacturable ? `
            <div class="flex items-center justify-between text-xs mono">
              <span class="text-slate-400 font-semibold">Mode:</span>
              <div class="flex space-x-1">
                <button onclick="toggleBuildSelf(event, ${node.typeId})" class="toggle-btn ${node.isBuildingSelf ? 'toggle-btn-active-accent' : ''}">
                  <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 6l4 4-8.5 8.5a2 2 0 01-2.8 0v0a2 2 0 010-2.8L15.2 7.2"/><path d="M12 8l4-4 4 4-4 4"/></svg>
                  Build
                </button>
                <button onclick="toggleBuildSelf(event, ${node.typeId})" class="toggle-btn ${!node.isBuildingSelf ? 'toggle-btn-active-buy' : ''}">
                  <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="20" r="1"/><circle cx="18" cy="20" r="1"/><path d="M2 4h2l2.4 12.4a2 2 0 002 1.6h8.4a2 2 0 002-1.6L21 8H6"/></svg>
                  Buy
                </button>
              </div>
            </div>
          ` : ''}
          ${!isRoot && (!node.isBuildingSelf || !node.children || node.children.length === 0) ? `
            <div class="flex items-center justify-between text-xs mono">
              <span class="text-slate-400 font-semibold">Buy via:</span>
              <div class="flex space-x-1">
                <button onclick="setComponentBuyMode(event, ${node.typeId}, 'sell')" class="toggle-btn ${currentBuyStrategy === 'sell' ? 'toggle-btn-active-accent' : ''}" title="Instant Buy off Sell Orders">
                  <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13,2 3,14 11,14 9,22 21,10 13,10"/></svg>
                  Sell
                </button>
                <button onclick="setComponentBuyMode(event, ${node.typeId}, 'buy')" class="toggle-btn ${currentBuyStrategy === 'buy' ? 'toggle-btn-active-buy' : ''}" title="Order Placing via Buy Orders">
                  <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h9l3 3v15H6z"/><line x1="9" y1="9" x2="15" y2="9"/><line x1="9" y1="13" x2="15" y2="13"/></svg>
                  Buy
                </button>
              </div>
            </div>
          ` : ''}
          ${node.isBuildingSelf && node.isManufacturable && !node.isReaction ? `
            <div class="flex items-center justify-between text-xs mono" onmousedown="event.stopPropagation()">
              <span class="text-slate-400 font-semibold">Job ME/TE:</span>
              <div class="flex items-center space-x-1">
                <input type="number" id="card-me-${node.instanceId}" min="0" max="10" value="${node.customME}" onchange="onCardMEChange(event, ${node.typeId}, ${node.instanceId})" class="w-10 bg-black/40 border border-[#3a3025] rounded text-center text-orange-400 font-bold p-0.5 outline-none focus:border-[var(--accent)]">
                <span class="text-slate-500">%</span>
                <input type="number" id="card-te-${node.instanceId}" min="0" max="20" value="${node.customTE}" onchange="onCardTEChange(event, ${node.typeId}, ${node.instanceId})" class="w-10 bg-black/40 border border-[#3a3025] rounded text-center text-orange-400 font-bold p-0.5 outline-none focus:border-[var(--accent)]">
                <span class="text-slate-500">%</span>
              </div>
            </div>
          ` : ''}
        </div>
      ` : ''}

      <div class="text-sm mono space-y-1 border-t border-[#3a3025] pt-2.5">
        <div class="flex justify-between items-center font-semibold">
          <span class="text-slate-400">Lowest Sell:</span>
          <div class="flex items-center gap-1.5">
            <span class="text-green-400 font-bold">${prices.sell.toLocaleString()} ISK</span>
            <button onclick="openMarketComparison(event, ${productTypeId}, '${window.esc(node.productName || node.name)}')" class="toggle-btn" title="Compare price and trade volume across your tracked markets">
              <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17,1 21,5 17,9"/><path d="M3 11V9a4 4 0 014-4h14"/><polyline points="7,23 3,19 7,15"/><path d="M21 13v2a4 4 0 01-4 4H3"/></svg>
              Compare
            </button>
          </div>
        </div>
        <div class="flex justify-between text-slate-400"><span>Highest Buy:</span><span class="text-slate-300">${prices.buy.toLocaleString()} ISK</span></div>
        ${!isRoot && savingsPct !== null ? `<div class="flex justify-between text-green-400 font-semibold text-xs"><span>Order Savings:</span><span>${savingsPct}%</span></div>` : ''}
        ${node.jobFee > 0 && node.isBuildingSelf ? `<div class="flex justify-between text-[#e85555] font-semibold border-t border-[#3a3025] pt-1"><span>Job Inst. Fee:</span><span>+${Math.round(node.jobFee).toLocaleString()} ISK</span></div>` : ''}
        <div class="flex justify-between font-bold border-t border-[#3a3025] pt-1 mt-1"><span class="text-slate-300">${isRoot ? 'Total Production Cost:' : node.isBuildingSelf ? 'Calculated Build Cost:' : 'Market Buy Cost:'}</span><span class="text-orange-400 font-bold">${Math.round(node.calculatedCost || 0).toLocaleString()} ISK</span></div>
        ${isRoot ? `
          <div class="flex justify-between font-bold border-t border-green-500/40 pt-1.5 mt-1">
            <span class="text-slate-300">${window.rootSellStrategy === 'custom-contract' ? 'Net Profit (Contract Output):' : 'Net Profit (Sell Output):'}</span>
            <span class="${(node.netProfitSell || 0) >= 0 ? 'text-green-400' : 'text-red-400'} font-bold">${Math.round(node.netProfitSell || 0).toLocaleString()} ISK</span>
          </div>
        ` : ''}
      </div>
      ${(buildTimeUI || isRoot) ? `
        <div class="border-t border-[#3a3025] pt-2.5">
          <div class="section-label text-[11px] mb-1">Time and Efficiency</div>
          <div class="text-sm mono space-y-1">
            ${buildTimeUI}
            ${isRoot ? `
              <div class="flex justify-between font-bold" title="This job's own time PLUS every sub-component you're manufacturing yourself (not buying) - this is the number the Ledger's countdown timer actually uses, since building sub-components takes real time before you can even start the final job.">
                <span class="text-slate-300">Total Project Time:</span>
                ${node.totalBuildSeconds > 0
                  ? `<span class="text-orange-300 font-bold">${window.formatDuration(node.totalBuildSeconds)}</span>`
                  : `<span class="text-slate-500 italic">No Time Data</span>`}
              </div>
            ` : ''}
            ${isRoot ? `
              <div class="flex justify-between font-bold" title="Total net sell profit divided by the total time to build this item and every sub-component you're manufacturing yourself.">
                <span class="text-slate-300">Est. ISK/Hour:</span>
                ${node.totalBuildSeconds > 0
                  ? `<span class="${(node.netProfitSell || 0) >= 0 ? 'text-green-400' : 'text-red-400'} font-bold">${Math.round((node.netProfitSell || 0) / (node.totalBuildSeconds / 3600)).toLocaleString()} ISK</span>`
                  : `<span class="text-slate-500 italic">No Time Data</span>`}
              </div>
            ` : ''}
          </div>
        </div>
      ` : ''}
    </div>
  `;
  return card;
}

function syncCardRunsToGlobal(e) {
  const val = Math.max(1, parseInt(e.target.value) || 1);
  window.globalRuns = val;
  const globalInput = document.getElementById('bp-runs');
  if (globalInput) { globalInput.value = val; }
  recalculate();
}

function syncCustomPrice(e) {
  const val = parseFloat(e.target.value) || 0;
  window.rootCustomPrice = val >= 0 ? val : 0;
  recalculate();
}

function syncCustomTax(e) {
  const val = parseFloat(e.target.value) || 0;
  window.rootCustomTax = val >= 0 ? val : 0;
  recalculate();
}

function syncSellStrategy(e) {
  window.rootSellStrategy = e.target.value;
  recalculate();
}

// (extractJobMaterialsForNode moved to config.js so both the calculator and ledger pages can use it)

// Finds every sub-assembly (depth > 0) that's toggled to "Build" and actually has its own inputs -
// i.e. every intermediate manufacturing job the player needs to run before the final product.
// Returned deepest-first, since prerequisites must be built before whatever depends on them.
function collectSubBuildNodes(root) {
  const results = [];
  function walk(node) {
    if (!node) return;
    if (node.depth > 0 && node.isBuildingSelf && node.children && node.children.length > 0) {
      results.push(node);
    }
    if (node.children) node.children.forEach(child => { if (child) walk(child); });
  }
  walk(root);
  results.sort((a, b) => b.depth - a.depth); // deepest (most prerequisite) first
  return results;
}

function addCurrentJobToLedger(e) {
  if (e) e.stopPropagation();
  if (!window.recipeTreeRoot) return;

  recalculate();

  let queue = [];
  try {
    const saved = localStorage.getItem('eve_ledger_jobs');
    if (saved) {
      queue = JSON.parse(saved);
    }
  } catch (err) {
    queue = [];
  }

  const selectedStrategy = window.rootSellStrategy || 'market-sell';
  const rootProductTypeId = window.recipeTreeRoot.productTypeId || window.recipeTreeRoot.typeId;
  const outputPrices = window.priceCache[rootProductTypeId] || { sell: 0, buy: 0 };
  let customPrice = window.rootCustomPrice || 0;
  let unitSellPrice = selectedStrategy.startsWith('custom-') ? customPrice : outputPrices.sell;
  const baseTime = extractBuildTime(window.recipeTreeRoot.recipe, window.recipeTreeRoot.typeId, window.recipeTreeRoot.name);

  const materials = extractJobMaterialsForNode(window.recipeTreeRoot);

  const rootJobName = window.recipeTreeRoot.productName || window.recipeTreeRoot.name.replace(/ Blueprint$/i, '').replace(/ Reaction Formula$/i, '').replace(/ Formula$/i, '').trim();

  // Every build-toggled sub-assembly becomes its own queued job, inserted before the final job since
  // it's a prerequisite for it. These deliberately have no netProfit field - the final job's profit
  // already accounts for the savings from building these instead of buying them, so giving each
  // sub-build its own "profit" figure would double-count the same value. The ledger's profit totals
  // already skip any job where netProfit is undefined, so this "just works" without extra bookkeeping.
  const subBuildNodes = collectSubBuildNodes(window.recipeTreeRoot);
  const subBuildJobs = subBuildNodes.map(node => ({
    id: Date.now() + Math.floor(Math.random() * 1000) + node.instanceId,
    typeId: node.typeId,
    productTypeId: node.productTypeId,
    name: node.productName || node.name.replace(/ Blueprint$/i, '').replace(/ Reaction Formula$/i, '').replace(/ Formula$/i, '').trim(),
    runsNeeded: node.runsNeeded,
    qtyNeeded: node.qtyNeeded,
    calculatedCost: node.calculatedCost || 0,
    baseTime: extractBuildTime(node.recipe),
    totalBuildSeconds: calculateTotalBuildSeconds(node),
    materials: extractJobMaterialsForNode(node),
    isSubBuild: true,
    parentJobName: rootJobName,
    addedAt: new Date().toISOString()
  }));

  const job = {
    id: Date.now() + Math.floor(Math.random() * 1000),
    typeId: window.recipeTreeRoot.typeId,
    name: rootJobName,
    productTypeId: window.recipeTreeRoot.productTypeId,
    runsNeeded: window.recipeTreeRoot.runsNeeded,
    qtyNeeded: window.recipeTreeRoot.qtyNeeded,
    calculatedCost: window.recipeTreeRoot.calculatedCost || 0,
    baseTime: baseTime,
    totalBuildSeconds: calculateTotalBuildSeconds(window.recipeTreeRoot),
    netProfit: window.recipeTreeRoot.netProfitSell || 0,
    sellStrategy: selectedStrategy,
    unitSellPrice: unitSellPrice,
    materials: materials,
    addedAt: new Date().toISOString()
  };

  // Sub-build (prerequisite) jobs go in first, final job last.
  queue.push(...subBuildJobs, job);
  localStorage.setItem('eve_ledger_jobs', JSON.stringify(queue));
  localStorage.setItem('eve_user_stock_map', JSON.stringify(window.userStockMap || {}));

  updateHeaderLedgerCount();

  const btn = e.target.closest('button');
  if (btn) {
    const originalText = btn.innerHTML;
    btn.innerHTML = subBuildJobs.length > 0 ? `✔ ADDED ${subBuildJobs.length + 1} JOBS` : '✔ ADDED TO QUEUE';
    btn.classList.remove('bg-orange-800', 'hover:bg-orange-700', 'text-orange-100');
    btn.classList.add('bg-green-700', 'text-white');
    setTimeout(() => {
      btn.innerHTML = originalText;
      btn.classList.remove('bg-green-700', 'text-white');
      btn.classList.add('bg-orange-800', 'hover:bg-orange-700', 'text-orange-100');
    }, 1500);
  }
}

function updateHeaderLedgerCount() {
  const badge = document.getElementById('header-journal-count');
  if (!badge) return;
  try {
    const saved = localStorage.getItem('eve_ledger_jobs');
    if (saved) {
      const queue = JSON.parse(saved);
      badge.textContent = Array.isArray(queue) ? queue.length.toString() : '0';
    } else {
      badge.textContent = '0';
    }
  } catch (e) {
    badge.textContent = '0';
  }
}

function onNodeClick(e, instanceId) {
  e.stopPropagation();
  window.selectedInstanceId = (window.selectedInstanceId === instanceId) ? null : instanceId;
  applyNodeHighlightClasses();
  drawConnectingLines();
}

function clearHighlight() {
  if (window.selectedInstanceId !== null) {
    window.selectedInstanceId = null;
    applyNodeHighlightClasses();
    drawConnectingLines();
  }
}

function findNodeByInstanceId(root, id) {
  if (!root) return null;
  if (root.instanceId === id) return root;
  if (root.children) {
    for (const child of root.children) {
      if (child) {
        const found = findNodeByInstanceId(child, id);
        if (found) return found;
      }
    }
  }
  return null;
}

function applyNodeHighlightClasses() {
  const allCards = document.querySelectorAll('.diagram-node');
  
  if (!window.selectedInstanceId) {
    allCards.forEach(card => {
      card.classList.remove('node-selected', 'node-child-highlight', 'node-parent-highlight', 'node-dimmed');
    });
    return;
  }

  const selectedNode = findNodeByInstanceId(window.recipeTreeRoot, window.selectedInstanceId);
  const childInstanceIds = new Set(selectedNode ? selectedNode.children.map(c => c.instanceId) : []);
  const parentInstanceId = selectedNode ? selectedNode.parentInstanceId : null;

  allCards.forEach(card => {
    const instanceId = parseInt(card.getAttribute('data-instance-id'));
    card.classList.remove('node-selected', 'node-child-highlight', 'node-parent-highlight', 'node-dimmed');

    if (instanceId === window.selectedInstanceId) {
      card.classList.add('node-selected');
    } else if (childInstanceIds.has(instanceId)) {
      card.classList.add('node-child-highlight');
    } else if (instanceId === parentInstanceId) {
      card.classList.add('node-parent-highlight');
    } else {
      card.classList.add('node-dimmed');
    }
  });
}

function highlightNodeByTypeId(typeId) {
  function findMatchingNode(node) {
    if (!node) return null;
    // BOM rows are keyed by productTypeId (the traded item). For raw materials, typeId and
    // productTypeId are the same, so the old typeId/displayTypeId-only check happened to work. But
    // for a manufacturable sub-component toggled to "Buy", node.typeId is the blueprint's own id while
    // productTypeId is the actual traded item the BOM row represents - only checking typeId/displayTypeId
    // silently failed to find those nodes, which is why clicking some BOM rows never centered anything.
    if (node.typeId === typeId || node.displayTypeId === typeId || node.productTypeId === typeId) return node;
    if (node.children) {
      for (const child of node.children) {
        if (child) {
          const found = findMatchingNode(child);
          if (found) return found;
        }
      }
    }
    return null;
  }

  const targetNode = findMatchingNode(window.recipeTreeRoot);
  if (targetNode) {
    window.selectedInstanceId = targetNode.instanceId;
    applyNodeHighlightClasses();
    drawConnectingLines();
    centerOnSelectedNode();
  }
}

function isolateComponent(e, instanceId) {
  if (e) e.stopPropagation();
  window.isolatedInstanceId = instanceId;
  window.selectedInstanceId = instanceId;
  renderIsolatedDiagram();
  setTimeout(drawConnectingLines, 50);
  setTimeout(centerOnSelectedNode, 60);
}

function exitIsolation(e) {
  if (e) e.stopPropagation();
  const targetId = window.isolatedInstanceId || window.selectedInstanceId;
  window.isolatedInstanceId = null;
  recalculate();
  setTimeout(() => {
    window.selectedInstanceId = targetId;
    applyNodeHighlightClasses();
    drawConnectingLines();
    centerOnSelectedNode();
  }, 60);
}

function renderIsolatedDiagram() {
  const container = document.getElementById('tree-container');
  if (!container) return;
  container.innerHTML = '';

  const isolatedNode = findNodeByInstanceId(window.recipeTreeRoot, window.isolatedInstanceId);
  if (!isolatedNode) return;

  const parentNode = isolatedNode.parentInstanceId ? findNodeByInstanceId(window.recipeTreeRoot, isolatedNode.parentInstanceId) : null;

  const inputCol = document.createElement('div');
  inputCol.className = 'flex flex-col space-y-4 justify-center';
  
  if (!isolatedNode.isBuildingSelf || isolatedNode.children.length === 0) {
    inputCol.innerHTML = `<div class="bg-[#0a0d0e] border border-[#3a4a4c] p-3 text-xs text-slate-400 mono ">${!isolatedNode.isBuildingSelf ? 'Purchased off Market (No decomposed inputs)' : 'No inputs (Base Material)'}</div>`;
  } else {
    isolatedNode.children.forEach(child => {
      if (child) inputCol.appendChild(createNodeCard(child));
    });
  }

  const centerCol = document.createElement('div');
  centerCol.className = 'flex flex-col justify-center';
  centerCol.appendChild(createNodeCard(isolatedNode));

  const outputCol = document.createElement('div');
  outputCol.className = 'flex flex-col justify-center';
  
  if (parentNode) {
    outputCol.appendChild(createNodeCard(parentNode));
  } else {
    outputCol.innerHTML = `<div class="bg-[#0a0d0e] border border-orange-500/50 p-3 text-xs text-orange-300 font-bold mono ">Final Target Output</div>`;
  }

  container.appendChild(inputCol);
  container.appendChild(centerCol);
  container.appendChild(outputCol);

  applyNodeHighlightClasses();
}

function centerOnSelectedNode() {
  let targetId = window.isolatedInstanceId || window.selectedInstanceId;
  
  if (!targetId && window.recipeTreeRoot) {
    targetId = window.recipeTreeRoot.instanceId;
  }

  if (!targetId) return;

  const card = document.getElementById(`node-card-${targetId}`);
  const viewport = document.getElementById('viewport');
  const content = document.getElementById('pan-zoom-content');

  if (!card || !viewport || !content) return;

  viewport.scrollTop = 0;
  viewport.scrollLeft = 0;

  const viewportRect = viewport.getBoundingClientRect();
  const contentRect = content.getBoundingClientRect();
  const cardRect = card.getBoundingClientRect();

  const cardContentX = (cardRect.left - contentRect.left) / window.zoomScale;
  const cardContentY = (cardRect.top - contentRect.top) / window.zoomScale;

  const cardContentWidth = cardRect.width / window.zoomScale;
  const cardContentHeight = cardRect.height / window.zoomScale;

  const cardContentCenterX = cardContentX + cardContentWidth / 2;
  const cardContentCenterY = cardContentY + cardContentHeight / 2;

  window.panX = (viewportRect.width / 2) - cardContentCenterX * window.zoomScale;
  window.panY = (viewportRect.height / 2) - cardContentCenterY * window.zoomScale;

  updateTransform();
  drawConnectingLines();

  card.classList.add('ring-4', 'ring-orange-400');
  setTimeout(() => card.classList.remove('ring-4', 'ring-orange-400'), 800);
}

function drawConnectingLines() {
  const svg = document.getElementById('tree-svg');
  const container = document.getElementById('tree-container');
  if (!svg || !container) return;
  
  svg.setAttribute('width', container.scrollWidth);
  svg.setAttribute('height', container.scrollHeight);
  svg.innerHTML = '';

  if (!window.recipeTreeRoot) return;

  const containerRect = container.getBoundingClientRect();

  if (window.isolatedInstanceId !== null) {
    const MathEl = document.getElementById(`node-card-${window.isolatedInstanceId}`);
    if (!MathEl) return;

    const isoRect = MathEl.getBoundingClientRect();
    const isoLeftX = (isoRect.left - containerRect.left) / window.zoomScale;
    const isoRightX = (isoRect.right - containerRect.left) / window.zoomScale;
    const isoCenterY = (isoRect.top + isoRect.height / 2 - containerRect.top) / window.zoomScale;

    const isolatedNode = findNodeByInstanceId(window.recipeTreeRoot, window.isolatedInstanceId);
    if (!isolatedNode) return;

    if (isolatedNode.isBuildingSelf && isolatedNode.children) {
      isolatedNode.children.forEach(child => {
        if (child) {
          const childEl = document.getElementById(`node-card-${child.instanceId}`);
          if (childEl) {
            const childRect = childEl.getBoundingClientRect();
            const startX = (childRect.right - containerRect.left) / window.zoomScale;
            const startY = (childRect.top + childRect.height / 2 - containerRect.top) / window.zoomScale;

            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', `M ${startX} ${startY} C ${startX + 40} ${startY}, ${isoLeftX - 40} ${isoCenterY}, ${isoLeftX} ${isoCenterY}`);
            path.setAttribute('stroke', '#4caf6f');
            path.setAttribute('stroke-width', '3.5');
            path.setAttribute('stroke-opacity', '1.0');
            path.setAttribute('fill', 'none');
            svg.appendChild(path);
          }
        }
      });
    }

    if (isolatedNode.parentInstanceId) {
      const parentNode = findNodeByInstanceId(window.recipeTreeRoot, isolatedNode.parentInstanceId);
      if (parentNode) {
        const parentEl = document.getElementById('node-card-' + parentNode.instanceId);
        if (parentEl) {
          const parentRect = parentEl.getBoundingClientRect();
          const endX = (parentRect.left - containerRect.left) / window.zoomScale;
          const endY = (parentRect.top + parentRect.height / 2 - containerRect.top) / window.zoomScale;

          const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          path.setAttribute('d', `M ${isoRightX} ${isoCenterY} C ${isoRightX + 40} ${isoCenterY}, ${endX - 40} ${endY}, ${endX} ${endY}`);
          path.setAttribute('stroke', '#e8c96a');
          path.setAttribute('stroke-width', '3.5');
          path.setAttribute('stroke-opacity', '1.0');
          path.setAttribute('fill', 'none');
          svg.appendChild(path);
        }
      }
    }
    return;
  }

  drawConnectingLinesForTree(window.recipeTreeRoot);
}

function drawConnectingLinesForTree(root) {
  if (!root) return;
  
  const container = document.getElementById('tree-container');
  const svg = document.getElementById('tree-svg');
  if (!svg || !container) return;

  const containerRect = container.getBoundingClientRect();
  const selectedNode = window.selectedInstanceId ? findNodeByInstanceId(window.recipeTreeRoot, window.selectedInstanceId) : null;
  const activeChildIds = new Set(selectedNode ? selectedNode.children.map(c => c.instanceId) : []);
  const parentInstanceId = selectedNode ? selectedNode.parentInstanceId : null;

  function drawLinesForNode(node) {
    if (!node.isBuildingSelf || !node.children || node.children.length === 0) return;

    const parentEl = document.getElementById(`node-card-${node.instanceId}`);
    if (!parentEl) return;

    const parentRect = parentEl.getBoundingClientRect();
    
    const endX = (parentRect.left - containerRect.left) / window.zoomScale;
    const endY = (parentRect.top + parentRect.height / 2 - containerRect.top) / window.zoomScale;

    node.children.forEach(child => {
      if (child) {
        const childEl = document.getElementById(`node-card-${child.instanceId}`);
        if (childEl) {
          const childRect = childEl.getBoundingClientRect();
          
          const startX = (childRect.right - containerRect.left) / window.zoomScale;
          const startY = (childRect.top + childRect.height / 2 - containerRect.top) / window.zoomScale;

          const controlX1 = startX + 40;
          const controlX2 = endX - 40;

          const isInputConnection = (window.selectedInstanceId !== null) && 
            (node.instanceId === window.selectedInstanceId && activeChildIds.has(child.instanceId));

          const isOutputConnection = (window.selectedInstanceId !== null) && 
            (child.instanceId === window.selectedInstanceId && node.instanceId === parentInstanceId);

          const isHighlightedConnection = isInputConnection || isOutputConnection;
          const isDimmedConnection = (window.selectedInstanceId !== null) && !isHighlightedConnection;

          const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          path.setAttribute('d', `M ${startX} ${startY} C ${controlX1} ${startY}, ${controlX2} ${endY}, ${endX} ${endY}`);
          
          if (isHighlightedConnection) {
            path.setAttribute('stroke', isOutputConnection ? '#e8c96a' : '#4caf6f');
            path.setAttribute('stroke-width', '3.5');
            path.setAttribute('stroke-opacity', '1.0');
          } else if (isDimmedConnection) {
            path.setAttribute('stroke', '#06b6d4');
            path.setAttribute('stroke-width', '1.5');
            path.setAttribute('stroke-opacity', '0.12');
          } else {
            path.setAttribute('stroke', '#06b6d4');
            path.setAttribute('stroke-width', '2');
            path.setAttribute('stroke-opacity', '0.75');
          }

          path.setAttribute('fill', 'none');
          svg.appendChild(path);
        }
      }
      drawLinesForNode(child);
    });
  }

  drawLinesForNode(root);
}

function renderBillOfMaterials(rootNode, brokerFee = 0) {
  const listContainer = document.getElementById('bom-items-list');
  if (!listContainer) return;
  listContainer.innerHTML = '';

  if (!rootNode) return;

  const deductModeInput = document.getElementById('deduct-stock-mode');
  const isStockDeductEnabled = deductModeInput ? deductModeInput.value === 'true' : true;
  const bomMap = {};
  // Shared pool that gets decremented as materials are claimed across the WHOLE tree - reading
  // window.userStockMap directly per-leaf (the previous approach) let the same physical stock get
  // counted as covering multiple different sub-components' needs simultaneously, whenever the same
  // raw material (e.g. Tritanium) was needed in more than one place in the build.
  const allocatedStockPool = { ...window.userStockMap };

  function generateBOM(node) {
    if (!node) return;
    if (!node.isBuildingSelf || !node.children || node.children.length === 0) {
      const typeId = node.displayTypeId || node.typeId;
      const strategy = window.getNodePriceStrategy(node);
      
      const productTypeId = node.productTypeId || node.typeId;
      const availableStock = isStockDeductEnabled ? (allocatedStockPool[productTypeId] || allocatedStockPool[node.typeId] || 0) : 0;
      const consumedFromStock = Math.min(node.qtyNeeded, availableStock);
      if (isStockDeductEnabled && allocatedStockPool[productTypeId] !== undefined) {
        allocatedStockPool[productTypeId] = Math.max(0, allocatedStockPool[productTypeId] - consumedFromStock);
      }
      const netQtyNeeded = Math.max(0, node.qtyNeeded - consumedFromStock);

      if (!bomMap[productTypeId]) {
        bomMap[productTypeId] = {
          typeId: productTypeId,
          name: node.name.replace(' Blueprint', ''),
          qty: 0,
          strategy: strategy
        };
      }
      bomMap[productTypeId].qty += netQtyNeeded;
    } else {
      node.children.forEach(child => {
        if (child) generateBOM(child);
      });
    }
  }

  if (rootNode.isBuildingSelf && rootNode.children && rootNode.children.length > 0) {
    rootNode.children.forEach(c => {
      if (c) generateBOM(c);
    });
  } else {
    const rootTypeId = rootNode.productTypeId || rootNode.typeId;
    const strategy = getNodeStrategyOnly(rootNode); // safe strategy getter
    const stockQty = isStockDeductEnabled ? (window.userStockMap[rootTypeId] || window.userStockMap[rootNode.typeId] || 0) : 0;
    const netQtyNeeded = Math.max(0, rootNode.qtyNeeded - stockQty);

    bomMap[rootTypeId] = { typeId: rootTypeId, name: rootNode.productName || rootNode.name.replace(' Blueprint', ''), qty: netQtyNeeded, strategy: strategy };
  }

  const bomItems = Object.values(bomMap).filter(item => item.qty > 0);
  let totalBOMCost = 0;
  let totalBOMVolume = 0;

  bomItems.forEach(item => {
    const prices = window.priceCache[item.typeId] || { sell: 0, buy: 0 };
    let unitPrice = item.strategy === 'sell' ? prices.sell : prices.buy;
    if (item.strategy === 'buy') {
      unitPrice = unitPrice * (1 + brokerFee);
    }
    item.unitPrice = unitPrice;
    item.lineCost = unitPrice * item.qty;
    totalBOMCost += item.lineCost;
    const unitVolume = (window.EVE_VOLUMES && window.EVE_VOLUMES[item.typeId]) || 0;
    item.lineVolume = unitVolume * item.qty;
    totalBOMVolume += item.lineVolume;
  });

  bomItems.sort((a, b) => b.lineCost - a.lineCost);

  bomItems.forEach(item => {
    const row = document.createElement('div');
    row.className = 'bg-[#0a0d0e] rounded border border-[#262e30] hover:border-orange-500 hover:bg-[#283438] p-2 flex items-center justify-between cursor-pointer transition shadow-sm';
    row.title = 'Click to find and focus this material in the build diagram';
    row.onclick = () => highlightNodeByTypeId(item.typeId);

    row.innerHTML = `
      <div class="flex items-center space-x-2.5 min-w-0">
        <img src="https://images.evetech.net/types/${item.typeId}/icon?size=32" class="w-7 h-7 border border-slate-700 bg-[#030405] flex-shrink-0" loading="lazy" onerror="this.onerror=null; this.src='https://images.evetech.net/types/${item.typeId}/render?size=32';">
        <div class="min-w-0 flex-1">
          <div class="font-semibold text-slate-200 truncate flex items-center gap-1.5">
            <span class="truncate">${item.name}</span>
            <span class="text-[9px] px-1 font-bold mono ${item.strategy === 'sell' ? 'bg-orange-900/60 text-orange-300' : 'bg-orange-900/60 text-orange-300'}">
              ${item.strategy === 'sell' ? 'SELL' : 'BUY'}
            </span>
          </div>
          <div class="text-[10px] text-slate-400 mono font-semibold">Qty: ${item.qty.toLocaleString()} &times; ${Math.round(item.unitPrice).toLocaleString()} ISK${item.lineVolume > 0 ? ` &bull; ${item.lineVolume.toLocaleString(undefined, {maximumFractionDigits: 1})} m3` : ''}</div>
        </div>
      </div>
      <div class="text-right mono font-bold text-orange-400 flex-shrink-0 ml-2">
        ${Math.round(item.lineCost).toLocaleString()} ISK
      </div>
    `;

    listContainer.appendChild(row);
  });

  const countEl = document.getElementById('bom-type-count');
  if (countEl) countEl.textContent = bomItems.length.toLocaleString();

  const totalEl = document.getElementById('bom-total-isk');
  if (totalEl) totalEl.textContent = Math.round(totalBOMCost).toLocaleString() + ' ISK';

  const volumeEl = document.getElementById('bom-total-volume');
  if (volumeEl) volumeEl.textContent = totalBOMVolume.toLocaleString(undefined, { maximumFractionDigits: 1 }) + ' m3';

  window.currentBOMText = bomItems.map(i => `${i.name} x${i.qty}`).join('\n');
}

function getNodeStrategyOnly(node) {
  if (!node) return 'sell';
  const globalStrategy = document.getElementById('input-price-mode')?.value || 'sell';
  return window.customBuyModes[node.typeId] || globalStrategy;
}

// --- Icon rail flyout navigation ---
function toggleFlyout(sectionId) {
  const targetFlyout = document.getElementById(`flyout-${sectionId}`);
  const targetBtn = document.getElementById(`icon-btn-${sectionId}`);
  const rail = document.getElementById('control-sidebar');
  if (!targetFlyout || !targetBtn || !rail) return;
  const isCurrentlyOpen = targetFlyout.classList.contains('open');

  if (isCurrentlyOpen) {
    targetFlyout.classList.remove('open');
    targetBtn.classList.remove('icon-rail-btn-active');
    return;
  }

  targetFlyout.classList.add('open');
  targetBtn.classList.add('icon-rail-btn-active');

  // Position near the clicked icon's own vertical spot instead of always vertically centering,
  // clamped so it never renders below the visible rail height.
  targetFlyout.style.transform = 'none';
  const iconTop = targetBtn.offsetTop;
  const flyoutHeight = targetFlyout.offsetHeight;
  const railHeight = rail.offsetHeight;
  let top = iconTop;
  if (top + flyoutHeight > railHeight) {
    top = Math.max(12, railHeight - flyoutHeight - 12);
  }
  targetFlyout.style.top = `${top}px`;
}
window.toggleFlyout = toggleFlyout;

function copyMaterialNameToClipboard(event, el, name) {
  if (event) event.stopPropagation();
  navigator.clipboard.writeText(name).then(() => {
    if (!el) return;
    const orig = el.textContent;
    const origClass = el.className;
    el.textContent = '✔ Copied!';
    el.className = 'truncate text-green-400 font-bold transition';
    setTimeout(() => {
      el.textContent = orig;
      el.className = origClass;
    }, 1200);
  }).catch(() => {});
}
window.copyMaterialNameToClipboard = copyMaterialNameToClipboard;

function copyMultibuyText() {
  if (!window.currentBOMText) return;
  navigator.clipboard.writeText(window.currentBOMText).then(() => {
    const btn = document.querySelector('button[onclick="copyMultibuyText()"]');
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = 'Copied!';
      btn.className = 'px-3.5 py-1.5 bg-green-600 text-white font-bold text-xs mono transition';
      setTimeout(() => {
        btn.textContent = orig;
        btn.className = 'px-3.5 py-1.5 bg-orange-600 hover:bg-orange-500 text-white font-bold text-xs mono transition shadow';
      }, 1500);
    }
  });
}

// Smooth Pan and Zoom Engine
const viewport = document.getElementById('viewport');
const content = document.getElementById('pan-zoom-content');

if (viewport) {
  viewport.addEventListener('mousedown', (e) => {
    if (e.button === 1) {
      e.preventDefault();
      window.isPanning = true;
      window.startX = e.clientX - window.panX;
      window.startY = e.clientY - window.panY;
      viewport.style.cursor = 'grabbing';
    }
  });

  window.addEventListener('mousemove', (e) => {
    if (window.isPanning) {
      window.panX = e.clientX - window.startX;
      window.panY = e.clientY - window.startY;
      updateTransform();
    }
  });

  window.addEventListener('mouseup', (e) => {
    if (e.button === 1 && window.isPanning) {
      window.isPanning = false;
      viewport.style.cursor = 'grab';
    }
  });

  viewport.addEventListener('wheel', (e) => {
    e.preventDefault();
    const zoomFactor = e.deltaY < 0 ? 1.15 : 0.85;
    const newScale = Math.min(Math.max(0.2, window.zoomScale * zoomFactor), 3.0);

    const rect = viewport.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    window.panX = mouseX - (mouseX - window.panX) * (newScale / window.zoomScale);
    window.panY = mouseY - (mouseY - window.panY) * (newScale / window.zoomScale);
    window.zoomScale = newScale;

    updateTransform();
    drawConnectingLines();
  }, { passive: false });
}

function updateTransform() {
  const roundedPanX = Math.round(window.panX);
  const roundedPanY = Math.round(window.panY);
  if (content) content.style.transform = `translate(${roundedPanX}px, ${roundedPanY}px) scale(${window.zoomScale})`;
  const zoomText = document.getElementById('zoom-level-text');
  if (zoomText) zoomText.textContent = `Zoom: ${Math.round(window.zoomScale * 100)}%`;
}

function resetPanZoom() {
  window.zoomScale = 1.0;
  window.panX = 0;
  window.panY = 0;
  updateTransform();
  drawConnectingLines();
}

window.addCurrentJobToLedger = addCurrentJobToLedger;
window.updateHeaderLedgerCount = updateHeaderLedgerCount;
window.syncSellStrategy = syncSellStrategy;
window.syncCustomPrice = syncCustomPrice;
window.syncCustomTax = syncCustomTax;
window.syncCardRunsToGlobal = syncCardRunsToGlobal;
window.selectItem = selectItem;
window.clearHighlight = clearHighlight;
window.isolateComponent = isolateComponent;
window.exitIsolation = exitIsolation;
window.onNodeClick = onNodeClick;
window.highlightNodeByTypeId = highlightNodeByTypeId;
window.centerOnSelectedNode = centerOnSelectedNode;
window.resetPanZoom = resetPanZoom;
window.copyMultibuyText = copyMultibuyText;
window.resolveProductIdFromBlueprintNameAsync = resolveProductIdFromBlueprintNameAsync;

// Initialize Application
// --- Halftone triangle background ---
// Generates a radial halftone of triangles: large/dense near the edges, shrinking and fading
// toward the center. A true radial halftone can't be done with repeating CSS patterns alone
// (they're uniform, not distance-varying), so this computes it directly in JS.
function generateHalftoneBackground() {
  const svg = document.getElementById('halftone-bg');
  if (!svg) return;
  const W = window.innerWidth;
  const H = window.innerHeight;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const cx = W / 2, cy = H / 2;
  const maxDist = Math.sqrt(cx * cx + cy * cy);
  const spacing = 34;
  const rowHeight = spacing * 0.87;
  let svgContent = '';

  // Triangular tessellation: the outer grid (tile positions) stays at the ORIGINAL density -
  // spacing horizontally, rowHeight vertically - matching a correct equilateral-triangle rhythm.
  // Each tile then contains one up-pointing and one down-pointing triangle side by side, splitting
  // the tile's own width in half, rather than doubling the grid's iteration density (which was the
  // actual cause of the horizontal crowding in the previous attempt).
  for (let y = -rowHeight; y < H + rowHeight; y += rowHeight) {
    for (let x = -spacing; x < W + spacing; x += spacing) {
      const tileCenterX = x + spacing / 2;
      const dist = Math.sqrt((tileCenterX - cx) ** 2 + (y - cy) ** 2) / maxDist; // 0 (center) to 1 (corner)
      const sizeScale = Math.min(1, 0.15 + dist * 0.95); // how much of the tile's half-width each triangle actually fills
      const opacity = Math.min(0.13, dist * 0.1671);
      if (opacity < 0.004) continue;

      const halfW = (spacing / 2) * sizeScale / 2;
      const halfH = rowHeight * sizeScale / 2;

      // Up-pointing triangle, left half of the tile
      const upX = x + spacing / 4;
      svgContent += `<polygon points="${upX},${y - halfH} ${upX + halfW},${y + halfH} ${upX - halfW},${y + halfH}" fill="rgba(102,37,0,${opacity.toFixed(3)})"/>`;

      // Down-pointing triangle, right half of the tile
      const downX = x + spacing * 3 / 4;
      svgContent += `<polygon points="${downX - halfW},${y - halfH} ${downX + halfW},${y - halfH} ${downX},${y + halfH}" fill="rgba(102,37,0,${opacity.toFixed(3)})"/>`;
    }
  }
  svg.innerHTML = svgContent;
}
window.generateHalftoneBackground = generateHalftoneBackground;

let halftoneResizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(halftoneResizeTimer);
  halftoneResizeTimer = setTimeout(generateHalftoneBackground, 200);
});

window.onload = async () => {
  generateHalftoneBackground();
  (function positionDefaultFlyout() {
    const rail = document.getElementById('control-sidebar');
    const btn = document.getElementById('icon-btn-search');
    const flyout = document.getElementById('flyout-search');
    if (!rail || !btn || !flyout) return;
    flyout.style.transform = 'none';
    flyout.style.top = `${btn.offsetTop}px`;
  })();
  if (typeof window.buildPrepackedIndexes === 'function') {
    window.buildPrepackedIndexes();
  }

  // Load static local states instantly so the app is interactive immediately!
  try {
    restoreRigSlotInputs(); // Show each rig slot's saved rig name (if any) before restoring other tax settings
    renderProductionPresetDropdown();
    restoreHomeMarketInput();
    renderTrackedMarketsList();
    if (typeof window.ensureDefaultTrackedMarkets === 'function') {
      window.ensureDefaultTrackedMarkets().then(() => renderTrackedMarketsList()).catch(err => console.warn('Default market seeding failed:', err));
    }
    loadTaxSettings(); // Load custom taxes from localStorage!
    loadSavedState(); // Load previous product & overrides persistently from localStorage!
    updateHeaderLedgerCount(); // Update badge on load!
  } catch (err) {
    console.error("State restoration error:", err);
  }

  // Restore the previously-selected solar system (SCI) - was defined but never called, so the
  // system silently reset to the default (Jita) on every reload.
  if (typeof window.loadSavedSystem === 'function') {
    window.loadSavedSystem().catch(err => console.error("Saved system restore error:", err));
  }

  // Handle SSO Callback and assets asynchronously in the background
  if (typeof window.handleEsiSSOCallback === 'function') {
    window.handleEsiSSOCallback().catch(err => console.error("SSO Callback error:", err));
  }

  // Fetch adjusted prices asynchronously in the background
  if (typeof window.fetchAdjustedPrices === 'function') {
    window.fetchAdjustedPrices().catch(err => console.error("Adjusted prices fetch error:", err));
  }

  window.addEventListener('resize', drawConnectingLines);
};

// "F" key: center/focus on the selected card, or the final output card when nothing is selected.
// centerOnSelectedNode() already falls back to window.recipeTreeRoot when nothing is selected.
window.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() !== 'f' || e.ctrlKey || e.metaKey || e.altKey) return;
  const activeEl = document.activeElement;
  const tag = activeEl ? activeEl.tagName : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (activeEl && activeEl.isContentEditable)) return;
  if (typeof window.centerOnSelectedNode === 'function') {
    e.preventDefault();
    window.centerOnSelectedNode();
  }
});