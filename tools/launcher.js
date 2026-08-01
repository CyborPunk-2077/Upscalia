#!/usr/bin/env node
'use strict';

/**
 * Visionance launcher.
 *
 * The .cmd files at the project root are deliberately thin wrappers around this
 * script. Batch is hard to test and easy to get subtly wrong; this is plain
 * Node (which the app requires anyway), so the logic can be exercised on any
 * platform.
 *
 *   node tools/launcher.js            start the app
 *   node tools/launcher.js --stop     stop a running instance
 *   node tools/launcher.js --reset    delete local build state (asks first)
 *   node tools/launcher.js --doctor   run the checks, change nothing
 *
 * Services this app needs, derived from the source rather than assumed:
 *   - Node.js + npm ....... to install dependencies and run Electron
 *   - Electron ............ the app itself; there is no separate backend
 *   - ffmpeg/ffprobe ...... optional, only for the Export tab (via ffmpeg-static)
 *   - yt-dlp .............. optional, downloaded by the app on request
 *
 * There is no HTTP server, no database and no container in this project, so the
 * launcher deliberately does NOT check for Docker or open a browser. The
 * Electron window is the UI.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const STATE_DIR = path.join(ROOT, '.visionance');
const LOCK_FILE = path.join(STATE_DIR, 'run.lock');
const LOG_DIR = path.join(ROOT, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'visionance.log');
const INSTALL_LOG = path.join(LOG_DIR, 'install.log');

const MIN_NODE_MAJOR = 20;
/** How long the app may take to get on its feet before we call it healthy. */
const READY_GRACE_MS = 6000;
/** Hard ceiling on the startup wait. Bounded: this loop can never hang. */
const STARTUP_TIMEOUT_MS = 90000;
/** Hard ceiling on `npm ci`. A cold Electron download is ~200 MB. */
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;

const IS_WIN = process.platform === 'win32';

/* ------------------------------------------------------------------ *
 * Output helpers
 * ------------------------------------------------------------------ */

const useColour = process.stdout.isTTY && !process.env.NO_COLOR;
const ESC = '\u001b';
const c = (code, s) => (useColour ? `${ESC}[${code}m${s}${ESC}[0m` : s);
const bold = (s) => c('1', s);
const dim = (s) => c('2', s);
const green = (s) => c('32', s);
const yellow = (s) => c('33', s);
const red = (s) => c('31', s);
const cyan = (s) => c('36', s);

const say = (s = '') => console.log(s);
const step = (s) => say(`${cyan('>')} ${s}`);
const ok = (s) => say(`${green('OK')}  ${s}`);
const warn = (s) => say(`${yellow('!')}   ${s}`);
const info = (s) => say(`${dim('    ' + s)}`);

function banner() {
  say();
  say(bold('  Visionance'));
  say(dim('  real-time video enhancement'));
  say(dim('  ' + '-'.repeat(52)));
  say();
}

/**
 * Every fatal exit goes through here so the user always gets: what broke, why,
 * and what to do next - in plain English, never a bare stack trace.
 */
function fail(title, reasons = [], fixes = []) {
  say();
  say(red(bold('  Could not start Visionance')));
  say();
  say(`  ${bold(title)}`);
  if (reasons.length) {
    say();
    reasons.forEach((r) => say(`    ${r}`));
  }
  if (fixes.length) {
    say();
    say('  What to do:');
    fixes.forEach((f, i) => say(`    ${i + 1}. ${f}`));
  }
  say();
  if (fs.existsSync(LOG_FILE)) {
    say(dim(`  Full log: ${LOG_FILE}`));
  }
  say();
  process.exitCode = 1;
}

function ensureDirs() {
  for (const d of [STATE_DIR, LOG_DIR]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch { /* non-fatal */ }
  }
}

