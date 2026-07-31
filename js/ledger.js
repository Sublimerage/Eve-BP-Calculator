'use strict';

// Local HTML Escaper Helper
function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Safe JSON parser to prevent legacy data from crash-blocking script compilation
function safeParseJSON(str, fallback) {
  if (!str || str === 'undefined' || str === 'null') return fallback;
  try {
    const parsed = JSON.parse(str);
    return parsed !== null && parsed !== undefined ? parsed : fallback;
  } catch (e) {
    return fallback;
  }
}

// Convert seconds into human-readable EVE duration format (e.g. 1d 4h 12m)
function formatDuration(seconds) {
  if (!seconds || isNaN(seconds) || seconds <= 0) return 'N/A';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (mins > 0) parts.push(`${mins}m`);
  if (parts.length === 0) parts.push(`${secs}s`);
  return parts.join(' ');
}

// Global Ledger Queue State (relying on global userStockMap from config.js)
let activeJobs = [];
let buildHistory = [];

// Active BOM Filter States
let activeOrderFilter = 'all'; // 'all', 'buy', 'sell'
let activeCategoryFilter = 'all'; // 'all', 'minerals', 'pigas', 'fuel', 'ships', 'others'

// Load states defensively from shared LocalStorage (avoiding global reference mutations)
function loadJournalState() {
  try {
    const savedJobs = localStorage.getItem('eve_ledger_jobs');
    activeJobs = safeParseJSON(savedJobs, []);
    if (!Array.isArray(activeJobs)) activeJobs = [];
  } catch (e) {
    activeJobs = [];
  }

  try {
    const savedHistory = localStorage.getItem('eve_ledger_history');
    buildHistory = safeParseJSON(savedHistory, []);
    if (!Array.isArray(buildHistory)) buildHistory = [];
  } catch (e) {
    buildHistory = [];
  }

  // Safely empty and refill rawAssetItems (Array)
  try {
    const rawSaved = localStorage.getItem('eve_raw_assets');
    const parsedRaw = safeParseJSON(rawSaved, []);
    rawAssetItems.length = 0; 
    parsedRaw.forEach(item => {
      if (item) rawAssetItems.push(item);
    });
  } catch (e) {
    rawAssetItems.length = 0;
  }

  // Safely empty and refill resolvedLocationNames (Object)
  try {
    const resolvedSaved = localStorage.getItem('eve_resolved_location_names');
    const parsedResolved = safeParseJSON(resolvedSaved, {});
    for (const key in resolvedLocationNames) {
      delete resolvedLocationNames[key];
    }
    Object.assign(resolvedLocationNames, parsedResolved);
  } catch (e) {
    for (const key in resolvedLocationNames) {
      delete resolvedLocationNames[key];
    }
  }

  // Safely empty and refill corpDivisionNames (Object)
  try {
    const corpSaved = localStorage.getItem('eve_corp_division_names');
    const parsedCorp = safeParseJSON(corpSaved, {});
    for (const key in corpDivisionNames) {
      delete corpDivisionNames[key];
    }
    Object.assign(corpDivisionNames, parsedCorp);
  } catch (e) {
    for (const key in corpDivisionNames) {
      delete corpDivisionNames[key];
    }
  }

  // Safely empty and refill userStockMap (Object)
  try {
    const savedStocks = localStorage.getItem('eve_user_stock_map');
    const parsedStocks = safeParseJSON(savedStocks, {});
    for (const key in userStockMap) {
      delete userStockMap[key];
    }
    Object.assign(userStockMap, parsedStocks);
  } catch (e) {
    for (const key in userStockMap) {
      delete userStockMap[key];
    }
  }
}

// Structural helper to classify material categories
function getItemCategory(typeId, name) {
  if (!name) return 'others';
  const n = name.toLowerCase();

  // Minerals Group
  const mineralIds = new Set([34, 35, 36, 37, 38, 39, 40, 11399]);
  if (mineralIds.has(typeId) || n.includes('tritanium') || n.includes('pyerite') || n.includes('mexallon') || n.includes('isogen') || n.includes('nocxium') || n.includes('zydrine') || n.includes('megacyte') || n.includes('morphite')) {
    return 'minerals';
  }

  // Fuel Blocks Group
  if (n.includes('fuel block')) {
    return 'fuel';
  }

  // PI & Industrial Gases Group
  if (n.includes('gas') || n.includes('isotope') || n.includes('water') || n.includes('ozone') || 
      n.includes('plastics') || n.includes('chiral') || n.includes('cultures') || n.includes('viral') || n.includes('fiber') || n.includes('nanites')) {
    return 'pigas';
  }

  // Ships Group
  if (typeof isShipType === 'function' && isShipType(typeId)) {
    return 'ships';
  }

  return 'others';
}

