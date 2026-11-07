"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listSystemPrinters = listSystemPrinters;
exports.printOrder = printOrder;
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
// Loaded lazily: pdf-to-printer only works on Windows, and the app must still start (mock mode) elsewhere.
let pdfToPrinter = null;
const pdf = () => (pdfToPrinter = pdfToPrinter || require("pdf-to-printer"));
/** "Printers" that don't print on paper (OneNote, Save-as-PDF, XPS, Fax…) — never offered or auto-linked. */
const VIRTUAL_PRINTER = /onenote|print to pdf|pdf|xps|fax|snagit|cutepdf|send to|anydesk|document writer/i;
/**
 * Lists REAL printers installed on this machine (as Windows/OS sees them).
 * Used to link dashboard printers to the exact local printer name.
 */
async function listSystemPrinters() {
    try {
        const all = await pdf().getPrinters();
        return all.filter((p) => !VIRTUAL_PRINTER.test(p.name));
    }
    catch (err) {
        console.error("Could not list system printers:", err);
        return [];
    }
}
/** Strips the giant "Command failed: <path to SumatraPDF ...>" line down to something a shopkeeper can read. */
function friendlyPrintError(err, printerName) {
    const raw = err instanceof Error ? err.message : String(err);
    const detail = raw.split("\n").slice(1).join(" ").trim(); // stderr (after the command line), if any
    const base = `Could not print on "${printerName}" — check the printer is on, connected and has paper`;
    return detail ? `${base}. ${detail.slice(0, 160)}` : base;
}
/* ───────────── Windows duplex helpers ─────────────
 * SumatraPDF (used by pdf-to-printer) asks the driver for duplex per job, but many drivers ignore that and
 * only follow the printer's own "Printing Preferences". So for duplex orders we ALSO set the printer's
 * duplex mode through Windows (Set-PrintConfiguration) and put it back afterwards. All of this is
 * best-effort: if PowerShell/permissions fail we silently fall back to the normal Sumatra duplex flag. */
const IS_WIN = process.platform === "win32";
/** Escapes a value for use inside a single-quoted PowerShell string. */
const psq = (s) => s.replace(/'/g, "''");
function runPowerShell(script, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
        execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { timeout: timeoutMs, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(String(stdout).trim())));
    });
}
/** Does Windows report automatic duplex for this printer? null = couldn't tell. */
async function printerReportsDuplex(printer) {
    try {
        const out = await runPowerShell(`$p = Get-CimInstance Win32_Printer | Where-Object { $_.Name -eq '${psq(printer)}' }; if ($p) { ($p.Capabilities -contains 3) } else { 'unknown' }`);
        const v = out.toLowerCase();
        return v === "true" ? true : v === "false" ? false : null;
    }
    catch {
        return null;
    }
}
async function getDuplexMode(printer) {
    try {
        return (await runPowerShell(`(Get-PrintConfiguration -PrinterName '${psq(printer)}').DuplexingMode`)) || null;
    }
    catch {
        return null;
    }
}
async function setDuplexMode(printer, mode) {
    try {
        await runPowerShell(`Set-PrintConfiguration -PrinterName '${psq(printer)}' -DuplexingMode ${mode}`);
        return true;
    }
    catch {
        return false;
    }
}
/* ───────────── Windows colour helpers ─────────────
 * Same idea as duplex: SumatraPDF gets a colour/monochrome flag per job, but many drivers ignore it and follow the
 * printer's own "Printing Preferences" (often left on Grayscale). So we ALSO set the printer's colour mode through
 * Windows (Set-PrintConfiguration -Color) for the job and put it back afterwards. Best-effort. */
/** Does Windows report colour printing for this printer? null = couldn't tell. */
async function printerReportsColor(printer) {
    try {
        const out = await runPowerShell(`$p = Get-CimInstance Win32_Printer | Where-Object { $_.Name -eq '${psq(printer)}' }; if ($p) { ($p.Capabilities -contains 2) } else { 'unknown' }`);
        const v = out.toLowerCase();
        return v === "true" ? true : v === "false" ? false : null;
    }
    catch {
        return null;
    }
}
async function getColorMode(printer) {
    try {
        const v = (await runPowerShell(`(Get-PrintConfiguration -PrinterName '${psq(printer)}').Color`)).toLowerCase();
        return v === "true" ? true : v === "false" ? false : null;
    }
    catch {
        return null;
    }
}
async function setColorMode(printer, color) {
    try {
        await runPowerShell(`Set-PrintConfiguration -PrinterName '${psq(printer)}' -Color ${color ? "$true" : "$false"}`);
        return true;
    }
    catch {
        return false;
    }
}
/* ───────────── Verifying that the job really printed ─────────────
 * print() only means "handed to the Windows spooler". If the printer is offline / paused / out of paper the job
 * just sits in the queue and nothing comes out — yet the order used to be marked "ready". Now we (1) refuse to
 * start when Windows says the printer can't print, and (2) watch the spooler until OUR job leaves the queue,
 * failing the order (and removing the stuck job, so it can't print later as a duplicate) if it gets stuck. */
