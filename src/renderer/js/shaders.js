/* eslint-disable no-undef */
/**
 * GLSL ES 3.00 sources for the Visionance real-time enhancement pipeline.
 *
 * The pipeline runs four passes:
 *
 *   1. RESTORE  (source resolution)  edge-aware denoise + compression-artefact
 *                                    cleanup, so we never magnify noise
 *   2. UPSCALE  (output resolution)  Catmull-Rom resample + edge-directed
 *                                    reconstruction + optional line darkening
 *   3. SHARPEN  (output resolution)  contrast-adaptive sharpening with halo
 *                                    suppression
 *   4. GRADE    (output resolution)  deband, local contrast, tone curve,
 *                                    colour, bloom, grain, vignette
 *
 * Every pass is a no-op fast path when its strength is zero, so unused work is
 * skipped rather than computed and discarded.
 */

const VERT_QUAD = `#version 300 es
in vec2 aPos;
out vec2 vUV;
void main() {
  vUV = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

const COMMON = `
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
`;

/* ------------------------------------------------------------------ *
 * Pass 1 - restoration
 * ------------------------------------------------------------------ */

const FRAG_RESTORE = `#version 300 es
precision highp float;
precision highp sampler2D;

in vec2 vUV;
out vec4 fragColor;

uniform sampler2D uTex;
uniform vec2  uTexel;    // 1.0 / source size
uniform float uDenoise;  // 0..1
uniform float uDeblock;  // 0..1
${COMMON}

const vec2 OFFS[12] = vec2[12](
  vec2(-1.0, -1.0), vec2( 0.0, -1.0), vec2( 1.0, -1.0),
  vec2(-1.0,  0.0),                   vec2( 1.0,  0.0),
  vec2(-1.0,  1.0), vec2( 0.0,  1.0), vec2( 1.0,  1.0),
  vec2(-2.0,  0.0), vec2( 2.0,  0.0), vec2( 0.0, -2.0), vec2( 0.0,  2.0)
);

const float SW[12] = float[12](
  0.707, 1.0, 0.707,
  1.0,        1.0,
  0.707, 1.0, 0.707,
  0.45,  0.45, 0.45, 0.45
);

void main() {
  vec3 center = texture(uTex, vUV).rgb;

  if (uDenoise < 0.002 && uDeblock < 0.002) {
    fragColor = vec4(center, 1.0);
    return;
  }

  float lc = luma(center);

  // Range sigma: gentle at low strength so real detail survives.
  float sigma = mix(0.025, 0.16, uDenoise) + uDeblock * 0.05;
  float inv2s2 = 1.0 / (2.0 * sigma * sigma);

  vec3 sum = center;
  float wsum = 1.0;
  float lmin = lc;
  float lmax = lc;

  for (int i = 0; i < 12; i++) {
    vec3 s = texture(uTex, vUV + OFFS[i] * uTexel).rgb;
    float ls = luma(s);
    float d = ls - lc;
    float w = SW[i] * exp(-d * d * inv2s2);
    sum += s * w;
    wsum += w;
    if (i < 8) {
      lmin = min(lmin, ls);
      lmax = max(lmax, ls);
    }
  }

  vec3 smoothed = sum / wsum;

  // Flat neighbourhoods are where blocking and mosquito noise live; textured
  // ones are where detail lives. Weight the cleanup accordingly.
  float localContrast = lmax - lmin;
  float flatness = 1.0 - smoothstep(0.025, 0.20, localContrast);
  float amount = clamp(uDenoise * 0.85 + uDeblock * flatness, 0.0, 1.0);

  fragColor = vec4(mix(center, smoothed, amount), 1.0);
}
`;

/* ------------------------------------------------------------------ *
 * Pass 2 - upscale / reconstruction
 * ------------------------------------------------------------------ */

const FRAG_UPSCALE = `#version 300 es
precision highp float;
precision highp sampler2D;

in vec2 vUV;
out vec4 fragColor;