/** Last N non-empty lines of a log, for failure reporting. */
function tailLog(file, lines = 12) {
  try {
    return fs.readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .slice(-lines);
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ *
 * Single-instance lock
 * ------------------------------------------------------------------ */

function readLock() {
  try {
    return JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    // Signal 0 performs the permission/existence check without delivering it.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // exists but owned by someone else
  }
}

function acquireLock(childPid) {
  ensureDirs();
  fs.writeFileSync(
    LOCK_FILE,
    JSON.stringify({ pid: childPid, launcherPid: process.pid, startedAt: Date.now() }, null, 2)
  );
}

function releaseLock() {
  try { fs.unlinkSync(LOCK_FILE); } catch { /* already gone */ }
}

/**
 * @returns {{running:boolean, pid?:number}} whether a live instance holds the lock
 */
function checkExistingInstance() {
  const lock = readLock();
  if (!lock) return { running: false };
  if (isAlive(lock.pid)) return { running: true, pid: lock.pid };
  info('Clearing a stale lock left by a previous run.');
  releaseLock();
  return { running: false };
}

/* ------------------------------------------------------------------ *
 * Preflight checks
 * ------------------------------------------------------------------ */

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (Number.isFinite(major) && major < MIN_NODE_MAJOR) {
    return {
      ok: false,
      title: `Node.js ${process.versions.node} is too old.`,
      reasons: [`Visionance needs Node.js ${MIN_NODE_MAJOR} or newer.`],
      fixes: [
        'Install the current LTS from https://nodejs.org',
        'Close this window, open a new one, and run RUN_VISIONANCE.cmd again'
      ]
    };
  }
  return { ok: true, detail: `Node.js ${process.versions.node}` };
}

function npmCommand() {
  return IS_WIN ? 'npm.cmd' : 'npm';
}

function checkNpm() {
  const res = spawnSync(npmCommand(), ['--version'], {
    encoding: 'utf8',
    shell: IS_WIN,
    windowsHide: true
  });
  if (res.error || res.status !== 0) {
    return {
      ok: false,
      title: 'npm is not available.',
      reasons: ['Node.js was found, but npm could not be run.'],
      fixes: [
        'Reinstall Node.js from https://nodejs.org (npm ships with it)',
        'Make sure npm is on your PATH, then try again'
      ]
    };
  }
  return { ok: true, detail: `npm ${String(res.stdout).trim()}` };
}

/* ------------------------------------------------------------------ *
 * Dependency state
 * ------------------------------------------------------------------ */

const NODE_MODULES = path.join(ROOT, 'node_modules');
const LOCK_JSON = path.join(ROOT, 'package-lock.json');
const INSTALLED_LOCK = path.join(NODE_MODULES, '.package-lock.json');

/** Path to the Electron executable the app will actually run. */
function electronBinaryPath() {
  const dist = path.join(NODE_MODULES, 'electron', 'dist');
  if (IS_WIN) return path.join(dist, 'electron.exe');
  if (process.platform === 'darwin') {
    return path.join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron');
  }
  return path.join(dist, 'electron');
}

/**
 * @returns {'ok'|'missing'|'stale'}
 *   missing - no node_modules at all
 *   stale   - package-lock.json changed since the last install
 *
 * Note this deliberately does NOT consider the Electron binary. Electron 43
 * dropped its postinstall script and downloads the runtime lazily on first
 * use, so a missing binary is normal after a fresh install and is handled
 * separately by ensureElectronBinary().
 */
function dependencyState() {
  if (!fs.existsSync(NODE_MODULES) || !fs.existsSync(INSTALLED_LOCK)) return 'missing';

  try {
    const lockMtime = fs.statSync(LOCK_JSON).mtimeMs;
    const installedMtime = fs.statSync(INSTALLED_LOCK).mtimeMs;
    // A second of slack: some filesystems round mtimes.
    if (lockMtime > installedMtime + 1000) return 'stale';
  } catch {
    return 'missing';
  }
  return 'ok';
}

/**
 * The Node version Electron itself requires, read from whatever source is
 * available rather than hardcoded, so it stays correct across upgrades.
 * @returns {{raw:string, major:number, minor:number}|null}
 */
function electronNodeRequirement() {
  const readEngines = () => {
    try {
      return require(path.join(NODE_MODULES, 'electron', 'package.json')).engines;
    } catch { /* not installed yet */ }
    try {
      const lock = JSON.parse(fs.readFileSync(LOCK_JSON, 'utf8'));
      return lock.packages['node_modules/electron'].engines;
    } catch {
      return null;
    }
  };

  const engines = readEngines();
  if (!engines || !engines.node) return null;
  const m = /(\d+)\.(\d+)/.exec(engines.node);
  if (!m) return null;
  return { raw: engines.node, major: Number(m[1]), minor: Number(m[2]) };
}

function checkElectronEngine() {
  const need = electronNodeRequirement();
  if (!need) return { ok: true, detail: null };

  const [major, minor] = process.versions.node.split('.').map(Number);
  const satisfied = major > need.major || (major === need.major && minor >= need.minor);
  if (satisfied) return { ok: true, detail: `Node satisfies Electron's requirement (${need.raw})` };

  return {
    ok: false,
    title: `Node.js ${process.versions.node} is too old for this version of Electron.`,
    reasons: [
      `Electron requires Node ${need.raw} to install and run in development.`,
      `You have Node ${process.versions.node}.`
    ],
    fixes: [
      'Install the current LTS from https://nodejs.org',
      'Close this window, open a new one, and double-click RUN_VISIONANCE.cmd again'
    ]
  };
}

function runInstall() {
  ensureDirs();
  const logStream = fs.createWriteStream(INSTALL_LOG, { flags: 'w' });
  logStream.write(`# npm ci started ${new Date().toISOString()}\n`);

  say();
  info('This can take a few minutes the first time (Electron is a ~200 MB download).');
  info(`Live output below; a copy is saved to ${path.relative(ROOT, INSTALL_LOG)}`);
  say();

  return new Promise((resolve) => {
    // `npm ci` installs exactly what package-lock.json specifies and refuses to
    // silently edit it - the right choice for a reproducible launcher.
    const child = spawn(npmCommand(), ['ci', '--no-audit', '--no-fund'], {
      cwd: ROOT,
      shell: IS_WIN,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch { /* ignore */ }
    }, INSTALL_TIMEOUT_MS);

    const relay = (streamName) => (chunk) => {
      const text = chunk.toString();
      process[streamName === 'err' ? 'stderr' : 'stdout'].write(text);
      logStream.write(text);
    };
    child.stdout.on('data', relay('out'));
    child.stderr.on('data', relay('err'));

    child.on('error', (err) => {
      clearTimeout(timer);
      logStream.end();
      resolve({ ok: false, code: -1, error: err.message });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      logStream.end();
      resolve({ ok: code === 0 && !timedOut, code, timedOut });
    });
  });
}

/* ------------------------------------------------------------------ *
 * Runtime verification
 * ------------------------------------------------------------------ */

/**
 * Make sure the Electron runtime binary exists, downloading it if not.
 *
 * Electron 43 removed its postinstall script (npm v12 blocks those by default),
 * so the ~200 MB runtime is fetched on first use instead. We trigger that here,
 * with visible progress, rather than letting it happen invisibly at launch.
 */
function ensureElectronBinary() {
  const bin = electronBinaryPath();
  if (fs.existsSync(bin)) {
    return Promise.resolve({ ok: true, detail: path.relative(ROOT, bin), downloaded: false });
  }

  const installer = path.join(NODE_MODULES, 'electron', 'install.js');
  if (!fs.existsSync(installer)) {
    return Promise.resolve({
      ok: false,
      title: 'The Electron package is missing or damaged.',
      reasons: ['node_modules/electron/install.js was not found.'],
      fixes: ['Run RESET_VISIONANCE.cmd, then RUN_VISIONANCE.cmd again']
    });
  }

  step('Downloading the Electron runtime (~200 MB, first run only)');
  info('Progress is shown below and saved to the install log.');
  say();

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [installer], {
      cwd: path.join(NODE_MODULES, 'electron'),
      stdio: ['ignore', 'inherit', 'pipe'],
      windowsHide: true
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch { /* ignore */ }
    }, INSTALL_TIMEOUT_MS);

    const finish = (okState, extra = {}) => {
      clearTimeout(timer);
      resolve(okState
        ? { ok: true, detail: path.relative(ROOT, bin), downloaded: true }
        : { ok: false, ...extra });
    };

    child.on('error', (err) => finish(false, {
      title: 'Could not start the Electron download.',
      reasons: [err.message],
      fixes: ['Run RESET_VISIONANCE.cmd, then try again']
    }));

    child.on('close', (code) => {
      if (timedOut) {
        return finish(false, {
          title: 'The Electron download timed out.',
          reasons: [`It ran for more than ${INSTALL_TIMEOUT_MS / 60000} minutes.`],
          fixes: ['Check your internet connection', 'Run RUN_VISIONANCE.cmd again - it resumes from cache']
        });
      }
      if (code === 0 && fs.existsSync(bin)) return finish(true);

      const proxyHint = /proxy|ENOTFOUND|ETIMEDOUT|certificate|EAI_AGAIN/i.test(stderr);
      return finish(false, {
        title: 'The Electron runtime could not be downloaded.',
        reasons: stderr.split('\n').filter(Boolean).slice(-6),
        fixes: proxyHint
          ? [
            'You appear to be behind a proxy or firewall.',
            'Set HTTPS_PROXY, or set ELECTRON_MIRROR to an internal mirror, then retry.'
          ]
          : [
            'Check your internet connection and try again',
            'If your network blocks GitHub, set ELECTRON_MIRROR to a mirror you can reach'
          ]
      });
    });
  });
}

