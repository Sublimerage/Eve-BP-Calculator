'use strict';

// Global HTML Escaper Helper Function
function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
window.esc = esc;

// Hardcoded EVE Developer Application Client ID for instant 1-click SSO
window.HARDCODED_CLIENT_ID = '20e4087a1f564a3e897aaaa6daebbecd';

// Global Caches & Indexes (Explicitly attached to window)
window.IDX = {};                  // Full Item Index
window.SYSTEM_IDX = {};           // Full Solar System Index
window.recipeMap = {};            // Dual-Key Recipe Map
window.currentProduct = null;      // Selected root item metadata
window.recipeTreeRoot = null;      // Recursive blueprint tree
window.blueprintCache = {};        // Cached blueprint responses
window.priceCache = {};            // Cached Jita 4-4 prices
window.eivCache = {};              // Cached EVE ESI Adjusted Prices
window.rawAssetItems = [];         // Raw ESI / Pasted asset records
window.userStockMap = {};          // Filtered stock quantities
window.systemNameCache = {};       // Cached system names
window.resolvedLocationNames = {}; // Cached location names
window.instanceCounter = 0;        // Node instance ID counter

// User Overrides State
window.buildSelfOverrides = {};    // { typeId: boolean }
window.customBuyModes = {};        // { typeId: 'sell' | 'buy' }
window.customMEOverrides = {};     // { typeId: number }
window.customTEOverrides = {};     // { typeId: number }

window.selectedInstanceId = null;  
window.isolatedInstanceId = null;  

// Live ESI System Cost Indices
window.activeMfgSCI = 0.0425;
window.activeReactSCI = 0.0110;

// Pan & Zoom State
window.zoomScale = 1.0;
window.panX = 0;
window.panY = 0;
window.isPanning = false;
window.startX = 0;
window.startY = 0;

// Global Prepacked Index Builder (Resolves EVE_ITEMS & EVE_RECIPES from eve_db.js)
window.buildPrepackedIndexes = function() {
  const statusText = document.getElementById('status-text');
  const statusDot = document.getElementById('status-dot');

  const itemsObj = (typeof EVE_ITEMS !== 'undefined') ? EVE_ITEMS : (window.EVE_ITEMS || null);
  const recipesObj = (typeof EVE_RECIPES !== 'undefined') ? EVE_RECIPES : (window.EVE_RECIPES || null);
  const systemsObj = (typeof EVE_SYSTEMS !== 'undefined') ? EVE_SYSTEMS : (window.EVE_SYSTEMS || null);

  if (itemsObj && Object.keys(itemsObj).length > 10) {
    for (const [id, name] of Object.entries(itemsObj)) {
      window.IDX[name.toLowerCase()] = { id: parseInt(id), name: name };
    }
  } else {
    POPULAR_ITEMS.forEach(r => {
      window.IDX[r.name.toLowerCase()] = { id: r.id, name: r.name };
    });
  }

  if (systemsObj && Object.keys(systemsObj).length > 10) {
    for (const [id, name] of Object.entries(systemsObj)) {
      window.SYSTEM_IDX[name.toLowerCase()] = { id: parseInt(id), name: name.toUpperCase() };
      window.systemNameCache[id] = name.toUpperCase();
    }
  } else {
    POPULAR_SYSTEMS.forEach(sys => {
      window.SYSTEM_IDX[sys.name.toLowerCase()] = { id: sys.id, name: sys.name.toUpperCase() };
      window.systemNameCache[sys.id] = sys.name.toUpperCase();
    });
  }

  if (recipesObj && typeof recipesObj === 'object') {
    for (const [idStr, recipe] of Object.entries(recipesObj)) {
      const keyId = parseInt(idStr);
      window.recipeMap[keyId] = recipe;
      if (recipe.blueprintTypeID) window.recipeMap[recipe.blueprintTypeID] = recipe;
      if (recipe.productTypeID) window.recipeMap[recipe.productTypeID] = recipe;
    }
  }

  // Explicitly override stale recipes with live verified SDE quantities
  for (const [idStr, recipe] of Object.entries(BUILTIN_RECIPES)) {
    const keyId = parseInt(idStr);
    window.recipeMap[keyId] = recipe;
    if (recipe.blueprintTypeID) window.recipeMap[recipe.blueprintTypeID] = recipe;
    if (recipe.productTypeID) window.recipeMap[recipe.productTypeID] = recipe;
  }

  if (statusDot) statusDot.className = 'w-2 h-2 rounded-full bg-green-400';
  if (statusText) statusText.textContent = `INDEX READY (${Object.keys(window.IDX).length.toLocaleString()} ITEMS | ${Object.keys(window.recipeMap).length.toLocaleString()} RECIPES)`;
};

