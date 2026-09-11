'use strict';

// --- Invention Job Queue ---
// Deliberately separate storage/lifecycle from the manufacturing Ledger (eve_ledger_jobs) - an
// invention "job" is a BATCH of probabilistic attempts (0+ successes out of N real tries), not one
// deterministic build with a fixed material list. Once a batch actually produces a successful BPC,
// THAT BPC's manufacturing run is a normal deterministic build again and belongs in the Ledger the
// usual way (see sendInventionQueueBatchToCalculator below, which reuses the exact same ?build= link
// js/invention.js's own sendInventionRowToCalculator already uses to hand a BPC to the Calculator).
//
// Real in-game matching is grounded in two confirmed ESI facts (see the plan/session notes this was
// verified against, not guessed):
//   - An invention job's own `blueprint_type_id` is the T1 BPC being invented FROM, and its
//     `product_type_id` is the T2 BLUEPRINT COPY it produces if it succeeds - NOT the ship/module
//     item itself, since a blueprint copy is literally what an invention job creates.
//   - `successful_runs` on a completed ("delivered") job is "Number of successful runs for this job.
//     Equal to runs unless this is an invention job" (ESI schema) - for invention specifically this
//     is the real win/lose signal: 0 = failed, >0 = succeeded. This only appears once the job's
//     status is 'delivered', which is why in-progress attempts are left alone until then rather than
//     guessed at from 'active'/'ready'.

const INVENTION_QUEUE_KEY = 'eve_invention_queue_v1';

function loadInventionQueue() {
  return window.safeParseJSON(localStorage.getItem(INVENTION_QUEUE_KEY), []);
}
function saveInventionQueue(queue) {
  localStorage.setItem(INVENTION_QUEUE_KEY, JSON.stringify(queue));
}

// Called by js/invention.js's queueInventionRow() with a plain data object - this function owns
// giving it an id/status/attempts array and persisting it.
function addInventionQueueBatch(data) {
  const queue = loadInventionQueue();
  const batch = {
    id: `${Date.now()}-${Math.floor(Math.random() * 100000)}`,
    t2BlueprintTypeId: data.t2BlueprintTypeId,
    t2ProductTypeId: data.t2ProductTypeId,
    t2ProductName: data.t2ProductName,
    t1BlueprintTypeId: data.t1BlueprintTypeId,
    t1BlueprintName: data.t1BlueprintName,
    decryptorName: data.decryptorName,
    resultME: data.resultME,
    resultTE: data.resultTE,
    resultRuns: data.resultRuns,
    targetBPCs: data.targetBPCs,
    successChance: data.successChance,
    plannedAttempts: data.plannedAttempts,
    estimatedCost: data.estimatedCost,
    status: 'planned', // planned -> active (>=1 real attempt matched) -> complete
    scope: 'personal', // same default addCurrentJobToLedger uses - upgraded to 'corp' if a matched real job turns out to be one
    ownerCharId: window.getActiveCharId ? window.getActiveCharId() : null,
    corpId: null,
    addedAt: new Date().toISOString(),
    autoImported: false,
    attempts: []
  };
  queue.unshift(batch);
  saveInventionQueue(queue);
  renderInventionQueue();
  if (typeof window.showToast === 'function') {
    window.showToast(`Queued "${data.t2ProductName}" (${data.decryptorName}) - Sync EVE Jobs will track your real attempts against it.`, 'success');
  }
}
window.addInventionQueueBatch = addInventionQueueBatch;

function abandonInventionQueueBatch(id) {
  const queue = loadInventionQueue().filter(b => b.id !== id);
  saveInventionQueue(queue);
  renderInventionQueue();
}
window.abandonInventionQueueBatch = abandonInventionQueueBatch;

// Manual fallback for when you're not logged in, haven't synced yet, or just want to correct the
// tally by hand - adds one attempt with no eveJobId (never matched against a real job later, since
// syncInventionQueueWithEve only ever touches attempts that already carry undefined/null eveJobId
// is fine to leave alongside real ones - they're just never resolved further).
function manualLogInventionAttempt(id, outcome) {
  const queue = loadInventionQueue();
  const batch = queue.find(b => b.id === id);
  if (!batch) return;
  batch.attempts.push({ eveJobId: null, status: outcome, startedAt: new Date().toISOString(), completedAt: new Date().toISOString() });
  batch.status = 'active';
  const successes = batch.attempts.filter(a => a.status === 'succeeded').length;
  if (successes >= batch.targetBPCs) batch.status = 'complete';
  saveInventionQueue(queue);
  renderInventionQueue();
}
window.manualLogInventionAttempt = manualLogInventionAttempt;

