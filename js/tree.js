'use strict';

// Centralized HTML Escaper and JSON Parser Helpers are loaded globally from js/config.js

// Structural helper to recursively search and extract the output batch yield/quantity of a product in any recipe format
function extractSdeYield(recipe, targetProductTypeId) {
  if (!recipe) return 1;

  const pId = parseInt(targetProductTypeId);
  if (isNaN(pId)) return 1;

  // 1. Direct root-level yield property candidates
  const rootCandidates = [
    recipe.productQtyPerRun,
    recipe.mfgQtyPerRun,
    recipe.reactionQtyPerRun,
    recipe.outputQty,
    recipe.portionSize,
    recipe.qty,
    recipe.productQty,
    recipe.pQty,
    recipe.yield,
    recipe.batchYield,
    recipe.amount,
    recipe.qtyPerRun
  ];
  for (const c of rootCandidates) {
    const val = parseInt(c);
    if (!isNaN(val) && val > 1) return val;
  }

  // 2. If recipe contains a "products" block (array or dictionary)
  if (recipe.products) {
    if (Array.isArray(recipe.products)) {
      for (const p of recipe.products) {
        if (!p) continue; // Defensive guard
        const itemType = parseInt(p.typeID || p.typeId || p.id || p.productTypeID);
        if (itemType === pId) {
          const val = parseInt(p.quantity || p.qty || p.amount || p.yield);
          if (!isNaN(val) && val > 0) return val;
        }
      }
    } else if (typeof recipe.products === 'object') {
      const directVal = recipe.products[pId] || recipe.products[String(pId)];
      if (directVal !== undefined) {
        if (typeof directVal === 'number') return directVal;
        if (typeof directVal === 'object' && directVal !== null) {
          const val = parseInt(directVal.quantity || directVal.qty || directVal.amount);
          if (!isNaN(val) && val > 0) return val;
        }
      }
      for (const key of Object.keys(recipe.products)) {
        const p = recipe.products[key];
        if (p && typeof p === 'object') {
          const itemType = parseInt(p.typeID || p.typeId || p.id || p.productTypeID || key);
          if (itemType === pId) {
            const val = parseInt(p.quantity || p.qty || p.amount);
            if (!isNaN(val) && val > 0) return val;
          }
        }
      }
    }
  }

  // 3. If recipe contains an "activityProducts" block (common database/fuzzwork schema)
  if (recipe.activityProducts && typeof recipe.activityProducts === 'object') {
    for (const actKey of Object.keys(recipe.activityProducts)) {
      const products = recipe.activityProducts[actKey];
      if (Array.isArray(products)) {
        for (const p of products) {
          if (!p) continue; // Defensive guard
          const itemType = parseInt(p.typeID || p.typeId || p.id || p.productTypeID);
          if (itemType === pId) {
            const val = parseInt(p.quantity || p.qty || p.amount);
            if (!isNaN(val) && val > 0) return val;
          }
        }
      } else if (products && typeof products === 'object') {
        const directVal = products[pId] || products[String(pId)];
        if (directVal !== undefined) {
          if (typeof directVal === 'number') return directVal;
          if (typeof directVal === 'object' && directVal !== null) {
            const val = parseInt(directVal.quantity || directVal.qty || directVal.amount);
            if (!isNaN(val) && val > 0) {
              foundYield = val;
              return;
            }
          }
        }
      }
    }
  }

  // 4. Fallback: Deep search the entire object structure for references to targetProductTypeId
  let foundYield = null;
  function deepSearch(obj) {
    if (foundYield !== null) return;
    if (!obj || typeof obj !== 'object') return;

    if (Array.isArray(obj)) {
      for (const item of obj) {
        deepSearch(item);
      }
    } else {
      const itemType = parseInt(obj.typeID || obj.typeId || obj.id || obj.productTypeID);
      if (itemType === pId) {
        const val = parseInt(obj.quantity || obj.qty || obj.amount || obj.yield);
        if (!isNaN(val) && val > 0) {
          foundYield = val;
          return;
        }
      }

      const directVal = obj[pId] || obj[String(pId)];
      if (directVal !== undefined) {
        if (typeof directVal === 'number' && directVal > 1) { // Greater than 1 to avoid matching Type IDs
          foundYield = directVal;
          return;
        } else if (typeof directVal === 'object' && directVal !== null) {
          const val = parseInt(directVal.quantity || directVal.qty || directVal.amount);
          if (!isNaN(val) && val > 0) {
            foundYield = val;
            return;
          }
        }
      }

      for (const key of Object.keys(obj)) {
        // Skip scanning materials to avoid picking up input requirements instead of output quantities
        if (key === 'materials' || key === 'mfgMaterials' || key === 'reactionMaterials' || key === 'mats' || key === 'm') {
          continue;
        }
        deepSearch(obj[key]);
      }
    }
  }

  deepSearch(recipe);
  if (foundYield !== null) return foundYield;

  // 5. Final fallback to any root quantity field
  const fallbackVal = parseInt(recipe.quantity);
  if (!isNaN(fallbackVal) && fallbackVal > 0) return fallbackVal;

  return 1;
}

