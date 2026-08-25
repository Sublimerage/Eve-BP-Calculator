// --- Invention Calculator ---
// Formula and decryptor stats confirmed against EVE University's Invention page (verified current
// as of this writing): success chance = base × (1 + (sci1+sci2)/30 + encryption/40) × (1 + decryptor
// probability modifier/100). Base T2 BPC outcome (before decryptor modifiers) is always +2% ME, +4%
// TE, and 10 runs for most items or 1 run for ships/rigs.
const DECRYPTORS = [
  { name: 'No Decryptor', probMod: 0, runsMod: 0, meMod: 0, teMod: 0 },
  { name: 'Accelerant Decryptor', probMod: 20, runsMod: 1, meMod: 2, teMod: 10 },
  { name: 'Attainment Decryptor', probMod: 80, runsMod: 4, meMod: -1, teMod: 4 },
  { name: 'Augmentation Decryptor', probMod: -40, runsMod: 9, meMod: -2, teMod: 2 },
  { name: 'Optimized Attainment Decryptor', probMod: 90, runsMod: 2, meMod: 1, teMod: -2 },
  { name: 'Optimized Augmentation Decryptor', probMod: -10, runsMod: 7, meMod: 2, teMod: 0 },
  { name: 'Parity Decryptor', probMod: 50, runsMod: 3, meMod: 1, teMod: -2 },
  { name: 'Process Decryptor', probMod: 10, runsMod: 0, meMod: 3, teMod: 6 },
  { name: 'Symmetry Decryptor', probMod: 0, runsMod: 2, meMod: 1, teMod: 8 }
];

let _inventionCurrentBlueprint = null; // the T1 blueprint recipe object
let _inventionCurrentProduct = null;   // the T2 product being searched/selected

// --- Reverse index: T2 product -> T1 source recipe ---
// Built once, lazily, from the same recipeMap data already loaded. Only items with BOTH invention
// materials and a confirmed T2 product get indexed, so anything found via this map is guaranteed to
// have complete data - no more "found it, but missing product data" dead ends.
let _inventionT2ToT1Map = null;
function getInventionT2ToT1Map() {
  if (_inventionT2ToT1Map) return _inventionT2ToT1Map;
  const map = {};
  const seenBlueprintIds = new Set();
  for (const recipe of Object.values(window.recipeMap || {})) {
    if (!recipe || seenBlueprintIds.has(recipe.blueprintTypeID)) continue;
    seenBlueprintIds.add(recipe.blueprintTypeID);
    if (recipe.inventionMaterials && recipe.inventionMaterials.length > 0 && recipe.inventionProducts && recipe.inventionProducts.length > 0) {
      recipe.inventionProducts.forEach(p => {
        if (p && p.typeId) map[p.typeId] = recipe;
      });
    }
  }
  _inventionT2ToT1Map = map;
  console.info(`[Invention] Built T2->T1 reverse index: ${Object.keys(map).length} inventable T2 products found.`);
  return map;
}

// --- Search (searches the T2 product you want, not the T1 BPC you'd use) ---
let _inventionSearchToken = 0;
let _inventionLastSearchHits = [];

function searchInventionItem(query) {
  const resultsEl = document.getElementById('invention-search-results');
  if (!resultsEl) return;
  const token = ++_inventionSearchToken;
  const q = (query || '').toLowerCase().trim();
  if (q.length < 2) {
    resultsEl.classList.add('hidden');
    return;
  }
  const t2Map = getInventionT2ToT1Map();
  const hits = [];
  for (const t2IdStr of Object.keys(t2Map)) {
    const t2Id = parseInt(t2IdStr);
    const name = (window.TYPE_ID_TO_NAME && window.TYPE_ID_TO_NAME[t2Id]) || (window.EVE_ITEMS && window.EVE_ITEMS[t2Id]);
    if (name && name.toLowerCase().includes(q)) {
      hits.push({ id: t2Id, name: name });
    }
    if (hits.length >= 15) break;
  }
  if (token !== _inventionSearchToken) return;
  _inventionLastSearchHits = hits;
  if (hits.length === 0) {
    resultsEl.innerHTML = `<div class="p-3 text-slate-400 text-xs italic">No inventable Tech II items found matching "${window.esc(q)}". Search the T2 item you want to produce (e.g. "Wolf"), not the T1 item it's invented from.</div>`;
    resultsEl.classList.remove('hidden');
    return;
  }
  renderInventionSearchResults(hits);
}
window.searchInventionItem = searchInventionItem;

function renderInventionSearchResults(hits, profitById) {
  const resultsEl = document.getElementById('invention-search-results');
  if (!resultsEl) return;
  const sortBtn = hits.length > 1 ? `
    <div class="px-3 py-1.5 bg-[#0a0f14] border-b border-[#1e3348] flex items-center justify-between">
      <span class="text-xs text-slate-500">${hits.length} match${hits.length > 1 ? 'es' : ''}</span>
      <button onmousedown="sortInventionSearchResultsByProfit()" class="text-xs px-2 py-0.5 bg-purple-800 hover:bg-purple-700 text-black font-bold rounded transition">📊 Sort by Profit</button>
    </div>
  ` : '';
  resultsEl.innerHTML = sortBtn + hits.map(h => {
    const profit = profitById && profitById[h.id] !== undefined ? profitById[h.id] : null;
    const profitBadge = profit !== null
      ? `<span class="ml-auto text-xs font-bold ${profit >= 0 ? 'text-green-400' : 'text-red-400'} flex-shrink-0">${Math.round(profit).toLocaleString()} ISK</span>`
      : '';
    return `
    <div class="px-3 py-2 hover:bg-[#1e3348] cursor-pointer flex items-center space-x-3 text-xs border-b border-[#1e3348]/40" onmousedown="selectInventionItem(${h.id}, '${window.esc(h.name)}')">
      <img src="https://images.evetech.net/types/${h.id}/icon?size=32" class="w-6 h-6 rounded flex-shrink-0" loading="lazy" onerror="this.onerror=null; this.src='https://images.evetech.net/types/${h.id}/render?size=32';">
      <span class="font-semibold text-slate-200 truncate">${window.esc(h.name)}</span>
      ${profitBadge}
    </div>
  `; }).join('');
  resultsEl.classList.remove('hidden');
}