// Known Base Raw Materials
const RAW_BASE_MATERIALS = new Set([
  34, 35, 36, 37, 38, 39, 40, 11399, // Minerals
  16274, 16275, 17887, 17888,        // Isotopes
  16272, 16273,                      // Heavy Water, Liquid Ozone
  3689, 3683, 9848,                  // Coolant, Enriched Uranium, Robotics
  2267, 2268, 2270, 2272, 2305       // Gas / Ores
]);

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
  { id: 34,    name: "Tritanium" },
  { id: 35,    name: "Pyerite" },
  { id: 36,    name: "Mexallon" },
  { id: 37,    name: "Isogen" },
  { id: 38,    name: "Nocxium" },
  { id: 39,    name: "Zydrine" },
  { id: 40,    name: "Megacyte" }
];

// Built-in Popular Solar Systems Index
const POPULAR_SYSTEMS = [
  { id: 30000142, name: "JITA" }, { id: 30000144, name: "PERIMETER" },
  { id: 30002187, name: "AMARR" }, { id: 30002659, name: "DODIXIE" },
  { id: 30002510, name: "RENS" }, { id: 30002053, name: "HEK" },
  { id: 30002537, name: "AMAMAKE" }, { id: 30004759, name: "1DQ1-A" }
];

// Corrected Live EVE Client SDE Material Quantities & Verified Type IDs
const BUILTIN_RECIPES = {
  // Drekavac
  48519: {
    blueprintTypeID: 49715, productTypeID: 48519, productName: "Drekavac", mfgQtyPerRun: 1, productQtyPerRun: 1,
    mfgMaterials: [
      { typeId: 34, name: "Tritanium", baseQty: 1828712 },
      { typeId: 35, name: "Pyerite", baseQty: 368466 },
      { typeId: 36, name: "Mexallon", baseQty: 87814 },
      { typeId: 37, name: "Isogen", baseQty: 19374 },
      { typeId: 38, name: "Nocxium", baseQty: 5774 },
      { typeId: 39, name: "Zydrine", baseQty: 2804 },
      { typeId: 40, name: "Megacyte", baseQty: 1402 },
      { typeId: 52310, name: "Crystalline Isogen-10", baseQty: 460 },
      { typeId: 52311, name: "Zero-Point Condensate", baseQty: 360 }
    ]
  },
  49715: {
    blueprintTypeID: 49715, productTypeID: 48519, productName: "Drekavac", mfgQtyPerRun: 1, productQtyPerRun: 1,
    mfgMaterials: [
      { typeId: 34, name: "Tritanium", baseQty: 1828712 },
      { typeId: 35, name: "Pyerite", baseQty: 368466 },
      { typeId: 36, name: "Mexallon", baseQty: 87814 },
      { typeId: 37, name: "Isogen", baseQty: 19374 },
      { typeId: 38, name: "Nocxium", baseQty: 5774 },
      { typeId: 39, name: "Zydrine", baseQty: 2804 },
      { typeId: 40, name: "Megacyte", baseQty: 1402 },
      { typeId: 52310, name: "Crystalline Isogen-10", baseQty: 460 },
      { typeId: 52311, name: "Zero-Point Condensate", baseQty: 360 }
    ]
  },
  // Leshak
  47271: {
    blueprintTypeID: 47968, productTypeID: 47271, productName: "Leshak", mfgQtyPerRun: 1, productQtyPerRun: 1,
    mfgMaterials: [
      { typeId: 34, name: "Tritanium", baseQty: 8800000 },
      { typeId: 35, name: "Pyerite", baseQty: 2930004 },
      { typeId: 36, name: "Mexallon", baseQty: 660000 },
      { typeId: 37, name: "Isogen", baseQty: 186361 },
      { typeId: 38, name: "Nocxium", baseQty: 46200 },
      { typeId: 39, name: "Zydrine", baseQty: 15400 },
      { typeId: 40, name: "Megacyte", baseQty: 6575 },
      { typeId: 52310, name: "Crystalline Isogen-10", baseQty: 845 },
      { typeId: 52311, name: "Zero-Point Condensate", baseQty: 850 }
    ]
  },
  47968: {
    blueprintTypeID: 47968, productTypeID: 47271, productName: "Leshak", mfgQtyPerRun: 1, productQtyPerRun: 1,
    mfgMaterials: [
      { typeId: 34, name: "Tritanium", baseQty: 8800000 },
      { typeId: 35, name: "Pyerite", baseQty: 2930004 },
      { typeId: 36, name: "Mexallon", baseQty: 660000 },
      { typeId: 37, name: "Isogen", baseQty: 186361 },
      { typeId: 38, name: "Nocxium", baseQty: 46200 },
      { typeId: 39, name: "Zydrine", baseQty: 15400 },
      { typeId: 40, name: "Megacyte", baseQty: 6575 },
      { typeId: 52310, name: "Crystalline Isogen-10", baseQty: 845 },
      { typeId: 52311, name: "Zero-Point Condensate", baseQty: 850 }
    ]
  },
  // Auto-Integrity Preservation Seal
  57478: {
    blueprintTypeID: 57515, productTypeID: 57478, productName: "Auto-Integrity Preservation Seal", mfgQtyPerRun: 3, productQtyPerRun: 3,
    mfgMaterials: [
      { typeId: 2312, name: "Supertensile Plastics", baseQty: 4 },
      { typeId: 2463, name: "Nanites", baseQty: 4 },
      { typeId: 57457, name: "Reinforced Carbon Fiber", baseQty: 10 }
    ]
  },
  57515: {
    blueprintTypeID: 57515, productTypeID: 57478, productName: "Auto-Integrity Preservation Seal", mfgQtyPerRun: 3, productQtyPerRun: 3,
    mfgMaterials: [
      { typeId: 2312, name: "Supertensile Plastics", baseQty: 4 },
      { typeId: 2463, name: "Nanites", baseQty: 4 },
      { typeId: 57457, name: "Reinforced Carbon Fiber", baseQty: 10 }
    ]
  },
  // Life Support Backup Unit
  57486: {
    blueprintTypeID: 57523, productTypeID: 57486, productName: "Life Support Backup Unit", mfgQtyPerRun: 3, productQtyPerRun: 3,
    mfgMaterials: [
      { typeId: 2319, name: "Test Cultures", baseQty: 8 },
      { typeId: 3775, name: "Viral Agent", baseQty: 8 },
      { typeId: 57457, name: "Reinforced Carbon Fiber", baseQty: 10 }
    ]
  },
  57523: {
    blueprintTypeID: 57523, productTypeID: 57486, productName: "Life Support Backup Unit", mfgQtyPerRun: 3, productQtyPerRun: 3,
    mfgMaterials: [
      { typeId: 2319, name: "Test Cultures", baseQty: 8 },
      { typeId: 3775, name: "Viral Agent", baseQty: 8 },
      { typeId: 57457, name: "Reinforced Carbon Fiber", baseQty: 10 }
    ]
  },
  // Core Temperature Regulator
  57479: {
    blueprintTypeID: 57516, productTypeID: 57479, productName: "Core Temperature Regulator", mfgQtyPerRun: 1, productQtyPerRun: 1,
    mfgMaterials: [
      { typeId: 57453, name: "Pressurized Oxidizers", baseQty: 100 },
      { typeId: 2401, name: "Chiral Structures", baseQty: 100 },
      { typeId: 57457, name: "Reinforced Carbon Fiber", baseQty: 500 }
    ]
  },
  57516: {
    blueprintTypeID: 57516, productTypeID: 57479, productName: "Core Temperature Regulator", mfgQtyPerRun: 1, productQtyPerRun: 1,
    mfgMaterials: [
      { typeId: 57453, name: "Pressurized Oxidizers", baseQty: 100 },
      { typeId: 2401, name: "Chiral Structures", baseQty: 100 },
      { typeId: 57457, name: "Reinforced Carbon Fiber", baseQty: 500 }
    ]
  },
  // Caracal
  621: {
    blueprintTypeID: 622, productTypeID: 621, productName: "Caracal", mfgQtyPerRun: 1, productQtyPerRun: 1,
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