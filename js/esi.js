'use strict';

// Local HTML Escaper Helper
function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
if (!window.esc) window.esc = esc;

// Strict ESI Adjusted Price Fetcher (STRICT CCP ADJUSTED_PRICE ONLY)
async function fetchAdjustedPrices() {
  const statusEl = document.getElementById('eiv-status-text');
  if (statusEl) statusEl.innerHTML = `EIV Prices: <span class="text-amber-400 font-bold">Fetching...</span>`;

  const targetUrl = 'https://esi.evetech.net/latest/markets/prices/?datasource=tranquility';
  const tryUrls = [
    targetUrl,
    `https://corsproxy.io/?${encodeURIComponent(targetUrl)}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`
  ];

  for (const url of tryUrls) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 12000); // 12s timeout

      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0) {
          let loadedCount = 0;
          eivCache = {};
          data.forEach(item => {
            if (item.adjusted_price !== undefined && item.adjusted_price !== null) {
              eivCache[item.type_id] = parseFloat(item.adjusted_price);
              loadedCount++;
            }
          });
          
          if (statusEl) statusEl.innerHTML = `EIV Prices: <span class="text-green-400 font-bold">Loaded (${loadedCount.toLocaleString()})</span>`;
          
          if (recipeTreeRoot) {
            recalculate();
          }
          return;
        }
      }
    } catch (e) {
      console.warn('ESI price fetch attempt failed for ' + url, e);
    }
  }

  if (statusEl) statusEl.innerHTML = `EIV Prices: <span class="text-red-400 font-bold">ESI Offline</span>`;
}

function getEIV(typeId) {
  if (eivCache[typeId] !== undefined && eivCache[typeId] !== null) {
    return eivCache[typeId];
  }
  return 0; // CCP Rule: Unlisted items contribute 0 ISK to job EIV
}

function calculateNodeEIV(node) {
  if (!node) return;

  if (node.recipe && node.recipe.materials && node.recipe.materials.length > 0) {
    let baseRunEIV = 0;
    node.recipe.materials.forEach(m => {
      const matUnitEIV = getEIV(m.typeId);
      baseRunEIV += matUnitEIV * m.baseQty;
    });

    const batchYield = node.batchYield || 1;
    node.unitEIV = baseRunEIV / batchYield;
    node.jobEIV = baseRunEIV * node.runsNeeded;
  } else {
    node.unitEIV = getEIV(node.displayTypeId || node.typeId);
    node.jobEIV = node.unitEIV * node.qtyNeeded;
  }

  if (node.children && node.children.length > 0) {
    node.children.forEach(child => calculateNodeEIV(child));
  }
}

// --- EVE ESI SSO LOGIN & ASSETS (PKCE FLOW) ---
function generateRandomString(length) {
  const array = new Uint8Array(length);
  window.crypto.getRandomValues(array);
  return Array.from(array, byte => ('0' + (byte & 0xFF).toString(16)).slice(-2)).join('');
}

async function sha256(plain) {
  const encoder = new TextEncoder();
  const data = encoder.encode(plain);
  return window.crypto.subtle.digest('SHA-256', data);
}

function base64urlEncode(a) {
  let str = "";
  const bytes = new Uint8Array(a);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    str += String.fromCharCode(bytes[i]);
  }
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function startEsiSSOLogin() {
  const clientId = HARDCODED_CLIENT_ID;

  const verifier = generateRandomString(32);
  sessionStorage.setItem('esi_code_verifier', verifier);

  const hashed = await sha256(verifier);
  const challenge = base64urlEncode(hashed);

  const redirectUri = window.location.origin + window.location.pathname;
  const scope = 'esi-assets.read_assets.v1 esi-assets.read_corporation_assets.v1';
  const state = generateRandomString(16);
  sessionStorage.setItem('esi_auth_state', state);

  const authUrl = `https://login.eveonline.com/v2/oauth/authorize/?response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&client_id=${encodeURIComponent(clientId)}&scope=${encodeURIComponent(scope)}&code_challenge=${challenge}&code_challenge_method=S256&state=${state}`;

  window.location.href = authUrl;
}