// Render overall dashboard KPIs and list details
function renderJournalPage() {
  loadJournalState();

  const activeJobsCountEl = document.getElementById('journal-active-jobs');
  const totalCostEl = document.getElementById('journal-total-cost');
  const uniqueMaterialsEl = document.getElementById('journal-unique-materials');
  const materialsCostEl = document.getElementById('journal-materials-cost');

  // 1. Calculate Active Jobs Cost KPI
  let totalActiveCost = 0;
  activeJobs.forEach(job => {
    if (job) totalActiveCost += job.calculatedCost || 0;
  });

  if (activeJobsCountEl) activeJobsCountEl.textContent = activeJobs.length.toLocaleString();
  if (totalCostEl) totalCostEl.textContent = Math.round(totalActiveCost).toLocaleString() + ' ISK';

  // 2. Compile Consolidated BOM across ALL active jobs (respecting strategy & category filters)
  const consolidatedBOM = {};
  activeJobs.forEach(job => {
    if (job && Array.isArray(job.materials)) {
      job.materials.forEach(mat => {
        if (!mat || !mat.typeId) return;

        // Apply Order strategy filters dynamically on consolidation
        if (activeOrderFilter !== 'all' && mat.strategy !== activeOrderFilter) return;

        // Apply Category filters dynamically on consolidation
        const category = getItemCategory(mat.typeId, mat.name);
        if (activeCategoryFilter !== 'all' && category !== activeCategoryFilter) return;

        const id = mat.typeId;
        if (!consolidatedBOM[id]) {
          consolidatedBOM[id] = {
            typeId: id,
            name: mat.name,
            totalQtyNeeded: 0,
            unitPrice: mat.unitPrice || 0,
            strategy: mat.strategy || 'sell'
          };
        }
        consolidatedBOM[id].totalQtyNeeded += mat.qtyNeeded || 0;
      });
    }
  });

  // 3. Contrast consolidated material totals against active hangar stock map
  const bomItems = Object.values(consolidatedBOM);
  let aggregatedMissingCost = 0;

  const deductModeInput = document.getElementById('deduct-stock-mode');
  const isStockDeductEnabled = deductModeInput ? deductModeInput.value === 'true' : true;

  bomItems.forEach(item => {
    const stockQty = isStockDeductEnabled ? (userStockMap[item.typeId] || 0) : 0;
    const netMissing = Math.max(0, item.totalQtyNeeded - stockQty);
    item.stockQty = stockQty;
    item.netMissingQty = netMissing;
    item.lineCost = item.unitPrice * netMissing;
    aggregatedMissingCost += item.lineCost;
  });

  // Sort missing items by descending line cost (most expensive deficits first)
  bomItems.sort((a, b) => b.lineCost - a.lineCost);

  if (uniqueMaterialsEl) uniqueMaterialsEl.textContent = bomItems.length.toLocaleString() + ' types';
  if (materialsCostEl) materialsCostEl.textContent = Math.round(aggregatedMissingCost).toLocaleString() + ' ISK';

  // Clone stock map for prioritized FIFO allocation across job card loops
  const allocatedStock = { ...userStockMap };

  renderActiveJobsList(allocatedStock);
  renderConsolidatedBOMList(bomItems, aggregatedMissingCost);
  renderBuildHistoryLedger();
}

