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
let _inventionCurrentProduct = null;   // the T2 product/blueprint chosen from inventionProducts

// --- Search ---
let _inventionSearchToken = 0;
function searchInventionItem(query) {
  const resultsEl = document.getElementById('invention-search-results');
  if (!resultsEl) return;
  const token = ++_inventionSearchToken;
  const q = (query || '').toLowerCase().trim();
  if (q.length < 2) {
    resultsEl.classList.add('hidden');
    return;
  }
  const hits = [];
  for (const [name, entry] of Object.entries(window.IDX || {})) {
    if (name.includes(q)) {
      const recipe = window.recipeMap && window.recipeMap[entry.id];
      if (recipe && recipe.inventionMaterials && recipe.inventionMaterials.length > 0) {
        hits.push(entry);
      }
    }
    if (hits.length >= 15) break;
  }
  if (token !== _inventionSearchToken) return;
  if (hits.length === 0) {
    resultsEl.innerHTML = `<div class="p-3 text-slate-400 text-xs italic">No inventable items found matching "${window.esc(q)}". Search the item itself (e.g. "Caracal"), not its blueprint.</div>`;
    resultsEl.classList.remove('hidden');
    return;
  }
  resultsEl.innerHTML = hits.map(h => `
    <div class="px-3 py-2 hover:bg-[#1e3348] cursor-pointer flex items-center space-x-3 text-xs border-b border-[#1e3348]/40" onmousedown="selectInventionItem(${h.id}, '${window.esc(h.name)}')">
      <img src="https://images.evetech.net/types/${h.id}/icon?size=32" class="w-6 h-6 rounded" onerror="this.onerror=null; this.src='https://images.evetech.net/types/${h.id}/render?size=32';">
      <span class="font-semibold text-slate-200">${window.esc(h.name)}</span>
    </div>
  `).join('');
  resultsEl.classList.remove('hidden');
}
window.searchInventionItem = searchInventionItem;

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

async function selectInventionItem(typeId, name) {
  document.getElementById('invention-item-search').value = name;
  document.getElementById('invention-search-results').classList.add('hidden');

  const recipe = window.recipeMap && window.recipeMap[typeId];
  if (!recipe || !recipe.inventionMaterials) {
    alert('No invention data found for this item.');
    return;
  }
  _inventionCurrentBlueprint = recipe;

  const products = recipe.inventionProducts && recipe.inventionProducts.length > 0
    ? recipe.inventionProducts
    : [{ typeId: null, name: 'Unknown T2 product', probability: 1 }];
  _inventionCurrentProduct = products[0]; // TODO: if multiple, let user pick - most T1 items only invent one T2 variant

  document.getElementById('invention-config-panel').classList.remove('hidden');
  document.getElementById('invention-item-icon').src = `https://images.evetech.net/types/${typeId}/icon?size=64`;
  document.getElementById('invention-item-name').textContent = name;
  document.getElementById('invention-product-name').textContent = `Invents: ${_inventionCurrentProduct.name || 'Unknown'}`;

  const baseChance = getInventionBaseChance(_inventionCurrentProduct.typeId || typeId);
  document.getElementById('invention-base-chance').value = baseChance;

  renderInventionSkillInputs(recipe.inventionSkills || []);
  await renderInventionDatacoreList(recipe.inventionMaterials || []);

  recalculateInvention();
}
window.selectInventionItem = selectInventionItem;

