# Printer Monitor + Print Agent

One Windows app with two jobs:

1. **Printers tab** — live printer monitor (see below).
2. **Print Agent tab** — the Print Agent: it checks your dashboard for paid orders, downloads the file, prints it on the right printer (B&W / Color, copies, duplex), and reports back. It also sends each printer's real health (online / offline / paper jam / out of paper / low ink) to the dashboard, using the same scan as the Printers tab.

Closing the window keeps the agent running in the system tray (Quit from the tray icon). Run it on **one** PC only.

### First-time setup of the agent
1. `npm install`, then `npm start` (or install the built app).
2. Open the **Print Agent** tab, enter your dashboard URL and the **AGENT_API KEY** (same value as `AGENT_API_KEY` on the server), click **Save & restart agent**.
3. Printers on this PC appear automatically; set each printer's type (B&W / Color) in the dashboard → Printers.

Settings are stored in `%APPDATA%\printer-monitor\agent-config.json` (this is a new app, so settings from the old standalone agent are not carried over).

### Agent notes
- Duplex orders also set the Windows printer's duplex mode for the job, then restore it.
- After printing, the agent waits until the job leaves the Windows print queue; if the printer is offline / paused / out of paper the order is marked **Failed** with the reason (and the stuck job is removed so it can't print later).
- Download/server errors show the server's own message in **Recent activity**.

---

# Printer Monitor

A Windows Electron app that shows:

- how many printers are **installed**
- how many are **connected** vs **disconnected** (virtual printers such as "Microsoft Print to PDF" are counted separately)
- each printer's **status**, **paper state** (OK / low / out / jam), toner warnings, queued jobs, port, IP address and driver

## Run

```bat
npm install
npm start
```

## Build an installer

```bat
npm run build
```

The installer is created in the `dist` folder.

## How the Printers tab works

`main.js` runs `scan.ps1` through Windows PowerShell and sends the JSON result to the window.
The script uses `Win32_Printer`, `Get-Printer`, `Get-PrinterPort`, `Get-PrintJob` and `Get-PnpDevice`.

How "connected" is decided:

| Port type | Check |
| --- | --- |
| Network (TCP/IP) | Opens a TCP connection to the printer's IP and port (usually 9100) |
| Network (IPP, `http://...` ports) | Opens a TCP connection to the host and port from the URL |
| Network (WSD) | Looks for the live WSD device on the network, then pings its IP; if it is not discovered, it shows as disconnected |
| USB | Windows offline flag, plus a check that a USB printer device is present |
| Shared / other | Windows offline flag ("Use Printer Offline" or status Offline), not independently verified |
| Virtual (PDF, XPS, OneNote, Fax, HP Smart Printing) | Always shown as "Virtual" |

## Auto-restart

- If the window's renderer process crashes, or the window is frozen for 10 seconds, the window is rebuilt automatically.
- If the main process hits an uncaught error, the app relaunches itself.
- To avoid crash loops it gives up after 5 quick restarts in a row (running for 60 seconds counts as stable and resets the counter) and shows an error message.
- Crashes are logged to `crash.log` in the app's data folder (`%APPDATA%\printer-monitor`).

## Limitations

- Paper and toner come from what the driver reports to Windows. Most printers report problems
  (low paper, out of paper, jam) but not an exact paper level. "Not reported" means the driver
  gave no information. Exact paper/toner levels need SNMP or a vendor tool.
- If several USB printers are installed, the USB check only confirms that at least one USB
  printer device is attached, so unplugged USB printers are mainly detected through Windows'
  offline flag.
- Printer scans take a couple of seconds, longer if network printers are unreachable.

## Development on non-Windows

On macOS/Linux (or with `PRINTER_MONITOR_MOCK=1`) the app shows sample data so the UI can be developed.

## App updates (GitHub Releases)

The window shows an **Update available** button in the top bar only when a newer version exists on GitHub; otherwise
the button is hidden. Clicking it downloads the update, installs it silently and restarts the app (if an order is
printing, it waits until that print is finished). The app checks 20 seconds after start and then every 4 hours; the
tray icon also has **Check for updates**.

One-time setup
1. In `package.json` -> `build.publish` replace `YOUR_GITHUB_USERNAME` and `YOUR_REPO_NAME` with your GitHub repo.
   The repo (or at least its Releases) must be **public**: a private repo would need a token inside the app, which is unsafe.
2. Run `npm install` (adds `electron-updater`).
3. Install the app once from the new installer (`npm run build` -> `dist\Printer Monitor Setup x.y.z.exe`).
   Older installs without this feature cannot update themselves.

Publishing an update
1. Raise `version` in `package.json` (for example 1.0.0 -> 1.0.1).
2. Create a GitHub personal access token with `repo` scope and set it: `set GH_TOKEN=ghp_xxx` (Windows cmd).
3. Run `npm run release`. It builds the installer and uploads it and `latest.yml` to a new GitHub Release.
   Every installed copy shows the Update button within 4 hours (or right after a restart / "Check for updates").

Testing the button without a release: `npm run fake-update` shows a fake "v9.9.9" update after 3 seconds and simulates the download.
Updates only work in the installed Windows app, not in `npm start`.
