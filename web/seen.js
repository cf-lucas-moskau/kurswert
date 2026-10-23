// Which cars Lucas has already looked at. Shared by the server (persistence in
// <data>/seen.json) and the dashboard (window.Seen).
//
// State: { since: "YYYY-MM-DD", ids: { "<listing id>": "<ISO time seen>" } }
// A car is unseen when we first saw it on or after `since` (the day seen
// tracking started, so the old backlog doesn't flood the view) and it has not
// been marked seen since.
(function (root) {
  const ID = /^[\w:.-]{1,80}$/;

  function create(today) {
    return { since: today, ids: {} };
  }

  function isUnseen(state, listing) {
    return !!listing.firstSeen && Date.parse(listing.firstSeen) >= Date.parse(state.since) && !(String(listing.id) in state.ids);
  }

  // Marking is idempotent: a car keeps the time it was first seen. Returns a
  // new state plus how many ids were newly marked; malformed ids are ignored.
  function markSeen(state, ids, now) {
    const next = { ...state, ids: { ...state.ids } };
    let added = 0;
    for (const raw of ids) {
      const id = String(raw);
      if (!ID.test(id) || id in next.ids) continue;
      next.ids[id] = now;
      added++;
    }
    return { state: next, added };
  }

  const api = { create, isUnseen, markSeen };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Seen = api;
})(this);
