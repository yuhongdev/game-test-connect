/**
 * diffRuns.ts
 *
 * Compares two test runs and produces a diff showing:
 *   - Pass → Fail regressions  (games that broke)
 *   - Fail → Pass recoveries   (games that were fixed)
 *   - New games that appeared in run B but not in run A
 *   - Games that disappeared from run B that were in run A
 *   - Games that changed error type (same gate, different message)
 *
 * ── Usage (run from project root: D:\Yoong testing) ──────────────────────────
 *
 *   Auto-diff the two most recent run folders:
 *     npx ts-node tests/reports/diffRuns.ts --latest
 *
 *   Diff two specific dated run folders:
 *     npx ts-node tests/reports/diffRuns.ts ^
 *       --a-dir test-results/vendor-reports/2026-03-18T08-00-00 ^
 *       --b-dir test-results/vendor-reports/2026-03-19T08-00-00
 *
 *   Diff two specific CSV files:
 *     npx ts-node tests/reports/diffRuns.ts ^
 *       --a test-results/vendor-reports/2026-03-18T08-00-00/Amusnet_2026-03-18T08-00-00.csv ^
 *       --b test-results/vendor-reports/2026-03-19T08-00-00/Amusnet_2026-03-19T08-00-00.csv
 *
 *   Custom output:
 *     npx ts-node tests/reports/diffRuns.ts --latest --out my-diff.html
 *
 * ── Output ────────────────────────────────────────────────────────────────────
 *
 *   Console: summary + regression list
 *   File:    test-results/diff.html  (self-contained, open with: start test-results\diff.html)
 */

import * as fs   from 'fs';
import * as path from 'path';

// ── Config ────────────────────────────────────────────────────────────────────

// Paths resolved from process.cwd() (project root), not __dirname (script dir)
const CWD              = process.cwd();
const DEFAULT_CSV_BASE = path.join(CWD, 'test-results', 'vendor-reports');
const DEFAULT_OUT_FILE = path.join(CWD, 'test-results', 'diff.html');

// ── Types ─────────────────────────────────────────────────────────────────────

interface GameSnapshot {
    gameId:    number;
    gameName:  string;
    vendorId:  number;
    vendorName: string;
    status:    'Pass' | 'Fail';
    gate:      number | null;
    error:     string;
    retries:   number;
    timestamp: string;
}

type ChangeType = 'regression' | 'recovery' | 'new' | 'removed' | 'error-changed' | 'unchanged';

interface DiffEntry {
    gameId:     number;
    gameName:   string;
    vendorName: string;
    change:     ChangeType;
    before:     GameSnapshot | null;
    after:      GameSnapshot | null;
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
            fields.push(current); current = '';
        } else current += ch;
    }
    fields.push(current);
    return fields;
}

function loadSnapshots(csvPaths: string[]): Map<number, GameSnapshot> {
    const map = new Map<number, GameSnapshot>();

    for (const csvPath of csvPaths) {
        if (!fs.existsSync(csvPath)) {
            console.warn(`  ⚠ File not found: ${csvPath}`);
            continue;
        }
        const lines = fs.readFileSync(csvPath, 'utf8').trim().split('\n');
        for (let i = 1; i < lines.length; i++) {
            const parts = parseCsvLine(lines[i].trim());
            if (parts.length < 9) continue;

            // Handle both 9-column (old) and 10-column (new, has FrameDepth)
            // Columns: VendorId,VendorName,GameId,GameName,Status,Gate,Retries,[FrameDepth,]Error,Timestamp
            let vendorIdStr: string, vendorName: string, gameIdStr: string, gameName: string,
                status: string, gateStr: string, retriesStr: string, error: string, timestamp: string;

            if (parts.length >= 10) {
                [vendorIdStr, vendorName, gameIdStr, gameName,
                 status, gateStr, retriesStr, , error, timestamp] = parts;
            } else {
                [vendorIdStr, vendorName, gameIdStr, gameName,
                 status, gateStr, retriesStr, error, timestamp] = parts;
            }

            const gameId = parseInt(gameIdStr, 10);
            if (!gameId) continue;
            map.set(gameId, {
                gameId,
                gameName:   gameName.trim(),
                vendorId:   parseInt(vendorIdStr, 10) || 0,
                vendorName: vendorName.trim(),
                status:     status.trim() as 'Pass' | 'Fail',
                gate:       gateStr.trim() ? parseInt(gateStr.trim(), 10) : null,
                error:      error.trim(),
                retries:    parseInt(retriesStr.trim(), 10) || 0,
                timestamp:  timestamp.trim(),
            });
        }
    }

    return map;
}