// Computes each current search result's best-decryptor Total Potential Profit on demand (bounded to
// whatever's currently shown, not a scan of the whole database - see the earlier "margin finder"
// discussion for why scanning everything isn't practical) and re-sorts the list by it.
async function sortInventionSearchResultsByProfit() {
  const resultsEl = document.getElementById('invention-search-results');
  if (!resultsEl || _inventionLastSearchHits.length === 0) return;
  resultsEl.innerHTML = `<div class="p-3 text-slate-400 text-xs italic">Computing profit for ${_inventionLastSearchHits.length} item(s)...</div>`;

  const profitById = {};
  for (const hit of _inventionLastSearchHits) {
    try {
      const profit = await computeQuickBestInventionProfit(hit.id);
      profitById[hit.id] = profit;
    } catch (e) {
      console.warn(`[Invention] Quick profit calc failed for ${hit.name}:`, e);
      profitById[hit.id] = null;
    }
  }

  const sortedHits = [..._inventionLastSearchHits].sort((a, b) => {
    const pa = profitById[a.id] === null || profitById[a.id] === undefined ? -Infinity : profitById[a.id];
    const pb = profitById[b.id] === null || profitById[b.id] === undefined ? -Infinity : profitById[b.id];
    return pb - pa;
  });
  renderInventionSearchResults(sortedHits, profitById);
}
window.sortInventionSearchResultsByProfit = sortInventionSearchResultsByProfit;

// A lighter-weight version of the full comparison: just finds the best decryptor's Total Potential
// Profit for one item, using default skill levels (0, or your real ones if logged in via ESI) and 1
// BPC run, for ranking search results. Does NOT touch the currently-selected item's own state.
async function computeQuickBestInventionProfit(t2ProductTypeId) {
  const t2Map = getInventionT2ToT1Map();
  const recipe = t2Map[t2ProductTypeId]; // the T1 source recipe for this T2 product
  if (!recipe) return null;

  const t2Recipe = window.recipeMap && window.recipeMap[t2ProductTypeId];
  const t2BlueprintTypeId = t2Recipe ? t2Recipe.blueprintTypeID : null;
  if (!t2BlueprintTypeId) return null;

  const baseChance = getInventionBaseChance(t2ProductTypeId);
  const charSkills = window.safeParseJSON(localStorage.getItem('eve_char_skills'), { allSkills: {} });
  let encryptionLevel = 0;
  let scienceLevelSum = 0;
  (recipe.inventionSkills || []).forEach(sk => {
    const level = (charSkills.allSkills && charSkills.allSkills[sk.skillId] !== undefined) ? charSkills.allSkills[sk.skillId] : 0;
    if ((sk.name || '').toLowerCase().includes('encryption')) encryptionLevel = level;
    else scienceLevelSum += level;
  });

  const datacores = recipe.inventionMaterials || [];
  if (typeof window.fetchMarketPrices === 'function') {
    await window.fetchMarketPrices(datacores.map(m => m.typeId));
  }
  const datacoreCost = datacores.reduce((sum, m) => sum + (getInventionInputPrice(m.typeId) * m.qty), 0);

  const productGroupName = ((window.EVE_GROUP_NAMES && window.EVE_GROUP_NAMES[t2ProductTypeId]) || '').toLowerCase();
  const categoryId = window.EVE_CATEGORIES && window.EVE_CATEGORIES[t2ProductTypeId];
  const isShipOrRig = categoryId === 6 || productGroupName.includes('rig');
  const baseRuns = isShipOrRig ? 1 : 10;

  const decryptorTypeIds = DECRYPTORS.map(d => window.IDX && window.IDX[d.name.toLowerCase()] && window.IDX[d.name.toLowerCase()].id).filter(id => id);
  if (typeof window.fetchMarketPrices === 'function') await window.fetchMarketPrices(decryptorTypeIds);

  let bestProfit = -Infinity;
  for (const dec of DECRYPTORS) {
    const successChance = Math.min(100, baseChance * (1 + (scienceLevelSum / 30) + (encryptionLevel / 40)) * (1 + dec.probMod / 100));
    const resultRuns = Math.max(1, baseRuns + dec.runsMod);
    const resultME = 2 + dec.meMod;
    const resultTE = 4 + dec.teMod;
    const decEntry = window.IDX && window.IDX[dec.name.toLowerCase()];
    const decCost = (dec.name !== 'No Decryptor' && decEntry) ? getInventionInputPrice(decEntry.id) : 0;
    const costPerAttempt = datacoreCost + decCost;

    let bpcValue = 0;
    try {
      window.customMEOverrides = window.customMEOverrides || {};
      window.customTEOverrides = window.customTEOverrides || {};
      window.customMEOverrides[t2BlueprintTypeId] = resultME;
      window.customTEOverrides[t2BlueprintTypeId] = resultTE;
      window.recipeTreeRootProductTypeId = t2ProductTypeId;
      const root = await window.buildRecursiveRecipeTree(parseInt(t2BlueprintTypeId), t2Recipe.productName + ' Blueprint', resultRuns, 0, 6, new Set(), null);
      window.recipeTreeRootProductTypeId = null;
      if (root) {
        root.runsNeeded = resultRuns;
        root.qtyNeeded = resultRuns * (root.batchYield || 1);
        const facility = (window.getActiveStructureType ? window.getActiveStructureType().meBonus : 1.0) / 100;
        if (typeof window.scaleTreeQuantities === 'function') window.scaleTreeQuantities(root, facility);
        const allTypeIds = new Set();
        if (typeof window.collectAllTypeIds === 'function') window.collectAllTypeIds(root, allTypeIds);
        if (typeof window.fetchMarketPrices === 'function') await window.fetchMarketPrices(Array.from(allTypeIds));
        const materialCost = typeof window.calculateTreeNodeCost === 'function' ? window.calculateTreeNodeCost(root) : 0;
        const outputPrices = window.priceCache[t2ProductTypeId] || { sell: 0 };
        bpcValue = (outputPrices.sell * root.qtyNeeded) - materialCost;
      }
    } catch (e) { /* skip this decryptor for this item */ }

    const perAttemptProfit = (successChance / 100) * bpcValue - costPerAttempt;
    if (perAttemptProfit > bestProfit) bestProfit = perAttemptProfit;
  }
  return bestProfit === -Infinity ? null : bestProfit;
}

