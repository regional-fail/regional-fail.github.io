# Deploying Regional Fail to GitHub

Everything runs free on a **public** GitHub repo: Actions does the logging, Pages hosts the site.

## What runs where

| Workflow | When | What it does |
|---|---|---|
| `poll.yml` | every 5 min | Polls SEPTA, updates the `live` branch, archives finished days to `main` and `traces-YYYY` |
| `pages.yml` | on site changes + daily | Builds and publishes the website |
| `test.yml` | every push / PR | Runs the rule tests |
| `yearly-release.yml` | Jan 2 | Publishes last year's data as a GitHub Release |

Branches: `main` (code + daily archive), `live` (current state, always one commit), `traces-YYYY` (map replay data).

## One-time setup

0. **Accept SEPTA's GTFS license yourself.** Read the "SEPTA License Agreement" on https://www3.septa.org/developer and accept it there if you agree. The footer states the timetable is used under that agreement, and the logger downloads the same data from SEPTA's GitHub releases. Summary of the terms is in `research/FINDINGS.md`, section 5.

1. **Repo name: `regional-fail.github.io`** (decided). The site lives at `https://regional-fail.github.io/`. `REPO` in `site/js/common.js` is already set to `regional-fail/regional-fail.github.io`.

2. **Commit identity (optional anonymity).** In this folder, set a project-only name and GitHub's private noreply email (GitHub → Settings → Emails shows it):
   ```powershell
   git init -b main
   ```
   ```powershell
   git config user.name "Regional Fail"
   ```
   ```powershell
   git config user.email "<your-id>+<username>@users.noreply.github.com"
   ```

3. **Create the repo** under the organization: public, empty (no README), named `regional-fail.github.io`.

4. **Push.**
   ```powershell
   git add -A
   ```
   ```powershell
   git commit -m "Regional Fail v1"
   ```
   ```powershell
   git remote add origin https://github.com/regional-fail/regional-fail.github.io.git
   ```
   ```powershell
   git push -u origin main
   ```

5. **Repo settings**
   - **Settings → Pages → Build and deployment → Source: GitHub Actions.**
   - **Settings → Actions → General → Workflow permissions:** "Read and write permissions" (the poller pushes to `live`, `main` and `traces-YYYY`).

6. **Start it.** Actions tab → "Poll SEPTA" → Run workflow (the schedule takes over after that), then "Deploy site" → Run workflow.
   The site appears at `https://regional-fail.github.io/`.

7. **Stop the local logger** once GitHub is polling, so you're not running two loggers. (They don't conflict, but only GitHub's data is published.)

## Things to know
- **Scheduled runs can be late or skipped** when GitHub is busy. Gaps show up as "unknown" trains, never as SEPTA failures, and each day's record lists our own polling gaps.
- **GitHub disables scheduled workflows after 60 days without repo activity.** The poller's daily archive commit counts as activity.
- **raw.githubusercontent.com caches files for up to about 5 minutes**, so the site can be up to about 10 minutes behind SEPTA.
- Pushes made by the workflows don't trigger other workflows, which is why the site also rebuilds daily (to pick up timetable changes).
- **Before going public:** check SEPTA's terms of use for its real-time API and GTFS feed (see open items in `research/FINDINGS.md`).
