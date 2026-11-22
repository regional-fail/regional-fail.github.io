# Regional Fail: research findings (step 1)

Researched 2026-11-22. Everything below comes from a primary source or from data we pulled ourselves. Scripts are in this folder, so every number can be regenerated.

---

## 1. Live data and the timetable: cancellation tracking is feasible ✅

**Sources**
- Live train positions: `https://www3.septa.org/api/TrainView/index.php` (no key). Each train has its number, line, lat/lon, next stop, minutes late, cars, origin and destination.
- Timetable (GTFS): SEPTA's official GitHub, `github.com/septadev/GTFS/releases`. Release `v202611220` is valid 2026-11-22 to 2027-02-20. The rail feed is `google_rail.zip` inside `gtfs_public.zip`.
- Realtime trip updates (GTFS-RT): `https://www3.septa.org/gtfsrt/septarail-pa-us/Trip/rtTripUpdates.pb`
- Service alerts (GTFS-RT): `https://www3.septa.org/gtfsrt/septarail-pa-us/Service/rtServiceAlerts.pb`, plus the older JSON at `/api/Alerts/index.php`

**Matching test** (`match_test.mjs`, run Sunday 2026-11-22 at 17:22 ET):
- 230 trains scheduled that day and 22 in the live feed.
- All 17 trains that should have been mid-trip were in the live feed: **0 missing and 0 unknown.**
- In the timetable, the train number is `block_id` (also `trip_short_name` minus the line prefix), and it matches TrainView's `trainno`.

**Quirks to handle**
- `late: 999` means a train hasn't started reporting or hasn't departed yet, and its `currentstop` is stale. It isn't a 999-minute delay.
- Train numbers can carry a letter suffix (seen: `1723P`). Strip it to match.
- **Through-routed trains:** one train number can cover two lines (e.g. Trenton → Center City → Chestnut Hill East). The timetable has one trip per line, while TrainView shows a single `line` that changes mid-run. We'll score each leg against the line it's on.
- **Inbound/outbound** comes from `directions.txt`, and `direction_id` is **not** consistent across lines. For example, 0 = Inbound on Airport but 0 = Outbound on Chestnut Hill East, so we always look it up.
- The realtime trip-update feed covered only 5 trips while TrainView showed 22, so it's incomplete. **TrainView is the primary source.** The logger will still record any trip the realtime feed marks other than `SCHEDULED` (e.g. `CANCELED`) so we learn whether SEPTA ever uses that flag.
- No cancellations were announced when we checked (Sunday evening). Current alerts mention things like the Fox Chase bus shuttle starting Dec 7.

**Cancellation rules (proposed)**
- **Inferred ghost train:** scheduled, but never seen in TrainView from 15 minutes before its scheduled departure until 30 minutes after its scheduled arrival.
- **Confirmed ghost train:** a SEPTA alert names the train number as canceled.
- **Partial cancellation:** the train ran but terminated early or started late (it was seen, but not at its scheduled ends). We should track this separately.
- **Timetable baseline:** the logger saves each day's scheduled train list from the GTFS version in effect that morning. If a later GTFS release quietly drops trips for a date we already captured, those count as **pre-canceled** trips, not "never scheduled."
- **Planned bus substitutions** (e.g. Fox Chase weekday middays from Dec 7) don't appear in the rail timetable. They're reported as "bus bridges," not counted as ghost trains, and stated plainly on the site.

---

## 2. National Transit Database: SEPTA vs. peer commuter railroads

Source: FTA National Transit Database via `data.transportation.gov`. Scripts: `fetch_ntd.mjs` downloads the data and `analyze_ntd.mjs` builds the tables. NTD "report year 2025" is each agency's fiscal year 2025 (for SEPTA, July 2024 to June 2025), so **it ends before the Silverliner IV fires and federal emergency order in fall 2025.**

### What the data supports ✅

**SEPTA has the oldest commuter rail fleet among its peers.**