// --- Base chance classification ---
// Confirmed categories: modules/rigs/ammo/drones=34%, frigates/destroyers=30%,
// cruisers/battlecruisers/mining barges/haulers=26%, battleships=22%, freighters=18%.
// This is auto-classified from the item's group name; the UI lets the user override it directly
// since group-name matching can't perfectly cover every edge case, and the in-game invention window
// always shows the true value.
function getInventionBaseChance(productTypeId) {
  const groupName = ((window.EVE_GROUP_NAMES && window.EVE_GROUP_NAMES[productTypeId]) || '').toLowerCase();
  const categoryId = window.EVE_CATEGORIES && window.EVE_CATEGORIES[productTypeId];
  if (groupName.includes('freighter')) return 18;
  if (groupName.includes('battleship')) return 22;
  if (groupName.includes('cruiser') || groupName.includes('battlecruiser') || groupName.includes('mining barge') || groupName.includes('hauler') || groupName.includes('industrial')) return 26;
  if (groupName.includes('frigate') || groupName.includes('destroyer')) return 30;
  if (categoryId === 6) return 26; // an unclassified ship - fall back to a mid-tier default, flagged for manual check via the editable input
  return 34; // modules, rigs, ammo, drones, and everything else
}

let _inventionSelectedTypeId = null;
let _inventionSelectedName = null;

async function selectInventionItem(typeId, name, skipSave) {
  document.getElementById('invention-item-search').value = name;
  document.getElementById('invention-search-results').classList.add('hidden');

  const t2Map = getInventionT2ToT1Map();
  const t1Recipe = t2Map[typeId];
  if (!t1Recipe) {
    alert('No invention data found for this item.');
    return;
  }
  _inventionCurrentBlueprint = t1Recipe;
  _inventionSelectedTypeId = typeId;
  _inventionSelectedName = name;
  // typeId/name here are exactly what was searched (the T2 product) - no guessing or override needed,
  // since anything found via the reverse index is guaranteed to have this relationship confirmed.
  _inventionCurrentProduct = { typeId: typeId, name: name, probability: 1 };

  console.info(`[Invention] Selected T2 product "${name}" (typeId=${typeId}), invented from T1 "${t1Recipe.productName}" (blueprint typeId=${t1Recipe.blueprintTypeID}).`);

  document.getElementById('invention-config-panel').classList.remove('hidden');
  document.getElementById('invention-item-icon').src = `https://images.evetech.net/types/${typeId}/icon?size=64`;
  document.getElementById('invention-item-name').textContent = name;
  document.getElementById('invention-product-name').textContent = `Invented from: ${t1Recipe.productName || 'T1 item'}`;

  const baseChance = getInventionBaseChance(typeId);
  document.getElementById('invention-base-chance').value = baseChance;

  renderInventionSkillInputs(t1Recipe.inventionSkills || []);
  await renderInventionDatacoreList(t1Recipe.inventionMaterials || []);

  if (!skipSave) saveInventionState();
  recalculateInventionImpl();
}
window.selectInventionItem = selectInventionItem;

function renderInventionSkillInputs(skills) {
  const container = document.getElementById('invention-skill-inputs');
  if (!container) return;
  const charSkills = window.safeParseJSON(localStorage.getItem('eve_char_skills'), { allSkills: {} });

  if (skills.length === 0) {
    container.innerHTML = `<div class="text-slate-500 italic text-sm">No skill data found for this blueprint's invention activity - try regenerating the database.</div>`;
    return;
  }

  container.innerHTML = skills.map(sk => {
    const isEncryption = (sk.name || '').toLowerCase().includes('encryption');
    const trainedLevel = (charSkills.allSkills && charSkills.allSkills[sk.skillId] !== undefined) ? charSkills.allSkills[sk.skillId] : 0;
    return `
      <div class="flex items-center justify-between px-2 py-1.5">
        <span class="text-sm ${isEncryption ? 'text-amber-300' : 'text-cyan-300'} font-semibold truncate pr-2" title="${isEncryption ? 'Encryption skill (affects chance /40)' : 'Science skill (affects chance /30, combined with the other science skill)'}">${window.esc(sk.name || `Skill ${sk.skillId}`)}</span>
        <input type="number" min="0" max="5" value="${trainedLevel}" data-skill-id="${sk.skillId}" data-is-encryption="${isEncryption}"
          oninput="recalculateInvention()" class="invention-skill-input field-line w-12 text-center text-white font-bold text-sm p-1">
      </div>
    `;
  }).join('');
}

// Prices something you need to ACQUIRE (datacores, decryptor) using the same buy/sell strategy
// toggle the manufacturing cost engine reads - "sell" means buying instantly off sell orders, "buy"
// means placing your own buy order (cheaper, but not instant, and a broker fee applies).
function getInventionInputPrice(typeId) {
  const strategy = document.getElementById('input-price-mode')?.value || 'sell';
  const prices = (window.priceCache && window.priceCache[typeId]) || { sell: 0, buy: 0 };
  let price = strategy === 'sell' ? prices.sell : prices.buy;
  if (strategy === 'buy') {
    const brokerFeeInput = document.getElementById('broker-fee');
    const brokerFee = brokerFeeInput ? (parseFloat(brokerFeeInput.value) || 0) / 100 : 0.01;
    price = price * (1 + brokerFee);
  }
  return price || 0;
}

