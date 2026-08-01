/**
 * End-to-end boot smoke test.
 *
 * Boots the real application (main process, custom protocol, preload bridge,
 * renderer) and asserts that the pieces actually came up: the IPC bridge is
 * exposed, the renderer scripts loaded, the WebGL engine initialised, and the
 * UI rendered. Writes a screenshot so the result can be eyeballed.
 *
 *   xvfb-run -a npx electron tools/smoke.js
 */

const path = require('path');
const fs = require('fs');

process.argv.push('--dev-smoke');
require(path.join(__dirname, '..', 'src', 'main', 'main.js'));

const { app, BrowserWindow } = require('electron');

const CHECK = `
(async () => {
  const out = { errors: [] };
  out.bridge = typeof window.visionance === 'object' && window.visionance !== null;
  out.bridgeMethods = out.bridge ? Object.keys(window.visionance).sort() : [];
  out.shaders = typeof window.VSShaders === 'object';
  out.enginePresent = typeof window.VSEngine === 'object';
  out.presets = window.VSPresets ? window.VSPresets.BUILTIN.length : 0;

  const canvas = document.getElementById('glCanvas');
  out.canvas = !!canvas;
  out.glContext = !!(canvas && canvas.getContext('webgl2'));

  out.presetCards = document.querySelectorAll('.preset-card').length;
  out.sliders = document.querySelectorAll('.ctrl input[type=range]').length;
  out.tabs = document.querySelectorAll('.tab').length;
  out.emptyStateVisible = !document.getElementById('stageEmpty').hidden;

  // Exercise the IPC surface the same way the UI does on boot.
  try {
    const info = await window.visionance.app.info();
    out.appInfo = info.ok;
    out.appVersion = info.version;
    out.ffmpeg = info.binaries.ffmpeg.path ? 'found' : 'missing';
    out.ytdlp = info.binaries.ytdlp.path ? 'found' : 'missing';
  } catch (e) { out.errors.push('app.info failed: ' + e.message); }

  try {
    const s = await window.visionance.settings.get();
    out.settings = s.ok;
  } catch (e) { out.errors.push('settings.get failed: ' + e.message); }

  try {
    const r = await window.visionance.presets.get();
    out.presetStore = r.ok;
  } catch (e) { out.errors.push('presets.get failed: ' + e.message); }

  // Switch tabs to make sure every panel renders without throwing.
  for (const tab of document.querySelectorAll('.tab')) tab.click();
  out.tabsClicked = true;

  // Toggle the interactive affordances.
  document.getElementById('enhanceToggle').click();
  document.getElementById('enhanceToggle').click();
  document.getElementById('compareBtn').click();
  out.compareOn = !document.getElementById('splitHandle').hidden;
  document.getElementById('compareBtn').click();
  document.getElementById('statsBtn').click();
  out.statsOn = !document.getElementById('statsOverlay').hidden;
  document.getElementById('statsBtn').click();

  document.querySelector('.tab[data-tab="presets"]').click();
  return out;
})()
`;

const pageErrors = [];

/**
 * Electron 37 replaced the `console-message` signature.
 *   old: (event, level:number, message:string, line, sourceId)
 *   new: (event:{level:'info'|'warning'|'error'|'debug', message, ...})
 * Accept both so this harness runs against either.
 */
function normaliseConsoleMessage(args) {
  const [first, second, third] = args;
  if (first && typeof first === 'object' && 'message' in first) {
    return { level: first.level, message: String(first.message ?? '') };
  }
  return { level: second, message: String(third ?? '') };
}

const isError = (level) =>
  typeof level === 'number' ? level >= 2 : level === 'error';

