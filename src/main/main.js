'use strict';

/**
 * Visionance - main process.
 *
 * Responsibilities:
 *   - create the (context-isolated) window
 *   - serve renderer assets and media over a privileged `vs://` scheme so that
 *     video frames can be read into WebGL without tainting the canvas
 *   - expose a narrow, validated IPC surface to the renderer
 */

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  ipcMain,
  shell,
  net,
  protocol,
  powerSaveBlocker,
  nativeTheme
} = require('electron');

const { Store } = require('./store');
const binaries = require('./binaries');
const ytdlp = require('./ytdlp');
const {
  ExportManager,
  ffprobeInfo,
  detectEncoders
} = require('./exporter');

const IS_DEV = process.argv.includes('--dev') || !app.isPackaged;
const RENDERER_DIR = path.join(__dirname, '..', 'renderer');

// GPU switches: media playback plus shader work benefits from every bit of
// hardware acceleration we can legally ask for.
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'vs',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  }
]);

/** @type {BrowserWindow|null} */
let win = null;
let store = null;
let exporter = null;
let sleepBlockerId = null;

/** Header sets captured from yt-dlp, keyed by a short token. */
const headerVault = new Map();
let headerSeq = 0;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2'
};

const VIDEO_EXTS = ['mp4', 'mkv', 'webm', 'mov', 'avi', 'wmv', 'flv', 'm4v', 'ts', 'mpg', 'mpeg', 'm2ts', 'ogv', '3gp'];

/** Only forward things that are plausibly playable, not any stray argument. */
function isPlayableFile(p) {
  if (!p || p.startsWith('-')) return false;
  const ext = path.extname(p).slice(1).toLowerCase();
  if (!VIDEO_EXTS.includes(ext)) return false;
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Custom protocol
 * ------------------------------------------------------------------ */

function registerProtocol() {
  protocol.handle('vs', async (request) => {
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return new Response('Bad request', { status: 400 });
    }

    if (url.hostname !== 'app') return new Response('Not found', { status: 404 });

    // Media is served from the same origin as the page on purpose: a
    // cross-origin <video> would taint the WebGL canvas and make the whole
    // enhancement pipeline illegal to read back.
    if (url.pathname === '/__media') {
      const kind = url.searchParams.get('src');

      if (kind === 'local') {
        const filePath = url.searchParams.get('p');
        if (!filePath || !fs.existsSync(filePath)) {
          return new Response('Not found', { status: 404 });
        }
        const headers = new Headers();
        const range = request.headers.get('range');
        if (range) headers.set('range', range);
        return net.fetch(pathToFileURL(filePath).toString(), {
          headers,
          bypassCustomProtocolHandlers: true
        });
      }

      if (kind === 'remote') {
        const target = url.searchParams.get('u');
        if (!target || !/^https?:\/\//i.test(target)) {
          return new Response('Bad target', { status: 400 });
        }
        const headers = new Headers();
        const token = url.searchParams.get('h');
        const stored = token ? headerVault.get(token) : null;
        if (stored) {
          for (const [k, v] of Object.entries(stored)) {
            if (/^(host|content-length|connection)$/i.test(k)) continue;
            headers.set(k, String(v));
          }
        }
        const range = request.headers.get('range');
        if (range) headers.set('range', range);
        try {
          return await net.fetch(target, { headers, bypassCustomProtocolHandlers: true });
        } catch (err) {
          return new Response(`Upstream error: ${err.message}`, { status: 502 });
        }
      }

      return new Response('Bad request', { status: 400 });
    }

    // vs://app/<relative renderer asset>
    {
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
      const target = path.normalize(path.join(RENDERER_DIR, rel));
      if (!target.startsWith(RENDERER_DIR)) {
        return new Response('Forbidden', { status: 403 });
      }
      if (!fs.existsSync(target)) return new Response('Not found', { status: 404 });
      const body = await fs.promises.readFile(target);
      return new Response(body, {
        status: 200,
        headers: { 'content-type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream' }
      });
    }
  });
}

/* ------------------------------------------------------------------ *
 * Window
 * ------------------------------------------------------------------ */

