// One at a time per key. Two students pressing upload on the same part
// number (or the same linked spacer) at once would both read LUNA, both see
// the number as free, and both create a part. Running "check, then create"
// one at a time per key stops that: the second one waits, then sees the
// first one's part and gets the usual "already in LUNA" answer.
//
// This only covers this server (Render runs one copy of it). A part made in
// LUNA's own website at the same moment isn't covered; only a uniqueness
// rule inside LUNA could do that.

const tails = new Map(); // key -> promise that settles when its last job is done

async function withKeys(keys, job) {
  const wanted = [...new Set(keys.filter(Boolean))].sort();
  const before = wanted.map((k) => tails.get(k) || Promise.resolve());
  let release;
  const mine = new Promise((resolve) => { release = resolve; });
  for (const k of wanted) tails.set(k, mine);
  try {
    await Promise.all(before);
    return await job();
  } finally {
    release();
    // Forget a key once nothing else is queued behind it.
    for (const k of wanted) if (tails.get(k) === mine) tails.delete(k);
  }
}

module.exports = { withKeys };
