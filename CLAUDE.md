# CLAUDE.md — GOHA Suno Helper

Chrome extension (MV3) + local Python bridge (MCP server) that lets an AI assistant work Suno for the user:
WAV download via Studio export, 32-bit float export, stem split, and Create. Free for the community (MIT),
published at **github.com/Hieupi/goha-suno-helper** (GitHub login is `Hieupi`, lower-case p — never "HieuPi").
This folder is the only place GOHA Suno Helper is developed.

## Talking to the owner
- Everything the owner reads or acts on: **Vietnamese**, Markdown.
- Before any piece of work, write a short plan (goal, steps, cost in credits/time, checks) in `plans/<yymmdd-hhmm>-<slug>/plan.md`
  (git-ignored), show it, then execute. The owner has given full authority to build, test, commit, push and release.
- End every reply with `**Đề xuất:** <best next step>`.

## Layout
```
extension/          MV3 extension (lib/ logic, ui/ side panel, tests/ node --test, dev/ preview, tools/)
bridge/scripts/     bridge: suno_agent_bridge.py (MCP + ws://127.0.0.1:47831), suno_bridge_core.py (pairing, queue,
                    results), suno_jobs.py (job kinds + store), suno_projects.py (projects), suno_clip_status.py
bridge/tests/       Python tests (unittest)
installer/          CAI-DAT.bat + cai_dat.py (writes extension/install.json)
tools/build_release.py   builds dist/GOHA-Suno-Helper-<version>/ + .zip and checks it
HUONG-DAN.md · README.md · LICENSE   ship inside the package as-is
plans/              private plans (git-ignored)
```
`bridge/scripts` still carries the channel's episode modules (episode_audio, suno_generation, export_download_handoff,
validate_suno): the episode tools only register when an `episodes/` folder sits next to `bridge/`. Moving them out into a
channel plugin is planned (plans/261001-2335-tach-thanh-repo-phat-trien).

## Commands
- Extension tests: `cd extension && node --test tests/*.test.mjs`
- Bridge tests: `python -m unittest discover -s bridge/tests -t bridge`
- Side panel preview: serve `extension/` over http (e.g. `python -m http.server 47890 --directory extension`) and open
  `/dev/panel-preview.html#about`. Regenerate it after editing sidepanel.html: `node extension/tools/make-panel-preview.mjs`.
- Build the package: `python tools/build_release.py`

## Release (owner pre-approved)
1. Bump `extension/manifest.json` (`version`, `version_name`) **and** `BRIDGE_VERSION` in `bridge/scripts/suno_bridge_core.py`
   together (the bridge tells an older extension to reload).
2. Both test suites green → `python tools/build_release.py` (refuses secrets, machine paths, channel data; starts the
   packaged bridge and checks its tool list).
3. Commit (conventional, no AI attribution), push `main`.
4. `gh release create v<version> dist/GOHA-Suno-Helper-<version>.zip --repo Hieupi/goha-suno-helper --title "GOHA Suno Helper <version>" --notes-file <vi notes>`
5. Google Drive folder `1B1P6N31hwHpsXf9rft6C5vbH_WaaoVYf` (public; also linked from the About tab and README):
   `/c/rclone/rclone.exe copy dist/GOHA-Suno-Helper-<v>.zip goha-drive: --drive-root-folder-id 1B1P6N31hwHpsXf9rft6C5vbH_WaaoVYf`,
   then `deletefile` the previous zip (goes to Drive trash) so nobody downloads a stale build.
6. To test a release for real: unzip into a clean temp folder, run its CAI-DAT.bat, run its bridge
   (`bridge/scripts/suno_bridge_host.py` is NOT shipped — use the MCP server), and drive dry runs.

## Credit safety (never weaken)
- Create and stem Extract spend credits. A real job needs `dry_run=false` **and** `confirm_spend=true`; requeue of a real
  generate/stems job needs `confirm_spend`; a real project Create is refused while an earlier real one is queued, out or
  `unknown`, unless `allow_additional`.
- A stems job marks `spent` before the click; any retry is sent `alreadySpent` and never presses Extract again.
- "Already split" = Suno fetched `/api/clip/<id>/stems?page=` after the dialog opened (stem lanes can draw 9 s later);
  "not split" = `/stems/pages` answered 200 with no page requests. Only requests since the dialog opened count.
- The extension never presses Extract when the bridge link is down; an `unknown` real job is never retried automatically.
- Owner's Suno credits: dry runs first. Real runs on the owner's account only with the owner's OK.

## Things learned the hard way
- Measure Suno's UI live before writing a selector (Claude in Chrome on the owner's logged-in Chrome); Suno changes UI.
- Open in Studio from the stems dialog fully reloads the page: the controller registers `await_load` before the click.
- The song "···" menu sometimes opens late; the driver retries the Edit → Get Stems sequence once after Escape.
- `py -3` may pick a free-threaded build (`python3.14t`) that cannot install the bridge libraries — the installer skips "t" builds.
- Windows user names with diacritics: set `PYTHONUTF8=1` before Python prints any path.
- Bash heredocs in this environment can mangle backslashes: edit Windows-path strings with the Edit tool.
- Every Suno UI change can break every user: keep fixes small, ship fast, note the evidence in the commit.