async function handleEsiSSOCallback() {
  const urlParams = new URLSearchParams(window.location.search);
  const code = urlParams.get('code');
  if (!code) {
    const charName = localStorage.getItem('esi_char_name');
    const charId = localStorage.getItem('esi_char_id');
    const token = localStorage.getItem('esi_access_token');
    if (charName && charId && token) {
      updateEsiUserUI(charName, charId);
      fetchUserAndCorpAssets(charId, token);
    }
    return;
  }

  const verifier = sessionStorage.getItem('esi_code_verifier');
  const clientId = HARDCODED_CLIENT_ID;

  if (!verifier) return;

  window.history.replaceState({}, document.title, window.location.pathname);

  try {
    const redirectUri = window.location.origin + window.location.pathname;
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code: code,
      code_verifier: verifier,
      redirect_uri: redirectUri
    });

    const res = await fetch('https://login.eveonline.com/v2/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body
    });

    if (res.ok) {
      const tokenData = await res.json();
      const accessToken = tokenData.access_token;
      
      const jwtPayload = JSON.parse(atob(accessToken.split('.')[1]));
      const charId = jwtPayload.sub.split(':')[2];
      const charName = jwtPayload.name;

      localStorage.setItem('esi_access_token', accessToken);
      localStorage.setItem('esi_char_id', charId);
      localStorage.setItem('esi_char_name', charName);

      updateEsiUserUI(charName, charId);
      await fetchUserAndCorpAssets(charId, accessToken);
    }
  } catch (err) {
    console.error('ESI SSO Token Error:', err);
  }
}

function updateEsiUserUI(charName, charId) {
  const container = document.getElementById('esi-login-container');
  const safeName = esc(charName);
  if (container) {
    container.innerHTML = `
      <div class="flex items-center space-x-2 text-xs mono bg-[#0d1922] px-3 py-1.5 rounded-md border border-cyan-500/50 shadow">
        <img src="https://images.evetech.net/characters/${charId}/portrait?size=32" class="w-5 h-5 rounded-full border border-cyan-400">
        <span class="text-cyan-300 font-bold">${safeName}</span>
        <button onclick="logoutEsiSSO()" class="text-slate-400 hover:text-red-400 font-bold ml-1.5" title="Log out ESI Character">✖</button>
      </div>
    `;
  }
}

function logoutEsiSSO() {
  localStorage.removeItem('esi_access_token');
  localStorage.removeItem('esi_char_id');
  localStorage.removeItem('esi_char_name');
  rawAssetItems = [];
  userStockMap = {};
  const container = document.getElementById('esi-login-container');
  if (container) {
    container.innerHTML = `
      <button onclick="startEsiSSOLogin()" class="px-4 py-2 bg-cyan-700 hover:bg-cyan-600 text-white font-bold rounded-md transition flex items-center gap-2 shadow text-xs" title="Login with EVE Online to import your character assets">
        🔐 EVE SSO Login
      </button>
    `;
  }
  updateStockDisplayCount();
  populateLocationDropdown();
  recalculate();
}

async function fetchUserAndCorpAssets(charId, accessToken) {
  try {
    rawAssetItems = [];

    let corpId = null;
    const charRes = await fetch(`https://esi.evetech.net/latest/characters/${charId}/?datasource=tranquility`);
    if (charRes.ok) {
      const charData = await charRes.json();
      corpId = charData.corporation_id;
    }

    let page = 1;
    let hasMore = true;
    while (hasMore) {
      const res = await fetch(`https://esi.evetech.net/latest/characters/${charId}/assets/?datasource=tranquility&page=${page}`, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });

      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0) {
          data.forEach(ast => {
            if (ast.type_id && ast.quantity) {
              rawAssetItems.push({
                type_id: ast.type_id,
                quantity: ast.quantity,
                location_id: ast.location_id,
                owner_type: 'char'
              });
            }
          });
          page++;
        } else {
          hasMore = false;
        }
      } else {
        hasMore = false;
      }
    }

    if (corpId) {
      page = 1;
      hasMore = true;
      while (hasMore) {
        const res = await fetch(`https://esi.evetech.net/latest/corporations/${corpId}/assets/?datasource=tranquility&page=${page}`, {
          headers: { 'Authorization': `Bearer ${accessToken}` }
        });

        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data) && data.length > 0) {
            data.forEach(ast => {
              if (ast.type_id && ast.quantity) {
                rawAssetItems.push({
                  type_id: ast.type_id,
                  quantity: ast.quantity,
                  location_id: ast.location_id,
                  owner_type: 'corp'
                });
              }
            });
            page++;
          } else {
            hasMore = false;
          }
        } else {
          hasMore = false;
        }
      }
    }

    await resolveAndPopulateLocationFilter(accessToken);

  } catch (err) {
    console.warn('Assets fetch error:', err);
  }
}

