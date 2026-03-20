/**
 * generateReport.ts
 *
 * Reads every CSV under test-results/vendor-reports/ (recursively scanning
 * all dated run subfolders) and writes a self-contained HTML dashboard.
 *
 * ── Folder structure expected ─────────────────────────────────────────────────
 *
 *   test-results/vendor-reports/
 *       2026-03-19T08-24-15/           ← run folder (auto-created by v4 spec)
 *           Amusnet_2026-03-19T08-24-15.csv
 *           PG_Soft_2026-03-19T08-24-15.csv
 *       2026-03-20T09-00-00/
 *           Amusnet_2026-03-20T09-00-00.csv
 *
 * ── Usage (run from project root: D:\Yoong testing) ──────────────────────────
 *
 *   All runs (full history):
 *     npx ts-node tests/reports/generateReport.ts
 *
 *   Latest run only:
 *     npx ts-node tests/reports/generateReport.ts --latest
 *
 *   Specific run folder:
 *     npx ts-node tests/reports/generateReport.ts --dir test-results/vendor-reports/2026-03-19T08-24-15
 *
 *   Custom output file:
 *     npx ts-node tests/reports/generateReport.ts --out test-results/my-report.html
 *
 * ── Output ────────────────────────────────────────────────────────────────────
 *
 *   Default: test-results/report.html  (self-contained, no internet needed)
 *   Open:    start test-results\report.html
 */

import * as fs   from 'fs';
import * as path from 'path';

// ── Config ────────────────────────────────────────────────────────────────────

// All paths resolved from process.cwd() (project root where you run the command),
// NOT from __dirname (the script's own directory inside tests/reports/).
const CWD = process.cwd();

const DEFAULT_CSV_BASE = path.join(CWD, 'test-results', 'vendor-reports');
const DEFAULT_OUT_FILE = path.join(CWD, 'test-results', 'report.html');

// SLA: games failing continuously for more than this many hours are escalated
const SLA_FAIL_HOURS = 24;

// Flaky: a game that has BOTH a Pass and a Fail result across all CSV files
const FLAKY_MIN_RUNS = 2;

// ── Types ─────────────────────────────────────────────────────────────────────

interface CsvRow {
    vendorId:   number;
    vendorName: string;
    gameId:     number;
    gameName:   string;
    status:     'Pass' | 'Fail';
    gate:       number | null;
    retries:    number;
    error:      string;
    timestamp:  string;    // raw string e.g. "2026-03-19T05-41-47"
    runFile:    string;    // source filename
}

interface VendorStat {
    vendorId:   number;
    vendorName: string;
    total:      number;
    passed:     number;
    failed:     number;
    retried:    number;
    passRate:   number;   // 0–100
    gateBreakdown: Record<number, number>;   // gate → fail count
    errorTypes:    Record<string, number>;   // normalised error → count
    latestRun:  string;
}

interface GameRecord {
    gameId:     number;
    gameName:   string;
    vendorId:   number;
    vendorName: string;
    results:    Array<{ status: 'Pass' | 'Fail'; timestamp: string; error: string; gate: number | null; retries: number }>;
    isFlaky:    boolean;
    slaBreached: boolean;
    consecutiveFailHours: number;
}

// ── CSV parser ────────────────────────────────────────────────────────────────

function parseCsvLine(line: string): string[] {
    const fields: string[] = [];
    let   current          = '';
    let   inQuotes         = false;

    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
            else inQuotes = !inQuotes;
        } else if (ch === ',' && !inQuotes) {
            fields.push(current);
            current = '';
        } else {
            current += ch;
        }
    }
    fields.push(current);
    return fields;
}

function parseTimestamp(raw: string): Date {
    // Format: 2026-03-19T05-41-47  (colons replaced with dashes in filenames)
    const normalised = raw.replace(/T(\d{2})-(\d{2})-(\d{2})$/, 'T$1:$2:$3');
    return new Date(normalised);
}

function normalisedErrorType(error: string): string {
    if (!error) return 'Unknown';
    if (error.startsWith('AUTH_FAILURE'))        return 'Auth Failure';
    if (error.includes('Hard timeout'))          return 'Hard Timeout';
    if (error.includes('Connection Failed'))     return 'Connection Failed';
    if (error.includes('HTTP Error'))            return 'HTTP Error';
    if (error.includes('Blank Screen'))          return 'Blank Screen';
    if (error.includes('Game Error'))            return 'Game Error (Gate 3)';
    if (error.includes('Unstable'))              return 'Unstable (Gate 4)';
    if (error.includes('API Error'))             return 'API Error (Gate 1)';
    if (error.includes('iframe did not load'))   return 'iFrame Timeout';
    return 'Other';
}

/**
 * Collects all CSV files from a directory.
 * Handles two layouts:
 *   - Flat:   dir/*.csv                         (old structure / specific run folder)
 *   - Nested: dir/<run-datetime>/*.csv          (new v4 structure, all runs)
 *
 * Returns { csvFiles, runFolders } so the caller can display which runs were found.
 */
