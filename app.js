(() => {
  "use strict";

  const POS_LIST = ["QB", "RB", "WR", "TE", "K", "DST"];
  const SLOT_GROUPS = ["QB", "RB", "WR", "TE", "FLEX", "K", "DST", "BENCH"];
  const FLEX_ELIGIBLE = ["RB", "WR", "TE"];
  const TOP_OFFENSE_CUTOFF = 10;
  const BOTTOM_OFFENSE_CUTOFF = 27; // rank >= this is bottom 6 of 32
  const LS_KEYS = {
    csv: "ffdraft_csv_text",
    status: "ffdraft_status",
    settings: "ffdraft_settings",
    queue: "ffdraft_queue",
    theme: "ffdraft_theme",
  };

  const DEFAULT_SETTINGS = {
    teams: 12,
    myPos: 1,
    slots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1, BENCH: 6 },
    tierSensitivity: "medium",
  };

  // Two independent multiplier sets, because points gaps and rank gaps are
  // shaped nothing alike: rank gaps are roughly uniform small integers, while
  // points gaps are steep at the top of a position (a couple of true outliers)
  // and flat for most of the pool. Both were picked by sweeping against real
  // sample data until tier counts looked like a usable draft board (~4-16
  // tiers per position) rather than 1 giant tier or 30 singleton ones.
  const TIER_SENSITIVITY = {
    rank: { tight: 1.0, medium: 1.75, loose: 2.5 },
    projection: { tight: 0.25, medium: 0.5, loose: 1.25 },
  };

  // A position needs at least this many players with a projection value
  // before points-based tiering is trusted for it; below that (e.g. DST,
  // which regularly ships with zero point projections) tiering falls back
  // to the rank-gap method instead.
  const MIN_PROJECTION_SAMPLE = 10;

  /** @type {{players: any[], byId: Map<string,any>, settings: any, queue: Set<string>, slotAssignments: Record<string,string>, actionHistory: {id:string}[], tierMethodByPos: Record<string,string>, ui: any}} */
  const state = {
    players: [],
    byId: new Map(),
    settings: loadSettings(),
    queue: loadQueue(),
    slotAssignments: {},
    actionHistory: [],
    volatilityBands: null,
    injuryRiskQ1: null,
    injuryRiskQ3: null,
    tierMethodByPos: {},
    offenseRankByTeam: {},
    ui: {
      search: "",
      posFilter: "ALL",
      hideDrafted: false,
      sortKey: "rank",
      sortDir: 1,
      expanded: new Set(),
    },
  };

  // ---------- persistence ----------

  function loadSettings() {
    try {
      const raw = localStorage.getItem(LS_KEYS.settings);
      if (!raw) return structuredCloneSafe(DEFAULT_SETTINGS);
      const parsed = JSON.parse(raw);
      return { ...structuredCloneSafe(DEFAULT_SETTINGS), ...parsed, slots: { ...DEFAULT_SETTINGS.slots, ...(parsed.slots || {}) } };
    } catch {
      return structuredCloneSafe(DEFAULT_SETTINGS);
    }
  }

  function loadQueue() {
    try {
      const raw = localStorage.getItem(LS_KEYS.queue);
      return raw ? new Set(JSON.parse(raw)) : new Set();
    } catch {
      return new Set();
    }
  }

  function structuredCloneSafe(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function saveSettings() {
    localStorage.setItem(LS_KEYS.settings, JSON.stringify(state.settings));
  }

  function saveQueue() {
    localStorage.setItem(LS_KEYS.queue, JSON.stringify(Array.from(state.queue)));
  }

  function saveStatus() {
    const map = {};
    for (const p of state.players) {
      if (p.status !== "available") {
        map[p.id] = { status: p.status, pick: p.pick, slot: p.slot };
      }
    }
    localStorage.setItem(LS_KEYS.status, JSON.stringify(map));
  }

  function saveCsvText(text) {
    localStorage.setItem(LS_KEYS.csv, text);
  }

  // ---------- CSV parsing ----------

  function parseCsv(text) {
    const rows = [];
    let field = "";
    let row = [];
    let inQuotes = false;
    const n = text.length;
    for (let i = 0; i < n; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          field += c;
        }
        continue;
      }
      if (c === '"') {
        inQuotes = true;
      } else if (c === ",") {
        row.push(field);
        field = "";
      } else if (c === "\r") {
        // skip
      } else if (c === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else {
        field += c;
      }
    }
    if (field.length || row.length) {
      row.push(field);
      rows.push(row);
    }
    return rows.filter((r) => r.some((c) => c !== ""));
  }

  function detectColumns(header) {
    const norm = header.map((h) => (h || "").trim());
    const lower = norm.map((h) => h.toLowerCase());
    const find = (regexList) => {
      for (const re of regexList) {
        const idx = lower.findIndex((h) => re.test(h));
        if (idx !== -1) return idx;
      }
      return -1;
    };
    const nameIdx = find([/^(name|player|player_?name)$/]);
    const posIdx = find([/^(pos|position)$/]);
    const teamIdx = find([/^(team|tm)$/]);
    const byeIdx = find([/^(bye|bye_?week)$/]);
    const sosIdx = find([/^sos$/]);
    const adpIdx = find([/adp/]);
    const notesIdx = find([/^notes?$/]);
    const rankIdx = find([/^agg_?rank$/, /^overall_?rank$/, /^rank$/, /^ecr$/, /rank/]);
    const injuryIdx = find([/injury/]);

    // The points-projection column used for tiers. Priority 1: a "DS
    // Projection"-style column (this year's named source) — the "ds" check
    // keeps it from colliding with DS_Rank, which has no "proj" in it.
    // Priority 2: any other central projection/points column for CSVs that
    // don't use "DS" naming, explicitly excluding Floor/Ceiling projection
    // columns since those are variance bounds, not the point estimate to tier on.
    let projIdx = lower.findIndex((h) => h.includes("ds") && h.includes("proj"));
    if (projIdx === -1) {
      projIdx = lower.findIndex((h) => (h.includes("proj") || h.includes("pts") || h.includes("points")) && !h.includes("floor") && !h.includes("ceil"));
    }

    const used = new Set([nameIdx, posIdx, teamIdx, byeIdx, sosIdx, adpIdx, notesIdx, rankIdx].filter((i) => i !== -1));
    const extra = [];
    norm.forEach((h, idx) => {
      if (used.has(idx)) return;
      if (!h) return; // skip the blank leading index column
      extra.push({ idx, label: h });
    });

    return { nameIdx, posIdx, teamIdx, byeIdx, sosIdx, adpIdx, notesIdx, rankIdx, projIdx, injuryIdx, extra };
  }

  function buildPlayers(rows) {
    const header = rows[0];
    const cols = detectColumns(header);
    const players = [];
    const seenIds = new Map();

    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const name = (cols.nameIdx !== -1 ? row[cols.nameIdx] : "") || "";
      if (!name.trim()) continue;
      const pos = ((cols.posIdx !== -1 ? row[cols.posIdx] : "") || "").trim().toUpperCase();
      const team = ((cols.teamIdx !== -1 ? row[cols.teamIdx] : "") || "").trim().toUpperCase();
      const bye = cols.byeIdx !== -1 ? row[cols.byeIdx] : "";
      const sos = cols.sosIdx !== -1 ? row[cols.sosIdx] : "";
      const adpRaw = cols.adpIdx !== -1 ? row[cols.adpIdx] : "";
      const notes = cols.notesIdx !== -1 ? row[cols.notesIdx] : "";
      const rankRaw = cols.rankIdx !== -1 ? row[cols.rankIdx] : String(r);
      const rank = parseFloat(rankRaw);
      const projRaw = cols.projIdx !== -1 ? row[cols.projIdx] : "";
      const projection = parseFloat(projRaw);
      const injuryRaw = cols.injuryIdx !== -1 ? row[cols.injuryIdx] : "";
      const injuryRisk = parseFloat(String(injuryRaw).replace("%", ""));

      const extra = cols.extra
        .map(({ idx, label }) => ({ label, value: row[idx] }))
        .filter((e) => e.value !== undefined && e.value !== "");

      // Volatility sources: any non-main-rank column whose header names it as a
      // rank (contains "rank", case-insensitive). Excludes the aggregate/main
      // rank column (that's a derived average, not an independent opinion) and
      // excludes ADP (its header doesn't contain "rank").
      const rankSources = extra
        .filter((e) => /rank/i.test(e.label))
        .map((e) => ({ label: e.label, value: parseFloat(e.value) }))
        .filter((e) => Number.isFinite(e.value));

      let id = `${name}|${team}|${pos}`.toLowerCase().trim();
      if (seenIds.has(id)) {
        const n = seenIds.get(id) + 1;
        seenIds.set(id, n);
        id = `${id}#${n}`;
      } else {
        seenIds.set(id, 0);
      }

      players.push({
        id,
        rank: Number.isFinite(rank) ? rank : r,
        name: name.trim(),
        pos: pos || "?",
        team: team || "—",
        bye: bye ? String(bye).trim() : "",
        sos: sos ? String(sos).trim() : "",
        adp: parseAdp(adpRaw),
        notes: (notes || "").trim(),
        projection: Number.isFinite(projection) ? projection : null,
        injuryRisk: Number.isFinite(injuryRisk) ? injuryRisk : null,
        extra,
        rankSources,
        volatility: null,
        tier: null,
        status: "available",
        pick: null,
        slot: null,
      });
    }
    players.sort((a, b) => a.rank - b.rank);
    return players;
  }

  // ---------- tiers & volatility ----------

  // Assigns ascending tier numbers to `list` in place, breaking to a new tier
  // wherever the gap between consecutive `valueFn` results is a statistical
  // outlier relative to that list's own gaps (mean + mult*stddev). Shared by
  // both the points-based and rank-based tiering paths below — same
  // procedure, different input value and multiplier scale.
  function tierByGap(list, valueFn, mult) {
    list.sort((a, b) => valueFn(a) - valueFn(b));
    list[0].tier = 1;
    if (list.length === 1) return;

    const gaps = [];
    for (let i = 1; i < list.length; i++) gaps.push(valueFn(list[i]) - valueFn(list[i - 1]));
    const meanGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const variance = gaps.reduce((a, b) => a + (b - meanGap) ** 2, 0) / gaps.length;
    const stdGap = Math.sqrt(variance);
    const threshold = meanGap + mult * stdGap;

    let tier = 1;
    for (let i = 1; i < list.length; i++) {
      if (gaps[i - 1] > threshold && gaps[i - 1] > 0) tier++;
      list[i].tier = tier;
    }
  }

  function computeTiers(players) {
    const rankMult = TIER_SENSITIVITY.rank[state.settings.tierSensitivity] ?? TIER_SENSITIVITY.rank.medium;
    const projMult = TIER_SENSITIVITY.projection[state.settings.tierSensitivity] ?? TIER_SENSITIVITY.projection.medium;
    for (const p of players) p.tier = null;
    state.tierMethodByPos = {};

    for (const pos of POS_LIST) {
      const posPlayers = players.filter((p) => p.pos === pos);
      if (!posPlayers.length) continue;

      const withProjection = posPlayers.filter((p) => p.projection !== null);
      if (withProjection.length >= MIN_PROJECTION_SAMPLE) {
        // Higher points is better, so sort/gap on the negated value to reuse
        // the same ascending-gap logic as the rank path.
        tierByGap(withProjection, (p) => -p.projection, projMult);
        state.tierMethodByPos[pos] = "projection";
      } else {
        tierByGap(posPlayers, (p) => p.rank, rankMult);
        state.tierMethodByPos[pos] = "rank";
      }
    }
  }

  function percentile(sortedArr, p) {
    const idx = Math.min(sortedArr.length - 1, Math.floor(p * sortedArr.length));
    return sortedArr[idx];
  }

  function computeVolatility(players) {
    for (const p of players) {
      const vals = p.rankSources.map((r) => r.value);
      if (vals.length >= 2) {
        const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
        const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
        p.volatility = Math.sqrt(variance);
      } else {
        p.volatility = null;
      }
    }
    const values = players.map((p) => p.volatility).filter((v) => v !== null).sort((a, b) => a - b);
    state.volatilityBands = values.length ? { low: percentile(values, 0.33), high: percentile(values, 0.67) } : null;
  }

  // Bottom quartile (Q1, lowest reported risk %) and top quartile (Q3,
  // highest) of the Injury Risk column, used to flag the safest and riskiest
  // quarters of the pool.
  function computeInjuryRiskStats(players) {
    const values = players.map((p) => p.injuryRisk).filter((v) => v !== null).sort((a, b) => a - b);
    state.injuryRiskQ1 = values.length ? percentile(values, 0.25) : null;
    state.injuryRiskQ3 = values.length ? percentile(values, 0.75) : null;
  }

  function parseAdp(raw) {
    if (raw === undefined || raw === null || raw === "") return null;
    const cleaned = String(raw).replace(/\+/g, "");
    const n = parseFloat(cleaned);
    return Number.isFinite(n) ? n : null;
  }

  // ---------- loading ----------

  // Team offense strength (Rank,Team) is season-level reference data, not
  // something that changes with a re-drafted player CSV, so it's fetched
  // once at startup rather than tied into loadFromCsvText.
  async function loadOffenseRankings() {
    try {
      const res = await fetch("offense_rankings.csv");
      if (!res.ok) throw new Error("not found");
      const text = await res.text();
      const rows = parseCsv(text);
      const header = rows[0].map((h) => h.trim().toLowerCase());
      const rankIdx = header.indexOf("rank");
      const teamIdx = header.indexOf("team");
      if (rankIdx === -1 || teamIdx === -1) return;
      const map = {};
      for (const row of rows.slice(1)) {
        const team = (row[teamIdx] || "").trim().toUpperCase();
        const rank = parseInt(row[rankIdx], 10);
        if (team && Number.isFinite(rank)) map[team] = rank;
      }
      state.offenseRankByTeam = map;
      renderTable();
      renderMyTeam();
    } catch {
      // Offense data is optional flavor, not core functionality — fail quiet.
    }
  }

  function loadFromCsvText(text, { resetDraft } = { resetDraft: false }) {
    const rows = parseCsv(text);
    if (!rows.length) {
      toast("That CSV looks empty.");
      return;
    }
    const players = buildPlayers(rows);
    if (!players.length) {
      toast("Couldn't find any player rows in that file.");
      return;
    }

    state.players = players;
    state.byId = new Map(players.map((p) => [p.id, p]));
    state.slotAssignments = {};
    state.actionHistory = [];
    computeTiers(state.players);
    computeVolatility(state.players);
    computeInjuryRiskStats(state.players);

    if (resetDraft) {
      localStorage.removeItem(LS_KEYS.status);
      state.queue = new Set();
      saveQueue();
    } else {
      applySavedStatus();
      rebuildActionHistory();
    }

    saveCsvText(text);
    document.getElementById("emptyState").style.display = "none";
    renderAll();
    toast(`Loaded ${players.length} players.`);
  }

  function applySavedStatus() {
    try {
      const raw = localStorage.getItem(LS_KEYS.status);
      if (!raw) return;
      const map = JSON.parse(raw);
      for (const [id, saved] of Object.entries(map)) {
        const p = state.byId.get(id);
        if (!p) continue;
        p.status = saved.status;
        p.pick = saved.pick;
        p.slot = saved.slot;
        if (saved.slot) state.slotAssignments[saved.slot] = id;
      }
    } catch {
      /* ignore corrupt state */
    }
  }

  function rebuildActionHistory() {
    state.actionHistory = state.players
      .filter((p) => p.status !== "available" && p.pick != null)
      .sort((a, b) => a.pick - b.pick)
      .map((p) => ({ id: p.id }));
  }

  // ---------- roster slots ----------

  function buildSlotList() {
    const list = [];
    for (const type of SLOT_GROUPS) {
      const count = state.settings.slots[type] || 0;
      for (let i = 1; i <= count; i++) {
        list.push({ id: count > 1 || type === "BENCH" ? `${type}${i}` : type, type });
      }
    }
    return list;
  }

  function eligibleTypesFor(pos) {
    if (pos === "QB") return ["QB", "BENCH"];
    if (FLEX_ELIGIBLE.includes(pos)) return [pos, "FLEX", "BENCH"];
    if (pos === "K") return ["K", "BENCH"];
    if (pos === "DST") return ["DST", "BENCH"];
    return ["BENCH"];
  }

  function assignSlot(player) {
    const slots = buildSlotList();
    const priority = eligibleTypesFor(player.pos);
    for (const type of priority) {
      const slot = slots.find((s) => s.type === type && !state.slotAssignments[s.id]);
      if (slot) {
        state.slotAssignments[slot.id] = player.id;
        return slot.id;
      }
    }
    return null;
  }

  function unassignSlot(player) {
    if (player.slot) {
      delete state.slotAssignments[player.slot];
      player.slot = null;
    }
  }

  // ---------- draft actions ----------

  function draftPlayer(id, who) {
    const p = state.byId.get(id);
    if (!p || p.status !== "available") return;
    const pick = countDrafted() + 1;
    p.status = who;
    p.pick = pick;
    if (who === "me") {
      p.slot = assignSlot(p);
    }
    state.actionHistory.push({ id });
    persistAll();
    renderAll();
  }

  // `fromUndo` skips re-filtering the history stack, since undoLast() already
  // popped the entry it's unwinding; a manual per-row Reset click (fromUndo
  // false) can target any drafted player, not just the most recent pick, so it
  // has to scrub that player's entry out of the stack wherever it sits.
  function resetPlayer(id, { fromUndo = false } = {}) {
    const p = state.byId.get(id);
    if (!p || p.status === "available") return;
    unassignSlot(p);
    p.status = "available";
    p.pick = null;
    if (!fromUndo) {
      state.actionHistory = state.actionHistory.filter((a) => a.id !== id);
    }
    renumberPicks();
    persistAll();
    renderAll();
  }

  function renumberPicks() {
    const drafted = state.players
      .filter((p) => p.status !== "available")
      .sort((a, b) => a.pick - b.pick);
    drafted.forEach((p, i) => (p.pick = i + 1));
  }

  function undoLast() {
    if (!state.actionHistory.length) return;
    const last = state.actionHistory.pop();
    resetPlayer(last.id, { fromUndo: true });
  }

  function countDrafted() {
    return state.players.filter((p) => p.status !== "available").length;
  }

  function persistAll() {
    saveStatus();
  }

  function toggleQueue(id) {
    if (state.queue.has(id)) state.queue.delete(id);
    else state.queue.add(id);
    saveQueue();
    renderQueue();
    renderTable();
  }

  // ---------- rendering ----------

  function filteredSortedPlayers() {
    let list = state.players;
    if (state.ui.posFilter !== "ALL") {
      list = list.filter((p) => p.pos === state.ui.posFilter);
    }
    if (state.ui.search.trim()) {
      const q = state.ui.search.trim().toLowerCase();
      list = list.filter((p) => p.name.toLowerCase().includes(q) || p.team.toLowerCase().includes(q));
    }
    if (state.ui.hideDrafted) {
      list = list.filter((p) => p.status === "available");
    }
    const key = state.ui.sortKey;
    const dir = state.ui.sortDir;
    const val = (p) => {
      switch (key) {
        case "name":
          return p.name.toLowerCase();
        case "pos":
          return p.pos;
        case "team":
          return p.team;
        case "bye":
          return parseFloat(p.bye) || 999;
        case "adp":
          return p.adp === null ? 999 : p.adp;
        case "tier":
          return p.tier === null ? 999 : p.tier;
        case "volatility":
          return p.volatility === null ? 999 : p.volatility;
        default:
          return p.rank;
      }
    };
    return [...list].sort((a, b) => {
      const av = val(a);
      const bv = val(b);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return a.rank - b.rank;
    });
  }

  function renderAll() {
    renderTable();
    renderBestAvailable();
    renderPosCounts();
    renderMyTeam();
    renderQueue();
    renderClock();
    renderUndoButton();
  }

  function renderUndoButton() {
    const btn = document.getElementById("undoBtn");
    const n = state.actionHistory.length;
    btn.disabled = n === 0;
    btn.textContent = n > 0 ? `Undo last pick (${n})` : "Undo last pick";
  }

  function adpBadge(p) {
    if (p.adp === null || Number.isNaN(p.adp)) return `<span class="adp-delta neutral">—</span>`;
    if (p.adp < 0) return `<span class="adp-delta value" title="Ranked ahead of ADP — potential value">${p.adp} value</span>`;
    if (p.adp > 0) return `<span class="adp-delta reach" title="Ranked behind ADP — potential reach">+${p.adp} reach</span>`;
    return `<span class="adp-delta neutral">even</span>`;
  }

  function tierBadge(p) {
    if (!p.tier) return `<span class="tier-chip neutral">—</span>`;
    const method = state.tierMethodByPos[p.pos];
    const title = method === "projection" ? "Tiered by projected points" : "Tiered by rank (not enough projection data for this position)";
    return `<span class="tier-chip" title="${title}">T${p.tier}</span>`;
  }

  function volatilityBadge(p) {
    if (p.volatility === null) return `<span class="volatility-badge neutral" title="Not enough expert-rank sources for this player">—</span>`;
    const bands = state.volatilityBands;
    let label = "Mixed";
    let cls = "mixed";
    if (bands) {
      if (p.volatility <= bands.low) {
        label = "Steady";
        cls = "steady";
      } else if (p.volatility >= bands.high) {
        label = "Volatile";
        cls = "volatile";
      }
    }
    const sourceText = p.rankSources.map((r) => `${r.label}: ${r.value}`).join(", ");
    return `<span class="volatility-badge ${cls}" title="Spread across ${p.rankSources.length} sources (${sourceText})">${label} · ${p.volatility.toFixed(1)}</span>`;
  }

  // Compact at-a-glance warning icons shown next to a player's name — in the
  // main table and in the My Team roster — so risk is visible without having
  // to scan over to the dedicated Volatility column or expand row detail.
  function flagIcons(p) {
    const icons = [];
    if (p.injuryRisk !== null && state.injuryRiskQ1 !== null && p.injuryRisk <= state.injuryRiskQ1) {
      icons.push(`<span class="flag-icon" title="Low injury risk — reported at ${p.injuryRisk}%, in the safest quartile of rated players">🛡️</span>`);
    }
    if (p.injuryRisk !== null && state.injuryRiskQ3 !== null && p.injuryRisk >= state.injuryRiskQ3) {
      icons.push(`<span class="flag-icon" title="High injury risk — reported at ${p.injuryRisk}%, in the riskiest quartile of rated players">🚑</span>`);
    }
    if (p.volatility !== null && state.volatilityBands && p.volatility >= state.volatilityBands.high) {
      icons.push(`<span class="flag-icon" title="Highly volatile — expert ranks disagree widely on this player (σ=${p.volatility.toFixed(1)})">🎲</span>`);
    }
    const offenseRank = state.offenseRankByTeam[p.team];
    if (offenseRank !== undefined) {
      if (offenseRank <= TOP_OFFENSE_CUTOFF) {
        icons.push(`<span class="flag-icon" title="${p.team} has a top-${TOP_OFFENSE_CUTOFF} offense (ranked #${offenseRank} of 32)">🔥</span>`);
      } else if (offenseRank >= BOTTOM_OFFENSE_CUTOFF) {
        icons.push(`<span class="flag-icon" title="${p.team} has a bottom-6 offense (ranked #${offenseRank} of 32)">🧊</span>`);
      }
    }
    return icons.length ? `<span class="flag-icons">${icons.join("")}</span>` : "";
  }

  function renderTable() {
    const tbody = document.getElementById("playersBody");
    const players = filteredSortedPlayers();
    document.getElementById("emptyState").style.display = state.players.length ? "none" : "block";

    if (!players.length && state.players.length) {
      tbody.innerHTML = `<tr><td colspan="11" style="padding:24px;text-align:center;color:var(--text-muted)">No players match your filters.</td></tr>`;
      updateSortHeaders();
      return;
    }

    const frag = document.createDocumentFragment();
    // Tiers are computed on rank OR projected points depending on position,
    // but the table can be sorted by any column — so tier numbers don't
    // necessarily climb monotonically in display order (a lower-ranked player
    // can have a better points tier). Track the deepest tier seen per position
    // rather than just the last one, so re-encountering an earlier tier out of
    // order never fires a duplicate/backward divider.
    const maxTierSeenByPos = {};
    for (const p of players) {
      if (p.tier !== null && p.tier > (maxTierSeenByPos[p.pos] ?? 0)) {
        frag.appendChild(buildTierDividerRow(p));
        maxTierSeenByPos[p.pos] = p.tier;
      }

      const tr = document.createElement("tr");
      tr.className = "player-row" + (p.status === "me" ? " drafted-me" : p.status === "other" ? " drafted-other" : "");
      tr.dataset.id = p.id;

      const starred = state.queue.has(p.id);
      const isAvailable = p.status === "available";

      tr.innerHTML = `
        <td><button class="star-btn ${starred ? "active" : ""}" data-action="star" title="${starred ? "Remove from your queue" : "Add to your queue"}">${starred ? "★" : "☆"}</button></td>
        <td>${Number.isFinite(p.rank) ? p.rank : ""}</td>
        <td>${tierBadge(p)}</td>
        <td class="name-cell">${escapeHtml(p.name)}${flagIcons(p)}</td>
        <td><span class="pos-badge"><span class="pos-dot ${p.pos}"></span>${p.pos}</span></td>
        <td>${p.team}</td>
        <td>${p.bye || "—"}</td>
        <td>${adpBadge(p)}</td>
        <td>${volatilityBadge(p)}</td>
        <td>${statusPill(p)}</td>
        <td class="row-actions">${rowActions(p, isAvailable)}</td>
      `;
      frag.appendChild(tr);

      if (state.ui.expanded.has(p.id)) {
        frag.appendChild(buildDetailRow(p));
      }
    }
    tbody.innerHTML = "";
    tbody.appendChild(frag);
    updateSortHeaders();
  }

  function buildTierDividerRow(p) {
    const tr = document.createElement("tr");
    tr.className = "tier-divider-row";
    const method = state.tierMethodByPos[p.pos] === "projection" ? "by points" : "by rank";
    tr.innerHTML = `<td colspan="11"><span class="tier-divider"><span class="pos-dot ${p.pos}"></span>${p.pos} · Tier ${p.tier} <span class="tier-method">${method}</span></span></td>`;
    return tr;
  }

  function statusPill(p) {
    if (p.status === "me") return `<span class="status-pill me">Mine · #${p.pick}</span>`;
    if (p.status === "other") return `<span class="status-pill">Drafted · #${p.pick}</span>`;
    return `<span class="status-pill" style="opacity:.5">Available</span>`;
  }

  function rowActions(p, isAvailable) {
    if (isAvailable) {
      return `
        <button class="btn btn-primary" data-action="me">Mine</button>
        <button class="btn btn-ghost" data-action="other">Other</button>
      `;
    }
    return `<button class="btn btn-ghost" data-action="reset">Reset</button>`;
  }

  function buildDetailRow(p) {
    const tr = document.createElement("tr");
    tr.className = "detail-row";
    tr.dataset.detailFor = p.id;
    const extras = p.extra
      .map((e) => `<div class="detail-item"><strong>${escapeHtml(String(e.value))}</strong>${escapeHtml(e.label)}</div>`)
      .join("");
    const sos = p.sos ? `<div class="detail-item"><strong>${escapeHtml(p.sos)}</strong>SOS</div>` : "";
    tr.innerHTML = `
      <td colspan="11">
        <div class="detail-grid">${sos}${extras}</div>
        ${p.notes ? `<div class="detail-notes">${escapeHtml(p.notes)}</div>` : ""}
      </td>
    `;
    return tr;
  }

  function updateSortHeaders() {
    document.querySelectorAll("th.sortable").forEach((th) => {
      th.classList.toggle("sort-active", th.dataset.sort === state.ui.sortKey);
    });
  }

  function renderBestAvailable() {
    const el = document.getElementById("bestAvailable");
    const rows = POS_LIST.map((pos) => {
      const best = state.players.find((p) => p.pos === pos && p.status === "available");
      return `
        <div class="best-avail-row">
          <span class="pos-dot ${pos}"></span>
          <span class="name">${best ? escapeHtml(best.name) : "—"}</span>
          <span class="rank">${best ? "#" + best.rank : ""}</span>
        </div>`;
    }).join("");
    el.innerHTML = rows;
  }

  function renderPosCounts() {
    const el = document.getElementById("posCounts");
    el.innerHTML = POS_LIST.map((pos) => {
      const n = state.players.filter((p) => p.pos === pos && p.status === "available").length;
      return `<div class="pos-count-item"><span class="pos-dot ${pos}"></span>${pos} <span class="num">${n}</span></div>`;
    }).join("");
  }

  function renderMyTeam() {
    const el = document.getElementById("myTeam");
    const slots = buildSlotList();
    const rows = slots.map((slot) => {
      const pid = state.slotAssignments[slot.id];
      const player = pid ? state.byId.get(pid) : null;
      if (player) {
        return `
          <div class="roster-slot filled">
            <span class="slot-tag">${slot.type}</span>
            <span class="slot-player">${escapeHtml(player.name)}${flagIcons(player)} <span class="name-sub">${player.pos}${player.team !== "—" ? " · " + player.team : ""}</span></span>
            <button class="slot-remove" data-unassign="${slot.id}" title="Unassign from this roster slot">×</button>
          </div>`;
      }
      return `
        <div class="roster-slot empty">
          <span class="slot-tag">${slot.type}</span>
          <span class="slot-player">empty</span>
        </div>`;
    });

    const unassigned = state.players.filter((p) => p.status === "me" && !p.slot);
    if (unassigned.length) {
      rows.push(`<p class="hint" style="margin-top:6px">Unassigned</p>`);
      for (const p of unassigned) {
        const options = slots
          .filter((s) => eligibleTypesFor(p.pos).includes(s.type) && !state.slotAssignments[s.id])
          .map((s) => `<option value="${s.id}">${s.id}</option>`)
          .join("");
        rows.push(`
          <div class="roster-slot filled">
            <span class="slot-tag">${p.pos}</span>
            <span class="slot-player">${escapeHtml(p.name)}${flagIcons(p)}</span>
            <select data-manual-assign="${p.id}"><option value="">assign…</option>${options}</select>
          </div>`);
      }
    }
    el.innerHTML = rows.join("");
  }

  function renderQueue() {
    const el = document.getElementById("queueList");
    const hint = document.getElementById("queueHint");
    const ids = Array.from(state.queue).map((id) => state.byId.get(id)).filter(Boolean);
    ids.sort((a, b) => a.rank - b.rank);
    hint.style.display = ids.length ? "none" : "block";
    el.innerHTML = ids
      .map((p) => {
        const gone = p.status !== "available";
        return `
        <div class="queue-item ${gone ? "gone" : ""}">
          <span class="pos-dot ${p.pos}"></span>
          <span class="qname">${escapeHtml(p.name)}</span>
          <span class="name-sub">#${p.rank}</span>
          <button class="qremove" data-unqueue="${p.id}" title="Remove from queue">×</button>
        </div>`;
      })
      .join("");
  }

  function renderClock() {
    const teams = Math.max(2, state.settings.teams || 12);
    const mySlot = Math.min(teams, Math.max(1, state.settings.myPos || 1));
    const drafted = countDrafted();

    document.getElementById("pickCount").textContent = String(drafted);

    const round = Math.floor(drafted / teams) + 1;
    const pickInRound = (drafted % teams) + 1;
    document.getElementById("roundPick").textContent = `R${round} · P${pickInRound}`;

    let nextMyOverall = null;
    for (let r = 1; r <= 60; r++) {
      const idxInRound = r % 2 === 1 ? mySlot : teams - mySlot + 1;
      const overall = (r - 1) * teams + idxInRound;
      if (overall > drafted) {
        nextMyOverall = overall;
        break;
      }
    }
    const el = document.getElementById("picksUntilMe");
    if (nextMyOverall === null) {
      el.textContent = "–";
    } else {
      const gap = nextMyOverall - drafted - 1;
      el.textContent = gap <= 0 ? "You're up!" : String(gap);
    }
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ---------- toast ----------

  let toastTimer = null;
  function toast(msg) {
    const el = document.getElementById("toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
  }

  // ---------- wiring ----------

  function renderPosTabs() {
    const el = document.getElementById("posTabs");
    const tabs = ["ALL", ...POS_LIST];
    el.innerHTML = tabs
      .map((t) => `<button class="pos-tab ${t === state.ui.posFilter ? "active" : ""}" data-pos="${t}">${t}</button>`)
      .join("");
    el.querySelectorAll(".pos-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.ui.posFilter = btn.dataset.pos;
        renderPosTabs();
        renderTable();
      });
    });
  }

  function applySettingsFromForm() {
    state.settings.teams = parseInt(document.getElementById("cfgTeams").value, 10) || 12;
    state.settings.myPos = parseInt(document.getElementById("cfgSlot").value, 10) || 1;
    state.settings.tierSensitivity = document.getElementById("cfgTierSensitivity").value;
    document.querySelectorAll("#rosterCfg input[data-slot]").forEach((input) => {
      state.settings.slots[input.dataset.slot] = parseInt(input.value, 10) || 0;
    });
    saveSettings();
    if (state.players.length) computeTiers(state.players);
    renderAll();
    toast("Settings applied.");
  }

  function populateSettingsForm() {
    document.getElementById("cfgTeams").value = state.settings.teams;
    document.getElementById("cfgSlot").value = state.settings.myPos;
    document.getElementById("cfgTierSensitivity").value = state.settings.tierSensitivity;
    document.querySelectorAll("#rosterCfg input[data-slot]").forEach((input) => {
      input.value = state.settings.slots[input.dataset.slot] ?? 0;
    });
  }

  function init() {
    populateSettingsForm();
    renderPosTabs();
    loadOffenseRankings();

    document.getElementById("csvInput").addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => loadFromCsvText(String(reader.result), { resetDraft: true });
      reader.readAsText(file);
      e.target.value = "";
    });

    document.getElementById("loadSampleBtn").addEventListener("click", async () => {
      try {
        const res = await fetch("agg_rankings.csv");
        if (!res.ok) throw new Error("not found");
        const text = await res.text();
        loadFromCsvText(text, { resetDraft: true });
      } catch {
        toast("Couldn't fetch the sample file — serve this folder over http, or use Load CSV to upload it manually.");
      }
    });

    document.getElementById("resetBtn").addEventListener("click", () => {
      if (!confirm("Reset the whole draft? This clears all picks, your queue, and roster.")) return;
      localStorage.removeItem(LS_KEYS.status);
      state.queue = new Set();
      saveQueue();
      for (const p of state.players) {
        p.status = "available";
        p.pick = null;
        p.slot = null;
      }
      state.slotAssignments = {};
      state.actionHistory = [];
      persistAll();
      renderAll();
      toast("Draft reset.");
    });

    document.getElementById("undoBtn").addEventListener("click", undoLast);

    document.getElementById("searchBox").addEventListener("input", (e) => {
      state.ui.search = e.target.value;
      renderTable();
    });

    document.getElementById("hideDraftedToggle").addEventListener("change", (e) => {
      state.ui.hideDrafted = e.target.checked;
      renderTable();
    });

    document.querySelectorAll("th.sortable").forEach((th) => {
      th.addEventListener("click", () => {
        const key = th.dataset.sort;
        if (state.ui.sortKey === key) {
          state.ui.sortDir *= -1;
        } else {
          state.ui.sortKey = key;
          state.ui.sortDir = 1;
        }
        renderTable();
      });
    });

    document.getElementById("settingsToggle").addEventListener("click", () => {
      const body = document.getElementById("settingsBody");
      const btn = document.getElementById("settingsToggle");
      const open = body.hidden;
      body.hidden = !open;
      btn.setAttribute("aria-expanded", String(open));
    });

    document.getElementById("applySettings").addEventListener("click", applySettingsFromForm);

    document.getElementById("playersBody").addEventListener("click", (e) => {
      const tr = e.target.closest("tr.player-row");
      if (!tr) return;
      const id = tr.dataset.id;
      const actionBtn = e.target.closest("[data-action]");
      if (actionBtn) {
        const action = actionBtn.dataset.action;
        if (action === "me") draftPlayer(id, "me");
        else if (action === "other") draftPlayer(id, "other");
        else if (action === "reset") resetPlayer(id);
        else if (action === "star") toggleQueue(id);
        return;
      }
      if (state.ui.expanded.has(id)) state.ui.expanded.delete(id);
      else state.ui.expanded.add(id);
      renderTable();
    });

    document.getElementById("myTeam").addEventListener("click", (e) => {
      const unassignId = e.target.closest("[data-unassign]");
      if (unassignId) {
        const slotId = unassignId.dataset.unassign;
        const pid = state.slotAssignments[slotId];
        if (pid) {
          const p = state.byId.get(pid);
          delete state.slotAssignments[slotId];
          p.slot = null;
          persistAll();
          renderMyTeam();
          renderUndoButton();
        }
      }
    });

    document.getElementById("myTeam").addEventListener("change", (e) => {
      const select = e.target.closest("[data-manual-assign]");
      if (!select) return;
      const pid = select.dataset.manualAssign;
      const slotId = select.value;
      if (!slotId) return;
      const p = state.byId.get(pid);
      state.slotAssignments[slotId] = pid;
      p.slot = slotId;
      persistAll();
      renderMyTeam();
    });

    document.getElementById("queueList").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-unqueue]");
      if (!btn) return;
      toggleQueue(btn.dataset.unqueue);
    });

    document.getElementById("themeToggle").addEventListener("click", () => {
      const root = document.documentElement;
      const current = root.getAttribute("data-theme");
      const next = current === "dark" ? "light" : current === "light" ? null : "dark";
      if (next) root.setAttribute("data-theme", next);
      else root.removeAttribute("data-theme");
      localStorage.setItem(LS_KEYS.theme, next || "");
    });

    const savedTheme = localStorage.getItem(LS_KEYS.theme);
    if (savedTheme) document.documentElement.setAttribute("data-theme", savedTheme);

    ["dragover", "drop"].forEach((evt) => {
      document.body.addEventListener(evt, (e) => e.preventDefault());
    });
    document.body.addEventListener("drop", (e) => {
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => loadFromCsvText(String(reader.result), { resetDraft: true });
      reader.readAsText(file);
    });

    const savedCsv = localStorage.getItem(LS_KEYS.csv);
    if (savedCsv) {
      loadFromCsvText(savedCsv, { resetDraft: false });
    } else {
      renderAll();
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