async function resolveAndPopulateLocationFilter(accessToken = null) {
  const uniqueLocIds = Array.from(new Set(rawAssetItems.map(a => a.location_id).filter(id => id && id !== 99999999)));
  
  if (uniqueLocIds.length > 0) {
    const missingIds = uniqueLocIds.filter(id => !resolvedLocationNames[id]);

    // 1. Batch POST /universe/names/ for all unresolved location IDs
    if (missingIds.length > 0) {
      const chunks = [];
      for (let i = 0; i < missingIds.length; i += 500) {
        chunks.push(missingIds.slice(i, i + 500));
      }

      for (const chunk of chunks) {
        try {
          const res = await fetch('https://esi.evetech.net/latest/universe/names/?datasource=tranquility', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(chunk)
          });

          if (res.ok) {
            const nameData = await res.json();
            if (Array.isArray(nameData)) {
              nameData.forEach(item => {
                resolvedLocationNames[item.id] = item.name.toUpperCase();
              });
            }
          }
        } catch (e) {}
      }
    }

    // 2. Resolve Upwell Structure IDs (> 1,000,000,000,000) not resolved by universe/names
    const token = accessToken || localStorage.getItem('esi_access_token');
    const unresolvedStructureIds = uniqueLocIds.filter(id => id > 1000000000000 && !resolvedLocationNames[id]);
    
    if (unresolvedStructureIds.length > 0 && token) {
      await Promise.all(unresolvedStructureIds.map(async (structId) => {
        try {
          const res = await fetch(`https://esi.evetech.net/latest/universe/structures/${structId}/?datasource=tranquility`, {
            headers: { 'Authorization': `Bearer ${token}` }
          });

          if (res.ok) {
            const structData = await res.json();
            if (structData && structData.name) {
              resolvedLocationNames[structId] = structData.name.toUpperCase();
            }
          } else if (res.status === 403) {
            resolvedLocationNames[structId] = `UPWELL STRUCTURE (${structId.toString().slice(-6)}) [NO ACL DOCK ACCESS]`;
          }
        } catch (e) {}
      }));
    }
  }

  // 3. Fallback assignments for remaining unmapped IDs
  rawAssetItems.forEach(item => {
    const id = item.location_id;
    if (!resolvedLocationNames[id]) {
      if (id === 99999999) {
        resolvedLocationNames[id] = 'CLIPBOARD / MANUAL IMPORT';
      } else if (systemNameCache[id]) {
        resolvedLocationNames[id] = systemNameCache[id];
      } else if (id >= 30000000 && id < 34000000) {
        resolvedLocationNames[id] = `SOLAR SYSTEM #${id}`;
      } else if (id >= 60000000 && id < 64000000) {
        resolvedLocationNames[id] = `NPC STATION #${id}`;
      } else if (id > 1000000000000) {
        resolvedLocationNames[id] = `UPWELL STRUCTURE (${id.toString().slice(-6)})`;
      } else {
        resolvedLocationNames[id] = `CONTAINER / HANGAR #${id}`;
      }
    }
  });

  populateLocationDropdown();
  applyStockLocationFilter();
}

function populateLocationDropdown() {
  const filterSelect = document.getElementById('stock-location-filter');
  if (!filterSelect) return;

  const currentSystemName = (document.getElementById('system-search')?.value || 'JITA').toUpperCase();
  const currentValue = filterSelect.value || 'all';

  filterSelect.innerHTML = `
    <option value="all">All Locations (Combined Assets)</option>
    <option value="industry_system">Current System Only (${currentSystemName})</option>
  `;

  const locCounts = {};
  rawAssetItems.forEach(item => {
    const locId = item.location_id;
    const locName = resolvedLocationNames[locId] || `Location #${locId}`;
    if (!locCounts[locId]) {
      locCounts[locId] = {
        name: locName,
        count: 0
      };
    }
    locCounts[locId].count += item.quantity;
  });

  for (const [locId, data] of Object.entries(locCounts)) {
    const opt = document.createElement('option');
    opt.value = `loc_${locId}`;
    opt.textContent = `${data.name} (${data.count.toLocaleString()} items)`;
    filterSelect.appendChild(opt);
  }

  if (filterSelect.querySelector(`option[value="${currentValue}"]`)) {
    filterSelect.value = currentValue;
  } else {
    filterSelect.value = 'all';
  }
}

