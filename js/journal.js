'use strict';

// Local HTML Escaper Helper
function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Global Journal State
let activeJobs = [];
let buildHistory = [];
let userStockMap = {};

// Load states from shared LocalStorage
function loadJournalState() {
  try {
    const savedJobs = localStorage.getItem('eve_journal_jobs');
    activeJobs = savedJobs ? JSON.parse(savedJobs) : [];
    if (!Array.isArray(activeJobs)) activeJobs = [];
  } catch (e) {
    activeJobs = [];
  }

  try {
    const savedHistory = localStorage.getItem('eve_journal_history');
    buildHistory = savedHistory ? JSON.parse(savedHistory) : [];
    if (!Array.isArray(buildHistory)) buildHistory = [];
  } catch (e) {
    buildHistory = [];
  }

  try {
    const savedStocks = localStorage.getItem('eve_user_stock_map');
    userStockMap = savedStocks ? JSON.parse(savedStocks) : {};
  } catch (e) {
    userStockMap = {};
  }
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
    totalActiveCost += job.calculatedCost || 0;
  });

  if (activeJobsCountEl) activeJobsCountEl.textContent = activeJobs.length.toLocaleString();
  if (totalCostEl) totalCostEl.textContent = Math.round(totalActiveCost).toLocaleString() + ' ISK';

  // 2. Compile Consolidated BOM across ALL active jobs
  const consolidatedBOM = {};
  activeJobs.forEach(job => {
    if (Array.isArray(job.materials)) {
      job.materials.forEach(mat => {
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

  bomItems.forEach(item => {
    const stockQty = userStockMap[item.typeId] || 0;
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

  renderActiveJobsList();
  renderConsolidatedBOMList(bomItems, aggregatedMissingCost);
  renderBuildHistoryLedger();
}

// Render active queued jobs
function renderActiveJobsList() {
  const container = document.getElementById('active-jobs-list');
  if (!container) return;

  if (activeJobs.length === 0) {
    container.innerHTML = `
      <div class="col-span-full bg-[#0c1318] border border-[#1e3348] p-8 rounded text-center text-slate-400 mono">
        No active manufacturing jobs queued in journal. Go back to the calculator and click "Add to Journal" on any root item card to add jobs here.
      </div>
    `;
    return;
  }

  container.innerHTML = activeJobs.map(job => {
    const iconTypeId = job.typeId;
    const sellLabel = job.sellStrategy === 'custom-contract' ? 'Contract' : 'Market Sell';
    const formattedDate = job.addedAt ? new Date(job.addedAt).toLocaleDateString() : 'N/A';

    return `
      <div class="bg-[#0c1318] border border-[#1e3348] hover:border-purple-500/40 rounded p-4 flex flex-col justify-between shadow-md transition space-y-4">
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

        <div class="text-xs mono space-y-1 bg-[#070b0f] p-2 rounded border border-[#1e3348]/40">
          <div class="flex justify-between">
            <span class="text-slate-400">Sell Channel:</span>
            <span class="text-purple-300 font-bold">${sellLabel}</span>
          </div>
          <div class="flex justify-between border-t border-[#1e3348]/40 pt-1 mt-1 font-bold">
            <span class="text-slate-300">Total Build Cost:</span>
            <span class="text-cyan-400">${Math.round(job.calculatedCost).toLocaleString()} ISK</span>
          </div>
        </div>

        <div class="flex items-center space-x-2 pt-1.5">
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
        No active material demands in queue.
      </div>
    `;
    return;
  }

  container.innerHTML = bomItems.map(item => {
    const isCompleted = item.netMissingQty === 0;
    const rowBg = isCompleted ? 'bg-[#0a0f14]/50 border-green-950 opacity-60' : 'bg-[#0c1318] border-[#1e3348] hover:border-purple-500/40';
    const statusBadge = isCompleted 
      ? `<span class="bg-green-950 text-green-300 text-[9px] px-1 rounded font-bold uppercase ml-1.5">Acquired</span>` 
      : `<span class="bg-amber-950 text-amber-300 text-[9px] px-1 rounded font-bold uppercase ml-1.5">Missing</span>`;

    return `
      <div class="rounded border p-2 flex items-center justify-between transition shadow-sm ${rowBg}">
        <div class="flex items-center space-x-2.5 min-w-0">
          <img src="https://images.evetech.net/types/${item.typeId}/icon?size=32" class="w-7 h-7 rounded border border-slate-700 bg-[#070b0f] flex-shrink-0" onerror="this.onerror=null; this.src='https://images.evetech.net/types/${item.typeId}/render?size=32';">
          <div class="min-w-0 flex-1">
            <div class="font-semibold text-slate-200 truncate flex items-center">
              <span class="truncate">${esc(item.name)}</span>
              ${statusBadge}
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

// Mark queued job as "built": Consumes materials from active stock map and logs to History
function markJobAsBuilt(jobId) {
  loadJournalState();

  const jobIndex = activeJobs.findIndex(j => j.id === jobId);
  if (jobIndex === -1) return;

  const job = activeJobs[jobIndex];

  // 1. MRP Material Consumption: Subtract required quantities from stock ledger
  if (Array.isArray(job.materials)) {
    job.materials.forEach(mat => {
      const id = mat.typeId;
      const consumedQty = mat.qtyNeeded || 0;
      if (userStockMap[id] !== undefined) {
        userStockMap[id] = Math.max(0, userStockMap[id] - consumedQty);
      }
    });
  }

  // Save updated stock map back to shared localStorage
  localStorage.setItem('eve_user_stock_map', JSON.stringify(userStockMap));

  // 2. Ledger Logging: Archive job records into completed build history array
  const record = {
    id: job.id,
    name: job.name,
    runsNeeded: job.runsNeeded,
    qtyNeeded: job.qtyNeeded,
    calculatedCost: job.calculatedCost,
    completedAt: new Date().toISOString()
  };

  buildHistory.unshift(record); // Insert completed job as first record
  localStorage.setItem('eve_journal_history', JSON.stringify(buildHistory));

  // 3. Remove job from the active manufacturing queue
  activeJobs.splice(jobIndex, 1);
  localStorage.setItem('eve_journal_jobs', JSON.stringify(activeJobs));

  renderJournalPage();
}

// Delete queued job from active queue (no history or stock deduction)
function deleteJobFromQueue(jobId) {
  loadJournalState();

  const index = activeJobs.findIndex(j => j.id === jobId);
  if (index !== -1) {
    activeJobs.splice(index, 1);
    localStorage.setItem('eve_journal_jobs', JSON.stringify(activeJobs));
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
          No completed build records logged in database.
        </td>
      </tr>
    `;
    return;
  }

  container.innerHTML = buildHistory.map(record => {
    const formattedDate = record.completedAt ? new Date(record.completedAt).toLocaleDateString() + ' ' + new Date(record.completedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'N/A';
    return `
      <tr class="hover:bg-[#0c1318]/50 text-slate-300 border-b border-[#1e3348]/20">
        <td class="p-1.5 py-2">${formattedDate}</td>
        <td class="p-1.5 py-2 font-bold text-white">${esc(record.name)}</td>
        <td class="p-1.5 py-2 text-right">${record.runsNeeded.toLocaleString()}</td>
        <td class="p-1.5 py-2 text-right text-purple-300 font-bold">${record.qtyNeeded.toLocaleString()}</td>
        <td class="p-1.5 py-2 text-right text-cyan-400 font-bold">${Math.round(record.calculatedCost || 0).toLocaleString()} ISK</td>
        <td class="p-1.5 py-2"><span class="text-green-400 font-bold uppercase text-[9px] bg-green-950 px-1 py-0.5 rounded">✔ Built</span></td>
      </tr>
    `;
  }).join('');
}

// Clear finished build logs
function clearJournalHistory() {
  localStorage.removeItem('eve_journal_history');
  renderJournalPage();
}

// Expose actions globally to windows environment
window.copyJournalMultibuy = copyJournalMultibuy;
window.markJobAsBuilt = markJobAsBuilt;
window.deleteJobFromQueue = deleteJobFromQueue;
window.clearJournalHistory = clearJournalHistory;

// Initialize Journal page on window load
window.onload = () => {
  renderJournalPage();
};