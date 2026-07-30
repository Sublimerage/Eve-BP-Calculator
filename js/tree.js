'use strict';

// Strict SDE Batch Yield Extractor (Uses exact database output quantity)
function getBatchYield(recipe, isReaction) {
  if (!recipe) return 1;

  if (typeof window.extractRecipeYield === 'function') {
    const explicit = window.extractRecipeYield(recipe);
    if (explicit > 1) return explicit;
  }

  // 1. Read explicit yield directly from all possible database record properties
  const candidates = [
    recipe.productQtyPerRun,
    recipe.mfgQtyPerRun,
    recipe.reactionQtyPerRun,
    recipe.outputQty,
    recipe.portionSize,
    recipe.quantity,
    recipe.qty,
    recipe.productQty,
    recipe.pQty,
    recipe.yield,
    recipe.batchYield,
    recipe.amount,
    recipe.qtyPerRun,
    recipe.products?.[0]?.quantity,
    recipe.products?.[0]?.qty,
    recipe.activityProducts?.[1]?.[0]?.quantity,
    recipe.activityProducts?.[11]?.[0]?.quantity,
    recipe.activityProducts?.['1']?.[0]?.quantity,
    recipe.activityProducts?.['11']?.[0]?.quantity
  ];

  for (const c of candidates) {
    const parsed = parseInt(c);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }

  // 2. Fallback check on item names / IDs for known SDE batch yield standards
  const name = ((recipe.productName || '') + ' ' + (recipe.blueprintTypeName || '')).toLowerCase();
  const typeId = recipe.productTypeID || recipe.typeID;

  if (typeId === 16681 || typeId === 16680 || typeId === 16679 || name.includes('carbide')) {
    return 10000;
  }

  if (name.includes('fuel block')) return 40;
  if (name.includes('nanite repair paste')) return 500;
  if (name.includes('auto-integrity preservation seal') || name.includes('life support backup unit')) return 3;
  if (name.includes('cap booster') || name.includes('interdiction probe') || name.includes('scanner probe')) return 10;
  if (name.includes('charge') || name.includes('frequency crystal') || name.includes('missile') || name.includes('torpedo') || name.includes('rocket') || name.includes('ammo')) return 100;
  if (isReaction || name.includes('reaction') || name.includes('polymer') || name.includes('ferrogel')) return 200;

  return 1;
}

function collectAllTypeIds(node, typeIds = new Set()) {
  if (!node) return typeIds;
  if (node.typeId) typeIds.add(node.typeId);
  if (node.displayTypeId) typeIds.add(node.displayTypeId);
  if (node.children) {
    node.children.forEach(child => collectAllTypeIds(child, typeIds));
  }
  return typeIds;
}

async function fetchBlueprintData(typeId) {
  if (blueprintCache[typeId] !== undefined) {
    return blueprintCache[typeId];
  }

  if (RAW_BASE_MATERIALS && RAW_BASE_MATERIALS.has(typeId)) {
    blueprintCache[typeId] = null;
    return null;
  }

  if (BUILTIN_RECIPES && BUILTIN_RECIPES[typeId]) {
    blueprintCache[typeId] = BUILTIN_RECIPES[typeId];
    return BUILTIN_RECIPES[typeId];
  }

  if (recipeMap && recipeMap[typeId]) {
    blueprintCache[typeId] = recipeMap[typeId];
    return recipeMap[typeId];
  }

  if (window.EVE_RECIPES && window.EVE_RECIPES[typeId]) {
    const recipe = window.EVE_RECIPES[typeId];
    blueprintCache[typeId] = recipe;
    return recipe;
  }

  // Pure Offline DB Lookup: If item is not in local EVE_RECIPES/recipeMap, it is a raw base material
  blueprintCache[typeId] = null;
  return null;
}