async function renderInventionDatacoreList(materials) {
  const container = document.getElementById('invention-datacore-list');
  if (!container) return;
  if (materials.length === 0) {
    container.innerHTML = `<div class="text-slate-500 italic">No datacore data found.</div>`;
    return;
  }
  const typeIds = materials.map(m => m.typeId);
  if (typeof window.fetchMarketPrices === 'function') {
    await window.fetchMarketPrices(typeIds);
  }
  container.innerHTML = materials.map(m => {
    const price = getInventionInputPrice(m.typeId);
    return `
      <div class="flex justify-between items-center py-0.5 border-b border-[#1e3348]/30">
        <span class="text-slate-300">${window.esc(m.name)} x${m.qty}</span>
        <span class="text-cyan-400 font-bold">${Math.round(price * m.qty).toLocaleString()} ISK</span>
      </div>
    `;
  }).join('');
}

// --- Core calculation + Profit Comparer ---
async function recalculateInventionImpl() {
  if (!_inventionCurrentBlueprint || !_inventionCurrentProduct) return;
  saveInventionState();

  const baseChance = parseFloat(document.getElementById('invention-base-chance').value) || 0;
  const targetBPCs = Math.max(1, parseInt(document.getElementById('invention-target-bpcs').value) || 1);

  let encryptionLevel = 0;
  let scienceLevelSum = 0;
  document.querySelectorAll('.invention-skill-input').forEach(input => {
    const level = parseInt(input.value) || 0;
    if (input.dataset.isEncryption === 'true') {
      encryptionLevel = level;
    } else {
      scienceLevelSum += level;
    }
  });
  console.info(`[Invention] Success chance inputs: baseChance=${baseChance}, encryptionLevel=${encryptionLevel}, scienceLevelSum=${scienceLevelSum}, skill inputs found: ${document.querySelectorAll('.invention-skill-input').length}`);
  document.querySelectorAll('.invention-skill-input').forEach(input => {
    console.info(`[Invention]   skill-id=${input.dataset.skillId}, isEncryption=${input.dataset.isEncryption}, value=${input.value}`);
  });

  const datacores = _inventionCurrentBlueprint.inventionMaterials || [];
  const deductStock = document.getElementById('invention-deduct-stock')?.checked ?? true;

  const t2ProductTypeId = _inventionCurrentProduct.typeId;
  // recipeMap stores the blueprint's own ID directly on the recipe object - far more reliable than
  // reverse-searching BLUEPRINT_TO_PRODUCT_MAP for a matching entry, which was silently failing and
  // leaving bpcValue at 0 for every row (recipeMap is indexed by product ID too, so this always works
  // as long as the T2 item's recipe was captured during database generation).
  const t2Recipe = window.recipeMap && window.recipeMap[t2ProductTypeId];
  const t2BlueprintTypeId = t2Recipe ? t2Recipe.blueprintTypeID : null;
  console.info(`[Invention] T2 product typeId=${t2ProductTypeId}, resolved blueprint typeId=${t2BlueprintTypeId || 'NOT FOUND'}`);
  if (!t2ProductTypeId) {
    console.warn('[Invention] No T2 product typeId set at all - profit calculation cannot run.');
  } else if (!t2BlueprintTypeId) {
    console.warn(`[Invention] recipeMap has no entry for product ${t2ProductTypeId}, or it's missing blueprintTypeID - manufacturing profit cannot be calculated.`);
  }

  const productGroupName = ((window.EVE_GROUP_NAMES && window.EVE_GROUP_NAMES[t2ProductTypeId]) || '').toLowerCase();
  const categoryId = window.EVE_CATEGORIES && window.EVE_CATEGORIES[t2ProductTypeId];
  const isShipOrRig = categoryId === 6 || productGroupName.includes('rig');
  const baseRuns = isShipOrRig ? 1 : 10;

  const decryptorNames = DECRYPTORS.map(d => d.name);
  if (typeof window.fetchMarketPrices === 'function') {
    const decryptorTypeIds = decryptorNames
      .map(n => window.IDX && window.IDX[n.toLowerCase()] && window.IDX[n.toLowerCase()].id)
      .filter(id => id);
    await window.fetchMarketPrices(decryptorTypeIds);
  }

  const rows = await Promise.all(DECRYPTORS.map(async (dec) => {
    const successChance = Math.min(100, baseChance * (1 + (scienceLevelSum / 30) + (encryptionLevel / 40)) * (1 + dec.probMod / 100));
    const resultRuns = Math.max(1, baseRuns + dec.runsMod);
    const resultME = 2 + dec.meMod;
    const resultTE = 4 + dec.teMod;

    const decEntry = window.IDX && window.IDX[dec.name.toLowerCase()];

    // How many attempts this decryptor needs to reach the target, computed here (before the cost
    // block) since stock deduction has to happen against the TOTAL quantity needed across all
    // attempts, not per-attempt - owning 5 datacores covers part of attempt 1 AND part of attempt 2,
    // it doesn't reset each time.
    const successProbability = successChance / 100;
    const requiredAttempts = successProbability > 0 ? Math.ceil(targetBPCs / successProbability) : Infinity;

    // Build the multibuy line items with stock deducted from the TOTAL need, not per-attempt.
    const multibuyItems = [];
    let totalInventionCost = 0;
    if (isFinite(requiredAttempts)) {
      datacores.forEach(m => {
        const totalNeeded = m.qty * requiredAttempts;
        const owned = deductStock ? (window.userStockMap[m.typeId] || 0) : 0;
        const netToBuy = Math.max(0, totalNeeded - owned);
        const unitPrice = getInventionInputPrice(m.typeId);
        totalInventionCost += netToBuy * unitPrice;
        if (netToBuy > 0) multibuyItems.push({ name: m.name, qty: netToBuy });
      });
      if (dec.name !== 'No Decryptor' && decEntry) {
        const totalNeeded = requiredAttempts;
        const owned = deductStock ? (window.userStockMap[decEntry.id] || 0) : 0;
        const netToBuy = Math.max(0, totalNeeded - owned);
        const unitPrice = getInventionInputPrice(decEntry.id);
        totalInventionCost += netToBuy * unitPrice;
        if (netToBuy > 0) multibuyItems.push({ name: dec.name, qty: netToBuy });
      }

      // The invention job's own installation fee - same EIV-based formula as manufacturing jobs
      // (facility tax + SCC surcharge + system cost index), but using invention's own SCI and EIV
      // based on the datacores actually consumed per attempt (invention has no ME to reduce this).
      const facilityTaxForInv = (parseFloat(document.getElementById('facility-tax')?.value) || 1.0) / 100;
      const sccSurchargeForInv = (parseFloat(document.getElementById('scc-surcharge')?.value) || 4.0) / 100;
      const structureTypeForInv = window.getActiveStructureType ? window.getActiveStructureType() : { costBonus: 5.0 };
      const structureRoleBonusForInv = structureTypeForInv.costBonus / 100;
      const inventionSCI = window.activeInventionSCI !== undefined ? window.activeInventionSCI : 0.02;
      const attemptEIV = datacores.reduce((sum, m) => sum + (window.eivCache && window.eivCache[m.typeId] ? window.eivCache[m.typeId] * m.qty : 0), 0);
      const inventionJobFeePerAttempt = attemptEIV * (inventionSCI * (1 - structureRoleBonusForInv) + facilityTaxForInv + sccSurchargeForInv);
      totalInventionCost += inventionJobFeePerAttempt * requiredAttempts;
    } else {
      totalInventionCost = Infinity;
    }

    let unitCost = 0;   // material cost to manufacture ONE BPC's full production
    let unitSell = 0;   // gross revenue from selling ONE BPC's full production
    let unitBuildSeconds = 0; // build time for ONE BPC's full production
    let profitDetail = 'No product data';
    if (t2BlueprintTypeId && t2ProductTypeId) {
      try {
        window.customMEOverrides = window.customMEOverrides || {};
        window.customTEOverrides = window.customTEOverrides || {};
        window.customMEOverrides[t2BlueprintTypeId] = resultME;
        window.customTEOverrides[t2BlueprintTypeId] = resultTE;
        window.recipeTreeRootProductTypeId = t2ProductTypeId;
        const root = await window.buildRecursiveRecipeTree(parseInt(t2BlueprintTypeId), _inventionCurrentProduct.name + ' Blueprint', resultRuns, 0, 6, new Set(), null);
        window.recipeTreeRootProductTypeId = null;
        if (!root) {
          console.warn(`[Invention] buildRecursiveRecipeTree returned nothing for blueprint ${t2BlueprintTypeId} (decryptor: ${dec.name}) - this item's manufacturing recipe may be missing or malformed.`);
        }
        if (root) {
          root.runsNeeded = resultRuns;
          root.qtyNeeded = resultRuns * (root.batchYield || 1);
          const facility = (window.getActiveStructureType ? window.getActiveStructureType().meBonus : 1.0) / 100;
          if (typeof window.scaleTreeQuantities === 'function') window.scaleTreeQuantities(root, facility);
          const allTypeIds = new Set();
          if (typeof window.collectAllTypeIds === 'function') window.collectAllTypeIds(root, allTypeIds);
          if (typeof window.fetchMarketPrices === 'function') await window.fetchMarketPrices(Array.from(allTypeIds));
          const materialCost = typeof window.calculateTreeNodeCost === 'function' ? window.calculateTreeNodeCost(root) : 0;

          // Manufacturing job installation fee (facility tax + SCC surcharge + system cost index on
          // the job's EIV) - reuses the exact same calculation the main calculator uses, not a
          // separate approximation, so this stays consistent if that formula is ever revisited.
          const facilityTax = (parseFloat(document.getElementById('facility-tax')?.value) || 1.0) / 100;
          const sccSurcharge = (parseFloat(document.getElementById('scc-surcharge')?.value) || 4.0) / 100;
          const structureType = window.getActiveStructureType ? window.getActiveStructureType() : { costBonus: 5.0 };
          const structureRoleBonus = structureType.costBonus / 100;
          let mfgJobFee = 0;
          if (typeof window.calculateNodeEIV === 'function' && typeof window.calculateNodeJobFee === 'function') {
            window.calculateNodeEIV(root);
            mfgJobFee = window.calculateNodeJobFee(root, facilityTax, sccSurcharge, structureRoleBonus);
          }
          unitCost = materialCost + mfgJobFee;

          const outputPrices = window.priceCache[t2ProductTypeId] || { sell: 0 };
          const grossSell = outputPrices.sell * root.qtyNeeded;
          const salesTax = (parseFloat(document.getElementById('sales-tax')?.value) || 3.6) / 100;
          const sellBrokerFee = (parseFloat(document.getElementById('broker-fee')?.value) || 1.0) / 100;
          unitSell = grossSell * (1 - salesTax - sellBrokerFee);

          unitBuildSeconds = typeof window.calculateTotalBuildSeconds === 'function' ? window.calculateTotalBuildSeconds(root) : 0;
          profitDetail = `${root.qtyNeeded} units @ ${Math.round(outputPrices.sell).toLocaleString()} ISK sell (net of tax/broker: ${Math.round(unitSell).toLocaleString()}), ${Math.round(materialCost).toLocaleString()} ISK mats + ${Math.round(mfgJobFee).toLocaleString()} ISK job fee per BPC, ${unitBuildSeconds > 0 ? window.formatDuration(unitBuildSeconds) : 'no time data'} to manufacture per BPC`;
          if (dec.name === 'No Decryptor') {
            console.info(`[Invention] "No Decryptor" per-BPC breakdown: resultRuns=${resultRuns}, qtyProduced=${root.qtyNeeded}, sellPrice=${outputPrices.sell}, grossSell=${grossSell}, unitSell(net)=${unitSell}, materialCost=${materialCost}, mfgJobFee=${mfgJobFee}, unitCost=${unitCost}, unitBuildSeconds=${unitBuildSeconds}`);
          }
        }
      } catch (e) {
        console.warn('[Invention] Profit calc threw an error for', dec.name, e);
      }
    }

    const totalManufacturingCost = targetBPCs * unitCost;
    const totalRevenue = targetBPCs * unitSell;
    const totalProfit = isFinite(totalInventionCost) ? (totalRevenue - totalManufacturingCost - totalInventionCost) : -Infinity;
    const totalBuildSeconds = targetBPCs * unitBuildSeconds;
    const iskPerHour = totalBuildSeconds > 0 && isFinite(totalProfit) ? totalProfit / (totalBuildSeconds / 3600) : null;
    // Normalizes to a single manufacturing run (not a single attempt) so decryptors producing
    // different run counts per BPC (e.g. Augmentation's many runs vs Process's none) compare fairly.
    const totalRunsProduced = targetBPCs * resultRuns;
    const profitPerRun = (isFinite(totalProfit) && totalRunsProduced > 0) ? totalProfit / totalRunsProduced : (isFinite(totalProfit) ? totalProfit : -Infinity);

    return { dec, successChance, resultRuns, resultME, resultTE, requiredAttempts, totalInventionCost, totalManufacturingCost, totalRevenue, totalProfit, totalBuildSeconds, iskPerHour, profitPerRun, multibuyItems, profitDetail };
  }));

  renderInventionComparisonTable(rows);
  renderInventionSummaryTiles(rows);

  document.getElementById('invention-empty-state').classList.add('hidden');
  document.getElementById('invention-results-area').classList.remove('hidden');
}
let _recalculateInventionDebounceTimer = null;
// The public name every HTML oninput handler calls. Debouncing serializes rapid repeated triggers
// (typing multiple digits fires this several times in quick succession) into a single delayed call,
// which both avoids redundant work (9 full recipe tree builds with market fetches per call) and
// fixes a real race condition: without this, an older/slower calculation could finish after a newer
// one and silently overwrite the UI with stale results, since there was no protection against
// overlapping async calls.
function recalculateInvention() {
  if (_recalculateInventionDebounceTimer) clearTimeout(_recalculateInventionDebounceTimer);
  _recalculateInventionDebounceTimer = setTimeout(() => {
    _recalculateInventionDebounceTimer = null;
    recalculateInventionImpl();
  }, 400);
}
window.recalculateInvention = recalculateInvention;

