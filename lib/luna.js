// Talking to LUNA Parts (https://build.lunatecs.org/api/v1).
// The API key lives only in Render's env vars and is only ever sent from
// this server, so the panel (and anyone viewing it) never sees it.

const LUNA_API_BASE = (process.env.LUNA_PARTS_API_BASE || 'https://build.lunatecs.org/api/v1').replace(/\/+$/, '');

function lunaHeaders() {
  return {
    Authorization: `Bearer ${process.env.LUNA_PARTS_API_KEY}`,
    Accept: 'application/json',
  };
}

// One request to LUNA Parts, answered with fetch's raw Response so the caller
// can tell LUNA's errors apart (404, 422 ...). `json` is sent as a JSON body;
// `body` (e.g. a FormData) is sent as it is.
function lunaRequest(path, { method = 'GET', json, body } = {}) {
  const headers = lunaHeaders();
  if (json !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(`${LUNA_API_BASE}/${path}`, {
    method,
    headers,
    ...(json !== undefined ? { body: JSON.stringify(json) } : body !== undefined ? { body } : {}),
  });
}

// LUNA Parts returns lists one page at a time; this follows next_page_url
// until it has everything (capped so a bad response can't loop forever).
async function lunaGetAll(resource) {
  const items = [];
  let url = `${LUNA_API_BASE}/${resource}`;

  for (let page = 0; url && page < 20; page++) {
    const res = await fetch(url, { headers: lunaHeaders() });

    if (!res.ok) {
      const err = new Error(`LUNA Parts ${resource} returned ${res.status}`);
      err.status = res.status;
      throw err;
    }

    const body = await res.json();
    items.push(...body.data);
    url = body.next_page_url;
  }

  return items;
}

// One thing (not a list), parsed. Throws with err.status on an error.
async function lunaGet(path) {
  const res = await lunaRequest(path);
  if (!res.ok) {
    const err = new Error(`LUNA Parts ${path} returned ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// A file's type, from whichever name field LUNA filled in.
function attachmentExtension(file) {
  return String(file.extension || file.original_filename || file.filename || '').toLowerCase().split('.').pop();
}

// ---- Part statuses ---------------------------------------------------------
// The API has no endpoint that lists part statuses, but every part carries
// a part_status_id, and fetching a single part includes its status. So we
// collect the IDs in use and look up one example part for each to get the
// status's name. Statuses rarely change, so the answer is cached.
const STATUS_CACHE_MS = 10 * 60 * 1000;
let statusCache = null;

function statusName(part) {
  const status = part.status || part.part_status || part.partStatus;
  if (!status || typeof status !== 'object') return null;
  return status.name || status.label || status.title || null;
}

async function loadStatuses() {
  const parts = await lunaGetAll('parts');
  const examples = new Map();
  for (const part of parts) {
    if (!examples.has(part.part_status_id)) examples.set(part.part_status_id, part);
  }

  const statuses = await Promise.all([...examples].map(async ([id, part]) => {
    let name = statusName(part);
    if (!name) {
      try {
        name = statusName(await lunaGet(`parts/${part.id}`));
      } catch (err) {
        console.error(`Could not look up status ${id}:`, err);
      }
    }
    return { id, name: name || `Status ${id}` };
  }));

  return statuses.sort((a, b) => a.id - b.id);
}

async function getStatuses() {
  if (!statusCache || Date.now() - statusCache.at > STATUS_CACHE_MS) {
    statusCache = { at: Date.now(), statuses: await loadStatuses() };
  }
  return statusCache.statuses;
}

module.exports = {
  LUNA_API_BASE,
  lunaRequest,
  lunaGetAll,
  lunaGet,
  attachmentExtension,
  getStatuses,
};
