/**
 * Export pipeline verification.
 *
 * Generates a short synthetic clip, then runs a real ffmpeg render through the
 * ExportManager for every built-in preset, asserting that:
 *   - the generated filter chain is accepted by ffmpeg
 *   - progress events actually arrive and reach 100%
 *   - the output file exists, is non-trivial, and has the requested resolution
 *   - cancellation kills the process and removes the partial file
 *
 *   node tools/verify-export.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, execFile } = require('child_process');

// exporter.js is deliberately free of any electron import so it can be tested
// and reasoned about as a plain Node module.
const {
  ExportManager, ffprobeInfo, buildFilterChain, detectEncoders
} = require(require('path').join(__dirname, '..', 'src', 'main', 'exporter'));

function which(name) {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const d of dirs) {
    const p = path.join(d, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const FFMPEG = which('ffmpeg');
const FFPROBE = which('ffprobe');

if (!FFMPEG || !FFPROBE) {
  console.error('ffmpeg/ffprobe not on PATH; skipping export verification.');
  process.exit(0);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'visionance-test-'));
const SOURCE = path.join(TMP, 'source.mp4');

function makeSource() {
  execFileSync(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '34',
    '-c:a', 'aac', '-shortest', '-pix_fmt', 'yuv420p',
    SOURCE
  ]);
}

function probe(file) {
  return new Promise((resolve, reject) => {
    execFile(FFPROBE, [
      '-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file
    ], (err, stdout) => (err ? reject(err) : resolve(JSON.parse(stdout))));
  });
}

(async () => {
  console.log('Generating test source…');
  makeSource();
  const srcInfo = await ffprobeInfo(FFPROBE, SOURCE);
  console.log(`Source: ${srcInfo.width}x${srcInfo.height} @ ${srcInfo.fps}fps, ${srcInfo.duration.toFixed(2)}s, audio=${srcInfo.hasAudio}\n`);

  const encoders = await detectEncoders(FFMPEG);
  console.log(`Hardware encoders detected: ${encoders.length ? encoders.map((e) => e.id).join(', ') : 'none (CPU only)'}\n`);

  const { BUILTIN } = loadPresets();
  const manager = new ExportManager();

  const progressSeen = new Map();
  manager.on('update', (job) => {
    const arr = progressSeen.get(job.id) || [];
    arr.push(job.progress);
    progressSeen.set(job.id, arr);
  });

  let failures = 0;

  console.log('Preset renders (1080p target, libx264)');
  for (const preset of BUILTIN) {
    const output = path.join(TMP, `${preset.id}.mp4`);
    const chain = buildFilterChain({ ...preset.params, targetResolution: '1080p' }, srcInfo);

    const job = await manager.enqueue({
      ffmpegBin: FFMPEG,
      ffprobeBin: FFPROBE,
      input: SOURCE,
      output,
      title: preset.name,
      params: { ...preset.params, targetResolution: '1080p' },
      encoder: 'libx264',
      quality: 60,
      preserveAudio: true
    });

    const final = await waitForJob(manager, job.id);

    let detail = '';
    let ok = final.status === 'done' && fs.existsSync(output);
    if (ok) {
      const info = await probe(output);
      const v = info.streams.find((s) => s.codec_type === 'video');
      const a = info.streams.find((s) => s.codec_type === 'audio');
      const size = Number(info.format.size);
      detail = `${v.width}x${v.height} ${(size / 1024).toFixed(0)}KB audio=${a ? 'yes' : 'no'}`;
      if (v.width !== 1920 || v.height !== 1080) { ok = false; detail += ' WRONG SIZE'; }
      if (!a) { ok = false; detail += ' MISSING AUDIO'; }
      if (size < 4096) { ok = false; detail += ' TOO SMALL'; }
      const updates = progressSeen.get(job.id) || [];
      if (updates[updates.length - 1] !== 1) { ok = false; detail += ' NO FINAL PROGRESS'; }
    } else {
      detail = final.error || 'no output produced';
    }

    if (!ok) failures++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${preset.id.padEnd(12)} ${detail}`);
    if (!ok) console.log(`       filters: ${chain}`);
  }

  // Cancellation
  console.log('\nCancellation');
  const cancelOut = path.join(TMP, 'cancelled.mp4');
  const longJob = await manager.enqueue({
    ffmpegBin: FFMPEG,
    ffprobeBin: FFPROBE,
    input: SOURCE,
    output: cancelOut,
    title: 'cancel test',
    params: { ...BUILTIN[1].params, targetResolution: '2160p' },
    encoder: 'libx264',
    quality: 95,
    preserveAudio: true
  });
  await new Promise((r) => setTimeout(r, 700));
  const cancelled = manager.cancel(longJob.id);
  const finalCancel = await waitForJob(manager, longJob.id);
  const cleanedUp = !fs.existsSync(cancelOut);
  const cancelOk = cancelled && finalCancel.status === 'cancelled' && cleanedUp;
  if (!cancelOk) failures++;
  console.log(`  ${cancelOk ? 'ok  ' : 'FAIL'} cancel stops ffmpeg and removes the partial file`);

  // Audio can be dropped on request
  console.log('\nAudio handling');
  const silentOut = path.join(TMP, 'silent.mp4');
  const silentJob = await manager.enqueue({
    ffmpegBin: FFMPEG, ffprobeBin: FFPROBE, input: SOURCE, output: silentOut,
    title: 'no audio', params: BUILTIN[1].params, encoder: 'libx264',
    quality: 50, preserveAudio: false
  });
  const silentFinal = await waitForJob(manager, silentJob.id);
  let silentOk = silentFinal.status === 'done';
  if (silentOk) {
    const info = await probe(silentOut);
    silentOk = !info.streams.some((s) => s.codec_type === 'audio');
  }
  if (!silentOk) failures++;
  console.log(`  ${silentOk ? 'ok  ' : 'FAIL'} "keep audio" off produces a video-only file`);

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures} problem${failures === 1 ? '' : 's'})`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('Harness error:', err);
  process.exit(1);
});

/**
 * Resolve only once the job is terminal *and* finishedAt is set, i.e. the
 * ffmpeg process has actually exited. Cancelling emits a terminal status
 * immediately, before the process is reaped and the partial file deleted.
 */
function waitForJob(manager, id) {
  return new Promise((resolve) => {
    const done = (job) =>
      ['done', 'failed', 'cancelled'].includes(job.status) && job.finishedAt;
    const existing = manager.list().find((j) => j.id === id);
    if (existing && done(existing)) return resolve(existing);
    const check = (job) => {
      if (job.id !== id || !done(job)) return;
      manager.off('update', check);
      resolve(job);
    };
    manager.on('update', check);
  });
}

function loadPresets() {
  // presets.js targets the browser; evaluate it with a stub global.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'js', 'presets.js'), 'utf8');
  const sandbox = { window: {} };
  new Function('window', src)(sandbox.window);
  return sandbox.window.VSPresets;
}