function renderInventionSummaryTiles(rows) {
  const container = document.getElementById('invention-summary-tiles');
  if (!container || rows.length === 0) return;
  const best = rows.reduce((a, b) => (b.totalProfit > a.totalProfit ? b : a), rows[0]);
  const targetBPCs = Math.max(1, parseInt(document.getElementById('invention-target-bpcs').value) || 1);

  container.innerHTML = `
    <div class="bg-[#0d1922] px-3.5 py-2.5 rounded-lg shadow flex flex-col justify-center">
      <div class="text-xs text-slate-400 uppercase font-bold mono tracking-wide truncate">Best Option</div>
      <div class="text-base font-bold text-green-300 mono leading-tight truncate">${window.esc(best.dec.name)}</div>
      <div class="text-xs text-slate-500 mt-0.5">${best.successChance.toFixed(1)}% success chance</div>
    </div>
    <div class="bg-[#0d1922] px-3.5 py-2.5 rounded-lg shadow flex flex-col justify-center">
      <div class="text-xs text-slate-400 uppercase font-bold mono tracking-wide truncate">Attempts Needed</div>
      <div class="text-lg font-bold text-amber-300 mono leading-tight">${isFinite(best.requiredAttempts) ? best.requiredAttempts.toLocaleString() : '—'}</div>
      <div class="text-xs text-slate-500 mt-0.5">to get ${targetBPCs} successful BPC${targetBPCs > 1 ? 's' : ''}</div>
    </div>
    <div class="bg-[#0d1922] px-3.5 py-2.5 rounded-lg shadow flex flex-col justify-center">
      <div class="text-xs text-slate-400 uppercase font-bold mono tracking-wide truncate">Total Cost (Invention + Mfg)</div>
      <div class="text-lg font-bold text-cyan-400 mono leading-tight">${isFinite(best.totalInventionCost) ? Math.round(best.totalInventionCost + best.totalManufacturingCost).toLocaleString() : '—'} ISK</div>
      <div class="text-xs text-slate-500 mt-0.5">${isFinite(best.totalInventionCost) ? Math.round(best.totalInventionCost).toLocaleString() + ' invention + ' + Math.round(best.totalManufacturingCost).toLocaleString() + ' mfg' : ''}</div>
    </div>
    <div class="bg-[#0d1922] px-3.5 py-2.5 rounded-lg shadow flex flex-col justify-center">
      <div class="text-xs text-slate-400 uppercase font-bold mono tracking-wide truncate">Total Profit</div>
      <div class="text-lg font-bold ${isFinite(best.totalProfit) && best.totalProfit >= 0 ? 'text-green-400' : 'text-red-400'} mono leading-tight">${isFinite(best.totalProfit) ? Math.round(best.totalProfit).toLocaleString() + ' ISK' : '—'}</div>
      <div class="text-xs text-slate-500 mt-0.5">for ${targetBPCs} successful BPC${targetBPCs > 1 ? 's' : ''}</div>
    </div>
    <div class="bg-[#0d1922] px-3.5 py-2.5 rounded-lg shadow flex flex-col justify-center">
      <div class="text-xs text-slate-400 uppercase font-bold mono tracking-wide truncate">ISK/Hour</div>
      <div class="text-lg font-bold ${best.iskPerHour !== null ? (best.iskPerHour >= 0 ? 'text-green-400' : 'text-red-400') : 'text-slate-500'} mono leading-tight">${best.iskPerHour !== null ? Math.round(best.iskPerHour).toLocaleString() + ' ISK' : 'No time data'}</div>
      <div class="text-xs text-slate-500 mt-0.5">${best.totalBuildSeconds > 0 ? window.formatDuration(best.totalBuildSeconds) + ' total manufacturing' : 'build time unavailable'}</div>
    </div>
  `;
}

