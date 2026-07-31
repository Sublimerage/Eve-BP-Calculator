'use strict';

// Initialize global variables securely in memory to prevent DOM-sync issues
if (window.rootSellStrategy === undefined) window.rootSellStrategy = 'market-sell';
if (window.rootCustomPrice === undefined) window.rootCustomPrice = 0;
if (window.globalRuns === undefined) window.globalRuns = 1;

// Centralized helpers are loaded globally from js/config.js (window.esc, window.safeParseJSON, window.formatDuration)

// Structural helper to extract the base build time of a recipe or resolve intelligent fallbacks
function extractBuildTime(recipe, typeId, name) {
  if (recipe) {
    // Standard compressed SDE files use "t" for the base blueprint time to conserve space
    const candidates = [
      recipe.t,
      recipe.time,
      recipe.timeSeconds,
      recipe.duration,
      recipe.productionTime,
      recipe.mfgTime,
      recipe.reactionTime,
      recipe.activityTime,
      recipe.activityDuration
    ];
    for (const c of candidates) {
      const val = parseInt(c);
      if (!isNaN(val) && val > 0) return val;
    }

    // Check inside nested activityProducts/activityMaterials or standard compressed SDE arrays
    if (recipe.activityProducts && typeof recipe.activityProducts === 'object') {
      const act1 = recipe.activityProducts['1'] || recipe.activityProducts[1];
      const act11 = recipe.activityProducts['11'] || recipe.activityProducts[11];
      if (act1 && act1[0] && (act1[0].time || act1[0].t)) {
        const val = parseInt(act1[0].time || act1[0].t);
        if (!isNaN(val) && val > 0) return val;
      }
      if (act11 && act11[0] && (act11[0].time || act11[0].t)) {
        const val = parseInt(act11[0].time || act11[0].t);
        if (!isNaN(val) && val > 0) return val;
      }
    }
  }

  // Fallback: If SDE lacks time data entirely, resolve intelligent default base manufacturing times
  const n = String(name || '').toLowerCase();
  const tId = parseInt(typeId);

  // 1. Known stubs by Type ID
  if (tId === 16681 || tId === 16680 || tId === 16679 || tId === 17730 || tId === 17729 || tId === 17728) {
    return 600; // Reactions (10 minutes)
  }
  if (tId === 4247 || tId === 4248 || tId === 4246) {
    return 15; // Fuel blocks (15 seconds)
  }
  if (tId === 57478 || tId === 57515 || tId === 57486 || tId === 57523) {
    return 240; // Auto-integrity / Life support
  }
  if (tId === 57479 || tId === 57516) {
    return 1200; // Core temp regulator
  }

  // 2. Ships by Case-Insensitive Name Matching
  // Battleships (80,000 seconds base)
  if (n.includes('leshak') || n.includes('megathron') || n.includes('raven') || n.includes('abaddon') || n.includes('dominix') || n.includes('tempest') || n.includes('rokh') || n.includes('hyperion') || n.includes('apocalypse') || n.includes('typhoon') || n.includes('geddon') || n.includes('maelstrom')) return 80000;
  // Battlecruisers (40,000 seconds base)
  if (n.includes('drekavac') || n.includes('drake') || n.includes('hurricane') || n.includes('brutix') || n.includes('harbinger') || n.includes('myrmidon') || n.includes('ferox') || n.includes('cyclone') || n.includes('prophecy') || n.includes('gnosis')) return 40000;
  // Cruisers (24,000 seconds base)
  if (n.includes('caracal') || n.includes('ishtar') || n.includes('vexor') || n.includes('rupture') || n.includes('thorax') || n.includes('omen') || n.includes('moa') || n.includes('stabber') || n.includes('maller') || n.includes('blackbird') || n.includes('celestis') || n.includes('arbitrator') || n.includes('bellicose')) return 24000;
  // Destroyers (12,000 seconds base)
  if (n.includes('cormorant') || n.includes('coercer') || n.includes('catalyst') || n.includes('thrasher') || n.includes('talwar') || n.includes('corax') || n.includes('algos') || n.includes('dragoon')) return 12000;
  // Frigates / Rookie (6,000 seconds base)
  if (n.includes('rifter') || n.includes('punisher') || n.includes('merlin') || n.includes('tristan') || n.includes('kestrel') || n.includes('incursus') || n.includes('atron') || n.includes('slasher') || n.includes('imicus') || n.includes('heron') || n.includes('magnate') || n.includes('probe')) return 6000;

  // 3. Modules by Tech Level
  if (n.includes(' ii') || n.endsWith(' ii') || n.includes('2')) return 2340; // Tech II Modules / Items (39 minutes)

  // Default T1 Modules/Items
  return 900; // Tech I Modules (15 minutes)
}