/** Optional: only the Export tab needs ffmpeg, so this never blocks startup. */
function verifyFfmpeg() {
  const dir = path.join(NODE_MODULES, 'ffmpeg-static');
  if (!fs.existsSync(dir)) return { ok: false, reason: 'ffmpeg-static is not installed' };
  const candidates = ['ffmpeg.exe', 'ffmpeg'].map((f) => path.join(dir, f));
  if (candidates.some((f) => fs.existsSync(f))) return { ok: true };
  return {
    ok: false,
    reason: 'ffmpeg-static downloaded no binary (its install script may be blocked)'
  };
}

/* ------------------------------------------------------------------ *
 * Launch
 * ------------------------------------------------------------------ */

function startApp() {
  ensureDirs();
  const logStream = fs.createWriteStream(LOG_FILE, { flags: 'w' });
  logStream.write(`# Visionance started ${new Date().toISOString()}\n`);

  const child = spawn(electronBinaryPath(), ['.'], {
    cwd: ROOT,
    windowsHide: false,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const capture = [];
  const relay = (chunk) => {
    const text = chunk.toString();
    process.stdout.write(text);
    logStream.write(text);
    capture.push(text);
    if (capture.length > 400) capture.shift();
  };
  child.stdout.on('data', relay);
  child.stderr.on('data', relay);

  return { child, logStream, capture };
}

/**
 * Bounded readiness wait. Resolves as soon as the process has survived the
 * grace period, or rejects the moment it exits early. Both paths are capped by
 * STARTUP_TIMEOUT_MS, so this can never spin forever.
 */
function waitForReady(child) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(graceTimer);
      clearTimeout(hardTimer);
      resolve(result);
    };

    const graceTimer = setTimeout(() => finish({ ready: true }), READY_GRACE_MS);
    const hardTimer = setTimeout(
      () => finish({ ready: false, reason: 'timeout' }),
      STARTUP_TIMEOUT_MS
    );

    child.once('exit', (code, signal) =>
      finish({ ready: false, reason: 'exited', code, signal })
    );
    child.once('error', (err) =>
      finish({ ready: false, reason: 'spawn-error', error: err })
    );
  });
}

