'use strict';

/**
 * ffmpeg export pipeline.
 *
 * Renders a permanent enhanced copy of a source using a filter chain that
 * mirrors the real-time shader settings as closely as ffmpeg allows, so what
 * the user previews in the player is what lands on disk.
 *
 * One job runs at a time; further jobs queue. Progress is read from
 * `-progress pipe:1`, which is machine-readable and far more reliable than
 * scraping stderr.
 */

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');

const HW_ENCODERS = [
  { id: 'h264_nvenc', label: 'NVIDIA NVENC (H.264)', codec: 'h264', vendor: 'nvidia' },
  { id: 'hevc_nvenc', label: 'NVIDIA NVENC (HEVC)', codec: 'hevc', vendor: 'nvidia' },
  { id: 'h264_qsv', label: 'Intel Quick Sync (H.264)', codec: 'h264', vendor: 'intel' },
  { id: 'hevc_qsv', label: 'Intel Quick Sync (HEVC)', codec: 'hevc', vendor: 'intel' },
  { id: 'h264_amf', label: 'AMD AMF (H.264)', codec: 'h264', vendor: 'amd' },
  { id: 'hevc_amf', label: 'AMD AMF (HEVC)', codec: 'hevc', vendor: 'amd' },
  { id: 'h264_videotoolbox', label: 'Apple VideoToolbox (H.264)', codec: 'h264', vendor: 'apple' },
  { id: 'hevc_videotoolbox', label: 'Apple VideoToolbox (HEVC)', codec: 'hevc', vendor: 'apple' }
];

function ffprobeInfo(ffprobeBin, input) {
  return new Promise((resolve, reject) => {
    if (!ffprobeBin) return reject(new Error('ffprobe not found'));
    execFile(
      ffprobeBin,
      [
        '-v', 'error',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        input
      ],
      { timeout: 30000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) return reject(err);
        try {
          const json = JSON.parse(stdout);
          const v = (json.streams || []).find((s) => s.codec_type === 'video') || {};
          const a = (json.streams || []).find((s) => s.codec_type === 'audio') || null;
          const fmt = json.format || {};
          const fpsParts = String(v.avg_frame_rate || v.r_frame_rate || '0/1').split('/');
          const fps = Number(fpsParts[1]) ? Number(fpsParts[0]) / Number(fpsParts[1]) : 0;
          resolve({
            width: v.width || 0,
            height: v.height || 0,
            fps: Number.isFinite(fps) ? Math.round(fps * 1000) / 1000 : 0,
            vcodec: v.codec_name || null,
            acodec: a ? a.codec_name : null,
            hasAudio: !!a,
            duration: Number(fmt.duration || v.duration || 0) || 0,
            bitrate: Number(fmt.bit_rate || 0) || 0,
            size: Number(fmt.size || 0) || 0,
            pixFmt: v.pix_fmt || null
          });
        } catch (e) {
          reject(e);
        }
      }
    );
  });
}

function detectEncoders(ffmpegBin) {
  return new Promise((resolve) => {
    if (!ffmpegBin) return resolve([]);
    execFile(
      ffmpegBin,
      ['-hide_banner', '-encoders'],
      { timeout: 20000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err && !stdout) return resolve([]);
        const text = String(stdout);
        resolve(HW_ENCODERS.filter((e) => new RegExp(`\\s${e.id}\\s`).test(text)));
      }
    );
  });
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || 0));

/**
 * Translate the renderer's enhancement parameters into an ffmpeg -vf chain.
 * Values arrive on the same 0..1-ish scales the shader pipeline uses.
 */