// Recursively binds memory ME/TE overrides to tree objects before calculating
function syncTreeOverrides(node) {
  if (!node) return;
  const tId = node.typeId;

  // Guard against uninitialized variables on initial loads
  const meMap = (typeof window.customMEOverrides !== 'undefined' && window.customMEOverrides) ? window.customMEOverrides : {};
  const teMap = (typeof window.customTEOverrides !== 'undefined' && window.customTEOverrides) ? window.customTEOverrides : {};

  node.customME = meMap[tId] !== undefined ? meMap[tId] : 0;
  node.customTE = teMap[tId] !== undefined ? teMap[tId] : 0;
  
  if (node.children) {
    node.children.forEach(child => syncTreeOverrides(child));
  }
}

function saveTaxSettings() {
  try {
    const facilitySelectEl = document.getElementById('facility-select');
    const selectedText = facilitySelectEl ? facilitySelectEl.options[facilitySelectEl.selectedIndex].text.toLowerCase() : 'npc';
    let facilityKey = 'npc';
    if (selectedText.includes('sotiyo')) facilityKey = 'sotiyo';
    else if (selectedText.includes('azbel')) facilityKey = 'azbel';
    else if (selectedText.includes('raitaru')) facilityKey = 'raitaru';

    localStorage.setItem('eve_active_facility_key', facilityKey);

    const settings = {
      facilityTax: document.getElementById('facility-tax')?.value,
      sccSurcharge: document.getElementById('scc-surcharge')?.value,
      salesTax: document.getElementById('sales-tax')?.value,
      brokerFee: document.getElementById('broker-fee')?.value,
      facilitySelect: document.getElementById('facility-select')?.value,
      structureRoleBonus: document.getElementById('structure-role-bonus')?.value,
      contractTax: document.getElementById('contract-tax')?.value,
      contractBroker: document.getElementById('contract-broker')?.value
    };
    localStorage.setItem('eve_tax_settings', JSON.stringify(settings));
  } catch (e) {}
}

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
      if (settings.structureRoleBonus !== undefined && document.getElementById('structure-role-bonus')) document.getElementById('structure-role-bonus').value = settings.structureRoleBonus;
      if (settings.contractTax !== undefined && document.getElementById('contract-tax')) document.getElementById('contract-tax').value = settings.contractTax;
      if (settings.contractBroker !== undefined && document.getElementById('contract-broker')) document.getElementById('contract-broker').value = settings.contractBroker;
    }
  } catch (e) {}
}

function searchItems(query) {
  const q = query.toLowerCase().trim();
  if (!q) return [];
  const exact = [], starts = [], contains = [];
  for (const [k, v] of Object.entries(IDX)) {
    if (k === q) exact.push(v);
    else if (k.startsWith(q)) starts.push(v);
    else if (k.includes(q)) contains.push(v);
  }
  return [...exact, ...starts, ...contains].slice(0, 15);
}

// Full search solar systems locally
function searchSolarSystemsLocally(query) {
  const q = query.toLowerCase().trim();
  if (!q) return [];
  const exact = [], starts = [], contains = [];
  for (const [k, v] of Object.entries(SYSTEM_IDX)) {
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
          SYSTEM_IDX[sys.name.toLowerCase()] = item;
          systemNameCache[sys.id] = item.name;
          results.push(item);
        });
      }
    }
    return results;
  } catch (err) {
    return [];
  }
}

// Live Dynamic Search across ALL 35,000+ EVE Online Items
async function fetchEsiSearchResults(query) {
  try {
    if (!query || query.trim().length < 2) return [];
    const res = await fetch(`https://esi.evetech.net/latest/search/?categories=inventory_type&search=${encodeURIComponent(query.trim())}&datasource=tranquility&strict=false`);
    if (!res.ok) return [];
    const data = await res.json();
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
      IDX[item.name.toLowerCase()] = obj;
      results.push(obj);
    });
    return results;
  } catch (err) {
    return [];
  }
}

