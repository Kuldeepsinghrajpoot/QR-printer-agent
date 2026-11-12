# QRtoPrint Agent - Powered by Lexical Software

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

## Publish an app update to GitHub

The installed app checks GitHub Releases for newer versions. To publish an update:

1. Make sure `Kuldeepsinghrajpoot/Agent-printer` has at least one commit and is public.
2. Increase `version` in `package.json`.
3. Set a GitHub token with permission to create releases as `GH_TOKEN`.
4. Run `npm run release`.

Electron Builder creates the Windows installer and updater metadata (`latest.yml`) in `dist` and uploads them to a GitHub Release. Do not upload a hand-written `latest.yml`; it contains hashes and filenames for that exact installer.

Self-updates work in the installed Windows app, not in `npm start`. `npm run fake-update` previews the update button without publishing a release.

## How the Printers tab works

`main.mjs` runs `scan.ps1` through Windows PowerShell and sends the JSON result to the window.
Node-side application modules use ES modules. The renderer uses browser scripts, and Electron's sandboxed preload stays CommonJS in `preload.cjs`.
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

## Colour test page

If colour orders come out black & white, open the **Print Agent** tab and press **Test colour** next to the printer.
It prints a page of coloured bars through exactly the same path real orders use. Grey bars mean the printer driver is
ignoring the colour request: open the printer's *Printing Preferences*, set **Color** (untick "Print in grayscale" /
"Black & white") and press Apply. The agent also logs a warning when Windows refuses to keep the colour setting.
**Test B&W** prints the same page as a black & white job, for comparison.

## TCP/IP printers that Windows shows as "Offline"

Windows sometimes marks a network (TCP/IP) printer "Offline" or ticks "Use Printer Offline" even though it answers on its
IP address (common when the same printer is also plugged in by USB, or after a driver status-polling hiccup). Before a job the
agent now tests the printer's IP and port itself. If it answers, the agent clears the offline flag and prints, and writes a note
in the Activity log. If the printer does not answer, or the printer is USB, the job is still refused with the same clear message.

## Pages per sheet and flip edge

Orders can ask for 2, 4, 6, 9 or 16 pages per sheet and for double-sided printing that flips on the long or the short edge.
- **Pages per sheet** is done by the agent itself (`agent/nup.js`, uses the `pdf-lib` package): it lays the pages out on new sheets and
  prints that PDF. 2-up and 6-up use a landscape sheet. Only PDFs can be laid out; other file types print normally and the Activity log says so.
  Run `npm install` once after updating, because `pdf-lib` is a new dependency.
- **Flip edge** sets Windows' duplex mode (`TwoSidedLongEdge` / `TwoSidedShortEdge`) and SumatraPDF's `duplexlong` / `duplexshort`.
  Print one test sheet per printer first: some drivers treat long/short edge differently for landscape sheets (2-up, 6-up).


## Shop online status (dashboard)

While the app is open and an AGENT_API KEY is set, it sends `POST /api/agent/heartbeat` every 15 seconds (header `x-agent-key`),
and one last beat with `status: "offline"` when you quit. Body:

```json
{ "agentId": "uuid", "agent": { "hostname": "...", "appVersion": "1.0.13" }, "status": "online" | "offline",
  "seq": 12, "sentAt": "ISO date", "printers": { "total": 2, "online": 1 } }
```

Server side: store `lastSeenAt` (and `status`) for the shop that owns the agent key. Treat the shop as **online** when
`status === "online"` and `lastSeenAt` is less than 45 seconds old; otherwise offline (this also covers a crash, power cut or no internet).
Until that route exists the server answers 404 and the Activity log shows a one-time note.
