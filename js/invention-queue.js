'use strict';

// --- Invention Job Queue ---
// Deliberately separate storage/lifecycle from the manufacturing Ledger (eve_ledger_jobs) - an
// invention "job" is a BATCH of probabilistic attempts (0+ successes out of N real tries), not one
// deterministic build with a fixed material list. Once a batch actually produces a successful BPC,
// THAT BPC's manufacturing run is a normal deterministic build again and belongs in the Ledger the
// usual way (see sendInventionQueueBatchToCalculator below, which reuses the exact same ?build= link
// js/invention.js's own sendInventionRowToCalculator already uses to hand a BPC to the Calculator).
//
// Real in-game matching/resolution is grounded in confirmed ESI facts, not guesses:
//   - An invention job's own `blueprint_type_id` is the T1 BPC being invented FROM, and its
//     `product_type_id` is the T2 BLUEPRINT COPY it produces if it succeeds - NOT the ship/module
//     item itself, since a blueprint copy is literally what an invention job creates. Matching on
//     this pair works WITHOUT knowing which decryptor was used, since the decryptor never changes
//     which T1/T2 pair a job is for - only its odds and the resulting BPC's stats.
//   - A job's `runs` field is how many separate invention ATTEMPTS it bundles into one job (you can
//     run several attempts back to back in a single job, sharing one timer) - each real job is NOT
//     automatically "one attempt". `successful_runs`, present once a job's status is 'delivered', is
//     "Number of successful runs for this job. Equal to runs unless this is an invention job" (ESI
//     schema) - for invention this is the real count of how many of those `runs` attempts succeeded.
//     There is no per-attempt outcome visible mid-job, only this final tally - which is also why
//     manual logging below records "N attempts, M succeeded" as one entry, not one click per attempt.
//   - ESI does NOT report which decryptor a job used, so a job's resulting BPC's real ME/TE/runs
//     can't be read off the job itself. Instead, once a job resolves with successful_runs > 0, this
//     file looks at the character/corp's CURRENT blueprint list for a T2 BPC (not a BPO) of the
//     target type that hasn't already been claimed by an earlier resolution, and reads ITS real
//     stats directly - the actual result, not a guess from which decryptor was probably used. This
//     is a best-effort match (ESI gives blueprint items no creation timestamp to match precisely by),
//     shown as such in the UI - but it means ESI sync stays useful for real numbers even without
//     decryptor visibility, not just attempt/success counting.

const INVENTION_QUEUE_KEY = 'eve_invention_queue_v1';
const INVENTION_VIEW_MODE_KEY = 'eve_invention_view_mode';

function loadInventionQueue() {
  return window.safeParseJSON(localStorage.getItem(INVENTION_QUEUE_KEY), []);
}
function saveInventionQueue(queue) {
  localStorage.setItem(INVENTION_QUEUE_KEY, JSON.stringify(queue));
}

