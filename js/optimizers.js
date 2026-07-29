'use strict';

// --- Action: Toggle Component Build / Buy Mode ---
async function toggleBuildSelf(e, typeId) {
  if (e) e.stopPropagation();
  const currentState = (buildSelfOverrides[typeId] !== undefined) ? buildSelfOverrides[typeId] : false;
  buildSelfOverrides[typeId] = !currentState;
  if (currentProduct) {
    await selectItem(currentProduct.id, currentProduct.name, true);
  }
}

// --- Action: Per-Card ME / TE Inputs ---
function onCardMEChange(e, typeId, instanceId) {
  if (e) e.stopPropagation();
  const val = Math.max(0, Math.min(10, parseFloat(e.target.value) || 0));
  customMEOverrides[typeId] = val;
  if (currentProduct) {
    selectItem(currentProduct.id, currentProduct.name, true);
  }
}

function onCardTEChange(e, typeId, instanceId) {
  if (e) e.stopPropagation();
  const val = Math.max(0, Math.min(20, parseFloat(e.target.value) || 0));
  customTEOverrides[typeId] = val;
  recalculate();
}

// --- Action: Build All Sub-Components ---
async function buildAllComponents() {
  function markAllBuild(node) {
    if (!node) return;
    if (node.isManufacturable) {
      buildSelfOverrides[node.typeId] = true;
      if (node.displayTypeId) buildSelfOverrides[node.displayTypeId] = true;
    }
    if (node.children) {
      node.children.forEach(c => markAllBuild(c));
    }
  }

  if (recipeTreeRoot) {
    markAllBuild(recipeTreeRoot);
    if (currentProduct) {
      await selectItem(currentProduct.id, currentProduct.name, true);
    }
  }
}

// --- Action: Buy All Sub-Components ---
async function buyAllSubComponents() {
  buildSelfOverrides = {};
  if (currentProduct) {
    await selectItem(currentProduct.id, currentProduct.name, true);
  }
  applyComponentSpreadOptimizer();
}

// --- Action: Reset Smart Buy Override Modes ---
function resetSmartBuyModes() {
  customBuyModes = {};
  recalculate();
}

// Optimizer 1: Build vs Buy Profit Margin Optimizer
async function applyBuildProfitOptimizer() {
  const threshold = parseFloat(document.getElementById('build-profit-threshold')?.value) || 0;

  if (!recipeTreeRoot) return;

  // Pre-fetch market prices for all type IDs before evaluating build margins
  const allTypeIds = new Set();
  if (typeof collectAllTypeIds === 'function') {
    collectAllTypeIds(recipeTreeRoot, allTypeIds);
    await fetchMarketPrices(Array.from(allTypeIds));
  }

  function evaluateBuildNode(node) {
    if (!node) return;

    if (node.depth > 0 && node.isManufacturable) {
      const typeId = node.displayTypeId || node.typeId;
      const prices = priceCache[typeId] || { sell: 0, buy: 0 };
      const marketPrice = prices.sell || prices.buy || getEIV(typeId) || 0;

      const deductModeInput = document.getElementById('deduct-stock-mode');
      const isStockDeductEnabled = deductModeInput ? deductModeInput.value === 'true' : true;
      const stockQty = isStockDeductEnabled ? (userStockMap[typeId] || userStockMap[node.typeId] || 0) : 0;
      const netQtyNeeded = Math.max(0, node.qtyNeeded - stockQty);

      const marketBuyCost = marketPrice * netQtyNeeded;

      // Estimate build cost from recipe materials + job fees
      let estimatedBuildCost = 0;
      if (node.recipe && node.recipe.materials) {
        node.recipe.materials.forEach(mat => {
          const matPrices = priceCache[mat.typeId] || { sell: 0, buy: 0 };
          const matUnitPrice = matPrices.sell || matPrices.buy || getEIV(mat.typeId) || 0;
          const meFactor = node.isReaction ? 1.0 : (1 - (node.customME || 0) / 100);
          const facFactor = (1 - parseFloat(document.getElementById('facility-select')?.value || '0.01'));
          const matQty = Math.max(node.runsNeeded, Math.ceil(node.runsNeeded * mat.baseQty * meFactor * facFactor));
          estimatedBuildCost += matUnitPrice * matQty;
        });
      }

      estimatedBuildCost += (node.jobFee || 0);

      if (marketBuyCost > 0 && estimatedBuildCost > 0) {
        const buildSavingsPct = ((marketBuyCost - estimatedBuildCost) / marketBuyCost) * 100;
        if (buildSavingsPct >= threshold) {
          buildSelfOverrides[typeId] = true;  // Building saves >= threshold %: switch to Build!
        } else {
          buildSelfOverrides[typeId] = false; // Building saves < threshold %: buy off Market!
        }
      } else {
        buildSelfOverrides[typeId] = true;
      }
    }

    if (node.children) {
      node.children.forEach(child => evaluateBuildNode(child));
    }
  }

  evaluateBuildNode(recipeTreeRoot);

  if (currentProduct) {
    await selectItem(currentProduct.id, currentProduct.name, true);
  }
}

