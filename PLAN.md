# Regional Fail: project plan

> **Traffic? lol. Delays? lmao.**
> A tongue-in-cheek, fully sourced dashboard of SEPTA Regional Rail's reliability.
> Framing: **starved & mismanaged.** Every claim is sourced or measured by us. See [research/FINDINGS.md](research/FINDINGS.md).

---

## 1. How it works

```
SEPTA live API ──(every 5 min)──► logger (GitHub Action) ──► today.json   (branch: live)
SEPTA timetable (GTFS) ─────────►        │
                                         └──(nightly, ~4am ET)──► daily archive   (branch: main)
                                                                  map traces      (branch: traces-YYYY)
                                                                  report card PNG + day page
Website (GitHub Pages, static) ◄── reads today.json + archives
```

- **No servers and no database.** Everything runs free on GitHub Actions and GitHub Pages (public repo).
- The website can't call SEPTA directly (SEPTA's API blocks browser requests from other sites), so it reads our own `today.json`. That file is at most about 5 minutes old.
- **Local first:** everything runs on your PC with `npm` commands before anything goes to GitHub.

## 2. Folder layout

```
regional_fail/
├─ PLAN.md
├─ package.json
├─ logger/
│  ├─ poll.mjs          # runs every 5 min: fetch live data, update today's state
│  ├─ archive.mjs       # runs nightly: finalize the day, classify trains, write archive
│  └─ lib/
│     ├─ septa.mjs      # fetch TrainView, alerts, realtime trip updates
│     ├─ gtfs.mjs       # load timetable, list a service day's scheduled trains
│     ├─ classify.mjs   # ran / ghost (confirmed|inferred) / partial; lateness
│     └─ score.mjs      # line scores, grades, rush-hour rules
├─ site/
│  ├─ index.html        # live whole-day map (the main view)
│  ├─ lines.html        # line scorecards
│  ├─ day/              # generated permanent page per day (with link-preview image)
│  ├─ js/  css/
├─ data/
│  ├─ gtfs/             # cached SEPTA rail timetable + version tag
│  └─ archive/YYYY/MM/DD.json.gz
├─ test/                # automated tests with recorded sample data
├─ research/            # step 1 scripts + findings
└─ .github/workflows/   # poll.yml, archive.yml, pages.yml, yearly-release.yml
```

**Branches:** `main` holds code and daily summaries. `live` holds only `today.json` and is replaced on each poll, so it never builds up history. `traces-YYYY` holds map replay data for each year. On each **January 1**, a GitHub Release bundles the previous year's full archive as one download.

## 3. What gets recorded

**Each poll (every 5 minutes) updates `today.json`.** For each train it keeps:

| Field | Meaning |
|---|---|
| `train`, `line(s)`, `direction` | Train number, line per leg, Inbound/Outbound to Center City |
| `sched_dep`, `sched_arr` | Scheduled first departure and last arrival, from the timetable |
| `first_seen`, `last_seen` | When it first and last appeared in the live feed |
| `first_stop_seen`, `last_stop_seen` | Used to catch trains that started late or ended early |
| `late_now`, `late_max`, `late_final` | Minutes late right now, worst so far, and at its last report |
| `cars` | Car numbers, which tell us which railcar types ran |
| `trail` | `[time, lat, lon, late]` points, added only when the train moves |
| `status` | `scheduled` / `running` / `done` / `ghost?` / `ghost` / `partial` |

It also saves raw SEPTA alerts that mention train numbers, and any realtime trip update not marked `SCHEDULED`.

**The nightly archive** splits that into a small summary (kept on `main`) and the trails (kept on `traces-YYYY`). It also stores the day's timetable version, so every result can be traced back to the schedule it was measured against.

## 4. Rules (published on the site, word for word)

**The service day** runs from 4:00am to 3:59am ET, matching SEPTA's timetable, where after-midnight trains belong to the previous day.