let _inventionLastComparisonRows = [];
let _inventionSortColumn = 'totalProfit';
let _inventionSortDescending = true;

function sortInventionComparisonBy(column) {
  if (_inventionSortColumn === column) {
    _inventionSortDescending = !_inventionSortDescending;
  } else {
    _inventionSortColumn = column;
    _inventionSortDescending = true;
  }
  renderInventionComparisonTable(_inventionLastComparisonRows);
}
window.sortInventionComparisonBy = sortInventionComparisonBy;

function copyInventionMultibuy(rowIndex) {
  const row = _inventionLastComparisonRows[rowIndex];
  if (!row) return;
  if (row.multibuyItems.length === 0) {
    alert('Nothing to buy - you already have enough stock for this decryptor\'s requirement.');
    return;
  }
  const text = row.multibuyItems.map(i => `${i.name} x${i.qty}`).join('\n');
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById(`invention-multibuy-btn-${rowIndex}`);
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = '✔ Copied!';
      setTimeout(() => { btn.textContent = orig; }, 1500);
    }
  });
}
window.copyInventionMultibuy = copyInventionMultibuy;

function renderInventionComparisonTable(rows) {
  const container = document.getElementById('invention-comparison-table');
  if (!container) return;
  _inventionLastComparisonRows = rows;
  const bestProfit = rows.length > 0 ? Math.max(...rows.map(r => r.totalProfit)) : 0;
  const targetBPCs = Math.max(1, parseInt(document.getElementById('invention-target-bpcs').value) || 1);

  const sortedRows = [...rows].sort((a, b) => {
    const av = a[_inventionSortColumn] === null || !isFinite(a[_inventionSortColumn]) ? -Infinity : a[_inventionSortColumn];
    const bv = b[_inventionSortColumn] === null || !isFinite(b[_inventionSortColumn]) ? -Infinity : b[_inventionSortColumn];
    return _inventionSortDescending ? bv - av : av - bv;
  });

  const sortHeader = (column, label, align) => {
    const isActive = _inventionSortColumn === column;
    const arrow = isActive ? (_inventionSortDescending ? ' ▼' : ' ▲') : '';
    return `<th class="p-2 ${align === 'right' ? 'text-right' : ''} cursor-pointer hover:text-purple-300 select-none" onclick="sortInventionComparisonBy('${column}')">${label}${arrow}</th>`;
  };

  container.innerHTML = `
    <table class="w-full text-left border-collapse text-xs mono">
      <thead>
        <tr class="text-slate-400 border-b border-[#1e3348] uppercase text-xs font-bold">
          <th class="p-2">Decryptor</th>
          ${sortHeader('successChance', 'Success %', 'right')}
          <th class="p-2 text-right">Result BPC</th>
          ${sortHeader('requiredAttempts', `Attempts Needed (for ${targetBPCs})`, 'right')}
          ${sortHeader('totalInventionCost', 'Total Invention Cost', 'right')}
          ${sortHeader('totalManufacturingCost', 'Total Mfg Cost', 'right')}
          ${sortHeader('totalProfit', 'Total Profit', 'right')}
          ${sortHeader('iskPerHour', 'ISK/Hour', 'right')}
          ${sortHeader('profitPerRun', 'Profit / 1 Run', 'right')}
          <th class="p-2 text-right">Buy List</th>
        </tr>
      </thead>
      <tbody>
        ${sortedRows.map(r => {
          const isBest = r.totalProfit === bestProfit && bestProfit > -Infinity;
          const rowIndex = rows.indexOf(r);
          return `
          <tr class="border-b border-[#1e3348]/40 ${isBest ? 'bg-green-950/30' : ''} hover:bg-[#0d1922] transition" title="${window.esc(r.profitDetail)}">
            <td class="p-2 font-bold ${isBest ? 'text-green-300' : 'text-slate-200'}">${isBest ? '🏆 ' : ''}${window.esc(r.dec.name)}</td>
            <td class="p-2 text-right text-cyan-300 font-bold">${r.successChance.toFixed(1)}%</td>
            <td class="p-2 text-right text-slate-400">${r.resultRuns} run${r.resultRuns > 1 ? 's' : ''}, ME${r.resultME >= 0 ? '+' : ''}${r.resultME}, TE${r.resultTE >= 0 ? '+' : ''}${r.resultTE}</td>
            <td class="p-2 text-right text-amber-300 font-bold">${isFinite(r.requiredAttempts) ? r.requiredAttempts.toLocaleString() : '—'}</td>
            <td class="p-2 text-right text-amber-300">${isFinite(r.totalInventionCost) ? Math.round(r.totalInventionCost).toLocaleString() + ' ISK' : '—'}</td>
            <td class="p-2 text-right text-cyan-400">${Math.round(r.totalManufacturingCost).toLocaleString()} ISK</td>
            <td class="p-2 text-right font-bold ${isFinite(r.totalProfit) && r.totalProfit >= 0 ? 'text-green-300' : 'text-red-300'}">${isFinite(r.totalProfit) ? Math.round(r.totalProfit).toLocaleString() + ' ISK' : '—'}</td>
            <td class="p-2 text-right ${r.iskPerHour !== null ? (r.iskPerHour >= 0 ? 'text-green-400' : 'text-red-400') : 'text-slate-500'} font-bold">${r.iskPerHour !== null ? Math.round(r.iskPerHour).toLocaleString() + ' ISK' : '—'}</td>
            <td class="p-2 text-right font-bold ${isFinite(r.profitPerRun) && r.profitPerRun >= 0 ? 'text-green-400' : 'text-red-400'}">${isFinite(r.profitPerRun) ? Math.round(r.profitPerRun).toLocaleString() + ' ISK' : '—'}</td>
            <td class="p-2 text-right">
              <button id="invention-multibuy-btn-${rowIndex}" onclick="copyInventionMultibuy(${rowIndex})" class="px-2 py-1 bg-purple-700 hover:bg-purple-600 text-black font-bold rounded text-xs transition" title="Copy datacores + decryptor needed for this decryptor's Attempts Needed, minus whatever stock you already own">📋 Copy</button>
            </td>
          </tr>
        `; }).join('')}
      </tbody>
    </table>
    <p class="text-xs text-slate-500 mt-2 leading-relaxed">
      Click any column header to sort by it (click again to reverse).
      <b>Attempts Needed</b> = the average number of invention tries (successes AND failures) to reach your target of ${targetBPCs} successful BPC${targetBPCs > 1 ? 's' : ''}, given this decryptor's success chance - this is where the success rate actually shows up: a worse chance means more attempts, more failed datacores/decryptors spent, and a higher Total Invention Cost for the same goal.
      <b>Buy List</b> copies the datacores + decryptors needed for that many attempts in EVE multibuy format, with your owned stock (from the location filter on the left) already deducted.
      <b>Total Invention Cost</b> = Attempts Needed × (datacores + decryptor cost per attempt), net of owned stock - you pay this on every attempt, win or lose.
      <b>Total Mfg Cost / Total Profit</b> = manufacturing your ${targetBPCs} target BPC${targetBPCs > 1 ? 's' : ''} worth of production, at your chosen Jita buy/sell pricing, minus Total Invention Cost.
      <b>Profit / 1 Run</b> normalizes Total Profit to a single manufacturing run, so decryptors with different run counts per BPC compare fairly.
      Not included: the T1 BPC's own acquisition cost, the invention job's own installation fee, or manufacturing job fees (facility tax/SCC/broker).
    </p>
  `;
}