/** Thrown for problems we detected ourselves — message is already shopkeeper-friendly. */
class PrintCheckError extends Error {
    /** stalled = the printer itself is the problem (offline / job stuck) -> the agent reports it offline. */
    constructor(message, stalled = false) {
        super(message);
        this.printerStalled = stalled;
    }
}
exports.PrintCheckError = PrintCheckError;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Jobs currently in this printer's Windows queue. null = couldn't read the queue (don't block on it). */
async function listJobs(printer) {
    try {
        const out = await runPowerShell(`@(Get-PrintJob -PrinterName '${psq(printer)}' -ErrorAction Stop | Select-Object Id, @{n='S';e={[string]$_.JobStatus}}) | ConvertTo-Json -Compress`);
        if (!out)
            return [];
        const parsed = JSON.parse(out);
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        return arr.map((j) => ({ id: Number(j.Id), status: String(j.S ?? "") }));
    }
    catch {
        return null;
    }
}
async function removeJobs(printer, ids) {
    for (const id of ids) {
        try {
            await runPowerShell(`Remove-PrintJob -PrinterName '${psq(printer)}' -ID ${Number(id)} -ErrorAction Stop`);
        }
        catch {
            // best effort
        }
    }
}
const PRINTER_PROBLEMS = {
    paused: "is paused",
    offline: "is offline (switched off, asleep or not connected)",
    paperjam: "has a paper jam",
    paperout: "is out of paper",
    dooropen: "has its cover/door open",
    notoner: "is out of toner/ink",
};
/** Refuses to start a job on a printer Windows already knows can't print. */
async function assertPrinterReady(printer) {
    try {
        const out = await runPowerShell(`Get-Printer -Name '${psq(printer)}' -ErrorAction Stop | Select-Object WorkOffline, @{n='S';e={[string]$_.PrinterStatus}} | ConvertTo-Json -Compress`);
        if (!out)
            return;
        const st = JSON.parse(out);
        if (st.WorkOffline) {
            throw new PrintCheckError(`"${printer}" is set to "Use Printer Offline". In Windows open the printer's queue -> Printer menu -> untick "Use Printer Offline", then retry.`, true);
        }
        const key = String(st.S ?? "").toLowerCase();
        const problem = PRINTER_PROBLEMS[key];
        if (problem)
            throw new PrintCheckError(`"${printer}" ${problem}. Fix it and retry.`, key === "offline" || key === "paused");
    }
    catch (err) {
        if (err instanceof PrintCheckError)
            throw err;
        // Couldn't query the printer (old Windows / no permission) — carry on and rely on the queue check.
    }
}
const JOB_DONE = /printed|complete|retained/i; // job already finished (some drivers keep it listed)
const JOB_STUCK = /error|offline|paperout|userintervention|blocked|paused|deleting/i;
const VERIFY_MAX_MS = 150000;
/** Waits until the job(s) created by our print() leave the queue; throws if they get stuck. */
async function verifyPrinted(printer, before) {
    const started = Date.now();
    const mine = new Set();
    let stuckPolls = 0;
    let lastStatus = "";
    await sleep(1500); // let the spooler register the job
    while (Date.now() - started < VERIFY_MAX_MS) {
        const jobs = await listJobs(printer);
        if (jobs === null)
            return; // can't read the queue — nothing to verify against
        for (const j of jobs)
            if (!before.has(j.id))
                mine.add(j.id);
        const active = jobs.filter((j) => mine.has(j.id) && !JOB_DONE.test(j.status));
        if (active.length === 0)
            return; // our job is gone (printed) — or never queued
        lastStatus = active.map((j) => j.status || "Normal").join(", ");
        stuckPolls = active.some((j) => JOB_STUCK.test(j.status)) ? stuckPolls + 1 : 0;
        if (stuckPolls >= 3) {
            await removeJobs(printer, active.map((j) => j.id));
            throw new PrintCheckError(`Print job is stuck on "${printer}" (${lastStatus}). Check the printer is on, connected, has paper and isn't set to offline/paused. The stuck job was cancelled.`, true);
        }
        await sleep(2000);
    }
    // Still in the queue after the time limit: fine if the printer is actively printing a long job.
    if (/printing/i.test(lastStatus) && !JOB_STUCK.test(lastStatus))
        return;
    const jobs = (await listJobs(printer)) ?? [];
    await removeJobs(printer, jobs.filter((j) => mine.has(j.id)).map((j) => j.id));
    throw new PrintCheckError(`Print job did not finish on "${printer}" within ${Math.round(VERIFY_MAX_MS / 60000 * 10) / 10} minutes (${lastStatus || "waiting"}). Check the printer and retry. The stuck job was cancelled.`, true);
}
/**
 * Saves the order's file to a temp path and sends it to the given Windows printer.
 * On Windows it then waits until the job has actually left the print queue, so "ready" means it printed.
 */
async function printOrder({ fileBuffer, fileName, systemPrinterName, copies, duplex, printType }) {
    const warnings = []; // non-fatal things worth showing in the activity log
    // "color" -> true, "bw" -> false, anything else (old callers) -> leave the printer's own setting alone.
    const wantColor = printType === "color" ? true : printType === "bw" ? false : null;
    const tmpDir = path.join(os.tmpdir(), "qrtoprint-agent");
    if (!fs.existsSync(tmpDir))
        fs.mkdirSync(tmpDir, { recursive: true });
    const safeName = (fileName || "order.pdf").replace(/[^a-zA-Z0-9.\-_]/g, "_");
    const filePath = path.join(tmpDir, `${Date.now()}-${safeName}`);
    fs.writeFileSync(filePath, fileBuffer);
    let restoreMode = null;
    let restoreColor = null;
    try {
        let before = new Set();
        if (IS_WIN) {
            await assertPrinterReady(systemPrinterName);
            before = new Set(((await listJobs(systemPrinterName)) ?? []).map((j) => j.id));
        }
        // Duplex: also set the Windows printer's own duplex mode (see helpers above) and restore it after the job.
        let driverModeSet = false;
        if (duplex && IS_WIN) {
            if ((await printerReportsDuplex(systemPrinterName)) === false) {
                console.warn(`"${systemPrinterName}" does not report automatic duplex. If pages come out single-sided: open Printer Properties -> ` +
                    `Device Settings and set "Duplex Unit" to Installed, or use a printer that has a duplex unit.`);
            }
            const previous = await getDuplexMode(systemPrinterName);
            driverModeSet = await setDuplexMode(systemPrinterName, "TwoSidedLongEdge");
            if (driverModeSet && previous && previous !== "TwoSidedLongEdge")
                restoreMode = previous;
            console.log(`Duplex job on "${systemPrinterName}": driver mode ${driverModeSet ? "set to TwoSidedLongEdge" : "could not be set (using Sumatra flag only)"}`);
        }
        // Colour: switch the Windows printer to colour (or B&W) for this job and restore it afterwards.
        if (wantColor !== null && IS_WIN) {
            if (wantColor && (await printerReportsColor(systemPrinterName)) === false) {
                warnings.push(`"${systemPrinterName}" does not report colour support, so this colour order may print in black & white. Use a colour printer for colour orders.`);
            }
            const prevColor = await getColorMode(systemPrinterName);
            const colorSet = await setColorMode(systemPrinterName, wantColor);
            if (colorSet && prevColor !== null && prevColor !== wantColor)
                restoreColor = prevColor;
            if (!colorSet && wantColor) {
                warnings.push(`Could not switch "${systemPrinterName}" to colour through Windows. If the pages still come out black & white, open the printer's Printing Preferences and set Color instead of Grayscale.`);
            }
            console.log(`${wantColor ? "Colour" : "B&W"} job on "${systemPrinterName}": Windows colour mode ${colorSet ? "set" : "could not be set (using the Sumatra flag only)"}`);
        }
        try {
            try {
                await pdf().print(filePath, {
                    printer: systemPrinterName,
                    copies: Math.max(1, copies || 1),
                    silent: true, // no SumatraPDF error pop-ups on the shop PC
                    // pdf-to-printer maps "side" to SumatraPDF's duplex setting ("duplexlong" = flip on long edge)
                    side: duplex ? "duplexlong" : "simplex",
                    // colour order -> colour, B&W order -> monochrome (pdf-to-printer passes this on to SumatraPDF)
                    ...(wantColor === null ? {} : { monochrome: !wantColor }),
                });
            }
            catch (err) {
                throw new Error(friendlyPrintError(err, systemPrinterName));
            }
            // The job must really leave the queue before we call it done (also keeps duplex mode until it has printed).
            if (IS_WIN)
                await verifyPrinted(systemPrinterName, before);
        }
        finally {
            if (restoreMode)
                await setDuplexMode(systemPrinterName, restoreMode);
            if (restoreColor !== null)
                await setColorMode(systemPrinterName, restoreColor);
        }
    }
    finally {
        // Clean up the temp file regardless of print success/failure —
        // we never keep customer documents on disk longer than necessary.
        fs.unlink(filePath, () => { });
    }
    return { warnings };
}
