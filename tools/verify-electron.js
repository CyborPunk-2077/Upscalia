/**
 * Headless verification harness that runs inside Electron itself, so the
 * shaders are compiled by the exact Chromium/ANGLE stack the app ships with.
 *
 *   npx electron tools/verify-electron.js          (needs a display / xvfb-run)
 *
 * Exit code 0 = every program linked, every preset rendered without a GL error
 * and produced output measurably different from the untouched source.
 */

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

app.commandLine.appendSwitch('use-gl', 'angle');
app.commandLine.appendSwitch('use-angle', 'swiftshader');
app.commandLine.appendSwitch('enable-unsafe-swiftshader');
app.commandLine.appendSwitch('ignore-gpu-blocklist');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const PAGE_TEST = `
(() => {
  const report = { ok: true, gl: null, precision: null, programs: [], presets: [], errors: [] };

  const canvas = document.createElement('canvas');
  canvas.width = 1280; canvas.height = 720;
  canvas.style.width = '1280px'; canvas.style.height = '720px';
  document.body.appendChild(canvas);

  let engine;
  try {
    engine = new window.VSEngine.Engine(canvas);
  } catch (e) {
    return { ok: false, errors: ['Engine construction failed: ' + e.message], programs: [], presets: [] };
  }

  const gl = engine.gl;
  report.gl = gl.getParameter(gl.VERSION);
  report.precision = engine.precision;

  for (const [name, pass] of Object.entries(engine.passes)) {
    const linked = gl.getProgramParameter(pass.program, gl.LINK_STATUS);
    report.programs.push({ name, linked, uniforms: pass.uniforms.size });
    if (!linked) { report.ok = false; report.errors.push(name + ': link failed'); }
  }

  // Synthetic frame with the four things the pipeline claims to fix:
  // banding, aliasing, fine detail and noise.
  const src = document.createElement('canvas');
  src.width = 640; src.height = 360;
  const ctx = src.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 640, 0);
  grad.addColorStop(0, '#101820');
  grad.addColorStop(1, '#c8d8ff');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 640, 360);
  ctx.fillStyle = '#ff3050';
  ctx.beginPath();
  ctx.moveTo(60, 300); ctx.lineTo(220, 40); ctx.lineTo(380, 300); ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = '16px monospace';
  ctx.fillText('VISIONANCE 0123456789', 380, 200);
  const img = ctx.getImageData(0, 0, 640, 360);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 24;
    img.data[i] += n; img.data[i+1] += n; img.data[i+2] += n;
  }
  ctx.putImageData(img, 0, 0);

  src.videoWidth = 640;
  src.videoHeight = 360;
  src.readyState = 4;
  src.paused = true;
  engine.setVideo(src);
  engine.adaptive = false;

  const sample = () => {
    const px = new Uint8Array(4 * 64 * 16);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(600, 400, 64, 16, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px;
  };

  // Lock the render geometry so every preset is measured against the same
  // resample, isolating what the enhancement passes actually contribute.
  engine.setRenderScaleCap(2);
  const NEUTRAL = {
    enabled: true, denoise: 0, deblock: 0, edge: 0, line: 0, sharpen: 0,
    haloGuard: 0, deband: 0, localContrast: 0, contrast: 0, brightness: 0,
    saturation: 0, vibrance: 0, gamma: 0, temperature: 0, tint: 0,
    blackLevel: 0, highlightRolloff: 0, bloom: 0, grain: 0, vignette: 0
  };
  engine.setParams(NEUTRAL);
  try { engine.draw(); } catch (e) {
    report.ok = false; report.errors.push('neutral draw threw: ' + e.message);
    return report;
  }
  gl.getError();
  const baseline = sample();
  report.baselineOutput = canvas.width + 'x' + canvas.height;

  for (const preset of window.VSPresets.BUILTIN) {
    const entry = { id: preset.id, glError: null, delta: null, output: null };
    engine.setParams({ ...NEUTRAL, ...preset.params });
    try { engine.draw(); } catch (e) {
      entry.glError = 'threw: ' + e.message;
      report.ok = false;
      report.presets.push(entry);
      continue;
    }
    const err = gl.getError();
    if (err !== gl.NO_ERROR) { entry.glError = '0x' + err.toString(16); report.ok = false; }

    const px = sample();
    let sum = 0;
    for (let i = 0; i < px.length; i++) sum += Math.abs(px[i] - baseline[i]);
    entry.delta = Math.round((sum / px.length) * 100) / 100;
    entry.output = canvas.width + 'x' + canvas.height;

    if (preset.id !== 'off' && entry.delta < 0.2) {
      report.errors.push(preset.id + ': output is indistinguishable from the neutral resample');
      report.ok = false;
    }
    report.presets.push(entry);
  }

  engine.setCompare(1, 0.5);
  engine.draw();
  if (gl.getError() !== gl.NO_ERROR) {
    report.ok = false;
    report.errors.push('compare mode produced a GL error');
  }

  engine.setCompare(0, 0.5);
  engine.setParams({ ...window.VSPresets.BUILTIN[2].params });
  engine.setRenderScaleCap(4);
  engine.draw();
  if (gl.getError() !== gl.NO_ERROR) {
    report.ok = false;
    report.errors.push('4x render scale produced a GL error');
  }
  report.maxScaleOutput = canvas.width + 'x' + canvas.height;

  // Auto scale must land somewhere sane for the display, not at 1x.
  engine.setRenderScaleCap('auto');
  engine.draw();
  if (gl.getError() !== gl.NO_ERROR) {
    report.ok = false;
    report.errors.push('auto render scale produced a GL error');
  }
  report.autoScaleOutput = canvas.width + 'x' + canvas.height;

  return report;
})()
`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    webPreferences: { offscreen: false, webgl: true, contextIsolation: true }
  });

  // Electron 37 changed this event's signature from
  // (event, level:number, message) to (event:{level:string, message}).
  win.webContents.on('console-message', (...args) => {
    const [first, second, third] = args;
    const obj = first && typeof first === 'object' && 'message' in first;
    const level = obj ? first.level : second;
    const message = String((obj ? first.message : third) ?? '');
    const isError = typeof level === 'number' ? level >= 2 : level === 'error';
    if (isError) console.error('  [page]', message);
  });

  await win.loadURL('data:text/html,<html><body></body></html>');
  await win.webContents.executeJavaScript(read('src/renderer/js/shaders.js'));
  await win.webContents.executeJavaScript(read('src/renderer/js/engine.js'));
  await win.webContents.executeJavaScript(read('src/renderer/js/presets.js'));

  let report;
  try {
    report = await win.webContents.executeJavaScript(PAGE_TEST);
  } catch (err) {
    console.error('Harness failed:', err.message);
    app.exit(1);
    return;
  }

  console.log('WebGL:     ', report.gl);
  console.log('Precision: ', report.precision);
  console.log('\nPrograms');
  for (const p of report.programs) {
    console.log(`  ${p.linked ? 'ok  ' : 'FAIL'} ${String(p.name).padEnd(10)} ${p.uniforms} uniforms`);
  }
  console.log(`\nPresets (delta = mean 8-bit difference vs. neutral resample at ${report.baselineOutput})`);
  for (const p of report.presets) {
    const flag = p.glError ? `GL ${p.glError}` : 'ok';
    console.log(`  ${flag.padEnd(9)} ${String(p.id).padEnd(12)} out=${String(p.output).padEnd(11)} delta=${p.delta}`);
  }
  if (report.maxScaleOutput) console.log(`\n4x render scale output:   ${report.maxScaleOutput}`);
  if (report.autoScaleOutput) console.log(`auto render scale output: ${report.autoScaleOutput}`);
  if (report.errors && report.errors.length) {
    console.log('\nErrors');
    report.errors.forEach((e) => console.log('  - ' + e));
  }
  console.log(`\n${report.ok ? 'PASS' : 'FAIL'}`);
  app.exit(report.ok ? 0 : 1);
});