// --- State persistence (survives reload and navigating away/back) ---
function saveInventionState() {
  if (!_inventionSelectedTypeId) return;
  const state = {
    typeId: _inventionSelectedTypeId,
    name: _inventionSelectedName,
    baseChance: document.getElementById('invention-base-chance')?.value,
    targetBPCs: document.getElementById('invention-target-bpcs')?.value,
    priceMode: document.getElementById('input-price-mode')?.value,
    skillLevels: Array.from(document.querySelectorAll('.invention-skill-input')).map(el => ({ skillId: el.dataset.skillId, value: el.value }))
  };
  localStorage.setItem('eve_invention_state', JSON.stringify(state));
}
window.saveInventionState = saveInventionState;

async function restoreInventionState() {
  const state = window.safeParseJSON(localStorage.getItem('eve_invention_state'), null);
  if (!state || !state.typeId) return;

  await selectInventionItem(state.typeId, state.name, true); // skipSave - don't overwrite what we're restoring

  if (state.baseChance !== undefined) document.getElementById('invention-base-chance').value = state.baseChance;
  const targetBPCsToRestore = state.targetBPCs !== undefined ? state.targetBPCs : state.bpcRuns; // bpcRuns: back-compat with state saved before this rename
  if (targetBPCsToRestore !== undefined) {
    const targetEl = document.getElementById('invention-target-bpcs');
    if (targetEl) targetEl.value = targetBPCsToRestore;
  }
  if (state.priceMode !== undefined) {
    const priceEl = document.getElementById('input-price-mode');
    if (priceEl) priceEl.value = state.priceMode;
  }
  if (Array.isArray(state.skillLevels)) {
    state.skillLevels.forEach(sl => {
      const input = document.querySelector(`.invention-skill-input[data-skill-id="${sl.skillId}"]`);
      if (input) input.value = sl.value;
    });
  }

  recalculateInventionImpl();
}
window.restoreInventionState = restoreInventionState;

