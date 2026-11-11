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

// LUNA Parts returns lists one page at a time (100 at most per page). We ask
// for each page by number ourselves, because LUNA's next_page_url may drop
// our filters. Capped so a bad answer can't loop forever (10,000 rows).
const PER_PAGE = 100;
const MAX_PAGES = 100;

function withQuery(resource, params) {
  const extra = new URLSearchParams(params).toString();
  return `${resource}${resource.includes('?') ? '&' : '?'}${extra}`;
}

// Every page of a list. Also returns deleted_ids (only sync answers have
// them) and LUNA's own clock from the Date header of the first page.
async function lunaGetPages(resource) {
  const items = [];
  let deletedIds = null;
  let serverDate = null;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetch(`${LUNA_API_BASE}/${withQuery(resource, { per_page: PER_PAGE, page })}`, { headers: lunaHeaders() });

    if (!res.ok) {
      const err = new Error(`LUNA Parts ${resource} returned ${res.status}`);
      err.status = res.status;
      throw err;
    }

    if (page === 1) {
      const date = Date.parse(res.headers.get('date') || '');
      if (!Number.isNaN(date)) serverDate = date;
    }
    const body = await res.json();
    items.push(...(body.data || []));
    if (body.deleted_ids !== undefined && body.deleted_ids !== null) {
      deletedIds = deletedIds || [];
      const ids = Array.isArray(body.deleted_ids) ? body.deleted_ids : String(body.deleted_ids).split(',');
      deletedIds.push(...ids.map(Number).filter((n) => Number.isInteger(n)));
    }

    const more = body.last_page !== undefined ? Number(body.current_page || page) < Number(body.last_page) : Boolean(body.next_page_url);
    if (!more) break;
  }

  return { items, deletedIds, serverDate };
}

async function lunaGetAll(resource) {
  return (await lunaGetPages(resource)).items;
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
  const parts = await getParts();
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

// ---- Every part in LUNA, kept in sync --------------------------------------
// The first time, we read the whole list. After that we only ask for parts
// changed since the last read (updated_since), plus the ids of parts deleted
// since then, and patch our copy. So most reads are one small request. A full
// re-read happens every few hours anyway, in case something was missed.
const FULL_REFRESH_MS = 6 * 60 * 60 * 1000;
// Ask a little further back than strictly needed, so a part saved just as we
// were reading isn't missed. Re-reading a part twice does no harm.
const SYNC_OVERLAP_MS = 2 * 60 * 1000;
const partsCache = { byId: new Map(), since: null, fullAt: 0, pending: null };

async function syncParts() {
  const full = !partsCache.since || Date.now() - partsCache.fullAt > FULL_REFRESH_MS;
  const askedAt = Date.now();
  const { items, deletedIds, serverDate } = await lunaGetPages(
    full ? 'parts' : `parts?updated_since=${encodeURIComponent(partsCache.since)}`,
  );

  // An answer to a sync request without deleted_ids means LUNA ignored
  // updated_since and sent everything, so use it as a full list.
  if (full || deletedIds === null) {
    partsCache.byId = new Map();
    partsCache.fullAt = askedAt;
  }
  for (const part of items) {
    if (part.deleted_at) partsCache.byId.delete(part.id);
    else partsCache.byId.set(part.id, part);
  }
  for (const id of deletedIds || []) partsCache.byId.delete(id);

  // LUNA's own clock if it sent one, so the two clocks don't need to agree.
  partsCache.since = new Date((serverDate || askedAt) - SYNC_OVERLAP_MS).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return [...partsCache.byId.values()];
}

// Every part in LUNA (all projects), up to date. Requests made at the same
// time share one sync.
function getParts() {
  if (!partsCache.pending) {
    partsCache.pending = syncParts().finally(() => { partsCache.pending = null; });
  }
  return partsCache.pending;
}

// One project's parts, from the synced list.
async function getProjectParts(projectId) {
  return (await getParts()).filter((p) => p.project_id === projectId);
}

module.exports = {
  LUNA_API_BASE,
  lunaRequest,
  lunaGetAll,
  getParts,
  getProjectParts,
  lunaGet,
  attachmentExtension,
  getOptions,
  getStatuses,
};
