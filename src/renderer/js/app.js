/**
 * Visionance renderer application.
 *
 * Wires the DOM to the WebGL engine and the main-process API. Deliberately
 * framework-free: the whole UI is a few hundred lines of direct DOM work,
 * which keeps startup instant and the frame loop free of allocations.
 */

(function () {
  'use strict';

  const api = window.visionance;
  const { Engine } = window.VSEngine;
  const { BUILTIN, CONTROLS } = window.VSPresets;

  const $ = (id) => document.getElementById(id);

  /* ------------------------------------------------------------------ *
   * Icons
   *
   * Inline SVG rather than unicode glyphs: symbols like ⟲ and ⧉ render as
   * empty boxes on any machine without a font that covers them, which looks
   * broken on exactly the low-end hardware this app is aimed at.
   * ------------------------------------------------------------------ */

  const svg = (body, fill) =>
    `<svg viewBox="0 0 24 24" width="18" height="18" fill="${fill ? 'currentColor' : 'none'}" ` +
    `stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

  const ICONS = {
    play: svg('<path d="M7 4.5v15l12-7.5z"/>', true),
    pause: svg('<rect x="7" y="5" width="3.5" height="14" rx="1"/><rect x="13.5" y="5" width="3.5" height="14" rx="1"/>', true),
    back10: svg('<path d="M11 8H6.5V3.5"/><path d="M6.9 8.2A7.5 7.5 0 1 1 4.6 14"/><text x="12" y="15.6" font-size="7.5" stroke="none" fill="currentColor" text-anchor="middle" font-family="sans-serif">10</text>'),
    fwd10: svg('<path d="M13 8h4.5V3.5"/><path d="M17.1 8.2A7.5 7.5 0 1 0 19.4 14"/><text x="12" y="15.6" font-size="7.5" stroke="none" fill="currentColor" text-anchor="middle" font-family="sans-serif">10</text>'),
    volume: svg('<path d="M4 9.5h3.5L12 5.5v13L7.5 14.5H4z"/><path d="M16 9a4.5 4.5 0 0 1 0 6"/><path d="M18.5 6.5a8 8 0 0 1 0 11"/>'),
    mute: svg('<path d="M4 9.5h3.5L12 5.5v13L7.5 14.5H4z"/><path d="M16.5 10l4 4"/><path d="M20.5 10l-4 4"/>'),
    camera: svg('<rect x="3" y="7" width="18" height="13" rx="2.5"/><circle cx="12" cy="13.5" r="3.6"/><path d="M8.5 7l1.4-2.4h4.2L15.5 7"/>'),
    pip: svg('<rect x="2.5" y="4.5" width="19" height="15" rx="2.5"/><rect x="12" y="11.5" width="8" height="6.5" rx="1.5" fill="currentColor" stroke="none"/>'),
    fullscreen: svg('<path d="M3.5 9V4.5H8"/><path d="M16 4.5h4.5V9"/><path d="M20.5 15v4.5H16"/><path d="M8 19.5H3.5V15"/>'),
    exitFullscreen: svg('<path d="M8 3.5V8H3.5"/><path d="M20.5 8H16V3.5"/><path d="M16 20.5V16h4.5"/><path d="M3.5 16H8v4.5"/>'),
    stats: svg('<path d="M4 19.5V13"/><path d="M9.3 19.5V8"/><path d="M14.7 19.5v-6"/><path d="M20 19.5V4.5"/>'),
    gear: svg('<circle cx="12" cy="12" r="3.2"/><path d="M19.4 14.5a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.56V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.56-1.1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1-1.56V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.56 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
    folder: svg('<path d="M3.5 6.5A1.5 1.5 0 0 1 5 5h4l2 2.5h8a1.5 1.5 0 0 1 1.5 1.5v8.5A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z"/>'),
    file: svg('<path d="M6 3.5h7.5L19 9v11.5H6z"/><path d="M13.5 3.5V9H19"/>'),
    link: svg('<path d="M10 13.5a4 4 0 0 0 5.7 0l2.6-2.6a4 4 0 0 0-5.7-5.7l-1.5 1.5"/><path d="M14 10.5a4 4 0 0 0-5.7 0l-2.6 2.6a4 4 0 0 0 5.7 5.7l1.5-1.5"/>')
  };

  function applyIcons() {
    const map = {
      playBtn: ICONS.play,
      back10Btn: ICONS.back10,
      fwd10Btn: ICONS.fwd10,
      muteBtn: ICONS.volume,
      snapshotBtn: ICONS.camera,
      pipBtn: ICONS.pip,
      fullscreenBtn: ICONS.fullscreen,
      statsBtn: ICONS.stats,
      settingsBtn: ICONS.gear
    };
    for (const [id, icon] of Object.entries(map)) {
      if (el[id]) el[id].innerHTML = icon;
    }
    el.openFileBtn.innerHTML = `${ICONS.folder}<span>Open file</span>`;
  }

  /* ------------------------------------------------------------------ *
   * State
   * ------------------------------------------------------------------ */

  const state = {
    engine: null,
    media: null,          // descriptor of what is loaded
    params: null,
    presetId: 'balanced',
    userPresets: {},
    settings: null,
    info: null,
    compare: 0,           // 0 off, 1 split
    splitX: 0.5,
    splitDragging: false,
    scrubbing: false,
    dualStream: false,
    jobs: new Map(),
    resumeKey: null,
    lastSavedPosition: 0,
    idleTimer: null
  };

  const el = {};
  [
    'urlInput', 'goBtn', 'openFileBtn', 'statsBtn', 'settingsBtn',
    'stage', 'stageInner', 'glCanvas', 'video', 'audio', 'stageEmpty',
    'stageLoading', 'loadingText', 'statsOverlay', 'compareLabels', 'splitHandle',
    'toastStack', 'transport', 'scrub', 'scrubBuffered', 'scrubPlayed',
    'scrubKnob', 'scrubTooltip', 'playBtn', 'back10Btn', 'fwd10Btn', 'muteBtn',
    'volume', 'timeLabel', 'enhanceToggle', 'compareBtn', 'resBadge',
    'speedSelect', 'snapshotBtn', 'pipBtn', 'fullscreenBtn', 'panel',
    'presetGrid', 'scaleSelect', 'adaptiveToggle', 'presetName', 'savePresetBtn',
    'controlGroups', 'resetParamsBtn', 'exportRes', 'exportEncoder',
    'exportQuality', 'exportQualityVal', 'exportAudio', 'startExportBtn',
    'jobList', 'recentList', 'clearRecentsBtn', 'dropOverlay', 'settingsModal',
    'closeSettings', 'ytdlpStatus', 'installYtdlpBtn', 'locateYtdlpBtn',
    'maxHeight', 'cookieBrowser', 'ffmpegStatus', 'locateFfmpegBtn',
    'autoplayToggle', 'resumeToggle', 'targetFpsSelect', 'aboutText',
    'infoModal', 'closeInfo', 'emptyOpenBtn', 'emptyDemoBtn', 'brandSub'
  ].forEach((id) => { el[id] = $(id); });

  /* ------------------------------------------------------------------ *
   * Utilities
   * ------------------------------------------------------------------ */

  function toast(message, kind = 'info', ms = 4200) {
    const node = document.createElement('div');
    node.className = `toast ${kind}`;
    node.textContent = message;
    el.toastStack.appendChild(node);
    setTimeout(() => {
      node.classList.add('leaving');
      setTimeout(() => node.remove(), 220);
    }, ms);
  }

  function fmtTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    const s = Math.floor(seconds % 60);
    const m = Math.floor((seconds / 60) % 60);
    const h = Math.floor(seconds / 3600);
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  function fmtBytes(bytes) {
    if (!bytes) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = bytes;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function labelForHeight(h) {
    if (!h) return '—';
    if (h >= 4320) return '8K';
    if (h >= 2160) return '4K';
    if (h >= 1440) return '1440p';
    if (h >= 1080) return '1080p';
    if (h >= 720) return '720p';
    return `${h}p`;
  }

  const isUrl = (s) => /^(https?:\/\/|www\.)\S+$/i.test((s || '').trim());

  /* ------------------------------------------------------------------ *
   * Media control - handles both single-file and split video/audio
   * ------------------------------------------------------------------ */

  const media = {
    get v() { return el.video; },
    get a() { return el.audio; },

    async load(descriptor) {
      const v = el.video;
      const a = el.audio;

      state.dualStream = !!descriptor.audioUrl;
      v.pause();
      a.pause();
      a.removeAttribute('src');
      a.load();

      v.src = descriptor.playbackUrl;
      if (state.dualStream) {
        a.src = descriptor.audioUrl;
        v.muted = true;         // audio comes from the separate element
        a.muted = !!state.settings.muted;
        a.volume = state.settings.volume;
      } else {
        v.muted = !!state.settings.muted;
        v.volume = state.settings.volume;
      }
      v.playbackRate = Number(el.speedSelect.value) || 1;
      a.playbackRate = v.playbackRate;
      v.load();
    },

    play() {
      const p = el.video.play();
      if (p && p.catch) p.catch((err) => {
        if (err && err.name !== 'AbortError') toast(`Playback blocked: ${err.message}`, 'error');
      });
      if (state.dualStream) {
        el.audio.currentTime = el.video.currentTime;
        const ap = el.audio.play();
        if (ap && ap.catch) ap.catch(() => { /* resync on next tick */ });
      }
    },

    pause() {
      el.video.pause();
      if (state.dualStream) el.audio.pause();
    },

    toggle() {
      if (el.video.paused) this.play(); else this.pause();
    },

    seek(seconds) {
      const d = el.video.duration;
      const t = Math.max(0, Math.min(Number.isFinite(d) ? d - 0.05 : seconds, seconds));
      el.video.currentTime = t;
      if (state.dualStream) el.audio.currentTime = t;
    },

    setVolume(vol) {
      const target = state.dualStream ? el.audio : el.video;
      target.volume = vol;
      if (vol > 0) target.muted = false;
    },

    setMuted(muted) {
      const target = state.dualStream ? el.audio : el.video;
      target.muted = muted;
    },

    get muted() {
      return state.dualStream ? el.audio.muted : el.video.muted;
    },

    setRate(rate) {
      el.video.playbackRate = rate;
      el.audio.playbackRate = rate;
    },

    /** Keep the separate audio track locked to the video clock. */
    syncDrift() {
      if (!state.dualStream || el.video.paused) return;
      const drift = el.audio.currentTime - el.video.currentTime;
      if (Math.abs(drift) > 0.25) {
        el.audio.currentTime = el.video.currentTime;
      } else if (Math.abs(drift) > 0.06) {
        // Nudge the rate instead of jumping, which is inaudible.
        el.audio.playbackRate = el.video.playbackRate * (drift > 0 ? 0.98 : 1.02);
      } else if (el.audio.playbackRate !== el.video.playbackRate) {
        el.audio.playbackRate = el.video.playbackRate;
      }
    }
  };

  /* ------------------------------------------------------------------ *
   * Loading sources
   * ------------------------------------------------------------------ */

  function showLoading(text) {
    el.loadingText.textContent = text;
    el.stageLoading.hidden = false;
  }

  function hideLoading() {
    el.stageLoading.hidden = true;
  }

  async function openLocalFile(filePath) {
    showLoading('Reading file…');
    const res = await api.media.open(filePath);
    hideLoading();
    if (!res.ok) return toast(res.error, 'error');
    await startPlayback(res);
  }

  async function openUrl(rawUrl) {
    let url = (rawUrl || '').trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

    showLoading('Resolving stream…');
    const maxHeight = Number(el.maxHeight.value) || null;
    const res = await api.media.resolveUrl(url, { maxHeight });
    hideLoading();

    if (!res.ok) {
      if (res.code === 'YT_DLP_MISSING') {
        toast(res.error, 'warn', 7000);
        openSettings();
      } else {
        toast(res.error, 'error', 7000);
      }
      return;
    }
    await startPlayback(res);
  }

  async function startPlayback(descriptor) {
    state.media = descriptor;
    state.resumeKey = descriptor.source;

    el.stageEmpty.hidden = true;
    el.glCanvas.classList.remove('hidden');
    el.brandSub.textContent = descriptor.title || 'Real-time enhancement';
    document.title = `${descriptor.title || 'Visionance'} — Visionance`;

    await media.load(descriptor);

    api.recents.add({
      source: descriptor.source,
      kind: descriptor.kind,
      title: descriptor.title,
      duration: descriptor.info ? descriptor.info.duration : null
    }).then((r) => r.ok && renderRecents(r.recents));

    api.system.keepAwake(true);
    updateResBadge();
  }

  /* ------------------------------------------------------------------ *
   * Engine
   * ------------------------------------------------------------------ */

  function initEngine() {
    try {
      state.engine = new Engine(el.glCanvas);
    } catch (err) {
      toast(err.message, 'error', 12000);
      el.stageEmpty.querySelector('p').textContent =
        'This machine does not expose WebGL2, which Visionance needs for real-time enhancement. Updating your graphics driver usually fixes it.';
      return;
    }
    state.engine.onError = (err) => toast(err.message, 'error', 9000);
    state.engine.setVideo(el.video);
    state.engine.start();
  }

  function applyParams(params, presetId) {
    state.params = { ...params };
    if (presetId) state.presetId = presetId;
    if (state.engine) state.engine.setParams(state.params);
    syncControlValues();
    renderPresetGrid();
    updateEnhanceToggle();
  }

  function findPreset(id) {
    const builtin = BUILTIN.find((p) => p.id === id);
    if (builtin) return builtin;
    return state.userPresets[id] || null;
  }

  /* ------------------------------------------------------------------ *
   * UI - presets
   * ------------------------------------------------------------------ */

  function renderPresetGrid() {
    const all = [...BUILTIN, ...Object.values(state.userPresets)];
    el.presetGrid.innerHTML = '';
    for (const preset of all) {
      const card = document.createElement('button');
      card.className = 'preset-card' + (preset.id === state.presetId ? ' active' : '');
      card.title = preset.description || '';
      card.innerHTML =
        `<span class="pname"></span><span class="ptag"></span>`;
      card.querySelector('.pname').textContent = preset.name;
      card.querySelector('.ptag').textContent = preset.tag || 'Custom';

      if (state.userPresets[preset.id]) {
        const del = document.createElement('button');
        del.className = 'pdel';
        del.textContent = '✕';
        del.title = 'Delete preset';
        del.addEventListener('click', async (e) => {
          e.stopPropagation();
          const r = await api.presets.remove(preset.id);
          if (r.ok) {
            state.userPresets = r.presets;
            if (state.presetId === preset.id) applyParams(findPreset('balanced').params, 'balanced');
            else renderPresetGrid();
            toast('Preset deleted');
          }
        });
        card.appendChild(del);
      }

      card.addEventListener('click', () => applyParams(preset.params, preset.id));
      el.presetGrid.appendChild(card);
    }
  }

  /* ------------------------------------------------------------------ *
   * UI - adjust sliders
   * ------------------------------------------------------------------ */

  const sliderRefs = new Map();

  function buildControls() {
    el.controlGroups.innerHTML = '';
    for (const group of CONTROLS) {
      const wrap = document.createElement('div');
      wrap.className = 'ctrl-group';
      const h = document.createElement('h4');
      h.textContent = group.group;
      wrap.appendChild(h);
      if (group.hint) {
        const hint = document.createElement('p');
        hint.className = 'ghint';
        hint.textContent = group.hint;
        wrap.appendChild(hint);
      }

      for (const item of group.items) {
        const ctrl = document.createElement('div');
        ctrl.className = 'ctrl';

        const head = document.createElement('div');
        head.className = 'ctrl-head';
        const label = document.createElement('label');
        label.textContent = item.label;
        label.htmlFor = `ctrl_${item.key}`;
        const val = document.createElement('span');
        val.className = 'cval';
        head.append(label, val);

        const input = document.createElement('input');
        input.type = 'range';
        input.id = `ctrl_${item.key}`;
        input.min = item.min;
        input.max = item.max;
        input.step = item.step;

        input.addEventListener('input', () => {
          const v = parseFloat(input.value);
          val.textContent = v.toFixed(2);
          state.params[item.key] = v;
          state.engine && state.engine.setParams({ [item.key]: v });
          markCustom();
        });

        ctrl.append(head, input);
        if (item.help) {
          const help = document.createElement('p');
          help.className = 'chelp';
          help.textContent = item.help;
          ctrl.appendChild(help);
        }
        wrap.appendChild(ctrl);
        sliderRefs.set(item.key, { input, val });
      }
      el.controlGroups.appendChild(wrap);
    }
  }

  function syncControlValues() {
    for (const [key, ref] of sliderRefs) {
      const v = state.params[key];
      if (typeof v === 'number') {
        ref.input.value = v;
        ref.val.textContent = v.toFixed(2);
      }
    }
  }

  /** Once a slider moves, the selection is no longer a stock preset. */
  function markCustom() {
    if (state.presetId !== '__custom') {
      state.presetId = '__custom';
      renderPresetGrid();
    }
  }

  /* ------------------------------------------------------------------ *
   * UI - transport
   * ------------------------------------------------------------------ */

  function updatePlayButton() {
    el.playBtn.innerHTML = el.video.paused ? ICONS.play : ICONS.pause;
  }

  function updateTime() {
    const v = el.video;
    const d = Number.isFinite(v.duration) ? v.duration : 0;
    el.timeLabel.textContent = `${fmtTime(v.currentTime)} / ${fmtTime(d)}`;
    if (!state.scrubbing && d > 0) {
      const pct = (v.currentTime / d) * 100;
      el.scrubPlayed.style.width = pct + '%';
      el.scrubKnob.style.left = pct + '%';
    }
    if (v.buffered.length && d > 0) {
      let end = 0;
      for (let i = 0; i < v.buffered.length; i++) {
        if (v.buffered.start(i) <= v.currentTime) end = Math.max(end, v.buffered.end(i));
      }
      el.scrubBuffered.style.width = Math.min(100, (end / d) * 100) + '%';
    }
  }

  function updateResBadge() {
    const v = el.video;
    if (!v.videoWidth) { el.resBadge.textContent = '—'; return; }
    const src = labelForHeight(v.videoHeight);
    // Read the canvas directly rather than the stats snapshot, which is only
    // refreshed twice a second and would lag behind a settings change.
    const outH = el.glCanvas.height || v.videoHeight;
    el.resBadge.textContent = state.params.enabled
      ? `${src} → ${labelForHeight(outH)}`
      : src;
  }

  function updateEnhanceToggle() {
    const on = !!state.params.enabled;
    el.enhanceToggle.classList.toggle('off', !on);
    el.enhanceToggle.innerHTML = `<span class="dot"></span> Enhancement ${on ? 'on' : 'off'}`;
    updateResBadge();
  }

  function scrubPositionFromEvent(e) {
    const rect = el.scrub.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  }

  function bindTransport() {
    el.playBtn.addEventListener('click', () => media.toggle());
    el.back10Btn.addEventListener('click', () => media.seek(el.video.currentTime - 10));
    el.fwd10Btn.addEventListener('click', () => media.seek(el.video.currentTime + 10));

    el.volume.addEventListener('input', () => {
      const v = parseFloat(el.volume.value);
      media.setVolume(v);
      media.setMuted(v === 0);
      updateMuteIcon();
      api.settings.patch({ volume: v, muted: v === 0 });
    });

    el.muteBtn.addEventListener('click', () => {
      media.setMuted(!media.muted);
      updateMuteIcon();
      api.settings.patch({ muted: media.muted });
    });

    el.speedSelect.addEventListener('change', () => {
      media.setRate(parseFloat(el.speedSelect.value));
    });

    el.enhanceToggle.addEventListener('click', () => {
      state.params.enabled = !state.params.enabled;
      state.engine && state.engine.setParams({ enabled: state.params.enabled });
      updateEnhanceToggle();
    });

    el.compareBtn.addEventListener('click', () => setCompare(state.compare ? 0 : 1));

    el.snapshotBtn.addEventListener('click', takeSnapshot);

    el.pipBtn.addEventListener('click', async () => {
      try {
        // Picture-in-picture works off a live capture of the enhanced canvas,
        // so the floating window shows the processed image, not the raw video.
        if (document.pictureInPictureElement) {
          await document.exitPictureInPicture();
          return;
        }
        const stream = el.glCanvas.captureStream(30);
        const pipVideo = document.createElement('video');
        pipVideo.muted = true;
        pipVideo.srcObject = stream;
        await pipVideo.play();
        await pipVideo.requestPictureInPicture();
      } catch (err) {
        toast(`Picture-in-picture unavailable: ${err.message}`, 'error');
      }
    });

    el.fullscreenBtn.addEventListener('click', toggleFullscreen);

    // Scrubbing
    const onScrubMove = (e) => {
      const p = scrubPositionFromEvent(e);
      const d = el.video.duration || 0;
      el.scrubTooltip.textContent = fmtTime(p * d);
      el.scrubTooltip.style.left = (p * 100) + '%';
      if (state.scrubbing) {
        el.scrubPlayed.style.width = (p * 100) + '%';
        el.scrubKnob.style.left = (p * 100) + '%';
      }
    };
    el.scrub.addEventListener('mousemove', onScrubMove);
    el.scrub.addEventListener('mousedown', (e) => {
      state.scrubbing = true;
      onScrubMove(e);
    });
    window.addEventListener('mousemove', (e) => { if (state.scrubbing) onScrubMove(e); });
    window.addEventListener('mouseup', (e) => {
      if (!state.scrubbing) return;
      state.scrubbing = false;
      const d = el.video.duration || 0;
      if (d) media.seek(scrubPositionFromEvent(e) * d);
    });

    // Media element events
    const v = el.video;
    v.addEventListener('play', () => {
      updatePlayButton();
      if (state.dualStream && el.audio.paused) {
        el.audio.currentTime = v.currentTime;
        el.audio.play().catch(() => { /* corrected by the drift timer */ });
      }
    });
    v.addEventListener('pause', () => { updatePlayButton(); if (state.dualStream) el.audio.pause(); });
    v.addEventListener('timeupdate', () => { updateTime(); updateResBadge(); });
    v.addEventListener('progress', updateTime);
    v.addEventListener('durationchange', updateTime);
    v.addEventListener('seeking', () => { if (state.dualStream) el.audio.currentTime = v.currentTime; });
    v.addEventListener('waiting', () => { if (state.dualStream) el.audio.pause(); });
    v.addEventListener('playing', () => {
      if (state.dualStream && el.audio.paused) {
        el.audio.currentTime = v.currentTime;
        el.audio.play().catch(() => { /* corrected by the drift timer */ });
      }
    });
    v.addEventListener('ratechange', () => { el.speedSelect.value = String(v.playbackRate); });
    v.addEventListener('ended', () => { api.system.keepAwake(false); updatePlayButton(); });

    v.addEventListener('loadedmetadata', async () => {
      updateTime();
      updateResBadge();
      if (state.settings.rememberPosition && state.resumeKey) {
        const r = await api.resume.get(state.resumeKey);
        if (r.ok && r.seconds > 15 && r.seconds < (v.duration || Infinity) - 20) {
          media.seek(r.seconds);
          toast(`Resumed at ${fmtTime(r.seconds)}`, 'ok', 3000);
        }
      }
      if (state.settings.autoplay) media.play();
    });

    v.addEventListener('error', () => {
      const err = v.error;
      const map = {
        1: 'Loading was aborted.',
        2: 'A network error interrupted the stream.',
        3: 'This file could not be decoded — the codec may not be supported.',
        4: 'This source is not supported.'
      };
      toast(map[err && err.code] || 'Playback failed.', 'error', 8000);
      hideLoading();
    });

    // Drift correction + position persistence
    setInterval(() => {
      media.syncDrift();
      if (
        state.settings && state.settings.rememberPosition && state.resumeKey &&
        !v.paused && Math.abs(v.currentTime - state.lastSavedPosition) > 5
      ) {
        state.lastSavedPosition = v.currentTime;
        api.resume.set(state.resumeKey, v.currentTime);
      }
    }, 1000);
  }

  function updateMuteIcon() {
    const silent = media.muted || parseFloat(el.volume.value) === 0;
    el.muteBtn.innerHTML = silent ? ICONS.mute : ICONS.volume;
  }

  async function takeSnapshot() {
    if (!state.engine || !state.media) return toast('Nothing is playing.', 'warn');
    const blob = await state.engine.snapshot();
    if (!blob) return toast('Could not capture the frame.', 'error');
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const base = (state.media.title || 'frame').replace(/[^\w.-]+/g, '_').slice(0, 60);
    a.href = url;
    a.download = `${base}_${Math.round(el.video.currentTime)}s.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast('Frame saved to your downloads folder.', 'ok');
  }

  /* ------------------------------------------------------------------ *
   * Compare split
   * ------------------------------------------------------------------ */

  function setCompare(mode) {
    state.compare = mode;
    el.compareBtn.classList.toggle('active', !!mode);
    el.compareLabels.hidden = !mode;
    el.splitHandle.hidden = !mode;
    if (state.engine) state.engine.setCompare(mode, state.splitX);
    positionSplitHandle();
  }

  function positionSplitHandle() {
    const rect = el.glCanvas.getBoundingClientRect();
    const stage = el.stageInner.getBoundingClientRect();
    const x = rect.left - stage.left + rect.width * state.splitX;
    el.splitHandle.style.left = `${x}px`;
  }

  function bindSplit() {
    const move = (e) => {
      if (!state.splitDragging) return;
      const rect = el.glCanvas.getBoundingClientRect();
      state.splitX = Math.max(0.02, Math.min(0.98, (e.clientX - rect.left) / rect.width));
      state.engine && state.engine.setCompare(state.compare, state.splitX);
      positionSplitHandle();
    };
    el.splitHandle.addEventListener('mousedown', (e) => {
      state.splitDragging = true;
      e.preventDefault();
    });
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', () => { state.splitDragging = false; });
    window.addEventListener('resize', positionSplitHandle);
  }

  /* ------------------------------------------------------------------ *
   * Fullscreen + idle chrome
   * ------------------------------------------------------------------ */

  async function toggleFullscreen() {
    const res = await api.system.setFullscreen();
    document.body.classList.toggle('is-fullscreen', res.fullscreen);
    el.fullscreenBtn.innerHTML = res.fullscreen ? ICONS.exitFullscreen : ICONS.fullscreen;
    setTimeout(positionSplitHandle, 120);
  }

  function bindIdle() {
    const wake = () => {
      document.body.classList.remove('idle');
      clearTimeout(state.idleTimer);
      state.idleTimer = setTimeout(() => {
        if (document.body.classList.contains('is-fullscreen') && !el.video.paused) {
          document.body.classList.add('idle');
        }
      }, 2600);
    };
    ['mousemove', 'mousedown', 'keydown', 'wheel'].forEach((evt) =>
      window.addEventListener(evt, wake, { passive: true })
    );
    wake();
  }

  /* ------------------------------------------------------------------ *
   * Stats overlay
   * ------------------------------------------------------------------ */

  function bindStats() {
    let visible = false;
    const render = () => {
      if (!visible || !state.engine) return;
      const s = state.engine.stats;
      const v = el.video;
      const rows = [
        ['Source', v.videoWidth ? `${v.videoWidth}×${v.videoHeight}` : '—'],
        ['Render', s.outputW ? `${s.outputW}×${s.outputH}` : '—'],
        ['Scale', v.videoWidth ? `${(s.outputW / v.videoWidth).toFixed(2)}×` : '—'],
        ['Frame rate', `${s.fps} fps`],
        ['Frame cost', `${s.cpuMs} ms`],
        ['Quality scale', `${Math.round(s.droppedScale * 100)}%`],
        ['Precision', state.engine.precision],
        ['GPU', String(s.gpu).slice(0, 34)]
      ];
      if (s.limited) rows.push(['Status', 'GPU limited — try a lighter preset']);
      el.statsOverlay.innerHTML = rows
        .map(([k, val]) => `<div class="row"><span>${k}</span><b>${val}</b></div>`)
        .join('');
    };
    setInterval(render, 500);

    el.statsBtn.addEventListener('click', () => {
      visible = !visible;
      el.statsOverlay.hidden = !visible;
      el.statsBtn.classList.toggle('active', visible);
      api.settings.patch({ showStats: visible });
      render();
    });

    // Restore the persisted preference once settings arrive.
    setTimeout(() => {
      if (state.settings && state.settings.showStats) el.statsBtn.click();
    }, 60);
  }

  /* ------------------------------------------------------------------ *
   * Export
   * ------------------------------------------------------------------ */

  async function populateEncoders() {
    const res = await api.app.encoders();
    if (!res.ok) return;
    const sel = el.exportEncoder;
    const existing = new Set([...sel.options].map((o) => o.value));
    for (const enc of res.encoders) {
      if (existing.has(enc.id)) continue;
      const opt = document.createElement('option');
      opt.value = enc.id;
      opt.textContent = `${enc.label} — hardware`;
      sel.appendChild(opt);
    }
    const x265 = document.createElement('option');
    x265.value = 'libx265';
    x265.textContent = 'HEVC (CPU, smaller files)';
    sel.appendChild(x265);
    // Default to hardware when it exists: an hour-long 4K render goes from
    // hours to minutes.
    if (res.encoders.length) sel.value = res.encoders[0].id;
  }

  async function startExport() {
    if (!state.media) return toast('Open a video first.', 'warn');
    if (state.media.isLive) return toast('Live streams cannot be exported.', 'warn');

    const base = (state.media.title || 'visionance')
      .replace(/\.[a-z0-9]{2,4}$/i, '')
      .replace(/[^\w\s.-]+/g, '')
      .trim()
      .slice(0, 70) || 'visionance';
    const suggested = `${base} (enhanced).mp4`;

    const dest = await api.dialog.saveVideo(suggested);
    if (!dest.ok) return;

    const params = { ...state.params };
    const resValue = el.exportRes.value;
    if (resValue !== 'source') params.targetResolution = resValue;
    else params.scaleFactor = 1;

    const cfg = {
      input: state.media.kind === 'local' ? state.media.source : state.media.video.url,
      audioInput: state.media.audio ? state.media.audio.url : null,
      output: dest.file,
      title: state.media.title,
      params,
      encoder: el.exportEncoder.value,
      quality: Number(el.exportQuality.value),
      preserveAudio: el.exportAudio.checked,
      headerToken: state.media.headerToken || null
    };

    const res = await api.exports.start(cfg);
    if (!res.ok) return toast(res.error, 'error', 8000);
    toast('Render queued. You can keep watching while it runs.', 'ok');
    upsertJob(res.job);
    document.querySelector('.tab[data-tab="export"]').click();
  }

  function upsertJob(job) {
    state.jobs.set(job.id, job);
    renderJobs();
  }

  function renderJobs() {
    const jobs = [...state.jobs.values()].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    if (!jobs.length) {
      el.jobList.innerHTML = '';
      return;
    }
    el.jobList.innerHTML = '';
    for (const job of jobs) {
      const node = document.createElement('div');
      node.className = 'job';

      const head = document.createElement('div');
      head.className = 'job-head';
      const title = document.createElement('div');
      title.className = 'job-title';
      title.textContent = job.title;
      title.title = job.output;
      const status = document.createElement('div');
      status.className = `job-status ${job.status}`;
      status.textContent = job.status;
      head.append(title, status);

      const bar = document.createElement('div');
      bar.className = 'job-bar';
      const fill = document.createElement('span');
      fill.style.width = `${Math.round((job.progress || 0) * 100)}%`;
      bar.appendChild(fill);

      const meta = document.createElement('div');
      meta.className = 'job-meta';
      const left = document.createElement('span');
      left.textContent = `${Math.round((job.progress || 0) * 100)}%`;
      const right = document.createElement('span');
      right.textContent = job.status === 'running'
        ? `${job.speed ? job.speed.toFixed(2) + '×' : '—'}${job.eta ? ` · ${fmtTime(job.eta)} left` : ''}`
        : job.status === 'done' && job.outputSize ? fmtBytes(job.outputSize) : '';
      meta.append(left, right);

      node.append(head, bar, meta);

      if (job.error) {
        const err = document.createElement('div');
        err.className = 'job-error';
        err.textContent = job.error;
        node.appendChild(err);
      }

      const actions = document.createElement('div');
      actions.className = 'job-actions';
      if (job.status === 'running' || job.status === 'queued') {
        const cancel = document.createElement('button');
        cancel.className = 'btn btn-ghost';
        cancel.textContent = 'Cancel';
        cancel.addEventListener('click', () => api.exports.cancel(job.id));
        actions.appendChild(cancel);
      } else if (job.status === 'done') {
        const open = document.createElement('button');
        open.className = 'btn btn-ghost';
        open.textContent = 'Play';
        open.addEventListener('click', () => api.system.openPath(job.output));
        const reveal = document.createElement('button');
        reveal.className = 'btn btn-ghost';
        reveal.textContent = 'Show in folder';
        reveal.addEventListener('click', () => api.system.reveal(job.output));
        actions.append(open, reveal);
      }
      if (actions.children.length) node.appendChild(actions);

      el.jobList.appendChild(node);
    }
  }

  /* ------------------------------------------------------------------ *
   * Library
   * ------------------------------------------------------------------ */

  function renderRecents(recents) {
    el.recentList.innerHTML = '';
    if (!recents || !recents.length) {
      el.recentList.innerHTML = '<div class="empty-note">Nothing here yet. Videos you play will show up for one-click reopening.</div>';
      return;
    }
    for (const item of recents) {
      const row = document.createElement('div');
      row.className = 'recent';

      const icon = document.createElement('div');
      icon.className = 'recent-icon';
      icon.innerHTML = item.kind === 'stream' ? ICONS.link : ICONS.file;

      const meta = document.createElement('div');
      meta.className = 'recent-meta';
      const t = document.createElement('div');
      t.className = 'recent-title';
      t.textContent = item.title || item.source;
      const s = document.createElement('div');
      s.className = 'recent-sub';
      s.textContent = item.kind === 'stream' ? 'Online stream' : item.source;
      meta.append(t, s);

      const del = document.createElement('button');
      del.className = 'recent-del';
      del.textContent = '✕';
      del.title = 'Remove';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        const r = await api.recents.remove(item.source);
        if (r.ok) renderRecents(r.recents);
      });

      row.addEventListener('click', () => {
        if (item.kind === 'stream') openUrl(item.source);
        else openLocalFile(item.source);
      });

      row.append(icon, meta, del);
      el.recentList.appendChild(row);
    }
  }

  /* ------------------------------------------------------------------ *
   * Settings modal
   * ------------------------------------------------------------------ */

  function openSettings() {
    el.settingsModal.hidden = false;
    refreshDependencyStatus();
  }

  async function refreshDependencyStatus() {
    const res = await api.app.info();
    if (!res.ok) return;
    state.info = res;

    const yt = res.binaries.ytdlp;
    if (yt.path) {
      el.ytdlpStatus.textContent = `Installed — ${yt.version || 'version unknown'}`;
      el.installYtdlpBtn.textContent = 'Reinstall';
    } else {
      el.ytdlpStatus.textContent = 'Not found. Online video playback needs it.';
      el.installYtdlpBtn.textContent = 'Install';
    }

    const ff = res.binaries.ffmpeg;
    el.ffmpegStatus.textContent = ff.path
      ? `Ready — ${(ff.version || '').replace('ffmpeg version ', '').split(' ')[0] || 'ok'}`
      : 'Not found. Exporting is unavailable until ffmpeg is located.';

    el.aboutText.textContent =
      `Visionance ${res.version} · Electron ${res.versions.electron} · Chromium ${res.versions.chrome} · ${res.platform}/${res.arch}`;
  }

  function bindSettings() {
    el.settingsBtn.addEventListener('click', openSettings);
    el.closeSettings.addEventListener('click', () => { el.settingsModal.hidden = true; });
    el.settingsModal.addEventListener('mousedown', (e) => {
      if (e.target === el.settingsModal) el.settingsModal.hidden = true;
    });

    el.closeInfo.addEventListener('click', () => { el.infoModal.hidden = true; });
    el.infoModal.addEventListener('mousedown', (e) => {
      if (e.target === el.infoModal) el.infoModal.hidden = true;
    });
    el.emptyDemoBtn.addEventListener('click', () => { el.infoModal.hidden = false; });

    el.installYtdlpBtn.addEventListener('click', async () => {
      el.installYtdlpBtn.disabled = true;
      el.ytdlpStatus.textContent = 'Downloading…';
      const off = api.ytdlp.onProgress((f) => {
        el.ytdlpStatus.textContent = `Downloading… ${Math.round(f * 100)}%`;
      });
      const res = await api.ytdlp.install();
      off();
      el.installYtdlpBtn.disabled = false;
      if (res.ok) {
        toast('yt-dlp installed. Online videos are ready.', 'ok');
        refreshDependencyStatus();
      } else {
        el.ytdlpStatus.textContent = res.error;
        toast(res.error, 'error', 8000);
      }
    });

    el.locateYtdlpBtn.addEventListener('click', async () => {
      const r = await api.dialog.pickBinary('ytdlp');
      if (r.ok) { toast('yt-dlp location saved.', 'ok'); refreshDependencyStatus(); }
    });
    el.locateFfmpegBtn.addEventListener('click', async () => {
      const r = await api.dialog.pickBinary('ffmpeg');
      if (r.ok) { toast('ffmpeg location saved.', 'ok'); refreshDependencyStatus(); }
    });

    el.maxHeight.addEventListener('change', () =>
      api.settings.patch({ maxStreamHeight: Number(el.maxHeight.value) }));
    el.cookieBrowser.addEventListener('change', () =>
      api.settings.patch({ cookiesFromBrowser: el.cookieBrowser.value }));
    el.autoplayToggle.addEventListener('change', () => {
      state.settings.autoplay = el.autoplayToggle.checked;
      api.settings.patch({ autoplay: el.autoplayToggle.checked });
    });
    el.resumeToggle.addEventListener('change', () => {
      state.settings.rememberPosition = el.resumeToggle.checked;
      api.settings.patch({ rememberPosition: el.resumeToggle.checked });
    });
    el.targetFpsSelect.addEventListener('change', () => {
      const fps = Number(el.targetFpsSelect.value);
      if (state.engine) state.engine.targetFps = fps;
      api.settings.patch({ targetFps: fps });
    });
  }

  /* ------------------------------------------------------------------ *
   * Global bindings
   * ------------------------------------------------------------------ */

  function bindGlobal() {
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
        document.querySelectorAll('.tab-page').forEach((p) => p.classList.remove('active'));
        tab.classList.add('active');
        document.querySelector(`.tab-page[data-page="${tab.dataset.tab}"]`).classList.add('active');
      });
    });

    el.goBtn.addEventListener('click', () => openUrl(el.urlInput.value));
    el.urlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') openUrl(el.urlInput.value);
    });
    el.urlInput.addEventListener('paste', () => {
      setTimeout(() => {
        if (isUrl(el.urlInput.value)) openUrl(el.urlInput.value);
      }, 30);
    });

    const pickFile = async () => {
      const res = await api.dialog.openVideo();
      if (res.ok) openLocalFile(res.files[0]);
    };
    el.openFileBtn.addEventListener('click', pickFile);
    el.emptyOpenBtn.addEventListener('click', pickFile);

    el.scaleSelect.addEventListener('change', () => {
      const value = el.scaleSelect.value;
      state.engine && state.engine.setRenderScaleCap(value === 'auto' ? 'auto' : Number(value));
      api.settings.patch({ renderScale: value });
    });

    el.adaptiveToggle.addEventListener('change', () => {
      if (state.engine) state.engine.setAdaptive(el.adaptiveToggle.checked);
      api.settings.patch({ adaptiveQuality: el.adaptiveToggle.checked });
    });

    el.savePresetBtn.addEventListener('click', async () => {
      const name = el.presetName.value.trim();
      if (!name) return toast('Give the preset a name first.', 'warn');
      const preset = {
        id: `user_${Date.now()}`,
        name,
        tag: 'Custom',
        description: 'Your saved look.',
        params: { ...state.params }
      };
      const r = await api.presets.save(preset);
      if (r.ok) {
        state.userPresets = r.presets;
        state.presetId = preset.id;
        el.presetName.value = '';
        renderPresetGrid();
        toast(`Saved "${name}".`, 'ok');
      }
    });

    el.resetParamsBtn.addEventListener('click', () => {
      const preset = findPreset(state.presetId) || findPreset('balanced');
      applyParams(preset.params, preset.id);
      toast(`Reset to ${preset.name}.`);
    });

    el.exportQuality.addEventListener('input', () => {
      el.exportQualityVal.textContent = el.exportQuality.value;
    });
    el.startExportBtn.addEventListener('click', startExport);
    el.clearRecentsBtn.addEventListener('click', async () => {
      const r = await api.recents.clear();
      if (r.ok) renderRecents(r.recents);
    });

    // Drag & drop
    let dragDepth = 0;
    window.addEventListener('dragenter', (e) => {
      e.preventDefault();
      dragDepth++;
      el.dropOverlay.hidden = false;
    });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('dragleave', (e) => {
      e.preventDefault();
      if (--dragDepth <= 0) { dragDepth = 0; el.dropOverlay.hidden = true; }
    });
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      dragDepth = 0;
      el.dropOverlay.hidden = true;

      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) {
        const p = api.pathForFile(file);
        if (p) return openLocalFile(p);
      }
      const text = e.dataTransfer.getData('text/plain');
      if (isUrl(text)) {
        el.urlInput.value = text;
        openUrl(text);
      } else {
        toast('That does not look like a video file or link.', 'warn');
      }
    });

    // Keyboard
    window.addEventListener('keydown', (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
      if (typing) {
        if (e.key === 'Escape') document.activeElement.blur();
        return;
      }
      if (!el.settingsModal.hidden || !el.infoModal.hidden) {
        if (e.key === 'Escape') { el.settingsModal.hidden = true; el.infoModal.hidden = true; }
        return;
      }

      switch (e.key.toLowerCase()) {
        case ' ':
        case 'k': e.preventDefault(); media.toggle(); break;
        case 'arrowleft': media.seek(el.video.currentTime - (e.shiftKey ? 60 : 5)); break;
        case 'arrowright': media.seek(el.video.currentTime + (e.shiftKey ? 60 : 5)); break;
        case 'j': media.seek(el.video.currentTime - 10); break;
        case 'l': media.seek(el.video.currentTime + 10); break;
        case 'arrowup': e.preventDefault(); nudgeVolume(0.05); break;
        case 'arrowdown': e.preventDefault(); nudgeVolume(-0.05); break;
        case 'm': media.setMuted(!media.muted); updateMuteIcon(); break;
        case 'f': toggleFullscreen(); break;
        case 'c': setCompare(state.compare ? 0 : 1); break;
        case 'b': el.enhanceToggle.click(); break;
        case 's': takeSnapshot(); break;
        case 'escape':
          if (document.body.classList.contains('is-fullscreen')) toggleFullscreen();
          break;
        default:
          if (/^[0-9]$/.test(e.key) && el.video.duration) {
            media.seek((Number(e.key) / 10) * el.video.duration);
          }
      }
    });

    el.stageInner.addEventListener('click', (e) => {
      if (e.target === el.glCanvas) media.toggle();
    });
    el.stageInner.addEventListener('dblclick', (e) => {
      if (e.target === el.glCanvas) toggleFullscreen();
    });

    // Menu commands from the main process
    api.events.onMenu((command) => {
      const actions = {
        'open-file': pickFile,
        'open-url': () => el.urlInput.focus(),
        'export': startExport,
        'toggle-play': () => media.toggle(),
        'toggle-enhance': () => el.enhanceToggle.click(),
        'toggle-compare': () => setCompare(state.compare ? 0 : 1),
        'toggle-stats': () => el.statsBtn.click(),
        fullscreen: toggleFullscreen
      };
      const fn = actions[command];
      if (fn) fn();
    });

    api.events.onExternalFile((filePath) => openLocalFile(filePath));
    api.exports.onUpdate((job) => upsertJob(job));

    window.addEventListener('beforeunload', () => {
      if (state.resumeKey && state.settings && state.settings.rememberPosition) {
        api.resume.set(state.resumeKey, el.video.currentTime);
      }
      api.system.keepAwake(false);
    });
  }

  function nudgeVolume(delta) {
    const next = Math.max(0, Math.min(1, parseFloat(el.volume.value) + delta));
    el.volume.value = next;
    el.volume.dispatchEvent(new Event('input'));
  }

  /* ------------------------------------------------------------------ *
   * Boot
   * ------------------------------------------------------------------ */

  async function boot() {
    const [settingsRes, presetsRes, recentsRes] = await Promise.all([
      api.settings.get(),
      api.presets.get(),
      api.recents.get()
    ]);

    state.settings = settingsRes.ok ? settingsRes.settings : {};
    state.userPresets = presetsRes.ok ? presetsRes.presets : {};

    applyIcons();
    buildControls();
    initEngine();

    const startPreset = findPreset(state.settings.lastPresetId) || findPreset('balanced');
    applyParams(startPreset.params, startPreset.id);

    // Reflect persisted settings in the UI.
    el.volume.value = state.settings.volume ?? 1;
    el.scaleSelect.value = String(state.settings.renderScale ?? 'auto');
    el.adaptiveToggle.checked = state.settings.adaptiveQuality !== false;
    el.autoplayToggle.checked = state.settings.autoplay !== false;
    el.resumeToggle.checked = state.settings.rememberPosition !== false;
    el.targetFpsSelect.value = String(state.settings.targetFps || 60);
    el.maxHeight.value = String(state.settings.maxStreamHeight ?? 1080);
    el.cookieBrowser.value = state.settings.cookiesFromBrowser || '';
    updateMuteIcon();

    if (state.engine) {
      state.engine.setAdaptive(el.adaptiveToggle.checked);
      state.engine.targetFps = Number(el.targetFpsSelect.value);
      state.engine.setRenderScaleCap(
        el.scaleSelect.value === 'auto' ? 'auto' : Number(el.scaleSelect.value)
      );
    }

    bindTransport();
    bindSplit();
    bindStats();
    bindSettings();
    bindGlobal();
    bindIdle();

    renderRecents(recentsRes.ok ? recentsRes.recents : []);
    populateEncoders();
    refreshDependencyStatus().then(() => {
      if (state.info && !state.info.binaries.ytdlp.path) {
        toast('Install yt-dlp in Settings to play online video links.', 'warn', 8000);
      }
    });

    const jobsRes = await api.exports.list();
    if (jobsRes.ok) jobsRes.jobs.forEach((j) => state.jobs.set(j.id, j));
    renderJobs();

    // Persist the active preset so the next launch feels continuous.
    setInterval(() => {
      if (state.presetId !== '__custom' && state.settings.lastPresetId !== state.presetId) {
        state.settings.lastPresetId = state.presetId;
        api.settings.patch({ lastPresetId: state.presetId });
      }
      updateResBadge();
    }, 3000);
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
