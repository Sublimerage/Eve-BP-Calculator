'use strict';

if (window.rootSellStrategy === undefined) window.rootSellStrategy = 'market-sell';
if (window.rootCustomPrice === undefined) window.rootCustomPrice = 0;
if (window.globalRuns === undefined) window.globalRuns = 1;

// Queries unreduced SDE manufacturing durations directly from the SDE database
function extractBuildTime(recipe) {
  if (!recipe) return 0;
  return parseInt(recipe.time || recipe.t || recipe.timeSeconds || recipe.duration || recipe.mfgTime || recipe.productionTime || 0);
}

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
  for (const [k, v] of Object.entries(window.IDX || {})) {
    const isBlueprint = k.includes('blueprint') || k.includes('formula') || k.includes('reaction');
    if (!isBlueprint) continue;

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
      window.IDX[item.name.toLowerCase()] = obj;
      results.push(obj);
    });
    return results;
  } catch (err) { return []; }
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
  const maxDepth = 10;
  window.recipeTreeRoot = await window.buildRecursiveRecipeTree(typeId, name, 1, 0, maxDepth, new Set(), null);
  recalculate();
  if (!preserveView) { resetPanZoom(); } else { setTimeout(drawConnectingLines, 50); }

  const statusText = document.getElementById('status-text');
  const statusDot = document.getElementById('status-dot');
  if (statusText) statusText.textContent = 'TREE READY | UPDATING MARKET PRICES...';
  if (statusDot) statusDot.className = 'w-2.5 h-2.5 rounded-full bg-amber-400';

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
    demandMap[typeId] = { typeId, name: node.name, totalQtyNeeded: 0, isBuildingSelf: node.isBuildingSelf, batchYield: node.batchYield || 1, nodes: [] };
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
  const structureRoleBonus = parseFloat(document.getElementById('structure-role-bonus')?.value) || 0.03;

  const contractTaxPercent = parseFloat(document.getElementById('contract-tax')?.value) || 0.5;
  const contractBrokerPercent = parseFloat(document.getElementById('contract-broker')?.value) || 0.5;
  const contractTaxRate = contractTaxPercent / 100;
  const contractBrokerRate = contractBrokerPercent / 100;

  const facility = document.getElementById('facility-select')?.value || '0.01';
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

  let cardStyle = 'bg-[#0c1318] border border-[#1e3348] w-64';
  if (isRoot) cardStyle = 'bg-[#0d1922] border-2 border-cyan-500 w-80';
  else if (!node.isBuildingSelf) cardStyle = 'bg-[#0a1017] border border-slate-700/80 w-64';
  else if (node.isReaction) cardStyle = 'bg-[#0f1424] border border-purple-600/80 w-64';
  else if (node.batchYield > 1) cardStyle = 'bg-[#18150d] border border-amber-600/80 w-64';

  const totalProduced = node.runsNeeded * node.batchYield;
  const surplus = totalProduced - node.qtyNeeded;
  
  const iconUrl = node.isManufacturable
    ? `https://images.evetech.net/blueprints/${node.typeId}/blueprint?size=128`
    : `https://images.evetech.net/types/${node.typeId}/icon?size=128`;

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
                <input type="number" id="card-custom-price" value="${curCustomPrice}" placeholder="Unit Price" oninput="syncCustomPrice(event)" class="w-24 bg-[#0c1318] border border-[#1e3348] text-center text-green-400 font-bold rounded p-0.5 outline-none text-[10px]">
                <span class="text-slate-500 text-[9px]">ISK</span>
              </div>
            </div>
            <div class="text-[9px] text-green-400 text-right font-bold mt-1">${Math.round(window.rootCustomPrice || 0).toLocaleString()} ISK</div>
          </div>
        ` : ''}
        <button onclick="addCurrentJobToLedger(event)" class="w-full mt-2 py-1.5 bg-purple-800 hover:bg-purple-700 text-purple-100 font-bold rounded transition text-[11px] mono flex items-center justify-center gap-1 border border-purple-500/30 shadow-md">➕ ADD TO JOB QUEUE</button>
      </div>
    `;
  }

  let buildTimeUI = '';
  if (node.isBuildingSelf && node.recipe) {
    const baseTime = extractBuildTime(node.recipe, node.typeId, node.name);
    if (baseTime > 0) {
      const skills = window.safeParseJSON(localStorage.getItem('eve_char_skills'), { industry: 5, advIndustry: 5 });
      const indFactor = 1 - (0.04 * (skills.industry || 0));
      const advIndFactor = 1 - (0.03 * (skills.advIndustry || 0));
      const skillTimeFactor = indFactor * advIndFactor;
      const te = node.customTE || 0;
      const teFactor = 1 - (te / 100);

      const activeFacilityKey = localStorage.getItem('eve_active_facility_key') || 'sotiyo';
      let facilityFactor = 1.0;
      let structureName = 'NPC Station';
      let structureTEBonus = '0%';
      if (activeFacilityKey === 'sotiyo') { facilityFactor = 0.70; structureName = 'Sotiyo'; structureTEBonus = '30%'; }
      else if (activeFacilityKey === 'azbel') { facilityFactor = 0.80; structureName = 'Azbel'; structureTEBonus = '20%'; }
      else if (activeFacilityKey === 'raitaru') { facilityFactor = 0.85; structureName = 'Raitaru'; structureTEBonus = '15%'; }

      const totalSeconds = baseTime * teFactor * skillTimeFactor * facilityFactor * node.runsNeeded;
      const hoverTitle = `Skill Reductions Applied:\n• Industry Level: ${skills.industry}/5\n• Advanced Industry Level: ${skills.advIndustry}/5\n• Structure Bonus: ${structureName} (${structureTEBonus} TE reduction)\n• Base SDE Time: ${window.formatDuration(baseTime)}`;

      buildTimeUI = `
        <div class="flex justify-between text-[10px] text-slate-400 mono border-t border-[#1e3348]/40 pt-1 mt-1 cursor-help" title="${window.esc(hoverTitle)}">
          <span>Est. Build Time:</span>
          <span class="text-slate-300 font-semibold">${window.formatDuration(totalSeconds)}</span>
        </div>
      `;
    }
  }

  card.className = `diagram-node rounded p-3 shadow-2xl transition-all ${cardStyle}`;
  card.innerHTML = `
    <div class="flex items-center space-x-3 border-b border-[#1e3348] pb-2 mb-2">
      <img src="${iconUrl}" class="w-10 h-10 rounded border border-slate-700 bg-[#070b0f] flex-shrink-0" onerror="this.onerror=null; this.src='https://images.evetech.net/types/${productTypeId}/icon?size=64';">
      <div class="min-w-0 flex-1">
        <div class="font-bold text-sm text-white truncate flex items-center justify-between">
          <span class="truncate">${node.name}</span>
          <div class="flex items-center space-x-1 flex-shrink-0 ml-1">
            ${isRoot ? `
              <div class="relative group inline-block" onclick="event.stopPropagation()">
                <span class="bg-amber-900/80 hover:bg-amber-700 text-amber-300 text-[9px] px-1.5 py-0.5 rounded mono border border-amber-500/80 cursor-help font-bold tracking-wider" title="Unit EIV: ${formattedUnitEIV} | Total Job EIV: ${formattedTotalEIV}">EIV</span>
                <div class="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block bg-[#070b0f] border border-amber-500 text-white text-[10px] p-2 rounded shadow-2xl z-[999] whitespace-nowrap mono pointer-events-none">
                  <div class="text-amber-300 font-bold border-b border-[#1e3348] pb-1 mb-1">Estimated Item Value (EIV)</div>
                  <div class="flex justify-between space-x-4 text-slate-300"><span>Unit EIV:</span> <span class="text-cyan-300 font-bold">${formattedUnitEIV}</span></div>
                  <div class="flex justify-between space-x-4 text-slate-300"><span>Total Job EIV:</span> <span class="text-amber-400 font-bold">${formattedTotalEIV}</span></div>
                </div>
              </div>
            ` : ''}
            ${isIsolated ? `
              <button onclick="exitIsolation(event)" class="text-[9px] bg-amber-600 hover:bg-amber-500 text-black font-bold px-2 py-0.5 rounded mono transition shadow">Exit ✖</button>
            ` : `
              <button onclick="isolateComponent(event, ${node.instanceId})" class="text-[9px] bg-[#1e3348] hover:bg-cyan-600 text-cyan-200 px-1.5 py-0.5 rounded mono transition">🔍 Isolate</button>
            `}
          </div>
        </div>
        <div class="text-[11px] text-cyan-400 mono flex items-center justify-between">
          <span>${isRoot ? 'Output Qty:' : 'Req Qty:'} ${node.qtyNeeded.toLocaleString()} ${node.productName}</span>
          ${stockQty > 0 ? `<span class="bg-cyan-950 text-cyan-300 border border-cyan-500/40 text-[9px] px-1 rounded font-bold" title="In Stock in Hangar">Stock: ${stockQty.toLocaleString()}</span>` : ''}
        </div>
        ${node.isBuildingSelf && node.batchYield > 1 ? `<div class="${node.isReaction ? 'text-purple-300 font-bold' : 'text-amber-300'} text-[10px] mono font-semibold mt-0.5">(${node.runsNeeded} Run${node.runsNeeded > 1 ? 's' : ''} @ ${node.batchYield}/run ${surplus > 0 ? `→ ${surplus} Surplus` : ''})</div>` : ''}
      </div>
    </div>

    ${isRoot ? `
      <div class="mb-2 p-1.5 bg-[#070b0f] rounded border border-cyan-500/40 flex items-center justify-between text-[11px] mono" onclick="event.stopPropagation()">
        <span class="text-slate-300 font-bold">Runs:</span>
        <div class="flex items-center space-x-1">
          <input type="number" id="card-bp-runs" value="${node.runsNeeded}" min="1" max="1000000" oninput="syncCardRunsToGlobal(event)" onkeydown="if(event.key==='Enter') this.blur()" class="w-16 bg-[#0c1318] border border-cyan-500/60 text-center text-amber-300 font-bold rounded p-0.5 outline-none">
          <span class="text-slate-400 text-[10px]">Runs</span>
        </div>
      </div>
    ` : ''}
    ${sellStrategyUI}

    ${!isRoot && node.isManufacturable ? `
      <div class="mb-2 flex items-center justify-between bg-[#070b0f] p-1 rounded border border-[#1e3348]/60 text-[10px] mono">
        <span class="text-slate-400 font-semibold ml-1">Mode:</span>
        <div class="flex space-x-1" onclick="event.stopPropagation()">
          <button onclick="toggleBuildSelf(event, ${node.typeId})" class="px-2 py-0.5 rounded font-bold transition ${node.isBuildingSelf ? 'bg-green-600 text-white' : 'bg-[#1e3348] text-slate-400 hover:text-white'}">🔨 Build</button>
          <button onclick="toggleBuildSelf(event, ${node.typeId})" class="px-2 py-0.5 rounded font-bold transition ${!node.isBuildingSelf ? 'bg-amber-600 text-black' : 'bg-[#1e3348] text-slate-400 hover:text-white'}">🛒 Buy</button>
        </div>
      </div>
    ` : ''}

    ${!isRoot && (!node.isBuildingSelf || !node.children || node.children.length === 0) ? `
      <div class="mb-2 flex items-center justify-between bg-[#070b0f] p-1 rounded border border-[#1e3348]/60 text-[10px] mono">
        <span class="text-slate-400 font-semibold ml-1">Buy via:</span>
        <div class="flex space-x-1" onclick="event.stopPropagation()">
          <button onclick="setComponentBuyMode(event, ${node.typeId}, 'sell')" class="px-1.5 py-0.5 rounded font-bold transition ${currentBuyStrategy === 'sell' ? 'bg-amber-600 text-black' : 'bg-[#1e3348] text-slate-400 hover:text-white'}" title="Instant Buy off Sell Orders">⚡ Sell</button>
          <button onclick="setComponentBuyMode(event, ${node.typeId}, 'buy')" class="px-1.5 py-0.5 rounded font-bold transition ${currentBuyStrategy === 'buy' ? 'bg-cyan-600 text-white' : 'bg-[#1e3348] text-slate-400 hover:text-white'}" title="Order Placing via Buy Orders">📜 Buy</button>
        </div>
      </div>
    ` : ''}

    ${node.isBuildingSelf && node.isManufacturable && !node.isReaction ? `
      <div class="flex items-center justify-between mb-2 px-1 text-[10px] mono border-b border-[#1e3348]/40 pb-1">
        <span class="text-slate-400 font-semibold">Job ME/TE:</span>
        <div class="flex items-center space-x-1" onclick="event.stopPropagation()" onmousedown="event.stopPropagation()">
          <input type="number" id="card-me-${node.instanceId}" min="0" max="10" value="${node.customME}" oninput="onCardMEChange(event, ${node.typeId}, ${node.instanceId})" class="w-10 bg-[#070b0f] border border-[#1e3348] text-center text-cyan-400 font-bold rounded p-0.5 outline-none focus:border-cyan-500">
          <span class="text-slate-500">%</span>
          <input type="number" id="card-te-${node.instanceId}" min="0" max="20" value="${node.customTE}" oninput="onCardTEChange(event, ${node.typeId}, ${node.instanceId})" class="w-10 bg-[#070b0f] border border-[#1e3348] text-center text-cyan-400 font-bold rounded p-0.5 outline-none focus:border-cyan-500">
          <span class="text-slate-500">%</span>
        </div>
      </div>
    ` : ''}

    <div class="text-[11px] mono space-y-1">
      <div class="flex justify-between font-semibold"><span class="text-slate-400">Lowest Sell:</span><span class="text-green-400 font-bold">${prices.sell.toLocaleString()} ISK</span></div>
      <div class="flex justify-between text-slate-400"><span>Highest Buy:</span><span class="text-slate-300">${prices.buy.toLocaleString()} ISK</span></div>
      ${!isRoot && savingsPct !== null ? `<div class="flex justify-between text-green-400 font-semibold text-[10px]"><span>Order Savings:</span><span>${savingsPct}%</span></div>` : ''}
      ${node.jobFee > 0 && node.isBuildingSelf ? `<div class="flex justify-between text-[#e85555] font-semibold border-t border-[#1e3348]/40 pt-1"><span>Job Inst. Fee:</span><span>+${Math.round(node.jobFee).toLocaleString()} ISK</span></div>` : ''}
      <div class="flex justify-between font-bold border-t border-[#1e3348]/60 pt-1 mt-1"><span class="text-slate-300">${isRoot ? 'Total Production Cost:' : node.isBuildingSelf ? 'Calculated Build Cost:' : 'Market Buy Cost:'}</span><span class="text-amber-400 font-bold">${Math.round(node.calculatedCost || 0).toLocaleString()} ISK</span></div>
      ${buildTimeUI}
      ${isRoot ? `
        <div class="flex justify-between font-bold border-t border-green-500/40 pt-1 mt-1 bg-green-950/30 p-1 rounded">
          <span class="text-slate-300">${window.rootSellStrategy === 'custom-contract' ? 'Net Profit (Contract Output):' : 'Net Profit (Sell Output):'}</span>
          <span class="${(node.netProfitSell || 0) >= 0 ? 'text-green-400' : 'text-red-400'} font-bold">${Math.round(node.netProfitSell || 0).toLocaleString()} ISK</span>
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

  const materials = [];
  function extractBOM(node) {
    if (!node) return;
    if (!node.isBuildingSelf || !node.children || node.children.length === 0) {
      const typeId = node.displayTypeId || node.typeId;
      const strategy = window.getNodePriceStrategy(node);
      
      const deductModeInput = document.getElementById('deduct-stock-mode');
      const isStockDeductEnabled = deductModeInput ? deductModeInput.value === 'true' : true;
      const productTypeId = node.productTypeId || node.typeId;
      const stockQty = isStockDeductEnabled ? (window.userStockMap[productTypeId] || window.userStockMap[node.typeId] || 0) : 0;
      const netQtyNeeded = Math.max(0, node.qtyNeeded - stockQty);

      const prices = window.priceCache[productTypeId] || { sell: 0, buy: 0 };
      let unitPrice = strategy === 'sell' ? prices.sell : prices.buy;
      
      materials.push({
        typeId: productTypeId,
        name: node.name.replace(' Blueprint', ''),
        qtyNeeded: node.qtyNeeded,
        stockQty: stockQty,
        netQtyNeeded: netQtyNeeded,
        strategy: strategy,
        unitPrice: unitPrice,
        lineCost: unitPrice * netQtyNeeded
      });
    } else {
      node.children.forEach(child => {
        if (child) extractBOM(child);
      });
    }
  }

  if (window.recipeTreeRoot.isBuildingSelf && window.recipeTreeRoot.children && window.recipeTreeRoot.children.length > 0) {
    window.recipeTreeRoot.children.forEach(c => {
      if (c) extractBOM(c);
    });
  } else {
    const rootTypeId = window.recipeTreeRoot.productTypeId || window.recipeTreeRoot.typeId;
    const strategy = window.getNodePriceStrategy(window.recipeTreeRoot);
    const deductModeInput = document.getElementById('deduct-stock-mode');
    const isStockDeductEnabled = deductModeInput ? deductModeInput.value === 'true' : true;
    const stockQty = isStockDeductEnabled ? (window.userStockMap[rootTypeId] || window.userStockMap[window.recipeTreeRoot.typeId] || 0) : 0;
    const netQtyNeeded = Math.max(0, window.recipeTreeRoot.qtyNeeded - stockQty);
    const prices = window.priceCache[rootTypeId] || { sell: 0, buy: 0 };
    let unitPrice = strategy === 'sell' ? prices.sell : prices.buy;

    materials.push({
      typeId: rootTypeId,
      name: window.recipeTreeRoot.productName || window.recipeTreeRoot.name.replace(' Blueprint', ''),
      qtyNeeded: window.recipeTreeRoot.qtyNeeded,
      stockQty: stockQty,
      netQtyNeeded: netQtyNeeded,
      strategy: strategy,
      unitPrice: unitPrice,
      lineCost: unitPrice * netQtyNeeded
    });
  }

  const job = {
    id: Date.now() + Math.floor(Math.random() * 1000),
    typeId: window.recipeTreeRoot.typeId,
    name: window.recipeTreeRoot.name,
    runsNeeded: window.recipeTreeRoot.runsNeeded,
    qtyNeeded: window.recipeTreeRoot.qtyNeeded,
    calculatedCost: window.recipeTreeRoot.calculatedCost || 0,
    baseTime: baseTime,
    sellStrategy: selectedStrategy,
    unitSellPrice: unitSellPrice,
    materials: materials,
    addedAt: new Date().toISOString()
  };

  queue.push(job);
  localStorage.setItem('eve_ledger_jobs', JSON.stringify(queue));
  localStorage.setItem('eve_user_stock_map', JSON.stringify(window.userStockMap || {}));

  updateHeaderLedgerCount();

  const btn = e.target.closest('button');
  if (btn) {
    const originalText = btn.innerHTML;
    btn.innerHTML = '✔ ADDED TO QUEUE';
    btn.classList.remove('bg-purple-800', 'hover:bg-purple-700', 'text-purple-100');
    btn.classList.add('bg-green-700', 'text-white');
    setTimeout(() => {
      btn.innerHTML = originalText;
      btn.classList.remove('bg-green-700', 'text-white');
      btn.classList.add('bg-purple-800', 'hover:bg-purple-700', 'text-purple-100');
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
    if (node.typeId === typeId || node.displayTypeId === typeId) return node;
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
    inputCol.innerHTML = `<div class="bg-[#0c1318] border border-[#1e3348] p-3 text-xs text-slate-400 mono rounded">${!isolatedNode.isBuildingSelf ? 'Purchased off Market (No decomposed inputs)' : 'No inputs (Base Material)'}</div>`;
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
    outputCol.innerHTML = `<div class="bg-[#0c1318] border border-amber-500/50 p-3 text-xs text-amber-300 font-bold mono rounded">Final Target Job Output</div>`;
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

  card.classList.add('ring-4', 'ring-cyan-400');
  setTimeout(() => card.classList.remove('ring-4', 'ring-cyan-400'), 800);
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
    const isolatedNode = findNodeByInstanceId(window.recipeTreeRoot, window.isolatedInstanceId);
    if (!isolatedNode) return;

    const MathEl = document.getElementById(`node-card-${isolatedNode.instanceId}`);
    if (!MathEl) return;

    const isoRect = MathEl.getBoundingClientRect();
    const isoLeftX = (isoRect.left - containerRect.left) / window.zoomScale;
    const isoRightX = (isoRect.right - containerRect.left) / window.zoomScale;
    const isoCenterY = (isoRect.top + isoRect.height / 2 - containerRect.top) / window.zoomScale;

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
        const parentEl = document.getElementById(`node-card-${parentNode.instanceId}`);
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

  function generateBOM(node) {
    if (!node) return;
    if (!node.isBuildingSelf || !node.children || node.children.length === 0) {
      const typeId = node.displayTypeId || node.typeId;
      const strategy = window.getNodePriceStrategy(node);
      
      const productTypeId = node.productTypeId || node.typeId;
      const stockQty = isStockDeductEnabled ? (window.userStockMap[productTypeId] || window.userStockMap[node.typeId] || 0) : 0;
      const netQtyNeeded = Math.max(0, node.qtyNeeded - stockQty);

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

  const bomItems = Object.values(bomMap);
  let totalBOMCost = 0;

  bomItems.forEach(item => {
    const prices = window.priceCache[item.typeId] || { sell: 0, buy: 0 };
    let unitPrice = item.strategy === 'sell' ? prices.sell : prices.buy;
    if (item.strategy === 'buy') {
      unitPrice = unitPrice * (1 + brokerFee);
    }
    item.unitPrice = unitPrice;
    item.lineCost = unitPrice * item.qty;
    totalBOMCost += item.lineCost;
  });

  bomItems.sort((a, b) => b.lineCost - a.lineCost);

  bomItems.forEach(item => {
    const row = document.createElement('div');
    row.className = 'bg-[#0c1318] border border-[#1e3348] hover:border-cyan-500 hover:bg-[#101d2a] rounded p-2 flex items-center justify-between cursor-pointer transition shadow-sm';
    row.title = 'Click to find and focus this material in the build diagram';
    row.onclick = () => highlightNodeByTypeId(item.typeId);

    row.innerHTML = `
      <div class="flex items-center space-x-2.5 min-w-0">
        <img src="https://images.evetech.net/types/${item.typeId}/icon?size=32" class="w-7 h-7 rounded border border-slate-700 bg-[#070b0f] flex-shrink-0" onerror="this.onerror=null; this.src='https://images.evetech.net/types/${item.typeId}/render?size=32';">
        <div class="min-w-0 flex-1">
          <div class="font-semibold text-slate-200 truncate flex items-center gap-1.5">
            <span class="truncate">${item.name}</span>
            <span class="text-[9px] px-1 rounded font-bold mono ${item.strategy === 'sell' ? 'bg-amber-900/60 text-amber-300' : 'bg-cyan-900/60 text-cyan-300'}">
              ${item.strategy === 'sell' ? 'SELL' : 'BUY'}
            </span>
          </div>
          <div class="text-[10px] text-slate-400 mono font-semibold">Qty: ${item.qty.toLocaleString()} &times; ${Math.round(item.unitPrice).toLocaleString()} ISK</div>
        </div>
      </div>
      <div class="text-right mono font-bold text-cyan-400 flex-shrink-0 ml-2">
        ${Math.round(item.lineCost).toLocaleString()} ISK
      </div>
    `;

    listContainer.appendChild(row);
  });

  const countEl = document.getElementById('bom-type-count');
  if (countEl) countEl.textContent = bomItems.length.toString();

  const totalEl = document.getElementById('bom-total-isk');
  if (totalEl) totalEl.textContent = Math.round(totalBOMCost).toLocaleString() + ' ISK';

  window.currentBOMText = bomItems.map(i => `${i.name} x${i.qty}`).join('\n');
}

function getNodeStrategyOnly(node) {
  if (!node) return 'sell';
  const globalStrategy = document.getElementById('input-price-mode')?.value || 'sell';
  return window.customBuyModes[node.typeId] || globalStrategy;
}

function copyMultibuyText() {
  if (!window.currentBOMText) return;
  navigator.clipboard.writeText(window.currentBOMText).then(() => {
    const btn = document.querySelector('button[onclick="copyMultibuyText()"]');
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = 'Copied!';
      btn.className = 'px-3.5 py-1.5 bg-green-600 text-white font-bold text-xs rounded mono transition';
      setTimeout(() => {
        btn.textContent = orig;
        btn.className = 'px-3.5 py-1.5 bg-cyan-600 hover:bg-cyan-500 text-white font-bold text-xs rounded mono transition shadow';
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

// Initialize Application
window.onload = async () => {
  if (typeof window.buildPrepackedIndexes === 'function') {
    window.buildPrepackedIndexes();
  }

  // Load static local states instantly so the app is interactive immediately!
  try {
    loadTaxSettings(); // Load custom taxes from localStorage!
    loadSavedState(); // Load previous product & overrides persistently from localStorage!
    updateHeaderLedgerCount(); // Update badge on load!
  } catch (err) {
    console.error("State restoration error:", err);
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