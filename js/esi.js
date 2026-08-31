'use strict';

// Decodes unpadded Base64URL JWT payloads securely
function decodeJwt(token) {
  try {
    if (!token) return null;
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const base64Url = parts[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const pad = base64.length % 4;
    const paddedBase64 = pad ? base64 + '='.repeat(4 - pad) : base64;
    return JSON.parse(atob(paddedBase64));
  } catch (e) {
    console.error('JWT Decode failed:', e);
    return null;
  }
}

// Fast O(1) Helper to look up exact item type name
function getItemTypeName(typeId) {
  if (!typeId) return '';
  if (window.TYPE_ID_TO_NAME && window.TYPE_ID_TO_NAME[typeId]) {
    return window.TYPE_ID_TO_NAME[typeId];
  }
  if (window.EVE_ITEMS && window.EVE_ITEMS[typeId]) {
    return window.EVE_ITEMS[typeId];
  }
  return '';
}

// Detects if an asset location flag belongs to ship slots or cargo
function isShipLocationFlag(flag) {
  if (!flag) return false;
  const f = flag.toLowerCase();
  return f.includes('cargo') || f.includes('dronebay') || f.includes('shiphangar') || 
         f.includes('fleethangar') || f.includes('subsystem') || f.includes('fighter') || 
         f.includes('highslot') || f.includes('medslot') || f.includes('lowslot') || 
         f.includes('rigslot') || f.includes('specialized') || f.includes('fuelbay') ||
         f.includes('autofit') || f.includes('corpsebay');
}

// Returns true if the item is an actual inventory container
function isContainerAsset(typeId) {
  const typeName = getItemTypeName(typeId);
  if (!typeName) return false;
  const t = typeName.toLowerCase();
  const isContainer = t.includes('container') || t.includes('canister') || t.includes('vault') || 
                      t.includes('freight') || t.includes('plastic wrap') || t.includes('audit log') || 
                      t.includes('box') || t.includes('crate') || t.includes('chest') || t.includes('can') ||
                      t.includes('hangar array') || t.includes('silo') || t.includes('storage') || t.includes('depot');
  const isShip = t.includes('frigate') || t.includes('destroyer') || t.includes('cruiser') ||
                 t.includes('battlecruiser') || t.includes('battleship') || t.includes('dreadnought') ||
                 t.includes('carrier') || t.includes('titan') || t.includes('corvette') ||
                 t.includes('industrial') || t.includes('freighter') || t.includes('barge') ||
                 t.includes('exhumer') || t.includes('shuttle') || t.includes('interdictor') ||
                 t.includes('covert ops') || t.includes('logistics') || t.includes('ship') ||
                 t.includes('transport') || t.includes('ibis') || t.includes('reaper') ||
                 t.includes('velator') || t.includes('impairor') || t.includes('taipan') ||
                 t.includes('venture') || t.includes('orca') || t.includes('rorqual');
  return isContainer && !isShip;
}

// Walks an item's location chain up through any nested containers to find its real root station/
// structure, and the first container (if any) it's sitting in - same logic already used to build
// the asset hierarchy, but reusable for anything with a location_id (e.g. a blueprint), not just
// during the asset refresh flow itself.
function resolveItemLocationHierarchy(locationId, itemIdToAssetMap) {
  let currentLoc = locationId;
  let depth = 0;
  let containerId = null;
  while (itemIdToAssetMap[currentLoc] && depth < 10) {
    const parentAsset = itemIdToAssetMap[currentLoc];
    if (isContainerAsset(parentAsset.type_id) && !containerId) {
      containerId = currentLoc;
    }
    currentLoc = parentAsset.location_id;
    depth++;
  }
  return { rootLocationId: currentLoc, containerId: containerId };
}
window.resolveItemLocationHierarchy = resolveItemLocationHierarchy;

function buildItemIdToAssetMap() {
  const map = {};
  (window.rawAssetItems || []).forEach(ast => {
    if (ast.item_id) map[ast.item_id] = ast;
  });
  return map;
}
window.buildItemIdToAssetMap = buildItemIdToAssetMap;


// Checks for Rookie Ships and all EVE ship hulls
function isShipType(typeId) {
  const rookieShipIds = new Set([
    601, 606, 608, 596, 33079, 33081, 33083, 33085,
    621, 622, 12005, 587, 24698, 644, 642, 643, 12015, 11987, 11989
  ]);
  if (typeId && rookieShipIds.has(typeId)) return true;
  const typeName = getItemTypeName(typeId);
  if (!typeName) return false;
  const t = typeName.toLowerCase();
  if (isContainerAsset(typeId)) return false;
  const shipTerms = [
    'frigate', 'destroyer', 'cruiser', 'battlecruiser', 'battleship', 'dreadnought',
    'carrier', 'supercarrier', 'titan', 'corvette', 'industrial', 'freighter',
    'mining barge', 'exhumer', 'shuttle', 'interdictor', 'covert ops', 'stealth bomber',
    'logistics', 'assault', 'recon', 'command ship', 'heavy assault', 'blockade runner',
    'deep space', 'jump freighter', 'tactical destroyer', 'strategic cruiser',
    'ibis', 'reaper', 'velator', 'impairor', 'taipan', 'hematite', 'violator', 'echo',
    'venture', 'procurer', 'retriever', 'covetor', 'orca', 'rorqual', 'bowhead',
    'heron', 'magnate', 'imicus', 'probe', 'condor', 'slicer', 'executioner', 'tormentor',
    'punisher', 'kestrel', 'merlin', 'tristan', 'inquisitor', 'navitas', 'bantam', 'ship'
  ];
  return shipTerms.some(term => t.includes(term));
}

// Unified fetch wrapper that validates active login sessions and handles auth decay.
// suppressLogout: for auxiliary/non-essential calls (corp division names, corp assets, skills) whose
// failure (missing scope, missing corp role, etc.) is a normal, expected outcome for many characters
// and must never be treated as "the whole session is invalid."
async function fetchWithAuth(url, options = {}, token, suppressLogout = false) {
  if (!options.headers) options.headers = {};
  options.headers['Authorization'] = `Bearer ${token}`;
  try {
    let res = await fetch(url, options);
    if (res.status === 401) {
      // The access token may have simply expired since it was handed to this function - try one
      // silent refresh-and-retry before giving up, instead of immediately logging the character out.
      const refreshed = await refreshEsiAccessToken();
      if (refreshed) {
        options.headers['Authorization'] = `Bearer ${refreshed}`;
        res = await fetch(url, options);
      }
      if (res.status === 401) {
        if (suppressLogout) {
          console.warn("Auxiliary ESI call unauthorized (401/missing scope) - skipping without logging out:", url);
          return null;
        }
        console.warn("SSO Token expired or unauthorized (401), and refresh failed. Executing clean logout.");
        logoutEsiSSO();
        return null;
      }
    }
    return res;
  } catch (err) {
    console.error("fetchWithAuth network error for URL:", url, err);
    throw err;
  }
}

// Exchanges the stored refresh_token for a new access token. EVE SSO access tokens expire in
// ~20 minutes; without this, any reload or long session inevitably hits a 401 and gets logged out.
async function refreshEsiAccessToken() {
  const refreshToken = localStorage.getItem('esi_refresh_token');
  if (!refreshToken) return null;
  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: window.HARDCODED_CLIENT_ID,
      refresh_token: refreshToken
    });
    const res = await fetch('https://login.eveonline.com/v2/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body
    });
    if (!res.ok) return null;
    const tokenData = await res.json();
    if (!tokenData.access_token) return null;
    const expiresAt = Date.now() + ((parseInt(tokenData.expires_in) || 1200) * 1000);
    localStorage.setItem('esi_access_token', tokenData.access_token);
    localStorage.setItem('esi_token_expiry', String(expiresAt));
    if (tokenData.refresh_token) localStorage.setItem('esi_refresh_token', tokenData.refresh_token);
    return tokenData.access_token;
  } catch (err) {
    console.warn('ESI token refresh failed:', err);
    return null;
  }
}