function inventionBatchRunsDone(batch) {
  return batch.attempts.reduce((sum, a) => sum + (a.runs || 1), 0);
}
function inventionBatchSuccesses(batch) {
  return batch.attempts.reduce((sum, a) => sum + (a.status === 'resolved' ? (a.successfulRuns || 0) : 0), 0);
}
function inventionBatchInProgressRuns(batch) {
  return batch.attempts.filter(a => a.status === 'in_progress').reduce((sum, a) => sum + (a.runs || 1), 0);
}
// The most credible result stats for this batch's eventual BPC: a REAL result read off a resolved
// attempt's matched blueprint (see this file's own top comment) beats the planned/simulated one from
// whichever decryptor was picked at queue time, since a different decryptor may have actually been
// used in-game.
function inventionBatchBestResult(batch) {
  const withReal = batch.attempts.find(a => a.resultBPC);
  if (withReal) return { me: withReal.resultBPC.me, te: withReal.resultBPC.te, runs: withReal.resultBPC.runs, isReal: true };
  if (batch.resultRuns !== null && batch.resultRuns !== undefined) return { me: batch.resultME, te: batch.resultTE, runs: batch.resultRuns, isReal: false };
  return null;
}
// How many MORE attempts the queue-time plan estimated you'd still need, given attempts already run -
// e.g. planned 4 to reach the target, already ran 1, so 3 left. null (not a number) when there's no
// plan to estimate from at all (an auto-imported batch, decryptor never confirmed) - shown/used
// differently from "0 more needed" (on track) by callers.
function inventionBatchRunsNeeded(batch) {
  if (!batch.plannedRuns) return null;
  return Math.max(0, batch.plannedRuns - inventionBatchRunsDone(batch));
}
// Four visually distinct states, not just "complete or not" - a batch nobody has touched yet reads
// very differently from one that's actively running in-game, which reads differently again from one
// where every attempt so far has failed and nothing is currently running (needs your attention: go
// queue more attempts in-game, or accept the shortfall).
function inventionBatchDisplayStatus(batch) {
  const successes = inventionBatchSuccesses(batch);
  const inProgressRuns = inventionBatchInProgressRuns(batch);
  const totalRun = inventionBatchRunsDone(batch);
  if (batch.status === 'complete' || successes >= batch.targetBPCs) {
    return { key: 'complete', label: 'Complete', badgeBg: 'rgba(76,196,145,0.18)', badgeColor: 'var(--green)', border: 'var(--green)', icon: 'check' };
  }
  if (inProgressRuns > 0) {
    return { key: 'in_progress', label: 'In Progress', badgeBg: 'rgba(106,152,222,0.2)', badgeColor: 'var(--blue-300)', border: 'var(--blue)', icon: 'hourglass' };
  }
  if (totalRun > 0) {
    return { key: 'needs_more', label: 'Needs More Runs', badgeBg: 'rgba(221,107,100,0.18)', badgeColor: 'var(--red-300)', border: 'var(--red)', icon: 'warning' };
  }
  return { key: 'planned', label: 'Planned', badgeBg: 'rgba(255,255,255,0.07)', badgeColor: 'var(--text-mute)', border: 'rgba(255,255,255,0.18)', icon: null };
}

// --- View mode (Compare Decryptors <-> Job Queue) ---

function setInventionViewMode(mode) {
  localStorage.setItem(INVENTION_VIEW_MODE_KEY, mode);
  const compareView = document.getElementById('invention-compare-view');
  const queueView = document.getElementById('invention-queue-view');
  const compareBtn = document.getElementById('invention-mode-compare-btn');
  const queueBtn = document.getElementById('invention-mode-queue-btn');
  if (!compareView || !queueView) return;
  compareView.classList.toggle('hidden', mode !== 'compare');
  queueView.classList.toggle('hidden', mode !== 'queue');
  if (compareBtn) compareBtn.classList.toggle('active', mode === 'compare');
  if (queueBtn) queueBtn.classList.toggle('active', mode === 'queue');
  if (mode === 'queue') renderInventionQueueBom();
}
window.setInventionViewMode = setInventionViewMode;

// Settles on whichever view (Compare/Queue) to show on page load - called once from js/invention.js's
// window.onload, after both a restored item's Compare data and the cached queue have rendered.
// Prefers your last-used view when there's actually content for it, falls back sensibly otherwise
// (an item was restored but the queue's empty -> Compare; only a queue exists -> Queue; neither ->
// leave the initial "search for an item" empty-state showing).
function restoreInventionViewModeOnLoad() {
  const hasCompareContent = (document.getElementById('invention-summary-tiles')?.children.length || 0) > 0;
  const hasQueueContent = loadInventionQueue().length > 0;
  if (!hasCompareContent && !hasQueueContent) return;
  const saved = localStorage.getItem(INVENTION_VIEW_MODE_KEY);
  const mode = (saved === 'queue' && hasQueueContent) ? 'queue'
    : (saved === 'compare' && hasCompareContent) ? 'compare'
    : hasCompareContent ? 'compare' : 'queue';
  setInventionViewMode(mode);
}
window.restoreInventionViewModeOnLoad = restoreInventionViewModeOnLoad;

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
    decryptorTypeId: data.decryptorTypeId,
    resultME: data.resultME,
    resultTE: data.resultTE,
    resultRuns: data.resultRuns,
    targetBPCs: data.targetBPCs,
    successChance: data.successChance,
    plannedRuns: data.plannedRuns,
    estimatedCost: data.estimatedCost,
    invMaterials: data.invMaterials || [],
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
    window.showToast(`Queued "${data.t2ProductName}" (${data.decryptorName}) - Sync EVE Jobs will track your real runs against it.`, 'success');
  }
}
window.addInventionQueueBatch = addInventionQueueBatch;