uniform sampler2D uTex;
uniform vec2  uSrcSize;   // source pixels
uniform vec2  uSrcTexel;  // 1.0 / uSrcSize
uniform float uEdge;      // edge-directed reconstruction strength 0..1
uniform float uLine;      // line darkening (anime) 0..1
${COMMON}

// 9-tap bilinear-accelerated Catmull-Rom. Sharper than bicubic B-spline and
// far cleaner than the driver's bilinear stretch.
vec3 catmullRom(vec2 uv) {
  vec2 samplePos = uv * uSrcSize;
  vec2 texPos1 = floor(samplePos - 0.5) + 0.5;
  vec2 f = samplePos - texPos1;

  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);

  vec2 w12 = w1 + w2;
  vec2 offset12 = w2 / max(w12, vec2(1e-5));

  vec2 texPos0 = (texPos1 - 1.0) * uSrcTexel;
  vec2 texPos3 = (texPos1 + 2.0) * uSrcTexel;
  vec2 texPos12 = (texPos1 + offset12) * uSrcTexel;

  vec3 result = vec3(0.0);
  result += texture(uTex, vec2(texPos0.x,  texPos0.y)).rgb  * w0.x  * w0.y;
  result += texture(uTex, vec2(texPos12.x, texPos0.y)).rgb  * w12.x * w0.y;
  result += texture(uTex, vec2(texPos3.x,  texPos0.y)).rgb  * w3.x  * w0.y;

  result += texture(uTex, vec2(texPos0.x,  texPos12.y)).rgb * w0.x  * w12.y;
  result += texture(uTex, vec2(texPos12.x, texPos12.y)).rgb * w12.x * w12.y;
  result += texture(uTex, vec2(texPos3.x,  texPos12.y)).rgb * w3.x  * w12.y;

  result += texture(uTex, vec2(texPos0.x,  texPos3.y)).rgb  * w0.x  * w3.y;
  result += texture(uTex, vec2(texPos12.x, texPos3.y)).rgb  * w12.x * w3.y;
  result += texture(uTex, vec2(texPos3.x,  texPos3.y)).rgb  * w3.x  * w3.y;

  return max(result, vec3(0.0));
}