function filterLocationDropdownOptions() {
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
      feedbackBadge.textContent = `Found: ${visibleCount} location(s)`;
      feedbackBadge.classList.remove('hidden');
    } else {
      feedbackBadge.textContent = '';
      feedbackBadge.classList.add('hidden');
    }
  }
}

function updateStockDisplayCount() {
  const el = document.getElementById('stock-count-display');
  if (!el) return;
  const totalItems = Object.values(userStockMap).reduce((acc, q) => acc + q, 0);
  el.textContent = `${totalItems.toLocaleString()} items`;
}

function applyStockLocationFilter() {
  const filterVal = document.getElementById('stock-location-filter')?.value || 'all';
  const activeSystemName = (document.getElementById('system-search')?.value || 'JITA').toUpperCase();

  const useChar = document.getElementById('use-char-assets')?.checked ?? true;
  const useCorp = document.getElementById('use-corp-assets')?.checked ?? true;

  userStockMap = {};

  rawAssetItems.forEach(item => {
    if (item.owner_type === 'char' && !useChar) return;
    if (item.owner_type === 'corp' && !useCorp) return;

    let include = false;
    const itemLocName = resolvedLocationNames[item.location_id] || '';

    if (filterVal === 'all') {
      include = true;
    } else if (filterVal === 'industry_system') {
      include = itemLocName.includes(activeSystemName);
    } else if (filterVal.startsWith('loc_')) {
      const targetLocId = parseInt(filterVal.replace('loc_', ''));
      include = item.location_id === targetLocId;
    }

    if (include) {
      userStockMap[item.type_id] = (userStockMap[item.type_id] || 0) + item.quantity;
    }
  });

  updateStockDisplayCount();
  recalculate();
}

function openPasteModal() {
  const modal = document.getElementById('paste-modal');
  if (modal) modal.classList.remove('hidden');
}

function closePasteModal() {
  const modal = document.getElementById('paste-modal');
  if (modal) modal.classList.add('hidden');
}

function clearUserStock() {
  rawAssetItems = rawAssetItems.filter(item => item.location_id !== 99999999);
  userStockMap = {};
  updateStockDisplayCount();
  populateLocationDropdown();
  recalculate();
  closePasteModal();
}