| Railroad | Vehicles | Avg age (yrs) | Share 31+ yrs old |
|---|---:|---:|---:|
| **SEPTA** | 411 | **36.4** | **66.2%** |
| Metra | 1,450 | 33.9 | 43.8% |
| NJ Transit | 1,306 | 26.4 | 27.7% |
| MBTA | 534 | 25.4 | 51.1% |
| MARC | 225 | 23.9 | 30.2% |
| Metro-North | 1,278 | 21.9 | 20.0% |
| LIRR | 1,254 | 19.8 | 4.8% |
| Caltrain | 176 | 7.5 | 0.0% |

The fleet is getting older every year: average age was 33.1 years in 2022 and 36.4 in 2025.

**SEPTA receives the least capital (infrastructure and vehicle) funding per rider of any peer.**

| Agency (all modes) | Capital $ per trip | State capital $ per trip |
|---|---:|---:|
| **SEPTA** | **$3.05** | $1.66 |
| NJ Transit | $4.32 | $2.11 |
| MBTA | $7.47 | $4.60 |
| MARC (MD MTA) | $9.52 | $1.74 |
| LIRR | $10.60 | $2.89 |
| Metra | $13.46 | — |
| Metro-North | $13.98 | $0.53 |
| Caltrain | $28.32 | $13.40 |

### What the data contradicts ⚠️

**SEPTA Regional Rail is the cheapest railroad to run, per trip and per hour, and its admin share is among the lowest.**

| Railroad | Cost per trip | Cost per vehicle-hour | General admin share of opex |
|---|---:|---:|---:|
| MARC | $42.48 | $1,184 | 15.0% |
| Metra | $26.98 | $684 | 21.1% |
| NJ Transit | $24.54 | $826 | 17.2% |
| LIRR | $22.11 | $852 | 16.0% |
| Metro-North | $21.60 | $830 | 19.3% |
| MBTA | $20.79 | $662 | 28.3% |
| Caltrain | $19.87 | $739 | 30.0% |
| **SEPTA** | **$14.12** | **$385** | **15.3%** |

So "the budget is bloated and executives are pocketing it" **is not supported by the federal data.** SEPTA's documented corruption cases are real, but they total roughly $1M. That's a scandal, not a structural cause.

### Mixed

**Breakdowns:** SEPTA ranks 3rd worst of 8 on car-miles between major mechanical failures (127,549). That's better than MBTA (100,955) and MARC (37,968) and far behind Metro-North (1.36M). The figure jumps around year to year: 80K in 2022, 140K in 2023, 82K in 2024 and 128K in 2025. Agencies report their own breakdowns, so definitions may differ.

**State operating funding per agency-wide trip:** SEPTA gets $4.44, versus NJ Transit $4.32, MBTA $7.00, LIRR $13.27 and Metro-North $12.41. SEPTA sits mid-to-low, well below Boston and New York.

### Caveats for anything we publish
- Funding tables are **whole-agency** (buses, subway and trolleys included). SEPTA, MBTA and NJ Transit are multimodal, while LIRR, Metro-North, Metra and Caltrain are rail-only. "MARC" funding is all of Maryland Transit Administration.
- Each state routes money differently. For example, Boston's dedicated sales tax shows up as state money, Chicago's RTA money as local, and NJ Transit reports no local funding. Per-trip totals are fairer to compare than any single funding category.
- Cost per trip partly reflects trip length. SEPTA's cost per **passenger-mile** ($1.08) is mid-pack, not cheapest.
- Agencies self-report and the NTD flags questionable values (the `_1`/`_questionable` fields). Check those flags before publishing a specific number.

### Decided framing (2026-11-22): "Starved & mismanaged"
SEPTA is underfunded for capital and runs the oldest fleet, **and** SEPTA is accountable for how it manages what it has: running cars past their safe life, moving capital money into operating costs, paying for ad campaigns and the documented corruption cases. The site never claims the budget is being pocketed.

