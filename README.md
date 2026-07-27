# Draft Dashboard

A single-page draft companion for fantasy football. Drop in a rankings CSV
(like `agg_rankings.csv`) and use it side-by-side with whatever site you're
drafting on.

## Running it

Browsers block `fetch()` of local files opened via `file://`, which the
"Load sample" button needs, so serve the folder instead of double-clicking
`index.html`:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000/`.

(You can still open `index.html` directly and use the "Load CSV" button or
drag-and-drop to load a file — that path doesn't need the server.)

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
- **Persistence** — your loaded CSV, picks, roster, and settings are saved
  to `localStorage`, so a page refresh mid-draft doesn't lose progress.
  "Reset draft" clears picks/roster/queue; loading a new CSV starts fresh.
- **Dark mode** toggle for late draft nights.

No build step, no dependencies — just static HTML/CSS/JS.