function collectCsvFiles(dir: string): { csvFiles: Array<{ file: string; runLabel: string }>; runFolders: string[] } {
    if (!fs.existsSync(dir)) {
        console.error(`\n❌  Directory not found: ${dir}`);
        console.error(`\n    Run the validation first:\n`);
        console.error(`      npx playwright test tests/v4/ --project=chromium --workers=6\n`);
        process.exit(1);
    }

    const entries   = fs.readdirSync(dir, { withFileTypes: true });
    const csvFiles: Array<{ file: string; runLabel: string }> = [];
    const runFolders: string[] = [];

    // Check if there are dated subfolders (new v4 structure)
    const subDirs = entries.filter(e => e.isDirectory()).map(e => e.name).sort();

    if (subDirs.length > 0) {
        // Nested structure: each subfolder is a run
        for (const sub of subDirs) {
            const subPath = path.join(dir, sub);
            const subCsvs = fs.readdirSync(subPath).filter(f => f.endsWith('.csv')).sort();
            if (subCsvs.length > 0) {
                runFolders.push(sub);
                for (const f of subCsvs) {
                    csvFiles.push({ file: path.join(subPath, f), runLabel: sub });
                }
            }
        }
    }

    // Also pick up any CSVs directly in dir (old flat structure or mixed)
    const flatCsvs = entries.filter(e => e.isFile() && e.name.endsWith('.csv')).map(e => e.name).sort();
    for (const f of flatCsvs) {
        csvFiles.push({ file: path.join(dir, f), runLabel: 'legacy' });
    }

    return { csvFiles, runFolders };
}

function loadAllCsvs(dir: string): CsvRow[] {
    const { csvFiles, runFolders } = collectCsvFiles(dir);

    if (csvFiles.length === 0) {
        console.error(`\n❌  No CSV files found in: ${dir}`);
        console.error(`\n    Run the validation first:\n`);
        console.error(`      npx playwright test tests/v4/ --project=chromium --workers=6\n`);
        process.exit(1);
    }

    if (runFolders.length > 0) {
        console.log(`✓  Found ${runFolders.length} run folder${runFolders.length !== 1 ? 's' : ''} in ${dir}`);
        runFolders.forEach(f => console.log(`   └─ ${f}`));
    }
    console.log(`✓  Total CSV files: ${csvFiles.length}\n`);

    const rows: CsvRow[] = [];

    for (const { file, runLabel } of csvFiles) {
        const lines = fs.readFileSync(file, 'utf8').trim().split('\n');

        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;

            const parts = parseCsvLine(line);
            if (parts.length < 9) continue;

            // Handle both 9-column (old) and 10-column (new, has FrameDepth)
            // Columns: VendorId,VendorName,GameId,GameName,Status,Gate,Retries,[FrameDepth,]Error,Timestamp
            let vendorIdStr: string, vendorName: string, gameIdStr: string, gameName: string,
                status: string, gateStr: string, retriesStr: string, error: string, timestamp: string;

            if (parts.length >= 10) {
                // 10-column format with FrameDepth
                [vendorIdStr, vendorName, gameIdStr, gameName,
                 status, gateStr, retriesStr, , error, timestamp] = parts;
            } else {
                [vendorIdStr, vendorName, gameIdStr, gameName,
                 status, gateStr, retriesStr, error, timestamp] = parts;
            }

            rows.push({
                vendorId:   parseInt(vendorIdStr, 10)  || 0,
                vendorName: vendorName.trim(),
                gameId:     parseInt(gameIdStr, 10)    || 0,
                gameName:   gameName.trim(),
                status:     (status.trim() as 'Pass' | 'Fail'),
                gate:       gateStr.trim() ? parseInt(gateStr.trim(), 10) : null,
                retries:    parseInt(retriesStr.trim(), 10) || 0,
                error:      error.trim(),
                timestamp:  timestamp.trim(),
                // runFile uses the run folder name for grouping in the timeline
                runFile:    runLabel === 'legacy' ? path.basename(file) : runLabel,
            });
        }
    }

    console.log(`✓  Loaded ${rows.length} total game results`);
    return rows;
}

/**
 * Returns the path of the most recent run subfolder, or the base dir if flat.
 * Used by --latest flag to scope the report to just the last run.
 */
function getLatestRunDir(baseDir: string): string {
    if (!fs.existsSync(baseDir)) return baseDir;
    const subDirs = fs.readdirSync(baseDir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name)
        .sort();
    if (subDirs.length === 0) return baseDir; // flat structure
    return path.join(baseDir, subDirs[subDirs.length - 1]);
}

// ── Metrics computation ───────────────────────────────────────────────────────

function computeVendorStats(rows: CsvRow[]): VendorStat[] {
    const byVendor = new Map<number, CsvRow[]>();

    for (const row of rows) {
        if (!byVendor.has(row.vendorId)) byVendor.set(row.vendorId, []);
        byVendor.get(row.vendorId)!.push(row);
    }

    const stats: VendorStat[] = [];

    for (const [vendorId, vendorRows] of byVendor) {
        const passed  = vendorRows.filter(r => r.status === 'Pass').length;
        const failed  = vendorRows.filter(r => r.status === 'Fail').length;
        const retried = vendorRows.filter(r => r.retries > 0).length;

        const gateBreakdown: Record<number, number> = {};
        const errorTypes:    Record<string, number> = {};

        for (const r of vendorRows) {
            if (r.status === 'Fail') {
                const g = r.gate ?? 0;
                gateBreakdown[g] = (gateBreakdown[g] || 0) + 1;

                const et = normalisedErrorType(r.error);
                errorTypes[et] = (errorTypes[et] || 0) + 1;
            }
        }

        const timestamps = vendorRows.map(r => r.timestamp).sort();

        stats.push({
            vendorId,
            vendorName:    vendorRows[0].vendorName,
            total:         vendorRows.length,
            passed,
            failed,
            retried,
            passRate:      vendorRows.length > 0 ? Math.round((passed / vendorRows.length) * 100) : 0,
            gateBreakdown,
            errorTypes,
            latestRun:     timestamps[timestamps.length - 1] || '',
        });
    }

    return stats.sort((a, b) => a.passRate - b.passRate); // worst first
}

