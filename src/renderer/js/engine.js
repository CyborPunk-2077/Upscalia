/**
 * WebGL2 rendering engine.
 *
 * Owns the GL context, the shader programs, the ping-pong framebuffers and the
 * frame loop. It is deliberately decoupled from the UI: give it a <video> and a
 * parameter object and it draws enhanced frames into its canvas.
 */

(function () {
  'use strict';

  const S = window.VSShaders;

  const QUAD = new Float32Array([-1, -1, 3, -1, -1, 3]); // full-screen triangle

  /** Texture unit reserved for allocations, never sampled by a shader. */
  const SCRATCH_UNIT = 7;

  class Pass {
    constructor(gl, fragSrc, name) {
      this.gl = gl;
      this.name = name;
      this.program = createProgram(gl, S.VERT_QUAD, fragSrc, name);
      this.uniforms = new Map();
      const count = gl.getProgramParameter(this.program, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < count; i++) {
        const info = gl.getActiveUniform(this.program, i);
        if (!info) continue;
        const cleanName = info.name.replace(/\[0\]$/, '');
        this.uniforms.set(cleanName, gl.getUniformLocation(this.program, info.name));
      }
    }

    use() {
      this.gl.useProgram(this.program);
      return this;
    }

    loc(name) {
      return this.uniforms.get(name) || null;
    }

    f(name, value) {
      const l = this.loc(name);
      if (l) this.gl.uniform1f(l, value);
      return this;
    }

    i(name, value) {
      const l = this.loc(name);
      if (l) this.gl.uniform1i(l, value);
      return this;
    }

    v2(name, x, y) {
      const l = this.loc(name);
      if (l) this.gl.uniform2f(l, x, y);
      return this;
    }
  }

  function compile(gl, type, src, name) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error(`[${name}] shader compile failed: ${log}`);
    }
    return sh;
  }

  function createProgram(gl, vsSrc, fsSrc, name) {
    const vs = compile(gl, gl.VERTEX_SHADER, vsSrc, name + ':vert');
    const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc, name + ':frag');
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.bindAttribLocation(prog, 0, 'aPos');
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(prog);
      gl.deleteProgram(prog);
      throw new Error(`[${name}] program link failed: ${log}`);
    }
    return prog;
  }

  class RenderTarget {
    constructor(gl, internalFormat, type) {
      this.gl = gl;
      this.internalFormat = internalFormat;
      this.type = type;
      this.width = 0;
      this.height = 0;
      this.texture = gl.createTexture();
      this.fbo = gl.createFramebuffer();
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texture, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    resize(w, h) {
      w = Math.max(1, Math.floor(w));
      h = Math.max(1, Math.floor(h));
      if (w === this.width && h === this.height) return;
      const gl = this.gl;
      this.width = w;
      this.height = h;
      // Reallocate on a scratch texture unit. Using unit 0 here would replace
      // the source texture a pass has just bound and create a framebuffer
      // feedback loop the moment we draw into this target.
      gl.activeTexture(gl.TEXTURE0 + SCRATCH_UNIT);
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, this.internalFormat, w, h, 0, gl.RGBA, this.type, null);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.activeTexture(gl.TEXTURE0);
    }

    dispose() {
      const gl = this.gl;
      gl.deleteTexture(this.texture);
      gl.deleteFramebuffer(this.fbo);
    }
  }

  const DEFAULT_PARAMS = {
    enabled: true,
    denoise: 0,
    deblock: 0,
    edge: 0.5,
    line: 0,
    sharpen: 0.35,
    haloGuard: 0.8,
    deband: 0.25,
    localContrast: 0.15,
    contrast: 0.06,
    brightness: 0,
    saturation: 0.08,
    vibrance: 0.1,
    gamma: 0,
    temperature: 0,
    tint: 0,
    blackLevel: 0.05,
    highlightRolloff: 0.25,
    bloom: 0,
    grain: 0,
    vignette: 0,
    scaleFactor: 2
  };

  class Engine {
    /**
     * @param {HTMLCanvasElement} canvas
     */
    constructor(canvas) {
      this.canvas = canvas;
      this.params = { ...DEFAULT_PARAMS };
      this.video = null;
      this.compareMode = 0; // 0 off, 1 split, 2 original
      this.splitX = 0.5;
      this.running = false;
      this.renderScaleCap = 'auto';
      this.adaptive = true;
      this.targetFps = 60;
      this.onError = null;

      this.stats = {
        fps: 0,
        cpuMs: 0,
        outputW: 0,
        outputH: 0,
        sourceW: 0,
        sourceH: 0,
        droppedScale: 1,
        gpu: 'unknown'
      };

      this._frameTimes = [];
      this._lastStatsAt = performance.now();
      this._framesSinceStats = 0;
      this._qualityScale = 1;
      this._rvfcHandle = null;
      this._rafHandle = null;
      this._needsDraw = true;

      this._initGL();
    }

    _initGL() {
      const attrs = {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: false,
        powerPreference: 'high-performance',
        desynchronized: true
      };
      const gl = this.canvas.getContext('webgl2', attrs);
      if (!gl) throw new Error('WebGL2 is not available on this system.');
      this.gl = gl;

      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      if (dbg) {
        this.stats.gpu = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || 'unknown';
      }

      // Half-float intermediates keep the grading maths clean; fall back to 8bpc.
      const hasHalfFloat = !!gl.getExtension('EXT_color_buffer_half_float') ||
        !!gl.getExtension('EXT_color_buffer_float');
      this.internalFormat = hasHalfFloat ? gl.RGBA16F : gl.RGBA8;
      this.textureType = hasHalfFloat ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
      this.precision = hasHalfFloat ? '16-bit float' : '8-bit';

      this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);

      this.vao = gl.createVertexArray();
      gl.bindVertexArray(this.vao);
      this.vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, QUAD, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);

      this.passes = {
        restore: new Pass(gl, S.FRAG_RESTORE, 'restore'),
        upscale: new Pass(gl, S.FRAG_UPSCALE, 'upscale'),
        sharpen: new Pass(gl, S.FRAG_SHARPEN, 'sharpen'),
        grade: new Pass(gl, S.FRAG_GRADE, 'grade')
      };

      this.videoTexture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.videoTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

      this.rtA = new RenderTarget(gl, this.internalFormat, this.textureType);
      this.rtB = new RenderTarget(gl, this.internalFormat, this.textureType);
      this.rtC = new RenderTarget(gl, this.internalFormat, this.textureType);

      this.canvas.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        this.stop();
        if (this.onError) this.onError(new Error('The GPU context was lost. Reloading the view will restore it.'));
      });
    }

    setVideo(videoEl) {
      this.video = videoEl;
      this._videoTextureSize = null;
      this._needsDraw = true;
      this._restartFrameSource();
    }

    setParams(patch) {
      Object.assign(this.params, patch || {});
      this._needsDraw = true;
    }

    getParams() {
      return { ...this.params };
    }

    setCompare(mode, splitX) {
      this.compareMode = mode | 0;
      if (typeof splitX === 'number') this.splitX = Math.min(1, Math.max(0, splitX));
      this._needsDraw = true;
    }

    setRenderScaleCap(cap) {
      this.renderScaleCap = cap;
      // Start from full quality: a throttle earned at the previous resolution
      // says nothing about the new one, and inheriting it makes the setting
      // look like it did nothing.
      this._qualityScale = 1;
      this.stats.limited = false;
      this._needsDraw = true;
    }

    setAdaptive(enabled) {
      this.adaptive = !!enabled;
      if (!enabled) {
        this._qualityScale = 1;
        this.stats.limited = false;
      }
      this._needsDraw = true;
    }

    start() {
      if (this.running) return;
      this.running = true;
      this._restartFrameSource();
    }

    stop() {
      this.running = false;
      if (this._rafHandle) cancelAnimationFrame(this._rafHandle);
      this._rafHandle = null;
      if (this._rvfcHandle && this.video && this.video.cancelVideoFrameCallback) {
        try { this.video.cancelVideoFrameCallback(this._rvfcHandle); } catch { /* ignore */ }
      }
      this._rvfcHandle = null;
    }

    /**
     * Prefer requestVideoFrameCallback: it fires once per decoded frame, so a
     * 24 fps film costs 24 renders per second instead of 60.
     */
    _restartFrameSource() {
      if (!this.running) return;
      if (this._rafHandle) cancelAnimationFrame(this._rafHandle);
      this._rafHandle = null;

      const useRvfc = this.video && typeof this.video.requestVideoFrameCallback === 'function';
      if (useRvfc) {
        const step = () => {
          if (!this.running) return;
          this._drawSafe();
          this._rvfcHandle = this.video.requestVideoFrameCallback(step);
        };
        this._rvfcHandle = this.video.requestVideoFrameCallback(step);
        // A low-rate rAF keeps the canvas correct while paused or seeking.
        const idle = () => {
          if (!this.running) return;
          if (this._needsDraw || (this.video && this.video.paused)) this._drawSafe();
          this._rafHandle = requestAnimationFrame(idle);
        };
        this._rafHandle = requestAnimationFrame(idle);
      } else {
        const loop = () => {
          if (!this.running) return;
          this._drawSafe();
          this._rafHandle = requestAnimationFrame(loop);
        };
        this._rafHandle = requestAnimationFrame(loop);
      }
    }

    _drawSafe() {
      try {
        this.draw();
      } catch (err) {
        this.stop();
        if (this.onError) this.onError(err);
        else console.error(err);
      }
    }

    _computeOutputSize(srcW, srcH) {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      // Measure the container, not the canvas: the canvas's own box depends on
      // the size we are about to choose, which would make this self-referential.
      const host = this.canvas.parentElement || this.canvas;
      const rect = host.getBoundingClientRect();
      const displayW = Math.max(320, Math.round(rect.width * dpr));
      const displayH = Math.max(180, Math.round(rect.height * dpr));

      let factor;
      if (this.renderScaleCap === 'auto') {
        // Render just enough pixels to saturate the display, capped at 4x so a
        // 360p clip on a 4K panel does not try to hallucinate 12x detail.
        const fitW = displayW / srcW;
        const fitH = displayH / srcH;
        factor = Math.min(Math.max(fitW, fitH), 4);
      } else {
        factor = Number(this.renderScaleCap) || 1;
      }

      // Adaptive quality may pull the scale back down, but never below native:
      // rendering under the source resolution destroys real detail, which is
      // strictly worse than doing nothing.
      factor = Math.max(1, Math.max(1, factor) * this._qualityScale);

      let outW = Math.round(srcW * factor);
      let outH = Math.round(srcH * factor);

      const maxDim = Math.min(this.maxTextureSize, 7680);
      if (outW > maxDim || outH > maxDim) {
        const s = Math.min(maxDim / outW, maxDim / outH);
        outW = Math.round(outW * s);
        outH = Math.round(outH * s);
      }
      // No point rendering far above what the panel can show.
      const ceilW = Math.round(displayW * 1.35);
      const ceilH = Math.round(displayH * 1.35);
      if (outW > ceilW || outH > ceilH) {
        const s = Math.min(ceilW / outW, ceilH / outH);
        outW = Math.max(srcW, Math.round(outW * s));
        outH = Math.max(srcH, Math.round(outH * s));
      }
      return { outW, outH };
    }

    _uploadVideo() {
      const gl = this.gl;
      const v = this.video;
      const w = v.videoWidth;
      const h = v.videoHeight;
      if (!w || !h) return false;

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.videoTexture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

      const sizeChanged = !this._videoTextureSize ||
        this._videoTextureSize[0] !== w || this._videoTextureSize[1] !== h;

      if (sizeChanged) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, v);
        this._videoTextureSize = [w, h];
      } else {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, v);
      }
      return true;
    }

    _blit(pass, target, width, height) {
      const gl = this.gl;
      if (target) {
        target.resize(width, height);
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      } else {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      }
      gl.viewport(0, 0, width, height);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      void pass;
    }

    draw() {
      const gl = this.gl;
      const v = this.video;
      if (!v || v.readyState < 2) return;

      const t0 = performance.now();
      const srcW = v.videoWidth;
      const srcH = v.videoHeight;
      if (!srcW || !srcH) return;

      if (!this._uploadVideo()) return;

      const p = this.params;
      const bypass = !p.enabled;
      const { outW, outH } = bypass
        ? { outW: Math.min(srcW, 3840), outH: Math.min(srcH, 2160) }
        : this._computeOutputSize(srcW, srcH);

      if (this.canvas.width !== outW || this.canvas.height !== outH) {
        this.canvas.width = outW;
        this.canvas.height = outH;
      }

      gl.bindVertexArray(this.vao);
      gl.disable(gl.BLEND);
      gl.disable(gl.DEPTH_TEST);

      // --- Pass 1: restoration (source resolution) --------------------
      let currentTex = this.videoTexture;
      const wantsRestore = !bypass && (p.denoise > 0.002 || p.deblock > 0.002);
      if (wantsRestore) {
        const pass = this.passes.restore.use();
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.videoTexture);
        pass.i('uTex', 0)
          .v2('uTexel', 1 / srcW, 1 / srcH)
          .f('uDenoise', p.denoise)
          .f('uDeblock', p.deblock);
        this._blit(pass, this.rtA, srcW, srcH);
        currentTex = this.rtA.texture;
      }

      // --- Pass 2: upscale / reconstruction (output resolution) -------
      {
        const pass = this.passes.upscale.use();
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, currentTex);
        pass.i('uTex', 0)
          .v2('uSrcSize', srcW, srcH)
          .v2('uSrcTexel', 1 / srcW, 1 / srcH)
          .f('uEdge', bypass ? 0 : p.edge)
          .f('uLine', bypass ? 0 : p.line);
        this._blit(pass, this.rtB, outW, outH);
        currentTex = this.rtB.texture;
      }

      // --- Pass 3: contrast adaptive sharpening ----------------------
      if (!bypass && p.sharpen > 0.002) {
        const pass = this.passes.sharpen.use();
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, currentTex);
        pass.i('uTex', 0)
          .v2('uTexel', 1 / outW, 1 / outH)
          .f('uSharpen', p.sharpen)
          .f('uHaloGuard', p.haloGuard);
        this._blit(pass, this.rtC, outW, outH);
        currentTex = this.rtC.texture;
      }

      // --- Pass 4: grade + compare, straight to the canvas -----------
      {
        const pass = this.passes.grade.use();
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, currentTex);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.videoTexture);

        pass.i('uTex', 0)
          .i('uOrig', 1)
          .v2('uTexel', 1 / outW, 1 / outH)
          .f('uTime', (t0 % 100000) / 1000)
          .f('uDeband', bypass ? 0 : p.deband)
          .f('uLocalContrast', bypass ? 0 : p.localContrast)
          .f('uContrast', bypass ? 0 : p.contrast)
          .f('uBrightness', bypass ? 0 : p.brightness)
          .f('uSaturation', bypass ? 0 : p.saturation)
          .f('uVibrance', bypass ? 0 : p.vibrance)
          .f('uGamma', bypass ? 0 : p.gamma)
          .f('uTemperature', bypass ? 0 : p.temperature)
          .f('uTint', bypass ? 0 : p.tint)
          .f('uBlackLevel', bypass ? 0 : p.blackLevel)
          .f('uHighlightRolloff', bypass ? 0 : p.highlightRolloff)
          .f('uBloom', bypass ? 0 : p.bloom)
          .f('uGrain', bypass ? 0 : p.grain)
          .f('uVignette', bypass ? 0 : p.vignette)
          .i('uCompareMode', bypass ? 2 : this.compareMode)
          .f('uSplitX', this.splitX);

        this._blit(pass, null, outW, outH);
      }

      gl.bindVertexArray(null);
      this._needsDraw = false;

      this._updateStats(t0, srcW, srcH, outW, outH);
    }

    _updateStats(t0, srcW, srcH, outW, outH) {
      const cpuMs = performance.now() - t0;
      this._frameTimes.push(cpuMs);
      if (this._frameTimes.length > 60) this._frameTimes.shift();
      this._framesSinceStats++;

      const now = performance.now();
      const elapsed = now - this._lastStatsAt;
      if (elapsed >= 500) {
        const avg = this._frameTimes.reduce((a, b) => a + b, 0) / this._frameTimes.length;
        this.stats.fps = Math.round((this._framesSinceStats * 1000) / elapsed);
        this.stats.cpuMs = Math.round(avg * 100) / 100;
        this.stats.sourceW = srcW;
        this.stats.sourceH = srcH;
        this.stats.outputW = outW;
        this.stats.outputH = outH;
        this.stats.droppedScale = this._qualityScale;
        this._framesSinceStats = 0;
        this._lastStatsAt = now;

        if (this.adaptive) this._adapt(avg);
      }
    }

    /**
     * If a frame costs more than its share of the frame budget, shrink the
     * render resolution rather than dropping frames. Recovers automatically.
     */
    _adapt(avgMs) {
      const budget = 1000 / Math.max(24, this.targetFps);
      const overBudget = avgMs > budget * 0.85;
      if (overBudget && this._qualityScale > 0.5) {
        this._qualityScale = Math.max(0.5, this._qualityScale - 0.1);
      } else if (avgMs < budget * 0.45 && this._qualityScale < 1) {
        this._qualityScale = Math.min(1, this._qualityScale + 0.05);
      }
      // At the floor and still over budget means the GPU cannot sustain this
      // look at native resolution; the UI can tell the user rather than just
      // stuttering silently.
      this.stats.limited = overBudget && this._qualityScale <= 0.5;
    }

    /** Grab the current enhanced frame as a PNG blob. */
    async snapshot() {
      this.draw();
      return new Promise((resolve) => {
        this.canvas.toBlob((blob) => resolve(blob), 'image/png');
      });
    }

    dispose() {
      this.stop();
      const gl = this.gl;
      if (!gl) return;
      this.rtA.dispose();
      this.rtB.dispose();
      this.rtC.dispose();
      gl.deleteTexture(this.videoTexture);
      gl.deleteBuffer(this.vbo);
      gl.deleteVertexArray(this.vao);
      Object.values(this.passes).forEach((p) => gl.deleteProgram(p.program));
    }
  }

  window.VSEngine = { Engine, DEFAULT_PARAMS };
})();
