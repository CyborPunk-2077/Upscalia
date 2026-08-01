'use strict';

/**
 * Locates the external binaries Visionance depends on (ffmpeg, ffprobe, yt-dlp).
 *
 * Resolution order for each binary:
 *   1. Explicit user override saved in settings
 *   2. Binary shipped in <resources>/bin  (electron-builder extraResources)
 *   3. Binary downloaded by the app into <userData>/bin
 *   4. npm package (ffmpeg-static / ffprobe-static), with asar path fix-up
 *   5. Whatever is on the system PATH
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { app } = require('electron');
const { execFile } = require('child_process');

const IS_WIN = process.platform === 'win32';
const EXE = IS_WIN ? '.exe' : '';

/** Absolute path to the writable folder where we keep downloaded binaries. */
function userBinDir() {
  return path.join(app.getPath('userData'), 'bin');
}

/** Absolute path to binaries shipped alongside a packaged build. */
function resourceBinDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'bin')
    : path.join(app.getAppPath(), 'bin');
}

function isExecutableFile(p) {
  try {
    return !!p && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * ffmpeg-static resolves to a path inside app.asar when packaged, which is not
 * executable. electron-builder unpacks it to app.asar.unpacked, so rewrite.
 */
function unpackAsar(p) {
  if (!p) return p;
  return p.includes('app.asar') && !p.includes('app.asar.unpacked')
    ? p.replace('app.asar', 'app.asar.unpacked')
    : p;
}

function fromNodeModule(moduleName) {
  try {
    const mod = require(moduleName);
    const raw = typeof mod === 'string' ? mod : mod && mod.path;
    const fixed = unpackAsar(raw);
    return isExecutableFile(fixed) ? fixed : null;
  } catch {
    return null;
  }
}

/** Look for `name` on the system PATH without spawning a shell. */
function fromSystemPath(name) {
  const exts = IS_WIN ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext.toLowerCase());
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

const COMMON_UNIX_DIRS = [
  '/usr/local/bin',
  '/usr/bin',
  '/opt/homebrew/bin',
  '/snap/bin',
  path.join(os.homedir(), '.local', 'bin')
];

function fromCommonDirs(name) {
  if (IS_WIN) return null;
  for (const dir of COMMON_UNIX_DIRS) {
    const candidate = path.join(dir, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/**
 * @param {'ffmpeg'|'ffprobe'|'yt-dlp'} name
 * @param {{override?: string}} [opts]
 * @returns {string|null}
 */
function resolve(name, opts = {}) {
  const override = opts.override;
  if (isExecutableFile(override)) return override;

  const fileName = name + EXE;
  const shipped = path.join(resourceBinDir(), fileName);
  if (isExecutableFile(shipped)) return shipped;

  const downloaded = path.join(userBinDir(), fileName);
  if (isExecutableFile(downloaded)) return downloaded;

  if (name === 'ffmpeg') {
    const m = fromNodeModule('ffmpeg-static');
    if (m) return m;
  }
  if (name === 'ffprobe') {
    const m = fromNodeModule('ffprobe-static');
    if (m) return m;
  }

  return fromSystemPath(name) || fromCommonDirs(name);
}

/** Run `bin --version` (or the given args) and return trimmed stdout. */
function probeVersion(bin, args = ['--version']) {
  return new Promise((resolve) => {
    if (!bin) return resolve(null);
    execFile(bin, args, { timeout: 10000, windowsHide: true }, (err, stdout, stderr) => {
      if (err && !stdout && !stderr) return resolve(null);
      const out = String(stdout || stderr || '').split('\n')[0].trim();
      resolve(out || null);
    });
  });
}

const YTDLP_RELEASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/';

function ytDlpAssetName() {
  if (IS_WIN) return 'yt-dlp.exe';
  if (process.platform === 'darwin') return 'yt-dlp_macos';
  return 'yt-dlp';
}

function download(url, dest, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects'));
    https
      .get(url, { headers: { 'User-Agent': 'Visionance' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(download(res.headers.location, dest, onProgress, redirects + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`Download failed with HTTP ${res.statusCode}`));
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let received = 0;
        const tmp = dest + '.part';
        const file = fs.createWriteStream(tmp);
        res.on('data', (chunk) => {
          received += chunk.length;
          if (onProgress && total) onProgress(received / total);
        });
        res.pipe(file);
        file.on('finish', () => {
          file.close(() => {
            try {
              fs.renameSync(tmp, dest);
              if (!IS_WIN) fs.chmodSync(dest, 0o755);
              resolve(dest);
            } catch (e) {
              reject(e);
            }
          });
        });
        file.on('error', reject);
      })
      .on('error', reject);
  });
}

/**
 * Fetch the latest yt-dlp build into <userData>/bin.
 * @param {(fraction:number)=>void} [onProgress]
 */
async function installYtDlp(onProgress) {
  const dir = userBinDir();
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, 'yt-dlp' + EXE);
  await download(YTDLP_RELEASE + ytDlpAssetName(), dest, onProgress);
  return dest;
}

module.exports = {
  resolve,
  probeVersion,
  installYtDlp,
  userBinDir,
  resourceBinDir,
  isExecutableFile
};
