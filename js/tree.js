'use strict';

// Strict SDE Batch Yield Extractor (Uses exact database output quantity)
function getBatchYield(recipe, isReaction) {
  if (!recipe) return 1;

  // Read explicit yield directly from the database record
  const explicitQty = recipe.productQtyPerRun || recipe.mfgQtyPerRun || recipe.reactionQtyPerRun || recipe.outputQty || recipe.portionSize || recipe.quantity || recipe.products?.[0]?.quantity;
  if (explicitQty && parseInt(explicitQty) > 0) {
    return parseInt(explicitQty);
  }

  // Fallback ONLY if the database record lacks an output quantity
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

  // SHORT-CIRCUIT: If prepacked local DB is loaded, any item not in recipeMap is a raw base material!
  if ((window.EVE_RECIPES && Object.keys(window.EVE_RECIPES).length > 20) || (window.EVE_ITEMS && Object.keys(window.EVE_ITEMS).length > 50)) {
    blueprintCache[typeId] = null;
    return null;
  }

  const tryTypeIds = [typeId];
  const popMatch = POPULAR_ITEMS ? POPULAR_ITEMS.find(p => p.id === typeId || p.bpId === typeId) : null;
  if (popMatch && popMatch.bpId && !tryTypeIds.includes(popMatch.bpId)) {
    tryTypeIds.unshift(popMatch.bpId);
  }

  for (const targetId of tryTypeIds) {
    const fuzzworkUrl = `https://www.fuzzwork.co.uk/blueprint/api/blueprint.php?typeid=${targetId}`;
    const tryUrls = [
      fuzzworkUrl,
      `https://corsproxy.io/?${encodeURIComponent(fuzzworkUrl)}`
    ];

    for (const url of tryUrls) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2000);

        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);

        if (res.ok) {
          const data = await res.json();
          if (data && data.activityMaterials && typeof data.activityMaterials === 'object') {
            const mfgMat = data.activityMaterials['1'] ? data.activityMaterials['1'].map(m => ({
              typeId: parseInt(m.typeid),
              name: m.name,
              baseQty: parseInt(m.quantity)
            })) : null;

            const reactionMat = data.activityMaterials['11'] ? data.activityMaterials['11'].map(m => ({
              typeId: parseInt(m.typeid),
              name: m.name,
              baseQty: parseInt(m.quantity)
            })) : null;

            if (mfgMat || reactionMat) {
              const parsed = {
                blueprintTypeID: data.blueprintTypeID,
                blueprintTypeName: data.blueprintTypeName || '',
                productTypeID: parseInt(data.productTypeID) || typeId,
                productName: data.productTypeName || '',
                activityProducts: data.activityProducts || null,
                productQtyPerRun: parseInt(data.productQtyPerRun) || 1,
                mfgQtyPerRun: parseInt(data.productQtyPerRun) || 1,
                time: data.time || 0,
                mfgMaterials: mfgMat,
                reactionMaterials: reactionMat
              };

              blueprintCache[typeId] = parsed;
              if (parsed.productTypeID) blueprintCache[parsed.productTypeID] = parsed;
              if (parsed.blueprintTypeID) blueprintCache[parsed.blueprintTypeID] = parsed;
              return parsed;
            }
          }
        }
      } catch (e) {
        // Try next
      }
    }
  }

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
      node.displayTypeId = recipe.productTypeID || typeId;
      node.isManufacturable = true;
      
      const allowReactions = document.getElementById('include-reactions')?.value === 'true';

      let rawMaterials = recipe.mfgMaterials || recipe.materials;
      let isReaction = false;

      if (!rawMaterials && allowReactions && recipe.reactionMaterials) {
        rawMaterials = recipe.reactionMaterials;
        isReaction = true;
      }

      if (rawMaterials && rawMaterials.length > 0) {
        // CONSOLIDATE & DE-DUPLICATE SDE RECIPE MATERIALS:
        // Keeps unique typeIDs with their true single quantity (e.g. 11), preventing double-counting to 22
        const activeMaterials = [];
        const matMap = {};

        rawMaterials.forEach(m => {
          const tId = parseInt(m.typeId || m.typeid);
          const qty = parseInt(m.baseQty || m.quantity || 1);
          const matName = m.name || (window.TYPE_ID_TO_NAME ? window.TYPE_ID_TO_NAME[tId] : '') || 'Material';

          if (matMap[tId]) {
            matMap[tId].baseQty = Math.max(matMap[tId].baseQty, qty); // Keeps single true quantity (11)
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

        node.recipe = { ...recipe, materials: activeMaterials };
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