function abandonInventionQueueBatch(id) {
  const queue = loadInventionQueue().filter(b => b.id !== id);
  saveInventionQueue(queue);
  renderInventionQueue();
}
window.abandonInventionQueueBatch = abandonInventionQueueBatch;

// Manual fallback for when you're not logged in, haven't synced yet, or want to correct the tally -
// logs ONE resolved entry of "N attempts, M succeeded" (matching how EVE itself only ever reports an
// invention job's outcome as a single final tally, never per-attempt), not a per-attempt click.
function manualLogInventionRuns(id) {
  const runsInput = document.getElementById(`inv-manual-runs-${id}`);
  const successInput = document.getElementById(`inv-manual-success-${id}`);
  const runs = Math.max(1, parseInt(runsInput?.value) || 0);
  const successes = Math.max(0, Math.min(runs, parseInt(successInput?.value) || 0));
  if (!runs) return;
  const queue = loadInventionQueue();
  const batch = queue.find(b => b.id === id);
  if (!batch) return;
  batch.attempts.push({ eveJobId: null, runs, status: 'resolved', successfulRuns: successes, startDate: null, endDate: null, completedAt: new Date().toISOString(), resultBPC: null });
  batch.status = inventionBatchSuccesses(batch) >= batch.targetBPCs ? 'complete' : 'active';
  saveInventionQueue(queue);
  renderInventionQueue();
}
window.manualLogInventionRuns = manualLogInventionRuns;

function sendInventionQueueBatchToCalculator(id) {
  const batch = loadInventionQueue().find(b => b.id === id);
  if (!batch) return;
  const result = inventionBatchBestResult(batch);
  if (!result || !batch.t2BlueprintTypeId) return;
  const state = { id: batch.t2BlueprintTypeId, name: batch.t2ProductName, runs: result.runs, me: result.me, te: result.te };
  const encoded = btoa(encodeURIComponent(JSON.stringify(state)));
  window.location.href = `index.html?build=${encoded}`;
}
window.sendInventionQueueBatchToCalculator = sendInventionQueueBatchToCalculator;

// A real invention job ESI reports that doesn't match anything queued - still shown (same "just
// show me what's really happening in-game" philosophy js/ledger.js's own auto-import already
// follows). Datacores CAN still be resolved (decryptor-independent, see js/invention.js's
// getInventionMaterialsForT1Blueprint) even though the decryptor itself can't be.
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
    decryptorTypeId: null,
    resultME: null,
    resultTE: null,
    resultRuns: null,
    targetBPCs: 1,
    successChance: null, // unknown - excluded from the aggregate shopping list's quantity math (needs a % to estimate remaining attempts)
    plannedRuns: null,
    estimatedCost: null,
    invMaterials: typeof window.getInventionMaterialsForT1Blueprint === 'function' ? window.getInventionMaterialsForT1Blueprint(rj.blueprint_type_id) : [],
    status: 'planned',
    scope: rj._source === 'corp' ? 'corp' : 'personal',
    ownerCharId: rj.installer_id !== undefined ? String(rj.installer_id) : null,
    corpId: rj._source === 'corp' ? (window.getActiveCharacterRecord ? (window.getActiveCharacterRecord() || {}).corpId : null) : null,
    addedAt: new Date().toISOString(),
    autoImported: true,
    attempts: []
  };
}

