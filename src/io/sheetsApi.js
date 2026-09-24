// Direct-to-Sheets export via the Apps Script EXECUTION API (scripts.run) —
// runs the SAME Apps Script code (apiBuild / apiSyncSheetState /
// apiUpdateComposite in appsScript.js) as the in-Sheet menu, just triggered
// by a signed-in Google account instead of the download-a-JSON-and-pick-it
// dialog. See the setup note at the top of appsScript.js (also in CLAUDE.md)
// for the one-time GCP/OAuth-client/deployment steps this needs — none of
// that can happen from code, it's done once per studio in Google's consoles.
//
// UNVERIFIED AGAINST A REAL DEPLOYMENT: the request/response shape here
// follows Google's documented scripts.run contract, but the exact error
// shape when the called script throws hasn't been tested live — see the
// error handling in callScript() below if a real call reports something
// unexpected.

const SCOPES = 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/script.scriptapp';

let gisReady = null;
function loadGis() {
  if (gisReady) return gisReady;
  gisReady = new Promise((resolve, reject) => {
    if (window.google && window.google.accounts && window.google.accounts.oauth2) return resolve();
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Could not load Google Sign-In.'));
    document.head.appendChild(s);
  });
  return gisReady;
}

function getConfig() {
  let clientId = '', deploymentId = '';
  try {
    clientId = localStorage.getItem('mushyGoogleClientId') || '';
    deploymentId = localStorage.getItem('mushyScriptDeploymentId') || '';
  } catch (e) {}
  return { clientId, deploymentId };
}
function setConfig(clientId, deploymentId) {
  try {
    localStorage.setItem('mushyGoogleClientId', clientId);
    localStorage.setItem('mushyScriptDeploymentId', deploymentId);
  } catch (e) {}
}
export function configureGoogleSheets() {
  const cur = getConfig();
  const clientId = (prompt('Google OAuth Client ID (GCP project → APIs & Services → Credentials):', cur.clientId) || '').trim();
  if (!clientId) return false;
  const deploymentId = (prompt('Apps Script API-executable deployment ID (Deploy → Manage deployments):', cur.deploymentId) || '').trim();
  if (!deploymentId) return false;
  setConfig(clientId, deploymentId);
  return true;
}
export function hasGoogleSheetsConfig() {
  const { clientId, deploymentId } = getConfig();
  return !!(clientId && deploymentId);
}

let tokenClient = null, cachedToken = null, tokenExpiry = 0;
async function getAccessToken() {
  const { clientId } = getConfig();
  if (!clientId) throw new Error('No Google Client ID set — use "Configure Google Sheets…" first.');
  if (cachedToken && Date.now() < tokenExpiry - 30000) return cachedToken;
  await loadGis();
  return new Promise((resolve, reject) => {
    if (!tokenClient) {
      tokenClient = window.google.accounts.oauth2.initTokenClient({ client_id: clientId, scope: SCOPES, callback: () => {} });
    }
    tokenClient.callback = (resp) => {
      if (resp.error) { reject(new Error(resp.error)); return; }
      cachedToken = resp.access_token;
      tokenExpiry = Date.now() + (resp.expires_in || 3600) * 1000;
      resolve(cachedToken);
    };
    tokenClient.requestAccessToken({ prompt: cachedToken ? '' : 'consent' });
  });
}

async function callScript(fn, params) {
  const { deploymentId } = getConfig();
  if (!deploymentId) throw new Error('No Apps Script deployment ID set — use "Configure Google Sheets…" first.');
  const token = await getAccessToken();
  const resp = await fetch(`https://script.googleapis.com/v1/scripts/${deploymentId}:run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ function: fn, parameters: params }),
  });
  const json = await resp.json().catch(() => null);
  if (!json) throw new Error(`No response from the Apps Script API (HTTP ${resp.status}).`);
  if (json.error) throw new Error(json.error.message || 'Apps Script call failed.');
  if (json.response && json.response.error) {
    const e = json.response.error;
    throw new Error(typeof e === 'string' ? e : (e.errorMessage || e.message || 'Script error.'));
  }
  return json.response ? json.response.result : undefined;
}

export function apiBuild(data) { return callScript('apiBuild', [data]); }
export function apiSyncSheetState() { return callScript('apiSyncSheetState', []); }
export function apiUpdateComposite(payload) { return callScript('apiUpdateComposite', [payload]); }