function sendInventionQueueBatchToCalculator(id) {
  const batch = loadInventionQueue().find(b => b.id === id);
  if (!batch) return;
  const state = { id: batch.t2BlueprintTypeId, name: batch.t2ProductName, runs: batch.resultRuns, me: batch.resultME, te: batch.resultTE };
  const encoded = btoa(encodeURIComponent(JSON.stringify(state)));
  window.location.href = `index.html?build=${encoded}`;
}
window.sendInventionQueueBatchToCalculator = sendInventionQueueBatchToCalculator;

// A real invention job ESI reports that doesn't match anything queued - still shown (same "just
// show me what's really happening in-game" philosophy js/ledger.js's own auto-import already
// follows), but honestly labeled: ESI's job object has no field for which DECRYPTOR was used, so
// the resulting BPC's ME/TE/runs genuinely can't be known here - shown as "Unknown" rather than
// guessed, and Send to Calculator stays disabled for it until you queue a real plan yourself.
function buildAutoImportedInventionBatch(rj) {
  const t2Name = (window.TYPE_ID_TO_NAME && window.TYPE_ID_TO_NAME[rj.product_type_id]) || `Type ${rj.product_type_id}`;
  const t1Name = (window.EVE_ITEMS && window.EVE_ITEMS[rj.blueprint_type_id]) || `Type ${rj.blueprint_type_id}`;
  return {
    id: `auto-${rj.job_id}`,
    t2BlueprintTypeId: rj.product_type_id,
    t2ProductTypeId: (window.BLUEPRINT_TO_PRODUCT_MAP && window.BLUEPRINT_TO_PRODUCT_MAP[rj.product_type_id]) || rj.product_type_id,
    t2ProductName: t2Name.replace(/ Blueprint$/i, ''),
    t1BlueprintTypeId: rj.blueprint_type_id,
    t1BlueprintName: t1Name,
    decryptorName: null, // unknown - ESI doesn't report which decryptor a job used
    resultME: null,
    resultTE: null,
    resultRuns: null,
    targetBPCs: 1,
    successChance: null,
    plannedAttempts: null,
    estimatedCost: null,
    status: 'planned',
    scope: rj._source === 'corp' ? 'corp' : 'personal',
    ownerCharId: rj.installer_id !== undefined ? String(rj.installer_id) : null,
    corpId: rj._source === 'corp' ? (window.getActiveCharacterRecord ? (window.getActiveCharacterRecord() || {}).corpId : null) : null,
    addedAt: new Date().toISOString(),
    autoImported: true,
    attempts: []
  };
}