function createWindow() {
  const saved = store.get('window');
  win = new BrowserWindow({
    width: saved.width || 1360,
    height: saved.height || 860,
    x: Number.isInteger(saved.x) ? saved.x : undefined,
    y: Number.isInteger(saved.y) ? saved.y : undefined,
    minWidth: 940,
    minHeight: 620,
    backgroundColor: '#07070c',
    show: false,
    autoHideMenuBar: true,
    title: 'Visionance',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webgl: true,
      backgroundThrottling: false,
      spellcheck: false
    }
  });

  if (saved.maximized) win.maximize();

  win.once('ready-to-show', () => {
    win.show();
    if (IS_DEV) win.webContents.openDevTools({ mode: 'detach' });
  });

  const persistBounds = () => {
    if (!win || win.isDestroyed()) return;
    const maximized = win.isMaximized();
    const b = maximized ? store.get('window') : win.getBounds();
    store.set('window', {
      width: b.width, height: b.height, x: b.x, y: b.y, maximized
    });
  };
  win.on('resize', debounce(persistBounds, 400));
  win.on('move', debounce(persistBounds, 400));
  win.on('close', persistBounds);
  win.on('closed', () => { win = null; });

  // Never let the renderer navigate itself somewhere else; open real links
  // in the user's browser instead.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('vs://app/')) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  win.loadURL('vs://app/index.html');
  buildMenu();
}