function renderInventionSkillInputs(skills) {
  const container = document.getElementById('invention-skill-inputs');
  if (!container) return;
  const charSkills = window.safeParseJSON(localStorage.getItem('eve_char_skills'), { allSkills: {} });

  if (skills.length === 0) {
    container.innerHTML = `<div class="text-slate-500 italic text-[11px]">No skill data found for this blueprint's invention activity - try regenerating the database.</div>`;
    return;
  }

  container.innerHTML = skills.map(sk => {
    const isEncryption = (sk.name || '').toLowerCase().includes('encryption');
    const trainedLevel = (charSkills.allSkills && charSkills.allSkills[sk.skillId] !== undefined) ? charSkills.allSkills[sk.skillId] : 0;
    return `
      <div class="flex items-center justify-between bg-[#070b0f] border border-[#1e3348] rounded px-2 py-1.5">
        <span class="text-[11px] ${isEncryption ? 'text-amber-300' : 'text-cyan-300'} font-semibold truncate pr-2" title="${isEncryption ? 'Encryption skill (affects chance /40)' : 'Science skill (affects chance /30, combined with the other science skill)'}">${window.esc(sk.name || `Skill ${sk.skillId}`)}</span>
        <input type="number" min="0" max="5" value="${trainedLevel}" data-skill-id="${sk.skillId}" data-is-encryption="${isEncryption}"
          oninput="recalculateInvention()" class="invention-skill-input w-12 bg-[#0d1922] border border-[#1e3348] rounded text-center text-white font-bold text-[11px] outline-none p-1">
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
async function recalculateInvention() {
  if (!_inventionCurrentBlueprint || !_inventionCurrentProduct) return;

  const baseChance = parseFloat(document.getElementById('invention-base-chance').value) || 0;
  const bpcRuns = Math.max(1, parseInt(document.getElementById('invention-bpc-runs').value) || 1);

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

  const datacores = _inventionCurrentBlueprint.inventionMaterials || [];
  const datacoreCost = datacores.reduce((sum, m) => sum + (getInventionInputPrice(m.typeId) * m.qty), 0);

  const t2ProductTypeId = _inventionCurrentProduct.typeId;
  // recipeMap stores the blueprint's own ID directly on the recipe object - far more reliable than
  // reverse-searching BLUEPRINT_TO_PRODUCT_MAP for a matching entry, which was silently failing and
  // leaving bpcValue at 0 for every row (recipeMap is indexed by product ID too, so this always works
  // as long as the T2 item's recipe was captured during database generation).
  const t2Recipe = window.recipeMap && window.recipeMap[t2ProductTypeId];
  const t2BlueprintTypeId = t2Recipe ? t2Recipe.blueprintTypeID : null;
  if (!t2BlueprintTypeId) {
    console.warn(`[Invention] No recipe found for T2 product ${t2ProductTypeId} - regenerate your database, or this item's manufacturing data is missing.`);
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
    const decCost = (dec.name !== 'No Decryptor' && decEntry) ? getInventionInputPrice(decEntry.id) : 0;

    const costPerAttempt = datacoreCost + decCost;

    let bpcValue = 0;
    let totalBuildSeconds = 0;
    let iskPerHour = null;
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
          const grossSell = outputPrices.sell * root.qtyNeeded;
          bpcValue = grossSell - materialCost;

          // Real manufacturing time for producing every run this BPC allows, using the same time
          // calculation (skills, TE research, facility/rig bonuses) the calculator and ledger use.
          totalBuildSeconds = typeof window.calculateTotalBuildSeconds === 'function' ? window.calculateTotalBuildSeconds(root) : 0;
          iskPerHour = totalBuildSeconds > 0 ? bpcValue / (totalBuildSeconds / 3600) : null;

          profitDetail = `${root.qtyNeeded} units @ ${Math.round(outputPrices.sell).toLocaleString()} ISK sell, ${Math.round(materialCost).toLocaleString()} ISK mats, ${totalBuildSeconds > 0 ? window.formatDuration(totalBuildSeconds) : 'no time data'} to manufacture`;
        }
      } catch (e) {
        console.warn('Invention profit calc failed for', dec.name, e);
      }
    }

    const expectedProfitPerAttempt = (successChance / 100) * bpcValue - costPerAttempt;
    const expectedCostPerSuccess = successChance > 0 ? costPerAttempt / (successChance / 100) : Infinity;
    // Each run on the T1 BPC is one invention attempt (success or fail, it's consumed) - this is the
    // expected total profit if you use every available run attempting this decryptor choice.
    const totalExpectedProfitAllRuns = expectedProfitPerAttempt * bpcRuns;

    return { dec, successChance, resultRuns, resultME, resultTE, costPerAttempt, bpcValue, expectedProfitPerAttempt, expectedCostPerSuccess, totalBuildSeconds, iskPerHour, totalExpectedProfitAllRuns, profitDetail };
  }));

  rows.sort((a, b) => b.expectedProfitPerAttempt - a.expectedProfitPerAttempt);
  renderInventionComparisonTable(rows);

  document.getElementById('invention-empty-state').classList.add('hidden');
  document.getElementById('invention-results-area').classList.remove('hidden');
}
window.recalculateInvention = recalculateInvention;