// Matches real in-game invention activity against the queue, same spirit as js/ledger.js's own
// syncWithEveIndustryJobs but meaningfully simpler: invention attempts aren't splittable/partial the
// way manufacturing runs are (each ESI job IS one attempt), and invention doesn't need the real
// blueprint's own ME/TE (it has no bearing on invention's outcome) - so there's no equivalent of
// that function's Pass-1 partial-match or its corp-mate blueprint ME/TE widening.
async function syncInventionQueueWithEve(silent) {
  const btn = document.getElementById('btn-sync-invention-jobs');
  const btnLabel = document.getElementById('btn-sync-invention-jobs-label');
  if (btn && !silent) { btn.disabled = true; if (btnLabel) btnLabel.textContent = 'Syncing...'; }

  const charId = window.getActiveCharId ? window.getActiveCharId() : null;
  if (!charId) {
    if (btn) { btn.disabled = false; if (btnLabel) btnLabel.textContent = 'Sync EVE Jobs'; }
    if (!silent && typeof window.showToast === 'function') window.showToast('Log in via EVE SSO first to sync real invention jobs.', 'info');
    return;
  }

  const [charJobs, corpJobs, charCompleted, corpCompleted] = await Promise.all([
    typeof window.fetchActiveIndustryJobs === 'function' ? window.fetchActiveIndustryJobs() : null,
    typeof window.fetchActiveCorpIndustryJobs === 'function' ? window.fetchActiveCorpIndustryJobs() : [],
    typeof window.fetchCompletedIndustryJobs === 'function' ? window.fetchCompletedIndustryJobs() : null,
    typeof window.fetchCompletedCorpIndustryJobs === 'function' ? window.fetchCompletedCorpIndustryJobs() : []
  ]);

  if (btn) { btn.disabled = false; if (btnLabel) btnLabel.textContent = 'Sync EVE Jobs'; }

  if (!charJobs && (!corpJobs || !corpJobs.length) && !charCompleted) {
    if (!silent && typeof window.showToast === 'function') window.showToast('Could not fetch industry jobs. Make sure you are logged in via EVE SSO - if you logged in before this feature existed, log out and back in once to grant Industry Jobs permissions.', 'error');
    return;
  }

  (charJobs || []).forEach(j => { if (j) j._source = 'personal'; });
  (corpJobs || []).forEach(j => { if (j) j._source = 'corp'; });
  const activeInventionJobs = [...(charJobs || []), ...(corpJobs || [])].filter(j => j && j.status === 'active' && j.activity_id === 8);

  const completedById = new Map();
  [...(charCompleted || []), ...(corpCompleted || [])].forEach(j => { if (j) completedById.set(j.job_id, j); });

  const queue = loadInventionQueue();

  const trackedEveJobIds = new Set();
  queue.forEach(b => b.attempts.forEach(a => { if (a.eveJobId !== undefined && a.eveJobId !== null) trackedEveJobIds.add(a.eveJobId); }));

  // 1) Match (or auto-import) newly-seen ACTIVE invention jobs.
  let newlyMatched = 0, newlyImported = 0;
  activeInventionJobs.forEach(rj => {
    if (trackedEveJobIds.has(rj.job_id)) return;
    let batch = queue.find(b => (b.status === 'planned' || b.status === 'active') && b.t1BlueprintTypeId === rj.blueprint_type_id && b.t2BlueprintTypeId === rj.product_type_id);
    if (batch) {
      newlyMatched++;
    } else {
      batch = buildAutoImportedInventionBatch(rj);
      queue.push(batch);
      newlyImported++;
    }
    batch.attempts.push({ eveJobId: rj.job_id, status: 'in_progress', startedAt: rj.start_date || null, completedAt: null });
    batch.status = 'active';
    trackedEveJobIds.add(rj.job_id);
  });

  // 2) Resolve IN-PROGRESS attempts against completed jobs (successful_runs is the real signal -
  // see this file's own top comment). A cancelled/reverted job never delivered a BPC either way.
  let newlyResolved = 0;
  queue.forEach(batch => {
    batch.attempts.forEach(a => {
      if (a.status !== 'in_progress' || a.eveJobId === null) return;
      const cj = completedById.get(a.eveJobId);
      if (!cj) return; // still active, or not visible in the completed list yet
      if (cj.status === 'delivered') {
        a.status = (cj.successful_runs || 0) > 0 ? 'succeeded' : 'failed';
        a.completedAt = cj.completed_date || cj.end_date || new Date().toISOString();
        newlyResolved++;
      } else if (cj.status === 'cancelled' || cj.status === 'reverted') {
        a.status = 'failed';
        a.completedAt = cj.completed_date || cj.end_date || new Date().toISOString();
        newlyResolved++;
      }
      // 'active' / 'paused' / 'ready' left alone - not confirmed resolved yet.
    });
    const successes = batch.attempts.filter(a => a.status === 'succeeded').length;
    if (batch.status !== 'complete' && successes >= batch.targetBPCs) {
      batch.status = 'complete';
    }
  });

  saveInventionQueue(queue);
  renderInventionQueue();

  if (!silent && typeof window.showToast === 'function') {
    if (newlyMatched || newlyImported || newlyResolved) {
      const parts = [];
      if (newlyMatched) parts.push(`${newlyMatched} attempt${newlyMatched > 1 ? 's' : ''} matched to queued plans`);
      if (newlyImported) parts.push(`${newlyImported} unplanned invention job${newlyImported > 1 ? 's' : ''} detected`);
      if (newlyResolved) parts.push(`${newlyResolved} attempt${newlyResolved > 1 ? 's' : ''} resolved`);
      window.showToast(parts.join(', ') + '.', 'success');
    } else {
      window.showToast('No new invention activity found.', 'info');
    }
  }
}
window.syncInventionQueueWithEve = syncInventionQueueWithEve;

// Periodic background re-check while the tab stays open, same 10-minute cadence js/ledger.js's own
// runScheduledEsiJobSync uses for the manufacturing queue - a job started before you opened this
// tab, or one that finishes while you're still on it, still gets picked up without a manual click.
let _inventionQueueBackgroundSyncScheduled = false;
function scheduleInventionQueueBackgroundSync() {
  if (_inventionQueueBackgroundSyncScheduled) return;
  _inventionQueueBackgroundSyncScheduled = true;
  const tick = () => {
    if (window.getActiveCharId && window.getActiveCharId()) {
      syncInventionQueueWithEve(true).catch(e => console.warn('[Invention] Background queue sync error:', e));
    }
    setTimeout(tick, 600000); // 10 minutes
  };
  setTimeout(tick, 600000);
}
window.scheduleInventionQueueBackgroundSync = scheduleInventionQueueBackgroundSync;

// --- Rendering ---

function inventionQueueStatusBadge(batch) {
  const successes = batch.attempts.filter(a => a.status === 'succeeded').length;
  const inProgress = batch.attempts.filter(a => a.status === 'in_progress').length;
  if (batch.status === 'complete') return `<span class="lp-badge" style="background:rgba(76,196,145,0.18);color:var(--green);">${window.svgIcon('check')} Complete</span>`;
  if (inProgress > 0) return `<span class="lp-badge" style="background:rgba(217,184,74,0.18);color:#e7cd77;">${window.svgIcon('hourglass')} In Progress</span>`;
  if (successes > 0) return `<span class="lp-badge lp-badge-accent">${window.svgIcon('check')} ${successes} Success${successes > 1 ? 'es' : ''}</span>`;
  return `<span class="lp-badge">Planned</span>`;
}