// Item Autocomplete Setup
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
      searchResults.innerHTML = hits.map(item => `
        <div class="px-3 py-2 hover:bg-[#1e3348] cursor-pointer flex items-center space-x-3 text-xs border-b border-[#1e3348]/40"
             onclick="selectItem(${item.id}, '${window.esc(item.name)}')">
          <img src="https://images.evetech.net/types/${item.id}/icon?size=32" class="w-6 h-6 rounded" onerror="this.onerror=null; this.src='https://images.evetech.net/types/${item.id}/render?size=32';">
          <span class="font-semibold text-slate-200">${window.esc(item.name)}</span>
        </div>
      `).join('');
      searchResults.classList.remove('hidden');
    }
  });
}

document.addEventListener('click', (e) => {
  if (searchInput && searchResults && !searchInput.contains(e.target) && !searchResults.contains(e.target)) {
    searchResults.classList.add('hidden');
  }
});

// System Autocomplete Setup
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
        <div class="px-3 py-1.5 hover:bg-[#1e3348] cursor-pointer text-xs font-bold text-cyan-300 border-b border-[#1e3348]/40 mono"
             onclick="selectSolarSystem(${sys.id}, '${window.esc(sys.name)}')">
          ${window.esc(sys.name)}
        </div>
      `).join('');
      systemSearchResults.classList.remove('hidden');
    }
  });

  systemSearchInput.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      const q = systemSearchInput.value.trim();
      if (q) {
        await resolveSystemSCI(q);
      }
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
  currentProduct = { id: typeId, name };
  
  if (!preserveView) {
    selectedInstanceId = null;
    isolatedInstanceId = null;
    // Revert selling strategy, custom price, and global runs securely in memory
    window.rootSellStrategy = 'market-sell';
    window.rootCustomPrice = 0;
    window.globalRuns = 1;
    const globalInput = document.getElementById('bp-runs');
    if (globalInput) globalInput.value = 1;

    // Reset build overrides on fresh select
    buildSelfOverrides = {};
    customBuyModes = {};
    customMEOverrides = {};
    customTEOverrides = {};
    window.buildSelfOverrides = buildSelfOverrides;
    window.customBuyModes = customBuyModes;
    window.customMEOverrides = customMEOverrides;
    window.customTEOverrides = customTEOverrides;
  }

  const maxDepth = 10;
  recipeTreeRoot = await buildRecursiveRecipeTree(typeId, name, 1, 0, maxDepth, new Set(), null);

  recalculate();
  
  if (!preserveView) {
    resetPanZoom();
  } else {
    setTimeout(drawConnectingLines, 50);
  }

  const statusText = document.getElementById('status-text');
  const statusDot = document.getElementById('status-dot');
  if (statusText) statusText.textContent = 'TREE READY | UPDATING MARKET PRICES...';
  if (statusDot) statusDot.className = 'w-2.5 h-2.5 rounded-full bg-amber-400';

  const allTypeIds = new Set();
  collectAllTypeIds(recipeTreeRoot, allTypeIds);

  fetchMarketPrices(Array.from(allTypeIds)).finally(() => {
    if (statusDot) statusDot.className = 'w-2.5 h-2.5 rounded-full bg-green-400';
    if (statusText) statusText.textContent = 'RECIPES & PRICES LOADED';
    recalculate();
  });
}

// Global Pooled Demand Collector (Aggregates required quantities across all tree branches)
function collectGlobalDemand(node, demandMap = {}) {
  if (!node) return demandMap;

  const typeId = node.displayTypeId || node.typeId;
  if (!demandMap[typeId]) {
    demandMap[typeId] = {
      typeId: typeId,
      name: node.name,
      totalQtyNeeded: 0,
      isBuildingSelf: node.isBuildingSelf,
      batchYield: node.batchYield || 1,
      nodes: []
    };
  }

  demandMap[typeId].totalQtyNeeded += node.qtyNeeded;
  demandMap[typeId].nodes.push(node);

  if (node.isBuildingSelf && node.children) {
    node.children.forEach(child => {
      if (child) collectGlobalDemand(child, demandMap); // defensive guard
    });
  }

  return demandMap;
}

// Write the active settings and root state to localStorage for seamless Ledger transitions
function saveActiveState() {
  try {
    localStorage.setItem('eve_active_product', JSON.stringify(currentProduct));
    localStorage.setItem('eve_build_self_overrides', JSON.stringify(buildSelfOverrides));
    localStorage.setItem('eve_custom_buy_modes', JSON.stringify(customBuyModes));
    localStorage.setItem('eve_custom_me_overrides', JSON.stringify(customMEOverrides));
    localStorage.setItem('eve_custom_te_overrides', JSON.stringify(customTEOverrides));
    localStorage.setItem('eve_global_runs', window.globalRuns);
    localStorage.setItem('eve_root_sell_strategy', window.rootSellStrategy);
    localStorage.setItem('eve_root_custom_price', window.rootCustomPrice);
  } catch (e) {}
}

// Load settings defensively on window load
function loadSavedState() {
  try {
    window.buildSelfOverrides = window.safeParseJSON(localStorage.getItem('eve_build_self_overrides'), {});
    window.customBuyModes = window.safeParseJSON(localStorage.getItem('eve_custom_buy_modes'), {});
    window.customMEOverrides = window.safeParseJSON(localStorage.getItem('eve_custom_me_overrides'), {});
    window.customTEOverrides = window.safeParseJSON(localStorage.getItem('eve_custom_te_overrides'), {});
    window.globalRuns = parseInt(localStorage.getItem('eve_global_runs')) || 1;
    window.rootSellStrategy = localStorage.getItem('eve_root_sell_strategy') || 'market-sell';
    window.rootCustomPrice = parseFloat(localStorage.getItem('eve_root_custom_price')) || 0;
    
    // Sync window objects
    window.buildSelfOverrides = buildSelfOverrides;
    window.customBuyModes = customBuyModes;
    window.customMEOverrides = customMEOverrides;
    window.customTEOverrides = customTEOverrides;

    const savedProduct = window.safeParseJSON(localStorage.getItem('eve_active_product'), null);
    if (savedProduct && savedProduct.id && savedProduct.name) {
      selectItem(savedProduct.id, savedProduct.name, true);
    } else {
      selectItem(48519, 'Drekavac'); // default fallback
    }
  } catch (e) {
    selectItem(48519, 'Drekavac'); // default fallback
  }
}

function recalculate() {
  if (!recipeTreeRoot) return;

  const activeEl = document.activeElement;
  const activeId = activeEl ? activeEl.id : null;

  // Sync the typed card overrides before executing recalculations
  syncTreeOverrides(recipeTreeRoot);

  // Read directly from in-memory global runs count
  const inputVal = Math.max(1, window.globalRuns || 1);

  const salesTax = (parseFloat(document.getElementById('sales-tax')?.value) || 3.6) / 100;
  const brokerFee = (parseFloat(document.getElementById('broker-fee')?.value) || 1.0) / 100;
  const facilityTax = (parseFloat(document.getElementById('facility-tax')?.value) || 1.0) / 100;
  const sccSurcharge = (parseFloat(document.getElementById('scc-surcharge')?.value) || 4.0) / 100;
  const structureRoleBonus = parseFloat(document.getElementById('structure-role-bonus')?.value) || 0.03;

  // Retrieve global contract configurations
  const contractTaxPercent = parseFloat(document.getElementById('contract-tax')?.value) || 0.5;
  const contractBrokerPercent = parseFloat(document.getElementById('contract-broker')?.value) || 0.5;

  const contractTaxRate = contractTaxPercent / 100;
  const contractBrokerRate = contractBrokerPercent / 100;

  const facility = document.getElementById('facility-select')?.value || '0.01';
  const priceStrategy = document.getElementById('input-price-mode')?.value || 'sell';

  const rootYield = recipeTreeRoot.batchYield || 1;
  
  // Enforce mathematically strict runsMode by default
  const rootRunsNeeded = inputVal;
  const totalRootOutputQty = rootYield * inputVal;

  recipeTreeRoot.qtyNeeded = totalRootOutputQty;
  recipeTreeRoot.runsNeeded = rootRunsNeeded;

  scaleTreeQuantities(recipeTreeRoot, facility);
  calculateNodeEIV(recipeTreeRoot);

  // 1. Collect global pooled demand across all branches
  const globalDemand = collectGlobalDemand(recipeTreeRoot);
  let totalSurplusMaterialValue = 0;

  // 2. Calculate surplus re-sale credit for batch leftovers across all manufacturing & reaction steps
  Object.values(globalDemand).forEach(item => {
    if (item.isBuildingSelf && item.batchYield > 1) {
      const runs = Math.ceil(item.totalQtyNeeded / item.batchYield);
      const totalProduced = runs * item.batchYield;
      const netSurplusQty = totalProduced - item.totalQtyNeeded;

      if (netSurplusQty > 0) {
        const prices = priceCache[item.typeId] || { sell: 0, buy: 0 };
        const unitPrice = prices.sell || prices.buy || getEIV(item.typeId) || 0;
        totalSurplusMaterialValue += netSurplusQty * unitPrice;
      }
    }
  });

  let rawMaterialCost = 0;
  if (recipeTreeRoot.isBuildingSelf && recipeTreeRoot.children && recipeTreeRoot.children.length > 0) {
    recipeTreeRoot.children.forEach(child => {
      rawMaterialCost += calculateTreeNodeCost(child);
    });
  } else {
    const rootStrategy = getNodePriceStrategy(recipeTreeRoot);
    const prices = priceCache[recipeTreeRoot.typeId] || { sell: 0, buy: 0 };
    let unitPrice = rootStrategy === 'sell' ? prices.sell : prices.buy;
    if (rootStrategy === 'buy') {
      unitPrice = unitPrice * (1 + brokerFee);
    }
    
    const deductModeInput = document.getElementById('deduct-stock-mode');
    const isStockDeductEnabled = deductModeInput ? deductModeInput.value === 'true' : true;
    const stockQty = isStockDeductEnabled ? (userStockMap[recipeTreeRoot.typeId] || userStockMap[recipeTreeRoot.displayTypeId] || 0) : 0;
    const netRootQty = Math.max(0, totalRootOutputQty - stockQty);

    rawMaterialCost = unitPrice * netRootQty;
  }

  let effectiveMaterialCost = rawMaterialCost;
  let totalJobFees = calculateNodeJobFee(recipeTreeRoot, facilityTax, sccSurcharge, structureRoleBonus);
  let totalProductionCost = effectiveMaterialCost + totalJobFees;

  const outputPrices = priceCache[recipeTreeRoot.typeId] || { sell: 0, buy: 0 };
  const selectedStrategy = window.rootSellStrategy || 'market-sell';

  let unitSellPrice = 0;
  let isContractMode = selectedStrategy === 'custom-contract';

  if (selectedStrategy === 'market-sell') {
    unitSellPrice = outputPrices.sell;
  } else if (selectedStrategy === 'custom-market-sell') {
    unitSellPrice = window.rootCustomPrice || 0;
  } else if (selectedStrategy === 'custom-contract') {
    unitSellPrice = window.rootCustomPrice || 0;
  }

  const grossSellRevenue = unitSellPrice * totalRootOutputQty;
  const grossBuyRevenue = outputPrices.buy * totalRootOutputQty; // fallback reference

  recipeTreeRoot.calculatedCost = totalProductionCost;
  recipeTreeRoot.outputMarketValue = grossSellRevenue;

  // Compute final net revenue based on chosen channel strategy
  let netSellRevenue = grossSellRevenue;
  let netBuyRevenue = grossBuyRevenue * (1 - salesTax); // standard buy fallback (accounting for sales tax)

  if (isContractMode) {
    // Contract Sale: Broker fee (% + 10k flat) and Sales Tax
    const cSalesTax = grossSellRevenue * contractTaxRate;
    const cBrokerFee = (grossSellRevenue * contractBrokerRate) + 10000;

    netSellRevenue = grossSellRevenue - cSalesTax - cBrokerFee;
    
    // Save to root node for calculations
    recipeTreeRoot.contractSalesTax = cSalesTax;
    recipeTreeRoot.contractBrokerFee = cBrokerFee;
  } else {
    // Market Sell: standard sales tax and broker fee
    netSellRevenue = grossSellRevenue * (1 - salesTax - brokerFee);
  }

  // Net Profit formula includes Surplus Re-sale Credit
  const profitSell = netSellRevenue + totalSurplusMaterialValue - totalProductionCost;
  const profitBuy = netBuyRevenue + totalSurplusMaterialValue - totalProductionCost;
  
  // Attach final aligned profit and revenue calculations to root node structure
  recipeTreeRoot.netProfitSell = profitSell;
  recipeTreeRoot.netProfitBuy = profitBuy;

  const roiSell = totalProductionCost > 0 ? ((profitSell / totalProductionCost) * 100).toFixed(1) : 0;
  const roiBuy = totalProductionCost > 0 ? ((profitBuy / totalProductionCost) * 100).toFixed(1) : 0;

  const summaryCostEl = document.getElementById('summary-build-cost');
  if (summaryCostEl) summaryCostEl.textContent = Math.round(totalProductionCost).toLocaleString() + ' ISK';

  const summarySubtextEl = document.getElementById('summary-runs-subtext');
  if (summarySubtextEl) summarySubtextEl.textContent = `Mat: ${Math.round(effectiveMaterialCost).toLocaleString()} + Fee: ${Math.round(totalJobFees).toLocaleString()}`;

  const summarySurplusEl = document.getElementById('summary-surplus-credit');
  if (summarySurplusEl) summarySurplusEl.textContent = Math.round(totalSurplusMaterialValue).toLocaleString() + ' ISK';

  const summaryOutSellEl = document.getElementById('summary-output-sell');
  if (summaryOutSellEl) {
    summaryOutSellEl.textContent = Math.round(netSellRevenue).toLocaleString() + ' ISK';
  }

  const summaryOutBuyEl = document.getElementById('summary-output-buy');
  if (summaryOutBuyEl) {
    if (isContractMode) {
      summaryOutBuyEl.textContent = 'Net Contract: ' + Math.round(netSellRevenue).toLocaleString() + ' ISK';
    } else {
      summaryOutBuyEl.textContent = `Instant Buy: ${Math.round(netBuyRevenue).toLocaleString()} ISK`;
    }
  }

  const pSellEl = document.getElementById('summary-profit-sell');
  if (pSellEl) {
    pSellEl.textContent = Math.round(profitSell).toLocaleString() + ' ISK';
    pSellEl.className = `text-sm font-bold mt-0.5 mono ${profitSell >= 0 ? 'text-green-400' : 'text-red-500'}`;
  }

  const pSellLabelEl = document.getElementById('summary-profit-sell-label');
  if (pSellLabelEl) {
    pSellLabelEl.textContent = isContractMode ? 'Net Profit (Contract Output)' : 'Net Profit (Sell Output)';
  }

  const roiSellEl = document.getElementById('summary-roi-sell');
  if (roiSellEl) {
    const finalRoi = totalProductionCost > 0 ? ((profitSell / totalProductionCost) * 100).toFixed(1) : 0;
    
    let label = 'ROI';
    if (selectedStrategy === 'custom-contract') label = 'Contract ROI';
    else label = 'Sell ROI';

    roiSellEl.textContent = `${label}: ${finalRoi}%`;
  }

  const pBuyEl = document.getElementById('summary-profit-buy');
  if (pBuyEl) {
    pBuyEl.textContent = Math.round(profitBuy).toLocaleString() + ' ISK';
    pBuyEl.className = `text-sm font-bold mt-0.5 mono ${profitBuy >= 0 ? 'text-green-400' : 'text-red-500'}`;
  }

  const roiBuyEl = document.getElementById('summary-roi-buy');
  if (roiBuyEl) roiBuyEl.textContent = `ROI: ${roiBuy}%`;

  const curStrategy = window.rootSellStrategy || 'market-sell';

  if (isolatedInstanceId) {
    const isoNode = findNodeByInstanceId(recipeTreeRoot, isolatedInstanceId);
    if (isoNode) {
      renderIsolatedDiagram();
    } else {
      isolatedInstanceId = null;
      renderTreeDiagram(recipeTreeRoot, priceStrategy, profitSell, roiSell);
    }
  } else {
    renderTreeDiagram(recipeTreeRoot, priceStrategy, profitSell, roiSell);
  }
  
  renderBillOfMaterials(recipeTreeRoot, brokerFee);
  setTimeout(drawConnectingLines, 50);

  // Synchronize raw inventory and active parameters to LocalStorage
  saveActiveState();

  try {
    localStorage.setItem('eve_raw_assets', JSON.stringify(window.rawAssetItems || []));
    localStorage.setItem('eve_resolved_location_names', JSON.stringify(window.resolvedLocationNames || {}));
    localStorage.setItem('eve_corp_division_names', JSON.stringify(window.corpDivisionNames || {}));
    localStorage.setItem('eve_user_stock_map', JSON.stringify(window.userStockMap || {}));
  } catch (err) {}

  // Restore active input focus and cursor position dynamically (prevent cursor jump)
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
    if (!node) return; // Defensive guard
    if (!levels[node.depth]) levels[node.depth] = [];
    levels[node.depth].push(node);
    if (node.children) {
      node.children.forEach(child => {
        if (child) traverse(child); // Defensive guard
      });
    }
  }
  traverse(rootNode);

  levels.reverse().forEach((nodesAtDepth) => {
    const colDiv = document.createElement('div');
    colDiv.className = 'flex flex-col space-y-6 justify-center';

    nodesAtDepth.forEach(node => {
      if (node) { // Defensive guard
        const card = createNodeCard(node);
        colDiv.appendChild(card);
      }
    });

    container.appendChild(colDiv);
  });

  applyNodeHighlightClasses();
}

function createNodeCard(node) {
  const prices = priceCache[node.typeId] || { sell: 0, buy: 0 };
  const isRoot = node.depth === 0;
  const isIsolated = node.instanceId === isolatedInstanceId;

  const deductModeInput = document.getElementById('deduct-stock-mode');
  const isStockDeductEnabled = deductModeInput ? deductModeInput.value === 'true' : true;
  const stockQty = isStockDeductEnabled ? (userStockMap[node.typeId] || userStockMap[node.displayTypeId] || 0) : 0;

  const card = document.createElement('div');
  card.id = `node-card-${node.instanceId}`;
  card.setAttribute('data-instance-id', node.instanceId);
  card.onclick = (e) => onNodeClick(e, node.instanceId);

  let cardStyle = 'bg-[#0c1318] border border-[#1e3348] w-64';
  if (isRoot) {
    cardStyle = 'bg-[#0d1922] border-2 border-cyan-500 w-80';
  } else if (!node.isBuildingSelf) {
    cardStyle = 'bg-[#0a1017] border border-slate-700/80 w-64';
  } else if (node.isReaction) {
    cardStyle = 'bg-[#0f1424] border border-purple-600/80 w-64';
  } else if (node.batchYield > 1) {
    cardStyle = 'bg-[#18150d] border border-amber-600/80 w-64';
  }

  const totalProduced = node.runsNeeded * node.batchYield;
  const surplus = totalProduced - node.qtyNeeded;

  const iconTypeId = node.displayTypeId || node.typeId;

  const unitEIV = node.unitEIV || 0;
  const totalEIV = node.jobEIV || (unitEIV * node.qtyNeeded);

  const formattedUnitEIV = Math.round(unitEIV).toLocaleString() + ' ISK';
  const formattedTotalEIV = Math.round(totalEIV).toLocaleString() + ' ISK';

  const savingsPct = prices.sell > 0 && prices.buy > 0 && prices.sell > prices.buy 
    ? (((prices.sell - prices.buy) / prices.sell) * 100).toFixed(1) 
    : null;

  const currentBuyStrategy = getNodePriceStrategy(node);

  let sellStrategyUI = '';
  if (isRoot) {
    const curStrategy = window.rootSellStrategy || 'market-sell';
    const curCustomPrice = window.rootCustomPrice || '';

    const isCustomPriceNeeded = curStrategy === 'custom-market-sell' || curStrategy === 'custom-contract';

    sellStrategyUI = `
      <div class="mb-2 p-1.5 bg-[#070b0f] rounded border border-purple-500/40 space-y-1.5" onclick="event.stopPropagation()">
        <div class="flex justify-between items-center text-[10px] mono">
          <span class="text-purple-300 font-bold">Sell Channel:</span>
          <select id="card-sell-strategy" onchange="syncSellStrategy(event)" class="bg-[#0c1318] text-white rounded p-0.5 border border-[#1e3348] text-[10px] outline-none">
            <option value="market-sell" ${curStrategy === 'market-sell' ? 'selected' : ''}>Auto</option>
            <option value="custom-market-sell" ${curStrategy === 'custom-market-sell' ? 'selected' : ''}>Custom Market Sell</option>
            <option value="custom-contract" ${curStrategy === 'custom-contract' ? 'selected' : ''}>Custom Contract</option>
          </select>
        </div>
        
        ${isCustomPriceNeeded ? `
          <div class="flex flex-col text-[10px] mono">
            <div class="flex justify-between items-center">
              <span class="text-purple-300 font-bold">Custom Sell Price:</span>
              <div class="flex items-center space-x-1">
                <input type="number" id="card-custom-price" value="${curCustomPrice}" placeholder="Unit Price"
                  oninput="syncCustomPrice(event)"
                  class="w-24 bg-[#0c1318] border border-[#1e3348] text-center text-green-400 font-bold rounded p-0.5 outline-none text-[10px]">
                <span class="text-slate-500 text-[9px]">ISK</span>
              </div>
            </div>
            <div class="text-[9px] text-green-400 text-right font-bold mt-1">
              ${Math.round(window.rootCustomPrice || 0).toLocaleString()} ISK
            </div>
          </div>
        ` : ''}
        
        <!-- Add to Ledger (Job Queue) Trigger -->
        <button onclick="addCurrentJobToLedger(event)" class="w-full mt-2 py-1.5 bg-purple-800 hover:bg-purple-700 text-purple-100 font-bold rounded transition text-[11px] mono flex items-center justify-center gap-1 border border-purple-500/30 shadow-md" title="Add this build job with its compiled materials to your manufacturing queue">
          ➕ ADD TO JOB QUEUE
        </button>
      </div>
    `;
  }

  // Calculate Est. Build Time defensively (Accounting for ESI skills, Sotiyo rigs, custom TE overrides)
  let buildTimeUI = '';
  if (node.isBuildingSelf && node.recipe) {
    const baseTime = extractBuildTime(node.recipe, node.typeId, node.name);
    if (baseTime > 0) {
      // Default to Max Level 5 fallback if guest/not logged in, otherwise load character sheets
      const skills = window.safeParseJSON(localStorage.getItem('eve_char_skills'), { industry: 5, advIndustry: 5 });
      const indFactor = 1 - (0.04 * (skills.industry || 0));
      const advIndFactor = 1 - (0.03 * (skills.advIndustry || 0));
      const skillTimeFactor = indFactor * advIndFactor;

      const te = node.customTE || 0;
      const teFactor = 1 - (te / 100);

      // Resolve specific Upwell Engineering Complex Time bonuses (Sotiyo: 30%, Azbel: 20%, Raitaru: 15%, NPC: 0%)
      const activeFacilityKey = localStorage.getItem('eve_active_facility_key') || 'sotiyo';
      let facilityFactor = 1.0;
      let structureName = 'NPC Station';
      let structureTEBonus = '0%';
      if (activeFacilityKey === 'sotiyo') { facilityFactor = 0.70; structureName = 'Sotiyo'; structureTEBonus = '30%'; }
      else if (activeFacilityKey === 'azbel') { facilityFactor = 0.80; structureName = 'Azbel'; structureTEBonus = '20%'; }
      else if (activeFacilityKey === 'raitaru') { facilityFactor = 0.85; structureName = 'Raitaru'; structureTEBonus = '15%'; }

      const totalSeconds = baseTime * teFactor * skillTimeFactor * facilityFactor * node.runsNeeded;

      // Provide dynamic browser tooltips on hovering to clearly show skill allocations
      const hoverTitle = `Skill Reductions Applied:\n• Industry Level: ${skills.industry}/5\n• Advanced Industry Level: ${skills.advIndustry}/5\n• Structure Bonus: ${structureName} (${structureTEBonus} TE reduction)\n• Base SDE Time: ${window.formatDuration(baseTime)}`;

      buildTimeUI = `
        <div class="flex justify-between text-[10px] text-slate-400 mono border-t border-[#1e3348]/40 pt-1 mt-1 cursor-help" title="${window.esc(hoverTitle)}">
          <span>Est. Build