/** Turn an early Electron exit into something a human can act on. */
function diagnoseEarlyExit(result, capture) {
  const text = capture.join('');
  if (result.reason === 'spawn-error') {
    return {
      title: 'The Electron runtime could not be started.',
      reasons: [result.error && result.error.message].filter(Boolean),
      fixes: ['Run RESET_VISIONANCE.cmd, then RUN_VISIONANCE.cmd again']
    };
  }
  if (/failed to install correctly|dist[\\/]electron/i.test(text)) {
    return {
      title: 'The Electron runtime is present but unusable.',
      reasons: ['The download may have been interrupted or partially written.'],
      fixes: ['Run RESET_VISIONANCE.cmd to reinstall dependencies']
    };
  }
  if (/WebGL2|GPU process|GL_|SwiftShader/i.test(text)) {
    return {
      title: 'The app started but could not initialise graphics.',
      reasons: [
        'Visionance needs WebGL2 for its enhancement pipeline.',
        'This is usually an out-of-date graphics driver.'
      ],
      fixes: [
        'Update your graphics driver, then try again',
        `Check ${path.relative(ROOT, LOG_FILE)} for the exact GPU error`
      ]
    };
  }
  const tail = tailLog(LOG_FILE, 10);
  return {
    title: `Visionance exited immediately (exit code ${result.code ?? 'unknown'}).`,
    reasons: tail.length ? ['Last lines of the log:', ...tail.map((l) => '  ' + l)] : [],
    fixes: [
      `Read the full log: ${path.relative(ROOT, LOG_FILE)}`,
      'If it mentions missing files, run RESET_VISIONANCE.cmd'
    ]
  };
}