function buildFilterChain(params, srcInfo) {
  const p = params || {};
  const filters = [];

  // 1. Clean up compression artefacts before scaling, never after.
  const deblock = clamp(p.deblock, 0, 1);
  if (deblock > 0.02) {
    // alpha/beta thresholds: gentle at low strength, aggressive at high.
    const alpha = (0.05 + deblock * 0.15).toFixed(3);
    const beta = (0.05 + deblock * 0.1).toFixed(3);
    filters.push(`deblock=filter=weak:block=8:alpha=${alpha}:beta=${beta}`);
  }

  const denoise = clamp(p.denoise, 0, 1);
  if (denoise > 0.02) {
    const ls = (denoise * 4).toFixed(2);   // luma spatial
    const cs = (denoise * 3).toFixed(2);   // chroma spatial
    const lt = (denoise * 6).toFixed(2);   // luma temporal
    const ct = (denoise * 4.5).toFixed(2); // chroma temporal
    filters.push(`hqdn3d=${ls}:${cs}:${lt}:${ct}`);
  }

  // 2. Scale. Lanczos is the closest CPU analogue to the edge-aware GPU upscale.
  const target = resolveTargetSize(p, srcInfo);
  if (target && (target.w !== srcInfo.width || target.h !== srcInfo.height)) {
    filters.push(`scale=${target.w}:${target.h}:flags=lanczos+accurate_rnd:param0=3`);
  }

  // 3. Sharpen after scaling, matching the shader's contrast-adaptive pass.
  const sharpen = clamp(p.sharpen, 0, 1);
  if (sharpen > 0.02) {
    const amount = (sharpen * 1.4).toFixed(3);
    filters.push(`unsharp=luma_msize_x=5:luma_msize_y=5:luma_amount=${amount}:chroma_msize_x=5:chroma_msize_y=5:chroma_amount=${(sharpen * 0.5).toFixed(3)}`);
  }

  // 4. Colour grading.
  const contrast = 1 + clamp(p.contrast, -1, 1) * 0.5;
  const saturation = 1 + clamp(p.saturation, -1, 1) * 0.8;
  const brightness = clamp(p.brightness, -1, 1) * 0.2;
  const gamma = 1 / Math.max(0.4, 1 + clamp(p.gamma, -1, 1) * 0.5);
  if (
    Math.abs(contrast - 1) > 0.01 ||
    Math.abs(saturation - 1) > 0.01 ||
    Math.abs(brightness) > 0.005 ||
    Math.abs(gamma - 1) > 0.01
  ) {
    filters.push(
      `eq=contrast=${contrast.toFixed(3)}:saturation=${saturation.toFixed(3)}:brightness=${brightness.toFixed(3)}:gamma=${gamma.toFixed(3)}`
    );
  }

  // 5. Kill the banding that scaling + grading tends to expose.
  const deband = clamp(p.deband, 0, 1);
  if (deband > 0.02) {
    const thr = (0.004 + deband * 0.03).toFixed(4);
    filters.push(`deband=1thr=${thr}:2thr=${thr}:3thr=${thr}:4thr=${thr}:range=16:blur=1`);
  }

  const grain = clamp(p.grain, 0, 1);
  if (grain > 0.02) {
    filters.push(`noise=alls=${Math.round(grain * 12)}:allf=t+u`);
  }

  // Force a widely compatible pixel format last.
  filters.push('format=yuv420p');
  return filters.join(',');
}

const RES_MAP = {
  '720p': 1280,
  '1080p': 1920,
  '1440p': 2560,
  '2160p': 3840,
  '4320p': 7680
};

function even(n) {
  const v = Math.round(n);
  return v % 2 === 0 ? v : v + 1;
}

function resolveTargetSize(p, srcInfo) {
  const sw = srcInfo.width || 1920;
  const sh = srcInfo.height || 1080;
  if (!sw || !sh) return null;

  if (p.targetResolution && RES_MAP[p.targetResolution]) {
    const targetW = RES_MAP[p.targetResolution];
    return { w: even(targetW), h: even((targetW * sh) / sw) };
  }
  const factor = clamp(p.scaleFactor, 1, 4) || 1;
  if (factor === 1) return null;
  return { w: even(sw * factor), h: even(sh * factor) };
}