// Strict ESI Adjusted Price Fetcher
async function fetchAdjustedPrices() {
  const statusEl = document.getElementById('eiv-status-text');
  if (statusEl) statusEl.innerHTML = `EIV Prices: <span class="text-amber-400 font-bold">Fetching...</span>`;
  const targetUrl = 'https://esi.evetech.net/latest/markets/prices/?datasource=tranquility';
  const tryUrls = [targetUrl, `https://corsproxy.io/?${encodeURIComponent(targetUrl)}`];
  for (const url of tryUrls) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);
      if (res.ok) {
        let data = await res.json();
        if (data && data.contents && typeof data.contents === 'string') {
          try { data = JSON.parse(data.contents); } catch(e){}
        }
        if (Array.isArray(data) && data.length > 0) {
          let loadedCount = 0;
          window.eivCache = {};
          data.forEach(item => {
            if (item.adjusted_price !== undefined && item.adjusted_price !== null) {
              window.eivCache[item.type_id] = parseFloat(item.adjusted_price);
              loadedCount++;
            }
          });
          if (statusEl) statusEl.innerHTML = `EIV Prices: <span class="text-green-400 font-bold">Loaded (${loadedCount.toLocaleString()})</span>`;
          if (window.recipeTreeRoot && typeof recalculate === 'function') {
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
  if (window.eivCache && window.eivCache[typeId] !== undefined && window.eivCache[typeId] !== null) {
    return window.eivCache[typeId];
  }
  return 0;
}

function calculateNodeEIV(node) {
  if (!node) return;
  if (node.recipe && node.recipe.materials && node.recipe.materials.length > 0) {
    let baseRunEIV = 0;
    node.recipe.materials.forEach(m => {
      baseRunEIV += getEIV(m.typeId) * m.baseQty;
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

// Safely generate a folder-normalized absolute redirect URI
function getCleanRedirectUri() {
  const hostname = window.location.hostname.toLowerCase();
  if (hostname === 'sublimerage.github.io') {
    return 'https://sublimerage.github.io/Eve-BP-Calculator/';
  }
  let pathname = window.location.pathname;
  if (pathname.endsWith('.html')) {
    pathname = pathname.substring(0, pathname.lastIndexOf('/') + 1);
  } else if (!pathname.endsWith('/')) {
    pathname += '/';
  }
  return window.location.origin + pathname;
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
  const clientId = window.HARDCODED_CLIENT_ID;
  const verifier = generateRandomString(32);
  localStorage.setItem('esi_code_verifier', verifier);
  const hashed = await sha256(verifier);
  const challenge = base64urlEncode(hashed);
  const redirectUri = getCleanRedirectUri();
  // "invalid_request: redirect URL does not match" comes directly from login.eveonline.com and means
  // this exact string isn't registered as a Callback URL on the app's EVE Developer Application page
  // (https://developers.eveonline.com) for this Client ID. Log it so it can be copied verbatim -
  // including the trailing slash, which EVE matches exactly.
  console.info(`[EVE SSO] Sending redirect_uri: "${redirectUri}" - this exact string must be registered as a Callback URL for Client ID ${clientId} at https://developers.eveonline.com`);
  const scope = 'esi-assets.read_assets.v1 esi-assets.read_corporation_assets.v1 esi-universe.read_structures.v1 esi-skills.read_skills.v1 esi-corporations.read_divisions.v1 esi-industry.read_character_jobs.v1 esi-industry.read_corporation_jobs.v1 esi-characters.read_blueprints.v1 esi-corporations.read_blueprints.v1 esi-search.search_structures.v1';
  const state = generateRandomString(16);
  localStorage.setItem('esi_auth_state', state);
  const authUrl = `https://login.eveonline.com/v2/oauth/authorize/?response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&client_id=${encodeURIComponent(clientId)}&scope=${encodeURIComponent(scope)}&code_challenge=${challenge}&code_challenge_method=S256&state=${state}`;
  window.location.href = authUrl;
}

async function handleEsiSSOCallback() {
  const urlParams = new URLSearchParams(window.location.search);
  const ssoError = urlParams.get('error');
  if (ssoError) {
    // Some SSO failures (e.g. the user declining consent) do redirect back with ?error=... instead of
    // failing directly on login.eveonline.com - surface those instead of failing silently.
    const desc = decodeURIComponent((urlParams.get('error_description') || '').replace(/\+/g, ' '));
    console.error('EVE SSO Error:', ssoError, desc);
    window.history.replaceState({}, document.title, window.location.pathname);
    const statusText = document.getElementById('status-text');
    const statusDot = document.getElementById('status-dot');
    if (statusText) statusText.textContent = `EVE SSO LOGIN FAILED: ${desc || ssoError}`;
    if (statusDot) statusDot.className = 'w-2.5 h-2.5 rounded-full bg-red-500';
    return;
  }
  const code = urlParams.get('code');
  if (!code) {
    const charName = localStorage.getItem('esi_char_name');
    const charId = localStorage.getItem('esi_char_id');
    let token = localStorage.getItem('esi_access_token');
    if (charName && charId && token) {
      const expiry = parseInt(localStorage.getItem('esi_token_expiry')) || 0;
      const hasRefreshToken = !!localStorage.getItem('esi_refresh_token');
      if (hasRefreshToken && Date.now() >= expiry - 30000) {
        const refreshed = await refreshEsiAccessToken();
        if (refreshed) {
          token = refreshed;
        } else {
          // Refresh token is invalid/revoked, so the cached access token is stale too - log out
          // cleanly instead of showing a "logged in" button that will immediately fail on any call.
          logoutEsiSSO();
          return;
        }
      }
      updateEsiUserUI(charName, charId);
      await fetchUserAndCorpAssets(charId, token);
    }
    return;
  }
  const verifier = localStorage.getItem('esi_code_verifier');
  if (!verifier) return;
  window.history.replaceState({}, document.title, window.location.pathname);
  try {
    const redirectUri = getCleanRedirectUri();
    const clientId = window.HARDCODED_CLIENT_ID;
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
      const jwtPayload = decodeJwt(accessToken);
      if (jwtPayload) {
        const charId = String(jwtPayload.sub.split(':')[2]).trim();
        const charName = jwtPayload.name;
        const expiresAt = Date.now() + ((parseInt(tokenData.expires_in) || 1200) * 1000);
        localStorage.setItem('esi_access_token', accessToken);
        localStorage.setItem('esi_token_expiry', String(expiresAt));
        if (tokenData.refresh_token) localStorage.setItem('esi_refresh_token', tokenData.refresh_token);
        localStorage.setItem('esi_char_id', charId);
        localStorage.setItem('esi_char_name', charName);
        updateEsiUserUI(charName, charId);
        await fetchUserAndCorpAssets(charId, accessToken);
      }
    } else {
      console.error("SSO Code Exchange Failed:", res.status, await res.text());
      reportSsoLoginFailure(`Login failed (${res.status}). Please try again.`);
    }
  } catch (err) {
    console.error('ESI SSO Token Error:', err);
    reportSsoLoginFailure('Login failed - check your connection and try again.');
  }
}

function reportSsoLoginFailure(message) {
  const statusText = document.getElementById('status-text');
  const statusDot = document.getElementById('status-dot');
  if (statusText) statusText.textContent = 'EVE SSO LOGIN FAILED';
  if (statusDot) statusDot.className = 'w-2.5 h-2.5 rounded-full bg-red-500';
  if (typeof window.showToast === 'function') window.showToast(message, 'error');
}

function updateEsiUserUI(charName, charId, corpName, corpTicker) {
  const container = document.getElementById('esi-login-container');
  if (!container) return;
  const safeName = window.esc(charName);
  const ticker = corpTicker || localStorage.getItem('esi_corp_ticker') || '';
  const safeTicker = window.esc(ticker);
  const safeCorpName = window.esc(corpName || localStorage.getItem('esi_corp_name') || '');
  container.innerHTML = `
    <div class="pilot-badge mono" title="${safeName}${safeCorpName ? ' — ' + safeCorpName : ''}">
      <img src="https://images.evetech.net/characters/${charId}/portrait?size=128" alt="${safeName}" class="pilot-portrait" loading="lazy" onerror="this.onerror=null; this.src='https://images.evetech.net/characters/1/portrait?size=128';">
      <div class="pilot-meta">
        <span class="pilot-name">${safeName}</span>
        ${ticker ? `<span class="pilot-corp">[${safeTicker}]</span>` : ''}
      </div>
      <span class="pilot-dot"></span>
      <button onclick="logoutEsiSSO()" class="pilot-logout" title="Log out ESI Character">
        <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" style="width:12px;height:12px;"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
  `;
}

function logoutEsiSSO() {
  localStorage.removeItem('esi_access_token');
  localStorage.removeItem('esi_refresh_token');
  localStorage.removeItem('esi_token_expiry');
  localStorage.removeItem('esi_char_id');
  localStorage.removeItem('esi_char_name');
  localStorage.removeItem('esi_corp_id');
  localStorage.removeItem('esi_corp_name');
  localStorage.removeItem('esi_corp_ticker');
  localStorage.removeItem('esi_code_verifier');
  localStorage.removeItem('esi_auth_state');
  window.rawAssetItems = [];
  window.userStockMap = {};
  window.corpDivisionNames = {};
  const container = document.getElementById('esi-login-container');
  if (container) {
    container.innerHTML = `
      <button onclick="startEsiSSOLogin()" class="btn-glass btn-glass-muted px-3.5 py-2 text-xs flex items-center gap-1.5" title="Login with EVE Online to import your character assets">
        <svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;"><rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V7a4 4 0 018 0v4"/></svg>
        EVE SSO Login
      </button>
    `;
  }
  if (typeof updateStockDisplayCount === 'function') updateStockDisplayCount();
  if (typeof populateLocationDropdown === 'function') populateLocationDropdown();
  if (typeof updateJournalStockCountBadge === 'function') updateJournalStockCountBadge();
  if (typeof populateJournalLocationDropdown === 'function') populateJournalLocationDropdown();
  if (typeof recalculate === 'function') {
    recalculate();
  } else if (typeof renderJournalPage === 'function') {
    renderJournalPage();
  }
}

async function refreshLiveAssets() {
  const charId = localStorage.getItem('esi_char_id');
  const token = localStorage.getItem('esi_access_token');
  if (!charId || !token) {
    startEsiSSOLogin();
    return;
  }
  const statusText = document.getElementById('status-text');
  const statusDot = document.getElementById('status-dot');
  if (statusText) statusText.textContent = 'REFRESHING LIVE ESI ASSETS...';
  if (statusDot) statusDot.className = 'w-2.5 h-2.5 rounded-full bg-amber-400';
  window.resolvedLocationNames = {};
  window.userStockMap = {};
  const ok = await fetchUserAndCorpAssets(charId, token);
  if (statusDot) statusDot.className = `w-2.5 h-2.5 rounded-full ${ok ? 'bg-green-400' : 'bg-red-400'}`;
  if (statusText) statusText.textContent = ok ? 'ASSETS REFRESHED' : 'ASSET REFRESH FAILED';
  if (!ok && typeof window.showToast === 'function') {
    window.showToast('Failed to refresh assets - check your connection, or your login may have expired.', 'error');
  }
}

async function fetchUserAndCorpAssets(charId, accessToken) {
  let assetsFetchOk = false;
  try {
    window.rawAssetItems = [];
    let corpId = null;
    const charRes = await fetch(`https://esi.evetech.net/latest/characters/${charId}/?datasource=tranquility`);
    if (charRes.ok) {
      const charData = await charRes.json();
      corpId = charData.corporation_id;
      if (corpId) localStorage.setItem('esi_corp_id', String(corpId));
      // Public endpoint, no auth needed - just the corp name/ticker for the header's pilot badge.
      // Fired off without blocking the asset fetch below; updates the badge in place once it lands.
      if (corpId) {
        fetch(`https://esi.evetech.net/latest/corporations/${corpId}/?datasource=tranquility`)
          .then(r => r.ok ? r.json() : null)
          .then(corpData => {
            if (!corpData || !corpData.ticker) return;
            localStorage.setItem('esi_corp_name', corpData.name || '');
            localStorage.setItem('esi_corp_ticker', corpData.ticker);
            const charName = localStorage.getItem('esi_char_name');
            if (charName) updateEsiUserUI(charName, charId, corpData.name, corpData.ticker);
          })
          .catch(e => console.warn('[ESI] Corp info fetch failed:', e));
      }
    }
    if (corpId && accessToken) {
      try {
        const divRes = await fetchWithAuth(`https://esi.evetech.net/latest/corporations/${corpId}/divisions/?datasource=tranquility`, {}, accessToken, true);
        if (divRes && divRes.ok) {
          const divData = await divRes.json();
          if (divData && Array.isArray(divData.hangar)) {
            divData.hangar.forEach(d => {
              if (d.division && d.name) {
                window.corpDivisionNames[d.division] = d.name.toUpperCase();
              }
            });
          }
        }
      } catch (e) { console.warn('[ESI] Corp division names fetch failed - hangar divisions will show as generic names:', e); }
    }
    try {
      const skillsRes = await fetchWithAuth(`https://esi.evetech.net/latest/characters/${charId}/skills/?datasource=tranquility`, {}, accessToken, true);
      if (skillsRes && skillsRes.ok) {
        const skillsData = await skillsRes.json();
        if (skillsData && Array.isArray(skillsData.skills)) {
          let indLevel = 0;
          let advIndLevel = 0;
          const allSkills = {};
          skillsData.skills.forEach(sk => {
            const level = sk.active_skill_level !== undefined ? sk.active_skill_level : (sk.trained_skill_level || 0);
            allSkills[sk.skill_id] = level;
            if (sk.skill_id === 3380) indLevel = level;
            if (sk.skill_id === 3388) advIndLevel = level;
          });
          // Store the FULL skill sheet too, not just Industry/Advanced Industry - many blueprints
          // (T2, T3, faction, Triglavian) require specific science/engineering skills that ALSO grant
          // their own 1%/level manufacturing time reduction for items requiring that skill, on top of
          // the generic Industry/Advanced Industry bonuses. Matching those needs the player's actual
          // trained level in every such skill, not just the two generic ones.
          localStorage.setItem('eve_char_skills', JSON.stringify({ industry: indLevel, advIndustry: advIndLevel, allSkills: allSkills }));
        }
      }
    } catch (e) {
      console.warn('ESI Skills fetch failed:', e);
    }
    let page = 1;
    let hasMore = true;
    while (hasMore) {
      const res = await fetchWithAuth(`https://esi.evetech.net/latest/characters/${charId}/assets/?datasource=tranquility&page=${page}`, {}, accessToken);
      if (res && res.ok) {
        assetsFetchOk = true;
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0) {
          data.forEach(ast => {
            // is_blueprint_copy is present (true OR false) only on blueprint-type assets, absent
            // on everything else - excluding it here stops a BPO/BPC from ever being counted as
            // stock of the item it produces (they're always distinct type_ids, but a blueprint
            // sitting in a hangar is never "stock" of the manufactured item either way).
            if (ast.type_id && ast.quantity && ast.is_blueprint_copy === undefined) {
              window.rawAssetItems.push({
                item_id: ast.item_id,
                type_id: ast.type_id,
                quantity: ast.quantity,
                location_id: ast.location_id,
                location_flag: ast.location_flag,
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
    if (corpId && accessToken) {
      page = 1;
      hasMore = true;
      while (hasMore) {
        const res = await fetchWithAuth(`https://esi.evetech.net/latest/corporations/${corpId}/assets/?datasource=tranquility&page=${page}`, {}, accessToken, true);
        if (res && res.ok) {
          const data = await res.json();
          if (Array.isArray(data) && data.length > 0) {
            data.forEach(ast => {
              if (ast.type_id && ast.quantity && ast.is_blueprint_copy === undefined) {
                window.rawAssetItems.push({
                  item_id: ast.item_id,
                  type_id: ast.type_id,
                  quantity: ast.quantity,
                  location_id: ast.location_id,
                  location_flag: ast.location_flag,
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
    const itemIdToAssetMap = {};
    window.rawAssetItems.forEach(ast => {
      if (ast.item_id) itemIdToAssetMap[ast.item_id] = ast;
    });
    const charContainerIds = [];
    const corpContainerIds = [];
    window.rawAssetItems.forEach(ast => {
      let currentLoc = ast.location_id;
      let depth = 0;
      let containerId = null;
      while (itemIdToAssetMap[currentLoc] && depth < 10) {
        const parentAsset = itemIdToAssetMap[currentLoc];
        if (isContainerAsset(parentAsset.type_id)) {
          if (!containerId) {
            containerId = currentLoc;
            if (ast.owner_type === 'char' && !charContainerIds.includes(containerId)) {
              charContainerIds.push(containerId);
            } else if (ast.owner_type === 'corp' && !corpContainerIds.includes(containerId)) {
              corpContainerIds.push(containerId);
            }
          }
        }
        currentLoc = parentAsset.location_id;
        depth++;
      }
      ast.root_location_id = currentLoc;
      ast.container_id = containerId;
    });
    if (charContainerIds.length > 0) {
      for (let i = 0; i < charContainerIds.length; i += 500) {
        const chunk = charContainerIds.slice(i, i + 500);
        try {
          const nameRes = await fetchWithAuth(`https://esi.evetech.net/latest/characters/${charId}/assets/names/?datasource=tranquility`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(chunk)
          }, accessToken, true);
          if (nameRes && nameRes.ok) {
            const customNames = await nameRes.json();
            if (Array.isArray(customNames)) {
              customNames.forEach(cn => {
                if (cn.item_id && cn.name && cn.name !== 'None' && cn.name.trim() !== '') {
                  window.resolvedLocationNames[cn.item_id] = cn.name.toUpperCase();
                }
              });
            }
          }
        } catch (e) { console.warn('[ESI] Personal container custom-name fetch failed - those containers will show a generic name instead:', e); }
      }
    }
    if (corpId && corpContainerIds.length > 0 && accessToken) {
      for (let i = 0; i < corpContainerIds.length; i += 500) {
        const chunk = corpContainerIds.slice(i, i + 500);
        try {
          const nameRes = await fetchWithAuth(`https://esi.evetech.net/latest/corporations/${corpId}/assets/names/?datasource=tranquility`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(chunk)
          }, accessToken, true);
          if (nameRes && nameRes.ok) {
            const customNames = await nameRes.json();
            if (Array.isArray(customNames)) {
              customNames.forEach(cn => {
                if (cn.item_id && cn.name && cn.name !== 'None' && cn.name.trim() !== '') {
                  window.resolvedLocationNames[cn.item_id] = cn.name.toUpperCase();
                }
              });
            }
          }
        } catch (e) { console.warn('[ESI] Corp container custom-name fetch failed - those containers will show a generic name instead:', e); }
      }
    }
    await resolveAndPopulateLocationFilter(accessToken);
    if (assetsFetchOk) {
      localStorage.setItem('eve_assets_last_synced', String(Date.now()));
      // Shared choke point for both the manual Refresh button AND the automatic re-fetch that
      // happens on every page load when already logged in - so the "Last synced" text on the
      // ledger's Stock & Location panel stays honest regardless of which path populated the data.
      if (typeof window.updateStockLastSyncedDisplay === 'function') window.updateStockLastSyncedDisplay();
    }
    return assetsFetchOk;
  } catch (err) {
    console.warn('Assets fetch error:', err);
    return false;
  }
}

// Resolves a list of location IDs (NPC stations/systems via bulk /universe/names/, player-owned
// Upwell structures via the authenticated per-structure endpoint) into window.resolvedLocationNames.
// Reusable by anything needing real location names - not just the asset/stock flow.
async function resolveLocationIds(locationIds, accessToken = null) {
  const uniqueIds = Array.from(new Set((locationIds || []).filter(id => id && id !== 99999999)));
  if (uniqueIds.length === 0) return;

  const missingIds = uniqueIds.filter(id => !window.resolvedLocationNames[id]);
  const standardUniverseIds = missingIds.filter(id => id < 1000000000);
  if (standardUniverseIds.length > 0) {
    const chunks = [];
    for (let i = 0; i < standardUniverseIds.length; i += 500) {
      chunks.push(standardUniverseIds.slice(i, i + 500));
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
              window.resolvedLocationNames[item.id] = item.name.toUpperCase();
            });
          }
        }
      } catch (e) { console.warn('[ESI] Bulk location name lookup failed - those locations will show a raw ID instead:', e); }
    }
  }

  const token = accessToken || localStorage.getItem('esi_access_token');
  const unresolvedStructureIds = uniqueIds.filter(id => id > 1000000000000 && !window.resolvedLocationNames[id]);
  if (unresolvedStructureIds.length > 0 && token) {
    await Promise.all(unresolvedStructureIds.map(async (structId) => {
      try {
        const res = await fetchWithAuth(`https://esi.evetech.net/latest/universe/structures/${structId}/?datasource=tranquility`, {}, token, true);
        if (res && res.ok) {
          const structData = await res.json();
          if (structData && structData.name) {
            let sysName = window.systemNameCache[structData.solar_system_id] || '';
            if (!sysName && structData.solar_system_id) {
              try {
                const sysRes = await fetch(`https://esi.evetech.net/latest/universe/systems/${structData.solar_system_id}/?datasource=tranquility`);
                if (sysRes.ok) {
                  const sysData = await sysRes.json();
                  sysName = sysData.name.toUpperCase();
                  window.systemNameCache[structData.solar_system_id] = sysName;
                }
              } catch (e) { console.warn('[ESI] System name lookup for a structure failed - its name will show without the "(SYSTEM)" suffix:', e); }
            }
            const fullName = structData.name.toUpperCase();
            window.resolvedLocationNames[structId] = sysName ? `${fullName} (${sysName})` : fullName;
          }
        } else if (res && res.status === 403) {
          window.resolvedLocationNames[structId] = `UPWELL STRUCTURE (${structId.toString().slice(-6)}) [PRIVATE]`;
        }
      } catch (e) { console.warn(`[ESI] Structure ${structId} name lookup failed - it will show as a raw ID instead:`, e); }
    }));
  }
}
window.resolveLocationIds = resolveLocationIds;

async function resolveAndPopulateLocationFilter(accessToken = null) {
  const uniqueRootLocIds = Array.from(new Set(window.rawAssetItems.map(a => a.root_location_id || a.location_id).filter(id => id && id !== 99999999)));
  const uniqueContainerIds = Array.from(new Set(window.rawAssetItems.map(a => a.container_id).filter(id => id)));
  await resolveLocationIds(uniqueRootLocIds, accessToken);
  window.rawAssetItems.forEach(item => {
    const id = item.root_location_id || item.location_id;
    if (!window.resolvedLocationNames[id]) {
      if (id === 99999999) {
        window.resolvedLocationNames[id] = 'CLIPBOARD / MANUAL IMPORT';
      } else if (window.systemNameCache[id]) {
        window.resolvedLocationNames[id] = window.systemNameCache[id];
      } else if (id >= 30000000 && id < 34000000) {
        window.resolvedLocationNames[id] = `SOLAR SYSTEM #${id}`;
      } else if (id >= 60000000 && id < 64000000) {
        window.resolvedLocationNames[id] = `NPC STATION #${id}`;
      } else if (id > 1000000000000) {
        window.resolvedLocationNames[id] = `UPWELL STRUCTURE (${id.toString().slice(-6)})`;
      } else {
        window.resolvedLocationNames[id] = `CONTAINER / HANGAR #${id}`;
      }
    }
  });
  uniqueContainerIds.forEach(containerId => {
    if (!window.resolvedLocationNames[containerId]) {
      const containerItem = window.rawAssetItems.find(a => a.item_id === containerId);
      if (containerItem) {
        const typeName = getItemTypeName(containerItem.type_id) || 'Container';
        window.resolvedLocationNames[containerId] = `${typeName.toUpperCase()} (#${containerId.toString().slice(-5)})`;
      } else {
        window.resolvedLocationNames[containerId] = `CONTAINER (#${containerId.toString().slice(-5)})`;
      }
    }
  });
  populateLocationDropdown();
  // Ledger's own applyJournalStockFilter() must win when both exist - esi.js's own
  // applyStockLocationFilter() is a plain top-level function declaration, so it's ALWAYS in scope
  // on every page (esi.js loads everywhere), even though it was written for index.html/
  // invention.html. Checking it first meant a fresh asset fetch on ledger.html silently never
  // called the ledger's own re-render (applyJournalStockFilter -> renderJournalPage) - the stock
  // data itself was correct, but the Consolidated BOM panel never reflected it. Confirmed bug:
  // the "Refresh Assets" button appeared to do nothing on the ledger page.
  if (typeof applyJournalStockFilter === 'function') {
    applyJournalStockFilter();
  } else if (typeof applyStockLocationFilter === 'function') {
    applyStockLocationFilter();
  }
}

function populateLocationDropdown() {
  const filterSelect = document.getElementById('stock-location-filter');
  if (!filterSelect) return;
  const currentSystemName = (document.getElementById('system-search')?.value || 'JITA').toUpperCase();
  const currentValue = filterSelect.value || 'all';
  filterSelect.innerHTML = `
    <option value="all" style="color: #38bdf8; background-color: #0c1318; font-weight: bold;">All Locations (Combined Assets)</option>
    <option value="industry_system" style="color: #38bdf8; background-color: #0c1318; font-weight: bold;">Current System Only (${currentSystemName})</option>
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
    // Native <option> can't hold an inline SVG - the orange/green text color already distinguishes
    // Upwell structures from NPC stations, so no leading glyph is needed.
    if (isUpwellStructure) {
      mainOpt.style.color = '#f97316';
      mainOpt.style.backgroundColor = '#0c1318';
      mainOpt.style.fontWeight = 'bold';
      mainOpt.textContent = `${data.name} (${data.count.toLocaleString()} items)`;
    } else {
      mainOpt.style.color = '#4caf6f';
      mainOpt.style.backgroundColor = '#0c1318';
      mainOpt.style.fontWeight = 'bold';
      mainOpt.textContent = `${data.name} (${data.count.toLocaleString()} items)`;
    }
    filterSelect.appendChild(mainOpt);
    for (const [sagFlag, sagData] of Object.entries(data.corpDivisions)) {
      const sagOpt = document.createElement('option');
      sagOpt.value = `corpsag_${locId}_${sagFlag}`;
      sagOpt.style.color = '#c084fc';
      sagOpt.style.backgroundColor = '#070b0f';
      sagOpt.style.fontWeight = 'bold';
      sagOpt.textContent = `  └─ Corp: ${sagData.name} (${sagData.count.toLocaleString()} items)`;
      filterSelect.appendChild(sagOpt);
    }
    for (const [cId, cData] of Object.entries(data.containers)) {
      const containerOpt = document.createElement('option');
      containerOpt.value = `container_${cId}`;
      containerOpt.style.color = '#f8fafc';
      containerOpt.style.backgroundColor = '#070b0f';
      containerOpt.textContent = `  └─ Container: ${cData.name} (${cData.count.toLocaleString()} items)`;
      filterSelect.appendChild(containerOpt);
    }
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
      feedbackBadge.textContent = `Found: ${visibleCount.toLocaleString()}`;
      feedbackBadge.classList.remove('hidden');
    } else {
      feedbackBadge.textContent = '';
      feedbackBadge.classList.add('hidden');
    }
  }
  if (typeof window.openCustomSelect === 'function') window.openCustomSelect('stock-location-filter');
}

function updateStockDisplayCount() {
  const el = document.getElementById('stock-count-display');
  if (!el) return;
  const totalItems = Object.values(window.userStockMap || {}).reduce((acc, q) => acc + q, 0);
  el.textContent = `${totalItems.toLocaleString()} items`;
}

function applyStockLocationFilter() {
  const filterVal = document.getElementById('stock-location-filter')?.value || 'all';
  const activeSystemName = (document.getElementById('system-search')?.value || 'JITA').toUpperCase();
  const useChar = document.getElementById('use-char-assets')?.checked ?? true;
  const useCorp = document.getElementById('use-corp-assets')?.checked ?? true;
  window.userStockMap = {};
  window.rawAssetItems.forEach(item => {
    if (item.owner_type === 'char' && !useChar) return;
    if (item.owner_type === 'corp' && !useCorp) return;
    let include = false;
    const rootLocId = item.root_location_id || item.location_id;
    const itemLocName = window.resolvedLocationNames[rootLocId] || '';
    if (filterVal === 'all') {
      include = true;
    } else if (filterVal === 'industry_system') {
      include = itemLocName.includes(activeSystemName);
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
  updateStockDisplayCount();
  // This same function backs both pages that use it directly (index.html's own checkbox/select
  // onchange handlers, which already worked) - each page's actual recalculation entry point has a
  // different name, so both are tried; only one will ever exist on a given page.
  if (typeof window.recalculate === 'function') window.recalculate();
  else if (typeof window.recalculateInvention === 'function') window.recalculateInvention();
}

let _pasteModalOpenerEl = null;
function openPasteModal() {
  _pasteModalOpenerEl = document.activeElement;
  const modal = document.getElementById('paste-modal');
  if (modal) modal.classList.remove('hidden');
}

function closePasteModal() {
  const modal = document.getElementById('paste-modal');
  if (modal) modal.classList.add('hidden');
  if (_pasteModalOpenerEl && typeof _pasteModalOpenerEl.focus === 'function') _pasteModalOpenerEl.focus();
  _pasteModalOpenerEl = null;
}

function clearUserStock() {
  const rawAssetItemsSnapshot = window.rawAssetItems.slice();
  const userStockMapSnapshot = { ...window.userStockMap };
  window.rawAssetItems = window.rawAssetItems.filter(item => item.location_id !== 99999999);
  window.userStockMap = {};
  updateStockDisplayCount();
  populateLocationDropdown();
  if (typeof recalculate === 'function') recalculate();
  closePasteModal();
  if (typeof window.showToast === 'function') {
    window.showToast('Cleared all tracked stock.', 'info', { action: { label: 'Undo', onClick: () => {
      window.rawAssetItems = rawAssetItemsSnapshot;
      window.userStockMap = userStockMapSnapshot;
      updateStockDisplayCount();
      populateLocationDropdown();
      if (typeof recalculate === 'function') recalculate();
    } } });
  }
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
      if (!isNaN(parsedQty) && parsedQty > 0) qtyCandidate = parsedQty;
    } else {
      const match = trimmed.match(/^(.+?)\s+([0-9,.]+)\s*$/);
      if (match) {
        nameCandidate = match[1].trim();
        const parsedQty = parseInt(match[2].replace(/,/g, '').replace(/\./g, ''), 10);
        if (!isNaN(parsedQty) && parsedQty > 0) qtyCandidate = parsedQty;
      } else {
        nameCandidate = trimmed;
      }
    }
    if (nameCandidate) {
      const q = nameCandidate.toLowerCase();
      let matchedItem = window.IDX[q];
      if (!matchedItem && window.EVE_ITEMS) {
        for (const [idStr, name] of Object.entries(window.EVE_ITEMS)) {
          if (name.toLowerCase() === q) {
            matchedItem = { id: parseInt(idStr), name: name };
            break;
          }
        }
      }
      if (matchedItem) {
        window.rawAssetItems.push({
          type_id: matchedItem.id,
          quantity: qtyCandidate,
          location_id: 99999999,
          root_location_id: 99999999,
          owner_type: 'char'
        });
      }
    }
  });
  window.resolvedLocationNames[99999999] = 'CLIPBOARD / MANUAL IMPORT';
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
  } catch (e) { console.warn('[ESI] Failed to save the selected system - it will reset to the default on next reload:', e); }
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
  } catch (e) { console.warn('[ESI] Failed to restore the last saved system - falling back to JITA:', e); }
  await resolveSystemSCI('JITA');
}

async function resolveSystemSCI(systemName) {
  if (!systemName || systemName.trim().length < 2) return;
  const q = systemName.trim().toLowerCase();
  if (window.SYSTEM_IDX[q]) {
    await selectSolarSystem(window.SYSTEM_IDX[q].id, window.SYSTEM_IDX[q].name);
  } else {
    const matches = await fetchEsiSystemSearch(q);
    if (matches && matches.length > 0) {
      await selectSolarSystem(matches[0].id, matches[0].name);
    }
  }
}

async function fetchSystemSCIById(systemId, systemName) {
  try {
    const sysRes = await fetch('https://esi.evetech.net/latest/industry/systems/?datasource=tranquility');
    if (!sysRes.ok) return;
    const sysData = await sysRes.json();
    const sysEntry = sysData.find(s => s.solar_system_id === systemId);
    let mfgSCI = 0.01, reactSCI = 0.01, inventionSCI = 0.02;
    if (sysEntry && sysEntry.cost_indices) {
      sysEntry.cost_indices.forEach(ci => {
        if (ci.activity === 'manufacturing') mfgSCI = ci.cost_index;
        if (ci.activity === 'reaction') reactSCI = ci.cost_index;
        if (ci.activity === 'invention') inventionSCI = ci.cost_index;
      });
    }
    window.activeMfgSCI = mfgSCI;
    window.activeReactSCI = reactSCI;
    window.activeInventionSCI = inventionSCI;

    // Security status drives the rig bonus multiplier (highsec x1.0, lowsec x1.9, null/WH x2.1).
    let secLabel = '';
    try {
      const secRes = await fetch(`https://esi.evetech.net/latest/universe/systems/${systemId}/?datasource=tranquility`);
      if (secRes.ok) {
        const secData = await secRes.json();
        window.activeSystemSecurity = typeof secData.security_status === 'number' ? secData.security_status : null;
        if (window.activeSystemSecurity !== null) {
          const sec = window.activeSystemSecurity;
          secLabel = sec >= 0.45 ? ` | ${sec.toFixed(1)} (Highsec)` : (sec > 0.0 ? ` | ${sec.toFixed(1)} (Lowsec)` : ` | ${sec.toFixed(1)} (Null/WH)`);
        }
      }
    } catch (secErr) {
      window.activeSystemSecurity = null;
      console.warn('System security status fetch error:', secErr);
    }

    const sciBadgeEl = document.getElementById('sci-badge');
    if (sciBadgeEl) {
      sciBadgeEl.textContent = `System: ${systemName.toUpperCase()}${secLabel} | SCI: ${(mfgSCI * 100).toFixed(2)}% (Mfg) / ${(reactSCI * 100).toFixed(2)}% (React) / ${(inventionSCI * 100).toFixed(2)}% (Invention)`;
    }
    if (typeof recalculate === 'function') recalculate();
  } catch (err) {
    console.warn('System SCI fetch error:', err);
  }
}

// --- Market/Station Resolution ---
// Resolves a station name to its type/system/region IDs via ESI, entirely at runtime - this works
// for any station (major trade hub or a specific lowsec/null station the user knows), without
// hardcoding numeric IDs that would need independent verification to trust.
async function resolveStationByName(stationName) {
  try {
    const res = await fetch('https://esi.evetech.net/latest/universe/ids/?datasource=tranquility', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([stationName])
    });
    if (!res.ok) return null;
    const data = await res.json();
    const station = data.stations && data.stations[0];
    if (!station) return null;
    return { stationId: station.id, stationName: station.name };
  } catch (e) {
    console.warn('Station name resolution failed:', e);
    return null;
  }
}
window.resolveStationByName = resolveStationByName;

// Searches for stations matching a partial name (for the search-as-you-type UI), using ESI's public
// search endpoint.
// CCP removed the standalone public /search/ endpoint around mid-2022 (confirmed via EVE Online
// forum reports of it returning 404) - the only working search endpoint now is the authenticated,
// character-scoped one. This means search now requires being logged in via EVE SSO; without a
// character/token, there's no way to search ESI at all anymore (a real API constraint, not a choice
// made here). Returns {} (empty categories) on any failure so callers can treat "not logged in" and
// "no results" the same way.
async function esiCharacterSearch(searchTerm, categories) {
  const charId = localStorage.getItem('esi_char_id');
  const accessToken = localStorage.getItem('esi_access_token');
  if (!charId || !accessToken) {
    console.warn('[ESISearch] No results possible - ESI search requires being logged in via EVE SSO (the old public /search/ endpoint was removed by CCP).');
    return { __notLoggedIn: true };
  }
  try {
    const url = `https://esi.evetech.net/latest/characters/${charId}/search/?categories=${encodeURIComponent(categories)}&search=${encodeURIComponent(searchTerm)}&datasource=tranquility&strict=false`;
    console.info(`[ESISearch] Requesting: ${url}`);
    const res = await fetchWithAuth(url, {}, accessToken, true);
    if (!res) {
      console.warn('[ESISearch] fetchWithAuth returned no response object at all (network-level failure).');
      return {};
    }
    const bodyText = await res.text();
    console.info(`[ESISearch] Response status: ${res.status} ${res.statusText}. Body: ${bodyText}`);
    if (!res.ok) return {};
    return JSON.parse(bodyText);
  } catch (e) {
    console.warn('[ESISearch] Character search failed:', e);
    return {};
  }
}
window.esiCharacterSearch = esiCharacterSearch;

async function searchStationsByName(query) {
  if (!query || query.length < 3) return [];
  const data = await esiCharacterSearch(query, 'station');
  if (data.__notLoggedIn) return null; // distinct from [] - "couldn't search" vs "searched, found nothing"
  const stationIds = (data.station || []).slice(0, 15);
  if (stationIds.length === 0) return [];
  try {
    const namesRes = await fetch('https://esi.evetech.net/latest/universe/names/?datasource=tranquility', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(stationIds)
    });
    if (!namesRes.ok) return [];
    const namesData = await namesRes.json();
    return namesData.map(s => ({ stationId: s.id, stationName: s.name }));
  } catch (e) {
    console.warn('Station name resolution failed:', e);
    return [];
  }
}
window.searchStationsByName = searchStationsByName;

// Resolves a station's region id (needed for market history/volume) by walking station -> system ->
// constellation -> region. Only needed once per newly-tracked market since the result is cached.
async function resolveStationRegion(stationId) {
  try {
    const stationRes = await fetch(`https://esi.evetech.net/latest/universe/stations/${stationId}/?datasource=tranquility`);
    if (!stationRes.ok) return null;
    const stationData = await stationRes.json();
    const systemId = stationData.system_id;
    if (!systemId) return null;

    const systemRes = await fetch(`https://esi.evetech.net/latest/universe/systems/${systemId}/?datasource=tranquility`);
    if (!systemRes.ok) return null;
    const systemData = await systemRes.json();
    const constellationId = systemData.constellation_id;
    if (!constellationId) return null;

    const constRes = await fetch(`https://esi.evetech.net/latest/universe/constellations/${constellationId}/?datasource=tranquility`);
    if (!constRes.ok) return null;
    const constData = await constRes.json();
    return { regionId: constData.region_id, systemId: systemId };
  } catch (e) {
    console.warn('Station region resolution failed:', e);
    return null;
  }
}
window.resolveStationRegion = resolveStationRegion;

// Real daily trade volume (not just what's currently listed) comes from ESI market history, averaged
// over the most recent several days - this is the actual liquidity signal, distinct from Fuzzwork's
// order-book aggregates which only show what's currently for sale, not how fast it moves.
async function fetchAverageDailyVolume(regionId, typeId) {
  try {
    const res = await fetch(`https://esi.evetech.net/latest/markets/${regionId}/history/?datasource=tranquility&type_id=${typeId}`);
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) return null;
    const recent = data.slice(-7); // last 7 days of trading
    const totalVolume = recent.reduce((sum, day) => sum + (day.volume || 0), 0);
    return Math.round(totalVolume / recent.length);
  } catch (e) {
    console.warn('Market history fetch failed:', e);
    return null;
  }
}
window.fetchAverageDailyVolume = fetchAverageDailyVolume;

// Fetches price + liquidity for one item across every tracked market in parallel, for the Compare
// Markets panel. Price comes from Fuzzwork (per-station), volume from ESI history (per-region) -
// deliberately returned side by side rather than collapsed into a single "best" score, since the
// cheapest price and the most liquid market are often not the same place.
async function fetchMarketComparison(typeId) {
  const markets = typeof window.getTrackedMarkets === 'function' ? window.getTrackedMarkets() : [];
  const results = await Promise.all(markets.map(async (market) => {
    let sell = 0, buy = 0, avgVolume = null;
    try {
      const priceUrl = `https://market.fuzzwork.co.uk/aggregates/?station=${market.stationId}&types=${typeId}`;
      const priceRes = await fetch(priceUrl);
      if (priceRes.ok) {
        const priceData = await priceRes.json();
        const entry = priceData[String(typeId)];
        if (entry) {
          sell = entry.sell ? parseFloat(entry.sell.min) || 0 : 0;
          buy = entry.buy ? parseFloat(entry.buy.max) || 0 : 0;
        }
      }
    } catch (e) { /* leave as 0 */ }

    if (market.regionId) {
      avgVolume = await fetchAverageDailyVolume(market.regionId, typeId);
    }

    return { stationName: market.stationName, stationId: market.stationId, sell, buy, avgVolume };
  }));
  return results;
}
window.fetchMarketComparison = fetchMarketComparison;

// Fetches the character's real active/recent industry jobs from ESI - used to auto-detect when a
// job queued in the ledger has actually been started in-game, using the REAL start time and duration
// EVE calculated, rather than this app's own estimate.
async function fetchActiveIndustryJobs() {
  const charId = localStorage.getItem('esi_char_id');
  const accessToken = localStorage.getItem('esi_access_token');
  if (!charId || !accessToken) return null; // not logged in
  try {
    const res = await fetchWithAuth(`https://esi.evetech.net/latest/characters/${charId}/industry/jobs/?datasource=tranquility`, {}, accessToken, true);
    if (!res || !res.ok) return null;
    return await res.json();
  } catch (e) {
    console.warn('Industry jobs fetch failed:', e);
    return null;
  }
}
window.fetchActiveIndustryJobs = fetchActiveIndustryJobs;

// Fetches ALL industry jobs installed by ANY member of the character's corporation - requires the
// Factory Manager role in-game, and a corp ID cached from a prior asset refresh. Returns an empty
// array (not null) on any failure so callers can safely merge it with character jobs regardless of
// whether corp access is available - a character without Factory Manager simply contributes nothing
// here rather than breaking the whole sync.
async function fetchActiveCorpIndustryJobs() {
  const corpId = localStorage.getItem('esi_corp_id');
  const accessToken = localStorage.getItem('esi_access_token');
  if (!corpId || !accessToken) return [];
  try {
    const res = await fetchWithAuth(`https://esi.evetech.net/latest/corporations/${corpId}/industry/jobs/?datasource=tranquility`, {}, accessToken, true);
    if (!res || !res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.warn('Corp industry jobs fetch failed (likely missing Factory Manager role):', e);
    return [];
  }
}
window.fetchActiveCorpIndustryJobs = fetchActiveCorpIndustryJobs;

// Fetches the character's owned blueprints (with real ME/TE research levels) from ESI. A job's
// blueprint_id references a specific blueprint item instance - this is the only place its actual
// researched ME/TE lives, since the industry jobs endpoint itself doesn't carry that data.
// Both blueprint endpoints below are paginated by ESI exactly like /assets/ is (same "keep fetching
// incrementing ?page= until an empty array comes back" pattern already used for assets, rather than
// trusting the X-Pages header) - a character/corp with a large enough blueprint library (a big BPO
// collection easily clears the ~1000-per-page default) would otherwise silently lose everything past
// page 1 here. That's what made blueprints sitting in a well-stocked can look like "some show, some
// don't" - which ones were missing depended only on where they fell in ESI's own paging, not on
// anything about the can itself.
async function fetchCharacterBlueprints() {
  const charId = localStorage.getItem('esi_char_id');
  const accessToken = localStorage.getItem('esi_access_token');
  if (!charId || !accessToken) return [];
  const results = [];
  let page = 1;
  let hasMore = true;
  try {
    while (hasMore) {
      const res = await fetchWithAuth(`https://esi.evetech.net/latest/characters/${charId}/blueprints/?datasource=tranquility&page=${page}`, {}, accessToken, true);
      if (!res || !res.ok) break;
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        results.push(...data);
        page++;
      } else {
        hasMore = false;
      }
    }
    return results;
  } catch (e) {
    console.warn('Character blueprints fetch failed:', e);
    return results;
  }
}
window.fetchCharacterBlueprints = fetchCharacterBlueprints;

async function fetchCorpBlueprints() {
  const corpId = localStorage.getItem('esi_corp_id');
  const accessToken = localStorage.getItem('esi_access_token');
  if (!corpId || !accessToken) return [];
  const results = [];
  let page = 1;
  let hasMore = true;
  try {
    while (hasMore) {
      const res = await fetchWithAuth(`https://esi.evetech.net/latest/corporations/${corpId}/blueprints/?datasource=tranquility&page=${page}`, {}, accessToken, true);
      if (!res || !res.ok) break;
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        results.push(...data);
        page++;
      } else {
        hasMore = false;
      }
    }
    return results;
  } catch (e) {
    console.warn('Corp blueprints fetch failed (likely missing role):', e);
    return results;
  }
}
window.fetchCorpBlueprints = fetchCorpBlueprints;

async function fetchMarketPrices(typeIds) {
  const homeStationId = localStorage.getItem('eve_home_station_id') || '60003760'; // defaults to Jita IV - Moon 4
  const missing = typeIds.filter(id => !window.priceCache[id]);
  if (!missing.length) return;
  const chunks = [];
  for (let i = 0; i < missing.length; i += 30) {
    chunks.push(missing.slice(i, i + 30));
  }
  await Promise.all(chunks.map(async (chunk) => {
    const targetUrl = `https://market.fuzzwork.co.uk/aggregates/?station=${homeStationId}&types=${chunk.join(',')}`;
    const tryUrls = [targetUrl, `https://corsproxy.io/?${encodeURIComponent(targetUrl)}`];
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
                window.priceCache[id] = {
                  sell: entry.sell ? parseFloat(entry.sell.min) || 0 : 0,
                  buy: entry.buy ? parseFloat(entry.buy.max) || 0 : 0
                };
                foundPrices = true;
              }
            }
            if (foundPrices) break;
          }
        }
      } catch (err) {}
    }
    chunk.forEach(id => {
      if (!window.priceCache[id] || (!window.priceCache[id].sell && !window.priceCache[id].buy)) {
        // No real market order data available (fetch failed, or the item just has none at this
        // station) - EIV is a rough estimate, not a real order, so it's flagged as such here and
        // that flag is surfaced wherever this price gets displayed (see js/config.js formatPriceValue).
        const eivVal = getEIV(id);
        window.priceCache[id] = { sell: eivVal, buy: eivVal * 0.9, isEstimated: true };
      }
    });
  }));
}

// Explicit window bindings
window.decodeJwt = decodeJwt;
window.getItemTypeName = getItemTypeName;
window.isShipLocationFlag = isShipLocationFlag;
window.isContainerAsset = isContainerAsset;
window.isShipType = isShipType;
window.fetchWithAuth = fetchWithAuth;
window.fetchAdjustedPrices = fetchAdjustedPrices;
window.getEIV = getEIV;
window.calculateNodeEIV = calculateNodeEIV;
window.getCleanRedirectUri = getCleanRedirectUri;
window.startEsiSSOLogin = startEsiSSOLogin;
window.handleEsiSSOCallback = handleEsiSSOCallback;
window.updateEsiUserUI = updateEsiUserUI;
window.logoutEsiSSO = logoutEsiSSO;
window.refreshLiveAssets = refreshLiveAssets;
window.fetchUserAndCorpAssets = fetchUserAndCorpAssets;
window.resolveAndPopulateLocationFilter = resolveAndPopulateLocationFilter;
window.populateLocationDropdown = populateLocationDropdown;
window.filterLocationDropdownOptions = filterLocationDropdownOptions;
window.updateStockDisplayCount = updateStockDisplayCount;
window.applyStockLocationFilter = applyStockLocationFilter;
window.openPasteModal = openPasteModal;
window.closePasteModal = closePasteModal;
window.clearUserStock = clearUserStock;
window.processPastedStock = processPastedStock;
window.selectSolarSystem = selectSolarSystem;
window.loadSavedSystem = loadSavedSystem;
window.resolveSystemSCI = resolveSystemSCI;
window.fetchSystemSCIById = fetchSystemSCIById;
window.fetchMarketPrices = fetchMarketPrices;