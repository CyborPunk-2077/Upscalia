'use strict';

/**
 * yt-dlp integration.
 *
 * Visionance never downloads a full copy of an online video. It asks yt-dlp to
 * resolve the direct CDN URL(s) for a page, then hands those URLs to the
 * renderer's <video>/<audio> elements so playback is streamed and enhanced live.
 *
 * Two shapes can come back:
 *   muxed  -> one URL carrying both video and audio
 *   split  -> separate video-only and audio-only URLs, kept in sync by the player
 *
 * Split streams are what make >720p possible on sites that only offer low-res
 * muxed formats, so we prefer them when the quality gain is meaningful.
 */

const { execFile } = require('child_process');

const DEFAULT_TIMEOUT = 45000;

/** Codecs Chromium plays reliably inside Electron. */
const SAFE_VCODEC = /^(avc1|h264|vp0?9|vp8|av01)/i;
const SAFE_ACODEC = /^(mp4a|aac|opus|vorbis)/i;

function runYtDlp(bin, args, { timeout = DEFAULT_TIMEOUT } = {}) {
  return new Promise((resolve, reject) => {
    if (!bin) return reject(new Error('YT_DLP_MISSING'));
    execFile(
      bin,
      args,
      { timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const msg = String(stderr || err.message || '').trim();
          const e = new Error(msg || 'yt-dlp failed');
          e.stderr = msg;
          return reject(e);
        }
        resolve(String(stdout));
      }
    );
  });
}

function pickBest(formats, kind, maxHeight) {
  const list = formats.filter((f) => {
    if (!f.url) return false;
    if (f.protocol && /^(m3u8|http_dash_segments)/.test(f.protocol) && kind !== 'hls') return false;
    if (kind === 'video') {
      return f.vcodec && f.vcodec !== 'none' && (!f.acodec || f.acodec === 'none') &&
        SAFE_VCODEC.test(f.vcodec) && (!maxHeight || (f.height || 0) <= maxHeight);
    }
    if (kind === 'audio') {
      return f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none') &&
        SAFE_ACODEC.test(f.acodec);
    }
    // muxed
    return f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none' &&
      SAFE_VCODEC.test(f.vcodec) && SAFE_ACODEC.test(f.acodec) &&
      (!maxHeight || (f.height || 0) <= maxHeight);
  });

  const score = (f) => {
    if (kind === 'audio') return (f.abr || 0) * 1000 + (f.tbr || 0);
    // Prefer resolution, then fps, then bitrate. Slight bias toward h264 for
    // lower decode cost, which leaves more GPU headroom for the shader passes.
    const codecBonus = /^(avc1|h264)/i.test(f.vcodec || '') ? 1.05 : 1;
    return ((f.height || 0) * 10000 + (f.fps || 0) * 100 + (f.tbr || 0)) * codecBonus;
  };

  return list.sort((a, b) => score(b) - score(a))[0] || null;
}

function slimFormat(f) {
  if (!f) return null;
  return {
    url: f.url,
    formatId: f.format_id,
    ext: f.ext,
    height: f.height || null,
    width: f.width || null,
    fps: f.fps || null,
    vcodec: f.vcodec && f.vcodec !== 'none' ? f.vcodec : null,
    acodec: f.acodec && f.acodec !== 'none' ? f.acodec : null,
    tbr: f.tbr || null,
    protocol: f.protocol || null,
    filesize: f.filesize || f.filesize_approx || null
  };
}

/**
 * Resolve a page URL into playable stream URLs.
 * @param {string} bin        path to yt-dlp
 * @param {string} pageUrl    the URL the user pasted
 * @param {object} opts       { maxHeight, cookiesFromBrowser }
 */
async function resolveStream(bin, pageUrl, opts = {}) {
  const maxHeight = opts.maxHeight || null;
  const args = [
    '--no-warnings',
    '--no-playlist',
    '--no-check-certificate',
    '--dump-single-json'
  ];
  if (opts.cookiesFromBrowser) args.push('--cookies-from-browser', opts.cookiesFromBrowser);
  args.push(pageUrl);

  const raw = await runYtDlp(bin, args);
  const info = JSON.parse(raw);

  const formats = Array.isArray(info.formats) ? info.formats : [];
  const httpHeaders = info.http_headers || (formats[0] && formats[0].http_headers) || {};

  let muxed = pickBest(formats, 'muxed', maxHeight);
  const videoOnly = pickBest(formats, 'video', maxHeight);
  const audioOnly = pickBest(formats, 'audio');

  // Live streams / HLS-only sites: fall back to the manifest URL directly.
  if (!muxed && !videoOnly && info.url) {
    muxed = { url: info.url, vcodec: 'unknown', acodec: 'unknown', ext: info.ext };
  }

  const muxedHeight = (muxed && muxed.height) || 0;
  const splitHeight = (videoOnly && videoOnly.height) || 0;
  const useSplit = !!(videoOnly && audioOnly && splitHeight > muxedHeight);

  const chosen = useSplit
    ? { video: slimFormat(videoOnly), audio: slimFormat(audioOnly), muxed: false }
    : { video: slimFormat(muxed), audio: null, muxed: true };

  if (!chosen.video || !chosen.video.url) {
    throw new Error('No playable stream format was found for this URL.');
  }

  return {
    ok: true,
    title: info.title || info.fulltitle || pageUrl,
    uploader: info.uploader || info.channel || null,
    duration: info.duration || null,
    thumbnail: info.thumbnail || null,
    isLive: !!info.is_live,
    webpageUrl: info.webpage_url || pageUrl,
    extractor: info.extractor_key || info.extractor || null,
    headers: httpHeaders,
    ...chosen,
    // Compact list for the quality picker in the UI.
    available: formats
      .filter((f) => f.vcodec && f.vcodec !== 'none' && f.height)
      .map((f) => ({ height: f.height, fps: f.fps || null, ext: f.ext, formatId: f.format_id }))
      .filter((v, i, a) => a.findIndex((x) => x.height === v.height && x.fps === v.fps) === i)
      .sort((a, b) => b.height - a.height)
      .slice(0, 12)
  };
}

/** Human-readable explanation for the common yt-dlp failure modes. */
function explainError(err) {
  const msg = String((err && (err.stderr || err.message)) || '');
  if (msg.includes('YT_DLP_MISSING')) {
    return 'yt-dlp is not installed. Open Settings to install it automatically.';
  }
  if (/Sign in to confirm|age|consent|private video|members-only/i.test(msg)) {
    return 'This video requires an account. Enable "Use browser cookies" in Settings and try again.';
  }
  if (/Unsupported URL|Unable to extract|is not a valid URL/i.test(msg)) {
    return 'That link is not supported. Try a direct video page URL.';
  }
  if (/HTTP Error 4\d\d|Video unavailable|removed/i.test(msg)) {
    return 'The video is unavailable, region-locked, or has been removed.';
  }
  if (/timed out|ETIMEDOUT/i.test(msg)) {
    return 'Timed out while resolving the stream. Check your connection and retry.';
  }
  return msg.split('\n').slice(-1)[0] || 'Could not resolve this URL.';
}

module.exports = { resolveStream, explainError, runYtDlp };
