'use strict';

let activeJobs = [];
let buildHistory = [];

let activeOrderFilter = 'all'; 
let activeCategoryFilter = 'all'; 
let activeJobSearchQuery = '';
let activeJobStatusFilter = 'all'; // 'all' | 'started' | 'pending'
let collapsedJobCardIds = new Set(); // job IDs with the BOM/details section minimized
let activeQueueViewMode = localStorage.getItem('eve_queue_view_mode') || 'grid'; // 'grid' | 'list'

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
  // Prefer real category classification (from generate_db.py's EVE Ref data) over name-keyword
  // matching - the keyword list below only recognizes hull-class words and a curated list of T1
  // ship names, so faction/pirate/T2 hulls (e.g. "Vargur", "Leshak") that don't contain any of those
  // words were silently miscategorized as "Others" even though they're genuinely ships.
  const catId = window.EVE_CATEGORIES ? window.EVE_CATEGORIES[typeId] : undefined;
  if (catId === 6) return 'ships';
  if (catId !== undefined && catId !== null) return 'others';
  if (typeof window.isShipType === 'function' && window.isShipType(typeId)) {
    return 'ships';
  }
  return 'others';
}

// --- Profit display (always full cost - stock never affects profit, only the BOM shopping list) ---
// job.netProfit/job.calculatedCost are ALREADY full market cost from the moment they're calculated
// (calculateTreeNodeCost never credits stock - this has been the architecture since early on). A
// previous version of this file had a toggle that subtracted a stock-credit value from netProfit in
// "Full Cost" mode - but since netProfit was never stock-discounted to begin with, that subtraction
// was double-counting the stock value, which is what caused profit to swing wildly, sometimes
// severely negative. Stock only ever affects the consolidated BOM (shopping list) now - these
// functions keep their names so existing call sites don't need individual changes, but always return
// the real, unmodified value.
function getJobStockCreditValue(job) {
  return 0;
}
window.getJobStockCreditValue = getJobStockCreditValue;

function getEffectiveJobCost(job) {
  return job.calculatedCost || 0;
}
window.getEffectiveJobCost = getEffectiveJobCost;

function getEffectiveJobProfit(job) {
  return job.netProfit;
}
window.getEffectiveJobProfit = getEffectiveJobProfit;

