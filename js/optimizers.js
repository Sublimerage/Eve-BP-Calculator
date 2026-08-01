'use strict';

// --- Action: Recursive Helper to Sync UI Overrides to Tree Structure ---
function syncTreeBuildStates(node) {
  if (!node) return;
  const defaultBuildState = (node.depth === 0) ? true : false;
  node.isBuildingSelf = (window.buildSelfOverrides[node.typeId] !== undefined) ? window.buildSelfOverrides[node.typeId] : defaultBuildState;
  
  if (node.displayTypeId && window.buildSelfOverrides[node.displayTypeId] !== undefined) {
    node.isBuildingSelf = window.buildSelfOverrides[node.displayTypeId];
  }

  if (node.children) {
    node.children.forEach(child => syncTreeBuildStates(child));
  }
}

// --- Action: Toggle Component Build / Buy Mode ---
async function toggleBuildSelf(e, typeId) {
  if (e) e.stopPropagation();
  const currentState = (window.buildSelfOverrides[typeId] !== undefined) ? window.buildSelfOverrides[typeId] : false;
  window.buildSelfOverrides[typeId] = !currentState;
  if (window.currentProduct) {
    await window.selectItem(window.currentProduct.id, window.currentProduct.name, true);
  }
}

// --- Action: Per-Card ME / TE Inputs ---
function onCardMEChange(e, typeId, instanceId) {
  if (e) e.stopPropagation();
  const val = Math.max(0, Math.min(10, parseFloat(e.target.value) || 0));
  window.customMEOverrides[typeId] = val;
  if (window.currentProduct) {
    window.selectItem(window.currentProduct.id, window.currentProduct.name, true);
  }
}

// --- Action: Per-Card TE Change ---
function onCardTEChange(e, typeId, instanceId) {
  if (e) e.stopPropagation();
  const val = Math.max(0, Math.min(20, parseFloat(e.target.value) || 0));
  window.customTEOverrides[typeId] = val;
  if (typeof window.recalculate === 'function') {
    window.recalculate();
  }
}

// --- Action: Build All Sub-Components ---
async function buildAllComponents() {
  function markAllBuild(node) {
    if (!node) return;
    if (node.isManufacturable) {
      window.buildSelfOverrides[node.typeId] = true;
      if (node.displayTypeId) window.buildSelfOverrides[node.displayTypeId] = true;
    }
    if (node.children) {
      node.children.forEach(c => markAllBuild(c));
    }
  }

  if (window.recipeTreeRoot) {
    markAllBuild(window.recipeTreeRoot);
    if (window.currentProduct) {
      await window.selectItem(window.currentProduct.id, window.currentProduct.name, true);
    }
  }
}

// --- Action: Buy All Sub-Components ---
async function buyAllSubComponents() {
  window.buildSelfOverrides = {};
  if (window.currentProduct) {
    await window.selectItem(window.currentProduct.id, window.currentProduct.name, true);
  }
  window.applyComponentSpreadOptimizer();
}

// --- Action: Reset Smart Buy Override Modes ---
function resetSmartBuyModes() {
  window.customBuyModes = {};
  if (typeof window.recalculate === 'function') {
    window.recalculate();
  }
}