function buildEncoderArgs(opts) {
  const enc = opts.encoder || 'libx264';
  const quality = clamp(opts.quality, 0, 100) || 70;
  const args = ['-c:v', enc];

  if (enc.startsWith('lib')) {
    // CRF 14 (best) .. 30 (smallest) mapped from a 0..100 quality slider.
    const crf = Math.round(30 - (quality / 100) * 16);
    args.push('-crf', String(crf), '-preset', opts.preset || 'medium');
    if (enc === 'libx265') args.push('-tag:v', 'hvc1');
  } else if (enc.includes('nvenc')) {
    const cq = Math.round(34 - (quality / 100) * 16);
    args.push('-rc', 'vbr', '-cq', String(cq), '-preset', 'p5', '-b:v', '0');
  } else if (enc.includes('qsv')) {
    args.push('-global_quality', String(Math.round(34 - (quality / 100) * 16)), '-preset', 'medium');
  } else if (enc.includes('amf')) {
    args.push('-quality', 'quality', '-rc', 'cqp', '-qp_i', String(Math.round(32 - (quality / 100) * 14)));
  } else if (enc.includes('videotoolbox')) {
    args.push('-q:v', String(Math.round(30 + (quality / 100) * 40)));
  }
  return args;
}

class ExportManager extends EventEmitter {
  constructor() {
    super();
    this.jobs = new Map(); // id -> job
    this.queue = [];
    this.active = null;
    this.seq = 0;
  }

  list() {
    return [...this.jobs.values()].map((j) => this._public(j));
  }

  _public(job) {
    return {
      id: job.id,
      input: job.input,
      output: job.output,
      status: job.status,
      progress: job.progress,
      fps: job.fps,
      speed: job.speed,
      eta: job.eta,
      error: job.error,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      title: job.title,
      duration: job.duration
    };
  }

  _emit(job) {
    this.emit('update', this._public(job));
  }

  /**
   * @param {object} cfg { ffmpegBin, ffprobeBin, input, output, params, encoder,
   *                       quality, preserveAudio, headers, title }
   */
  async enqueue(cfg) {
    const info = await ffprobeInfo(cfg.ffprobeBin, cfg.input).catch(() => ({
      width: 1920, height: 1080, duration: 0, hasAudio: true, fps: 0
    }));

    const id = `job_${Date.now()}_${++this.seq}`;
    const job = {
      id,
      input: cfg.input,
      output: cfg.output,
      title: cfg.title || path.basename(cfg.output),
      cfg,
      info,
      duration: info.duration || 0,
      status: 'queued',
      progress: 0,
      fps: 0,
      speed: 0,
      eta: null,
      error: null,
      startedAt: null,
      finishedAt: null,
      proc: null
    };
    this.jobs.set(id, job);
    this.queue.push(id);
    this._emit(job);
    this._pump();
    return this._public(job);
  }

  _pump() {
    if (this.active || this.queue.length === 0) return;
    const id = this.queue.shift();
    const job = this.jobs.get(id);
    if (!job || job.status === 'cancelled') return this._pump();
    this.active = id;
    this._run(job);
  }

  _run(job) {
    const { cfg, info } = job;
    const vf = buildFilterChain(cfg.params, info);

    // -nostdin matters: without it ffmpeg keeps the inherited stdin pipe open
    // and can sit unresponsive instead of shutting down when asked to stop.
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];

