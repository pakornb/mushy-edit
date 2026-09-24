// Direct-to-Sheets export via the Apps Script EXECUTION API (scripts.run) —
// runs the SAME Apps Script code (apiBuild / apiSyncSheetState /
// apiUpdateComposite in appsScript.js) as the in-Sheet menu, just triggered
// by a signed-in Google account instead of the download-a-JSON-and-pick-it
// dialog. See the setup note at the top of appsScript.js (also in CLAUDE.md)
// for the one-time GCP/OAuth-client/deployment steps this needs — none of
// that can happen from code, it's done once per studio in Google's consoles.
//
// CLIENT_ID is the shared "hornet-tools" OAuth client — the same one works
// for any Hornet tool calling any deployed Apps Script project, isn't a
// secret (client IDs are public by design), and never changes per show, so
// it's hardcoded here rather than something every artist re-enters.
//
// deploymentId identifies which Sheet's deployed script to call. Most
// projects never need to think about this: DEFAULT_DEPLOYMENT_ID points at
// the one shared "Mushy Edit Breakdowns" Sheet, so Build/Update (direct)
// work with zero configuration out of the box, landing every show's
// breakdown as its own timestamped tab in that one Sheet. A project can
// still opt into its OWN separate Sheet via project.sheetsDeploymentId (set
// once via "Use a separate Google Sheet for this project…", saved in the
// work file) — that override, when present, always wins over the default.
// Never move deployment ID into this browser's localStorage; that would
// reintroduce "re-enter it per browser/profile."
//
// UNVERIFIED AGAINST A REAL DEPLOYMENT: the request/response shape here
// follows Google's documented scripts.run contract, but the exact error
// shape when the called script throws hasn't been tested live — see the
// error handling in callScript() below if a real call reports something
// unexpected.

const CLIENT_ID = '902841680403-3ua13oavs9ic6m4i1e6si7hl2b0q3qup.apps.googleusercontent.com';
export const DEFAULT_DEPLOYMENT_ID = 'AKfycbxhjhPrngLQwuYR3FW91iBes-67IEb6pbRxRA9XTtjg5lCOX98LvN8ElRhjKbWUhTzcXw';
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

let tokenClient = null, cachedToken = null, tokenExpiry = 0;
async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry - 30000) return cachedToken;
  await loadGis();
  return new Promise((resolve, reject) => {
    if (!tokenClient) {
      tokenClient = window.google.accounts.oauth2.initTokenClient({ client_id: CLIENT_ID, scope: SCOPES, callback: () => {} });
    }
    // If the popup gets closed (manually, or abandoned on Google's "unverified
    // app" warning screen) without the user finishing the flow, GIS never
    // calls back at all — this would otherwise hang forever with no feedback.
    const timeout = setTimeout(() => {
      reject(new Error('Timed out waiting for Google sign-in. If you saw a "Google hasn’t verified this app" warning, click Advanced → Go to Mushy Edit (unsafe), then check both permissions and continue — the popup has to fully complete, not just close.'));
    }, 120000);
    tokenClient.callback = (resp) => {
      clearTimeout(timeout);
      if (resp.error) { reject(new Error(resp.error)); return; }
      cachedToken = resp.access_token;
      tokenExpiry = Date.now() + (resp.expires_in || 3600) * 1000;
      resolve(cachedToken);
    };
    tokenClient.requestAccessToken({ prompt: cachedToken ? '' : 'consent' });
  });
}

async function callScript(fn, params, deploymentId) {
  if (!deploymentId) throw new Error('This project has no Google Sheet deployment ID set — Export → "Set Google Sheet deployment ID…" first.');
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

export function apiBuild(data, deploymentId) { return callScript('apiBuild', [data], deploymentId); }
export function apiSyncSheetState(deploymentId) { return callScript('apiSyncSheetState', [], deploymentId); }
export function apiUpdateComposite(payload, deploymentId) { return callScript('apiUpdateComposite', [payload], deploymentId); }
