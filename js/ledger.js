'use strict';

let activeJobs = [];
let buildHistory = [];

let activeOrderFilter = 'all'; 
let activeCategoryFilter = 'all'; 

function loadJournalState() {
  try {
    const savedJobs = localStorage.getItem('eve_ledger_jobs');
    activeJobs = window.safeParseJSON(savedJobs, []);
    if (!Array.isArray(activeJobs)) activeJobs = [];
  } catch (e) {
    activeJobs = [];
  }

  try {
    const savedHistory = localStorage.getItem('eve_ledger_history');
    buildHistory = window.safeParseJSON(savedHistory, []);
    if (!Array.isArray(buildHistory)) buildHistory = [];
  } catch (e) {
    buildHistory = [];
  }

  try {
    const rawSaved = localStorage.getItem('eve_raw_assets');
    const parsedRaw = window.safeParseJSON(rawSaved, []);
    rawAssetItems.length = 0; 
    parsedRaw.forEach(item => {
      if (item) rawAssetItems.push(item);
    });
  } catch (e) {
    rawAssetItems.length = 0;
  }

  try {
    const resolvedSaved = localStorage.getItem('eve_resolved_location_names');
    const parsedResolved = window.safeParseJSON(resolvedSaved, {});
    for (const key in resolvedLocationNames) {
      delete resolvedLocationNames[key];
    }
    Object.assign(resolvedLocationNames, parsedResolved);
  } catch (e) {
    for (const key in resolvedLocationNames) {
      delete resolvedLocationNames[key];
    }
  }

  try {
    const corpSaved = localStorage.getItem('eve_corp_division_names');
    const parsedCorp = window.safeParseJSON(corpSaved, {});
    for (const key in corpDivisionNames) {
      delete corpDivisionNames[key];
    }
    Object.assign(corpDivisionNames, parsedCorp);
  } catch (e) {
    for (const key in corpDivisionNames) {
      delete corpDivisionNames[key];
    }
  }

  try {
    const savedStocks = localStorage.getItem('eve_user_stock_map');
    const parsedStocks = window.safeParseJSON(savedStocks, {});
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

function getItemCategory(typeId, name) {
  if (!name) return 'others';
  const n = name.toLowerCase();
  const mineralIds = new Set([34, 35, 36, 37, 38, 39, 40, 11399]);
  if (mineralIds.has(typeId) || n.includes('tritanium') || n.includes('pyerite') || n.includes('mexallon') || n.includes('isogen') || n.includes('nocxium') || n.includes('zydrine') || n.includes('megacyte') || n.includes('morphite')) {
    return 'minerals';
  }
  if (n.includes('fuel block')) {
    return 'fuel';
  }
  if (n.includes('gas') || n.includes('isotope') || n.includes('water') || n.includes('ozone') || 
      n.includes('plastics') || n.includes('chiral') || n.includes('cultures') || n.includes('viral') || n.includes('fiber') || n.includes('nanites')) {
    return 'pigas';
  }
  if (typeof window.isShipType === 'function' && window.isShipType(typeId)) {
    return 'ships';
  }
  return 'others';
}

function renderJournalPage() {
  loadJournalState();

  const activeJobsCountEl = document.getElementById('journal-active-jobs');
  const totalCostEl = document.getElementById('journal-total-cost');
  const uniqueMaterialsEl = document.getElementById('journal-unique-materials');
  const materialsCostEl = document.getElementById('journal-materials-cost');

  let totalActiveCost = 0;
  activeJobs.forEach(job => {
    if (job) totalActiveCost += job.calculatedCost || 0;
  });

  if (activeJobsCountEl) activeJobsCountEl.textContent = activeJobs.length.toLocaleString();
  if (totalCostEl) totalCostEl.textContent = Math.round(totalActiveCost).toLocaleString() + ' ISK';

  const consolidatedBOM = {};
  activeJobs.forEach(job => {
    if (job && Array.isArray(job.materials)) {
      job.materials.forEach(mat => {
        if (!mat || !mat.typeId) return;
        if (activeOrderFilter !== 'all' && mat.strategy !== activeOrderFilter) return;

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

  bomItems.sort((a, b) => b.lineCost - a.lineCost);

  if (uniqueMaterialsEl) uniqueMaterialsEl.textContent = bomItems.length.toLocaleString() + ' types';
  if (materialsCostEl) materialsCostEl.textContent = Math.round(aggregatedMissingCost).toLocaleString() + ' ISK';

  const allocatedStock = { ...userStockMap };

  renderActiveJobsList(allocatedStock);
  renderConsolidatedBOMList(bomItems, aggregatedMissingCost);
  renderBuildHistoryLedger();
}

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

  container.innerHTML = activeJobs.map(job => {
    if (!job) return '';
    const iconTypeId = job.productTypeId || job.typeId;
    const formattedDate = job.addedAt ? new Date(job.addedAt).toLocaleDateString() : 'N/A';

    const priorityButtonsHTML = `
      <div class="flex items-center space-x-1 flex-shrink-0" onclick="event.stopPropagation()">
        <button onclick="moveJobUp(${job.id})" class="bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white font-bold px-1.5 py-0.5 rounded text-[9px] mono border border-[#1e3348]" title="Move up in priority (increases stock allocation preference)">
          ▲ Up
        </button>
        <button onclick="moveJobDown(${job.id})" class="bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white font-bold px-1.5 py-0.5 rounded text-[9px] mono border border-[#1e3348]" title="Move down in priority">
          ▼ Down
        </button>
      </div>
    `;

    const individualBOMHTML = Array.isArray(job.materials) ? job.materials.map(mat => {
      if (!mat) return '';
      const availableInStock = isStockDeductEnabled ? (allocatedStock[mat.typeId] || 0) : 0;
      const consumedQty = Math.min(mat.qtyNeeded, availableInStock);

      if (isStockDeductEnabled && allocatedStock[mat.typeId] !== undefined) {
        allocatedStock[mat.typeId] = Math.max(0, allocatedStock[mat.typeId] - consumedQty);
      }

      const netMissing = Math.max(0, mat.qtyNeeded - consumedQty);
      const isAcquired = netMissing === 0;

      return `
        <div class="flex justify-between items-center text-[10px] mono py-0.5 border-b border-[#1e3348]/20 ${isAcquired ? 'text-green-400' : 'text-slate-400'}">
          <span class="truncate pr-4">${window.esc(mat.name)}</span>
          <span class="flex-shrink-0">${isAcquired ? `✔ ${mat.qtyNeeded}` : `x${mat.qtyNeeded} (Deficit: ${netMissing})`}</span>
        </div>
      `;
    }).join('') : '<div class="text-[10px] text-slate-500 italic py-1">No materials logged for this build.</div>';

    let buildTimeUI = '';
    const baseTime = job.baseTime || 0;
    if (baseTime > 0) {
      const teFactor = 1.0; 
      const skills = window.safeParseJSON(localStorage.getItem('eve_char_skills'), { industry: 5, advIndustry: 5 });
      const indFactor = 1 - (0.04 * (skills.industry || 0));
      const advIndFactor = 1 - (0.03 * (skills.advIndustry || 0));
      const skillTimeFactor = indFactor * advIndFactor;

      const activeFacilityKey = localStorage.getItem('eve_active_facility_key') || 'sotiyo';
      let facilityFactor = 1.0;
      let structureName = 'NPC Station';
      let structureTEBonus = '0%';
      if (activeFacilityKey === 'sotiyo') { facilityFactor = 0.70; structureName = 'Sotiyo'; structureTEBonus = '30%'; }
      else if (activeFacilityKey === 'azbel') { facilityFactor = 0.80; structureName = 'Azbel'; structureTEBonus = '20%'; }
      else if (activeFacilityKey === 'raitaru') { facilityFactor = 0.85; structureName = 'Raitaru'; structureTEBonus = '15%'; }

      const totalSeconds = baseTime * teFactor * skillTimeFactor * facilityFactor * job.runsNeeded;
      const hoverTitle = `Skill Reductions Applied:\n• Industry Level: ${skills.industry}/5\n• Advanced Industry Level: ${skills.advIndustry}/5\n• Structure Bonus: ${structureName} (${structureTEBonus} TE reduction)\n• Base SDE Time: ${window.formatDuration(baseTime)}`;

      buildTimeUI = `
        <div class="flex justify-between text-[10px] text-slate-400 mono cursor-help" title="${window.esc(hoverTitle)}">
          <span>Est. Build Time:</span>
          <span class="text-slate-300 font-semibold">${window.formatDuration(totalSeconds)}</span>
        </div>
      `;
    }

    // CORRECTION: Direct blueprint path safety check inside active jobs loop prevents any imageservers 400 errors [1.1.1, 1.1.4]
    const jobNameLower = (window.TYPE_ID_TO_NAME[iconTypeId] || job.name || '').toLowerCase();
    const isJobBp = jobNameLower.includes('blueprint') || jobNameLower.includes('formula') || jobNameLower.includes('reaction');
    const jobIconUrl = isJobBp
      ? `https://images.evetech.net/types/${iconTypeId}/bp?size=64`
      : `https://images.evetech.net/types/${iconTypeId}/icon?size=64`;

    return `
      <div class="bg-[#0c1318] border border-[#1e3348] hover:border-purple-500/40 rounded p-4 flex flex-col justify-between shadow-md transition space-y-3">
        <div class="flex items-start justify-between">
          <div class="flex items-start space-x-3 min-w-0 flex-1">
            <img src="${jobIconUrl}" class="w-12 h-12 rounded border border-slate-700 bg-[#070b0f] flex-shrink-0" onerror="this.onerror=null; this.src='https://images.evetech.net/types/${iconTypeId}/render?size=64';">
            <div class="min-w-0 flex-1">
              <h3 class="font-bold text-sm text-white truncate">${window.esc(job.name)}</h3>
              <div class="text-[10px] mono text-slate-400 mt-0.5">Added on: ${formattedDate}</div>
            </div>
          </div>
          ${priorityButtonsHTML}
        </div>

        <div class="text-[11px] text-purple-300 font-bold mono mt-1">
          ${job.runsNeeded.toLocaleString()} Run${job.runsNeeded > 1 ? 's' : ''} @ ${job.qtyNeeded.toLocaleString()} total units
        </div>

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

function copyIndividualJobMultibuy(e, jobId) {
  if (e) e.stopPropagation();
  const job = activeJobs.find(j => j && j.id === jobId);
  if (!job || !Array.isArray(job.materials)) return;

  const deductModeInput = document.getElementById('deduct-stock-mode');
  const isStockDeductEnabled = deductModeInput ? deductModeInput.value === 'true' : true;

  const allocatedStock = { ...userStockMap };
  const targetIndex = activeJobs.findIndex(j => j && j.id === jobId);
  
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

    const strategyBadge = item.strategy === 'sell' 
      ? `<span class="bg-amber-900/60 text-amber-300 text-[9px] px-1 rounded font-bold uppercase ml-1.5 flex-shrink-0">SELL</span>` 
      : `<span class="bg-cyan-900/60 text-cyan-300 text-[9px] px-1 rounded font-bold uppercase ml-1.5 flex-shrink-0">BUY</span>`;

    // CORRECTION: Direct blueprint path safety check inside consolidated BOM prevents any imageservers 400 errors [1.1.1, 1.1.4]
    const itemNameLower = (window.TYPE_ID_TO_NAME[item.typeId] || item.name || '').toLowerCase();
    const isItemBp = itemNameLower.includes('blueprint') || itemNameLower.includes('formula') || itemNameLower.includes('reaction');
    const itemIconUrl = isItemBp
      ? `https://images.evetech.net/types/${item.typeId}/bp?size=32`
      : `https://images.evetech.net/types/${item.typeId}/icon?size=32`;

    return `
      <div class="rounded border p-2 flex items-center justify-between transition shadow-sm ${rowBg}">
        <div class="flex items-center space-x-2.5 min-w-0">
          <img src="${itemIconUrl}" class="w-7 h-7 rounded border border-slate-700 bg-[#070b0f] flex-shrink-0" onerror="this.onerror=null; this.src='https://images.evetech.net/types/${item.typeId}/render?size=32';">
          <div class="min-w-0 flex-1">
            <div class="font-semibold text-slate-200 truncate flex items-center">
              <span class="truncate">${window.esc(item.name)}</span>
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

  window.journalMultibuyText = bomItems
    .filter(i => i.netMissingQty > 0)
    .map(i => `${i.name} x${i.netMissingQty}`)
    .join('\n');
}

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

function markJobAsBuilt(jobId) {
  loadJournalState();
  const jobIndex = activeJobs.findIndex(j => j && j.id === jobId);
  if (jobIndex === -1) return;
  const job = activeJobs[jobIndex];

  const record = {
    id: job.id,
    typeId: job.typeId,
    name: job.name,
    runsNeeded: job.runsNeeded,
    qtyNeeded: job.qtyNeeded,
    calculatedCost: job.calculatedCost,
    materials: job.materials, 
    completedAt: new Date().toISOString()
  };

  buildHistory.unshift(record);
  localStorage.setItem('eve_ledger_history', JSON.stringify(buildHistory));

  activeJobs.splice(jobIndex, 1);
  localStorage.setItem('eve_ledger_jobs', JSON.stringify(activeJobs));

  renderJournalPage();
}

function requeueCompletedJob(recordId) {
  loadJournalState();
  const recordIndex = buildHistory.findIndex(r => r && r.id === recordId);
  if (recordIndex === -1) return;
  const record = buildHistory[recordIndex];

  const job = {
    id: Date.now() + Math.floor(Math.random() * 1000), 
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

function deleteJobFromQueue(jobId) {
  loadJournalState();
  con