function loadFromDir(dir: string): Map<number, GameSnapshot> {
    const absDir = path.resolve(CWD, dir);
    if (!fs.existsSync(absDir)) {
        console.error(`\n❌  Directory not found: ${absDir}\n`);
        process.exit(1);
    }
    // Collect CSVs — handles both flat (*.csv) and nested (subdir/*.csv)
    const files: string[] = [];
    const entries = fs.readdirSync(absDir, { withFileTypes: true });
    for (const e of entries) {
        if (e.isFile() && e.name.endsWith('.csv')) {
            files.push(path.join(absDir, e.name));
        } else if (e.isDirectory()) {
            const subCsvs = fs.readdirSync(path.join(absDir, e.name))
                .filter(f => f.endsWith('.csv'))
                .map(f => path.join(absDir, e.name, f));
            files.push(...subCsvs);
        }
    }
    return loadSnapshots(files);
}

/**
 * Returns the two most recent run folders as [aFiles[], bFiles[]].
 * With the new structure, each run is a dated subfolder.
 * Falls back to timestamp-based splitting from filenames if no subfolders exist.
 */
function getLatestTwoRuns(baseDir: string): [string[], string[]] {
    const absBase = path.resolve(CWD, baseDir);

    if (!fs.existsSync(absBase)) {
        console.error(`\n❌  Directory not found: ${absBase}`);
        console.error(`\n    Run the validation first:\n`);
        console.error(`      npx playwright test tests/v4/ --project=chromium --workers=6\n`);
        process.exit(1);
    }

    const entries = fs.readdirSync(absBase, { withFileTypes: true });
    const subDirs = entries
        .filter(e => e.isDirectory())
        .map(e => e.name)
        .sort();

    if (subDirs.length >= 2) {
        // New structure: each subfolder = one run
        const folderA = subDirs[subDirs.length - 2];
        const folderB = subDirs[subDirs.length - 1];
        const aFiles  = fs.readdirSync(path.join(absBase, folderA))
            .filter(f => f.endsWith('.csv'))
            .map(f => path.join(absBase, folderA, f));
        const bFiles  = fs.readdirSync(path.join(absBase, folderB))
            .filter(f => f.endsWith('.csv'))
            .map(f => path.join(absBase, folderB, f));
        console.log(`  Run A (before): ${folderA}  (${aFiles.length} vendor file${aFiles.length !== 1 ? 's' : ''})`);
        console.log(`  Run B (after):  ${folderB}  (${bFiles.length} vendor file${bFiles.length !== 1 ? 's' : ''})`);
        return [aFiles, bFiles];
    }

    if (subDirs.length === 1) {
        console.error(`\n❌  Only one run folder found. Need at least two runs to diff.\n`);
        process.exit(1);
    }

    // Flat structure fallback: group by timestamp embedded in filename
    const files = entries
        .filter(e => e.isFile() && e.name.endsWith('.csv'))
        .map(e => e.name)
        .sort();

    if (files.length < 2) {
        console.error(`\n❌  Need at least 2 CSV files to diff. Found: ${files.length} in ${absBase}\n`);
        process.exit(1);
    }

    const timestamps = [...new Set(files.map(f => {
        const m = f.match(/_(\d{4}-\d{2}-\d{2}T[\d-]+)\.csv$/);
        return m ? m[1] : null;
    }).filter(Boolean) as string[])].sort();

    if (timestamps.length < 2) {
        console.error(`\n❌  Cannot detect two distinct run timestamps in filenames.\n`);
        process.exit(1);
    }

    const tA     = timestamps[timestamps.length - 2];
    const tB     = timestamps[timestamps.length - 1];
    const aFiles = files.filter(f => f.includes(tA)).map(f => path.join(absBase, f));
    const bFiles = files.filter(f => f.includes(tB)).map(f => path.join(absBase, f));
    console.log(`  Run A (before): timestamp ${tA}  (${aFiles.length} files)`);
    console.log(`  Run B (after):  timestamp ${tB}  (${bFiles.length} files)`);
    return [aFiles, bFiles];
}

// ── Diff computation ──────────────────────────────────────────────────────────

