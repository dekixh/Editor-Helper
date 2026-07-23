// installer/system.js
// Windows-specific helpers for the Uninstall flow: elevation detection, UAC
// state, and relaunching ourselves elevated. Kept here so installer.js stays
// focused on install/uninstall logic.
//
// Why this exists: a non-elevated process CANNOT trigger a UAC prompt via
// CreateProcess (Node's child_process.spawn). An exe whose manifest requires
// admin (Adobe's HDBox Uninstaller, MSIs, etc.) launched that way runs
// non-elevated and then refuses — Adobe shows "turn on UAC first". The only way
// to actually elevate from a non-elevated process is ShellExecute with the
// "runas" verb, which we reach via PowerShell `Start-Process -Verb RunAs`.

const { execSync } = require('child_process');
const logger = require('../core/logger');

// Is the current process running with an elevated (admin) token?
// `net session` succeeds only as administrator.
function isElevated() {
  try {
    execSync('net session', { stdio: 'ignore', windowsHide: true, timeout: 6000 });
    return true;
  } catch (_) {
    return false;
  }
}

// Is UAC enabled? Reads EnableLUA (1 = on, 0 = off). Defaults to true if the
// value can't be read (so we don't accidentally bypass the standard uninstaller).
function uacEnabled() {
  try {
    const out = execSync('reg query "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System" /v EnableLUA', {
      encoding: 'utf8', windowsHide: true, timeout: 6000,
    });
    return /EnableLUA\s+REG_DWORD\s+0x1/i.test(out);
  } catch (_) {
    return true;
  }
}

// Relaunch the current app elevated (UAC prompt if UAC is on) and quit.
// Used when an action needs admin but we aren't elevated.
function relaunchElevated() {
  try {
    const { app } = require('electron');
    const exe = process.execPath;
    const safeExe = exe.replace(/'/g, "''");
    const script = `Start-Process -FilePath '${safeExe}' -Verb RunAs`;
    const { spawn } = require('child_process');
    const child = spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', script], {
      detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.unref();
    child.on('error', (e) => logger.warn(`relaunchElevated spawn failed: ${e.message}`));
    // Give the spawn a moment, then quit so the elevated instance takes over.
    setTimeout(() => { try { app.exit(0); } catch (_) {} }, 300);
    logger.info('Relaunching elevated via PowerShell Start-Process -Verb RunAs');
    return true;
  } catch (e) {
    logger.error(`relaunchElevated failed: ${e.message}`);
    return false;
  }
}

// Run a PowerShell script ELEVATED, in place — without relaunching the Electron
// app. We spawn a non-elevated powershell that does `Start-Process -Verb RunAs
// -Wait`, which ShellExecute("runas")-elevates a second powershell running our
// script. For an admin user with ConsentPromptBehaviorAdmin=0 this elevates
// SILENTLY (no UAC dialog); with normal UAC a consent prompt appears; for a
// standard user a credential prompt appears. The elevated script writes its
// outcome as JSON to $ResultPath (injected below), and we read it back here.
//
// Why not relaunch the app elevated: the portable exe is extracted to a temp
// dir at launch; the elevated instance races the dying instance's single-
// instance lock + temp extraction and may exit before any window appears, so
// the user sees "nothing happens". Running only the removal elevated keeps the
// original (non-elevated) window alive and just reports the result.
//
// scriptText must, at the end, write ConvertTo-Json of its result to $ResultPath.
// Resolves to { ok, exitCode, stdout, stderr, result } where `result` is the
// parsed JSON the script wrote (or null).
function runElevatedPowerShell(scriptText) {
  return new Promise((resolve) => {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const { spawn } = require('child_process');

    const tag = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const scriptPath = path.join(os.tmpdir(), `aepm-elev-${tag}.ps1`);
    const resultPath = path.join(os.tmpdir(), `aepm-elev-result-${tag}.json`);

    // Inject the result path + a guard footer so the script always emits JSON
    // even if it throws partway through.
    const fullScript =
      `$ResultPath = '${String(resultPath).replace(/'/g, "''")}'\n` +
      `$removed = @(); $missing = @(); $errors = @(); $cleaned = @()\n` +
      `try {\n${scriptText}\n} catch { $errors += $_.Exception.Message }\n` +
      `try { Set-Content -LiteralPath $ResultPath -Value (ConvertTo-Json -Compress -Depth 4 @{ removed=$removed; missing=$missing; errors=$errors; cleaned=$cleaned }) -Encoding UTF8 } catch {}\n`;

    try {
      // Prepend a UTF-8 BOM so Windows PowerShell decodes the temp script as
      // UTF-8 (it falls back to the system ANSI codepage for BOM-less files,
      // which would mojibake the Cyrillic error strings).
      fs.writeFileSync(scriptPath, '﻿' + fullScript, 'utf8');
    } catch (e) {
      return resolve({ ok: false, error: 'cannot write elevated script: ' + e.message });
    }

    // Outer (non-elevated) powershell: RunAs + Wait for the elevated inner one.
    const innerArgs = `'-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File','${String(scriptPath).replace(/'/g, "''")}'`;
    const cmd = `try { $p = Start-Process powershell -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList @(${innerArgs}); "EXIT=$($p.ExitCode)" } catch { "ERR=$($_.Exception.Message)" }`;

    const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', cmd], {
      windowsHide: true,
    });
    let out = '', errOut = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { errOut += d.toString(); });
    const finish = (ok, error) => {
      let result = null;
      try {
        // PowerShell `-Encoding UTF8` emits a BOM; JSON.parse would choke on it.
        result = JSON.parse(fs.readFileSync(resultPath, 'utf8').replace(/^﻿/, ''));
      } catch (_) {}
      try { fs.unlinkSync(scriptPath); } catch (_) {}
      try { fs.unlinkSync(resultPath); } catch (_) {}
      resolve({ ok, error, stdout: out, stderr: errOut, result });
    };
    child.on('error', (e) => finish(false, 'spawn failed: ' + e.message));
    child.on('close', (code) => {
      const denied = /ERR=/.test(out) || code !== 0;
      if (denied && !out.includes('EXIT=')) finish(false, 'elevation denied or failed: ' + out.trim());
      else finish(true, null);
    });
  });
}

module.exports = { isElevated, uacEnabled, relaunchElevated, runElevatedPowerShell };