app.whenReady().then(() => {
  setTimeout(async () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) {
      console.error('FAIL: no window was created');
      app.exit(1);
      return;
    }

    win.webContents.on('console-message', (...args) => {
      const { level, message } = normaliseConsoleMessage(args);
      if (isError(level) && !/Security Warning/.test(message)) pageErrors.push(message);
    });
    win.webContents.on('preload-error', (_e, p, err) => {
      pageErrors.push(`preload ${p}: ${err.message}`);
    });

    let result;
    try {
      result = await win.webContents.executeJavaScript(CHECK, true);
    } catch (err) {
      console.error('FAIL: renderer check threw:', err.message);
      app.exit(1);
      return;
    }

    // Optional playback phase: VISIONANCE_TEST_VIDEO=/path/to/clip.mp4
    // Proves the vs:// media route, decoding, texture upload and the render
    // loop all work together, not just that the UI drew itself.
    let playback = null;
    const testVideo = process.env.VISIONANCE_TEST_VIDEO;
    if (testVideo && fs.existsSync(testVideo)) {
      win.webContents.send('open-external-file', testVideo);
      await new Promise((r) => setTimeout(r, 4000));
      playback = await win.webContents.executeJavaScript(`
        (async () => {
          const v = document.getElementById('video');
          const c = document.getElementById('glCanvas');
          const stage = document.getElementById('stageInner').getBoundingClientRect();

          // Force an explicit 2x render scale so the upscale assertion does not
          // depend on how large the window happens to be in this environment.
          // Adaptive quality is switched off first: this harness runs on a
          // software rasteriser, which would legitimately throttle the scale.
          const adaptive = document.getElementById('adaptiveToggle');
          adaptive.checked = false;
          adaptive.dispatchEvent(new Event('change'));

          const sel = document.getElementById('scaleSelect');
          sel.value = '2';
          sel.dispatchEvent(new Event('change'));
          await new Promise(r => setTimeout(r, 800));
          const forced = { w: c.width, h: c.height };
          sel.value = 'auto';
          sel.dispatchEvent(new Event('change'));
          adaptive.checked = true;
          adaptive.dispatchEvent(new Event('change'));

          return {
            stageWidth: Math.round(stage.width),
            stageHeight: Math.round(stage.height),
            forcedWidth: forced.w,
            forcedHeight: forced.h,
            readyState: v.readyState,
            videoWidth: v.videoWidth,
            videoHeight: v.videoHeight,
            currentTime: v.currentTime,
            paused: v.paused,
            duration: v.duration,
            canvasWidth: c.width,
            canvasHeight: c.height,
            canvasVisible: !c.classList.contains('hidden'),
            resBadge: document.getElementById('resBadge').textContent,
            emptyHidden: document.getElementById('stageEmpty').hidden,
            loadingHidden: document.getElementById('stageLoading').hidden
          };
        })()
      `, true);
    }

    const shotPath = path.join(__dirname, '..', 'tools', 'smoke-screenshot.png');
    try {
      const image = await win.webContents.capturePage();
      fs.writeFileSync(shotPath, image.toPNG());
    } catch { /* screenshot is a nicety */ }

    const assertions = [
      ['preload bridge exposed', result.bridge],
      ['shader module loaded', result.shaders],
      ['engine module loaded', result.enginePresent],
      ['WebGL2 context created', result.glContext],
      ['built-in presets defined', result.presets >= 8],
      ['preset cards rendered', result.presetCards >= 8],
      ['adjust sliders rendered', result.sliders >= 15],
      ['tabs rendered', result.tabs === 4],
      ['empty state visible', result.emptyStateVisible],
      ['app.info over IPC', result.appInfo === true],
      ['settings over IPC', result.settings === true],
      ['presets over IPC', result.presetStore === true],
      ['compare toggles on', result.compareOn === true],
      ['stats overlay toggles on', result.statsOn === true],
      ['no renderer errors', pageErrors.length === 0 && result.errors.length === 0]
    ];

    if (playback) {
      assertions.push(
        ['test clip decoded', playback.readyState >= 2 && playback.videoWidth > 0],
        ['playback advanced', playback.currentTime > 0.1],
        ['loading overlay cleared', playback.loadingHidden === true],
        ['empty state dismissed', playback.emptyHidden === true],
        ['canvas revealed', playback.canvasVisible === true],
        ['engine rendered frames', playback.canvasWidth > 0 && playback.canvasHeight > 0],
        ['never renders below source resolution',
          playback.canvasWidth >= playback.videoWidth && playback.canvasHeight >= playback.videoHeight],
        ['2x render scale upscales',
          playback.forcedWidth >= playback.videoWidth * 1.9 &&
          playback.forcedHeight >= playback.videoHeight * 1.9],
        ['resolution badge populated', /→/.test(playback.resBadge)]
      );
    }

    console.log(`\nVisionance ${result.appVersion} boot smoke test`);
    console.log(`bridge namespaces : ${result.bridgeMethods.join(', ')}`);
    console.log(`ffmpeg            : ${result.ffmpeg}`);
    console.log(`yt-dlp            : ${result.ytdlp}`);
    console.log(`screenshot        : ${fs.existsSync(shotPath) ? shotPath : 'not captured'}`);
    if (playback) {
      console.log(`playback          : ${playback.videoWidth}x${playback.videoHeight} source -> ` +
        `${playback.canvasWidth}x${playback.canvasHeight} auto / ${playback.forcedWidth}x${playback.forcedHeight} at 2x, ` +
        `t=${playback.currentTime.toFixed(2)}s badge="${playback.resBadge}"`);
      console.log(`stage box         : ${playback.stageWidth}x${playback.stageHeight}`);
    }
    console.log('');

    let ok = true;
    for (const [label, pass] of assertions) {
      if (!pass) ok = false;
      console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${label}`);
    }
    if (pageErrors.length) {
      console.log('\nRenderer errors:');
      pageErrors.forEach((e) => console.log('  - ' + e));
    }
    if (result.errors.length) {
      console.log('\nCheck errors:');
      result.errors.forEach((e) => console.log('  - ' + e));
    }

    console.log(`\n${ok ? 'PASS' : 'FAIL'}`);
    app.exit(ok ? 0 : 1);
  }, 2500);
});