function computeDiff(
    snapA: Map<number, GameSnapshot>,
    snapB: Map<number, GameSnapshot>,
): DiffEntry[] {
    const entries: DiffEntry[] = [];
    const allIds = new Set([...snapA.keys(), ...snapB.keys()]);

    for (const gameId of allIds) {
        const before = snapA.get(gameId) ?? null;
        const after  = snapB.get(gameId) ?? null;

        let change: ChangeType;

        if (!before && after) {
            change = 'new';
        } else if (before && !after) {
            change = 'removed';
        } else if (before && after) {
            if (before.status === 'Pass' && after.status === 'Fail') {
                change = 'regression';
            } else if (before.status === 'Fail' && after.status === 'Pass') {
                change = 'recovery';
            } else if (before.status === 'Fail' && after.status === 'Fail'
                       && before.error !== after.error) {
                change = 'error-changed';
            } else {
                change = 'unchanged';
            }
        } else {
            continue;
        }

        entries.push({
            gameId,
            gameName:   (after ?? before)!.gameName,
            vendorName: (after ?? before)!.vendorName,
            change,
            before,
            after,
        });
    }

    // Sort: regressions first, then recoveries, then rest
    const order: ChangeType[] = ['regression', 'error-changed', 'new', 'removed', 'recovery', 'unchanged'];
    return entries.sort((a, b) => {
        const ia = order.indexOf(a.change);
        const ib = order.indexOf(b.change);
        if (ia !== ib) return ia - ib;
        return a.vendorName.localeCompare(b.vendorName) || a.gameName.localeCompare(b.gameName);
    });
}

// ── Console summary ───────────────────────────────────────────────────────────

function printSummary(diff: DiffEntry[]): void {
    const groups = {
        regression:     diff.filter(d => d.change === 'regression'),
        recovery:       diff.filter(d => d.change === 'recovery'),
        'error-changed':diff.filter(d => d.change === 'error-changed'),
        new:            diff.filter(d => d.change === 'new'),
        removed:        diff.filter(d => d.change === 'removed'),
    };

    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║           RUN DIFF SUMMARY                       ║');
    console.log('╠══════════════════════════════════════════════════╣');
    console.log(`║  ✗ Regressions (Pass→Fail):  ${String(groups.regression.length).padStart(5)}                ║`);
    console.log(`║  ✅ Recoveries  (Fail→Pass):  ${String(groups.recovery.length).padStart(5)}                ║`);
    console.log(`║  ~ Error changed (Fail→Fail): ${String(groups['error-changed'].length).padStart(5)}                ║`);
    console.log(`║  + New games:                 ${String(groups.new.length).padStart(5)}                ║`);
    console.log(`║  - Removed games:             ${String(groups.removed.length).padStart(5)}                ║`);
    console.log('╚══════════════════════════════════════════════════╝');

    if (groups.regression.length > 0) {
        console.log('\n⚠  REGRESSIONS (games that broke):');
        groups.regression.forEach(d => {
            console.log(`   [${d.vendorName}] ${d.gameName}`);
            console.log(`     Before: Pass`);
            console.log(`     After:  Fail (Gate ${d.after?.gate ?? '?'}) — ${d.after?.error ?? ''}`);
        });
    }

    if (groups.recovery.length > 0) {
        console.log('\n✅ RECOVERIES (games that were fixed):');
        groups.recovery.forEach(d => {
            console.log(`   [${d.vendorName}] ${d.gameName}`);
        });
    }
}

// ── HTML output ───────────────────────────────────────────────────────────────

