'use strict';

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
window.esc = esc;

// Shared toggle-button handler for "Deduct Stock" controls across all pages - a clear on/off button
// instead of a dropdown, but keeps the exact same id="deduct-stock-mode" + .value === 'true' pattern
// every read site already uses, since <button value="..."> supports .value identically to <select>.
function toggleDeductStockButton(btn, recalcFnName) {
  if (!btn) return;
  const newValue = btn.value === 'true' ? 'false' : 'true';
  btn.value = newValue;
  updateDeductStockButtonVisual(btn);
  if (recalcFnName && typeof window[recalcFnName] === 'function') window[recalcFnName]();
}
window.toggleDeductStockButton = toggleDeductStockButton;

function updateDeductStockButtonVisual(btn) {
  if (!btn) return;
  if (btn.value === 'true') {
    btn.textContent = '✔ Deducting Stock';
    btn.className = 'w-full px-3 py-1.5 rounded-md font-bold text-xs transition flex items-center justify-center gap-1.5 bg-cyan-700 hover:bg-cyan-600 text-white border border-cyan-400 shadow shadow-cyan-900/40';
    btn.title = 'Materials you already own are excluded from the shopping list/multibuy below - click to show the full list instead';
  } else {
    btn.textContent = '✖ Not Deducting Stock';
    btn.className = 'w-full px-3 py-1.5 rounded-md font-bold text-xs transition flex items-center justify-center gap-1.5 bg-[#1e3348] hover:bg-slate-600 text-slate-300 border border-slate-600';
    btn.title = 'Shopping list/multibuy below shows the FULL amount needed, even for materials you already own - click to deduct owned stock instead';
  }
}
window.updateDeductStockButtonVisual = updateDeductStockButtonVisual;

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

window.HARDCODED_CLIENT_ID = '20e4087a1f564a3e897aaaa6daebbecd';

var IDX = {};                  
var TYPE_ID_TO_NAME = {};      
var SYSTEM_IDX = {};           
var recipeMap = {};            
var currentProduct = null;      
var recipeTreeRoot = null;      
var blueprintCache = {};        
var priceCache = {};            
var eivCache = {};              
var rawAssetItems = [];         
var userStockMap = {};          
var systemNameCache = {};       
var resolvedLocationNames = {}; 
var corpDivisionNames = {};     
var instanceCounter = 0;        
var buildSelfOverrides = {};    
var customBuyModes = {};        
var customMEOverrides = {};     
var customTEOverrides = {};     
var selectedInstanceId = null;  
var isolatedInstanceId = null;  
var collapsedInstanceIds = new Set(); // instanceIds of nodes whose children are hidden from the diagram
var activeMfgSCI = 0.0425;
var activeReactSCI = 0.0110;
var activeInventionSCI = 0.0200;
var zoomScale = 1.0;
var panX = 0;
var panY = 0;
var isPanning = false;
var startX = 0;
var startY = 0;

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

