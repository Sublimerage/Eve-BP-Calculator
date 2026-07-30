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

// Optimizer 1: True Greedy Build vs Buy Profit Margin Optimizer
async function applyBuildProfitOptimizer() {
  const threshold = parseFloat(document.getElementById('build-profit-threshold')?.value) || 0;

  if (!recipeTreeRoot) return;

  // Pre-fetch market prices for all type IDs before evaluating build margins
  const allTypeIds = new Set();
  if (typeof collectAllTypeIds === 'function') {
    collectAllTypeIds(recipeTreeRoot, allTypeIds);
    await fetchMarketPrices(Array.from(allTypeIds));
  }

  // Collect all manufacturable sub-component type IDs in the recipe tree
  const manufacturableTypeIds = new Set();
  function collectManufacturableNodes(node) {
    if (!node) return;
    if (node.depth > 0 && node.isManufacturable) {
      manufacturableTypeIds.add(node.displayTypeId || node.typeId);
    }
    if (node.children) {
      node.children.forEach(child => collectManufacturableNodes(child));
    }
  }
  collectManufacturableNodes(recipeTreeRoot);

  const facilityTax = (parseFloat(document.getElementById('facility-tax')?.value) || 1.0) / 100;
  const sccSurcharge = (parseFloat(document.getElementById('scc-surcharge')?.value) || 4.0) / 100;
  const structureRoleBonus = parseFloat(document.getElementById('structure-role-bonus')?.value) || 0.03;
  const facility = document.getElementById('facility-select')?.value || '0.01';
  const brokerFee = (parseFloat(document.getElementById('broker-fee')?.value) || 1.0) / 100;

  // Helper to run a silent simulation test for profit under given build overrides
  function simulateProfit(overrideState) {
    const tempOverrides = { ...overrideState };
    
    // Scale tree quantities
    scaleTreeQuantities(recipeTreeRoot, facility);
    calculateNodeEIV(recipeTreeRoot);

    // Calculate material cost and job fees
    let matCost = 0;
    if (recipeTreeRoot.isBuildingSelf && recipeTreeRoot.children && recipeTreeRoot.children.length > 0) {
      recipeTreeRoot.children.forEach(child => {
        matCost += calculateTreeNodeCost(child);
      });
    } else {
      const rootPrices = priceCache[recipeTreeRoot.typeId] || { sell: 0, buy: 0 };
      matCost = (rootPrices.sell || rootPrices.buy || 0) * recipeTreeRoot.qtyNeeded;
    }

    const jobFees = calculateNodeJobFee(recipeTreeRoot, facilityTax, sccSurcharge, structureRoleBonus);
    const totalCost = matCost + jobFees;

    const outputPrices = priceCache[recipeTreeRoot.typeId] || { sell: 0, buy: 0 };
    const grossSell = outputPrices.sell * recipeTreeRoot.qtyNeeded;
    const salesTax = (parseFloat(document.getElementById('sales-tax')?.value) || 3.6) / 100;
    const netSell = grossSell * (1 - salesTax - brokerFee);

    return netSell - totalCost;
  }

  // Test building vs buying for each sub-component from bottom-up
  for (const typeId of Array.from(manufacturableTypeIds)) {
    // Scenario A: Test with component set to BUY
    buildSelfOverrides[typeId] = false;
    const profitBuy = simulateProfit(buildSelfOverrides);

    // Scenario B: Test with component set to BUILD
    buildSelfOverrides[typeId] = true;
    const profitBuild = simulateProfit(buildSelfOverrides);

    const prices = priceCache[typeId] || { sell: 0, buy: 0 };
    const unitPrice = prices.sell || prices.buy || getEIV(typeId) || 1;
    const baseCost = unitPrice * (recipeTreeRoot.qtyNeeded || 1);

    const profitGain = profitBuild - profitBuy;
    const marginGainPct = baseCost > 0 ? (profitGain / baseCost) * 100 : 0;

    // Only keep BUILD mode if building actually INCREASES net profit by >= threshold %
    if (profitBuild > profitBuy && marginGainPct >= threshold) {
      buildSelfOverrides[typeId] = true;
    } else {
      buildSelfOverrides[typeId] = false;
    }
  }

  // Re-apply final optimal tree state
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