// Render active queued jobs
function renderActiveJobsList(allocatedStock) {
  const container = document.getElementById('active-jobs-list');
  if (!container) return;

  if (activeJobs.length === 0) {
    container.innerHTML = `
      <div class="col-span-full bg-[#0c1318] border border-[#1e3348] p-8 rounded text-center text-slate-400 mono">
        No active manufacturing jobs queued in ledger. Go back to the calculator and click "Add to Job Queue" on any root item card to add jobs here.
      </div>
    `;
    return;
  }

  const deductModeInput = document.getElementById('deduct-stock-mode');
  const isStockDeductEnabled = deductModeInput ? deductModeInput.value === 'true' : true;

  // Retrieve Character skills for accurate TE Calculations
  const skills = safeParseJSON(localStorage.getItem('eve_char_skills'), { industry: 0, advIndustry: 0 });
  const indFactor = 1 - (0.04 * (skills.industry || 0));
  const advIndFactor = 1 - (0.03 * (skills.advIndustry || 0));
  const skillTimeFactor = indFactor * advIndFactor;

  container.innerHTML = activeJobs.map(job => {
    if (!job) return '';
    const iconTypeId = job.typeId;
    const formattedDate = job.addedAt ? new Date(job.addedAt).toLocaleDateString() : 'N/A';

    // Generate individual BOM breakdown defensively with prioritized FIFO allocation
    const individualBOMHTML = Array.isArray(job.materials) ? job.materials.map(mat => {
      if (!mat) return '';
      
      const availableInStock = isStockDeductEnabled ? (allocatedStock[mat.typeId] || 0) : 0;
      const consumedQty = Math.min(mat.qtyNeeded, availableInStock);

      // Subtract consumed parts iteratively from our prioritized in-memory stock clone
      if (isStockDeductEnabled && allocatedStock[mat.typeId] !== undefined) {
        allocatedStock[mat.typeId] = Math.max(0, allocatedStock[mat.typeId] - consumedQty);
      }

      const netMissing = Math.max(0, mat.qtyNeeded - consumedQty);
      const isAcquired = netMissing === 0;

      return `
        <div class="flex justify-between items-center text-[10px] mono py-0.5 border-b border-[#1e3348]/20 ${isAcquired ? 'text-green-400' : 'text-slate-400'}">
          <span class="truncate pr-4">${esc(mat.name)}</span>
          <span class="flex-shrink-0">${isAcquired ? `✔ ${mat.qtyNeeded}` : `x${mat.qtyNeeded} (Deficit: ${netMissing})`}</span>
        </div>
      `;
    }).join('') : '<div class="text-[10px] text-slate-500 italic py-1">No materials logged for this build.</div>';

    // 2. Skill-adjusted Build Duration calculation per card
    let buildTimeUI = '';
    const recipe = window.recipeMap ? (window.recipeMap[job.typeId] || null) : null;
    if (recipe && recipe.time) {
      const baseTime = recipe.time || 0;
      const teFactor = 1.0; // standard default TE factor fallback
      const facility = document.getElementById('facility-select')?.value || '0.01';
      const facilityTimeBonus = (facility === '0.01') ? 0.05 : 0; // Sotiyo offers 5% manufacturing time rigs
      const facilityFactor = 1 - facilityTimeBonus;

      const totalSeconds = baseTime * teFactor * skillTimeFactor * facilityFactor * job.runsNeeded;
      buildTimeUI = `
        <div class="flex justify-between text-[10px] text-slate-400 mono">
          <span>Est. Build Time:</span>
          <span class="text-slate-300 font-semibold">${formatDuration(totalSeconds)}</span>
        </div>
      `;
    }

    return `
      <div class="bg-[#0c1318] border border-[#1e3348] hover:border-purple-500/40 rounded p-4 flex flex-col justify-between shadow-md transition space-y-3">
        <div class="flex items-start space-x-3">
          <img src="https://images.evetech.net/types/${iconTypeId}/icon?size=64" class="w-12 h-12 rounded border border-slate-700 bg-[#070b0f] flex-shrink-0" onerror="this.onerror=null; this.src='https://images.evetech.net/types/${iconTypeId}/render?size=64';">
          <div class="min-w-0 flex-1">
            <h3 class="font-bold text-sm text-white truncate">${esc(job.name)}</h3>
            <div class="text-[10px] mono text-slate-400 mt-0.5">Added on: ${formattedDate}</div>
            <div class="text-[11px] text-purple-300 font-bold mono mt-1">
              ${job.runsNeeded.toLocaleString()} Run${job.runsNeeded > 1 ? 's' : ''} @ ${job.qtyNeeded.toLocaleString()} total units
            </div>
          </div>
        </div>

        <!-- Individual Material BOM breakdown area with Priority allocation -->
        <div class="p-2 bg-[#070b0f] rounded border border-[#1e3348]/40">
          <div class="flex justify-between items-center mb-1.5 pb-1 border-b border-[#1e3348]/40">
            <span class="text-[10px] text-cyan-400 font-bold uppercase tracking-wider rajdhani">Job Materials (BOM)</span>
            <button onclick="copyIndividualJobMultibuy(event, ${job.id})" class="text-[9px] bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold px-1.5 py-0.5 rounded mono transition">
              📋 Copy BOM
            </button>
          </div>
          <div class="max-h-28 overflow-y-auto scrollbar-thin">
            ${individualBOMHTML}
          </div>
          <div class="flex flex-col text-[10px] mono font-bold pt-1.5 border-t border-[#1e3348]/40 mt-1 space-y-1">
            ${buildTimeUI}
            <div class="flex justify-between items-center mt-0.5">
              <span class="text-slate-300">Total Build Cost:</span>
              <span class="text-cyan-400">${Math.round(job.calculatedCost).toLocaleString()} ISK</span>
            </div>
          </div>
        </div>

        <div class="flex items-center space-x-2 pt-1">
          <button onclick="markJobAsBuilt(${job.id})" class="flex-1 py-1.5 bg-green-800/80 hover:bg-green-700 text-white font-bold rounded text-[11px] mono transition border border-green-600/30 flex items-center justify-center gap-1">
            ✔ Built
          </button>
          <button onclick="deleteJobFromQueue(${job.id})" class="py-1.5 px-3 bg-red-950/60 hover:bg-red-800 text-red-300 font-bold rounded text-[11px] mono transition border border-red-800/30 flex items-center justify-center">
            ❌ Delete
          </button>
        </div>
      </div>
    `;
  }).join('');
}