// Extracts the direct material requirements for manufacturing a given node (flattening through any
// of its own build-toggled children down to what's actually bought/raw). Used both for jobs added
// from the calculator and for jobs auto-imported from real EVE industry data on the ledger page.
function extractJobMaterialsForNode(startNode) {
  const materials = [];
  const deductModeInput = document.getElementById('deduct-stock-mode');
  const isStockDeductEnabled = deductModeInput ? deductModeInput.value === 'true' : true;
  // Shared pool decremented as materials are claimed across the whole tree - checking each leaf
  // independently against the full stock amount (the previous approach) let the same physical stock
  // get counted as covering multiple different sub-components simultaneously.
  const allocatedStockPool = { ...window.userStockMap };

  function walk(node) {
    if (!node) return;
    if (!node.isBuildingSelf || !node.children || node.children.length === 0) {
      const productTypeId = node.productTypeId || node.typeId;
      const strategy = window.getNodePriceStrategy ? window.getNodePriceStrategy(node) : 'sell';
      const availableStock = isStockDeductEnabled ? (allocatedStockPool[productTypeId] || allocatedStockPool[node.typeId] || 0) : 0;
      const consumedFromStock = Math.min(node.qtyNeeded, availableStock);
      if (isStockDeductEnabled && allocatedStockPool[productTypeId] !== undefined) {
        allocatedStockPool[productTypeId] = Math.max(0, allocatedStockPool[productTypeId] - consumedFromStock);
      }
      const netQtyNeeded = Math.max(0, node.qtyNeeded - consumedFromStock);
      const prices = window.priceCache[productTypeId] || { sell: 0, buy: 0 };
      const unitPrice = strategy === 'sell' ? prices.sell : prices.buy;
      materials.push({
        typeId: productTypeId,
        name: node.name.replace(' Blueprint', ''),
        qtyNeeded: node.qtyNeeded,
        stockQty: consumedFromStock,
        netQtyNeeded: netQtyNeeded,
        strategy: strategy,
        unitPrice: unitPrice,
        lineCost: unitPrice * netQtyNeeded
      });
    } else {
      node.children.forEach(child => { if (child) walk(child); });
    }
  }

  if (startNode.isBuildingSelf && startNode.children && startNode.children.length > 0) {
    startNode.children.forEach(child => { if (child) walk(child); });
  } else {
    walk(startNode);
  }
  return materials;
}
window.extractJobMaterialsForNode = extractJobMaterialsForNode;

// Strictly queries exact unreduced SDE manufacturing durations directly from SDE database
function extractBuildTime(recipe) {
  if (!recipe) return 0;
  return parseInt(recipe.time || recipe.t || recipe.timeSeconds || recipe.duration || recipe.mfgTime || recipe.productionTime || 0);
}
window.extractBuildTime = extractBuildTime;

// Applies TE research, character skills (Industry/Advanced Industry), and the selected facility's
// time bonus to a single job's raw SDE duration. Reactions can't be TE-researched, so TE is ignored
// for them. Shared by the per-card time display, the total-tree time summary, the ledger, and the
// invention calculator.
const _loggedSkillDiagnosticIds = new Set();
function logSkillDiagnosticOnce(typeId, message) {
  const key = `${typeId}`;
  if (_loggedSkillDiagnosticIds.has(key)) return;
  _loggedSkillDiagnosticIds.add(key);
  console.info(message);
}

function calculateAdjustedJobSeconds(baseTimeSeconds, customTE, runsNeeded, isReaction, productTypeId, requiredSkills) {
  if (!baseTimeSeconds || baseTimeSeconds <= 0) return 0;
  const skills = window.safeParseJSON(localStorage.getItem('eve_char_skills'), { industry: 5, advIndustry: 5 });
  const indFactor = 1 - (0.04 * (skills.industry || 0));
  const advIndFactor = 1 - (0.03 * (skills.advIndustry || 0));

  let requiredSkillFactor = 1.0;
  if (Array.isArray(requiredSkills) && requiredSkills.length > 0) {
    if (!skills.allSkills) {
      logSkillDiagnosticOnce(productTypeId, `[BuildTime/Skills] Item ${productTypeId} requires skills but no full skill sheet is loaded (skills.allSkills missing) - log in via ESI SSO to fetch your trained skill levels, otherwise these bonuses stay at 0.`);
    } else {
      requiredSkills.forEach(reqSkill => {
        const playerLevel = skills.allSkills[reqSkill.skillId] || 0;
        requiredSkillFactor *= (1 - (0.01 * playerLevel));
      });
      logSkillDiagnosticOnce(productTypeId, `[BuildTime/Skills] Item ${productTypeId}: required skills ${JSON.stringify(requiredSkills)}, your trained levels: ${requiredSkills.map(s => `${s.skillId}=${skills.allSkills[s.skillId] || 0}`).join(', ')}, combined factor: ${requiredSkillFactor.toFixed(4)}`);
    }
  } else if (requiredSkills !== undefined) {
    logSkillDiagnosticOnce(productTypeId, `[BuildTime/Skills] Item ${productTypeId}: recipe has no requiredSkills data (empty array) - either this item genuinely needs none, or your local database predates this feature and needs regenerating (generate_db.py).`);
  }

  const skillTimeFactor = indFactor * advIndFactor * requiredSkillFactor;
  const te = isReaction ? 0 : (customTE || 0);
  const teFactor = 1 - (te / 100);
  const structureType = window.getActiveStructureType ? window.getActiveStructureType() : { teBonus: 30.0 };
  const facilityFactor = 1 - (structureType.teBonus / 100);
  const rigTEBonus = window.getEffectiveRigBonusForTypeId ? window.getEffectiveRigBonusForTypeId(productTypeId, 'TE') : 0;
  const rigFactor = 1 - (rigTEBonus / 100);
  return baseTimeSeconds * teFactor * skillTimeFactor * facilityFactor * rigFactor * (runsNeeded || 1);
}
window.calculateAdjustedJobSeconds = calculateAdjustedJobSeconds;

