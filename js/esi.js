async function handleEsiSSOCallback() {
  const urlParams = new URLSearchParams(window.location.search);
  const code = urlParams.get('code');
  if (!code) {
    const charName = localStorage.getItem('esi_char_name');
    const charId = localStorage.getItem('esi_char_id');
    const token = localStorage.getItem('esi_access_token');
    if (charName && charId && token) {
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
    const clientId = window.HARDCODED_CLIENT_ID; // Resolves the scope ReferenceError

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

        localStorage.setItem('esi_access_token', accessToken);
        localStorage.setItem('esi_char_id', charId);
        localStorage.setItem('esi_char_name', charName);

        updateEsiUserUI(charName, charId);
        await fetchUserAndCorpAssets(charId, accessToken);
      }
    } else {
      const errText = await res.text();
      console.error("SSO Code Exchange Failed:", res.status, errText);
    }
  } catch (err) {
    console.error('ESI SSO Token Error:', err);
  }
}