// Copy single card deficit components to clipboard in EVE Online Multibuy format
function copyIndividualJobMultibuy(e, jobId) {
  if (e) e.stopPropagation();
  
  const job = activeJobs.find(j => j && j.id === jobId);
  if (!job || !Array.isArray(job.materials)) return;

  const deductModeInput = document.getElementById('deduct-stock-mode');
  const isStockDeductEnabled = deductModeInput ? deductModeInput.value === 'true' : true;

  // We re-evaluate priority allocations dynamically on copy click
  const allocatedStock = { ...userStockMap };
  const targetIndex = activeJobs.findIndex(j => j && j.id === jobId);
  
  // Deduct previous jobs first to match FIFO priority bounds
  for (let i = 0; i < targetIndex; i++) {
    const prevJob = activeJobs[i];
    if (prevJob && Array.isArray(prevJob.materials)) {
      prevJob.materials.forEach(mat => {
        const availableInStock = isStockDeductEnabled ? (allocatedStock[mat.typeId] || 0) : 0;
        const consumed = Math.min(mat.qtyNeeded, availableInStock);
        if (allocatedStock[mat.typeId] !== undefined) {
          allocatedStock[mat.typeId] = Math.max(0, allocatedStock[mat.typeId] - consumed);
        }
      });
    }
  }

  const textList = job.materials
    .filter(m => {
      if (!m) return false;
      const availableInStock = isStockDeductEnabled ? (allocatedStock[m.typeId] || 0) : 0;
      return (m.qtyNeeded - availableInStock) > 0;
    })
    .map(m => {
      const availableInStock = isStockDeductEnabled ? (allocatedStock[m.typeId] || 0) : 0;
      const netMissing = m.qtyNeeded - availableInStock;
      return `${m.name} x${netMissing}`;
    })
    .join('\n');

  if (!textList.trim()) return;

  navigator.clipboard.writeText(textList).then(() => {
    const btn = e.target;
    if (btn) {
      const origText = btn.innerHTML;
      btn.innerHTML = 'Copied!';
      btn.className = 'text-[9px] bg-green-600 text-white font-bold px-1.5 py-0.5 rounded mono transition';
      setTimeout(() => {
        btn.innerHTML = origText;
        btn.className = 'text-[9px] bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold px-1.5 py-0.5 rounded mono transition';
      }, 1500);
    }
  });
}