// Recursively sums the adjusted build time across every job actually being manufactured in the tree.
function calculateTotalBuildSeconds(node) {
  if (!node || !node.isBuildingSelf) return 0;
  let total = 0;
  if (node.recipe) {
    total += calculateAdjustedJobSeconds(extractBuildTime(node.recipe), node.customTE, node.runsNeeded, node.isReaction, node.productTypeId, node.recipe.requiredSkills);
  }
  if (node.children) {
    node.children.forEach(child => { if (child) total += calculateTotalBuildSeconds(child); });
  }
  return total;
}
window.calculateTotalBuildSeconds = calculateTotalBuildSeconds;

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
window.collapsedInstanceIds = collapsedInstanceIds;
window.activeMfgSCI = activeMfgSCI;
window.activeReactSCI = activeReactSCI;
window.activeInventionSCI = activeInventionSCI;
window.zoomScale = zoomScale;
window.panX = panX;
window.panY = panY;
window.isPanning = isPanning;
window.startX = startX;
window.startY = startY;

window.BLUEPRINT_TO_PRODUCT_MAP = {
  57523: 57486, 
  57515: 57478, 
  57516: 57479, 
  17714: 17715  
};

const RAW_BASE_MATERIALS = new Set([
  34, 35, 36, 37, 38, 39, 40, 11399, 
  16274, 16275, 17887, 17888,        
  16272, 16273,                      
  3689, 3683, 9848,                  
  2267, 2268, 2270, 2272, 2305       
]);
window.RAW_BASE_MATERIALS = RAW_BASE_MATERIALS;

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

// --- Tracked Markets (for the multi-market Compare Markets feature) ---
// Default hub NAMES only, not hardcoded station/region IDs - those get resolved via ESI at runtime
// (resolveStationByName + resolveStationRegion in esi.js) and cached, rather than trusting guessed
// numeric IDs the way the earlier ship-group-id mistake did.
const DEFAULT_TRADE_HUB_NAMES = [
  'Jita IV - Moon 4 - Caldari Navy Assembly Plant',
  'Amarr VIII (Oris) - Emperor Family Academy',
  'Dodixie IX - Moon 20 - Federation Navy Assembly Plant',
  'Rens VI - Moon 8 - Brutor Tribe Treasury',
  'Hek VIII - Moon 12 - Boundless Creation Factory'
];