/* ------------------------------------------------------------------ *
 * Commands
 * ------------------------------------------------------------------ */

async function cmdRun({ doctorOnly = false } = {}) {
  banner();

  const existing = checkExistingInstance();
  if (existing.running) {
    say(`${yellow('Visionance is already running')} (process ${existing.pid}).`);
    say();
    say('  If you cannot see the window, it may be minimised or on another desktop.');
    say('  To force it closed, run STOP_VISIONANCE.cmd');
    say();
    process.exitCode = 0;
    return;
  }

  step('Checking prerequisites');
  for (const check of [checkNode(), checkNpm(), checkElectronEngine()]) {
    if (!check.ok) return fail(check.title, check.reasons, check.fixes);
    if (check.detail) ok(check.detail);
  }
  info('No Docker or database required - Visionance is a single desktop app.');

  step('Checking dependencies');
  const state = dependencyState();
  const explain = {
    ok: 'Dependencies are up to date',
    missing: 'Dependencies are not installed yet',
    stale: 'package-lock.json changed since the last install'
  };
  info(explain[state]);

  if (state !== 'ok') {
    if (doctorOnly) {
      warn('Would run: npm ci');
    } else {
      step('Installing dependencies with npm ci (exactly what the lockfile pins)');
      const result = await runInstall();
      if (!result.ok) {
        if (result.timedOut) {
          return fail('Dependency installation timed out.', [
            `npm ci ran for more than ${INSTALL_TIMEOUT_MS / 60000} minutes.`
          ], [
            'Check your internet connection',
            'Run RUN_VISIONANCE.cmd again - npm resumes from its cache'
          ]);
        }
        return fail('Dependency installation failed.',
          ['Last lines of npm output:', ...tailLog(INSTALL_LOG, 10).map((l) => '  ' + l)],
          [
            `Read the full log: ${path.relative(ROOT, INSTALL_LOG)}`,
            'If it mentions a lockfile mismatch, run: npm install',
            'If it mentions network or proxy errors, check your connection'
          ]
        );
      }
      ok('Dependencies installed');
    }
  }

  step('Verifying the runtime');
  if (doctorOnly) {
    if (fs.existsSync(electronBinaryPath())) ok('Electron runtime present');
    else warn('Electron runtime not downloaded yet (it is fetched on first launch)');
  } else {
    const electronCheck = await ensureElectronBinary();
    if (!electronCheck.ok) {
      return fail(electronCheck.title, electronCheck.reasons, electronCheck.fixes);
    }
    ok(electronCheck.downloaded
      ? 'Electron runtime downloaded'
      : `Electron runtime present (${electronCheck.detail})`);
  }

  const ffmpeg = verifyFfmpeg();
  if (ffmpeg.ok) ok('ffmpeg available (Export enabled)');
  else warn(`Export will be unavailable: ${ffmpeg.reason}`);
  info('yt-dlp is optional and can be installed from the app\'s Settings.');

  if (doctorOnly) {
    say();
    ok('All checks passed. Nothing was changed.');
    say();
    return;
  }

  step('Starting Visionance');
  const { child, logStream, capture } = startApp();
  acquireLock(child.pid);

  const cleanup = () => { releaseLock(); try { logStream.end(); } catch { /* ignore */ } };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { try { child.kill(); } catch { /* ignore */ } cleanup(); process.exit(0); });

  const result = await waitForReady(child);

  if (!result.ready && result.reason !== 'timeout') {
    cleanup();
    const d = diagnoseEarlyExit(result, capture);
    return fail(d.title, d.reasons, d.fixes);
  }

  say();
  ok(bold('Visionance is running - the app window should now be open.'));
  info('This window streams the app log. Closing the app also closes this window.');
  info('To stop it from elsewhere, run STOP_VISIONANCE.cmd');
  say();

  // Stay attached so the console keeps showing the app's log.
  await new Promise((resolve) => child.once('exit', resolve));
  cleanup();
  say();
  say(dim('Visionance closed.'));
}