void main() {
  vec3 base = catmullRom(vUV);

  if (uEdge < 0.002 && uLine < 0.002) {
    fragColor = vec4(base, 1.0);
    return;
  }

  // Sobel gradient of luma, measured in source texels.
  vec2 t = uSrcTexel;
  float l00 = luma(texture(uTex, vUV + vec2(-t.x, -t.y)).rgb);
  float l10 = luma(texture(uTex, vUV + vec2( 0.0, -t.y)).rgb);
  float l20 = luma(texture(uTex, vUV + vec2( t.x, -t.y)).rgb);
  float l01 = luma(texture(uTex, vUV + vec2(-t.x,  0.0)).rgb);
  float l11 = luma(texture(uTex, vUV).rgb);
  float l21 = luma(texture(uTex, vUV + vec2( t.x,  0.0)).rgb);
  float l02 = luma(texture(uTex, vUV + vec2(-t.x,  t.y)).rgb);
  float l12 = luma(texture(uTex, vUV + vec2( 0.0,  t.y)).rgb);
  float l22 = luma(texture(uTex, vUV + vec2( t.x,  t.y)).rgb);

  float gx = (l20 + 2.0 * l21 + l22) - (l00 + 2.0 * l01 + l02);
  float gy = (l02 + 2.0 * l12 + l22) - (l00 + 2.0 * l10 + l20);
  vec2 grad = vec2(gx, gy);
  float gmag = length(grad);

  vec3 color = base;

  if (uEdge > 0.002 && gmag > 1e-4) {
    // Resample along the edge tangent. Averaging *with* the edge removes the
    // staircase without softening the edge itself.
    vec2 dir = normalize(vec2(-grad.y, grad.x));
    vec3 s1 = catmullRom(vUV + dir * t * 0.6);
    vec3 s2 = catmullRom(vUV - dir * t * 0.6);
    vec3 aligned = (s1 + s2) * 0.5;
    float w = smoothstep(0.02, 0.18, gmag) * uEdge * 0.75;
    color = mix(color, aligned, w);
  }

  if (uLine > 0.002) {
    // Anime4K-style line darkening: pull near-edge pixels toward the darkest
    // neighbour so thin lines survive magnification instead of fading out.
    float lmin = min(min(min(l00, l10), min(l20, l01)),
                 min(min(l21, l02), min(l12, l22)));
    float lc = l11;
    float edgeMask = smoothstep(0.03, 0.22, gmag);
    float ratio = clamp(lmin / max(lc, 1e-3), 0.0, 1.0);
    float darken = mix(1.0, ratio, edgeMask * uLine * 0.55);
    color *= darken;
  }

  fragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
`;

/* ------------------------------------------------------------------ *
 * Pass 3 - contrast adaptive sharpening
 * ------------------------------------------------------------------ */

const FRAG_SHARPEN = `#version 300 es
precision highp float;
precision highp sampler2D;

in vec2 vUV;
out vec4 fragColor;

uniform sampler2D uTex;
uniform vec2  uTexel;
uniform float uSharpen;   // 0..1
uniform float uHaloGuard; // 0..1, clamps the result to the local range
${COMMON}

void main() {
  vec3 e = texture(uTex, vUV).rgb;

  if (uSharpen < 0.002) {
    fragColor = vec4(e, 1.0);
    return;
  }

  vec2 t = uTexel;
  vec3 a = texture(uTex, vUV + vec2(-t.x, -t.y)).rgb;
  vec3 b = texture(uTex, vUV + vec2( 0.0, -t.y)).rgb;
  vec3 c = texture(uTex, vUV + vec2( t.x, -t.y)).rgb;
  vec3 d = texture(uTex, vUV + vec2(-t.x,  0.0)).rgb;
  vec3 f = texture(uTex, vUV + vec2( t.x,  0.0)).rgb;
  vec3 g = texture(uTex, vUV + vec2(-t.x,  t.y)).rgb;
  vec3 h = texture(uTex, vUV + vec2( 0.0,  t.y)).rgb;
  vec3 i = texture(uTex, vUV + vec2( t.x,  t.y)).rgb;

  // AMD Contrast Adaptive Sharpening: the amount of sharpening applied is
  // inversely proportional to how much local contrast already exists, so flat
  // areas stay clean and busy areas do not ring.
  vec3 mnRGB = min(min(min(d, e), min(f, b)), h);
  vec3 mnRGB2 = min(mnRGB, min(min(a, c), min(g, i)));
  mnRGB += mnRGB2;

  vec3 mxRGB = max(max(max(d, e), max(f, b)), h);
  vec3 mxRGB2 = max(mxRGB, max(max(a, c), max(g, i)));
  mxRGB += mxRGB2;

  vec3 rcpM = 1.0 / max(mxRGB, vec3(1e-4));
  vec3 amp = clamp(min(mnRGB, 2.0 - mxRGB) * rcpM, 0.0, 1.0);
  amp = sqrt(amp);

  float peak = -1.0 / mix(9.0, 4.5, clamp(uSharpen, 0.0, 1.0));
  vec3 w = amp * peak;
  vec3 rcpWeight = 1.0 / (1.0 + 4.0 * w);
  vec3 sharpened = ((b + d + f + h) * w + e) * rcpWeight;

  if (uHaloGuard > 0.002) {
    vec3 lo = min(min(min(a, b), min(c, d)), min(min(e, f), min(g, min(h, i))));
    vec3 hi = max(max(max(a, b), max(c, d)), max(max(e, f), max(g, max(h, i))));
    // Allow a small overshoot so the sharpening still reads as "crisp".
    vec3 slack = (hi - lo) * 0.12;
    vec3 guarded = clamp(sharpened, lo - slack, hi + slack);
    sharpened = mix(sharpened, guarded, uHaloGuard);
  }

  fragColor = vec4(clamp(sharpened, 0.0, 1.0), 1.0);
}
`;

/* ------------------------------------------------------------------ *
 * Pass 4 - grade / finish
 * ------------------------------------------------------------------ */

const FRAG_GRADE = `#version 300 es
precision highp float;
precision highp sampler2D;

in vec2 vUV;
out vec4 fragColor;

uniform sampler2D uTex;
uniform sampler2D uOrig;      // untouched source, for split comparison
uniform vec2  uTexel;
uniform float uTime;

uniform float uDeband;
uniform float uLocalContrast;
uniform float uContrast;
uniform float uBrightness;
uniform float uSaturation;
uniform float uVibrance;
uniform float uGamma;
uniform float uTemperature;
uniform float uTint;
uniform float uBlackLevel;
uniform float uHighlightRolloff;
uniform float uBloom;
uniform float uGrain;
uniform float uVignette;

uniform int   uCompareMode;   // 0 off, 1 split, 2 original only
uniform float uSplitX;
${COMMON}

vec3 debandPass(vec3 center) {
  if (uDeband < 0.002) return center;

  float rnd = hash12(vUV * 1024.0 + uTime);
  float ang = rnd * 6.2831853;
  float radius = mix(4.0, 24.0, uDeband) * (0.5 + rnd * 0.5);
  vec2 r = vec2(cos(ang), sin(ang)) * radius * uTexel;
  vec2 rp = vec2(-r.y, r.x);

  vec3 s0 = texture(uTex, vUV + r).rgb;
  vec3 s1 = texture(uTex, vUV - r).rgb;
  vec3 s2 = texture(uTex, vUV + rp).rgb;
  vec3 s3 = texture(uTex, vUV - rp).rgb;
  vec3 avg = (s0 + s1 + s2 + s3) * 0.25;

  // Only replace the pixel where the neighbourhood is a smooth ramp, which is
  // exactly what a banded gradient looks like.
  vec3 maxDiff = max(max(abs(s0 - center), abs(s1 - center)),
                     max(abs(s2 - center), abs(s3 - center)));
  float threshold = mix(0.008, 0.045, uDeband);
  vec3 flat3 = 1.0 - step(vec3(threshold), maxDiff);
  vec3 result = mix(center, avg, flat3 * uDeband);

  // A touch of dither breaks up whatever banding survives.
  float dither = (hash12(vUV * 2048.0 + uTime * 1.7) - 0.5) * (1.0 / 255.0) * (1.0 + uDeband * 2.0);
  return result + dither;
}

vec3 applyLocalContrast(vec3 color) {
  if (uLocalContrast < 0.002) return color;
  // Wide, cheap low-pass; the difference against it is the local detail band.
  vec2 o = uTexel * 6.0;
  vec3 blur = texture(uTex, vUV + vec2( o.x,  0.0)).rgb
            + texture(uTex, vUV + vec2(-o.x,  0.0)).rgb
            + texture(uTex, vUV + vec2( 0.0,  o.y)).rgb
            + texture(uTex, vUV + vec2( 0.0, -o.y)).rgb
            + texture(uTex, vUV + vec2( o.x,  o.y)).rgb
            + texture(uTex, vUV + vec2(-o.x, -o.y)).rgb
            + texture(uTex, vUV + vec2( o.x, -o.y)).rgb
            + texture(uTex, vUV + vec2(-o.x,  o.y)).rgb;
  blur *= 0.125;
  vec3 detail = color - blur;
  return color + detail * uLocalContrast * 1.2;
}

vec3 applyBloom(vec3 color) {
  if (uBloom < 0.002) return color;
  vec2 o = uTexel * 9.0;
  vec3 acc = vec3(0.0);
  acc += texture(uTex, vUV + vec2( o.x,  o.y)).rgb;
  acc += texture(uTex, vUV + vec2(-o.x,  o.y)).rgb;
  acc += texture(uTex, vUV + vec2( o.x, -o.y)).rgb;
  acc += texture(uTex, vUV + vec2(-o.x, -o.y)).rgb;
  acc += texture(uTex, vUV + vec2( o.x * 2.0, 0.0)).rgb;
  acc += texture(uTex, vUV + vec2(-o.x * 2.0, 0.0)).rgb;
  acc *= (1.0 / 6.0);
  vec3 bright = max(acc - vec3(0.72), vec3(0.0)) / 0.28;
  return color + bright * uBloom * 0.35;
}

vec3 applyColor(vec3 color) {
  // Black level then gamma, so crushing blacks does not fight the curve.
  color = max(color - vec3(uBlackLevel * 0.06), vec3(0.0)) / max(1.0 - uBlackLevel * 0.06, 1e-3);
  color = pow(max(color, vec3(0.0)), vec3(1.0 / max(0.35, 1.0 + uGamma * 0.6)));

  // Filmic S-curve for contrast: keeps highlights and shadows from clipping.
  float k = uContrast * 0.9;
  color = clamp(color + k * (color - 0.5) * (1.0 - abs(color - 0.5) * 1.2), 0.0, 4.0);

  color += vec3(uBrightness * 0.18);

  // White balance as simple channel gains.
  color.r *= 1.0 + uTemperature * 0.14;
  color.b *= 1.0 - uTemperature * 0.14;
  color.g *= 1.0 + uTint * 0.10;

  float l = luma(color);

  // Saturation is global; vibrance protects already-saturated pixels (skin).
  color = mix(vec3(l), color, 1.0 + uSaturation);
  if (abs(uVibrance) > 0.002) {
    float mx = max(color.r, max(color.g, color.b));
    float mn = min(color.r, min(color.g, color.b));
    float sat = mx - mn;
    float boost = uVibrance * (1.0 - smoothstep(0.15, 0.75, sat));
    color = mix(vec3(luma(color)), color, 1.0 + boost);
  }

  if (uHighlightRolloff > 0.002) {
    // Reinhard-style shoulder: recovers detail that contrast pushed to clipping.
    vec3 over = max(color - vec3(1.0 - uHighlightRolloff * 0.35), vec3(0.0));
    color -= over - over / (1.0 + over);
  }

  return color;
}

void main() {
  vec3 original = texture(uOrig, vUV).rgb;

  if (uCompareMode == 2) {
    fragColor = vec4(original, 1.0);
    return;
  }

  vec3 color = texture(uTex, vUV).rgb;
  color = debandPass(color);
  color = applyLocalContrast(color);
  color = applyBloom(color);
  color = applyColor(color);

  if (uGrain > 0.002) {
    float n = hash12(vUV * 1920.0 + uTime * 60.0) - 0.5;
    // Grain is strongest in the midtones, where the eye notices banding most.
    float l = luma(color);
    float weight = 1.0 - abs(l - 0.5) * 1.4;
    color += n * uGrain * 0.06 * max(weight, 0.15);
  }

  if (uVignette > 0.002) {
    vec2 d = vUV - 0.5;
    float v = 1.0 - dot(d, d) * uVignette * 1.6;
    color *= clamp(v, 0.0, 1.0);
  }

  color = clamp(color, 0.0, 1.0);

  if (uCompareMode == 1) {
    float edge = smoothstep(uSplitX - 0.0012, uSplitX + 0.0012, vUV.x);
    vec3 mixed = mix(original, color, edge);
    float line = 1.0 - smoothstep(0.0009, 0.0022, abs(vUV.x - uSplitX));
    mixed = mix(mixed, vec3(0.29, 0.86, 0.98), line * 0.9);
    fragColor = vec4(mixed, 1.0);
    return;
  }

  fragColor = vec4(color, 1.0);
}
`;

window.VSShaders = {
  VERT_QUAD,
  FRAG_RESTORE,
  FRAG_UPSCALE,
  FRAG_SHARPEN,
  FRAG_GRADE
};
