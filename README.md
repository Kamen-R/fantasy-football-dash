# Draft Dashboard

A single-page draft companion for fantasy football. Drop in a rankings CSV
(like `agg_rankings.csv`) and use it side-by-side with whatever site you're
drafting on.

## Running it

Browsers block `fetch()` of local files opened via `file://`. That breaks
three things if you just double-click `index.html`: the "Load sample"
button, the team offense strength icons (🔥/🧊 — loaded from
`offense_rankings.csv`), and the ADP-source vs-ADP numbers (loaded from
whichever file `adp_underdog.csv`-style source is selected in League
settings). Serve the folder instead:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000/`. If a fetch-based feature fails to load
(e.g. you're on `file://`, or a file is missing), the app shows a toast
saying so rather than failing silently.

(You can still open `index.html` directly and use the "Load CSV" button or
drag-and-drop to load a player CSV — that path doesn't need the server,
since it reads the file locally rather than fetching it.)

## Features

- **Load any CSV** — upload, drag-and-drop, or load the bundled sample.
  Column detection is name-based (Name/Player, Pos/Position, Team, Bye, ADP,
  Rank, Notes, …) so a differently-formatted rankings export should still
  work; unrecognized numeric/rank columns show up in each player's expanded
  detail row.
- **Live filtering** — search by name/team, filter by position, hide
  drafted players.
- **One-click drafting** — mark a player "Mine" or drafted by someone else;
  undo the last pick.
- **My Team** — auto-assigns your picks to open roster slots (configurable
  QB/RB/WR/TE/FLEX/K/DST/bench counts), with manual reassignment.
- **On the clock** — enter your league size and draft slot to see picks
  made, current round/pick, and how many picks until you're back up
  (snake-draft aware).
- **Best available & remaining counts** — quick per-position glance at
  who's left.
- **Queue** — star players to track as a personal watchlist.
- **Tiers** — players within a position grouped by value, always ordered by
  rank so a worse-ranked player can never sit in a better tier than one
  ranked ahead of them. Tier breaks come from projected-points gaps where a
  position has enough projection data, otherwise from rank gaps. Tight/
  Medium/Loose sensitivity in League settings.
- **Volatility** — how much the expert-rank columns in your CSV disagree on
  a player (Steady/Mixed/Volatile), plus a 🎲 icon for the volatile ones.
- **Injury risk icons** — 🛡️ for the safest quartile, 🚑 for the riskiest,
  computed from the CSV's Injury Risk column.
- **Team offense icons** — 🔥 for players on a top-10 offense, 🧊 for a
  bottom-6 offense, from the bundled `offense_rankings.csv`.
- **ADP source picker** — vs ADP is computed from your own rank against a
  selectable external ADP source (League settings), falling back to the
  CSV's own ADP column for players that source doesn't cover.
- **Draft strategy tracker** — tracks 7 named draft strategies (Elite TE,
  Elite QB, Robust RB, Robust WR, Balanced, Late QB/TE, Double Anchor RB)
  live against your picks, each shown as achieved/eliminated/still
  available with a tooltip explaining the rule.
- **Multi-level undo** — not just the last pick; undo back through your
  whole pick history, or reset any single player individually.
- **Persistence** — your loaded CSV, picks, roster, and settings are saved
  to `localStorage`, so a page refresh mid-draft doesn't lose progress.
  "Reset draft" clears picks/roster/queue; loading a new CSV starts fresh.
- **Dark mode** toggle for late draft nights.

No build step, no dependencies — just static HTML/CSS/JS.
