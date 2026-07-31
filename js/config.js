'use strict';

// Centralized HTML Escaper Helper (Globally shared)
function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
window.esc = esc;

// Centralized JSON Parser Helper (Globally shared)
function safeParseJSON(str, fallback) {
  if (!str || str === 'undefined' || str === 'null') return fallback;
  try {
    const parsed = JSON.parse(str);
    return parsed !== null && parsed !== undefined ? parsed : fallback;
  } catch (e) {
    return fallback;
  }
}
window.safeParseJSON = safeParseJSON;

// Centralized Exact Duration Formatter (Displays precise Days, Hours, Minutes, and Seconds)
function formatDuration(seconds) {
  if (!seconds || isNaN(seconds) || seconds <= 0) return '0s';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (mins > 0) parts.push(`${mins}m`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);
  
  return parts.join(' ');
}
window.formatDuration = formatDuration;

// Hardcoded EVE Developer Application Client ID for instant 1-click SSO
window.HARDCODED_CLIENT_ID = '20e4087a1f564a3e897aaaa6daebbecd';

// Shared Lexical Global Declarations (Strict-mode compliant across all files)
var IDX = {};                  // Full Item Index (Keyed by lowercase name)
var TYPE_ID_TO_NAME = {};      // Fast O(1) Direct Lookup Index (Keyed by integer Type ID)
var SYSTEM_IDX = {};           // Full Solar System Index
var recipeMap = {};            // Dual-Key Recipe Map
var currentProduct = null;      // Selected root item metadata
var recipeTreeRoot = null;      // Recursive blueprint tree
var blueprintCache = {};        // Cached blueprint responses
var priceCache = {};            // Cached Jita 4-4 prices
var eivCache = {};              // Cached EVE ESI Adjusted Prices
var rawAssetItems = [];         // Raw ESI / Pasted asset records
var userStockMap = {};          // Filtered stock quantities
var systemNameCache = {};       // Cached system names
var resolvedLocationNames = {}; // Cached location names
var corpDivisionNames = {};     // Custom Corporation Hangar Division Names
var instanceCounter = 0;        // Node instance ID counter

// User Overrides State
var buildSelfOverrides = {};    // { typeId: boolean }
var customBuyModes = {};        // { typeId: 'sell' | 'buy' }
var customMEOverrides = {};     // { typeId: number }
var customTEOverrides = {};     // { typeId: number }

var selectedInstanceId = null;  
var isolatedInstanceId = null;  

// Live ESI System Cost Indices
var activeMfgSCI = 0.0425;
var activeReactSCI = 0.0110;

// Pan & Zoom State
var zoomScale = 1.0;
var panX = 0;
var panY = 0;
var isPanning = false;
var startX = 0;
var startY = 0;

// Explicitly attach to window for cross-module compatibility
window.IDX = IDX;
window.TYPE_ID_TO_NAME = TYPE_ID_TO_NAME;
window.SYSTEM_IDX = SYSTEM_IDX;
window.recipeMap = recipeMap;
window.currentProduct = currentProduct;
window.recipeTreeRoot = recipeTreeRoot;
window.blueprintCache = blueprintCache;
window.priceCache = priceCache;
window.eivCache = eivCache;
window.rawAssetItems = rawAssetItems;
window.userStockMap = userStockMap;
window.systemNameCache = systemNameCache;
window.resolvedLocationNames = resolvedLocationNames;
window.corpDivisionNames = corpDivisionNames;
window.instanceCounter = instanceCounter;
window.buildSelfOverrides = buildSelfOverrides;
window.customBuyModes = customBuyModes;
window.customMEOverrides = customMEOverrides;
window.customTEOverrides = customTEOverrides;
window.selectedInstanceId = selectedInstanceId;
window.isolatedInstanceId = isolatedInstanceId;
window.activeMfgSCI = activeMfgSCI;
window.activeReactSCI = activeReactSCI;
window.zoomScale = zoomScale;
window.panX = panX;
window.panY = panY;
window.isPanning = isPanning;
window.startX = startX;
window.startY = startY;