function cmdStop() {
  banner();
  const lock = readLock();
  if (!lock || !isAlive(lock.pid)) {
    say('Visionance does not appear to be running.');
    releaseLock();
    say();
    return;
  }

  step(`Stopping Visionance (process ${lock.pid})`);
  if (IS_WIN) {
    spawnSync('taskkill', ['/pid', String(lock.pid), '/T', '/F'], { windowsHide: true });
  } else {
    try { process.kill(lock.pid, 'SIGTERM'); } catch { /* already gone */ }
    const deadline = Date.now() + 5000;
    while (isAlive(lock.pid) && Date.now() < deadline) {
      spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},200)']);
    }
    if (isAlive(lock.pid)) {
      try { process.kill(lock.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }

  releaseLock();
  ok('Stopped.');
  say();
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}

function rmrf(target) {
  try {
    if (!fs.existsSync(target)) return false;
    fs.rmSync(target, { recursive: true, force: true });
    return true;
  } catch (err) {
    warn(`Could not remove ${target}: ${err.message}`);
    return false;
  }
}

function userDataDir() {
  if (IS_WIN) return path.join(process.env.APPDATA || '', 'Visionance');
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Visionance');
  }
  return path.join(os.homedir(), '.config', 'Visionance');
}

async function cmdReset() {
  banner();
  const running = checkExistingInstance();
  if (running.running) {
    say(yellow('Visionance is running. Close it (or run STOP_VISIONANCE.cmd) first.'));
    say();
    process.exitCode = 1;
    return;
  }

  const targets = [
    { p: NODE_MODULES, label: 'node_modules (installed dependencies)' },
    { p: path.join(ROOT, 'dist'), label: 'dist (build output)' },
    { p: LOG_DIR, label: 'logs' },
    { p: STATE_DIR, label: '.visionance (launcher state)' }
  ].filter((t) => fs.existsSync(t.p));

  if (!targets.length) {
    say('Nothing to reset - the project is already clean.');
    say();
    return;
  }

  say('This will delete the following, then you can re-run RUN_VISIONANCE.cmd:');
  say();
  targets.forEach((t) => say(`    - ${t.label}`));
  say();
  say(dim('  Your source code and Git history are NOT touched.'));
  const settings = userDataDir();
  if (fs.existsSync(settings)) {
    say(dim(`  Your saved settings and presets are NOT touched either.`));
    say(dim(`  (they live in ${settings})`));
  }
  say();

  const answer = await ask(`Type ${bold('RESET')} to confirm, or press Enter to cancel: `);
  if (answer !== 'RESET') {
    say();
    say('Cancelled. Nothing was deleted.');
    say();
    return;
  }

  say();
  for (const t of targets) {
    if (rmrf(t.p)) ok(`Removed ${t.label}`);
  }
  say();
  ok('Reset complete. Run RUN_VISIONANCE.cmd to reinstall and start.');
  say();
}

/* ------------------------------------------------------------------ *
 * Entry
 * ------------------------------------------------------------------ */

async function main() {
  const args = process.argv.slice(2);
  try {
    if (args.includes('--stop')) return cmdStop();
    if (args.includes('--reset')) return await cmdReset();
    if (args.includes('--doctor')) return await cmdRun({ doctorOnly: true });
    return await cmdRun();
  } catch (err) {
    fail('The launcher hit an unexpected problem.', [String(err && err.message)], [
      'Run RESET_VISIONANCE.cmd and try again',
      'If it keeps happening, check the logs folder'
    ]);
  }
}

main();