// Strict SDE Batch Yield Extractor (Uses exact database output quantity)
function getBatchYield(recipe, isReaction) {
  if (!recipe) return 1;

  if (typeof window.extractRecipeYield === 'function') {
    const explicit = window.extractRecipeYield(recipe);
    if (explicit > 1) return explicit;
  }

  const typeId = recipe.productTypeID || recipe.product || recipe.p || recipe.typeID;
  const sdeYield = extractSdeYield(recipe, typeId);
  if (sdeYield > 1) {
    return sdeYield;
  }

  // Fallback check on item names / IDs for known SDE batch yield standards
  const name = ((recipe.productName || '') + ' ' + (recipe.blueprintTypeName || '')).toLowerCase();

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
  if (node.productTypeId) typeIds.add(node.productTypeId);
  if (node.children) {
    node.children.forEach(child => collectAllTypeIds(child, typeIds));
  }
  return typeIds;
}

// Watertight list mapping blueprint IDs directly to their manufactured product IDs
const BLUEPRINT_TO_PRODUCT_MAP = {
  57523: 57486, // Life Support Backup Unit Blueprint -> Life Support Backup Unit
  57515: 57478, // Auto-Integrity Preservation Seal Blueprint -> Auto-Integrity Preservation Seal
  57516: 57479, // Core Temperature Regulator Blueprint -> Core Temperature Regulator
  17714: 17715  // Gila Blueprint -> Gila
};

// O(1) Fast SDE Reverse Lookup to find a Blueprint Type ID for a given manufactured item Product ID
function findBlueprintTypeIdForProduct(productTypeId) {
  const pId = parseInt(productTypeId);
  if (isNaN(pId)) return null;

  // 1. Direct index match
  if (window.recipeMap && window.recipeMap[pId]) {
    const recipe = window.recipeMap[pId];
    const bpId = recipe.blueprintTypeID || recipe.bp || recipe.bpId;
    if (bpId && parseInt(bpId) !== pId) {
      return parseInt(bpId);
    }
  }

  if (window.EVE_RECIPES && window.EVE_RECIPES[pId]) {
    const recipe = window.EVE_RECIPES[pId];
    const bpId = recipe.blueprintTypeID || recipe.bp || recipe.bpId;
    if (bpId && parseInt(bpId) !== pId) {
      return parseInt(bpId);
    }
  }

  // 2. Loop match fallback
  if (window.recipeMap) {
    for (const [key, r] of Object.entries(window.recipeMap)) {
      if (r) {
        const currentPId = r.productTypeID || r.product || r.p || r.pId;
        if (parseInt(currentPId) === pId) {
          const bpId = r.blueprintTypeID || r.bp || r.bpId || key;
          if (bpId && parseInt(bpId) !== pId) {
            return parseInt(bpId);
          }
        }
      }
    }
  }

  return null;
}
window.findBlueprintTypeIdForProduct = findBlueprintTypeIdForProduct;