// Optimizer 1: True Greedy Build vs Buy Profit Margin Optimizer
async function applyBuildProfitOptimizer() {
  const inputThreshold = parseFloat(document.getElementById('build-profit-threshold')?.value);
  const threshold = isNaN(inputThreshold) ? 5.0 : Math.max(0, inputThreshold);

  if (!window.recipeTreeRoot) return;

  // Pre-fetch market prices for all type IDs before evaluating build margins
  const allTypeIds = new Set();
  if (typeof window.collectAllTypeIds === 'function') {
    window.collectAllTypeIds(window.recipeTreeRoot, allTypeIds);
    await window.fetchMarketPrices(Array.from(allTypeIds));
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
  collectManufacturableNodes(window.recipeTreeRoot);

  const facilityTax = (parseFloat(document.getElementById('facility-tax')?.value) || 1.0) / 100;
  const sccSurcharge = (parseFloat(document.getElementById('scc-surcharge')?.value) || 4.0) / 100;
  const structureType = window.getActiveStructureType ? window.getActiveStructureType() : { costBonus: 5.0, meBonus: 1.0 };
  const structureRoleBonus = structureType.costBonus / 100;
  const facility = structureType.meBonus / 100;
  const brokerFee = (parseFloat(document.getElementById('broker-fee')?.value) || 1.0) / 100;

  // Helper to run a silent simulation test for profit under given build overrides
  function simulateProfit() {
    syncTreeBuildStates(window.recipeTreeRoot);
    if (typeof window.scaleTreeQuantities === 'function') {
      window.scaleTreeQuantities(window.recipeTreeRoot, facility);
    }
    if (typeof window.calculateNodeEIV === 'function') {
      window.calculateNodeEIV(window.recipeTreeRoot);
    }

    let matCost = 0;
    if (window.recipeTreeRoot.isBuildingSelf && window.recipeTreeRoot.children && window.recipeTreeRoot.children.length > 0) {
      window.recipeTreeRoot.children.forEach(child => {
        matCost += calculateTreeNodeCost(child);
      });
    } else {
      const productTypeId = window.recipeTreeRoot.productTypeId || window.recipeTreeRoot.typeId;
      const rootPrices = window.priceCache[productTypeId] || { sell: 0, buy: 0 };
      matCost = (rootPrices.sell || rootPrices.buy || 0) * window.recipeTreeRoot.qtyNeeded;
    }

    const jobFees = calculateNodeJobFee(window.recipeTreeRoot, facilityTax, sccSurcharge, structureRoleBonus);
    const totalCost = matCost + jobFees;

    const productTypeId = window.recipeTreeRoot.productTypeId || window.recipeTreeRoot.typeId;
    const outputPrices = window.priceCache[productTypeId] || { sell: 0, buy: 0 };
    const grossSell = outputPrices.sell * window.recipeTreeRoot.qtyNeeded;
    const salesTax = (parseFloat(document.getElementById('sales-tax')?.value) || 3.6) / 100;
    const netSell = grossSell * (1 - salesTax - brokerFee);

    return netSell - totalCost;
  }

  // Test building vs buying for each sub-component from bottom-up
  for (const typeId of Array.from(manufacturableTypeIds)) {
    window.buildSelfOverrides[typeId] = false;
    const profitBuy = simulateProfit();

    window.buildSelfOverrides[typeId] = true;
    const profitBuild = simulateProfit();

    const profitGain = profitBuild - profitBuy;
    // % impact measured against the whole build's total cost - matches the Budget Impact optimizer's
    // approach. The previous version normalized against this component's unit price times the ROOT's
    // quantity (often just 1, for a single ship), a denominator with no real connection to the actual
    // scale of the decision, which produced near-arbitrary percentages and made the threshold check
    // effectively meaningless.
    const rootTotalCost = window.recipeTreeRoot.calculatedCost || 1;
    const marginGainPct = rootTotalCost > 0 ? (profitGain / rootTotalCost) * 100 : 0;

    // Only keep BUILD mode if building actually INCREASES net profit by >= threshold %
    if (profitBuild > profitBuy && marginGainPct >= threshold) {
      window.buildSelfOverrides[typeId] = true;
    } else {
      window.buildSelfOverrides[typeId] = false;
    }
  }

  // Re-apply final optimal tree state
  if (window.currentProduct) {
    await window.selectItem(window.currentProduct.id, window.currentProduct.name, true);
  }
}

// Optimizer 2: Component Market Spread Threshold
function applyComponentSpreadOptimizer() {
  const inputThreshold = parseFloat(document.getElementById('buy-savings-threshold')?.value);
  const threshold = isNaN(inputThreshold) ? 5.0 : Math.max(0, inputThreshold);

  function optimizeNode(node) {
    if (!node) return;
    
    if (!node.isBuildingSelf || !node.children || node.children.length === 0) {
      const typeId = node.displayTypeId || node.typeId;
      // Use the tree-resolved productTypeId (never the blueprint's own id) for pricing.
      const productTypeId = node.productTypeId || typeId;
      const prices = window.priceCache[productTypeId] || { sell: 0, buy: 0 };
      
      if (prices.sell > 0 && prices.buy > 0 && prices.sell > prices.buy) {
        const spreadPct = ((prices.sell - prices.buy) / prices.sell) * 100;
        if (spreadPct >= threshold) {
          window.customBuyModes[typeId] = 'buy';  // Market spread is large enough: place a Buy Order!
        } else {
          window.customBuyModes[typeId] = 'sell'; // Market spread is small: buy instantly off Sell Orders!
        }
      } else {
        window.customBuyModes[typeId] = 'sell'; 
      }
    }

    if (node.children) {
      node.children.forEach(child => optimizeNode(child));
    }
  }

  if (window.recipeTreeRoot) {
    optimizeNode(window.recipeTreeRoot);
    if (typeof window.recalculate === 'function') window.recalculate();
  }
}

// Optimizer 3: Build Cost Savings Impact Threshold
function applyBudgetImpactOptimizer() {
  const inputThreshold = parseFloat(document.getElementById('total-cost-savings-threshold')?.value);
  const threshold = isNaN(inputThreshold) ? 1.0 : Math.max(0, inputThreshold);

  function optimizeNode(node) {
    if (!node) return;
    
    if (!node.isBuildingSelf || !node.children || node.children.length === 0) {
      const typeId = node.displayTypeId || node.typeId;
      // Use the tree-resolved productTypeId (never the blueprint's own id) for pricing.
      const productTypeId = node.productTypeId || typeId;
      const prices = window.priceCache[productTypeId] || { sell: 0, buy: 0 };
      
      const deductModeInput = document.getElementById('deduct-stock-mode');
      const isStockDeductEnabled = deductModeInput ? deductModeInput.value === 'true' : true;
      const stockQty = isStockDeductEnabled ? (window.userStockMap[productTypeId] || window.userStockMap[node.typeId] || 0) : 0;
      const netQtyNeeded = Math.max(0, node.qtyNeeded - stockQty);

      const sellTotal = prices.sell * netQtyNeeded;
      const buyTotal = prices.buy * netQtyNeeded;

      if (sellTotal > 0 && buyTotal > 0 && sellTotal > buyTotal) {
        const rootTotalCost = window.recipeTreeRoot?.calculatedCost || 1;
        const budgetImpactPct = rootTotalCost > 0 ? ((sellTotal - buyTotal) / rootTotalCost) * 100 : 0;

        if (budgetImpactPct >= threshold) {
          window.customBuyModes[typeId] = 'buy';  // Saves enough on overall budget: place a Buy Order!
        } else {
          window.customBuyModes[typeId] = 'sell'; // Minor impact on total budget: buy off Sell Orders!
        }
      } else {
        window.customBuyModes[typeId] = 'sell';
      }
    }

    if (node.children) {
      node.children.forEach(child => optimizeNode(child));
    }
  }

  if (window.recipeTreeRoot) {
    optimizeNode(window.recipeTreeRoot);
    if (typeof window.recalculate === 'function') window.recalculate();
  }
}

function setComponentBuyMode(e, typeId, mode) {
  if (e) e.stopPropagation();
  window.customBuyModes[typeId] = mode;
  if (typeof window.recalculate === 'function') window.recalculate();
}

function getNodePriceStrategy(node) {
  const globalStrategy = document.getElementById('input-price-mode')?.value || 'sell';
  return window.customBuyModes[node.typeId] || globalStrategy;
}

function calculateTreeNodeCost(node) {
  const deductModeInput = document.getElementById('deduct-stock-mode');
  const isStockDeductEnabled = deductModeInput ? deductModeInput.value === 'true' : true;
  const productTypeId = node.productTypeId || node.typeId;
  const stockQty = isStockDeductEnabled ? (window.userStockMap[productTypeId] || window.userStockMap[node.typeId] || 0) : 0;
  const netNeededQty = Math.max(0, node.qtyNeeded - stockQty);

  if (!node.isBuildingSelf || !node.children || node.children.length === 0) {
    const strategy = getNodePriceStrategy(node);
    const prices = window.priceCache[productTypeId] || { sell: 0, buy: 0 };
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

  const sci = node.isReaction ? window.activeReactSCI : window.activeMfgSCI;
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

// Explicit window bindings
window.syncTreeBuildStates = syncTreeBuildStates;
window.toggleBuildSelf = toggleBuildSelf;
window.onCardMEChange = onCardMEChange;
window.onCardTEChange = onCardTEChange;
window.buildAllComponents = buildAllComponents;
window.buyAllSubComponents = buyAllSubComponents;
window.resetSmartBuyModes = resetSmartBuyModes;
window.applyBuildProfitOptimizer = applyBuildProfitOptimizer;
window.applyComponentSpreadOptimizer = applyComponentSpreadOptimizer;
window.applyBudgetImpactOptimizer = applyBudgetImpactOptimizer;
window.setComponentBuyMode = setComponentBuyMode;
window.getNodePriceStrategy = getNodePriceStrategy;
window.calculateTreeNodeCost = calculateTreeNodeCost;
window.calculateNodeJobFee = calculateNodeJobFee;