// Shared with the main calculator via the same localStorage key - reads/writes only the tax/fee
// fields relevant here, merging with (not overwriting) calculator-specific fields like facility
// select or rig slots, so editing from either page keeps both in sync without clobbering settings
// this page doesn't touch.
function loadSharedTaxSettings() {
  try {
    const saved = localStorage.getItem('eve_tax_settings');
    if (!saved) return;
    const settings = window.safeParseJSON(saved, {});
    if (settings.facilityTax !== undefined && document.getElementById('facility-tax')) document.getElementById('facility-tax').value = settings.facilityTax;
    if (settings.sccSurcharge !== undefined && document.getElementById('scc-surcharge')) document.getElementById('scc-surcharge').value = settings.sccSurcharge;
    if (settings.salesTax !== undefined && document.getElementById('sales-tax')) document.getElementById('sales-tax').value = settings.salesTax;
    if (settings.brokerFee !== undefined && document.getElementById('broker-fee')) document.getElementById('broker-fee').value = settings.brokerFee;
  } catch (e) {}
}
window.loadSharedTaxSettings = loadSharedTaxSettings;

function saveSharedTaxSettings() {
  try {
    const existingRaw = localStorage.getItem('eve_tax_settings');
    const existing = existingRaw ? window.safeParseJSON(existingRaw, {}) : {};
    existing.facilityTax = document.getElementById('facility-tax')?.value;
    existing.sccSurcharge = document.getElementById('scc-surcharge')?.value;
    existing.salesTax = document.getElementById('sales-tax')?.value;
    existing.brokerFee = document.getElementById('broker-fee')?.value;
    localStorage.setItem('eve_tax_settings', JSON.stringify(existing));
  } catch (e) {}
}
window.saveSharedTaxSettings = saveSharedTaxSettings;

window.onload = async () => {
  if (typeof window.buildPrepackedIndexes === 'function') {
    window.buildPrepackedIndexes();
  }
  if (typeof window.handleEsiSSOCallback === 'function') {
    try { await window.handleEsiSSOCallback(); } catch (e) { console.error('SSO callback error:', e); }
  }
  loadSharedTaxSettings();
  // System cost index (needed for job fees) and adjusted prices (needed for EIV) - the calculator
  // and ledger both fetch these on load already; this page needs them too now that job fees are
  // calculated here. Both are AWAITED before restoreInventionState() runs the first calculation -
  // firing fetchAdjustedPrices() in the background here previously meant the first calculation (and
  // often every calculation after it) ran against an empty EIV cache, making job fees silently
  // compute to zero regardless of any tax/fee input, since nothing multiplied by zero stays zero.
  if (typeof window.loadSavedSystem === 'function') {
    try { await window.loadSavedSystem(); } catch (e) { console.warn('[Invention] SCI load failed:', e); }
  }
  if (typeof window.fetchAdjustedPrices === 'function') {
    try { await window.fetchAdjustedPrices(); } catch (e) { console.warn('[Invention] Adjusted prices fetch error:', e); }
  }
  // Page rendering and input aren't blocked while the awaits above are in flight, so it's possible
  // the user already selected an item before EIV/SCI data was ready - force one more recalculation
  // now that it actually is, rather than leaving a stale zero-fee calculation on screen.
  if (_inventionCurrentBlueprint) {
    recalculateInventionImpl();
  }
  try {
    await restoreInventionState();
  } catch (e) {
    console.warn('[Invention] Failed to restore previous session state:', e);
  }
};