// Known Base Raw Materials
const RAW_BASE_MATERIALS = new Set([
  34, 35, 36, 37, 38, 39, 40, 11399, // Minerals
  16274, 16275, 17887, 17888,        // Isotopes
  16272, 16273,                      // Heavy Water, Liquid Ozone
  3689, 3683, 9848,                  // Coolant, Enriched Uranium, Robotics
  2267, 2268, 2270, 2272, 2305       // Gas / Ores
]);
window.RAW_BASE_MATERIALS = RAW_BASE_MATERIALS;

// Popular Items Map
const POPULAR_ITEMS = [
  { id: 48519, bpId: 49715, name: "Drekavac" },
  { id: 47271, bpId: 47968, name: "Leshak" },
  { id: 621,   bpId: 622,   name: "Caracal" },
  { id: 12005, bpId: 12006, name: "Ishtar" },
  { id: 587,   bpId: 588,   name: "Rifter" },
  { id: 24698, bpId: 24699, name: "Drake" },
  { id: 644,   bpId: 645,   name: "Raven" },
  { id: 642,   bpId: 643,   name: "Megathron" },
  { id: 643,   bpId: 644,   name: "Abaddon" },
  { id: 12015, bpId: 12016, name: "Dominix" },
  { id: 11987, bpId: 11988, name: "Cerberus" },
  { id: 11989, bpId: 11990, name: "Eagle" },
  { id: 4247,  bpId: 4248,  name: "Hydrogen Fuel Block" },
  { id: 4246,  bpId: 4248,  name: "Helium Fuel Block" },
  { id: 16681, bpId: 17730, name: "Tungsten Carbide" },
  { id: 34,    name: "Tritanium" },
  { id: 35,    name: "Pyerite" },
  { id: 36,    name: "Mexallon" },
  { id: 37,    name: "Isogen" },
  { id: 38,    name: "Nocxium" },
  { id: 39,    name: "Zydrine" },
  { id: 40,    name: "Megacyte" }
];
window.POPULAR_ITEMS = POPULAR_ITEMS;

// Built-in Popular Solar Systems Index
const POPULAR_SYSTEMS = [
  { id: 30000142, name: "JITA" }, { id: 30000144, name: "PERIMETER" },
  { id: 30002187, name: "AMARR" }, { id: 30002659, name: "DODIXIE" },
  { id: 30002510, name: "RENS" }, { id: 30002053, name: "HEK" },
  { id: 30002537, name: "AMAMAKE" }, { id: 30004759, name: "1DQ1-A" }
];
window.POPULAR_SYSTEMS = POPULAR_SYSTEMS;

// Safe Read-Only Helper to extract yield from any recipe object format without mutating it
function extractRecipeYield(recipe) {
  if (!recipe) return 1;
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
    const val = parseInt(c);
    if (!isNaN(val) && val > 0) return val;
  }
  return 1;
}
window.extractRecipeYield = extractRecipeYield;