function getTrackedMarkets() {
  try {
    const saved = localStorage.getItem('eve_tracked_markets');
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch (e) {}
  return [];
}
window.getTrackedMarkets = getTrackedMarkets;

function saveTrackedMarkets(markets) {
  localStorage.setItem('eve_tracked_markets', JSON.stringify(markets));
}
window.saveTrackedMarkets = saveTrackedMarkets;

function addTrackedMarket(market) {
  const markets = getTrackedMarkets();
  if (markets.some(m => m.stationId === market.stationId)) return; // already tracked
  markets.push(market);
  saveTrackedMarkets(markets);
}
window.addTrackedMarket = addTrackedMarket;

function removeTrackedMarket(stationId) {
  const markets = getTrackedMarkets().filter(m => m.stationId !== stationId);
  saveTrackedMarkets(markets);
}
window.removeTrackedMarket = removeTrackedMarket;

// One-time setup: resolves the 5 default hub names to real station/region IDs via ESI and seeds the
// tracked markets list, if it's empty (first run, or a fresh browser profile).
async function ensureDefaultTrackedMarkets() {
  if (getTrackedMarkets().length > 0) return; // already seeded
  const resolved = [];
  for (const name of DEFAULT_TRADE_HUB_NAMES) {
    try {
      const station = await window.resolveStationByName(name);
      if (!station) continue;
      const regionInfo = await window.resolveStationRegion(station.stationId);
      resolved.push({
        stationId: station.stationId,
        stationName: station.stationName,
        regionId: regionInfo ? regionInfo.regionId : null,
        systemId: regionInfo ? regionInfo.systemId : null
      });
    } catch (e) {
      console.warn(`Failed to resolve default hub "${name}":`, e);
    }
  }
  if (resolved.length > 0) saveTrackedMarkets(resolved);
}
window.ensureDefaultTrackedMarkets = ensureDefaultTrackedMarkets;

// --- Unified Structure Type System ---
// A station/structure is ONE thing - it can't simultaneously be "Raitaru" in one dropdown and
// "Sotiyo" in another. This table is the single source of truth for every bonus a structure type
// grants (ME, TE, and job-fee/cost reduction), replacing what used to be two separate, and therefore
// occasionally self-contradictory, dropdowns.
// Numbers confirmed via CCP's official "Building Dreams: Introducing Engineering Complexes" dev blog:
// Raitaru: 1% ME / 15% TE (cost bonus not directly quoted in that source - 3% is inferred from the
// clear ascending progression 3/4/5 that matches the 15/20/30 TE progression, not independently
// confirmed the way Azbel/Sotiyo's cost bonus is). Azbel: 1% ME / 20% TE / 4% cost (confirmed).
// Sotiyo: 1% ME / 30% TE / 5% cost (confirmed). NOTE: this corrects a bug in this app's own prior
// dropdown, which had listed Sotiyo's fee bonus as -3% instead of the correct -5%.
const STRUCTURE_TYPES = {
  npc:     { label: 'NPC Station',        shortLabel: 'NPC Station', meBonus: 0.0, teBonus: 0.0,  costBonus: 0.0 },
  raitaru: { label: 'Raitaru (M Engineering Complex)', shortLabel: 'Raitaru', meBonus: 1.0, teBonus: 15.0, costBonus: 3.0 },
  azbel:   { label: 'Azbel (L Engineering Complex)',   shortLabel: 'Azbel',   meBonus: 1.0, teBonus: 20.0, costBonus: 4.0 },
  sotiyo:  { label: 'Sotiyo (XL Engineering Complex)', shortLabel: 'Sotiyo',  meBonus: 1.0, teBonus: 30.0, costBonus: 5.0 }
};
window.STRUCTURE_TYPES = STRUCTURE_TYPES;

// The single canonical read of "what structure am I in" - everything (ME calc, TE calc, job fee calc)
// should call this instead of reading separate DOM elements or maintaining its own copy of the numbers.
function getActiveStructureType() {
  const key = localStorage.getItem('eve_active_facility_key') || 'sotiyo';
  return STRUCTURE_TYPES[key] || STRUCTURE_TYPES.npc;
}
window.getActiveStructureType = getActiveStructureType;


// Real rig items are discovered directly from the generated database (window.EVE_ITEMS +
// window.EVE_GROUP_NAMES), not hand-typed - there are dozens of distinct rigs (per size tier, per
// ship-size class, per tech tier), and a fixed 5-bucket list can't represent that. A rig only affects
// the specific category/size class named in its own item name (e.g. "Small Ship" rigs don't help a
// Battleship), which we determine by parsing that name.

// ME base %: confirmed via EVE Online forums (Tier I = 2%, Tier II = 2.4%, before security multiplier).
// TE base %: NOT independently confirmed - estimated using the same Tier I->II scaling ratio (1.2x) as
// the confirmed ME figures. If your in-game rig shows a different %, this is the number to correct.
const RIG_ME_BASE = { T1: 2.0, T2: 2.4 };
const RIG_TE_BASE = { T1: 20.0, T2: 24.0 };

// Security bonus multipliers - confirmed via EVE Ref dogma attributes (High Security / Low Security /
// Nullsec and Wormhole Bonus Multiplier): highsec x1.0, lowsec x1.9, null/WH x2.1.
function getSecurityMultiplier() {
  const sec = window.activeSystemSecurity;
  if (sec === undefined || sec === null) return 1.0; // unknown system - assume highsec (safe default)
  if (sec >= 0.45) return 1.0;
  if (sec > 0.0) return 1.9;
  return 2.1;
}
window.getSecurityMultiplier = getSecurityMultiplier;

// Parses a real Standup rig item name into structured data. Rig names follow a very consistent EVE
// naming convention: "Standup {M|L|XL}-Set [Basic|Advanced ]{category} [Manufacturing ][Material|Time ]Efficiency {I|II}".
// Returns null for anything that isn't a manufacturing/reaction efficiency rig (e.g. Invention or Copy
// rigs, which end in "Optimization" rather than "Efficiency", and reprocessing rigs) - these correctly
// fall out of this app's build-cost/time calculations since they don't affect them.
function parseRigName(rawName) {
  if (!rawName) return null;
  const sizeMatch = rawName.match(/^Standup (M|L|XL)-Set (.+)$/);
  if (!sizeMatch) return null;
  const size = sizeMatch[1];
  let rest = sizeMatch[2];

  const tierMatch = rest.match(/ (I{1,2})$/);
  if (!tierMatch) return null;
  const tier = tierMatch[1] === 'II' ? 'T2' : 'T1';
  rest = rest.slice(0, -tierMatch[0].length);

  if (!/ Efficiency$/.test(rest)) return null; // excludes Optimization (Invention/Copy) and other non-Efficiency rigs
  rest = rest.slice(0, -' Efficiency'.length);

  let bonusType = 'BOTH'; // L/XL-tier rigs typically grant combined ME+TE in one item
  if (/ Material$/.test(rest)) { bonusType = 'ME'; rest = rest.slice(0, -' Material'.length); }
  else if (/ Time$/.test(rest)) { bonusType = 'TE'; rest = rest.slice(0, -' Time'.length); }

  if (/ Manufacturing$/.test(rest)) rest = rest.slice(0, -' Manufacturing'.length);

  let spec = null; // Basic = affects T1 items, Advanced = affects T2/T3 - see disclosed limitation below
  if (/^Basic /.test(rest)) { spec = 'Basic'; rest = rest.slice('Basic '.length); }
  else if (/^Advanced /.test(rest)) { spec = 'Advanced'; rest = rest.slice('Advanced '.length); }

  const categoryLabel = rest.trim();
  if (!categoryLabel) return null;
  return { size, tier, bonusType, spec, categoryLabel };
}
window.parseRigName = parseRigName;

// Classifies a ship's hull size (small/medium/large) from its real item group name, so "Small Ship"
// rigs only match frigates/destroyers, "Medium Ship" only cruisers/battlecruisers/industrials/barges,
// and "Large Ship" only battleships/freighters/industrial command ships - matching real EVE rig scope.
// Checked as specific multi-word phrases first to avoid collisions (e.g. "Logistics Frigate" is small,
// not the generic "Logistics" cruiser-sized bucket). Uncommon/specialty hull groups not covered here
// simply won't match a size-specific rig (they'll still match a sizeless "Ship (Any)" XL-tier rig).
const SHIP_SIZE_SPECIFIC = [
  ['logistics frigate', 'small'], ['command destroyer', 'small'], ['tactical destroyer', 'small'],
  ['covert ops', 'small'], ['electronic attack', 'small'], ['stealth bomber', 'small'],
  ['interdictor', 'small'], ['interceptor', 'small'], ['assault frigate', 'small'],
  ['industrial command ship', 'large'], ['force auxiliary', 'large'], ['lancer dreadnought', 'large'],
  ['heavy assault', 'medium'], ['heavy interdiction', 'medium'], ['combat recon', 'medium'],
  ['force recon', 'medium'], ['strategic cruiser', 'medium'], ['attack battlecruiser', 'medium'],
  ['mining barge', 'medium'], ['exhumer', 'medium']
];
const SHIP_SIZE_GENERIC = [
  ['battleship', 'large'], ['freighter', 'large'], ['command ship', 'large'], ['black ops', 'large'],
  ['marauder', 'large'], ['dreadnought', 'large'], ['carrier', 'large'], ['supercarrier', 'large'], ['titan', 'large'],
  ['cruiser', 'medium'], ['battlecruiser', 'medium'], ['industrial', 'medium'], ['logistics', 'medium'],
  ['frigate', 'small'], ['destroyer', 'small'], ['corvette', 'small'], ['shuttle', 'small']
];
function classifyShipSize(groupName) {
  if (!groupName) return null;
  const g = groupName.toLowerCase();
  for (const [kw, size] of SHIP_SIZE_SPECIFIC) if (g.includes(kw)) return size;
  for (const [kw, size] of SHIP_SIZE_GENERIC) if (g.includes(kw)) return size;
  return null;
}
window.classifyShipSize = classifyShipSize;

// Classifies whether a ship is "Basic" (Tech 1, including most faction/pirate hulls which typically
// share a T1 group) or "Advanced" (Tech 2/Tech 3), from its real item group name. T1 hulls sit in a
// small, fixed set of generic group names; T2/T3 hulls almost always get their own distinct group
// (e.g. "Assault Frigate", "Heavy Assault Cruiser", "Strategic Cruiser") - this avoids needing
// per-item tech-level data, which ESI doesn't expose in bulk (only one-call-per-item, impractical for
// 35,000+ items). Confirmed via in-game rig description: "Advanced" rigs affect "Tech 2 frigates,
// Tech 2 and Tech 3 destroyers" etc.
const T1_GENERIC_SHIP_GROUPS = new Set([
  'frigate', 'destroyer', 'cruiser', 'battlecruiser', 'battleship', 'industrial',
  'mining barge', 'freighter', 'shuttle', 'corvette', 'capsule'
]);
function classifyShipTechClass(groupName) {
  if (!groupName) return null;
  const g = groupName.toLowerCase().trim();
  if (T1_GENERIC_SHIP_GROUPS.has(g)) return 'basic';
  return 'advanced'; // specialized/named group - T2, T3, or similar
}
window.classifyShipTechClass = classifyShipTechClass;

// Checks whether a parsed rig actually affects a given product, based on real category/group data.
function doesRigMatchProduct(parsed, typeId) {
  const catId = window.EVE_CATEGORIES ? window.EVE_CATEGORIES[typeId] : undefined;
  const label = parsed.categoryLabel.toLowerCase();
  if (label === 'ship' || label.includes('ship')) {
    if (catId !== 6) return false;
    const groupName = window.EVE_GROUP_NAMES ? window.EVE_GROUP_NAMES[typeId] : null;
    // "Basic" rigs affect Tech 1 hulls, "Advanced" rigs affect Tech 2/3 hulls - confirmed via the
    // in-game rig description. A sizeless XL-tier "Ship" rig has no spec and matches any tech class.
    if (parsed.spec) {
      const techClass = classifyShipTechClass(groupName);
      if (techClass !== parsed.spec.toLowerCase()) return false;
    }
    if (label === 'ship') return true; // sizeless XL-tier rig - any ship, tech class already checked above
    const sizeClass = classifyShipSize(groupName);
    if (label.includes('small')) return sizeClass === 'small';
    if (label.includes('medium')) return sizeClass === 'medium';
    if (label.includes('large')) return sizeClass === 'large';
    return false;
  }
  if (label === 'ammunition') return catId === 8;
  if (label.includes('drone') || label.includes('fighter')) return catId === 18 || catId === 87;
  if (label === 'equipment') return catId === 7 || catId === 66;
  if (label.includes('component') || label.includes('structure')) return catId === 65 || catId === 4 || catId === 17;
  return false;
}
window.doesRigMatchProduct = doesRigMatchProduct;

let _rigItemCatalogCache = null;
// Scans the actual generated database for every real Structure Engineering Rig item (identified by
// its real in-game group name), parses each one, and returns the list - this is what populates the
// rig search dropdowns, so the list always reflects what's really in the game data.
function getRigItemCatalog() {
  if (_rigItemCatalogCache) return _rigItemCatalogCache;
  const rigs = [];
  if (window.EVE_ITEMS && window.EVE_GROUP_NAMES) {
    for (const typeIdStr of Object.keys(window.EVE_ITEMS)) {
      const groupName = window.EVE_GROUP_NAMES[typeIdStr];
      if (!groupName || !groupName.includes('Structure Engineering Rig')) continue;
      const name = window.EVE_ITEMS[typeIdStr];
      const parsed = parseRigName(name);
      if (!parsed) continue; // not a manufacturing/reaction efficiency rig (e.g. Invention/Copy/Reprocessing)
      rigs.push({ typeId: parseInt(typeIdStr), name, ...parsed });
    }
    rigs.sort((a, b) => a.name.localeCompare(b.name));
  }
  _rigItemCatalogCache = rigs;
  return rigs;
}
window.getRigItemCatalog = getRigItemCatalog;

// Reads the 3 rig slot selections (stored as the rig's own typeId) and returns the effective % bonus
// (already including the security multiplier) for the given product typeId and bonus type ('ME'/'TE').
// Only one rig "of the same type" can be fitted in-game, so matching slots take the max, not the sum.
function getEffectiveRigBonusForTypeId(typeId, bonusType) {
  const secMult = getSecurityMultiplier();
  let best = 0;
  for (let slot = 1; slot <= 3; slot++) {
    const rigTypeId = parseInt(localStorage.getItem(`eve_rig_slot_${slot}`));
    if (!rigTypeId) continue;
    const rigName = window.EVE_ITEMS ? window.EVE_ITEMS[rigTypeId] : null;
    if (!rigName) continue;
    const parsed = parseRigName(rigName);
    if (!parsed) continue;
    if (parsed.bonusType !== 'BOTH' && parsed.bonusType !== bonusType) continue;
    if (!doesRigMatchProduct(parsed, typeId)) continue;
    const base = bonusType === 'ME' ? RIG_ME_BASE[parsed.tier] : RIG_TE_BASE[parsed.tier];
    best = Math.max(best, base * secMult);
  }
  return best;
}
window.getEffectiveRigBonusForTypeId = getEffectiveRigBonusForTypeId;

const POPULAR_SYSTEMS = [
  { id: 30000142, name: "JITA" }, { id: 30000144, name: "PERIMETER" },
  { id: 30002187, name: "AMARR" }, { id: 30002659, name: "DODIXIE" },
  { id: 30002510, name: "RENS" }, { id: 30002053, name: "HEK" },
  { id: 30002537, name: "AMAMAKE" }, { id: 30004759, name: "1DQ1-A" }
];
window.POPULAR_SYSTEMS = POPULAR_SYSTEMS;

function extractRecipeYield(recipe) {
  if (!recipe) return 1;
  const candidates = [
    recipe.productQtyPerRun, recipe.mfgQtyPerRun, recipe.reactionQtyPerRun,
    recipe.outputQty, recipe.portionSize, recipe.quantity, recipe.qty,
    recipe.productQty, recipe.pQty, recipe.yield, recipe.batchYield,
    recipe.amount, recipe.qtyPerRun, recipe.products?.[0]?.quantity,
    recipe.products?.[0]?.qty, recipe.activityProducts?.[1]?.[0]?.quantity,
    recipe.activityProducts?.[11]?.[0]?.quantity, recipe.activityProducts?.['1']?.[0]?.quantity,
    recipe.activityProducts?.['11']?.[0]?.quantity
  ];
  for (const c of candidates) {
    const val = parseInt(c);
    if (!isNaN(val) && val > 0) return val;
  }
  return 1;
}
window.extractRecipeYield = extractRecipeYield;

const BUILTIN_RECIPES = {
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
  4247: {
    blueprintTypeID: 4248, productTypeID: 4247, productName: "Hydrogen Fuel Block", mfgQtyPerRun: 40, productQtyPerRun: 40, portionSize: 40, qty: 40, time: 15
  },
  4248: {
    blueprintTypeID: 4248, productTypeID: 4247, productName: "Hydrogen Fuel Block", mfgQtyPerRun: 40, productQtyPerRun: 40, portionSize: 40, qty: 40, time: 15
  },
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
        TYPE_ID_TO_NAME[numericId] = name; 
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
        const bpId = recipe.blueprintTypeID || recipe.bp || recipe.bpId;
        const pId = recipe.productTypeID || recipe.product || recipe.p || recipe.pId;
        if (bpId) recipeMap[parseInt(bpId)] = recipe;
        if (pId) recipeMap[parseInt(pId)] = recipe;
      }
    }

    for (const [idStr, recipe] of Object.entries(BUILTIN_RECIPES)) {
      const keyId = parseInt(idStr);
      recipeMap[keyId] = recipe;
      if (recipe.blueprintTypeID) recipeMap[recipe.blueprintTypeID] = recipe;
      if (recipe.productTypeID) recipeMap[recipe.productTypeID] = recipe;
    }

    // Dynamic SDE local index builder to match any Blueprint to its Product ID
    window.BLUEPRINT_TO_PRODUCT_MAP = window.BLUEPRINT_TO_PRODUCT_MAP || {};
    const blueprintSuffix = " blueprint";
    const formulaSuffix = " reaction formula";
    const formulaSuffix2 = " formula";

    for (const [name, item] of Object.entries(IDX)) {
      let pName = null;
      if (name.endsWith(blueprintSuffix)) {
        pName = name.slice(0, -blueprintSuffix.length);
      } else if (name.endsWith(formulaSuffix)) {
        pName = name.slice(0, -formulaSuffix.length);
      } else if (name.endsWith(formulaSuffix2)) {
        pName = name.slice(0, -formulaSuffix2.length);
      }

      if (pName) {
        const pItem = IDX[pName.trim()];
        if (pItem) {
          window.BLUEPRINT_TO_PRODUCT_MAP[item.id] = pItem.id;
        }
      }
    }

    if (statusDot) statusDot.className = 'w-2.5 h-2.5 rounded-full bg-green-400';
    if (statusText) statusText.textContent = `INDEX READY (${Object.keys(IDX).length.toLocaleString()} ITEMS)`;
  } catch (err) {
    console.error('buildPrepackedIndexes error:', err);
    if (statusDot) statusDot.className = 'w-2.5 h-2.5 rounded-full bg-red-500';
    if (statusText) statusText.textContent = 'INDEX LOAD ERROR: ' + err.message;
  }
};