function buildMenu() {
  const send = (channel, payload) => () => win && win.webContents.send(channel, payload);
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'Open Video…', accelerator: 'CmdOrCtrl+O', click: send('menu', 'open-file') },
        { label: 'Open URL…', accelerator: 'CmdOrCtrl+L', click: send('menu', 'open-url') },
        { type: 'separator' },
        { label: 'Export Enhanced Copy…', accelerator: 'CmdOrCtrl+E', click: send('menu', 'export') },
        { type: 'separator' },
        { role: process.platform === 'darwin' ? 'close' : 'quit' }
      ]
    },
    {
      label: 'Playback',
      submenu: [
        { label: 'Play / Pause', accelerator: 'Space', click: send('menu', 'toggle-play') },
        { label: 'Toggle Enhancement', accelerator: 'CmdOrCtrl+B', click: send('menu', 'toggle-enhance') },
        { label: 'Compare (Split View)', accelerator: 'CmdOrCtrl+D', click: send('menu', 'toggle-compare') },
        { label: 'Fullscreen', accelerator: 'F11', click: send('menu', 'fullscreen') }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Statistics Overlay', accelerator: 'CmdOrCtrl+I', click: send('menu', 'toggle-stats') },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Documentation',
          click: () => shell.openExternal('https://github.com/yt-dlp/yt-dlp#readme')
        },
        {
          label: 'Open Settings Folder',
          click: () => shell.openPath(app.getPath('userData'))
        },
        {
          label: 'About Visionance',
          click: () => {
            dialog.showMessageBox(win, {
              type: 'info',
              title: 'About Visionance',
              message: `Visionance ${app.getVersion()}`,
              detail:
                'Real-time GPU video enhancement.\n\n' +
                `Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · Node ${process.versions.node}`
            });
          }
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/* ------------------------------------------------------------------ *
 * IPC
 * ------------------------------------------------------------------ */

function binPaths() {
  const overrides = store.get('settings').binaries || {};
  return {
    ffmpeg: binaries.resolve('ffmpeg', { override: overrides.ffmpeg }),
    ffprobe: binaries.resolve('ffprobe', { override: overrides.ffprobe }),
    ytdlp: binaries.resolve('yt-dlp', { override: overrides.ytdlp })
  };
}

function stashHeaders(headers) {
  if (!headers || !Object.keys(headers).length) return null;
  const token = `h${++headerSeq}`;
  headerVault.set(token, headers);
  if (headerVault.size > 40) headerVault.delete(headerVault.keys().next().value);
  return token;
}

function localMediaUrl(filePath) {
  return `vs://app/__media?src=local&p=${encodeURIComponent(filePath)}`;
}

function remoteMediaUrl(url, token) {
  return `vs://app/__media?src=remote&u=${encodeURIComponent(url)}${token ? `&h=${token}` : ''}`;
}

function ok(data) { return { ok: true, ...data }; }
function fail(message, code) { return { ok: false, error: message, code: code || null }; }

function registerIpc() {
  ipcMain.handle('app:info', async () => {
    const bins = binPaths();
    const [ffmpegVer, ytdlpVer] = await Promise.all([
      binaries.probeVersion(bins.ffmpeg, ['-version']),
      binaries.probeVersion(bins.ytdlp, ['--version'])
    ]);
    return ok({
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      versions: {
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node
      },
      binaries: {
        ffmpeg: { path: bins.ffmpeg, version: ffmpegVer },
        ffprobe: { path: bins.ffprobe },
        ytdlp: { path: bins.ytdlp, version: ytdlpVer }
      },
      paths: { userData: app.getPath('userData'), videos: app.getPath('videos') },
      dark: nativeTheme.shouldUseDarkColors
    });
  });

  ipcMain.handle('app:encoders', async () => {
    const encoders = await detectEncoders(binPaths().ffmpeg);
    return ok({ encoders });
  });

  /* ---------- dialogs ---------- */

  ipcMain.handle('dialog:openVideo', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Open video',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Video files', extensions: VIDEO_EXTS },
        { name: 'All files', extensions: ['*'] }
      ]
    });
    if (res.canceled || !res.filePaths.length) return fail('cancelled', 'CANCELLED');
    return ok({ files: res.filePaths });
  });

  ipcMain.handle('dialog:saveVideo', async (_e, defaultName) => {
    const dir = store.get('settings').exportDir || app.getPath('videos');
    const res = await dialog.showSaveDialog(win, {
      title: 'Export enhanced video',
      defaultPath: path.join(dir, defaultName || 'visionance-export.mp4'),
      filters: [{ name: 'MP4 video', extensions: ['mp4'] }, { name: 'Matroska', extensions: ['mkv'] }]
    });
    if (res.canceled || !res.filePath) return fail('cancelled', 'CANCELLED');
    store.patchSettings({ exportDir: path.dirname(res.filePath) });
    return ok({ file: res.filePath });
  });

  ipcMain.handle('dialog:pickBinary', async (_e, which) => {
    const res = await dialog.showOpenDialog(win, {
      title: `Locate ${which}`,
      properties: ['openFile']
    });
    if (res.canceled || !res.filePaths.length) return fail('cancelled', 'CANCELLED');
    const p = res.filePaths[0];
    const settings = store.get('settings');
    settings.binaries = { ...settings.binaries, [which]: p };
    store.patchSettings({ binaries: settings.binaries });
    return ok({ path: p });
  });

  /* ---------- media ---------- */

  ipcMain.handle('media:open', async (_e, filePath) => {
    if (!filePath || !fs.existsSync(filePath)) return fail('File no longer exists.', 'ENOENT');
    const bins = binPaths();
    let info = null;
    try {
      info = await ffprobeInfo(bins.ffprobe, filePath);
    } catch {
      info = null; // ffprobe is a nicety here, not a requirement
    }
    const stat = fs.statSync(filePath);
    return ok({
      kind: 'local',
      source: filePath,
      title: path.basename(filePath),
      playbackUrl: localMediaUrl(filePath),
      audioUrl: null,
      info,
      size: stat.size
    });
  });

  ipcMain.handle('media:resolveUrl', async (_e, pageUrl, opts = {}) => {
    const bins = binPaths();
    if (!bins.ytdlp) {
      return fail('yt-dlp is not installed. Install it from Settings to play online videos.', 'YT_DLP_MISSING');
    }
    const settings = store.get('settings');
    try {
      const result = await ytdlp.resolveStream(bins.ytdlp, pageUrl, {
        maxHeight: opts.maxHeight || null,
        cookiesFromBrowser: settings.cookiesFromBrowser || null
      });
      const token = stashHeaders(result.headers);
      return ok({
        kind: 'stream',
        source: result.webpageUrl,
        title: result.title,
        uploader: result.uploader,
        duration: result.duration,
        thumbnail: result.thumbnail,
        isLive: result.isLive,
        extractor: result.extractor,
        muxed: result.muxed,
        available: result.available,
        video: result.video,
        audio: result.audio,
        headerToken: token,
        playbackUrl: remoteMediaUrl(result.video.url, token),
        audioUrl: result.audio ? remoteMediaUrl(result.audio.url, token) : null,
        info: {
          width: result.video.width,
          height: result.video.height,
          fps: result.video.fps,
          vcodec: result.video.vcodec,
          duration: result.duration || 0
        }
      });
    } catch (err) {
      return fail(ytdlp.explainError(err), 'RESOLVE_FAILED');
    }
  });

  ipcMain.handle('ytdlp:install', async (event) => {
    try {
      const p = await binaries.installYtDlp((fraction) => {
        event.sender.send('ytdlp:progress', fraction);
      });
      const version = await binaries.probeVersion(p, ['--version']);
      return ok({ path: p, version });
    } catch (err) {
      return fail(`Could not install yt-dlp: ${err.message}`, 'INSTALL_FAILED');
    }
  });

  /* ---------- settings / presets / recents ---------- */

  ipcMain.handle('settings:get', () => ok({ settings: store.get('settings') }));
  ipcMain.handle('settings:patch', (_e, patch) => ok({ settings: store.patchSettings(patch) }));

  ipcMain.handle('presets:get', () => ok({ presets: store.get('presets') }));
  ipcMain.handle('presets:save', (_e, preset) => {
    if (!preset || !preset.id) return fail('Invalid preset');
    const presets = store.get('presets');
    presets[preset.id] = preset;
    store.set('presets', presets);
    return ok({ presets });
  });
  ipcMain.handle('presets:delete', (_e, id) => {
    const presets = store.get('presets');
    delete presets[id];
    store.set('presets', presets);
    return ok({ presets });
  });

  ipcMain.handle('recents:get', () => ok({ recents: store.get('recents') }));
  ipcMain.handle('recents:add', (_e, entry) => ok({ recents: store.addRecent(entry) }));
  ipcMain.handle('recents:remove', (_e, source) => ok({ recents: store.removeRecent(source) }));
  ipcMain.handle('recents:clear', () => ok({ recents: store.clearRecents() }));

  ipcMain.handle('resume:get', (_e, key) => ok({ seconds: store.getResume(key) }));
  ipcMain.handle('resume:set', (_e, key, seconds) => {
    store.setResume(key, seconds);
    return ok({});
  });

  /* ---------- export ---------- */

  ipcMain.handle('export:start', async (_e, cfg) => {
    const bins = binPaths();
    if (!bins.ffmpeg) return fail('ffmpeg was not found. Set its location in Settings.', 'FFMPEG_MISSING');
    if (!cfg || !cfg.input || !cfg.output) return fail('Missing input or output path.');
    try {
      const job = await exporter.enqueue({
        ...cfg,
        ffmpegBin: bins.ffmpeg,
        ffprobeBin: bins.ffprobe,
        headers: cfg.headerToken ? headerVault.get(cfg.headerToken) : null
      });
      return ok({ job });
    } catch (err) {
      return fail(err.message, 'ENQUEUE_FAILED');
    }
  });

  ipcMain.handle('export:cancel', (_e, id) => ok({ cancelled: exporter.cancel(id) }));
  ipcMain.handle('export:list', () => ok({ jobs: exporter.list() }));
  ipcMain.handle('export:clear', () => ok({ jobs: exporter.clearFinished() }));

  /* ---------- shell / window ---------- */

  ipcMain.handle('shell:reveal', (_e, p) => {
    if (p && fs.existsSync(p)) shell.showItemInFolder(p);
    return ok({});
  });
  ipcMain.handle('shell:open', async (_e, p) => {
    if (p && fs.existsSync(p)) await shell.openPath(p);
    return ok({});
  });
  ipcMain.handle('shell:external', async (_e, url) => {
    if (/^https?:\/\//i.test(url)) await shell.openExternal(url);
    return ok({});
  });

  ipcMain.handle('window:fullscreen', (_e, value) => {
    if (!win) return ok({ fullscreen: false });
    const next = typeof value === 'boolean' ? value : !win.isFullScreen();
    win.setFullScreen(next);
    return ok({ fullscreen: next });
  });

  ipcMain.handle('power:keepAwake', (_e, enable) => {
    if (enable && sleepBlockerId === null) {
      sleepBlockerId = powerSaveBlocker.start('prevent-display-sleep');
    } else if (!enable && sleepBlockerId !== null) {
      try { powerSaveBlocker.stop(sleepBlockerId); } catch { /* already stopped */ }
      sleepBlockerId = null;
    }
    return ok({ active: sleepBlockerId !== null });
  });

  ipcMain.handle('media:localUrl', (_e, filePath) => ok({ url: localMediaUrl(filePath) }));
}

/* ------------------------------------------------------------------ *
 * Bootstrap
 * ------------------------------------------------------------------ */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
      const file = argv.slice(1).find(isPlayableFile);
      if (file) win.webContents.send('open-external-file', file);
    }
  });

  app.whenReady().then(() => {
    store = new Store();
    exporter = new ExportManager();
    exporter.on('update', (job) => {
      if (win && !win.isDestroyed()) win.webContents.send('export:update', job);
    });

    registerProtocol();
    registerIpc();
    createWindow();

    // Deliver a file passed on the command line once the UI is ready.
    const cliFile = process.argv.slice(1).find(isPlayableFile);
    if (cliFile && win) {
      win.webContents.once('did-finish-load', () => {
        win.webContents.send('open-external-file', cliFile);
      });
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    if (win) win.webContents.send('open-external-file', filePath);
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    if (exporter) exporter.killAll();
    if (sleepBlockerId !== null) {
      try { powerSaveBlocker.stop(sleepBlockerId); } catch { /* ignore */ }
    }
  });
}