function computeGameRecords(rows: CsvRow[]): GameRecord[] {
    // Group by gameId
    const byGame = new Map<number, CsvRow[]>();
    for (const row of rows) {
        if (!byGame.has(row.gameId)) byGame.set(row.gameId, []);
        byGame.get(row.gameId)!.push(row);
    }

    const records: GameRecord[] = [];
    const now = new Date();

    for (const [gameId, gameRows] of byGame) {
        const sorted    = gameRows.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        const hasPass   = sorted.some(r => r.status === 'Pass');
        const hasFail   = sorted.some(r => r.status === 'Fail');
        const isFlaky   = hasPass && hasFail && sorted.length >= FLAKY_MIN_RUNS;

        // SLA: find the earliest consecutive fail streak from the end
        let consecutiveFailHours = 0;
        let slaBreached          = false;

        const reversed = [...sorted].reverse();
        if (reversed[0]?.status === 'Fail') {
            // Walk backwards until we find a Pass or run out
            let firstFailInStreak = reversed[0].timestamp;
            for (const r of reversed) {
                if (r.status === 'Pass') break;
                firstFailInStreak = r.timestamp;
            }
            const firstFailDate   = parseTimestamp(firstFailInStreak);
            consecutiveFailHours  = (now.getTime() - firstFailDate.getTime()) / 3_600_000;
            slaBreached           = consecutiveFailHours >= SLA_FAIL_HOURS;
        }

        records.push({
            gameId,
            gameName:   sorted[0].gameName,
            vendorId:   sorted[0].vendorId,
            vendorName: sorted[0].vendorName,
            results:    sorted.map(r => ({
                status:    r.status,
                timestamp: r.timestamp,
                error:     r.error,
                gate:      r.gate,
                retries:   r.retries,
            })),
            isFlaky,
            slaBreached,
            consecutiveFailHours: Math.round(consecutiveFailHours),
        });
    }

    return records;
}

function computeRunTimeline(rows: CsvRow[]): Array<{ runFile: string; timestamp: string; passed: number; failed: number; total: number }> {
    const byRun = new Map<string, CsvRow[]>();
    for (const row of rows) {
        if (!byRun.has(row.runFile)) byRun.set(row.runFile, []);
        byRun.get(row.runFile)!.push(row);
    }

    return Array.from(byRun.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([runFile, runRows]) => ({
            runFile,
            timestamp: runRows[0]?.timestamp || '',
            passed:    runRows.filter(r => r.status === 'Pass').length,
            failed:    runRows.filter(r => r.status === 'Fail').length,
            total:     runRows.length,
        }));
}

// ── HTML generation ───────────────────────────────────────────────────────────

function escHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function generateHtml(
    rows:          CsvRow[],
    vendorStats:   VendorStat[],
    gameRecords:   GameRecord[],
    runTimeline:   ReturnType<typeof computeRunTimeline>,
): string {
    const totalGames   = rows.length;
    const totalPassed  = rows.filter(r => r.status === 'Pass').length;
    const totalFailed  = rows.filter(r => r.status === 'Fail').length;
    const totalVendors = new Set(rows.map(r => r.vendorId)).size;
    const totalRuns    = new Set(rows.map(r => r.runFile)).size;

    const flakyGames   = gameRecords.filter(g => g.isFlaky);
    const slaGames     = gameRecords.filter(g => g.slaBreached);

    // Gate failure summary across all runs
    const gateTotal: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
    for (const row of rows) {
        if (row.status === 'Fail' && row.gate) {
            gateTotal[row.gate] = (gateTotal[row.gate] || 0) + 1;
        }
    }

    // Error type summary
    const errorSummary: Record<string, number> = {};
    for (const row of rows) {
        if (row.status === 'Fail') {
            const et = normalisedErrorType(row.error);
            errorSummary[et] = (errorSummary[et] || 0) + 1;
        }
    }

    const vendorStatsJson  = JSON.stringify(vendorStats);
    const gameRecordsJson  = JSON.stringify(gameRecords.map(g => ({
        gameId:              g.gameId,
        gameName:            g.gameName,
        vendorName:          g.vendorName,
        latestStatus:        g.results[g.results.length - 1]?.status || 'Unknown',
        latestError:         g.results[g.results.length - 1]?.error  || '',
        latestGate:          g.results[g.results.length - 1]?.gate   || null,
        runs:                g.results.length,
        isFlaky:             g.isFlaky,
        slaBreached:         g.slaBreached,
        consecutiveFailHours: g.consecutiveFailHours,
    })));
    const runTimelineJson  = JSON.stringify(runTimeline);
    const errorSummaryJson = JSON.stringify(errorSummary);
    const gateTotalJson    = JSON.stringify(gateTotal);

    const generatedAt = new Date().toLocaleString();

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>s9.com Game Validation Report</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
  :root {
    --bg:        #0d0f14;
    --bg2:       #151820;
    --bg3:       #1c2030;
    --border:    #2a2f42;
    --text:      #e8eaf0;
    --muted:     #7b82a0;
    --accent:    #4f9cf9;
    --pass:      #22c55e;
    --fail:      #ef4444;
    --warn:      #f59e0b;
    --flaky:     #a78bfa;
    --radius:    10px;
    --font:      'DM Mono', 'Fira Code', 'Cascadia Code', monospace;
    --font-ui:   'DM Sans', 'Segoe UI', system-ui, sans-serif;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { scroll-behavior: smooth; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: var(--font-ui);
    font-size: 14px;
    line-height: 1.6;
    min-height: 100vh;
  }

  /* ── Layout ─────────────────────────── */
  .shell { display: flex; min-height: 100vh; }
  nav {
    width: 220px;
    min-width: 220px;
    background: var(--bg2);
    border-right: 1px solid var(--border);
    padding: 24px 0;
    position: sticky;
    top: 0;
    height: 100vh;
    overflow-y: auto;
    flex-shrink: 0;
  }
  nav .logo {
    padding: 0 20px 20px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 16px;
  }
  nav .logo h1 { font-size: 13px; font-weight: 600; color: var(--accent); letter-spacing: .06em; text-transform: uppercase; }
  nav .logo p  { font-size: 11px; color: var(--muted); margin-top: 3px; }
  nav a {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 9px 20px;
    color: var(--muted);
    text-decoration: none;
    font-size: 13px;
    transition: color .15s, background .15s;
    border-left: 2px solid transparent;
  }
  nav a:hover, nav a.active {
    color: var(--text);
    background: rgba(79,156,249,.07);
    border-left-color: var(--accent);
  }
  main { flex: 1; padding: 32px; overflow-x: hidden; }

  /* ── Sections ───────────────────────── */
  section { margin-bottom: 48px; scroll-margin-top: 24px; }
  .section-title {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: .1em;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 16px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--border);
  }

  /* ── KPI cards ──────────────────────── */
  .kpi-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .kpi {
    background: var(--bg2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 18px 20px;
    position: relative;
    overflow: hidden;
  }
  .kpi::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: var(--accent-kpi, var(--accent));
  }
  .kpi.pass  { --accent-kpi: var(--pass);  }
  .kpi.fail  { --accent-kpi: var(--fail);  }
  .kpi.warn  { --accent-kpi: var(--warn);  }
  .kpi.flaky { --accent-kpi: var(--flaky); }
  .kpi label { font-size: 11px; color: var(--muted); letter-spacing: .05em; text-transform: uppercase; }
  .kpi .val  { font-size: 32px; font-weight: 700; font-family: var(--font); line-height: 1.1; margin-top: 6px; }
  .kpi .sub  { font-size: 11px; color: var(--muted); margin-top: 4px; }

  /* ── Cards ──────────────────────────── */
  .card {
    background: var(--bg2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 20px;
  }
  .card-title { font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: .07em; margin-bottom: 16px; }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; }
  @media (max-width: 1100px) { .grid-3 { grid-template-columns: 1fr 1fr; } }
  @media (max-width: 800px)  { .grid-2, .grid-3 { grid-template-columns: 1fr; } }

  /* ── Vendor heatmap ─────────────────── */
  .heatmap { display: flex; flex-direction: column; gap: 4px; }
  .heatmap-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
  }
  .heatmap-label {
    width: 160px;
    min-width: 160px;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 12px;
  }
  .heatmap-bar-wrap { flex: 1; background: var(--bg3); border-radius: 4px; height: 22px; overflow: hidden; position: relative; }
  .heatmap-bar-pass { height: 100%; background: var(--pass); opacity: .7; border-radius: 4px 0 0 4px; transition: opacity .2s; float: left; }
  .heatmap-bar-fail { height: 100%; background: var(--fail); opacity: .7; float: left; }
  .heatmap-bar-wrap:hover .heatmap-bar-pass,
  .heatmap-bar-wrap:hover .heatmap-bar-fail { opacity: 1; }
  .heatmap-pct {
    width: 44px;
    text-align: right;
    font-family: var(--font);
    font-size: 12px;
    font-weight: 600;
    color: var(--pass);
  }
  .heatmap-pct.low { color: var(--fail); }
  .heatmap-pct.mid { color: var(--warn); }

  /* ── Table ──────────────────────────── */
  .tbl-wrap { overflow-x: auto; border-radius: var(--radius); border: 1px solid var(--border); }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  thead tr { background: var(--bg3); }
  th {
    padding: 10px 14px;
    text-align: left;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: .06em;
    text-transform: uppercase;
    color: var(--muted);
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
    cursor: pointer;
    user-select: none;
  }
  th:hover { color: var(--text); }
  th .sort-icon { margin-left: 4px; opacity: .4; }
  th.sorted .sort-icon { opacity: 1; color: var(--accent); }
  td {
    padding: 9px 14px;
    border-bottom: 1px solid var(--border);
    vertical-align: middle;
    max-width: 260px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: rgba(79,156,249,.04); }

  /* ── Badges ─────────────────────────── */
  .badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 600;
    font-family: var(--font);
    letter-spacing: .04em;
  }
  .badge-pass  { background: rgba(34,197,94,.15);  color: #4ade80; }
  .badge-fail  { background: rgba(239,68,68,.15);  color: #f87171; }
  .badge-flaky { background: rgba(167,139,250,.15); color: #c4b5fd; }
  .badge-sla   { background: rgba(245,158,11,.15); color: #fbbf24; }
  .badge-gate  { background: rgba(79,156,249,.15); color: #93c5fd; font-size: 10px; }

  /* ── Search + filter bar ────────────── */
  .filter-bar {
    display: flex;
    gap: 10px;
    margin-bottom: 14px;
    flex-wrap: wrap;
    align-items: center;
  }
  .filter-bar input, .filter-bar select {
    background: var(--bg3);
    border: 1px solid var(--border);
    color: var(--text);
    border-radius: 6px;
    padding: 7px 12px;
    font-size: 13px;
    font-family: var(--font-ui);
    outline: none;
    transition: border-color .15s;
  }
  .filter-bar input { flex: 1; min-width: 220px; }
  .filter-bar input:focus, .filter-bar select:focus { border-color: var(--accent); }
  .filter-bar select option { background: var(--bg3); }
  .filter-count { font-size: 12px; color: var(--muted); margin-left: auto; white-space: nowrap; }

  /* ── Chart container ────────────────── */
  .chart-wrap { position: relative; height: 220px; }
  .chart-wrap-tall { position: relative; height: 280px; }

  /* ── Timeline dots ──────────────────── */
  .timeline { display: flex; gap: 4px; align-items: flex-end; height: 60px; padding: 4px 0; }
  .tl-bar {
    flex: 1;
    border-radius: 3px 3px 0 0;
    min-height: 4px;
    cursor: pointer;
    transition: opacity .15s;
    position: relative;
  }
  .tl-bar:hover { opacity: .8; }
  .tl-bar:hover::after {
    content: attr(data-tip);
    position: absolute;
    bottom: calc(100% + 6px);
    left: 50%;
    transform: translateX(-50%);
    background: var(--bg3);
    border: 1px solid var(--border);
    padding: 4px 8px;
    border-radius: 4px;
    font-size: 11px;
    white-space: nowrap;
    pointer-events: none;
    z-index: 10;
    color: var(--text);
  }

  /* ── Misc ───────────────────────────── */
  .tag-list { display: flex; gap: 6px; flex-wrap: wrap; }
  .chip { background: var(--bg3); border: 1px solid var(--border); border-radius: 4px; padding: 2px 8px; font-size: 11px; color: var(--muted); }
  .text-pass  { color: var(--pass); }
  .text-fail  { color: var(--fail); }
  .text-warn  { color: var(--warn); }
  .text-flaky { color: var(--flaky); }
  .text-muted { color: var(--muted); }
  .pct-bar-wrap { background: var(--bg3); border-radius: 4px; height: 6px; width: 100%; margin-top: 4px; }
  .pct-bar      { height: 6px; border-radius: 4px; background: var(--pass); }
  footer { font-size: 11px; color: var(--muted); margin-top: 40px; padding-top: 16px; border-top: 1px solid var(--border); }
  .no-data { color: var(--muted); font-size: 13px; padding: 24px; text-align: center; }
</style>
</head>
<body>

<div class="shell">

<!-- ── Sidebar nav ─────────────────────────────────────────────── -->
<nav id="nav">
  <div class="logo">
    <h1>s9 · Game QA</h1>
    <p>Validation Report</p>
  </div>
  <a href="#overview"  onclick="setActive(this)">&#9632; Overview</a>
  <a href="#vendors"   onclick="setActive(this)">&#9632; Vendor Health</a>
  <a href="#gates"     onclick="setActive(this)">&#9632; Gate Analysis</a>
  <a href="#timeline"  onclick="setActive(this)">&#9632; Run Timeline</a>
  <a href="#flaky"     onclick="setActive(this)">&#9632; Flaky Games</a>
  <a href="#sla"       onclick="setActive(this)">&#9632; SLA Breaches</a>
  <a href="#games"     onclick="setActive(this)">&#9632; All Games</a>
</nav>

<!-- ── Main content ───────────────────────────────────────────── -->
<main>

<!-- ── Overview ─────────────────────────────────────────────── -->
<section id="overview">
  <div class="section-title">Overview</div>
  <div class="kpi-row">
    <div class="kpi">
      <label>Total Games</label>
      <div class="val">${totalGames.toLocaleString()}</div>
      <div class="sub">${totalVendors} vendors · ${totalRuns} run${totalRuns !== 1 ? 's' : ''}</div>
    </div>
    <div class="kpi pass">
      <label>Passed</label>
      <div class="val text-pass">${totalPassed.toLocaleString()}</div>
      <div class="sub">${totalGames > 0 ? Math.round(totalPassed / totalGames * 100) : 0}% pass rate</div>
    </div>
    <div class="kpi fail">
      <label>Failed</label>
      <div class="val text-fail">${totalFailed.toLocaleString()}</div>
      <div class="sub">${totalGames > 0 ? Math.round(totalFailed / totalGames * 100) : 0}% fail rate</div>
    </div>
    <div class="kpi flaky">
      <label>Flaky Games</label>
      <div class="val text-flaky">${flakyGames.length}</div>
      <div class="sub">Pass &amp; Fail across runs</div>
    </div>
    <div class="kpi warn">
      <label>SLA Breaches</label>
      <div class="val text-warn">${slaGames.length}</div>
      <div class="sub">Failing &gt;${SLA_FAIL_HOURS}h continuously</div>
    </div>
  </div>

  <div class="grid-2">
    <div class="card">
      <div class="card-title">Error type distribution</div>
      <div class="chart-wrap"><canvas id="chartErrors"></canvas></div>
    </div>
    <div class="card">
      <div class="card-title">Gate failure breakdown</div>
      <div class="chart-wrap"><canvas id="chartGates"></canvas></div>
    </div>
  </div>
</section>

<!-- ── Vendor Health ─────────────────────────────────────────── -->
<section id="vendors">
  <div class="section-title">Vendor Health</div>
  <div class="card">
    <div class="card-title">Pass rate by vendor (worst first)</div>
    <div class="heatmap" id="vendorHeatmap"></div>
  </div>
</section>

<!-- ── Gate Analysis ─────────────────────────────────────────── -->
<section id="gates">
  <div class="section-title">Gate Analysis</div>
  <div class="grid-3" id="gateCards"></div>
</section>

<!-- ── Run Timeline ──────────────────────────────────────────── -->
<section id="timeline">
  <div class="section-title">Run Timeline</div>
  <div class="card">
    <div class="card-title">Pass / Fail per run</div>
    <div class="chart-wrap-tall"><canvas id="chartTimeline"></canvas></div>
  </div>
</section>

<!-- ── Flaky Games ───────────────────────────────────────────── -->
<section id="flaky">
  <div class="section-title">Flaky Games <span class="badge badge-flaky" style="vertical-align:middle">${flakyGames.length}</span></div>
  <p class="text-muted" style="font-size:12px;margin-bottom:14px">
    Games that produced both Pass and Fail results across different runs.
    These indicate unstable provider servers or intermittent connectivity issues.
  </p>
  <div class="tbl-wrap">
    <table id="flakyTable">
      <thead>
        <tr>
          <th>Game</th>
          <th>Vendor</th>
          <th>Runs</th>
          <th>Latest</th>
          <th>Latest Error</th>
        </tr>
      </thead>
      <tbody id="flakyBody"></tbody>
    </table>
  </div>
</section>

<!-- ── SLA Breaches ──────────────────────────────────────────── -->
<section id="sla">
  <div class="section-title">SLA Breaches <span class="badge badge-sla" style="vertical-align:middle">${slaGames.length}</span></div>
  <p class="text-muted" style="font-size:12px;margin-bottom:14px">
    Games that have been failing continuously for more than ${SLA_FAIL_HOURS} hours.
    These require vendor escalation.
  </p>
  <div class="tbl-wrap">
    <table id="slaTable">
      <thead>
        <tr>
          <th>Game</th>
          <th>Vendor</th>
          <th>Failing for</th>
          <th>Gate</th>
          <th>Error</th>
        </tr>
      </thead>
      <tbody id="slaBody"></tbody>
    </table>
  </div>
</section>

<!-- ── All Games ─────────────────────────────────────────────── -->
<section id="games">
  <div class="section-title">All Games</div>
  <div class="filter-bar">
    <input type="text"   id="gameSearch"        placeholder="Search game or vendor…" oninput="filterGames()">
    <select id="statusFilter" onchange="filterGames()">
      <option value="">All statuses</option>
      <option value="Pass">Pass only</option>
      <option value="Fail">Fail only</option>
    </select>
    <select id="vendorFilter" onchange="filterGames()">
      <option value="">All vendors</option>
    </select>
    <select id="flagFilter" onchange="filterGames()">
      <option value="">All games</option>
      <option value="flaky">Flaky only</option>
      <option value="sla">SLA breach only</option>
    </select>
    <span class="filter-count" id="gameCount"></span>
  </div>
  <div class="tbl-wrap">
    <table id="gamesTable">
      <thead>
        <tr>
          <th onclick="sortGames('gameName')">Game <span class="sort-icon">↕</span></th>
          <th onclick="sortGames('vendorName')">Vendor <span class="sort-icon">↕</span></th>
          <th onclick="sortGames('latestStatus')">Status <span class="sort-icon">↕</span></th>
          <th onclick="sortGames('latestGate')">Gate <span class="sort-icon">↕</span></th>
          <th onclick="sortGames('runs')">Runs <span class="sort-icon">↕</span></th>
          <th>Flags</th>
          <th>Latest Error</th>
        </tr>
      </thead>
      <tbody id="gamesBody"></tbody>
    </table>
  </div>
</section>

<footer>Generated ${escHtml(generatedAt)} · ${totalGames.toLocaleString()} results from ${totalRuns} run${totalRuns !== 1 ? 's' : ''} across ${totalVendors} vendors</footer>

</main>
</div><!-- /shell -->

<script>
// ── Embedded data ──────────────────────────────────────────────────────────
const VENDOR_STATS   = ${vendorStatsJson};
const GAME_RECORDS   = ${gameRecordsJson};
const RUN_TIMELINE   = ${runTimelineJson};
const ERROR_SUMMARY  = ${errorSummaryJson};
const GATE_TOTAL     = ${gateTotalJson};

// ── Nav active state ───────────────────────────────────────────────────────
function setActive(el) {
  document.querySelectorAll('nav a').forEach(a => a.classList.remove('active'));
  el.classList.add('active');
}
document.querySelectorAll('nav a')[0]?.classList.add('active');

// ── Vendor heatmap ─────────────────────────────────────────────────────────
(function buildHeatmap() {
  const container = document.getElementById('vendorHeatmap');
  VENDOR_STATS.forEach(v => {
    const passPct = v.total > 0 ? (v.passed / v.total * 100) : 0;
    const failPct = 100 - passPct;
    const pctClass = passPct < 50 ? 'low' : passPct < 90 ? 'mid' : '';
    const row = document.createElement('div');
    row.className = 'heatmap-row';
    row.innerHTML =
      '<div class="heatmap-label" title="' + v.vendorName + '">' + v.vendorName + '</div>' +
      '<div class="heatmap-bar-wrap">' +
        '<div class="heatmap-bar-pass" style="width:' + passPct.toFixed(1) + '%"></div>' +
        '<div class="heatmap-bar-fail" style="width:' + failPct.toFixed(1) + '%"></div>' +
      '</div>' +
      '<div class="heatmap-pct ' + pctClass + '">' + Math.round(passPct) + '%</div>';
    container.appendChild(row);
  });
})();

// ── Gate cards ─────────────────────────────────────────────────────────────
(function buildGateCards() {
  const container = document.getElementById('gateCards');
  const labels = { 1: 'Gate 1 — API Entry', 2: 'Gate 2 — iFrame Load', 3: 'Gate 3 — Error Scan', 4: 'Gate 4 — Stability' };
  const descs  = {
    1: 'enterGame API failed or returned no redirect URL',
    2: 'Game iframe did not load within 20 seconds',
    3: 'Error text detected immediately after iframe load',
    4: 'Error appeared or blank screen during stability watch',
  };
  const colors = { 1: 'var(--accent)', 2: 'var(--fail)', 3: 'var(--warn)', 4: 'var(--flaky)' };
  const totalFails = Object.values(GATE_TOTAL).reduce((a, b) => a + b, 0);
  [1,2,3,4].forEach(g => {
    const count = GATE_TOTAL[g] || 0;
    const pct   = totalFails > 0 ? (count / totalFails * 100).toFixed(1) : '0';
    const card  = document.createElement('div');
    card.className = 'card';
    card.innerHTML =
      '<div class="card-title">' + labels[g] + '</div>' +
      '<div style="font-size:28px;font-weight:700;font-family:var(--font);color:' + colors[g] + '">' + count.toLocaleString() + '</div>' +
      '<div style="font-size:11px;color:var(--muted);margin-top:2px">' + pct + '% of all failures</div>' +
      '<div class="pct-bar-wrap" style="margin-top:10px"><div class="pct-bar" style="width:' + pct + '%;background:' + colors[g] + '"></div></div>' +
      '<div style="font-size:11px;color:var(--muted);margin-top:10px">' + descs[g] + '</div>';
    container.appendChild(card);
  });
})();

// ── Charts ─────────────────────────────────────────────────────────────────
const CHART_DEFAULTS = {
  plugins: { legend: { labels: { color: '#7b82a0', font: { size: 12 } } } },
  scales: {
    x: { ticks: { color: '#7b82a0', font: { size: 11 } }, grid: { color: 'rgba(255,255,255,.05)' } },
    y: { ticks: { color: '#7b82a0', font: { size: 11 } }, grid: { color: 'rgba(255,255,255,.05)' } },
  }
};

// Error type doughnut
new Chart(document.getElementById('chartErrors'), {
  type: 'doughnut',
  data: {
    labels: Object.keys(ERROR_SUMMARY),
    datasets: [{ data: Object.values(ERROR_SUMMARY),
      backgroundColor: ['#ef4444','#f59e0b','#4f9cf9','#22c55e','#a78bfa','#f97316','#06b6d4','#ec4899'],
      borderWidth: 0 }]
  },
  options: {
    cutout: '65%',
    plugins: { legend: { position: 'right', labels: { color: '#7b82a0', font: { size: 11 }, boxWidth: 12 } } }
  }
});

// Gate bar
new Chart(document.getElementById('chartGates'), {
  type: 'bar',
  data: {
    labels: ['Gate 1', 'Gate 2', 'Gate 3', 'Gate 4'],
    datasets: [{
      data: [GATE_TOTAL[1]||0, GATE_TOTAL[2]||0, GATE_TOTAL[3]||0, GATE_TOTAL[4]||0],
      backgroundColor: ['#4f9cf9','#ef4444','#f59e0b','#a78bfa'],
      borderRadius: 6, borderWidth: 0,
    }]
  },
  options: {
    ...CHART_DEFAULTS,
    plugins: { legend: { display: false } },
    scales: { x: CHART_DEFAULTS.scales.x, y: { ...CHART_DEFAULTS.scales.y, beginAtZero: true } }
  }
});

// Timeline stacked bar
if (RUN_TIMELINE.length > 0) {
  new Chart(document.getElementById('chartTimeline'), {
    type: 'bar',
    data: {
      labels: RUN_TIMELINE.map(r => r.runFile.replace(/^[^_]+_/, '').replace('.csv','')),
      datasets: [
        { label: 'Pass', data: RUN_TIMELINE.map(r => r.passed), backgroundColor: '#22c55e', borderRadius: 4, borderWidth: 0 },
        { label: 'Fail', data: RUN_TIMELINE.map(r => r.failed), backgroundColor: '#ef4444', borderRadius: 4, borderWidth: 0 },
      ]
    },
    options: {
      ...CHART_DEFAULTS,
      scales: {
        x: { stacked: true, ...CHART_DEFAULTS.scales.x,
          ticks: { ...CHART_DEFAULTS.scales.x.ticks, maxRotation: 45 } },
        y: { stacked: true, ...CHART_DEFAULTS.scales.y, beginAtZero: true },
      },
      plugins: { legend: { labels: { color: '#7b82a0', font: { size: 12 } } } }
    }
  });
}

// ── Flaky table ────────────────────────────────────────────────────────────
(function buildFlakyTable() {
  const body  = document.getElementById('flakyBody');
  const flaky = GAME_RECORDS.filter(g => g.isFlaky);
  if (flaky.length === 0) {
    body.innerHTML = '<tr><td colspan="5" class="no-data">No flaky games detected.</td></tr>';
    return;
  }
  flaky.sort((a,b) => a.vendorName.localeCompare(b.vendorName));
  body.innerHTML = flaky.map(g =>
    '<tr>' +
      '<td title="' + esc(g.gameName) + '">' + esc(g.gameName) + '</td>' +
      '<td>' + esc(g.vendorName) + '</td>' +
      '<td style="font-family:var(--font)">' + g.runs + '</td>' +
      '<td><span class="badge badge-' + g.latestStatus.toLowerCase() + '">' + g.latestStatus + '</span></td>' +
      '<td class="text-muted" style="font-size:11px" title="' + esc(g.latestError) + '">' + esc((g.latestError||'').slice(0,60)) + '</td>' +
    '</tr>'
  ).join('');
})();

// ── SLA table ──────────────────────────────────────────────────────────────
(function buildSlaTable() {
  const body = document.getElementById('slaBody');
  const sla  = GAME_RECORDS.filter(g => g.slaBreached)
    .sort((a,b) => b.consecutiveFailHours - a.consecutiveFailHours);
  if (sla.length === 0) {
    body.innerHTML = '<tr><td colspan="5" class="no-data">No SLA breaches. All failing games are within the 24h window.</td></tr>';
    return;
  }
  body.innerHTML = sla.map(g =>
    '<tr>' +
      '<td title="' + esc(g.gameName) + '">' + esc(g.gameName) + '</td>' +
      '<td>' + esc(g.vendorName) + '</td>' +
      '<td style="font-family:var(--font);color:var(--warn)">' + g.consecutiveFailHours + 'h</td>' +
      '<td>' + (g.latestGate ? '<span class="badge badge-gate">Gate ' + g.latestGate + '</span>' : '—') + '</td>' +
      '<td class="text-muted" style="font-size:11px" title="' + esc(g.latestError) + '">' + esc((g.latestError||'').slice(0,70)) + '</td>' +
    '</tr>'
  ).join('');
})();

// ── All-games table ────────────────────────────────────────────────────────
let gamesSort  = { key: 'gameName', asc: true };
let gamesData  = [...GAME_RECORDS];

// Populate vendor filter
(function() {
  const vendors = [...new Set(GAME_RECORDS.map(g => g.vendorName))].sort();
  const sel = document.getElementById('vendorFilter');
  vendors.forEach(v => {
    const opt = document.createElement('option');
    opt.value = v; opt.textContent = v;
    sel.appendChild(opt);
  });
})();

function filterGames() {
  const q      = document.getElementById('gameSearch').value.toLowerCase();
  const status = document.getElementById('statusFilter').value;
  const vendor = document.getElementById('vendorFilter').value;
  const flag   = document.getElementById('flagFilter').value;

  gamesData = GAME_RECORDS.filter(g => {
    if (q && !g.gameName.toLowerCase().includes(q) && !g.vendorName.toLowerCase().includes(q) && !g.latestError.toLowerCase().includes(q)) return false;
    if (status && g.latestStatus !== status) return false;
    if (vendor && g.vendorName !== vendor) return false;
    if (flag === 'flaky' && !g.isFlaky) return false;
    if (flag === 'sla'   && !g.slaBreached) return false;
    return true;
  });
  sortAndRenderGames();
}

function sortGames(key) {
  if (gamesSort.key === key) gamesSort.asc = !gamesSort.asc;
  else { gamesSort.key = key; gamesSort.asc = true; }
  document.querySelectorAll('#gamesTable th').forEach(th => th.classList.remove('sorted'));
  const headers = ['gameName','vendorName','latestStatus','latestGate','runs'];
  const idx = headers.indexOf(key);
  if (idx >= 0) document.querySelectorAll('#gamesTable th')[idx]?.classList.add('sorted');
  sortAndRenderGames();
}

function sortAndRenderGames() {
  const { key, asc } = gamesSort;
  const sorted = [...gamesData].sort((a, b) => {
    const va = a[key] ?? '', vb = b[key] ?? '';
    return asc ? (va > vb ? 1 : -1) : (va < vb ? 1 : -1);
  });
  const body = document.getElementById('gamesBody');
  document.getElementById('gameCount').textContent = sorted.length.toLocaleString() + ' games';
  if (sorted.length === 0) {
    body.innerHTML = '<tr><td colspan="7" class="no-data">No games match the current filter.</td></tr>';
    return;
  }
  // Render only first 500 rows to keep DOM fast
  const visible = sorted.slice(0, 500);
  body.innerHTML = visible.map(g => {
    const flags = [
      g.isFlaky     ? '<span class="badge badge-flaky">flaky</span>' : '',
      g.slaBreached ? '<span class="badge badge-sla">SLA</span>'     : '',
    ].filter(Boolean).join(' ');
    return '<tr>' +
      '<td title="' + esc(g.gameName) + '">' + esc(g.gameName) + '</td>' +
      '<td>' + esc(g.vendorName) + '</td>' +
      '<td><span class="badge badge-' + g.latestStatus.toLowerCase() + '">' + g.latestStatus + '</span></td>' +
      '<td>' + (g.latestGate ? '<span class="badge badge-gate">Gate ' + g.latestGate + '</span>' : '—') + '</td>' +
      '<td style="font-family:var(--font)">' + g.runs + '</td>' +
      '<td>' + (flags || '<span class="text-muted">—</span>') + '</td>' +
      '<td class="text-muted" style="font-size:11px" title="' + esc(g.latestError) + '">' + esc((g.latestError||'—').slice(0,55)) + '</td>' +
    '</tr>';
  }).join('');
  if (sorted.length > 500) {
    body.innerHTML += '<tr><td colspan="7" class="no-data text-muted">Showing 500 of ' + sorted.length.toLocaleString() + ' — refine your filter to see more.</td></tr>';
  }
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

filterGames(); // initial render
</script>
</body>
</html>`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main(): void {
    const args      = process.argv.slice(2);
    const isLatest  = args.includes('--latest');
    const dirIdx    = args.indexOf('--dir');
    const outIdx    = args.indexOf('--out');

    // Resolve CSV source directory:
    //   --latest      → most recent dated subfolder only
    //   --dir <path>  → explicit path (absolute or relative to CWD)
    //   (default)     → all run subfolders under test-results/vendor-reports/
    let csvDir: string;
    if (dirIdx >= 0) {
        csvDir = path.resolve(CWD, args[dirIdx + 1]);
    } else if (isLatest) {
        csvDir = getLatestRunDir(DEFAULT_CSV_BASE);
    } else {
        csvDir = DEFAULT_CSV_BASE;
    }

    const outFile = outIdx >= 0
        ? path.resolve(CWD, args[outIdx + 1])
        : DEFAULT_OUT_FILE;

    console.log('\n─────────────────────────────────────────');
    console.log('  s9 Game Validation Report Generator');
    console.log('─────────────────────────────────────────');
    console.log(`  Working dir : ${CWD}`);
    console.log(`  CSV source  : ${csvDir}${isLatest ? '  (latest run)' : ''}`);
    console.log(`  Output      : ${outFile}`);
    console.log('─────────────────────────────────────────\n');

    const rows        = loadAllCsvs(csvDir);
    const vendorStats = computeVendorStats(rows);
    const gameRecords = computeGameRecords(rows);
    const runTimeline = computeRunTimeline(rows);

    console.log(`\n  Vendors      : ${vendorStats.length}`);
    console.log(`  Unique games : ${gameRecords.length}`);
    console.log(`  Flaky games  : ${gameRecords.filter(g => g.isFlaky).length}`);
    console.log(`  SLA breaches : ${gameRecords.filter(g => g.slaBreached).length}`);

    const html = generateHtml(rows, vendorStats, gameRecords, runTimeline);

    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, html, 'utf8');

    const kb = Math.round(fs.statSync(outFile).size / 1024);
    console.log(`\n✅  Report written: ${outFile} (${kb} KB)`);
    console.log(`\n    Open it:  start "${outFile}"\n`);
}

main();