// Picks an unclaimed real BPC of the target type from an already-fetched blueprint list - see this
// file's own top comment on why this is how a resolved attempt's REAL ME/TE/runs get filled in.
// item_id descending as a weak recency proxy (ESI gives blueprint items no creation timestamp at
// all) - not a confident match, which is why the UI marks this "best-effort".
function pickUnclaimedBpcCandidate(blueprints, t2BlueprintTypeId, claimedItemIds) {
  const candidates = blueprints.filter(bp => bp && bp.type_id === t2BlueprintTypeId && bp.quantity !== -1 && !claimedItemIds.has(bp.item_id));
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.item_id - a.item_id);
  return candidates[0];
}

// Matches real in-game invention activity against the queue, same spirit as js/ledger.js's own
// syncWithEveIndustryJobs but meaningfully simpler: invention attempts don't split/partial-match the
// way manufacturing runs do (an untracked job just becomes a new attempt entry), and invention
// doesn't need the real blueprint's own ME/TE (it has no bearing on invention's outcome).
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

  const [charJobs, corpJobs, charCompleted, corpCompleted, charBps, corpBps] = await Promise.all([
    typeof window.fetchActiveIndustryJobs === 'function' ? window.fetchActiveIndustryJobs() : null,
    typeof window.fetchActiveCorpIndustryJobs === 'function' ? window.fetchActiveCorpIndustryJobs() : [],
    typeof window.fetchCompletedIndustryJobs === 'function' ? window.fetchCompletedIndustryJobs() : null,
    typeof window.fetchCompletedCorpIndustryJobs === 'function' ? window.fetchCompletedCorpIndustryJobs() : [],
    typeof window.fetchCharacterBlueprints === 'function' ? window.fetchCharacterBlueprints() : [],
    typeof window.fetchCorpBlueprints === 'function' ? window.fetchCorpBlueprints() : []
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

  const allBlueprints = [...(charBps || []), ...(corpBps || [])];

  const queue = loadInventionQueue();

  const trackedEveJobIds = new Set();
  const claimedItemIds = new Set();
  queue.forEach(b => b.attempts.forEach(a => {
    if (a.eveJobId !== undefined && a.eveJobId !== null) trackedEveJobIds.add(a.eveJobId);
    if (a.resultBPC && a.resultBPC.itemId !== undefined) claimedItemIds.add(a.resultBPC.itemId);
  }));

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
    batch.attempts.push({ eveJobId: rj.job_id, runs: rj.runs || 1, status: 'in_progress', successfulRuns: null, startDate: rj.start_date || null, endDate: rj.end_date || null, completedAt: null, resultBPC: null });
    batch.status = 'active';
    if (rj._source === 'corp' && batch.scope !== 'corp') {
      batch.scope = 'corp';
      batch.corpId = window.getActiveCharacterRecord ? (window.getActiveCharacterRecord() || {}).corpId : null;
    }
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
        a.successfulRuns = cj.successful_runs || 0;
        a.status = 'resolved';
        a.completedAt = cj.completed_date || cj.end_date || new Date().toISOString();
        newlyResolved++;
        if (a.successfulRuns > 0) {
          const candidate = pickUnclaimedBpcCandidate(allBlueprints, batch.t2BlueprintTypeId, claimedItemIds);
          if (candidate) {
            a.resultBPC = { me: candidate.material_efficiency || 0, te: candidate.time_efficiency || 0, runs: candidate.runs && candidate.runs > 0 ? candidate.runs : 1, itemId: candidate.item_id };
            claimedItemIds.add(candidate.item_id);
          }
        }
      } else if (cj.status === 'cancelled' || cj.status === 'reverted') {
        a.successfulRuns = 0;
        a.status = 'resolved';
        a.completedAt = cj.completed_date || cj.end_date || new Date().toISOString();
        newlyResolved++;
      }
      // 'active' / 'paused' / 'ready' left alone - not confirmed resolved yet.
    });
    if (batch.status !== 'complete' && inventionBatchSuccesses(batch) >= batch.targetBPCs) {
      batch.status = 'complete';
    }
  });

  saveInventionQueue(queue);
  renderInventionQueue();

  if (!silent && typeof window.showToast === 'function') {
    if (newlyMatched || newlyImported || newlyResolved) {
      const parts = [];
      if (newlyMatched) parts.push(`${newlyMatched} job${newlyMatched > 1 ? 's' : ''} matched to queued plans`);
      if (newlyImported) parts.push(`${newlyImported} unplanned invention job${newlyImported > 1 ? 's' : ''} detected`);
      if (newlyResolved) parts.push(`${newlyResolved} job${newlyResolved > 1 ? 's' : ''} resolved`);
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

// --- Live "time remaining" ticker for in-progress attempts, same pattern js/ledger.js's own
// updateJobTimers uses (a shared 1s interval touching only .inv-job-timer elements' text, not a
// full re-render). ---
function updateInventionJobTimers() {
  document.querySelectorAll('.inv-job-timer').forEach(el => {
    const endMs = parseInt(el.dataset.endMs);
    if (!endMs) return;
    const remaining = (endMs - Date.now()) / 1000;
    if (remaining <= 0) {
      el.textContent = 'Ready to deliver';
      el.style.color = 'var(--accent)';
    } else {
      el.textContent = `${window.formatDurationCompact(remaining)} remaining`;
      el.style.color = 'var(--blue-300)';
    }
  });
}
if (!window._inventionJobTimerIntervalStarted) {
  window._inventionJobTimerIntervalStarted = true;
  setInterval(updateInventionJobTimers, 1000);
}

// --- Rendering ---

function renderInventionQueueBatchCard(batch) {
  const successes = inventionBatchSuccesses(batch);
  const runsDone = inventionBatchRunsDone(batch);
  const failedRuns = batch.attempts.reduce((sum, a) => sum + (a.status === 'resolved' ? Math.max(0, (a.runs || 1) - (a.successfulRuns || 0)) : 0), 0);
  const decLabel = batch.decryptorName || 'Unknown decryptor (detected in-game)';
  const bestResult = inventionBatchBestResult(batch);
  const resultLabel = bestResult
    ? `${bestResult.runs} run${bestResult.runs > 1 ? 's' : ''}/BPC, ME${bestResult.me >= 0 ? '+' : ''}${bestResult.me}/TE${bestResult.te >= 0 ? '+' : ''}${bestResult.te}${bestResult.isReal ? ' (confirmed)' : ' (planned)'}`
    : 'ME/TE unknown';
  const canSendToCalc = successes > 0 && batch.t2BlueprintTypeId && bestResult;
  const disp = inventionBatchDisplayStatus(batch);
  const badgeHTML = `<span class="lp-badge" style="background:${disp.badgeBg};color:${disp.badgeColor};">${disp.icon ? window.svgIcon(disp.icon) + ' ' : ''}${disp.label}</span>`;

  // How many MORE runs the original plan estimated you'd still need to start in-game, netted
  // against what's already been run - the single most actionable number on this card (go start
  // this many runs in the Industry window), so it gets its own prominent stat block, not a clause
  // buried in a sentence. null when there's nothing to estimate from (auto-imported, decryptor
  // never confirmed).
  const runsNeeded = inventionBatchRunsNeeded(batch);
  const runsNeededHTML = `
    <div class="flex-shrink-0 text-center px-3" title="${runsNeeded !== null ? 'How many more invention runs to start in-game to stay on track for this plan\'s target.' : 'No plan to estimate from - this batch was detected from a real job, not queued from a decryptor comparison.'}">
      <div class="font-bold mono" style="color:${runsNeeded ? 'var(--accent)' : 'var(--text-mute)'}; font-size:22px; line-height:1;">${runsNeeded !== null ? runsNeeded : '—'}</div>
      <div class="text-[8px] font-bold uppercase tracking-wide mt-0.5" style="color:var(--text-mute);">Runs Needed</div>
    </div>
  `;

  // In-progress runs each carry their own end_date (several jobs can run in parallel across job
  // slots) - show the soonest, with a count if more than one is running.
  const inProgressAttempts = batch.attempts.filter(a => a.status === 'in_progress' && a.endDate);
  let timerHTML = '';
  if (inProgressAttempts.length > 0) {
    const soonest = inProgressAttempts.reduce((a, b) => new Date(a.endDate).getTime() < new Date(b.endDate).getTime() ? a : b);
    const endMs = new Date(soonest.endDate).getTime();
    const extra = inProgressAttempts.length > 1 ? ` (+${inProgressAttempts.length - 1} more running)` : '';
    timerHTML = `<div class="inv-job-timer text-[11px] font-bold mono" data-end-ms="${endMs}" style="color:var(--blue-300);">${window.formatDurationCompact(Math.max(0, (endMs - Date.now()) / 1000))} remaining</div><div class="text-[10px]" style="color:var(--text-mute);">${extra}</div>`;
  }

  // Manual log defaults to however many runs the plan still expects (falls back to 1 with no plan
  // to go on) - so logging a batch you just ran in-game doesn't need retyping that number.
  const manualDefaultRuns = runsNeeded !== null && runsNeeded > 0 ? runsNeeded : 1;

  return `
    <div class="lp-inset p-3" style="border-left:3px solid ${disp.border}; ${disp.key === 'needs_more' ? 'background:rgba(221,107,100,0.05);' : ''}">
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-2 min-w-0 flex-1">
          <img src="https://images.evetech.net/types/${batch.t2ProductTypeId || batch.t2BlueprintTypeId}/icon?size=32" alt="" class="w-8 h-8 rounded flex-shrink-0" loading="lazy" onerror="this.style.visibility='hidden'">
          <div class="min-w-0">
            <div class="font-bold truncate text-sm" style="color:var(--text);">${window.esc(batch.t2ProductName)}${batch.autoImported ? ' <span class="text-[9px] font-normal" style="color:var(--text-mute);">(detected, not planned)</span>' : ''}</div>
            <div class="text-[10px] mono truncate" style="color:var(--text-mute);">${window.esc(decLabel)} &middot; target ${batch.targetBPCs} BPC${batch.targetBPCs > 1 ? 's' : ''} &middot; ${window.esc(resultLabel)}</div>
          </div>
        </div>
        ${runsNeededHTML}
        <div class="flex-shrink-0 text-right">${badgeHTML}${timerHTML}</div>
      </div>
      <div class="mt-2 flex items-center justify-between gap-2 text-xs mono flex-wrap">
        <span style="color:var(--text-mute);">${successes}/${batch.targetBPCs} successful BPCs &middot; ${runsDone} run${runsDone !== 1 ? 's' : ''} done${failedRuns ? ` (${failedRuns} failed)` : ''}</span>
        <div class="flex items-center gap-1.5">
          <button onclick="sendInventionQueueBatchToCalculator('${batch.id}')" class="lp-chip-btn" style="padding:4px 7px;" ${canSendToCalc ? '' : 'disabled'} title="${canSendToCalc ? (bestResult.isReal ? 'Open the resulting BPC in the Calculator, using its CONFIRMED real ME/TE/runs read from your blueprint list' : 'Open the resulting BPC in the Calculator, using the PLANNED ME/TE/runs (no confirmed real result matched yet)') : 'No confirmed success with known ME/TE yet'}">${window.svgIcon('trending')}</button>
          <button onclick="abandonInventionQueueBatch('${batch.id}')" class="lp-chip-btn" style="padding:4px 7px;" title="Remove from queue">${window.svgIcon('x')}</button>
        </div>
      </div>
      <div class="mt-2 pt-2 flex items-center gap-1.5 text-[11px]" style="border-top:1px solid rgba(255,255,255,0.06);">
        <span style="color:var(--text-mute);" title="EVE only reports an invention job's outcome as one final tally (runs started, how many succeeded) once it completes - never per-run - so this logs a batch, not a single click.">Log result:</span>
        <input type="number" id="inv-manual-runs-${batch.id}" min="1" value="${manualDefaultRuns}" placeholder="Runs" class="fo-num" style="width:3.4em;padding:3px 5px;">
        <span style="color:var(--text-mute);">runs,</span>
        <input type="number" id="inv-manual-success-${batch.id}" min="0" value="0" placeholder="Successes" class="fo-num" style="width:3.4em;padding:3px 5px;">
        <span style="color:var(--text-mute);">succeeded</span>
        <button onclick="manualLogInventionRuns('${batch.id}')" class="lp-chip-btn" style="padding:3px 8px;">Log</button>
      </div>
    </div>
  `;
}

function renderInventionQueue() {
  const modeSwitch = document.getElementById('invention-mode-switch');
  const queueBtn = document.getElementById('invention-mode-queue-btn');
  const badge = document.getElementById('invention-queue-count-badge');
  const list = document.getElementById('invention-queue-list');
  const emptyMsg = document.getElementById('invention-queue-empty');
  if (!list) return;
  const queue = loadInventionQueue();
  const openCount = queue.filter(b => b.status !== 'complete' && b.status !== 'abandoned').length;

  if (badge) {
    if (openCount > 0) { badge.textContent = String(openCount); badge.classList.remove('hidden'); }
    else badge.classList.add('hidden');
  }
  // The mode switch bar is otherwise only revealed by a search producing Compare results
  // (js/invention.js recalculateInventionImpl) - reveal it here too so the Queue tab is reachable
  // even before you've searched anything, as long as there's something queued to show.
  if (modeSwitch && queue.length > 0) modeSwitch.classList.remove('hidden');

  if (queue.length === 0) {
    list.innerHTML = '';
    if (emptyMsg) emptyMsg.classList.remove('hidden');
    renderInventionQueueBom();
    return;
  }
  if (emptyMsg) emptyMsg.classList.add('hidden');

  // Active/planned first, complete last - so what still needs attention doesn't get buried below
  // finished batches as the queue grows.
  const sorted = [...queue].sort((a, b) => {
    const rank = s => s === 'complete' ? 2 : s === 'active' ? 0 : 1;
    return rank(a.status) - rank(b.status) || (b.addedAt || '').localeCompare(a.addedAt || '');
  });
  list.innerHTML = sorted.map(renderInventionQueueBatchCard).join('');
  renderInventionQueueBom();
}
window.renderInventionQueue = renderInventionQueue;

// --- Bill of Materials: datacores + decryptors for every OPEN batch's remaining runs, same
// Needed/Owned/To Buy shape the Calculator/Ledger's own BOM sidebars use. ---

function inventionQueueRemainingRunsNeeded(batch) {
  const successes = inventionBatchSuccesses(batch);
  const remainingBPCs = Math.max(0, batch.targetBPCs - successes);
  if (remainingBPCs === 0) return 0;
  if (!batch.successChance || batch.successChance <= 0) return null; // unknown - can't estimate (e.g. auto-imported, decryptor never confirmed)
  return Math.ceil(remainingBPCs / (batch.successChance / 100));
}

let _inventionQueueBomLines = [];
async function renderInventionQueueBom() {
  const bomCard = document.getElementById('invention-queue-bom-card');
  const bomEl = document.getElementById('invention-queue-bom');
  if (!bomCard || !bomEl) return;
  const queue = loadInventionQueue().filter(b => b.status === 'planned' || b.status === 'active');
  const openWithEstimate = queue.filter(b => inventionQueueRemainingRunsNeeded(b) !== null && inventionQueueRemainingRunsNeeded(b) > 0);
  if (openWithEstimate.length === 0) {
    bomCard.classList.add('hidden');
    return;
  }
  bomCard.classList.remove('hidden');

  const deductStock = (document.getElementById('invention-deduct-stock')?.value ?? 'true') === 'true';
  const totals = {}; // typeId -> { name, qty }
  openWithEstimate.forEach(batch => {
    const runsNeeded = inventionQueueRemainingRunsNeeded(batch);
    (batch.invMaterials || []).forEach(m => {
      const key = m.typeId;
      if (!totals[key]) totals[key] = { name: m.name, qty: 0 };
      totals[key].qty += (m.qty || 0) * runsNeeded;
    });
    if (batch.decryptorTypeId) {
      const key = batch.decryptorTypeId;
      if (!totals[key]) totals[key] = { name: batch.decryptorName, qty: 0 };
      totals[key].qty += runsNeeded;
    }
  });

  const typeIds = Object.keys(totals).map(Number);
  if (typeof window.fetchMarketPrices === 'function') await window.fetchMarketPrices(typeIds);

  let grandTotal = 0;
  const rows = typeIds.map(typeId => {
    const owned = deductStock ? (window.userStockMap[typeId] || 0) : 0;
    const netToBuy = Math.max(0, totals[typeId].qty - owned);
    const unitPrice = typeof window.getInventionInputPrice === 'function' ? window.getInventionInputPrice(typeId) : 0;
    const lineCost = netToBuy * unitPrice;
    grandTotal += lineCost;
    return { typeId, name: totals[typeId].name, needed: totals[typeId].qty, owned, netToBuy, lineCost };
  }).sort((a, b) => b.lineCost - a.lineCost);

  _inventionQueueBomLines = rows.filter(r => r.netToBuy > 0);

  const skipped = queue.length - openWithEstimate.length;
  bomEl.innerHTML = `
    <table class="lp-table text-xs mono">
      <thead><tr><th>Item</th><th class="text-right">Needed</th><th class="text-right">Owned</th><th class="text-right">To Buy</th><th class="text-right">Est. Cost</th></tr></thead>
      <tbody>
        ${rows.map(r => `
          <tr>
            <td>
              <div class="flex items-center gap-2">
                <img src="https://images.evetech.net/types/${r.typeId}/icon?size=32" alt="" class="w-5 h-5 rounded flex-shrink-0" loading="lazy" onerror="this.style.visibility='hidden'">
                <span>${window.esc(r.name)}</span>
              </div>
            </td>
            <td class="text-right" style="color:var(--text-mute);">${r.needed.toLocaleString()}</td>
            <td class="text-right" style="color:var(--text-mute);">${r.owned.toLocaleString()}</td>
            <td class="text-right font-bold" style="color:${r.netToBuy > 0 ? 'var(--text)' : 'var(--text-mute)'};">${r.netToBuy.toLocaleString()}</td>
            <td class="text-right" style="color:var(--cost);">${Math.round(r.lineCost).toLocaleString()} ISK</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    <div class="text-right font-bold text-sm mt-2" style="color:var(--cost);">Grand Total: ${Math.round(grandTotal).toLocaleString()} ISK</div>
    ${skipped > 0 ? `<p class="text-[10px] mt-1" style="color:var(--text-mute);">${skipped} queued batch${skipped > 1 ? 'es are' : ' is'} not included above (already at target, or no known success chance to estimate remaining runs from - e.g. an unplanned detected job whose decryptor was never confirmed).</p>` : ''}
  `;
}
window.renderInventionQueueBom = renderInventionQueueBom;

function copyInventionQueueBom() {
  if (_inventionQueueBomLines.length === 0) {
    if (typeof window.showToast === 'function') window.showToast('Nothing to buy - you already have enough stock for every queued batch.', 'info');
    return;
  }
  const text = _inventionQueueBomLines.map(r => `${r.name} x${r.netToBuy}`).join('\n');
  const btn = document.getElementById('invention-queue-bom-copy-btn');
  window.copyToClipboardWithFeedback(text, btn, { useInnerHTML: true });
}
window.copyInventionQueueBom = copyInventionQueueBom;
