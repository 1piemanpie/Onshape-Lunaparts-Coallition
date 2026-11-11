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

// ---- Dropdown lists (projects, machines, thicknesses, statuses) -----------
// LUNA Parts answers GET /options with every dropdown list in one request.
// If that ever fails (an older LUNA without it), we fall back to the old way:
// one list per resource, and statuses worked out from existing parts.
// The answer is cached for a minute, so opening the panel in several tabs
// (or the statuses and options requests together) is one LUNA call.
const OPTIONS_CACHE_MS = 60 * 1000;
let optionsCache = null;

// A list from /options, whether it came as a plain array or wrapped in `data`.
function listOf(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.data)) return value.data;
  return null;
}

function byOrder(a, b) {
  return (Number(a.order) || 0) - (Number(b.order) || 0) || a.id - b.id;
}

function tidyOptions({ projects, tools, thicknesses, statuses }) {
  return {
    projects: projects
      .filter((p) => !p.completed_at)
      .map((p) => ({ id: p.id, name: p.name, prefix: p.part_number_prefix })),
    tools: tools
      .filter((t) => t.is_active !== false)
      .sort(byOrder)
      .map((t) => ({ id: t.id, name: t.name })),
    thicknesses: thicknesses
      .sort(byOrder)
      .map((t) => ({ id: t.id, name: t.name })),
    statuses: statuses
      .sort(byOrder)
      .map((s) => ({ id: s.id, name: s.name || `Status ${s.id}` })),
  };
}

async function loadOptionsInOneCall() {
  const body = await lunaGet('options');
  const o = body && body.data && !Array.isArray(body.data) ? body.data : body;
  const lists = {
    projects: listOf(o.projects),
    tools: listOf(o.tools),
    thicknesses: listOf(o.material_thicknesses || o.thicknesses),
    statuses: listOf(o.part_statuses || o.statuses),
  };
  const missing = Object.keys(lists).filter((k) => !lists[k]);
  if (missing.length) throw new Error(`LUNA Parts options had no ${missing.join(', ')}`);
  return lists;
}

// ---- The old way, kept as a fallback --------------------------------------
// Every part carries a part_status_id, and fetching a single part includes
// its status, so we collect the IDs in use and look up one example each.
function statusName(part) {
  const status = part.status || part.part_status || part.partStatus;
  if (!status || typeof status !== 'object') return null;
  return status.name || status.label || status.title || null;
}

async function statusesFromParts() {
  const parts = await lunaGetAll('parts');
  const examples = new Map();
  for (const part of parts) {
    if (!examples.has(part.part_status_id)) examples.set(part.part_status_id, part);
  }

  return Promise.all([...examples].map(async ([id, part]) => {
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
}

async function loadOptionsTheOldWay() {
  const [projects, tools, thicknesses, statuses] = await Promise.all([
    lunaGetAll('projects'),
    lunaGetAll('tools'),
    lunaGetAll('material-thicknesses'),
    statusesFromParts(),
  ]);
  return { projects, tools, thicknesses, statuses };
}

async function loadOptions() {
  try {
    return tidyOptions(await loadOptionsInOneCall());
  } catch (err) {
    // A bad key is a bad key either way; don't hide it behind four more calls.
    if (err.status === 401 || err.status === 403) throw err;
    console.error('LUNA Parts /options failed, reading each list instead:', err.message);
    return tidyOptions(await loadOptionsTheOldWay());
  }
}

async function getOptions() {
  if (!optionsCache || Date.now() - optionsCache.at > OPTIONS_CACHE_MS) {
    const pending = loadOptions();
    optionsCache = { at: Date.now(), pending };
    pending.catch(() => { if (optionsCache && optionsCache.pending === pending) optionsCache = null; });
  }
  return optionsCache.pending;
}

async function getStatuses() {
  return (await getOptions()).statuses;
}

module.exports = {
  LUNA_API_BASE,
  lunaRequest,
  lunaGetAll,
  lunaGet,
  attachmentExtension,
  getOptions,
  getStatuses,
};