// Render Consolidated BOM Sidebar
function renderConsolidatedBOMList(bomItems, totalMissingISK) {
  const container = document.getElementById('journal-bom-items');
  const bomTypesEl = document.getElementById('journal-bom-types');
  const bomTotalEl = document.getElementById('journal-bom-total');

  if (bomTypesEl) bomTypesEl.textContent = bomItems.length.toString();
  if (bomTotalEl) bomTotalEl.textContent = Math.round(totalMissingISK).toLocaleString() + ' ISK';

  if (!container) return;

  if (bomItems.length === 0) {
    container.innerHTML = `
      <div class="bg-[#0c1318] p-4 text-center text-slate-400 mono italic">
        No active material demands in queue matching selected filters.
      </div>
    `;
    return;
  }

  container.innerHTML = bomItems.map(item => {
    const isCompleted = item.netMissingQty === 0;
    const rowBg = isCompleted ? 'bg-[#0a0f14]/50 border-green-950 opacity-60' : 'bg-[#0c1318] border-[#1e3348] hover:border-purple-500/40';
    const statusBadge = isCompleted 
      ? `<span class="bg-green-950 text-green-300 text-[9px] px-1 rounded font-bold uppercase ml-1.5 flex-shrink-0">Acquired</span>` 
      : `<span class="bg-amber-950 text-amber-300 text-[9px] px-1 rounded font-bold uppercase ml-1.5 flex-shrink-0">Missing</span>`;

    // Dynamic Buy/Sell strategy badge
    const strategyBadge = item.strategy === 'sell' 
      ? `<span class="bg-amber-900/60 text-amber-300 text-[9px] px-1 rounded font-bold uppercase ml-1.5 flex-shrink-0">SELL</span>` 
      : `<span class="bg-cyan-900/60 text-cyan-300 text-[9px] px-1 rounded font-bold uppercase ml-1.5 flex-shrink-0">BUY</span>`;

    return `
      <div class="rounded border p-2 flex items-center justify-between transition shadow-sm ${rowBg}">
        <div class="flex items-center space-x-2.5 min-w-0">
          <img src="https://images.evetech.net/types/${item.typeId}/icon?size=32" class="w-7 h-7 rounded border border-slate-700 bg-[#070b0f] flex-shrink-0" onerror="this.onerror=null; this.src='https://images.evetech.net/types/${item.typeId}/render?size=32';">
          <div class="min-w-0 flex-1">
            <div class="font-semibold text-slate-200 truncate flex items-center">
              <span class="truncate">${esc(item.name)}</span>
              ${statusBadge}
              ${strategyBadge}
            </div>
            <div class="text-[10px] text-slate-400 mono mt-0.5">
              Needed: ${item.totalQtyNeeded.toLocaleString()} | Stock: ${item.stockQty.toLocaleString()}
            </div>
            ${item.netMissingQty > 0 ? `<div class="text-[9px] text-amber-300 mono mt-0.5 font-bold">Deficit: &times;${item.netMissingQty.toLocaleString()}</div>` : ''}
          </div>
        </div>
        <div class="text-right mono font-bold text-cyan-400 flex-shrink-0 ml-2">
          ${Math.round(item.lineCost).toLocaleString()} ISK
        </div>
      </div>
    `;
  }).join('');

  // Cache missing list as text for EVE Multibuy copy/paste
  window.journalMultibuyText = bomItems
    .filter(i => i.netMissingQty > 0)
    .map(i => `${i.name} x${i.netMissingQty}`)
    .join('\n');
}

// Copy Consolidated Missing items to clipboard
function copyJournalMultibuy() {
  if (!window.journalMultibuyText) return;
  
  navigator.clipboard.writeText(window.journalMultibuyText).then(() => {
    const btn = document.querySelector('button[onclick="copyJournalMultibuy()"]');
    if (btn) {
      const origText = btn.textContent;
      btn.textContent = 'Copied!';
      btn.className = 'px-3.5 py-1.5 bg-green-600 text-white font-bold text-xs rounded mono transition';
      setTimeout(() => {
        btn.textContent = origText;
        btn.className = 'px-3.5 py-1.5 bg-purple-600 hover:bg-purple-500 text-white font-bold text-xs rounded mono transition shadow';
      }, 1500);
    }
  });
}

// Mark queued job as "built": Logs to History without deducting from active API stock map
function markJobAsBuilt(jobId) {
  loadJournalState();

  const jobIndex = activeJobs.findIndex(j => j && j.id === jobId);
  if (jobIndex === -1) return;

  const job = activeJobs[jobIndex];

  // Hangar stockpile quantities are left untouched as requested to ensure stock data relies strictly on ESI API and clipboard hangar pastes.

  // 1. Ledger Logging: Archive job records into completed build history array
  const record = {
    id: job.id,
    typeId: job.typeId,
    name: job.name,
    runsNeeded: job.runsNeeded,
    qtyNeeded: job.qtyNeeded,
    calculatedCost: job.calculatedCost,
    materials: job.materials, // Saved BOM
    completedAt: new Date().toISOString()
  };

  buildHistory.unshift(record); // Insert completed job as first record
  localStorage.setItem('eve_ledger_history', JSON.stringify(buildHistory));

  // 2. Remove job from the active manufacturing queue
  activeJobs.splice(jobIndex, 1);
  localStorage.setItem('eve_ledger_jobs', JSON.stringify(activeJobs));

  renderJournalPage();
}

