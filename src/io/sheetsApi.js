// Direct-to-Sheets export via the Apps Script EXECUTION API (scripts.run) —
// runs the SAME Apps Script code (apiBuild / apiSyncSheetState /
// apiUpdateComposite in appsScript.js) as the in-Sheet menu, just triggered
// by a signed-in Google account instead of the download-a-JSON-and-pick-it
// dialog. See the setup note at the top of appsScript.js (also in CLAUDE.md)
// for the one-time GCP/OAuth-client/deployment steps this needs — none of
// that can happen from code, it's done once per studio in Google's consoles.
//
// ONE shared deployment serves EVERY Sheet, not one deployment per Sheet:
// the Apps Script functions take a spreadsheetId and open that Spreadsheet
// explicitly (SpreadsheetApp.openById) instead of relying on "the active
// spreadsheet." So connecting a new show's Sheet is just giving Mushy Edit
// that Sheet's URL — no Apps Script editor, no GCP console, ever, for any
// future Sheet. (The one thing that CAN'T be automated is linking a script
// project to a specific GCP project — there's no public API for it — which
// is exactly why this avoids creating a new script project per Sheet at
// all, rather than trying to automate that step away.)
//
// CLIENT_ID is the shared "hornet-tools" OAuth client — isn't a secret
// (client IDs are public by design) and is the same for every Hornet tool,
// so it's hardcoded. DEFAULT_DEPLOYMENT_ID is that one shared deployment's
// ID — also hardcoded, since there's only ever one.
//
// UNVERIFIED AGAINST A REAL DEPLOYMENT: the request/response shape here
// follows Google's documented scripts.run contract, but the exact error
// shape when the called script throws hasn't been tested live — see the
// error handling in callScript() below if a real call reports something
// unexpected.

const CLIENT_ID = '902841680403-3ua13oavs9ic6m4i1e6si7hl2b0q3qup.apps.googleusercontent.com';
const DEFAULT_DEPLOYMENT_ID = 'AKfycbxhjhPrngLQwuYR3FW91iBes-67IEb6pbRxRA9XTtjg5lCOX98LvN8ElRhjKbWUhTzcXw';
// The one shared "Mushy Edit Breakdowns" Sheet every project defaults to.
export const DEFAULT_SPREADSHEET_ID = '1trX0caIez7UVX9LOXmDsF-PH1CieUj8ljtU4pAvohgs';
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

async function callScript(fn, params) {
  const token = await getAccessToken();
  const resp = await fetch(`https://script.googleapis.com/v1/scripts/${DEFAULT_DEPLOYMENT_ID}:run`, {
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

// data.sheetName in the result is the tab that got built — callers should
// save it (project.sheetsBreakdownTabName) and pass it back to the two
// functions below for any later update, since a headless call has no
// "active tab" to fall back on.
export function apiBuild(spreadsheetId, data) { return callScript('apiBuild', [spreadsheetId, data]); }
export function apiSyncSheetState(spreadsheetId, sheetName) { return callScript('apiSyncSheetState', [spreadsheetId, sheetName]); }
export function apiUpdateComposite(spreadsheetId, sheetName, payload) { return callScript('apiUpdateComposite', [spreadsheetId, sheetName, payload]); }
