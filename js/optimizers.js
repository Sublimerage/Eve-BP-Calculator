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

// Optimizer 1: Component Spread Optimizer
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
          customBuyModes[typeId] = 'buy';  // Worth placing a Buy Order!
        } else {
          customBuyModes[typeId] = 'sell'; // Spread too small, buy instant off Sell Orders!
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

// Optimizer 2: Budget Impact Optimizer
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
          customBuyModes[typeId] = 'buy';  // Moves the needle on total budget!
        } else {
          customBuyModes[typeId] = 'sell'; // Minor impact, buy instant off Sell Orders!
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