// Corrected Live EVE Client SDE Material Quantities & Verified Type IDs
const BUILTIN_RECIPES = {
  // Tungsten Carbide Reaction (10,000 Output Yield per 1 Run Batch)
  16681: {
    blueprintTypeID: 17730, productTypeID: 16681, productName: "Tungsten Carbide", mfgQtyPerRun: 10000, productQtyPerRun: 10000, reactionQtyPerRun: 10000, portionSize: 10000, qty: 10000, time: 600,
    reactionMaterials: [
      { typeId: 4247, name: "Nitrogen Fuel Block", baseQty: 5 },
      { typeId: 16672, name: "Rolled Tungsten Alloy", baseQty: 100 },
      { typeId: 16670, name: "Sulfuric Acid", baseQty: 100 }
    ]
  },
  17730: {
    blueprintTypeID: 17730, productTypeID: 16681, productName: "Tungsten Carbide", mfgQtyPerRun: 10000, productQtyPerRun: 10000, reactionQtyPerRun: 10000, portionSize: 10000, qty: 10000, time: 600,
    reactionMaterials: [
      { typeId: 4247, name: "Nitrogen Fuel Block", baseQty: 5 },
      { typeId: 16672, name: "Rolled Tungsten Alloy", baseQty: 100 },
      { typeId: 16670, name: "Sulfuric Acid", baseQty: 100 }
    ]
  },
  // Titanium Carbide Reaction (10,000 Output Yield)
  16680: {
    blueprintTypeID: 17729, productTypeID: 16680, productName: "Titanium Carbide", mfgQtyPerRun: 10000, productQtyPerRun: 10000, reactionQtyPerRun: 10000, portionSize: 10000, qty: 10000, time: 600,
    reactionMaterials: [
      { typeId: 4247, name: "Nitrogen Fuel Block", baseQty: 5 },
      { typeId: 16671, name: "Titanium Alloy", baseQty: 100 },
      { typeId: 16670, name: "Sulfuric Acid", baseQty: 100 }
    ]
  },
  17729: {
    blueprintTypeID: 17729, productTypeID: 16680, productName: "Titanium Carbide", mfgQtyPerRun: 10000, productQtyPerRun: 10000, reactionQtyPerRun: 10000, portionSize: 10000, qty: 10000, time: 600,
    reactionMaterials: [
      { typeId: 4247, name: "Nitrogen Fuel Block", baseQty: 5 },
      { typeId: 16671, name: "Titanium Alloy", baseQty: 100 },
      { typeId: 16670, name: "Sulfuric Acid", baseQty: 100 }
    ]
  },
  // Crystalline Carbonide Reaction (10,000 Output Yield)
  16679: {
    blueprintTypeID: 17728, productTypeID: 16679, productName: "Crystalline Carbonide", mfgQtyPerRun: 10000, productQtyPerRun: 10000, reactionQtyPerRun: 10000, portionSize: 10000, qty: 10000, time: 600,
    reactionMaterials: [
      { typeId: 4247, name: "Nitrogen Fuel Block", baseQty: 5 },
      { typeId: 16669, name: "Crystalline 3-M4", baseQty: 100 },
      { typeId: 16670, name: "Sulfuric Acid", baseQty: 100 }
    ]
  },
  17728: {
    blueprintTypeID: 17728, productTypeID: 16679, productName: "Crystalline Carbonide", mfgQtyPerRun: 10000, productQtyPerRun: 10000, reactionQtyPerRun: 10000, portionSize: 10000, qty: 10000, time: 600,
    reactionMaterials: [
      { typeId: 4247, name: "Nitrogen Fuel Block", baseQty: 5 },
      { typeId: 16669, name: "Crystalline 3-M4", baseQty: 100 },
      { typeId: 16670, name: "Sulfuric Acid", baseQty: 100 }
    ]
  },
  // Hydrogen Fuel Block (40 Output Yield)
  4247: {
    blueprintTypeID: 4248, productTypeID: 4247, productName: "Hydrogen Fuel Block", mfgQtyPerRun: 40, productQtyPerRun: 40, portionSize: 40, qty: 40, time: 15
  },
  4248: {
    blueprintTypeID: 4248, productTypeID: 4247, productName: "Hydrogen Fuel Block", mfgQtyPerRun: 40, productQtyPerRun: 40, portionSize: 40, qty: 40, time: 15
  },
  // Gila
  17715: {
    blueprintTypeID: 17714, productTypeID: 17715, productName: "Gila", mfgQtyPerRun: 1, productQtyPerRun: 1, portionSize: 1, qty: 1, time: 24000,
    mfgMaterials: [
      { typeId: 621, name: "Caracal", baseQty: 1 },
      { typeId: 57478, name: "Auto-Integrity Preservation Seal", baseQty: 60 },
      { typeId: 57486, name: "Life Support Backup Unit", baseQty: 30 },
      { typeId: 57479, name: "Core Temperature Regulator", baseQty: 1 }
    ]
  },
  17714: {
    blueprintTypeID: 17714, productTypeID: 17715, productName: "Gila", mfgQtyPerRun: 1, productQtyPerRun: 1, portionSize: 1, qty: 1, time: 24000,
    mfgMaterials: [
      { typeId: 621, name: "Caracal", baseQty: 1 },
      { typeId: 57478, name: "Auto-Integrity Preservation Seal", baseQty: 60 },
      { typeId: 57486, name: "Life Support Backup Unit", baseQty: 30 },
      { typeId: 57479, name: "Core Temperature Regulator", baseQty: 1 }
    ]
  },
  // Auto-Integrity Preservation Seal
  57478: {
    blueprintTypeID: 57515, productTypeID: 57478, productName: "Auto-Integrity Preservation Seal", mfgQtyPerRun: 3, productQtyPerRun: 3, portionSize: 3, qty: 3, time: 240,
    mfgMaterials: [
      { typeId: 2312, name: "Supertensile Plastics", baseQty: 4 },
      { typeId: 2463, name: "Nanites", baseQty: 4 },
      { typeId: 57457, name: "Reinforced Carbon Fiber", baseQty: 10 }
    ]
  },
  57515: {
    blueprintTypeID: 57515, productTypeID: 57478, productName: "Auto-Integrity Preservation Seal", mfgQtyPerRun: 3, productQtyPerRun: 3, portionSize: 3, qty: 3, time: 240,
    mfgMaterials: [
      { typeId: 2312, name: "Supertensile Plastics", baseQty: 4 },
      { typeId: 2463, name: "Nanites", baseQty: 4 },
      { typeId: 57457, name: "Reinforced Carbon Fiber", baseQty: 10 }
    ]
  },
  // Life Support Backup Unit
  57486: {
    blueprintTypeID: 57523, productTypeID: 57486, productName: "Life Support Backup Unit", mfgQtyPerRun: 3, productQtyPerRun: 3, portionSize: 3, qty: 3, time: 240,
    mfgMaterials: [
      { typeId: 2319, name: "Test Cultures", baseQty: 8 },
      { typeId: 3775, name: "Viral Agent", baseQty: 8 },
      { typeId: 57457, name: "Reinforced Carbon Fiber", baseQty: 10 }
    ]
  },
  57523: {
    blueprintTypeID: 57523, productTypeID: 57486, productName: "Life Support Backup Unit", mfgQtyPerRun: 3, productQtyPerRun: 3, portionSize: 3, qty: 3, time: 240,
    mfgMaterials: [
      { typeId: 2319, name: "Test Cultures", baseQty: 8 },
      { typeId: 3775, name: "Viral Agent", baseQty: 8 },
      { typeId: 57457, name: "Reinforced Carbon Fiber", baseQty: 10 }
    ]
  },
  // Core Temperature Regulator
  57479: {
    blueprintTypeID: 57516, productTypeID: 57479, productName: "Core Temperature Regulator", mfgQtyPerRun: 1, productQtyPerRun: 1, portionSize: 1, qty: 1, time: 1200,
    mfgMaterials: [
      { typeId: 57453, name: "Pressurized Oxidizers", baseQty: 100 },
      { typeId: 2401, name: "Chiral Structures", baseQty: 100 },
      { typeId: 57457, name: "Reinforced Carbon Fiber", baseQty: 500 }
    ]
  },
  57516: {
    blueprintTypeID: 57516, productTypeID: 57479, productName: "Core Temperature Regulator", mfgQtyPerRun: 1, productQtyPerRun: 1, portionSize: 1, qty: 1, time: 1200,
    mfgMaterials: [
      { typeId: 57453, name: "Pressurized Oxidizers", baseQty: 100 },
      { typeId: 2401, name: "Chiral Structures", baseQty: 100 },
      { typeId: 57457, name: "Reinforced Carbon Fiber", baseQty: 500 }
    ]
  },
  // Caracal
  621: {
    blueprintTypeID: 622, productTypeID: 621, productName: "Caracal", mfgQtyPerRun: 1, productQtyPerRun: 1, portionSize: 1, qty: 1, time: 6000,
    mfgMaterials: [
      { typeId: 34, name: "Tritanium", baseQty: 540000 },
      { typeId: 35, name: "Pyerite", baseQty: 180000 },
      { typeId: 36, name: "Mexallon", baseQty: 36000 },
      { typeId: 37, name: "Isogen", baseQty: 10000 },
      { typeId: 38, name: "Nocxium", baseQty: 1500 },
      { typeId: 39, name: "Zydrine", baseQty: 350 },
      { typeId: 40, name: "Megacyte", baseQty: 140 }
    ]
  }
};
window.BUILTIN_RECIPES = BUILTIN_RECIPES;