**Ghost trains**
- **Inferred 👻:** scheduled, but never seen from 15 minutes before scheduled departure until 30 minutes after scheduled arrival.
- **Confirmed 👻:** a SEPTA alert names that train as canceled.
- **Pre-canceled:** in that morning's timetable, but removed from a later SEPTA timetable update for the same date. It still counts.
- **Partial:** ran, but started more than 1 stop late or ended more than 1 stop early. It counts as delivered, never as on time.
- **Bus bridge:** planned bus replacement that isn't in the rail timetable. Reported, but not counted as a ghost train.

**Lateness** is the train's last reported delay before it disappears from the feed, which approximates arrival at its final stop. With 5-minute polling, this can understate the true final delay by a few minutes. That error favors SEPTA, and we'll say so.

**On time** (the only definition shown): 5 minutes late or less at the final stop. This is SEPTA's own "within 6 minutes" rule, applied to the whole minutes the feed reports. Using SEPTA's yardstick means nobody can call it unfair.

**Rush hour:** inbound trains scheduled to arrive in Center City 6:00–9:30am, and outbound trains departing 4:00–7:00pm, on weekdays.

**Line score (0–100), rolling 30 days.** Rush-hour trains count double:

```
score = 100 × ( 0.50 × delivered_rate          # trains that actually ran
              + 0.30 × on_time_rate            # SEPTA's own 5-minute rule
              + 0.20 × (1 − min(avg_late, 15) / 15) )   # how late, capped at 15 min
```
Grades: A 90+, B 80+, C 70+, D 60+, F below 60. Both directions are combined per line. A line needs enough observed trips (ran + ghost) in the period to be ranked: 20 today, 50 over 7 days, 100 over 30 days. Otherwise it's marked "not enough data."
- 🏆 **Most Reliably Unreliable:** lowest score
- 🎖️ **Actually Does Its Job:** highest score

**Days Since a Clean Rush Hour** (per line, morning and evening): a clean rush hour has no ghost trains and every train within 10 minutes. Thresholds get tuned after 2–3 weeks of real data, and any change is noted on the site.

## 5. Build order

### Version 1
1. **Logger core.** Load the timetable, poll SEPTA, update `today.json`, and classify trains. Tested against recorded sample data.
2. **Run it locally for a few hours** and check the results against what SEPTA's own app shows.
3. **Nightly archive** into gzipped daily summaries and traces.
4. **Live whole-day map**, `index.html`:
   - Lines drawn from SEPTA's own route shapes.
   - Live trains as markers colored by lateness. Finished trains as faded trails colored by final lateness. Ghost trains as 👻 at their scheduled origin.
   - Hover shows train number, line, direction, scheduled vs. actual times, worst delay and cars.
   - A time slider to replay the day, a "Traffic Conditions" banner and the tagline.
5. **Line scorecards**, `lines.html`: per line and direction, trains scheduled, ran, ghosted, on-time rate, average and worst delay, today's grade and the two awards.
6. **GitHub Actions workflows**, written and tested locally, ready for when you push.

### Version 2 (after a few weeks of data)
Daily report card image with link previews and a permanent page per day · "My Train" report card and Hall of Shame · daily grade calendar per line · Days Since a Clean Rush Hour · "SEPTA Owes You" refund counter (UK Delay Repay rules) · commute cost calculator · SEPTA Said vs. Reality · peer railroad comparison (federal data) · history timeline.

## 6. Tools and costs
- **Node.js** (already installed). Few dependencies: a zip reader for the timetable, Google's GTFS-realtime decoder, and later an image renderer for report cards.
- **Map:** MapLibre with OpenFreeMap basemap tiles. Free, with no account or key.
- **Hosting:** GitHub Pages and Actions on a public repo. Free.
- **Total cost: $0.**

## 7. Risks
| Risk | Mitigation |
|---|---|
| GitHub's scheduled jobs can run late or skip a run | A skipped poll is a 10-minute gap, still enough to catch any train. The site shows the timestamp of the last data. |
| GitHub disables scheduled jobs after 60 days with no repo activity | The nightly archive commit counts as activity |
| SEPTA changes or breaks its API | The logger records errors, and the site shows "data gap," never fake zeros |
| SEPTA's API or timetable terms of use | To check before going public (see open items in FINDINGS.md) |
| A false ghost train (API glitch) | Inferred vs. confirmed labels, a generous time window, and a gap in our own data means "unknown," never a ghost |