function processPastedStock() {
  const input = document.getElementById('paste-stock-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;

  const lines = text.split('\n');

  lines.forEach(line => {
    const trimmed = line.trim();
    if (!trimmed) return;

    const parts = trimmed.split('\t');
    let nameCandidate = '';
    let qtyCandidate = 1;

    if (parts.length >= 2) {
      nameCandidate = parts[0].trim();
      const cleanedQty = parts[1].replace(/,/g, '').replace(/\./g, '').trim();
      const parsedQty = parseInt(cleanedQty, 10);
      if (!isNaN(parsedQty) && parsedQty > 0) {
        qtyCandidate = parsedQty;
      }
    } else {
      const match = trimmed.match(/^(.+?)\s+([0-9,.]+)\s*$/);
      if (match) {
        nameCandidate = match[1].trim();
        const parsedQty = parseInt(match[2].replace(/,/g, '').replace(/\./g, ''), 10);
        if (!isNaN(parsedQty) && parsedQty > 0) {
          qtyCandidate = parsedQty;
        }
      } else {
        nameCandidate = trimmed;
      }
    }

    if (nameCandidate) {
      const q = nameCandidate.toLowerCase();
      let matchedItem = IDX[q];
      if (!matchedItem && window.EVE_ITEMS) {
        for (const [idStr, name] of Object.entries(window.EVE_ITEMS)) {
          if (name.toLowerCase() === q) {
            matchedItem = { id: parseInt(idStr), name: name };
            break;
          }
        }
      }

      if (matchedItem) {
        rawAssetItems.push({
          type_id: matchedItem.id,
          quantity: qtyCandidate,
          location_id: 99999999,
          owner_type: 'char'
        });
      }
    }
  });

  resolvedLocationNames[99999999] = 'CLIPBOARD / MANUAL IMPORT';
  input.value = '';
  closePasteModal();
  populateLocationDropdown();
  applyStockLocationFilter();
}

async function selectSolarSystem(systemId, systemName) {
  const searchInputEl = document.getElementById('system-search');
  if (searchInputEl) searchInputEl.value = systemName.toUpperCase();
  
  const resultsEl = document.getElementById('system-results');
  if (resultsEl) resultsEl.classList.add('hidden');
  
  try {
    localStorage.setItem('eve_selected_system', JSON.stringify({ id: systemId, name: systemName.toUpperCase() }));
  } catch (e) {}
  await fetchSystemSCIById(systemId, systemName);
}

async function loadSavedSystem() {
  try {
    const saved = localStorage.getItem('eve_selected_system');
    if (saved) {
      const obj = JSON.parse(saved);
      if (obj && obj.id && obj.name) {
        const searchInputEl = document.getElementById('system-search');
        if (searchInputEl) searchInputEl.value = obj.name.toUpperCase();
        await fetchSystemSCIById(obj.id, obj.name);
        return;
      }
    }
  } catch (e) {}
  await resolveSystemSCI('JITA');
}

async function resolveSystemSCI(systemName) {
  if (!systemName || systemName.trim().length < 2) return;
  const q = systemName.trim().toLowerCase();
  if (SYSTEM_IDX[q]) {
    await selectSolarSystem(SYSTEM_IDX[q].id, SYSTEM_IDX[q].name);
  } else {
    const matches = await fetchEsiSystemSearch(q);
    if (matches && matches.length > 0) {
      await selectSolarSystem(matches[0].id, matches[0].name);
    }
  }
}

async function fetchSystemSCIById(systemId, systemName) {
  try {
    const sysRes = await fetch(`https://esi.evetech.net/latest/industry/systems/?datasource=tranquility`);
    if (!sysRes.ok) return;
    const sysData = await sysRes.json();

    const sysEntry = sysData.find(s => s.solar_system_id === systemId);
    let mfgSCI = 0.01, reactSCI = 0.01;

    if (sysEntry && sysEntry.cost_indices) {
      sysEntry.cost_indices.forEach(ci => {
        if (ci.activity === 'manufacturing') mfgSCI = ci.cost_index;
        if (ci.activity === 'reaction') reactSCI = ci.cost_index;
      });
    }

    activeMfgSCI = mfgSCI;
    activeReactSCI = reactSCI;

    const sciBadgeEl = document.getElementById('sci-badge');
    if (sciBadgeEl) {
      sciBadgeEl.textContent = 
        `System: ${systemName.toUpperCase()} | SCI: ${(mfgSCI * 100).toFixed(2)}% (Mfg) / ${(reactSCI * 100).toFixed(2)}% (React)`;
    }

    recalculate();
  } catch (err) {
    console.warn('System SCI fetch error:', err);
  }
}

async function fetchMarketPrices(typeIds) {
  const missing = typeIds.filter(id => !priceCache[id]);
  if (!missing.length) return;

  const chunks = [];
  for (let i = 0; i < missing.length; i += 30) {
    chunks.push(missing.slice(i, i + 30));
  }

  await Promise.all(chunks.map(async (chunk) => {
    const targetUrl = `https://market.fuzzwork.co.uk/aggregates/?station=60003760&types=${chunk.join(',')}`;
    const tryUrls = [
      targetUrl,
      `https://corsproxy.io/?${encodeURIComponent(targetUrl)}`
    ];

    for (const url of tryUrls) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2000);

        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);

        if (res.ok) {
          const data = await res.json();
          if (data && typeof data === 'object') {
            let foundPrices = false;
            for (const id of chunk) {
              const entry = data[String(id)];
              if (entry && (entry.sell || entry.buy)) {
                priceCache[id] = {
                  sell: entry.sell ? parseFloat(entry.sell.min) || 0 : 0,
                  buy: entry.buy ? parseFloat(entry.buy.max) || 0 : 0
                };
                foundPrices = true;
              }
            }
            if (foundPrices) break;
          }
        }
      } catch (err) {
        // Try next
      }
    }

    chunk.forEach(id => {
      if (!priceCache[id] || (!priceCache[id].sell && !priceCache[id].buy)) {
        const eivVal = getEIV(id);
        priceCache[id] = { sell: eivVal, buy: eivVal * 0.9 };
      }
    });
  }));
}