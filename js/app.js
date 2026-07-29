'use strict';

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

// Autocomplete Setup
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

    const safeQ = window.esc ? window.esc(q) : q;

    if (!hits.length) {
      if (searchResults) {
        searchResults.innerHTML = `<div class="p-3 text-slate-400 text-xs italic">No matching items found for "${safeQ}"</div>`;
        searchResults.classList.remove('hidden');
      }
      return;
    }

    if (searchResults) {
      searchResults.innerHTML = hits.map(item => {
        const safeName = window.esc ? window.esc(item.name) : item.name;
        return `
          <div class="px-3 py-2 hover:bg-[#1e3348] cursor-pointer flex items-center space-x-3 text-xs border-b border-[#1e3348]/40"
               onclick="selectItem(${item.id}, '${safeName}')">
            <img src="https://images.evetech.net/types/${item.id}/icon?size=32" class="w-6 h-6 rounded" onerror="this.onerror=null; this.src='https://images.evetech.net/types/${item.id}/render?size=32';">
            <span class="font-semibold text-slate-200">${safeName}</span>
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

async function selectItem(typeId, name, preserveView = false) {
  if (searchInput) searchInput.value = name;
  if (searchResults) searchResults.classList.add('hidden');
  currentProduct = { id: typeId, name };
  
  if (!preserveView) {
    selectedInstanceId = null;
    isolatedInstanceId = null;
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
  if (statusText) statusText.textContent = 'TREE READY | UPDATING JITA PRICES...';
  if (statusDot) statusDot.className = 'w-2 h-2 rounded-full bg-amber-400';

  const allTypeIds = new Set();
  collectAllTypeIds(recipeTreeRoot, allTypeIds);

  fetchMarketPrices(Array.from(allTypeIds)).finally(() => {
    if (statusDot) statusDot.className = 'w-2 h-2 rounded-full bg-green-400';
    if (statusText) statusText.textContent = 'RECIPES & PRICES LOADED';
    recalculate();
  });
}

function recalculate() {
  if (!recipeTreeRoot) return;

  const runModeInput = document.getElementById('run-mode');
  const isRunsMode = runModeInput ? runModeInput.value === 'runs' : false;

  const bpRunsInput = document.getElementById('bp-runs');
  const inputVal = Math.max(1, parseInt(bpRunsInput ? bpRunsInput.value : 1) || 1);

  const salesTax = (parseFloat(document.getElementById('sales-tax')?.value) || 3.6) / 100;
  const brokerFee = (parseFloat(document.getElementById('broker-fee')?.value) || 1.0) / 100;
  const facilityTax = (parseFloat(document.getElementById('facility-tax')?.value) || 1.0) / 100;
  const sccSurcharge = (parseFloat(document.getElementById('scc-surcharge')?.value) || 4.0) / 100;
  const structureRoleBonus = parseFloat(document.getElementById('structure-role-bonus')?.value) || 0.03;

  const facility = document.getElementById('facility-select')?.value || '0.01';
  const priceStrategy = document.getElementById('input-price-mode')?.value || 'sell';

  const rootYield = recipeTreeRoot.batchYield || 1;
  
  let totalRootOutputQty = 1;
  let rootRunsNeeded = 1;

  if (isRunsMode) {
    rootRunsNeeded = inputVal;
    totalRootOutputQty = rootYield * inputVal;
  } else {
    totalRootOutputQty = inputVal;
    rootRunsNeeded = Math.ceil(inputVal / rootYield);
  }

  recipeTreeRoot.qtyNeeded = totalRootOutputQty;
  recipeTreeRoot.runsNeeded = rootRunsNeeded;

  scaleTreeQuantities(recipeTreeRoot, facility);
  calculateNodeEIV(recipeTreeRoot);

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
  const grossSellRevenue = outputPrices.sell * totalRootOutputQty;
  cons