async function fetchBlueprintData(typeId) {
  if (blueprintCache[typeId] !== undefined) {
    return blueprintCache[typeId];
  }

  if (RAW_BASE_MATERIALS && RAW_BASE_MATERIALS.has(typeId)) {
    blueprintCache[typeId] = null;
    return null;
  }

  // 1. Check direct key in recipeMap (LOCAL SDE DATABASE)
  if (recipeMap && recipeMap[typeId]) {
    blueprintCache[typeId] = recipeMap[typeId];
    return recipeMap[typeId];
  }

  // 2. Check direct key in window.EVE_RECIPES
  if (window.EVE_RECIPES && window.EVE_RECIPES[typeId]) {
    const recipe = window.EVE_RECIPES[typeId];
    blueprintCache[typeId] = recipe;
    return recipe;
  }

  // 3. Check direct key in BUILTIN_RECIPES (Fallback stubs)
  if (BUILTIN_RECIPES && BUILTIN_RECIPES[typeId]) {
    blueprintCache[typeId] = BUILTIN_RECIPES[typeId];
    return BUILTIN_RECIPES[typeId];
  }

  // 4. Search recipeMap for matching product or blueprint type ID
  if (window.recipeMap) {
    for (const r of Object.values(window.recipeMap)) {
      if (r && (r.blueprintTypeID === typeId || r.productTypeID === typeId || r.bp === typeId || r.product === typeId || r.p === typeId || r.result === typeId || r.output === typeId)) {
        blueprintCache[typeId] = r;
        return r;
      }
    }
  }

  // 5. Search window.EVE_RECIPES for matching product or blueprint type ID
  if (window.EVE_RECIPES) {
    for (const r of Object.values(window.EVE_RECIPES)) {
      if (r && (r.blueprintTypeID === typeId || r.productTypeID === typeId || r.bp === typeId || r.product === typeId || r.p === typeId || r.result === typeId || r.output === typeId)) {
        blueprintCache[typeId] = r;
        return r;
      }
    }
  }

  // 6. Fallback to external API (with exact activityProducts batch yield extraction)
  const tryTypeIds = [typeId];
  for (const targetId of tryTypeIds) {
    const fuzzworkUrl = `https://www.fuzzwork.co.uk/blueprint/api/blueprint.php?typeid=${targetId}`;
    const tryUrls = [
      fuzzworkUrl,
      `https://corsproxy.io/?${encodeURIComponent(fuzzworkUrl)}`
    ];

    for (const url of tryUrls) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2500);

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

            let outputBatchYield = parseInt(data.productQtyPerRun) || parseInt(data.portionSize) || 1;
            if (data.activityProducts && typeof data.activityProducts === 'object') {
              const act1 = data.activityProducts['1'] || data.activityProducts[1];
              const act11 = data.activityProducts['11'] || data.activityProducts[11];
              if (act1 && act1[0] && act1[0].quantity) {
                outputBatchYield = parseInt(act1[0].quantity);
              } else if (act11 && act11[0] && act11[0].quantity) {
                outputBatchYield = parseInt(act11[0].quantity);
              }
            }

            if (mfgMat || reactionMat) {
              const parsed = {
                blueprintTypeID: data.blueprintTypeID,
                blueprintTypeName: data.blueprintTypeName || '',
                productTypeID: parseInt(data.productTypeID) || typeId,
                productName: data.productTypeName || '',
                activityProducts: data.activityProducts || null,
                productQtyPerRun: outputBatchYield,
                mfgQtyPerRun: outputBatchYield,
                portionSize: outputBatchYield,
                batchYield: outputBatchYield,
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

// Parallel Multi-Layer SDE Blueprint-Centric Tree Generator
async function buildRecursiveRecipeTree(blueprintTypeId, name, qtyNeeded, currentDepth, maxDepth, visitedPath = new Set(), parentNode = null) {
  const defaultBuildState = (currentDepth === 0) ? true : false;
  const isBuildingSelf = (buildSelfOverrides[blueprintTypeId] !== undefined) ? buildSelfOverrides[blueprintTypeId] : defaultBuildState;

  const defaultME = 0;
  const defaultTE = 0;

  const node = {
    instanceId: ++instanceCounter,
    parentInstanceId: parentNode ? parentNode.instanceId : null,
    typeId: blueprintTypeId, // This is the Blueprint ID (e.g., 622)
    displayTypeId: blueprintTypeId,
    productTypeId: BLUEPRINT_TO_PRODUCT_MAP[blueprintTypeId] || null,     // Physical item manufactured (e.g., 621)
    name: name,              // Blueprint Name (e.g., "Caracal Blueprint")
    productName: '',         // Manufactured Item Name (e.g., "Caracal")
    qtyNeeded: qtyNeeded,    // Quantity of physical product needed by parent
    depth: currentDepth,
    recipe: null,
    children: [],
    isManufacturable: false,
    isReaction: false,
    batchYield: 1,
    runsNeeded: 1,
    isBuildingSelf: isBuildingSelf,
    customME: customMEOverrides[blueprintTypeId] !== undefined ? customMEOverrides[blueprintTypeId] : defaultME,
    customTE: customTEOverrides[blueprintTypeId] !== undefined ? customTEOverrides[blueprintTypeId] : defaultTE,
    unitEIV: 0,
    jobEIV: 0,
    jobFee: 0
  };

  try {
    const recipe = await fetchBlueprintData(blueprintTypeId);
    if (recipe) {
      node.productTypeId = recipe.productTypeID || recipe.product || recipe.p || BLUEPRINT_TO_PRODUCT_MAP[blueprintTypeId] || blueprintTypeId;
      node.productName = recipe.productName || window.TYPE_ID_TO_NAME[node.productTypeId] || '';
      node.isManufacturable = true;
      
      const allowReactions = document.getElementById('include-reactions')?.value === 'true';

      let rawMaterials = recipe.mfgMaterials || recipe.materials || recipe.mats || recipe.m;
      let isReaction = false;

      if ((!rawMaterials || rawMaterials.length === 0) && allowReactions && recipe.reactionMaterials && recipe.reactionMaterials.length > 0) {
        rawMaterials = recipe.reactionMaterials;
        isReaction = true;
      }

      if (rawMaterials && rawMaterials.length > 0) {
        const activeMaterials = [];
        const matMap = {};

        rawMaterials.forEach(m => {
          const tId = parseInt(m.typeId || m.typeid || m.id || m.materialTypeID);
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
        nextVisited.add(blueprintTypeId);
        if (node.productTypeId) {
          nextVisited.add(node.productTypeId);
        }

        const isCircular = visitedPath.has(blueprintTypeId) || (node.productTypeId && visitedPath.has(node.productTypeId));

        if (currentDepth < maxDepth && !isCircular && isBuildingSelf) {
          const childPromises = activeMaterials.map(async mat => {
            try {
              const childQty = calculateInputQuantity(mat.baseQty, runsNeeded, me, facility, isReaction);
              const childBlueprintTypeId = findBlueprintTypeIdForProduct(mat.typeId);

              if (childBlueprintTypeId) {
                // Child is manufacturable: Recurse on its Blueprint!
                return await buildRecursiveRecipeTree(childBlueprintTypeId, mat.name + ' Blueprint', childQty, currentDepth + 1, maxDepth, nextVisited, node);
              } else {
                // Child is raw/unmanufacturable: Create terminal leaf node
                return {
                  instanceId: ++instanceCounter,
                  parentInstanceId: node.instanceId,
                  typeId: mat.typeId,
                  displayTypeId: mat.typeId,
                  name: mat.name,
                  qtyNeeded: childQty,
                  depth: currentDepth + 1,
                  children: [],
                  isManufacturable: false,
                  isBuildingSelf: false
                };
              }
            } catch (err) {
              return {
                instanceId: ++instanceCounter,
                parentInstanceId: node.instanceId,
                typeId: mat.typeId,
                displayTypeId: mat.typeId,
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
    // Determine the product ID to match the recipe materials array correctly
    const childProductTypeId = child.productTypeId || child.typeId;
    
    const mat = Array.isArray(node.recipe.materials) ? node.recipe.materials.find(m => m.typeId === childProductTypeId) : null;
    if (mat) {
      child.qtyNeeded = calculateInputQuantity(mat.baseQty, runsNeeded, effectiveME, facility, node.isReaction);
    }
    scaleTreeQuantities(child, facility);
  });
}