function renderInventionComparisonTable(rows) {
  const container = document.getElementById('invention-comparison-table');
  if (!container) return;
  const bestProfit = rows.length > 0 ? rows[0].expectedProfitPerAttempt : 0;
  const bpcRuns = Math.max(1, parseInt(document.getElementById('invention-bpc-runs').value) || 1);

  container.innerHTML = `
    <table class="w-full text-left border-collapse text-xs mono">
      <thead>
        <tr class="text-slate-400 border-b border-[#1e3348] uppercase text-[10px] font-bold">
          <th class="p-2">Decryptor</th>
          <th class="p-2 text-right">Success %</th>
          <th class="p-2 text-right">Result BPC</th>
          <th class="p-2 text-right">Cost/Attempt</th>
          <th class="p-2 text-right">Build Time</th>
          <th class="p-2 text-right">ISK/Hour</th>
          <th class="p-2 text-right">Profit/Attempt</th>
          <th class="p-2 text-right">Total (${bpcRuns} run${bpcRuns > 1 ? 's' : ''})</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(r => {
          const isBest = r.expectedProfitPerAttempt === bestProfit && bestProfit > -Infinity;
          return `
          <tr class="border-b border-[#1e3348]/40 ${isBest ? 'bg-green-950/30' : ''} hover:bg-[#0d1922] transition" title="${window.esc(r.profitDetail)}">
            <td class="p-2 font-bold ${isBest ? 'text-green-300' : 'text-slate-200'}">${isBest ? '🏆 ' : ''}${window.esc(r.dec.name)}</td>
            <td class="p-2 text-right text-cyan-300 font-bold">${r.successChance.toFixed(1)}%</td>
            <td class="p-2 text-right text-slate-400">${r.resultRuns} run${r.resultRuns > 1 ? 's' : ''}, ME${r.resultME >= 0 ? '+' : ''}${r.resultME}, TE${r.resultTE >= 0 ? '+' : ''}${r.resultTE}</td>
            <td class="p-2 text-right text-amber-300">${Math.round(r.costPerAttempt).toLocaleString()} ISK</td>
            <td class="p-2 text-right text-slate-400">${r.totalBuildSeconds > 0 ? window.formatDuration(r.totalBuildSeconds) : '—'}</td>
            <td class="p-2 text-right ${r.iskPerHour !== null ? (r.iskPerHour >= 0 ? 'text-green-400' : 'text-red-400') : 'text-slate-500'} font-bold">${r.iskPerHour !== null ? Math.round(r.iskPerHour).toLocaleString() + ' ISK' : '—'}</td>
            <td class="p-2 text-right font-bold ${r.expectedProfitPerAttempt >= 0 ? 'text-green-400' : 'text-red-400'}">${Math.round(r.expectedProfitPerAttempt).toLocaleString()} ISK</td>
            <td class="p-2 text-right font-bold ${r.totalExpectedProfitAllRuns >= 0 ? 'text-green-300' : 'text-red-300'}">${Math.round(r.totalExpectedProfitAllRuns).toLocaleString()} ISK</td>
          </tr>
        `; }).join('')}
      </tbody>
    </table>
    <p class="text-[10px] text-slate-500 mt-2 leading-relaxed">
      <b>Profit/Attempt</b> = success chance × (value of manufacturing everything the resulting BPC allows) − cost of this one attempt.
      <b>ISK/Hour</b> uses the same manufacturing time calculation (skills, TE research, facility/rig bonuses) as the calculator and ledger.
      <b>Total (N runs)</b> = Profit/Attempt × your T1 BPC's available runs, assuming you use all of them on this decryptor choice.
      None of these include the T1 BPC's own cost (fixed regardless of decryptor), the invention job's own installation fee, or manufacturing job fees (facility tax/SCC/broker) - materials only.
    </p>
  `;
}

window.onload = async () => {
  if (typeof window.buildPrepackedIndexes === 'function') {
    window.buildPrepackedIndexes();
  }
  if (typeof window.handleEsiSSOCallback === 'function') {
    try { await window.handleEsiSSOCallback(); } catch (e) { console.error('SSO callback error:', e); }
  }
};