    if (cfg.headers && Object.keys(cfg.headers).length) {
      const headerLines = Object.entries(cfg.headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n');
      args.push('-headers', headerLines + '\r\n');
    }
    if (cfg.startTime) args.push('-ss', String(cfg.startTime));

    args.push('-i', cfg.input);
    if (cfg.audioInput) args.push('-i', cfg.audioInput);
    if (cfg.endTime) args.push('-to', String(cfg.endTime));

    args.push('-vf', vf);
    args.push(...buildEncoderArgs(cfg));

    if (cfg.preserveAudio === false) {
      args.push('-an');
    } else if (cfg.audioInput) {
      args.push('-map', '0:v:0', '-map', '1:a:0', '-c:a', 'aac', '-b:a', '256k');
    } else if (info.hasAudio) {
      args.push('-c:a', 'aac', '-b:a', '256k');
    }

    args.push('-movflags', '+faststart');
    args.push('-progress', 'pipe:1', '-nostats');
    args.push(job.output);

    try {
      fs.mkdirSync(path.dirname(job.output), { recursive: true });
    } catch { /* directory may already exist */ }

    job.status = 'running';
    job.startedAt = Date.now();
    job.command = `ffmpeg ${args.join(' ')}`;
    this._emit(job);

    const proc = spawn(cfg.ffmpegBin, args, { windowsHide: true });
    job.proc = proc;

    let stdoutBuf = '';
    let stderrTail = '';

    proc.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop();
      for (const line of lines) this._consumeProgress(job, line.trim());
    });

    proc.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-4000);
    });

    proc.on('error', (err) => {
      job.status = 'failed';
      job.error = err.code === 'ENOENT' ? 'ffmpeg executable not found.' : err.message;
      job.finishedAt = Date.now();
      job.proc = null;
      this._emit(job);
      this.active = null;
      this._pump();
    });

    proc.on('close', (code, signal) => {
      if (job.killTimer) {
        clearTimeout(job.killTimer);
        job.killTimer = null;
      }
      job.proc = null;
      job.finishedAt = Date.now();
      if (job.status === 'cancelled') {
        try { fs.existsSync(job.output) && fs.unlinkSync(job.output); } catch { /* best effort */ }
      } else if (code === 0) {
        job.status = 'done';
        job.progress = 1;
        try { job.outputSize = fs.statSync(job.output).size; } catch { /* ignore */ }
      } else {
        job.status = 'failed';
        job.error = stderrTail.split('\n').filter(Boolean).slice(-3).join(' ') ||
          `ffmpeg exited with code ${code}${signal ? ` (${signal})` : ''}`;
      }
      this._emit(job);
      this.active = null;
      this._pump();
    });
  }

  _consumeProgress(job, line) {
    const eq = line.indexOf('=');
    if (eq < 0) return;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);

    if (key === 'out_time_us' || key === 'out_time_ms') {
      const seconds = Number(value) / (key === 'out_time_us' ? 1e6 : 1e3);
      if (job.duration > 0 && Number.isFinite(seconds)) {
        job.progress = Math.min(0.999, seconds / job.duration);
        if (job.speed > 0) {
          job.eta = Math.max(0, (job.duration - seconds) / job.speed);
        }
      }
    } else if (key === 'fps') {
      job.fps = Number(value) || 0;
    } else if (key === 'speed') {
      job.speed = parseFloat(value) || 0;
    } else if (key === 'progress' && value === 'end') {
      job.progress = 1;
    }
    if (key === 'progress') this._emit(job);
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.status === 'queued') {
      this.queue = this.queue.filter((q) => q !== id);
      job.status = 'cancelled';
      this._emit(job);
      return true;
    }
    if (job.status === 'running' && job.proc) {
      job.status = 'cancelled';
      this._killProcess(job);
      this._emit(job);
      return true;
    }
    return false;
  }

  /**
   * ffmpeg treats SIGTERM as "finish what you're doing", which on a heavy
   * filter chain can mean several more seconds of work. Ask nicely, then
   * escalate, so Cancel always feels immediate.
   */
  _killProcess(job) {
    const proc = job.proc;
    if (!proc) return;
    try {
      if (process.platform === 'win32') {
        // Windows has no signals; take the whole process tree down.
        spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true });
        return;
      }
      proc.kill('SIGTERM');
    } catch { /* already gone */ }

    job.killTimer = setTimeout(() => {
      if (job.proc) {
        try { job.proc.kill('SIGKILL'); } catch { /* already gone */ }
      }
    }, 1500);
  }

  clearFinished() {
    for (const [id, job] of this.jobs) {
      if (['done', 'failed', 'cancelled'].includes(job.status)) this.jobs.delete(id);
    }
    return this.list();
  }

  killAll() {
    for (const job of this.jobs.values()) {
      if (job.proc) {
        job.status = 'cancelled';
        this._killProcess(job);
        try { job.proc.kill('SIGKILL'); } catch { /* ignore */ }
      }
    }
  }
}

module.exports = {
  ExportManager,
  ffprobeInfo,
  detectEncoders,
  buildFilterChain,
  resolveTargetSize,
  HW_ENCODERS
};