// Global Prepacked Index Builder (Resolves EVE_ITEMS & EVE_RECIPES from eve_db.js)
window.buildPrepackedIndexes = function() {
  const statusText = document.getElementById('status-text');
  const statusDot = document.getElementById('status-dot');

  try {
    const itemsObj = (typeof EVE_ITEMS !== 'undefined') ? EVE_ITEMS : (window.EVE_ITEMS || null);
    const recipesObj = (typeof EVE_RECIPES !== 'undefined') ? EVE_RECIPES : (window.EVE_RECIPES || null);
    const systemsObj = (typeof EVE_SYSTEMS !== 'undefined') ? EVE_SYSTEMS : (window.EVE_SYSTEMS || null);

    if (itemsObj && typeof itemsObj === 'object') {
      for (const [idStr, name] of Object.entries(itemsObj)) {
        const numericId = parseInt(idStr);
        IDX[name.toLowerCase()] = { id: numericId, name: name };
        TYPE_ID_TO_NAME[numericId] = name; // FAST O(1) DIRECT LOOKUP MAP
      }
    } else {
      POPULAR_ITEMS.forEach(r => {
        IDX[r.name.toLowerCase()] = { id: r.id, name: r.name };
        TYPE_ID_TO_NAME[r.id] = r.name;
      });
    }

    if (systemsObj && typeof systemsObj === 'object') {
      for (const [id, name] of Object.entries(systemsObj)) {
        SYSTEM_IDX[name.toLowerCase()] = { id: parseInt(id), name: name.toUpperCase() };
        systemNameCache[id] = name.toUpperCase();
      }
    } else {
      POPULAR_SYSTEMS.forEach(sys => {
        SYSTEM_IDX[sys.name.toLowerCase()] = { id: sys.id, name: sys.name.toUpperCase() };
        systemNameCache[sys.id] = sys.name.toUpperCase();
      });
    }

    if (recipesObj && typeof recipesObj === 'object') {
      for (const [idStr, recipe] of Object.entries(recipesObj)) {
        if (!recipe) continue;
        const keyId = parseInt(idStr);
        recipeMap[keyId] = recipe;
        
        // Map all candidate key fields without mutating recipe object directly
        const bpId = recipe.blueprintTypeID || recipe.bp || recipe.bpId;
        const pId = recipe.productTypeID || recipe.product || recipe.p || recipe.pId;

        if (bpId) recipeMap[parseInt(bpId)] = recipe;
        if (pId) recipeMap[parseInt(pId)] = recipe;
      }
    }

    // Explicitly override built-in recipes
    for (const [idStr, recipe] of Object.entries(BUILTIN_RECIPES)) {
      const keyId = parseInt(idStr);
      recipeMap[keyId] = recipe;
      if (recipe.blueprintTypeID) recipeMap[recipe.blueprintTypeID] = recipe;
      if (recipe.productTypeID) recipeMap[recipe.productTypeID] = recipe;
    }

    if (statusDot) statusDot.className = 'w-2.5 h-2.5 rounded-full bg-green-400';
    if (statusText) statusText.textContent = `INDEX READY (${Object.keys(IDX).length.toLocaleString()} ITEMS | ${Object.keys(recipeMap).length.toLocaleString()} RECIPES)`;
  } catch (err) {
    console.error('buildPrepackedIndexes error:', err);
    if (statusDot) statusDot.className = 'w-2.5 h-2.5 rounded-full bg-red-500';
    if (statusText) statusText.textContent = 'INDEX LOAD ERROR: ' + err.message;
  }
};