// Re-queue completed job back into active queue
function requeueCompletedJob(recordId) {
  loadJournalState();

  const recordIndex = buildHistory.findIndex(r => r && r.id === recordId);
  if (recordIndex === -1) return;

  const record = buildHistory[recordIndex];

  const job = {
    id: Date.now() + Math.floor(Math.random() * 1000), // Watertight unique ID
    typeId: record.typeId,
    name: record.name,
    runsNeeded: record.runsNeeded,
    qtyNeeded: record.qtyNeeded,
    calculatedCost: record.calculatedCost,
    materials: record.materials || [],
    addedAt: new Date().toISOString()
  };

  activeJobs.push(job);
  localStorage.setItem('eve_ledger_jobs', JSON.stringify(activeJobs));

  renderJournalPage();
}

// Delete queued job from active queue (no history or stock deduction)
function deleteJobFromQueue(jobId) {
  loadJournalState();

  const index = activeJobs.findIndex(j => j && j.id === jobId);
  if (index !== -1) {
    activeJobs.splice(index, 1);
    localStorage.setItem('eve_ledger_jobs', JSON.stringify(activeJobs));
    renderJournalPage();
  }
}

// Render Completed build history table
function renderBuildHistoryLedger() {
  const container = document.getElementById('journal-history-rows');
  if (!container) return;

  if (buildHistory.length === 0) {
    container.innerHTML = `
      <tr>
        <td colspan="6" class="p-4 text-center text-slate-400 mono italic">
          No completed build records logged in ledger history database.
        </td>
      </tr>
    `;
    return;
  }

  container.innerHTML = buildHistory.map(record => {
    if (!record) return '';
    const formattedDate = record.completedAt ? new Date(record.completedAt).toLocaleDateString() + ' ' + new Date(record.completedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'N/A';
    return `
      <tr class="hover:bg-[#0c1318]/50 text-slate-300 border-b border-[#1e3348]/20">
        <td class="p-1.5 py-2">${formattedDate}</td>
        <td class="p-1.5 py-2 font-bold text-white">${esc(record.name)}</td>
        <td class="p-1.5 py-2 text-right">${record.runsNeeded.toLocaleString()}</td>
        <td class="p-1.5 py-2 text-right text-purple-300 font-bold">${record.qtyNeeded.toLocaleString()}</td>
        <td class="p-1.5 py-2 text-right text-cyan-400 font-bold">${Math.round(record.calculatedCost || 0).toLocaleString()} ISK</td>
        <td class="p-1.5 py-2">
          <div class="flex items-center space-x-2">
            <span class="text-green-400 font-bold uppercase text-[9px] bg-green-950 px-1 py-0.5 rounded">✔ Built</span>
            <button onclick="requeueCompletedJob(${record.id})" class="px-2 py-0.5 bg-purple-950/60 hover:bg-purple-800 text-purple-300 font-semibold rounded text-[9px] mono border border-purple-800/40 transition">
              🔄 Re-queue
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

// Clear finished build logs
function clearJournalHistory() {
  localStorage.removeItem('eve_ledger_history');
  renderJournalPage();
}

// --- Live stock location / Container filter panel ---
function populateJournalLocationDropdown() {
  const filterSelect = document.getElementById('stock-location-filter');
  if (!filterSelect) return;

  const currentValue = filterSelect.value || 'all';

  filterSelect.innerHTML = `
    <option value="all" style="color: #38bdf8; background-color: #0c1318; font-weight: bold;">All Locations (Combined Assets)</option>
    <option value="industry_system" style="color: #38bdf8; background-color: #0c1318; font-weight: bold;">Current System Only (JITA)</option>
  `;

  const sagNameMap = {
    'CorpSAG1': window.corpDivisionNames[1] || 'DIVISION 1',
    'CorpSAG2': window.corpDivisionNames[2] || 'DIVISION 2',
    'CorpSAG3': window.corpDivisionNames[3] || 'DIVISION 3',
    'CorpSAG4': window.corpDivisionNames[4] || 'DIVISION 4',
    'CorpSAG5': window.corpDivisionNames[5] || 'DIVISION 5',
    'CorpSAG6': window.corpDivisionNames[6] || 'DIVISION 6',
    'CorpSAG7': window.corpDivisionNames[7] || 'DIVISION 7',
    'CorpDeliveries': 'CORP DELIVERIES'
  };

  const locCounts = {};
  window.rawAssetItems.forEach(item => {
    if (!item) return;
    const locId = item.root_location_id || item.location_id;
    const locName = window.resolvedLocationNames[locId] || `Location #${locId}`;

    if (!locCounts[locId]) {
      locCounts[locId] = {
        name: locName,
        count: 0,
        corpDivisions: {},
        containers: {}
      };
    }
    locCounts[locId].count += item.quantity;

    if (item.owner_type === 'corp' && item.location_flag && item.location_flag.startsWith('Corp')) {
      const sagFlag = item.location_flag;
      if (!locCounts[locId].corpDivisions[sagFlag]) {
        locCounts[locId].corpDivisions[sagFlag] = {
          name: sagNameMap[sagFlag] || sagFlag,
          count: 0
        };
      }
      locCounts[locId].corpDivisions[sagFlag].count += item.quantity;
    }

    if (item.container_id) {
      const cId = item.container_id;
      const cName = window.resolvedLocationNames[cId] || `Container #${cId}`;
      if (!locCounts[locId].containers[cId]) {
        locCounts[locId].containers[cId] = {
          name: cName,
          count: 0
        };
      }
      locCounts[locId].containers[cId].count += item.quantity;
    }
  });

  for (const [locId, data] of Object.entries(locCounts)) {
    const mainOpt = document.createElement('option');
    mainOpt.value = `loc_${locId}`;
    
    const numericLocId = parseInt(locId);
    const isUpwellStructure = numericLocId > 1000000000000;

    if (isUpwellStructure) {
      mainOpt.style.color = '#f97316';
      mainOpt.style.backgroundColor = '#0c1318';
      mainOpt.style.fontWeight = 'bold';
      mainOpt.textContent = `🟧 ${data.name} (${data.count.toLocaleString()} items)`;
    } else {
      mainOpt.style.color = '#4caf6f';
      mainOpt.style.backgroundColor = '#0c1318';
      mainOpt.style.fontWeight = 'bold';
      mainOpt.textContent = `🟩 ${data.name} (${data.count.toLocaleString()} items)`;
    }

    filterSelect.appendChild(mainOpt);

    for (const [sagFlag, sagData] of Object.entries(data.corpDivisions)) {
      const sagOpt = document.createElement('option');
      sagOpt.value = `corpsag_${locId}_${sagFlag}`;
      sagOpt.style.color = '#c084fc';
      sagOpt.style.backgroundColor = '#070b0f';
      sagOpt.style.fontWeight = 'bold';
      sagOpt.textContent = `  └─ 🟪 Corp Hangar: ${sagData.name} (${sagData.count.toLocaleString()} items)`;
      filterSelect.appendChild(sagOpt);
    }

    for (const [cId, cData] of Object.entries(data.containers)) {
      const containerOpt = document.createElement('option');
      containerOpt.value = `container_${cId}`;
      containerOpt.style.color = '#f8fafc';
      containerOpt.style.backgroundColor = '#070b0f';
      containerOpt.textContent = `  └─ 📦 Container: ${cData.name} (${cData.count.toLocaleString()} items)`;
      filterSelect.appendChild(containerOpt);
    }
  }

  if (filterSelect.querySelector(`option[value="${currentValue}"]`)) {
    filterSelect.value = currentValue;
  } else {
    filterSelect.value = 'all';
  }
}

function filterJournalLocationOptions() {
  const query = (document.getElementById('location-filter-search')?.value || '').trim().toUpperCase();
  const filterSelect = document.getElementById('stock-location-filter');
  const feedbackBadge = document.getElementById('location-search-feedback');
  if (!filterSelect) return;

  const options = filterSelect.querySelectorAll('option');
  let visibleCount = 0;

  options.forEach(opt => {
    if (opt.value === 'all' || opt.value === 'industry_system') {
      opt.style.display = '';
    } else {
      if (!query || opt.textContent.toUpperCase().includes(query)) {
        opt.style.display = '';
        visibleCount++;
      } else {
        opt.style.display = 'none';
      }
    }
  });

  if (feedbackBadge) {
    if (query) {
      feedbackBadge.textContent = `Found: ${visibleCount} location(s) / container(s)`;
      feedbackBadge.classList.remove('hidden');
    } else {
      feedbackBadge.textContent = '';
      feedbackBadge.classList.add('hidden');
    }
  }
}

function updateJournalStockCountBadge() {
  const el = document.getElementById('stock-count-display');
  if (!el) return;
  const totalItems = Object.values(window.userStockMap || {}).reduce((acc, q) => acc + q, 0);
  el.textContent = `${totalItems.toLocaleString()} items`;
}

function applyJournalStockFilter() {
  const filterVal = document.getElementById('stock-location-filter')?.value || 'all';

  const useChar = document.getElementById('use-char-assets')?.checked ?? true;
  const useCorp = document.getElementById('use-corp-assets')?.checked ?? true;

  window.userStockMap = {};

  window.rawAssetItems.forEach(item => {
    if (!item) return;
    if (item.owner_type === 'char' && !useChar) return;
    if (item.owner_type === 'corp' && !useCorp) return;

    let include = false;
    const rootLocId = item.root_location_id || item.location_id;
    const itemLocName = window.resolvedLocationNames[rootLocId] || '';

    if (filterVal === 'all') {
      include = true;
    } else if (filterVal === 'industry_system') {
      include = itemLocName.includes('JITA');
    } else if (filterVal.startsWith('loc_')) {
      const targetLocId = parseInt(filterVal.replace('loc_', ''));
      include = rootLocId === targetLocId;
    } else if (filterVal.startsWith('corpsag_')) {
      const parts = filterVal.split('_');
      const targetLocId = parseInt(parts[1]);
      const targetSag = parts[2];
      include = (rootLocId === targetLocId) && (item.location_flag === targetSag);
    } else if (filterVal.startsWith('container_')) {
      const targetContainerId = parseInt(filterVal.replace('container_', ''));
      include = item.container_id === targetContainerId;
    }

    if (include) {
      window.userStockMap[item.type_id] = (window.userStockMap[item.type_id] || 0) + item.quantity;
    }
  });

  // Sync to shared memory
  localStorage.setItem('eve_user_stock_map', JSON.stringify(window.userStockMap));

  updateJournalStockCountBadge();
  renderJournalPage();
}

function recalculateJournalStock() {
  applyJournalStockFilter();
}

// Active BOM Filter actions
function setBOMOrderFilter(type) {
  activeOrderFilter = type;
  const btnAll = document.getElementById('btn-order-all');
  const btnBuy = document.getElementById('btn-order-buy');
  const btnSell = document.getElementById('btn-order-sell');

  if (btnAll) btnAll.className = 'px-1.5 py-0.5 rounded font-bold transition ' + (type === 'all' ? 'bg-purple-800 text-white border border-purple-600/30' : 'bg-[#1e3348] text-slate-400 hover:text-white');
  if (btnBuy) btnBuy.className = 'px-1.5 py-0.5 rounded font-bold transition ' + (type === 'buy' ? 'bg-purple-800 text-white border border-purple-600/30' : 'bg-[#1e3348] text-slate-400 hover:text-white');
  if (btnSell) btnSell.className = 'px-1.5 py-0.5 rounded font-bold transition ' + (type === 'sell' ? 'bg-purple-800 text-white border border-purple-600/30' : 'bg-[#1e3348] text-slate-400 hover:text-white');

  renderJournalPage();
}

function setBOMCategoryFilter(cat) {
  activeCategoryFilter = cat;
  renderJournalPage();
}

// Expose actions globally to windows environment
window.copyJournalMultibuy = copyJournalMultibuy;
window.copyIndividualJobMultibuy = copyIndividualJobMultibuy;
window.markJobAsBuilt = markJobAsBuilt;
window.requeueCompletedJob = requeueCompletedJob;
window.deleteJobFromQueue = deleteJobFromQueue;
window.clearJournalHistory = clearJournalHistory;
window.applyJournalStockFilter = applyJournalStockFilter;
window.filterJournalLocationOptions = filterJournalLocationOptions;
window.recalculateJournalStock = recalculateJournalStock;
window.setBOMOrderFilter = setBOMOrderFilter;
window.setBOMCategoryFilter = setBOMCategoryFilter;

// Initialize Ledger page on window load
window.onload = () => {
  if (typeof window.buildPrepackedIndexes === 'function') {
    window.buildPrepackedIndexes();
  }
  loadJournalState();
  populateJournalLocationDropdown();
  updateJournalStockCountBadge();
  renderJournalPage();
};