function renderJournalPage() {
  loadJournalState();

  const activeJobsCountEl = document.getElementById('journal-active-jobs');
  const totalCostEl = document.getElementById('journal-total-cost');
  const uniqueMaterialsEl = document.getElementById('journal-unique-materials');
  const materialsCostEl = document.getElementById('journal-materials-cost');
  const totalProfitEl = document.getElementById('journal-total-profit');

  let totalActiveCost = 0;
  let totalPotentialProfit = 0;
  let profitDataMissing = false;
  activeJobs.forEach(job => {
    if (job) {
      totalActiveCost += job.calculatedCost || 0;
      const effProfit = getEffectiveJobProfit(job);
      if (effProfit !== undefined) {
        totalPotentialProfit += effProfit;
      } else if (!job.isSubBuild) {
        // Sub-build jobs deliberately have no netProfit (their value is already counted once, in the
        // final job's profit) - only a genuinely legacy job missing this field should raise the flag.
        profitDataMissing = true;
      }
    }
  });

  if (activeJobsCountEl) activeJobsCountEl.textContent = activeJobs.length.toLocaleString();
  if (totalCostEl) totalCostEl.textContent = Math.round(totalActiveCost).toLocaleString() + ' ISK';
  if (totalProfitEl) {
    totalProfitEl.textContent = Math.round(totalPotentialProfit).toLocaleString() + ' ISK' + (profitDataMissing ? ' *' : '');
    totalProfitEl.className = `text-lg font-bold mono leading-tight ${totalPotentialProfit >= 0 ? 'text-green-400' : 'text-red-400'}`;
    totalProfitEl.title = profitDataMissing ? 'One or more queued jobs were added before profit tracking existed and are excluded from this total.' : '';
  }

  const consolidatedBOM = {};
  // Anything that's the PRODUCT of another job already in the queue is being supplied internally,
  // not something to shop for - without this, a prerequisite job's own output (e.g. "Pure Synth Exile
  // Booster", produced by its own reaction job sitting right there in the queue) would show up in the
  // shopping list as if it needed to be bought from the market, even though it's already accounted
  // for by the job that makes it.
  const internallySuppliedTypeIds = new Set(
    activeJobs.filter(j => j && j.productTypeId !== undefined).map(j => j.productTypeId)
  );
  console.info(`[BOM Debug] Full active job list (${activeJobs.length} jobs):`, activeJobs.map(j => j && ({ id: j.id, name: j.name, isStarted: j.isStarted, isSubBuild: j.isSubBuild, parentJobName: j.parentJobName })));
  activeJobs.forEach(job => {
    // Already-started jobs have already committed their materials - a "what do I still need to
    // buy" list has nothing useful to say about them, so they're excluded entirely rather than
    // showing up as clutter (often at 0 qty needed, which conveys nothing).
    if (job && !job.isStarted && Array.isArray(job.materials)) {
      console.info(`[BOM Debug] Including job "${job.name}" (id=${job.id}, isStarted=${job.isStarted}, isSubBuild=${job.isSubBuild}, parentJobName=${job.parentJobName || 'n/a'}) in consolidated BOM.`);
      job.materials.forEach(mat => {
        if (!mat || !mat.typeId) return;
        if (internallySuppliedTypeIds.has(mat.typeId)) return;
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
      <div class="bg-[#0c1318] border border-[#1e3348] p-8 rounded text-center text-slate-400 mono">
        No active manufacturing jobs queued in ledger. Go back to the calculator and click "Add to Job Queue" on any root item card to add jobs here.
      </div>
    `;
    return;
  }

  const deductModeInput = document.getElementById('deduct-stock-mode');
  const isStockDeductEnabled = deductModeInput ? deductModeInput.value === 'true' : true;
  const q = (activeJobSearchQuery || '').toLowerCase().trim();

  const visibleJobs = activeJobs.filter(job => {
    if (!job) return false;
    if (q && !(job.name || '').toLowerCase().includes(q)) return false;
    if (activeJobStatusFilter === 'started' && !job.isStarted) return false;
    if (activeJobStatusFilter === 'pending' && job.isStarted) return false;
    return true;
  });

  if (visibleJobs.length === 0) {
    container.innerHTML = `
      <div class="bg-[#0c1318] border border-[#1e3348] p-8 rounded text-center text-slate-400 mono">
        No jobs match your current search/filter.
      </div>
    `;
    return;
  }

  const startedJobs = visibleJobs.filter(j => j.isStarted);
  const pendingJobs = visibleJobs.filter(j => !j.isStarted);

  const isListMode = activeQueueViewMode === 'list';
  const groupWrapClass = isListMode ? 'space-y-2' : 'grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-3';
  const renderGroup = (jobs) => jobs.map(job => isListMode
    ? renderJobListRowHTML(job, allocatedStock, isStockDeductEnabled)
    : renderJobCardHTML(job, allocatedStock, isStockDeductEnabled)
  ).join('');

  let html = '';
  if (activeJobStatusFilter !== 'pending' && startedJobs.length > 0) {
    html += `
      <div class="mb-2">
        <div class="flex items-center gap-2 mb-2.5 px-3 py-2 rounded-md bg-green-950/40 border-2 border-green-600/50">
          <span class="text-green-400 font-extrabold text-base rajdhani uppercase tracking-wider">🟢 In Progress</span>
          <span class="text-green-400 font-bold text-sm mono">(${startedJobs.length})</span>
        </div>
        <div class="${groupWrapClass}">${renderGroup(startedJobs)}</div>
      </div>
    `;
  }
  if (activeJobStatusFilter !== 'started' && pendingJobs.length > 0) {
    html += `
      <div>
        <div class="flex items-center gap-2 mb-2.5 px-3 py-2 rounded-md bg-[#0d1922] border-2 border-[#1e3348]">
          <span class="text-slate-200 font-extrabold text-base rajdhani uppercase tracking-wider">⏳ Pending</span>
          <span class="text-slate-400 font-bold text-sm mono">(${pendingJobs.length})</span>
        </div>
        <div class="${groupWrapClass}">${renderGroup(pendingJobs)}</div>
      </div>
    `;
  }
  container.innerHTML = html;
}

function toggleQueueViewMode() {
  activeQueueViewMode = activeQueueViewMode === 'list' ? 'grid' : 'list';
  localStorage.setItem('eve_queue_view_mode', activeQueueViewMode);
  const btn = document.getElementById('btn-view-mode');
  if (btn) btn.textContent = activeQueueViewMode === 'list' ? '▦ Grid View' : '☰ List View';
  renderJournalPage();
}
window.toggleQueueViewMode = toggleQueueViewMode;

// Compact single-line-per-job view. Shows the essentials (icon/name, runs, status, cost, profit,
// actions) with a chevron to expand the same BOM/details block used in grid view, reusing the same
// collapse state so switching views doesn't lose whether you had a job's details open.
function renderJobListRowHTML(job, allocatedStock, isStockDeductEnabled) {
  const iconTypeId = job.productTypeId || job.typeId;
  const isJobReady = job.isStarted && job.startedAt && ((Date.now() - job.startedAt) / 1000 >= (job.totalBuildSeconds || 0));
  const jobNameLower = (window.TYPE_ID_TO_NAME[iconTypeId] || job.name || '').toLowerCase();
  const isJobBp = jobNameLower.includes('blueprint') || jobNameLower.includes('formula') || jobNameLower.includes('reaction');
  const jobIconUrl = isJobBp
    ? `https://images.evetech.net/types/${iconTypeId}/bp?size=64`
    : `https://images.evetech.net/types/${iconTypeId}/icon?size=64`;
  const jobDisplayName = window.TYPE_ID_TO_NAME[iconTypeId] || (job.name || '')
    .replace(/ Blueprint$/i, '').replace(/ Reaction Formula$/i, '').replace(/ Formula$/i, '').trim();

  let statusText = '⏳ PENDING';
  let statusClass = 'text-slate-400';
  let isTimerBacked = false;
  if (job.isStarted && job.startedAt) {
    isTimerBacked = true;
    const elapsedSeconds = (Date.now() - job.startedAt) / 1000;
    const remaining = (job.totalBuildSeconds || 0) - elapsedSeconds;
    const ready = remaining <= 0;
    statusText = ready ? '✓ READY' : `⏱ ${window.formatDuration(Math.ceil(remaining))}`;
    statusClass = ready ? 'text-green-400' : 'text-cyan-300';
  }

  const p = getEffectiveJobProfit(job);
  const isExpanded = !collapsedJobCardIds.has(job.id);

  const expandedDetailHTML = isExpanded ? `
    <div class="px-3 pb-3 pt-1 border-t border-[#1e3348]/40" onclick="event.stopPropagation()">
      ${renderJobBOMBlockHTML(job, allocatedStock, isStockDeductEnabled)}
      ${!job.isStarted ? `
        <div class="flex items-center gap-1.5 px-2 py-1.5 mt-2 bg-[#070b0f] rounded border border-[#1e3348]">
          <span class="text-xs text-slate-400 font-bold flex-shrink-0">Runs to start:</span>
          <input type="number" id="start-runs-${job.id}" value="${job.runsNeeded}" min="1" max="${job.runsNeeded}"
            onmousedown="event.stopPropagation()" onfocus="this.select()"
            class="w-16 bg-[#0d1922] border border-[#1e3348] text-center text-amber-300 font-bold rounded p-1 outline-none text-sm">
          <button onclick="startJobRuns(${job.id})" class="ml-auto bg-cyan-700 hover:bg-cyan-600 text-white font-bold py-1 px-2.5 rounded text-xs mono transition flex-shrink-0">▶ Start Job</button>
        </div>
      ` : ''}
    </div>
  ` : '';

  return `
    <div class="job-card ${isJobReady ? 'bg-[#0d2818]' : (job.isStarted ? 'bg-green-950/20' : 'bg-[#0c1318]')} border${isJobReady ? '-2' : ''} ${job.isSubBuild ? 'border-amber-500' : (isJobReady ? 'border-green-500' : (job.isStarted ? 'border-green-700/50' : 'border-[#1e3348]'))} rounded shadow-md transition"
         draggable="true" data-job-id="${job.id}"
         ondragstart="handleJobDragStart(event, ${job.id})" ondragend="handleJobDragEnd(event)"
         ondragover="handleJobDragOver(event)" ondragleave="handleJobDragLeave(event)" ondrop="handleJobDrop(event, ${job.id})">
      <div class="flex items-center gap-2 p-2 cursor-pointer" onclick="toggleJobCardCollapse(${job.id})">
        <span class="drag-handle cursor-grab active:cursor-grabbing text-slate-500 hover:text-slate-300 px-1 text-sm select-none flex-shrink-0" onclick="event.stopPropagation()" title="Drag to reorder">⠿</span>
        <span class="text-slate-500 text-xs flex-shrink-0">${isExpanded ? '▾' : '▸'}</span>
        <img src="${jobIconUrl}" class="w-8 h-8 rounded border border-slate-700 bg-[#070b0f] flex-shrink-0" loading="lazy" onerror="this.onerror=null; this.src='https://images.evetech.net/types/${iconTypeId}/render?size=64';">
        <div class="min-w-0 flex-1">
          <div class="font-bold text-sm text-white truncate">${window.esc(jobDisplayName)}</div>
          ${job.isSubBuild ? `<div class="text-xs mono text-amber-400 font-bold uppercase truncate">⚙ Prereq for: ${window.esc(job.parentJobName || '?')}</div>` : ''}
          ${job.autoImported ? `<div class="text-xs mono text-cyan-400 font-bold uppercase truncate" title="No matching plan existed - imported from your active EVE job.">📥 Auto-imported ${job.meLevel !== undefined ? `| ME: ${job.meLevel}% TE: ${job.teLevel}%` : ''}</div>` : ''}
        </div>
        <span class="text-lg font-extrabold text-purple-300 mono flex-shrink-0 cursor-pointer hover:text-purple-200" onclick="event.stopPropagation(); copyRunsToClipboard(event, ${job.runsNeeded})" title="Click to copy run count">${job.runsNeeded.toLocaleString()}</span>
        <span class="text-xs text-slate-500 mono flex-shrink-0 w-14">runs</span>
        ${isTimerBacked
          ? `<span class="job-timer flex-shrink-0 w-28 text-center" data-started-at="${job.startedAt}" data-total-seconds="${job.totalBuildSeconds || 0}"><span class="timer-display text-xs font-extrabold ${statusClass} mono">${statusText}</span></span>`
          : `<span class="text-xs font-extrabold ${statusClass} mono flex-shrink-0 w-28 text-center">${statusText}</span>`}
        <span class="text-xs font-bold text-cyan-400 mono flex-shrink-0 w-24 text-right">${Math.round(job.calculatedCost || 0).toLocaleString()} ISK</span>
        <span class="text-xs font-bold ${p !== undefined ? (p >= 0 ? 'text-green-400' : 'text-red-400') : 'text-slate-600'} mono flex-shrink-0 w-24 text-right">${p !== undefined ? Math.round(p).toLocaleString() + ' ISK' : '—'}</span>
        <div class="flex items-center gap-1.5 flex-shrink-0" onclick="event.stopPropagation()">
          <button onclick="markJobAsBuilt(${job.id})" class="py-1 px-2 bg-green-800/80 hover:bg-green-700 text-white font-bold rounded text-xs mono transition">✔</button>
          <button onclick="deleteJobFromQueue(${job.id})" class="py-1 px-2 bg-red-950/60 hover:bg-red-800 text-red-300 font-bold rounded text-xs mono transition">❌</button>
        </div>
      </div>
      ${expandedDetailHTML}
    </div>
  `;
}

function renderJobBOMBlockHTML(job, allocatedStock, isStockDeductEnabled) {
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
        <div class="flex justify-between items-center text-xs mono py-0.5 border-b border-[#1e3348]/20 ${isAcquired ? 'text-green-400' : 'text-slate-400'}">
          <span class="truncate pr-4">${window.esc(mat.name)}</span>
          <span class="flex-shrink-0">${isAcquired ? `✔ ${mat.qtyNeeded.toLocaleString()}` : `x${mat.qtyNeeded.toLocaleString()} (Deficit: ${netMissing.toLocaleString()})`}</span>
        </div>
      `;
    }).join('') : '<div class="text-xs text-slate-500 italic py-1">No materials logged for this build.</div>';

    let buildTimeUI = '';
    let totalBuildSeconds = job.totalBuildSeconds;
    if (totalBuildSeconds === undefined) {
      // Legacy jobs added before totalBuildSeconds existed: fall back to the root job's own time only,
      // adjusted for skills/facility/rig but not TE (TE per sub-component isn't recoverable without the
      // full tree, which isn't available on this page).
      const baseTime = job.baseTime || 0;
      if (baseTime > 0) {
        const skills = window.safeParseJSON(localStorage.getItem('eve_char_skills'), { industry: 5, advIndustry: 5 });
        const indFactor = 1 - (0.04 * (skills.industry || 0));
        const advIndFactor = 1 - (0.03 * (skills.advIndustry || 0));
        const skillTimeFactor = indFactor * advIndFactor;
        const structureType = window.getActiveStructureType ? window.getActiveStructureType() : { teBonus: 30.0 };
        const facilityFactor = 1 - (structureType.teBonus / 100);
        const rigTEBonus = window.getEffectiveRigBonusForTypeId ? window.getEffectiveRigBonusForTypeId(job.productTypeId, 'TE') : 0;
        const rigFactor = 1 - (rigTEBonus / 100);
        totalBuildSeconds = baseTime * skillTimeFactor * facilityFactor * rigFactor * (job.runsNeeded || 1);
      } else {
        totalBuildSeconds = 0;
      }
    }
    const skills = window.safeParseJSON(localStorage.getItem('eve_char_skills'), { industry: 5, advIndustry: 5 });
    const structureType = window.getActiveStructureType ? window.getActiveStructureType() : { shortLabel: 'Sotiyo' };
    const structureName = structureType.shortLabel;
    const rigTEBonusDisplay = window.getEffectiveRigBonusForTypeId ? window.getEffectiveRigBonusForTypeId(job.productTypeId, 'TE') : 0;

    if (totalBuildSeconds > 0) {
      const hoverTitle = `Total time to build this item and every sub-component you're manufacturing yourself.\nIndustry: ${skills.industry}/5 | Advanced Industry: ${skills.advIndustry}/5 | Facility: ${structureName}${rigTEBonusDisplay > 0 ? ` | Rig: -${rigTEBonusDisplay.toFixed(2)}% TE` : ''}`;

      const effJobProfit = getEffectiveJobProfit(job);
      const iskPerHour = effJobProfit !== undefined ? (effJobProfit / (totalBuildSeconds / 3600)) : null;
      const iskPerHourUI = iskPerHour !== null
        ? `<div class="flex justify-between text-xs mono"><span class="text-slate-400">Est. ISK/Hour:</span><span class="font-bold ${iskPerHour >= 0 ? 'text-green-400' : 'text-red-400'}">${Math.round(iskPerHour).toLocaleString()} ISK</span></div>`
        : '';

      buildTimeUI = `
        <div class="flex justify-between text-xs text-slate-400 mono cursor-help" title="${window.esc(hoverTitle)}">
          <span>Est. Build Time:</span>
          <span class="text-slate-300 font-semibold">${window.formatDuration(totalBuildSeconds)}</span>
        </div>
        ${iskPerHourUI}
      `;
    } else {
      // Be honest that no time data was found, rather than silently omitting the line entirely -
      // a permanently missing line with no data looks identical to a rendering bug.
      buildTimeUI = `
        <div class="flex justify-between text-xs text-slate-400 mono cursor-help" title="No manufacturing time data was found for this job's blueprint at the time it was added.">
          <span>Est. Build Time:</span>
          <span class="text-slate-500 italic">No Time Data</span>
        </div>
      `;
    }

    return `
      <div class="p-2 bg-[#070b0f] rounded border border-[#1e3348]/40">
        <div class="flex justify-between items-center mb-1.5 pb-1 border-b border-[#1e3348]/40">
          <span class="text-xs text-cyan-400 font-bold uppercase tracking-wider rajdhani">Job Materials (BOM)</span>
          <button onclick="copyIndividualJobMultibuy(event, ${job.id})" class="text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold px-1.5 py-0.5 rounded mono transition">
            📋 Copy BOM
          </button>
        </div>
        <div class="max-h-28 overflow-y-auto scrollbar-thin">
          ${individualBOMHTML}
        </div>
        <div class="flex flex-col text-xs mono font-bold pt-1.5 border-t border-[#1e3348]/40 mt-1 space-y-1">
          ${buildTimeUI}
          <div class="flex justify-between items-center mt-0.5">
            <span class="text-slate-300">Total Build Cost:</span>
            <span class="text-cyan-400">${Math.round(job.calculatedCost).toLocaleString()} ISK</span>
          </div>
          ${(() => { const p = getEffectiveJobProfit(job); return p !== undefined ? `
            <div class="flex justify-between items-center">
              <span class="text-slate-300">Total Profit:</span>
              <span class="${p >= 0 ? 'text-green-400' : 'text-red-400'}">${Math.round(p).toLocaleString()} ISK</span>
            </div>
          ` : ''; })()}
        </div>
      </div>
    `;
}

function renderJobCardHTML(job, allocatedStock, isStockDeductEnabled) {
    const iconTypeId = job.productTypeId || job.typeId;
    const isJobReady = job.isStarted && job.startedAt && ((Date.now() - job.startedAt) / 1000 >= (job.totalBuildSeconds || 0));
    const formattedDate = job.addedAt ? new Date(job.addedAt).toLocaleDateString() : 'N/A';
    const isCollapsed = collapsedJobCardIds.has(job.id);

    const dragHandleHTML = `
      <div class="flex items-center flex-shrink-0" onclick="event.stopPropagation()">
        <button onclick="toggleJobCardCollapse(${job.id})" class="text-slate-500 hover:text-slate-300 px-1 text-xs select-none" title="${isCollapsed ? 'Show full details' : 'Hide Bill of Materials'}">
          ${isCollapsed ? '▸' : '▾'}
        </button>
        <span class="drag-handle cursor-grab active:cursor-grabbing text-slate-500 hover:text-slate-300 px-1.5 py-0.5 text-sm select-none" title="Drag to reorder (changes stock allocation priority)">
          ⠿
        </span>
      </div>
    `;

    // CORRECTION: Direct blueprint path safety check inside active jobs loop prevents any imageservers 400 errors [1.1.1, 1.1.4]
    const jobNameLower = (window.TYPE_ID_TO_NAME[iconTypeId] || job.name || '').toLowerCase();
    const isJobBp = jobNameLower.includes('blueprint') || jobNameLower.includes('formula') || jobNameLower.includes('reaction');
    const jobIconUrl = isJobBp
      ? `https://images.evetech.net/types/${iconTypeId}/bp?size=64`
      : `https://images.evetech.net/types/${iconTypeId}/icon?size=64`;
    // The job may have been saved with the raw searched name (e.g. "Vargur Blueprint") - always show
    // the manufactured product's name on the card instead.
    const jobDisplayName = window.TYPE_ID_TO_NAME[iconTypeId] || (job.name || '')
      .replace(/ Blueprint$/i, '').replace(/ Reaction Formula$/i, '').replace(/ Formula$/i, '').trim();

    // Status banner - kept prominent, right under the header, instead of buried below the BOM, since
    // job status is one of the most important things to see at a glance.
    let statusBannerHTML = '';
    if (job.isStarted && job.startedAt) {
      const elapsedSeconds = (Date.now() - job.startedAt) / 1000;
      const remaining = (job.totalBuildSeconds || 0) - elapsedSeconds;
      const ready = remaining <= 0;
      const text = ready ? '✓ READY TO COLLECT!' : `⏱ ${window.formatDuration(Math.ceil(remaining))} remaining`;
      statusBannerHTML = `
        <div class="job-timer flex items-center justify-between px-2.5 py-2 rounded border-2 ${ready ? 'bg-green-950/40 border-green-500/70' : 'bg-cyan-950/30 border-cyan-500/50'}" data-started-at="${job.startedAt}" data-total-seconds="${job.totalBuildSeconds || 0}">
          <span class="text-xs text-slate-300 font-bold uppercase tracking-wide flex-shrink-0">Status:</span>
          <span class="timer-display text-sm font-extrabold ${ready ? 'text-green-400' : 'text-cyan-300'} mono">${text}</span>
        </div>
      `;
    } else {
      statusBannerHTML = `
        <div class="flex items-center justify-between px-2.5 py-2 rounded border-2 bg-[#0d1922] border-slate-600/50">
          <span class="text-xs text-slate-300 font-bold uppercase tracking-wide flex-shrink-0">Status:</span>
          <span class="text-sm font-extrabold text-slate-400 mono">⏳ PENDING</span>
        </div>
      `;
    }

    const startJobRowHTML = (!job.isStarted) ? `
      <div class="flex items-center gap-1.5 px-2 py-1.5 bg-[#070b0f] rounded border border-[#1e3348]" onclick="event.stopPropagation()">
        <span class="text-xs text-slate-400 font-bold flex-shrink-0" title="Starting fewer than all runs splits this into a started job plus a still-queued job for the rest, matching how EVE actually queues manufacturing jobs.">Runs to start:</span>
        <input type="number" id="start-runs-${job.id}" value="${job.runsNeeded}" min="1" max="${job.runsNeeded}"
          onmousedown="event.stopPropagation()" onfocus="this.select()"
          class="w-16 bg-[#0d1922] border border-[#1e3348] text-center text-amber-300 font-bold rounded p-1 outline-none text-sm">
        <button onclick="startJobRuns(${job.id})" class="ml-auto bg-cyan-700 hover:bg-cyan-600 text-white font-bold py-1 px-2.5 rounded text-xs mono transition flex-shrink-0">▶ Start Job</button>
      </div>
    ` : '';

    return `
      <div class="job-card ${isJobReady ? 'bg-[#0d2818]' : (job.isStarted ? 'bg-green-950/20' : 'bg-[#0c1318]')} border${isJobReady ? '-2' : ''} ${job.isSubBuild ? 'border-amber-500 hover:border-amber-400' : (isJobReady ? 'border-green-500 hover:border-green-400' : (job.isStarted ? 'border-green-700/50 hover:border-green-500/70' : 'border-[#1e3348] hover:border-purple-500/40'))} rounded p-3 flex flex-col justify-between shadow-md transition space-y-2"
           draggable="true" data-job-id="${job.id}"
           ondragstart="handleJobDragStart(event, ${job.id})" ondragend="handleJobDragEnd(event)"
           ondragover="handleJobDragOver(event)" ondragleave="handleJobDragLeave(event)" ondrop="handleJobDrop(event, ${job.id})">
        <div class="flex items-start justify-between">
          <div class="flex items-start space-x-3 min-w-0 flex-1">
            <img src="${jobIconUrl}" class="w-12 h-12 rounded border border-slate-700 bg-[#070b0f] flex-shrink-0" loading="lazy" onerror="this.onerror=null; this.src='https://images.evetech.net/types/${iconTypeId}/render?size=64';">
            <div class="min-w-0 flex-1">
              <h3 class="font-bold text-base text-white truncate">${window.esc(jobDisplayName)}</h3>
              ${job.isSubBuild ? `<div class="text-xs mono text-amber-400 font-bold uppercase tracking-wide mt-0.5" title="This is a sub-assembly required by another queued job - build it first.">⚙ Prerequisite for: ${window.esc(job.parentJobName || 'another job')}</div>` : ''}
              ${job.autoImported ? `<div class="text-xs mono text-cyan-400 font-bold uppercase tracking-wide mt-0.5" title="No matching plan existed for this job - imported directly from your active EVE industry job using its real ME/TE and market sell pricing.">📥 Auto-imported from EVE ${job.meLevel !== undefined ? `| ME: ${job.meLevel}% TE: ${job.teLevel}%` : ''}</div>` : ''}
              <div class="text-xs mono text-slate-500 mt-0.5">Added on: ${formattedDate}</div>
            </div>
          </div>
          ${dragHandleHTML}
        </div>

        ${statusBannerHTML}

        <div class="flex items-center justify-between px-1">
          <span
            class="text-xl font-extrabold text-purple-300 mono cursor-pointer hover:text-purple-200 transition"
            onclick="event.stopPropagation(); copyRunsToClipboard(event, ${job.runsNeeded})"
            title="Click to copy the run count to clipboard">
            ${job.runsNeeded.toLocaleString()} Run${job.runsNeeded > 1 ? 's' : ''}
          </span>
          <span class="text-sm text-slate-400 mono">${job.qtyNeeded.toLocaleString()} units total</span>
        </div>

        ${!isCollapsed ? renderJobBOMBlockHTML(job, allocatedStock, isStockDeductEnabled) : `
          <div class="px-2 py-1 text-xs text-slate-500 italic text-center border border-[#1e3348]/40 rounded">
            Details minimized - click ▸ above to expand
          </div>
        `}

        ${startJobRowHTML}

        <div class="flex items-center space-x-2 pt-1">
          <button onclick="markJobAsBuilt(${job.id})" class="flex-1 py-1.5 bg-green-800/80 hover:bg-green-700 text-white font-bold rounded text-sm mono transition border border-green-600/30 flex items-center justify-center gap-1">
            ✔ Built
          </button>
          <button onclick="deleteJobFromQueue(${job.id})" class="py-1.5 px-3 bg-red-950/60 hover:bg-red-800 text-red-300 font-bold rounded text-sm mono transition border border-red-800/30 flex items-center justify-center">
            ❌ Delete
          </button>
        </div>
      </div>
    `;
}

// --- Search / status filter controls ---
function filterJobsBySearch(query) {
  activeJobSearchQuery = query;
  renderJournalPage();
}
window.filterJobsBySearch = filterJobsBySearch;

function setJobStatusFilter(status) {
  activeJobStatusFilter = status;
  ['all', 'started', 'pending'].forEach(s => {
    const btn = document.getElementById(`btn-status-${s}`);
    if (btn) btn.className = `px-2.5 py-1.5 rounded-md font-bold transition text-xs mono ${s === status ? 'bg-purple-800 text-white border border-purple-600/30' : 'bg-[#1e3348] text-slate-400 hover:text-white'}`;
  });
  renderJournalPage();
}
window.setJobStatusFilter = setJobStatusFilter;

// --- Minimize/maximize card details ---
function toggleJobCardCollapse(jobId) {
  if (collapsedJobCardIds.has(jobId)) collapsedJobCardIds.delete(jobId);
  else collapsedJobCardIds.add(jobId);
  renderJournalPage();
}
window.toggleJobCardCollapse = toggleJobCardCollapse;

function collapseAllJobCards() {
  activeJobs.forEach(j => { if (j) collapsedJobCardIds.add(j.id); });
  renderJournalPage();
}
window.collapseAllJobCards = collapseAllJobCards;

function expandAllJobCards() {
  collapsedJobCardIds.clear();
  renderJournalPage();
}
window.expandAllJobCards = expandAllJobCards;

// --- Click-to-copy runs count ---
function copyRunsToClipboard(e, runs) {
  if (e) e.stopPropagation();
  const text = String(runs);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(() => {});
  }
  const target = e && e.target;
  if (target) {
    const original = target.textContent;
    target.textContent = '✔ Copied!';
    setTimeout(() => { target.textContent = original; }, 900);
  }
}
window.copyRunsToClipboard = copyRunsToClipboard;

// --- Combine duplicate jobs ---
// Only merges jobs that are safely equivalent: same product, same build/buy config context
// (sub-build vs final, and which job it's a prerequisite for), same sell strategy, and neither one
// already started. Jobs that differ in any of these (e.g. one set to build, one to buy; one selling
// via buy order vs sell order) are deliberately left alone, since merging those would silently lose
// information about which configuration applies to which materials.
function combineDuplicateJobs() {
  loadJournalState();
  const groups = {};
  const order = [];
  activeJobs.forEach(job => {
    if (!job) return;
    if (job.isStarted) { order.push({ key: null, job }); return; } // never combine started jobs
    const key = [
      job.productTypeId || job.typeId,
      job.isSubBuild ? 'sub' : 'final',
      job.parentJobName || '',
      job.sellStrategy || ''
    ].join('|');
    if (!groups[key]) groups[key] = [];
    groups[key].push(job);
    order.push({ key, job });
  });

  const mergedByKey = {};
  let combinedCount = 0;
  Object.keys(groups).forEach(key => {
    const jobs = groups[key];
    if (jobs.length < 2) return;
    combinedCount += jobs.length - 1;

    const materialsMap = {};
    jobs.forEach(j => {
      (j.materials || []).forEach(m => {
        if (!m) return;
        if (!materialsMap[m.typeId]) {
          materialsMap[m.typeId] = { ...m, qtyNeeded: 0, stockQty: 0, netQtyNeeded: 0, lineCost: 0 };
        }
        materialsMap[m.typeId].qtyNeeded += m.qtyNeeded || 0;
        materialsMap[m.typeId].stockQty += m.stockQty || 0;
        materialsMap[m.typeId].netQtyNeeded += m.netQtyNeeded || 0;
        materialsMap[m.typeId].lineCost += m.lineCost || 0;
      });
    });

    const first = jobs[0];
    const merged = {
      ...first,
      runsNeeded: jobs.reduce((s, j) => s + (j.runsNeeded || 0), 0),
      qtyNeeded: jobs.reduce((s, j) => s + (j.qtyNeeded || 0), 0),
      calculatedCost: jobs.reduce((s, j) => s + (j.calculatedCost || 0), 0),
      netProfit: jobs.every(j => j.netProfit !== undefined) ? jobs.reduce((s, j) => s + j.netProfit, 0) : undefined,
      totalBuildSeconds: jobs.reduce((s, j) => s + (j.totalBuildSeconds || 0), 0),
      materials: Object.values(materialsMap),
      addedAt: jobs.reduce((earliest, j) => (j.addedAt && j.addedAt < earliest) ? j.addedAt : earliest, first.addedAt)
    };
    mergedByKey[key] = merged;
  });

  const newQueue = [];
  const emittedKeys = new Set();
  order.forEach(({ key, job }) => {
    if (key === null) { newQueue.push(job); return; }
    if (mergedByKey[key]) {
      if (!emittedKeys.has(key)) { newQueue.push(mergedByKey[key]); emittedKeys.add(key); }
    } else {
      newQueue.push(job);
    }
  });

  activeJobs = newQueue;
  localStorage.setItem('eve_ledger_jobs', JSON.stringify(activeJobs));
  renderJournalPage();

  if (combinedCount === 0) {
    alert('No combinable duplicate jobs found. Jobs only combine when they match on item, build/buy context, and sell strategy, and neither is already started.');
  }
}
window.combineDuplicateJobs = combineDuplicateJobs;

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
      btn.className = 'text-xs bg-green-600 text-white font-bold px-1.5 py-0.5 rounded mono transition';
      setTimeout(() => {
        btn.innerHTML = origText;
        btn.className = 'text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold px-1.5 py-0.5 rounded mono transition';
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
      ? `<span class="bg-green-950 text-green-300 text-xs px-1 rounded font-bold uppercase ml-1.5 flex-shrink-0">Acquired</span>` 
      : `<span class="bg-amber-950 text-amber-300 text-xs px-1 rounded font-bold uppercase ml-1.5 flex-shrink-0">Missing</span>`;

    const strategyBadge = item.strategy === 'sell' 
      ? `<span class="bg-amber-900/60 text-amber-300 text-xs px-1 rounded font-bold uppercase ml-1.5 flex-shrink-0">SELL</span>` 
      : `<span class="bg-cyan-900/60 text-cyan-300 text-xs px-1 rounded font-bold uppercase ml-1.5 flex-shrink-0">BUY</span>`;

    // CORRECTION: Direct blueprint path safety check inside the consolidated BOM prevents any imageservers 400 errors [1.1.1, 1.1.4]
    const itemNameLower = (window.TYPE_ID_TO_NAME[item.typeId] || item.name || '').toLowerCase();
    const isItemBp = itemNameLower.includes('blueprint') || itemNameLower.includes('formula') || itemNameLower.includes('reaction');
    const itemIconUrl = isItemBp
      ? `https://images.evetech.net/types/${item.typeId}/bp?size=32`
      : `https://images.evetech.net/types/${item.typeId}/icon?size=32`;

    return `
      <div class="rounded border p-2 flex items-center justify-between transition shadow-sm ${rowBg}">
        <div class="flex items-center space-x-2.5 min-w-0">
          <img src="${itemIconUrl}" class="w-7 h-7 rounded border border-slate-700 bg-[#070b0f] flex-shrink-0" loading="lazy" onerror="this.onerror=null; this.src='https://images.evetech.net/types/${item.typeId}/render?size=32';">
          <div class="min-w-0 flex-1">
            <div class="font-semibold text-slate-200 truncate flex items-center">
              <span class="truncate">${window.esc(item.name)}</span>
              ${statusBadge}
              ${strategyBadge}
            </div>
            <div class="text-xs text-slate-400 mono mt-0.5">
              Needed: ${item.totalQtyNeeded.toLocaleString()} | Stock: ${item.stockQty.toLocaleString()}
            </div>
            ${item.netMissingQty > 0 ? `<div class="text-xs text-amber-300 mono mt-0.5 font-bold">Deficit: &times;${item.netMissingQty.toLocaleString()}</div>` : ''}
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

// Starts a job (or a portion of it). Starting fewer than all remaining runs splits the job into an
// "in progress" fragment (started now, with its own timer) and a still-queued fragment for the rest -
// this mirrors real EVE mechanics, where a queued industry job has one fixed run count and duration,
// so starting a subset of runs means queuing a genuinely separate job for what's left.
function startJobRuns(jobId) {
  const input = document.getElementById(`start-runs-${jobId}`);
  const requestedRuns = input ? parseInt(input.value) : NaN;

  loadJournalState();
  const jobIndex = activeJobs.findIndex(j => j && j.id === jobId);
  if (jobIndex === -1) return;
  const job = activeJobs[jobIndex];
  const totalRuns = job.runsNeeded || 1;
  const startRuns = Math.max(1, Math.min(isNaN(requestedRuns) ? totalRuns : requestedRuns, totalRuns));

  if (startRuns >= totalRuns) {
    job.startedAt = Date.now();
    job.isStarted = true;
    localStorage.setItem('eve_ledger_jobs', JSON.stringify(activeJobs));
    renderJournalPage();
    return;
  }

  const ratio = startRuns / totalRuns;
  const remainingRuns = totalRuns - startRuns;
  const remainingRatio = remainingRuns / totalRuns;

  const scaleMaterials = (r) => Array.isArray(job.materials) ? job.materials.map(m => {
    const scaledQty = Math.ceil(m.qtyNeeded * r);
    const scaledStock = Math.min(m.stockQty || 0, scaledQty);
    return {
      ...m,
      qtyNeeded: scaledQty,
      stockQty: scaledStock,
      netQtyNeeded: Math.max(0, scaledQty - scaledStock),
      lineCost: (m.unitPrice || 0) * Math.max(0, scaledQty - scaledStock)
    };
  }) : [];

  const activeFragment = {
    ...job,
    id: Date.now() + Math.floor(Math.random() * 1000),
    runsNeeded: startRuns,
    qtyNeeded: Math.round((job.qtyNeeded || 0) * ratio),
    calculatedCost: (job.calculatedCost || 0) * ratio,
    netProfit: job.netProfit !== undefined ? job.netProfit * ratio : undefined,
    totalBuildSeconds: (job.totalBuildSeconds || 0) * ratio,
    materials: scaleMaterials(ratio),
    startedAt: Date.now(),
    isStarted: true,
    splitFromId: job.id
  };

  const remainingFragment = {
    ...job,
    id: Date.now() + Math.floor(Math.random() * 1000) + 1,
    runsNeeded: remainingRuns,
    qtyNeeded: Math.round((job.qtyNeeded || 0) * remainingRatio),
    calculatedCost: (job.calculatedCost || 0) * remainingRatio,
    netProfit: job.netProfit !== undefined ? job.netProfit * remainingRatio : undefined,
    totalBuildSeconds: (job.totalBuildSeconds || 0) * remainingRatio,
    materials: scaleMaterials(remainingRatio),
    startedAt: undefined,
    isStarted: false,
    splitFromId: job.id
  };

  activeJobs.splice(jobIndex, 1, activeFragment, remainingFragment);
  localStorage.setItem('eve_ledger_jobs', JSON.stringify(activeJobs));
  renderJournalPage();
}
window.startJobRuns = startJobRuns;

// Refreshes only the countdown text on already-rendered timer elements, without a full re-render -
// keeps started jobs' timers live every second without disturbing anything else on the page (drag
// state, scroll position, focused inputs, etc).
function updateJobTimers() {
  document.querySelectorAll('.job-timer').forEach(el => {
    const startedAt = parseInt(el.dataset.startedAt);
    const totalSeconds = parseFloat(el.dataset.totalSeconds);
    const display = el.querySelector('.timer-display');
    if (!display || !startedAt) return;
    const elapsedSeconds = (Date.now() - startedAt) / 1000;
    const remaining = totalSeconds - elapsedSeconds;
    if (remaining <= 0) {
      display.textContent = '✓ Ready to Collect!';
      display.className = 'timer-display text-sm font-bold text-green-400 mono';
      el.classList.remove('border-cyan-600/40');
      el.classList.add('border-green-600/50');
      // The parent card only shows the bold "ready" color once actually ready - update it live here
      // so it doesn't sit in the wrong color until the next full re-render.
      const card = el.closest('.job-card');
      if (card && !card.classList.contains('border-amber-500')) {
        card.classList.remove('bg-green-950/20', 'border', 'border-green-700/50', 'hover:border-green-500/70');
        card.classList.add('bg-[#0d2818]', 'border-2', 'border-green-500', 'hover:border-green-400');
      }
    } else {
      display.textContent = `⏱ ${window.formatDuration(Math.ceil(remaining))} remaining`;
      display.className = 'timer-display text-sm font-bold text-cyan-300 mono';
    }
  });
}
if (!window._jobTimerIntervalStarted) {
  window._jobTimerIntervalStarted = true;
  setInterval(updateJobTimers, 1000);
}

// Matches real active EVE industry jobs (from ESI) against PENDING ledger jobs, by product + run
// count, and marks matches as started using the REAL start time and duration EVE calculated - this
// replaces this app's own time estimate with the actual in-game number once a job is confirmed
// running, and means you don't have to manually click Start for jobs you already started in-game.
async function syncWithEveIndustryJobs(silent) {
  const btn = document.getElementById('btn-sync-eve-jobs');
  if (btn && !silent) { btn.disabled = true; btn.textContent = '🔄 Syncing...'; }

  const [charJobs, corpJobs, charBps, corpBps] = await Promise.all([
    typeof window.fetchActiveIndustryJobs === 'function' ? window.fetchActiveIndustryJobs() : null,
    typeof window.fetchActiveCorpIndustryJobs === 'function' ? window.fetchActiveCorpIndustryJobs() : [],
    typeof window.fetchCharacterBlueprints === 'function' ? window.fetchCharacterBlueprints() : [],
    typeof window.fetchCorpBlueprints === 'function' ? window.fetchCorpBlueprints() : []
  ]);

  if (btn) { btn.disabled = false; btn.textContent = '🔄 Sync EVE Jobs'; }

  console.info(`[JobSync] Fetched ${charJobs ? charJobs.length : 'null (fetch failed)'} character job(s), ${corpJobs ? corpJobs.length : 0} corp job(s), ${(charBps||[]).length} char blueprint(s), ${(corpBps||[]).length} corp blueprint(s).`);

  if (!charJobs && (!corpJobs || corpJobs.length === 0)) {
    if (!silent) alert('Could not fetch active industry jobs. Make sure you are logged in via EVE SSO - if you logged in before this feature existed, log out and back in once to grant the new Industry Jobs permissions.');
    return;
  }

  // Merge character jobs (this character's own) with corp jobs (any corp member's, if this character
  // has the Factory Manager role) - dedupe by job_id in case the same job appears in both.
  const seenJobIds = new Set();
  const allRealJobs = [...(charJobs || []), ...(corpJobs || [])].filter(j => {
    if (!j || seenJobIds.has(j.job_id)) return false;
    seenJobIds.add(j.job_id);
    return true;
  });

  // Only manufacturing (1) and reaction (11) jobs represent "building an item" the way the ledger
  // models it - research/copying/invention jobs are skipped.
  const activeRealJobs = allRealJobs.filter(j => j && j.status === 'active' && (j.activity_id === 1 || j.activity_id === 11));
  console.info(`[JobSync] ${activeRealJobs.length} active manufacturing/reaction job(s) out of ${allRealJobs.length} total fetched.`);
  activeRealJobs.forEach(rj => {
    console.info(`[JobSync]   Active real job: job_id=${rj.job_id}, product_type_id=${rj.product_type_id}, blueprint_id=${rj.blueprint_id}, blueprint_type_id=${rj.blueprint_type_id}, activity_id=${rj.activity_id}, runs=${rj.runs}`);
  });

  // Real ME/TE for the specific blueprint instance used, keyed by blueprint_id (item_id) - this is a
  // separate endpoint from industry jobs, since a job's blueprint_id only references the item, not
  // its research level.
  const blueprintMeTeMap = {};
  [...(charBps || []), ...(corpBps || [])].forEach(bp => {
    if (bp && bp.item_id !== undefined) {
      blueprintMeTeMap[bp.item_id] = { me: bp.material_efficiency || 0, te: bp.time_efficiency || 0 };
    }
  });

  loadJournalState();

  // Anything already tracked by an existing STARTED ledger job (from a previous sync), OR already
  // marked Built and moved to history, must be skipped here - otherwise every sync re-imports the
  // same real job as a brand new duplicate. History matters just as much as active jobs: if you mark
  // a job Built in the app but haven't clicked Deliver in EVE yet, ESI keeps reporting that job as
  // active, and the very next silent auto-sync (which runs on every page load) would otherwise see it
  // as untracked and bring it back as a "new" ready-to-collect job.
  const alreadyTrackedEveJobIds = new Set([
    ...activeJobs.filter(j => j && j.isStarted && j.eveJobId !== undefined).map(j => j.eveJobId),
    ...buildHistory.filter(r => r && r.eveJobId !== undefined).map(r => r.eveJobId)
  ]);
  const untrackedRealJobs = activeRealJobs.filter(rj => !alreadyTrackedEveJobIds.has(rj.job_id));
  console.info(`[JobSync] ${activeRealJobs.length - untrackedRealJobs.length} real job(s) already tracked by an existing started ledger job - skipping those, ${untrackedRealJobs.length} remain to match/import.`);

  const usedRealJobIds = new Set();
  let matchedCount = 0;
  let importedCount = 0;

  // Pass 1: match against existing PENDING ledger jobs. A real job's run count fitting inside a
  // larger pending job's run count splits it (started fragment + still-queued remainder) - the same
  // thing a manual partial "Start Job" already does - rather than ever creating a redundant duplicate.
  untrackedRealJobs.forEach(rj => {
    if (usedRealJobIds.has(rj.job_id)) return;
    const targetProductId = rj.product_type_id;
    const candidates = activeJobs
      .filter(j => j && !j.isStarted && (j.productTypeId || j.typeId) === targetProductId && j.runsNeeded >= rj.runs)
      .sort((a, b) => a.runsNeeded - b.runsNeeded); // smallest sufficient fit first, to avoid attributing a small job to a much larger unrelated one
    const candidate = candidates[0];
    if (!candidate) return; // no fit among pending jobs - falls through to auto-import in pass 2

    usedRealJobIds.add(rj.job_id);
    matchedCount++;
    const jobIndex = activeJobs.findIndex(j => j.id === candidate.id);
    if (jobIndex === -1) return;

    const startedAt = new Date(rj.start_date).getTime();
    const totalBuildSeconds = Math.max(0, (new Date(rj.end_date).getTime() - startedAt) / 1000);

    if (rj.runs >= candidate.runsNeeded) {
      console.info(`[JobSync]   ✔ MATCHED "${candidate.name}" (full ${candidate.runsNeeded} runs) to real job_id=${rj.job_id}`);
      activeJobs[jobIndex].isStarted = true;
      activeJobs[jobIndex].startedAt = startedAt;
      activeJobs[jobIndex].totalBuildSeconds = totalBuildSeconds;
      activeJobs[jobIndex].eveJobId = rj.job_id;
    } else {
      console.info(`[JobSync]   ✔ MATCHED "${candidate.name}" - splitting: ${rj.runs} of ${candidate.runsNeeded} runs started (job_id=${rj.job_id}), ${candidate.runsNeeded - rj.runs} remain pending`);
      const totalRuns = candidate.runsNeeded;
      const startRuns = rj.runs;
      const ratio = startRuns / totalRuns;
      const remainingRuns = totalRuns - startRuns;
      const remainingRatio = remainingRuns / totalRuns;
      const scaleMaterials = (r) => Array.isArray(candidate.materials) ? candidate.materials.map(m => {
        const scaledQty = Math.ceil(m.qtyNeeded * r);
        const scaledStock = Math.min(m.stockQty || 0, scaledQty);
        return { ...m, qtyNeeded: scaledQty, stockQty: scaledStock, netQtyNeeded: Math.max(0, scaledQty - scaledStock), lineCost: (m.unitPrice || 0) * Math.max(0, scaledQty - scaledStock) };
      }) : [];

      const activeFragment = {
        ...candidate,
        id: Date.now() + Math.floor(Math.random() * 1000),
        runsNeeded: startRuns,
        qtyNeeded: Math.round((candidate.qtyNeeded || 0) * ratio),
        calculatedCost: (candidate.calculatedCost || 0) * ratio,
        netProfit: candidate.netProfit !== undefined ? candidate.netProfit * ratio : undefined,
        totalBuildSeconds: totalBuildSeconds,
        materials: scaleMaterials(ratio),
        startedAt: startedAt,
        isStarted: true,
        eveJobId: rj.job_id,
        splitFromId: candidate.id
      };
      const remainingFragment = {
        ...candidate,
        id: Date.now() + Math.floor(Math.random() * 1000) + 1,
        runsNeeded: remainingRuns,
        qtyNeeded: Math.round((candidate.qtyNeeded || 0) * remainingRatio),
        calculatedCost: (candidate.calculatedCost || 0) * remainingRatio,
        netProfit: candidate.netProfit !== undefined ? candidate.netProfit * remainingRatio : undefined,
        totalBuildSeconds: (candidate.totalBuildSeconds || 0) * remainingRatio,
        materials: scaleMaterials(remainingRatio),
        startedAt: undefined,
        isStarted: false,
        splitFromId: candidate.id
      };
      activeJobs.splice(jobIndex, 1, activeFragment, remainingFragment);
    }
  });

  // Pass 2: any remaining active real job with no ledger counterpart gets auto-imported - built as a
  // real recipe tree using the blueprint's ACTUAL researched ME/TE, priced at market sell only.
  for (const rj of untrackedRealJobs) {
    if (usedRealJobIds.has(rj.job_id)) continue;
    console.info(`[JobSync]   ⬇ No pending job fits real job_id=${rj.job_id} (product ${rj.product_type_id}, ${rj.runs} runs) - auto-importing.`);
    const imported = await buildAutoImportedJob(rj, blueprintMeTeMap);
    if (imported) {
      activeJobs.push(imported);
      importedCount++;
    } else {
      console.warn(`[JobSync]   ✘ Auto-import failed for real job_id=${rj.job_id} - see warnings above for why.`);
    }
  }

  localStorage.setItem('eve_ledger_jobs', JSON.stringify(activeJobs));
  renderJournalPage();

  if (!silent) {
    if (matchedCount === 0 && importedCount === 0) {
      alert('No active EVE industry jobs found to sync (or none matched/imported). Check the browser console for [JobSync] diagnostic details.');
    } else {
      alert(`Synced ${matchedCount} job(s) against existing plans, auto-imported ${importedCount} job(s) with no prior plan - using EVE's real start time, duration, and researched ME/TE.`);
    }
  }
}
window.syncWithEveIndustryJobs = syncWithEveIndustryJobs;

// Builds a full ledger job entry for a real EVE industry job that has no matching pending plan,
// using the tool's own recipe database and the blueprint's ACTUAL researched ME/TE (fetched
// separately, since the industry jobs endpoint doesn't carry that). Prices materials and output at
// market sell only, per instruction - no buy/sell strategy modeling for auto-imports.
async function buildAutoImportedJob(realJob, blueprintMeTeMap) {
  try {
    const blueprintTypeId = realJob.blueprint_type_id;
    const productTypeId = realJob.product_type_id;
    const runs = realJob.runs;
    const bpInfo = blueprintMeTeMap[realJob.blueprint_id] || { me: 0, te: 0 };
    console.info(`[JobSync]   Blueprint ME/TE for blueprint_id=${realJob.blueprint_id}: ME=${bpInfo.me}%, TE=${bpInfo.te}% ${blueprintMeTeMap[realJob.blueprint_id] === undefined ? '(not found in your blueprints list - defaulting to 0/0, verify this against the job in-game)' : ''}`);

    if (typeof window.buildRecursiveRecipeTree !== 'function') {
      console.warn('[JobSync] Recipe tree builder not available - cannot auto-import.');
      return null;
    }

    window.customMEOverrides = window.customMEOverrides || {};
    window.customTEOverrides = window.customTEOverrides || {};
    window.customMEOverrides[blueprintTypeId] = bpInfo.me;
    window.customTEOverrides[blueprintTypeId] = bpInfo.te;
    window.recipeTreeRootProductTypeId = productTypeId; // we already know this for certain from ESI

    const productName = (window.TYPE_ID_TO_NAME && window.TYPE_ID_TO_NAME[productTypeId]) || (window.EVE_ITEMS && window.EVE_ITEMS[productTypeId]) || `Item ${productTypeId}`;

    let root;
    try {
      // qty is a rough guess (batch yield unknown until the recipe resolves) - corrected below.
      root = await window.buildRecursiveRecipeTree(blueprintTypeId, productName + ' Blueprint', runs, 0, 6, new Set(), null);
    } finally {
      window.recipeTreeRootProductTypeId = null; // don't leak into unrelated calls
    }

    if (!root) {
      console.warn(`[JobSync] Could not resolve a recipe for blueprint_type_id=${blueprintTypeId} (product ${productTypeId}) - this item may not be in your local database. Try regenerating it.`);
      return null;
    }

    // Force the EXACT real run count (the tree derives runs from a qty/batchYield guess, which we
    // don't know in advance) and re-cascade quantities through the tree with the corrected count.
    root.runsNeeded = runs;
    root.qtyNeeded = runs * (root.batchYield || 1);
    const facility = (window.getActiveStructureType ? window.getActiveStructureType().meBonus : 1.0) / 100;
    if (typeof window.scaleTreeQuantities === 'function') window.scaleTreeQuantities(root, facility);

    const allTypeIds = new Set();
    if (typeof window.collectAllTypeIds === 'function') window.collectAllTypeIds(root, allTypeIds);
    if (typeof window.fetchMarketPrices === 'function') await window.fetchMarketPrices(Array.from(allTypeIds));
    if (typeof window.calculateNodeEIV === 'function') window.calculateNodeEIV(root);

    const materialCost = typeof window.calculateTreeNodeCost === 'function' ? window.calculateTreeNodeCost(root) : 0;
    // ESI's own reported job installation fee is more accurate here than re-estimating our own -
    // it's the real ISK EVE actually charged for this specific job.
    const totalCost = materialCost + (realJob.cost || 0);

    const outputPrices = window.priceCache[productTypeId] || { sell: 0, buy: 0 };
    const grossSell = outputPrices.sell * root.qtyNeeded;
    const netProfit = grossSell - totalCost;

    const totalBuildSeconds = Math.max(0, (new Date(realJob.end_date).getTime() - new Date(realJob.start_date).getTime()) / 1000);
    const materials = typeof window.extractJobMaterialsForNode === 'function' ? window.extractJobMaterialsForNode(root) : [];

    return {
      id: Date.now() + Math.floor(Math.random() * 1000) + realJob.job_id,
      typeId: blueprintTypeId,
      productTypeId: productTypeId,
      name: productName,
      runsNeeded: runs,
      qtyNeeded: root.qtyNeeded,
      calculatedCost: totalCost,
      totalBuildSeconds: totalBuildSeconds,
      netProfit: netProfit,
      sellStrategy: 'market-sell',
      unitSellPrice: outputPrices.sell,
      materials: materials,
      isStarted: true,
      startedAt: new Date(realJob.start_date).getTime(),
      eveJobId: realJob.job_id,
      autoImported: true,
      meLevel: bpInfo.me,
      teLevel: bpInfo.te,
      addedAt: new Date().toISOString()
    };
  } catch (e) {
    console.warn(`[JobSync] Auto-import threw an error for job_id=${realJob.job_id}:`, e);
    return null;
  }
}


function collectAllReadyJobs() {
  loadJournalState();
  const readyJobs = activeJobs.filter(j => j && j.isStarted && j.startedAt && ((Date.now() - j.startedAt) / 1000 >= (j.totalBuildSeconds || 0)));
  if (readyJobs.length === 0) {
    alert('No jobs are ready to collect yet.');
    return;
  }
  readyJobs.forEach(j => markJobAsBuilt(j.id));
}
window.collectAllReadyJobs = collectAllReadyJobs;

function markJobAsBuilt(jobId) {
  loadJournalState();
  const jobIndex = activeJobs.findIndex(j => j && j.id === jobId);
  if (jobIndex === -1) return;
  const job = activeJobs[jobIndex];

  const record = {
    id: job.id,
    typeId: job.typeId,
    productTypeId: job.productTypeId,
    name: job.name,
    runsNeeded: job.runsNeeded,
    qtyNeeded: job.qtyNeeded,
    calculatedCost: job.calculatedCost,
    netProfit: job.netProfit,
    isSubBuild: job.isSubBuild,
    parentJobName: job.parentJobName,
    autoImported: job.autoImported,
    materials: job.materials,
    eveJobId: job.eveJobId,
    baseTime: job.baseTime,
    totalBuildSeconds: job.totalBuildSeconds,
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
    productTypeId: record.productTypeId,
    name: record.name,
    runsNeeded: record.runsNeeded,
    qtyNeeded: record.qtyNeeded,
    calculatedCost: record.calculatedCost,
    materials: record.materials || [],
    baseTime: record.baseTime,
    totalBuildSeconds: record.totalBuildSeconds,
    addedAt: new Date().toISOString()
  };

  activeJobs.push(job);
  localStorage.setItem('eve_ledger_jobs', JSON.stringify(activeJobs));

  renderJournalPage();
}

function deleteJobFromQueue(jobId) {
  loadJournalState();
  const index = activeJobs.findIndex(j => j && j.id === jobId);
  if (index !== -1) {
    activeJobs.splice(index, 1);
    localStorage.setItem('eve_ledger_jobs', JSON.stringify(activeJobs));
    renderJournalPage();
  }
}

function renderBuildHistoryLedger() {
  const container = document.getElementById('journal-history-rows');
  if (!container) return;

  const totalProfitEl = document.getElementById('journal-history-total-profit');
  const historyCountEl = document.getElementById('journal-history-count');
  if (historyCountEl) historyCountEl.textContent = buildHistory.length.toLocaleString();
  if (totalProfitEl) {
    let totalHistoryProfit = 0;
    let historyProfitMissing = false;
    buildHistory.forEach(record => {
      if (record) {
        // History records use their own stored netProfit directly - NOT getEffectiveJobProfit(), which
        // applies the stock-credit toggle. A completed job's profit is a fixed historical fact from
        // when it finished; it shouldn't fluctuate based on a live "with/without stock credit" display
        // preference the way a still-pending job's projected profit reasonably can.
        if (record.netProfit !== undefined) {
          totalHistoryProfit += record.netProfit;
        } else if (!record.isSubBuild) {
          historyProfitMissing = true;
        }
      }
    });
    totalProfitEl.textContent = Math.round(totalHistoryProfit).toLocaleString() + ' ISK' + (historyProfitMissing ? ' *' : '');
    totalProfitEl.className = `font-bold text-xs ${totalHistoryProfit >= 0 ? 'text-green-400' : 'text-red-400'}`;
  }

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
    const recordDisplayName = window.TYPE_ID_TO_NAME[record.productTypeId] || (record.name || '')
      .replace(/ Blueprint$/i, '').replace(/ Reaction Formula$/i, '').replace(/ Formula$/i, '').trim();
    return `
      <tr class="hover:bg-[#0c1318]/50 text-slate-300 border-b border-[#1e3348]/20">
        <td class="p-1.5 py-2">${formattedDate}</td>
        <td class="p-1.5 py-2 font-bold text-white">${window.esc(recordDisplayName)}${record.isSubBuild ? `<span class="ml-1.5 text-xs text-amber-400 font-semibold normal-case" title="Prerequisite for: ${window.esc(record.parentJobName || 'another job')}">⚙ prereq</span>` : ''}</td>
        <td class="p-1.5 py-2 text-right">${record.runsNeeded.toLocaleString()}</td>
        <td class="p-1.5 py-2 text-right text-purple-300 font-bold">${record.qtyNeeded.toLocaleString()}</td>
        <td class="p-1.5 py-2 text-right text-cyan-400 font-bold">${Math.round(record.calculatedCost || 0).toLocaleString()} ISK</td>
        <td class="p-1.5 py-2">
          <div class="flex items-center space-x-2">
            <span class="text-green-400 font-bold uppercase text-xs bg-green-950 px-1 py-0.5 rounded">✔ Built</span>
            <button onclick="requeueCompletedJob(${record.id})" class="px-2 py-0.5 bg-purple-950/60 hover:bg-purple-800 text-purple-300 font-semibold rounded text-xs mono border border-purple-800/40 transition">
              🔄 Re-queue
            </button>
            <button onclick="deleteHistoryRecord(${record.id})" class="px-2 py-0.5 bg-red-950/60 hover:bg-red-800 text-red-300 font-semibold rounded text-xs mono border border-red-800/40 transition" title="Delete this entry">
              ❌
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function deleteHistoryRecord(recordId) {
  const index = buildHistory.findIndex(r => r && r.id === recordId);
  if (index !== -1) {
    buildHistory.splice(index, 1);
    localStorage.setItem('eve_ledger_history', JSON.stringify(buildHistory));
    renderJournalPage();
  }
}
window.deleteHistoryRecord = deleteHistoryRecord;

function clearJournalHistory() {
  localStorage.removeItem('eve_ledger_history');
  renderJournalPage();
}

let _draggedJobId = null;

function handleJobDragStart(e, jobId) {
  _draggedJobId = jobId;
  e.dataTransfer.effectAllowed = 'move';
  try { e.dataTransfer.setData('text/plain', String(jobId)); } catch (err) {}
  if (e.currentTarget) e.currentTarget.classList.add('opacity-40');
}
window.handleJobDragStart = handleJobDragStart;

function handleJobDragEnd(e) {
  if (e.currentTarget) e.currentTarget.classList.remove('opacity-40');
  document.querySelectorAll('.job-card').forEach(el => el.classList.remove('ring-2', 'ring-cyan-400'));
  _draggedJobId = null;
}
window.handleJobDragEnd = handleJobDragEnd;

function handleJobDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  if (e.currentTarget) e.currentTarget.classList.add('ring-2', 'ring-cyan-400');
}
window.handleJobDragOver = handleJobDragOver;

function handleJobDragLeave(e) {
  if (e.currentTarget) e.currentTarget.classList.remove('ring-2', 'ring-cyan-400');
}
window.handleJobDragLeave = handleJobDragLeave;

// Dragging directly changes the array position, which is what drives stock allocation priority -
// same effect the old Up/Down buttons had, just without repeated clicking to move something far.
function handleJobDrop(e, targetJobId) {
  e.preventDefault();
  if (e.currentTarget) e.currentTarget.classList.remove('ring-2', 'ring-cyan-400');
  if (_draggedJobId === null || _draggedJobId === targetJobId) return;

  loadJournalState();
  const fromIndex = activeJobs.findIndex(j => j && j.id === _draggedJobId);
  const toIndex = activeJobs.findIndex(j => j && j.id === targetJobId);
  if (fromIndex === -1 || toIndex === -1) return;

  const [moved] = activeJobs.splice(fromIndex, 1);
  activeJobs.splice(toIndex, 0, moved);

  localStorage.setItem('eve_ledger_jobs', JSON.stringify(activeJobs));
  _draggedJobId = null;
  renderJournalPage();
}
window.handleJobDrop = handleJobDrop;

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
      locCounts[locId] = { name: locName, count: 0, corpDivisions: {}, containers: {} };
    }
    locCounts[locId].count += item.quantity;

    if (item.owner_type === 'corp' && item.location_flag && item.location_flag.startsWith('Corp')) {
      const sagFlag = item.location_flag;
      if (!locCounts[locId].corpDivisions[sagFlag]) {
        locCounts[locId].corpDivisions[sagFlag] = { name: sagNameMap[sagFlag] || sagFlag, count: 0 };
      }
      locCounts[locId].corpDivisions[sagFlag].count += item.quantity;
    }

    if (item.container_id) {
      const cId = item.container_id;
      const cName = window.resolvedLocationNames[cId] || `Container #${cId}`;
      if (!locCounts[locId].containers[cId]) {
        locCounts[locId].containers[cId] = { name: cName, count: 0 };
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
      sagOpt.textContent = `  └─ 🟪 Corp: ${sagData.name} (${sagData.count.toLocaleString()} items)`;
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
      feedbackBadge.textContent = `Found: ${visibleCount.toLocaleString()}`;
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

  localStorage.setItem('eve_user_stock_map', JSON.stringify(window.userStockMap));
  updateJournalStockCountBadge();
  renderJournalPage();
}

function recalculateJournalStock() {
  applyJournalStockFilter();
}

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

// Explicit window bindings
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

// --- Completed History Drawer ---
function getHistoryDrawerState() {
  return localStorage.getItem('eve_history_drawer_state') || 'collapsed';
}

function applyHistoryDrawerState(state) {
  const drawer = document.getElementById('history-drawer');
  const chevron = document.getElementById('history-drawer-chevron');
  const sizeBtn = document.getElementById('history-drawer-size-btn');
  if (!drawer) return;
  if (state === 'collapsed') {
    drawer.style.height = '44px';
    if (chevron) chevron.textContent = '▲';
    if (sizeBtn) sizeBtn.classList.add('hidden');
  } else if (state === 'tall') {
    drawer.style.height = '70vh';
    if (chevron) chevron.textContent = '▼';
    if (sizeBtn) { sizeBtn.classList.remove('hidden'); sizeBtn.textContent = '⤡ Shorter'; }
  } else {
    drawer.style.height = '24rem';
    if (chevron) chevron.textContent = '▼';
    if (sizeBtn) { sizeBtn.classList.remove('hidden'); sizeBtn.textContent = '⤢ Taller'; }
  }
  localStorage.setItem('eve_history_drawer_state', state);
}

function toggleHistoryDrawer() {
  applyHistoryDrawerState(getHistoryDrawerState() === 'collapsed' ? 'normal' : 'collapsed');
}
window.toggleHistoryDrawer = toggleHistoryDrawer;

function toggleHistoryDrawerSize() {
  applyHistoryDrawerState(getHistoryDrawerState() === 'tall' ? 'normal' : 'tall');
}
window.toggleHistoryDrawerSize = toggleHistoryDrawerSize;

window.onload = async () => {
  if (typeof window.buildPrepackedIndexes === 'function') {
    window.buildPrepackedIndexes();
  }

  try {
    loadJournalState();
    populateJournalLocationDropdown();
    updateJournalStockCountBadge();
    renderJournalPage();
    applyHistoryDrawerState(getHistoryDrawerState());
  } catch (err) {
    console.error("Ledger state load error:", err);
  }

  if (typeof window.handleEsiSSOCallback === 'function') {
    window.handleEsiSSOCallback()
      .then(() => { if (typeof window.syncWithEveIndustryJobs === 'function') return window.syncWithEveIndustryJobs(true); })
      .catch(err => console.error("SSO Callback error:", err));
  }

  if (typeof window.fetchAdjustedPrices === 'function') {
    window.fetchAdjustedPrices().catch(err => console.error("Adjusted prices fetch error:", err));
  }
};