function escHtml(s: string): string {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function generateDiffHtml(diff: DiffEntry[], labelA: string, labelB: string): string {
    const regressions    = diff.filter(d => d.change === 'regression');
    const recoveries     = diff.filter(d => d.change === 'recovery');
    const errorChanged   = diff.filter(d => d.change === 'error-changed');
    const newGames       = diff.filter(d => d.change === 'new');
    const removedGames   = diff.filter(d => d.change === 'removed');
    const unchanged      = diff.filter(d => d.change === 'unchanged');

    const generatedAt    = new Date().toLocaleString();

    function tableRows(entries: DiffEntry[], showBefore: boolean, showAfter: boolean): string {
        if (entries.length === 0) return '<tr><td colspan="5" style="text-align:center;color:#7b82a0;padding:20px">None</td></tr>';
        return entries.map(d => {
            const before = d.before ? `Gate ${d.before.gate ?? '?'}: ${(d.before.error || 'Pass').slice(0,60)}` : '—';
            const after  = d.after  ? `Gate ${d.after.gate  ?? '?'}: ${(d.after.error  || 'Pass').slice(0,60)}` : '—';
            return '<tr>' +
                '<td title="' + escHtml(d.gameName) + '">' + escHtml(d.gameName) + '</td>' +
                '<td>' + escHtml(d.vendorName) + '</td>' +
                (showBefore ? '<td class="mono muted" title="' + escHtml(before) + '">' + escHtml(before.slice(0,55)) + '</td>' : '') +
                (showAfter  ? '<td class="mono muted" title="' + escHtml(after)  + '">' + escHtml(after.slice(0,55))  + '</td>' : '') +
            '</tr>';
        }).join('');
    }

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Run Diff — ${escHtml(labelA)} vs ${escHtml(labelB)}</title>
<style>
  :root { --bg:#0d0f14;--bg2:#151820;--bg3:#1c2030;--border:#2a2f42;--text:#e8eaf0;--muted:#7b82a0;--pass:#22c55e;--fail:#ef4444;--warn:#f59e0b;--accent:#4f9cf9;--flaky:#a78bfa; }
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--text);font-family:'DM Sans','Segoe UI',system-ui,sans-serif;font-size:14px;padding:32px;line-height:1.6}
  h1{font-size:20px;font-weight:700;margin-bottom:4px}
  .sub{color:var(--muted);font-size:12px;margin-bottom:28px}
  .kpi-row{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:32px}
  .kpi{background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:16px 20px;min-width:140px}
  .kpi label{font-size:10px;color:var(--muted);letter-spacing:.07em;text-transform:uppercase}
  .kpi .val{font-size:26px;font-weight:700;font-family:'DM Mono',monospace;margin-top:4px}
  section{margin-bottom:36px}
  .section-title{font-size:11px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);padding-bottom:8px;border-bottom:1px solid var(--border);margin-bottom:14px}
  .tbl-wrap{overflow-x:auto;border-radius:8px;border:1px solid var(--border)}
  table{width:100%;border-collapse:collapse;font-size:13px}
  thead tr{background:var(--bg3)}
  th{padding:9px 14px;text-align:left;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--border)}
  td{padding:8px 14px;border-bottom:1px solid var(--border);max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  tr:last-child td{border-bottom:none}
  tr:hover td{background:rgba(79,156,249,.04)}
  .mono{font-family:'DM Mono',monospace;font-size:11px}
  .muted{color:var(--muted)}
  .text-pass{color:var(--pass)}.text-fail{color:var(--fail)}.text-warn{color:var(--warn)}.text-accent{color:var(--accent)}.text-flaky{color:var(--flaky)}
  footer{font-size:11px;color:var(--muted);margin-top:32px;padding-top:12px;border-top:1px solid var(--border)}
</style>
</head>
<body>

<h1>Run Diff</h1>
<div class="sub">Comparing <strong>${escHtml(labelA)}</strong> → <strong>${escHtml(labelB)}</strong> &nbsp;·&nbsp; Generated ${escHtml(generatedAt)}</div>

<div class="kpi-row">
  <div class="kpi"><label>Regressions</label><div class="val text-fail">${regressions.length}</div></div>
  <div class="kpi"><label>Recoveries</label><div class="val text-pass">${recoveries.length}</div></div>
  <div class="kpi"><label>Error Changed</label><div class="val text-warn">${errorChanged.length}</div></div>
  <div class="kpi"><label>New Games</label><div class="val text-accent">${newGames.length}</div></div>
  <div class="kpi"><label>Removed Games</label><div class="val muted">${removedGames.length}</div></div>
  <div class="kpi"><label>Unchanged</label><div class="val muted">${unchanged.length}</div></div>
</div>

<section id="regressions">
  <div class="section-title">⚠ Regressions — Pass → Fail (${regressions.length})</div>
  <div class="tbl-wrap"><table>
    <thead><tr><th>Game</th><th>Vendor</th><th>Before</th><th>After (Fail)</th></tr></thead>
    <tbody>${tableRows(regressions, true, true)}</tbody>
  </table></div>
</section>

<section id="recoveries">
  <div class="section-title">✅ Recoveries — Fail → Pass (${recoveries.length})</div>
  <div class="tbl-wrap"><table>
    <thead><tr><th>Game</th><th>Vendor</th><th>Before (Fail)</th><th>After</th></tr></thead>
    <tbody>${tableRows(recoveries, true, true)}</tbody>
  </table></div>
</section>

<section id="error-changed">
  <div class="section-title">~ Error Changed — Fail → Fail (${errorChanged.length})</div>
  <div class="tbl-wrap"><table>
    <thead><tr><th>Game</th><th>Vendor</th><th>Before Error</th><th>After Error</th></tr></thead>
    <tbody>${tableRows(errorChanged, true, true)}</tbody>
  </table></div>
</section>

<section id="new">
  <div class="section-title">+ New Games (${newGames.length})</div>
  <div class="tbl-wrap"><table>
    <thead><tr><th>Game</th><th>Vendor</th><th>Status in B</th></tr></thead>
    <tbody>${newGames.length === 0 ? '<tr><td colspan="3" style="text-align:center;color:#7b82a0;padding:20px">None</td></tr>' :
      newGames.map(d => '<tr><td>' + escHtml(d.gameName) + '</td><td>' + escHtml(d.vendorName) + '</td><td class="' + (d.after?.status === 'Pass' ? 'text-pass' : 'text-fail') + '">' + (d.after?.status || '?') + '</td></tr>').join('')
    }</tbody>
  </table></div>
</section>

<section id="removed">
  <div class="section-title">- Removed Games (${removedGames.length})</div>
  <div class="tbl-wrap"><table>
    <thead><tr><th>Game</th><th>Vendor</th><th>Last Status</th></tr></thead>
    <tbody>${removedGames.length === 0 ? '<tr><td colspan="3" style="text-align:center;color:#7b82a0;padding:20px">None</td></tr>' :
      removedGames.map(d => '<tr><td>' + escHtml(d.gameName) + '</td><td>' + escHtml(d.vendorName) + '</td><td class="' + (d.before?.status === 'Pass' ? 'text-pass' : 'text-fail') + '">' + (d.before?.status || '?') + '</td></tr>').join('')
    }</tbody>
  </table></div>
</section>

<footer>Generated ${escHtml(generatedAt)}</footer>
</body></html>`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main(): void {
    const args     = process.argv.slice(2);
    const isLatest = args.includes('--latest');
    const aIdx     = args.indexOf('--a');
    const bIdx     = args.indexOf('--b');
    const aDirIdx  = args.indexOf('--a-dir');
    const bDirIdx  = args.indexOf('--b-dir');
    const outIdx   = args.indexOf('--out');
    const outFile  = outIdx >= 0
        ? path.resolve(CWD, args[outIdx + 1])
        : DEFAULT_OUT_FILE;

    let snapA: Map<number, GameSnapshot>;
    let snapB: Map<number, GameSnapshot>;
    let labelA = 'Run A';
    let labelB = 'Run B';

    console.log('\n─────────────────────────────────────────');
    console.log('  s9 Game Validation — Run Diff');
    console.log('─────────────────────────────────────────\n');

    if (isLatest) {
        console.log(`Auto-detecting latest two runs from: ${DEFAULT_CSV_BASE}\n`);
        const [aFiles, bFiles] = getLatestTwoRuns(DEFAULT_CSV_BASE);
        snapA  = loadSnapshots(aFiles);
        snapB  = loadSnapshots(bFiles);
        labelA = path.basename(path.dirname(aFiles[0] || '')) || 'Run A';
        labelB = path.basename(path.dirname(bFiles[0] || '')) || 'Run B';
    } else if (aIdx >= 0 && bIdx >= 0) {
        const aFile = path.resolve(CWD, args[aIdx + 1]);
        const bFile = path.resolve(CWD, args[bIdx + 1]);
        console.log(`  A: ${aFile}\n  B: ${bFile}\n`);
        snapA  = loadSnapshots([aFile]);
        snapB  = loadSnapshots([bFile]);
        labelA = path.basename(aFile);
        labelB = path.basename(bFile);
    } else if (aDirIdx >= 0 && bDirIdx >= 0) {
        const aDir = args[aDirIdx + 1];
        const bDir = args[bDirIdx + 1];
        console.log(`  A dir: ${path.resolve(CWD, aDir)}\n  B dir: ${path.resolve(CWD, bDir)}\n`);
        snapA  = loadFromDir(aDir);
        snapB  = loadFromDir(bDir);
        labelA = path.basename(aDir);
        labelB = path.basename(bDir);
    } else {
        console.log('Usage (run from project root):\n');
        console.log('  Auto-diff latest two runs:');
        console.log('    npx ts-node tests/reports/diffRuns.ts --latest\n');
        console.log('  Diff two run folders:');
        console.log('    npx ts-node tests/reports/diffRuns.ts --a-dir test-results/vendor-reports/2026-03-18T08-00-00 --b-dir test-results/vendor-reports/2026-03-19T08-00-00\n');
        console.log('  Diff two specific CSV files:');
        console.log('    npx ts-node tests/reports/diffRuns.ts --a path/to/a.csv --b path/to/b.csv\n');
        process.exit(1);
    }

    console.log(`\n  Run A: ${snapA.size} games  |  Run B: ${snapB.size} games`);

    const diff = computeDiff(snapA, snapB);
    printSummary(diff);

    const html = generateDiffHtml(diff, labelA, labelB);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, html, 'utf8');

    const kb = Math.round(fs.statSync(outFile).size / 1024);
    console.log(`\n✅  Diff report written: ${outFile} (${kb} KB)`);
    console.log(`\n    Open it:  start "${outFile}"\n`);
}

main();