// Parallel Multi-Layer Tree Generator with Default ME = 0% and TE = 0%
async function buildRecursiveRecipeTree(typeId, name, qtyNeeded, currentDepth, maxDepth, visitedPath = new Set(), parentNode = null) {
  const defaultBuildState = (currentDepth === 0) ? true : false;
  const isBuildingSelf = (buildSelfOverrides[typeId] !== undefined) ? buildSelfOverrides[typeId] : defaultBuildState;

  // Strict default ME = 0%, TE = 0%
  const defaultME = 0;
  const defaultTE = 0;

  const node = {
    instanceId: ++instanceCounter,
    parentInstanceId: parentNode ? parentNode.instanceId : null,
    typeId,
    displayTypeId: typeId,
    name,
    qtyNeeded,
    depth: currentDepth,
    recipe: null,
    children: [],
    isManufacturable: false,
    isReaction: false,
    batchYield: 1,
    runsNeeded: 1,
    isBuildingSelf: isBuildingSelf,
    customME: customMEOverrides[typeId] !== undefined ? customMEOverrides[typeId] : defaultME,
    customTE: customTEOverrides[typeId] !== undefined ? customTEOverrides[typeId] : defaultTE,
    unitEIV: 0,
    jobEIV: 0,
    jobFee: 0
  };

  try {
    const recipe = await fetchBlueprintData(typeId);
    if (recipe) {
      node.displayTypeId = recipe.productTypeID || recipe.product || recipe.p || typeId;
      node.isManufacturable = true;
      
      const allowReactions = document.getElementById('include-reactions')?.value === 'true';

      let rawMaterials = recipe.mfgMaterials || recipe.materials || recipe.mats || recipe.m;
      let isReaction = false;

      if ((!rawMaterials || rawMaterials.length === 0) && allowReactions && recipe.reactionMaterials && recipe.reactionMaterials.length > 0) {
        rawMaterials = recipe.reactionMaterials;
        isReaction = true;
      }

      if (rawMaterials && rawMaterials.length > 0) {
        // CONSOLIDATE & DE-DUPLICATE SDE RECIPE MATERIALS:
        // Keeps unique typeIDs with their true single quantity
        const activeMaterials = [];
        const matMap = {};

        rawMaterials.forEach(m => {
          const tId = parseInt(m.typeId || m.typeid || m.id);
          const qty = parseInt(m.baseQty || m.quantity || m.qty || 1);
          const matName = m.name || (window.TYPE_ID_TO_NAME ? window.TYPE_ID_TO_NAME[tId] : '') || 'Material';

          if (matMap[tId]) {
            matMap[tId].baseQty = Math.max(matMap[tId].baseQty, qty);
          } else {
            matMap[tId] = {
              typeId: tId,
              name: matName,
              baseQty: qty
            };
            activeMaterials.push(matMap[tId]);
          }
        });

        const batchYield = getBatchYield(recipe, isReaction);

        node.recipe = { ...recipe, materials: activeMaterials, productQtyPerRun: batchYield, portionSize: batchYield, batchYield: batchYield };
        node.isReaction = isReaction;
        node.batchYield = batchYield;

        const me = isReaction ? 0 : node.customME;
        const facility = document.getElementById('facility-select')?.value || '0.01';

        const runsNeeded = Math.ceil(qtyNeeded / batchYield);
        node.runsNeeded = runsNeeded;

        const nextVisited = new Set(visitedPath);
        nextVisited.add(typeId);

        if (currentDepth < maxDepth && !visitedPath.has(typeId) && isBuildingSelf) {
          const childPromises = activeMaterials.map(async mat => {
            try {
              const childQty = calculateInputQuantity(mat.baseQty, runsNeeded, me, facility, isReaction);
              return await buildRecursiveRecipeTree(mat.typeId, mat.name, childQty, currentDepth + 1, maxDepth, nextVisited, node);
            } catch (err) {
              return {
                instanceId: ++instanceCounter,
                parentInstanceId: node.instanceId,
                typeId: mat.typeId,
                name: mat.name,
                qtyNeeded: mat.baseQty,
                depth: currentDepth + 1,
                children: [],
                isManufacturable: false,
                isBuildingSelf: false
              };
            }
          });

          node.children = await Promise.all(childPromises);
        }
      }
    }
  } catch (err) {
    console.error('Tree error on node:', name, err);
  }

  return node;
}

function calculateInputQuantity(baseQty, runs, me, facilityBonus, isReaction = false) {
  const meFactor = isReaction ? 1.0 : (1 - me / 100);
  const facFactor = (1 - parseFloat(facilityBonus));
  
  const minQty = isReaction ? 1 : runs;
  return Math.max(minQty, Math.ceil(runs * baseQty * meFactor * facFactor));
}

function scaleTreeQuantities(node, facility) {
  if (!node.recipe || !node.children) return;

  const batchYield = node.batchYield || getBatchYield(node.recipe, node.isReaction) || 1;
  node.batchYield = batchYield;
  const runsNeeded = Math.ceil(node.qtyNeeded / batchYield);
  node.runsNeeded = runsNeeded;

  const effectiveME = node.isReaction ? 0 : (node.customME || 0);

  node.children.forEach(child => {
    const mat = node.recipe.materials.find(m => m.typeId === child.typeId);
    if (mat) {
      child.qtyNeeded = calculateInputQuantity(mat.baseQty, runsNeeded, effectiveME, facility, node.isReaction);
    }
    scaleTreeQuantities(child, facility);
  });
}
```.