// Optimizer 2: Component Market Spread Threshold
function applyComponentSpreadOptimizer() {
  const threshold = parseFloat(document.getElementById('buy-savings-threshold')?.value) || 0;

  function optimizeNode(node) {
    if (!node) return;
    
    if (!node.isBuildingSelf || !node.children || node.children.length === 0) {
      const typeId = node.displayTypeId || node.typeId;
      const prices = priceCache[typeId] || { sell: 0, buy: 0 };
      
      if (prices.sell > 0 && prices.buy > 0 && prices.sell > prices.buy) {
        const spreadPct = ((prices.sell - prices.buy) / prices.sell) * 100;
        if (spreadPct >= threshold) {
          customBuyModes[typeId] = 'buy';  // Market spread is large enough: place a Buy Order!
        } else {
          customBuyModes[typeId] = 'sell'; // Market spread is small: buy instantly off Sell Orders!
        }
      } else {
        customBuyModes[typeId] = 'sell'; 
      }
    }

    if (node.children) {
      node.children.forEach(child => optimizeNode(child));
    }
  }

  if (recipeTreeRoot) {
    optimizeNode(recipeTreeRoot);
    recalculate();
  }
}

// Optimizer 3: Build Cost Savings Impact Threshold
function applyBudgetImpactOptimizer() {
  const threshold = parseFloat(document.getElementById('total-cost-savings-threshold')?.value) || 0;

  function optimizeNode(node) {
    if (!node) return;
    
    if (!node.isBuildingSelf || !node.children || node.children.length === 0) {
      const typeId = node.displayTypeId || node.typeId;
      const prices = priceCache[typeId] || { sell: 0, buy: 0 };
      
      const deductModeInput = document.getElementById('deduct-stock-mode');
      const isStockDeductEnabled = deductModeInput ? deductModeInput.value === 'true' : true;
      const stockQty = isStockDeductEnabled ? (userStockMap[typeId] || userStockMap[node.typeId] || 0) : 0;
      const netQtyNeeded = Math.max(0, node.qtyNeeded - stockQty);

      const sellTotal = prices.sell * netQtyNeeded;
      const buyTotal = prices.buy * netQtyNeeded;

      if (sellTotal > 0 && buyTotal > 0 && sellTotal > buyTotal) {
        const rootTotalCost = recipeTreeRoot?.calculatedCost || 1;
        const budgetImpactPct = rootTotalCost > 0 ? ((sellTotal - buyTotal) / rootTotalCost) * 100 : 0;

        if (budgetImpactPct >= threshold) {
          customBuyModes[typeId] = 'buy';  // Saves enough on overall budget: place a Buy Order!
        } else {
          customBuyModes[typeId] = 'sell'; // Minor impact on total budget: buy off Sell Orders!
        }
      } else {
        customBuyModes[typeId] = 'sell';
      }
    }

    if (node.children) {
      node.children.forEach(child => optimizeNode(child));
    }
  }

  if (recipeTreeRoot) {
    optimizeNode(recipeTreeRoot);
    recalculate();
  }
}

function setComponentBuyMode(e, typeId, mode) {
  if (e) e.stopPropagation();
  customBuyModes[typeId] = mode;
  recalculate();
}

function getNodePriceStrategy(node) {
  const globalStrategy = document.getElementById('input-price-mode')?.value || 'sell';
  return customBuyModes[node.typeId] || globalStrategy;
}

function calculateTreeNodeCost(node) {
  const deductModeInput = document.getElementById('deduct-stock-mode');
  const isStockDeductEnabled = deductModeInput ? deductModeInput.value === 'true' : true;
  const stockQty = isStockDeductEnabled ? (userStockMap[node.typeId] || userStockMap[node.displayTypeId] || 0) : 0;
  const netNeededQty = Math.max(0, node.qtyNeeded - stockQty);

  if (!node.isBuildingSelf || !node.children || node.children.length === 0) {
    const strategy = getNodePriceStrategy(node);
    const prices = priceCache[node.typeId] || { sell: 0, buy: 0 };
    let unitPrice = strategy === 'sell' ? prices.sell : prices.buy;
    if (strategy === 'buy') {
      const brokerFeeInput = document.getElementById('broker-fee');
      const brokerFee = brokerFeeInput ? (parseFloat(brokerFeeInput.value) || 0) / 100 : 0.01;
      unitPrice = unitPrice * (1 + brokerFee);
    }
    node.calculatedCost = unitPrice * netNeededQty;
    return node.calculatedCost;
  }

  let total = 0;
  node.children.forEach(child => {
    total += calculateTreeNodeCost(child);
  });
  node.calculatedCost = total;
  return total;
}

function calculateNodeJobFee(node, facilityTax, sccSurcharge, structureRoleBonus) {
  if (!node || !node.isBuildingSelf || !node.recipe || !node.recipe.materials) return 0;

  const sci = node.isReaction ? activeReactSCI : activeMfgSCI;
  const jobEIV = node.jobEIV || 0;

  const systemFee = jobEIV * sci * (1 - structureRoleBonus);
  const facilityFee = jobEIV * facilityTax;
  const sccFee = jobEIV * sccSurcharge;

  const totalNodeJobFee = systemFee + facilityFee + sccFee;

  node.jobFee = totalNodeJobFee;

  let childJobFees = 0;
  if (node.children && node.children.length > 0) {
    node.children.forEach(child => {
      childJobFees += calculateNodeJobFee(child, facilityTax, sccSurcharge, structureRoleBonus);
    });
  }

  return totalNodeJobFee + childJobFees;
}