### What this means for the story
The data points to **a starved, aging railroad, not a bloated one.** The fleet is the oldest of its peers and getting older, it has the lowest capital investment per rider, and it runs cheaply. That still holds SEPTA accountable: it's SEPTA that runs 1970s railcars until they catch fire, chose to move $394M of capital money into operating costs, and spent on billboards rather than repairs. But **the dashboard shouldn't claim the budget is being pocketed.** The numbers say otherwise, and a critic with NTD access could disprove it in an afternoon.

---

## 3. SEPTA's own published performance numbers

- **SEPTA's own on-time definition** (per news coverage, needs confirmation from a SEPTA document): a train is on time if it completes its trip **within 6 minutes** of schedule. Its service standard is **90%**. Reported recent figures: 81.8% (Jan 2025) and 87% (spring 2025 schedule period).
- SEPTA's KPI dashboard (`septa.org/tracking-progress`) lists **"Percent of Scheduled Service Delivered"** and **"Percent of schedule timepoints delivered on time (by mode)"**. "Scheduled service delivered" is SEPTA's own cancellation measure, so it's a natural fit for "SEPTA Said vs. Reality." The numbers render in JavaScript, so they need to be read in a browser.
- SEPTA's open data portal (ArcGIS) **requires accepting a license agreement** to download data. The license allows reproducing and redistributing data, bars commercial use of SEPTA trademarks, and lets SEPTA revoke access at any time. **We haven't accepted it.** That's your call, and we don't need it for version 1.
- A third-party on-time report exists at `apps.phor.net/septa/` (not SEPTA), and a Code for Philly project archived arrival data. Both are possible historical sources, but they need checking.

## 4. Open items
- [ ] Confirm SEPTA's on-time definition and 90% target from a SEPTA document
- [ ] Read SEPTA's KPI dashboard values in a browser
- [ ] Source the 2016 Silverliner V crack event (timeline)
- [ ] Billboard campaign date and, if possible, cost
- [ ] Choose a free traffic data source for the driving comparison (TomTom, HERE or 511PA)
- [x] Check the terms of use for SEPTA's real-time API and GTFS before publishing (see section 5)

## 5. SEPTA's terms of use (checked 2026-11-22; not legal advice)

Documents read: the GTFS "SEPTA License Agreement" for Trip Planning Data on `www3.septa.org/developer` (agreement dated 18 Mar 2014), the Open Data Portal "License Agreement" at `wwww.septa.org/license-agreement/` (undated), and the "Copyright & Trademark Disclaimer" at `wwww.septa.org/copyright/`.

**Timetable (GTFS)**
- Grants a non-exclusive, limited, revocable right to **use, reproduce and redistribute** the data. Publishing our timetable cache and statistics derived from it fits that grant. Derived statistics aren't mentioned either way.
- The commercial restriction applies to **SEPTA's trademarks and copyrighted materials**, not to the data. We're non-commercial and use no logos.
- The developer page download needs a click-through acceptance. **We download from SEPTA's own GitHub releases (`septadev/GTFS`), which has no license file or click-through.** Cleanest fix: the project owner accepts the agreement once on the developer page. That's the owner's action to take, not automated.
- Licensee **indemnifies SEPTA** for claims arising from use. Pennsylvania law governs. SEPTA can revoke the license, change the data or start charging at any time.

**Real-time feeds (TrainView, Alerts, GTFS-realtime)**
- **No terms found.** No API key, rate limit, attribution rule or prohibited-use list on any SEPTA page we read. The website copyright notice restricts copying "content" without consent outside informational, non-commercial use. Whether that reaches data feeds is unclear. Our use is informational and non-commercial.
- Our load is light: 4 small requests every 5 minutes (about 1,150 a day), with a User-Agent naming the project.

**Criticism and affiliation**
- Nothing restricts criticism of SEPTA, and nothing requires a disclaimer. Both pages now state the data sources, that numbers are our calculations provided as is, and that the project isn't affiliated with or endorsed by SEPTA.

**Residual risks:** the license is revocable, and SEPTA could block or change the feeds. The logger records feed failures as data gaps, never as SEPTA failures.