function renderInventionQueueBatchCard(batch) {
  const successes = batch.attempts.filter(a => a.status === 'succeeded').length;
  const failures = batch.attempts.filter(a => a.status === 'failed').length;
  const inProgress = batch.attempts.filter(a => a.status === 'in_progress').length;
  const totalRun = batch.attempts.length;
  const decLabel = batch.decryptorName || 'Unknown decryptor';
  const resultLabel = (batch.resultRuns !== null && batch.resultRuns !== undefined)
    ? `${batch.resultRuns} run${batch.resultRuns > 1 ? 's' : ''}, ME${batch.resultME >= 0 ? '+' : ''}${batch.resultME}/TE${batch.resultTE >= 0 ? '+' : ''}${batch.resultTE}`
    : 'ME/TE unknown - ESI does not report which decryptor a job used';
  const canSendToCalc = successes > 0 && batch.t2BlueprintTypeId && batch.resultRuns !== null && batch.resultRuns !== undefined;

  return `
    <div class="lp-inset p-3" style="border-left:3px solid ${batch.status === 'complete' ? 'var(--green)' : 'var(--accent)'};">
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-2 min-w-0">
          <img src="https://images.evetech.net/types/${batch.t2ProductTypeId || batch.t2BlueprintTypeId}/icon?size=32" alt="" class="w-8 h-8 rounded flex-shrink-0" loading="lazy" onerror="this.style.visibility='hidden'">
          <div class="min-w-0">
            <div class="font-bold truncate text-sm" style="color:var(--text);">${window.esc(batch.t2ProductName)}${batch.autoImported ? ' <span class="text-[9px] font-normal" style="color:var(--text-mute);">(detected, not planned)</span>' : ''}</div>
            <div class="text-[10px] mono truncate" style="color:var(--text-mute);">${window.esc(decLabel)} &middot; target ${batch.targetBPCs} BPC${batch.targetBPCs > 1 ? 's' : ''} &middot; ${window.esc(resultLabel)}</div>
          </div>
        </div>
        <div class="flex-shrink-0">${inventionQueueStatusBadge(batch)}</div>
      </div>
      <div class="mt-2 flex items-center justify-between gap-2 text-xs mono flex-wrap">
        <span style="color:var(--text-mute);">${successes}/${batch.targetBPCs} successes &middot; ${totalRun} attempt${totalRun !== 1 ? 's' : ''} run${inProgress ? ` (${inProgress} in progress)` : ''}${failures ? ` &middot; ${failures} failed` : ''}</span>
        <div class="flex items-center gap-1.5">
          <button onclick="manualLogInventionAttempt('${batch.id}','succeeded')" class="lp-chip-btn" style="padding:4px 7px;" title="Manually log one successful attempt (use if you're not syncing via ESI)">${window.svgIcon('check')}</button>
          <button onclick="manualLogInventionAttempt('${batch.id}','failed')" class="lp-chip-btn" style="padding:4px 7px;" title="Manually log one failed attempt">${window.svgIcon('x')}</button>
          <button onclick="sendInventionQueueBatchToCalculator('${batch.id}')" class="lp-chip-btn" style="padding:4px 7px;" ${canSendToCalc ? '' : 'disabled'} title="${canSendToCalc ? 'Open the resulting BPC in the Calculator' : 'No confirmed success with known ME/TE yet'}">${window.svgIcon('trending')}</button>
          <button onclick="abandonInventionQueueBatch('${batch.id}')" class="lp-chip-btn" style="padding:4px 7px;" title="Remove from queue">${window.svgIcon('x')}</button>
        </div>
      </div>
    </div>
  `;
}

function renderInventionQueue() {
  const section = document.getElementById('invention-queue-section');
  const list = document.getElementById('invention-queue-list');
  if (!section || !list) return;
  const queue = loadInventionQueue();
  if (queue.length === 0) {
    section.classList.add('hidden');
    list.innerHTML = '';
    return;
  }
  section.classList.remove('hidden');
  // Active/planned first, complete last - so what still needs attention doesn't get buried below
  // finished batches as the queue grows.
  const sorted = [...queue].sort((a, b) => {
    const rank = s => s === 'complete' ? 2 : s === 'active' ? 0 : 1;
    return rank(a.status) - rank(b.status) || (b.addedAt || '').localeCompare(a.addedAt || '');
  });
  list.innerHTML = sorted.map(renderInventionQueueBatchCard).join('');
}
window.renderInventionQueue = renderInventionQueue;
