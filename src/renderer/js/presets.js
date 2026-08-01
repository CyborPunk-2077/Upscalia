/**
 * Built-in enhancement presets.
 *
 * Values are tuned against the failure mode each content type actually has:
 *   - streaming video is bitrate-starved -> restoration before sharpening
 *   - anime has thin lines that vanish when scaled -> line darkening
 *   - film has grain that denoisers eat -> restoration off, grade gentle
 *   - screencasts are synthetic -> hard sharpening, zero denoise
 */

(function () {
  'use strict';

  const P = (o) => Object.assign({
    enabled: true,
    denoise: 0,
    deblock: 0,
    edge: 0.5,
    line: 0,
    sharpen: 0.35,
    haloGuard: 0.8,
    deband: 0.2,
    localContrast: 0.12,
    contrast: 0.05,
    brightness: 0,
    saturation: 0.06,
    vibrance: 0.08,
    gamma: 0,
    temperature: 0,
    tint: 0,
    blackLevel: 0.04,
    highlightRolloff: 0.2,
    bloom: 0,
    grain: 0,
    vignette: 0,
    scaleFactor: 2
  }, o);

  const BUILTIN = [
    {
      id: 'off',
      name: 'Original',
      tag: 'Bypass',
      description: 'No processing. Useful as a reference point.',
      params: P({ enabled: false })
    },
    {
      id: 'balanced',
      name: 'Balanced',
      tag: 'Everyday',
      description: 'Safe all-round lift. A good default for anything.',
      params: P({
        denoise: 0.12, deblock: 0.2, edge: 0.55, sharpen: 0.4,
        deband: 0.3, localContrast: 0.15, contrast: 0.07,
        saturation: 0.08, vibrance: 0.12, blackLevel: 0.05,
        highlightRolloff: 0.25
      })
    },
    {
      id: 'streaming',
      name: 'Streaming Rescue',
      tag: 'Low bitrate',
      description: 'Built for compressed 480p-1080p web video: kills blocking and banding first, then rebuilds detail.',
      params: P({
        denoise: 0.28, deblock: 0.55, edge: 0.7, sharpen: 0.5,
        haloGuard: 0.9, deband: 0.55, localContrast: 0.22,
        contrast: 0.09, saturation: 0.1, vibrance: 0.18,
        blackLevel: 0.06, highlightRolloff: 0.3, grain: 0.06
      })
    },
    {
      id: 'anime',
      name: 'Anime / Animation',
      tag: 'Line art',
      description: 'Keeps line weight through the upscale and flattens gradient banding in skies and cels.',
      params: P({
        denoise: 0.2, deblock: 0.35, edge: 0.85, line: 0.6,
        sharpen: 0.45, haloGuard: 0.95, deband: 0.6,
        localContrast: 0.1, contrast: 0.06, saturation: 0.14,
        vibrance: 0.2, blackLevel: 0.05
      })
    },
    {
      id: 'film',
      name: 'Film / Cinematic',
      tag: 'Grain safe',
      description: 'Leaves grain alone, lifts micro-contrast and holds the highlight roll-off.',
      params: P({
        denoise: 0.04, deblock: 0.1, edge: 0.4, sharpen: 0.28,
        haloGuard: 0.9, deband: 0.25, localContrast: 0.2,
        contrast: 0.1, saturation: 0.04, vibrance: 0.06,
        blackLevel: 0.08, highlightRolloff: 0.4, bloom: 0.08,
        temperature: 0.03
      })
    },
    {
      id: 'sports',
      name: 'Sports / Motion',
      tag: 'Fast pan',
      description: 'Cheap enough to hold 60 fps, weighted toward edge clarity during fast motion.',
      params: P({
        denoise: 0.15, deblock: 0.4, edge: 0.5, sharpen: 0.55,
        haloGuard: 0.75, deband: 0.3, localContrast: 0.25,
        contrast: 0.1, saturation: 0.14, vibrance: 0.16,
        blackLevel: 0.05, highlightRolloff: 0.2
      })
    },
    {
      id: 'lowlight',
      name: 'Low Light',
      tag: 'Dark scenes',
      description: 'Opens up shadows on dark footage without letting the noise floor come with them.',
      params: P({
        denoise: 0.4, deblock: 0.3, edge: 0.45, sharpen: 0.3,
        deband: 0.6, localContrast: 0.28, contrast: 0.04,
        brightness: 0.06, gamma: 0.18, saturation: 0.05,
        vibrance: 0.1, blackLevel: 0.0, highlightRolloff: 0.15
      })
    },
    {
      id: 'screencast',
      name: 'Screencast / Text',
      tag: 'Synthetic',
      description: 'For UI recordings, slides and gameplay HUDs. Maximum edge fidelity, no smoothing.',
      params: P({
        denoise: 0, deblock: 0.15, edge: 0.3, sharpen: 0.7,
        haloGuard: 1.0, deband: 0.15, localContrast: 0.08,
        contrast: 0.04, saturation: 0.02, vibrance: 0,
        blackLevel: 0.02, highlightRolloff: 0.1
      })
    },
    {
      id: 'vivid',
      name: 'Vivid Showcase',
      tag: 'Punchy',
      description: 'Deliberately aggressive - store-demo look. Great for showing someone the difference.',
      params: P({
        denoise: 0.18, deblock: 0.35, edge: 0.75, sharpen: 0.6,
        haloGuard: 0.7, deband: 0.4, localContrast: 0.35,
        contrast: 0.16, saturation: 0.24, vibrance: 0.28,
        blackLevel: 0.1, highlightRolloff: 0.35, bloom: 0.14,
        vignette: 0.12
      })
    }
  ];

  /** Slider definitions drive the whole Adjust panel - add one line, get a control. */
  const CONTROLS = [
    {
      group: 'Restore',
      hint: 'Runs before upscaling, at source resolution.',
      items: [
        { key: 'denoise', label: 'Denoise', min: 0, max: 1, step: 0.01, help: 'Edge-aware noise reduction. Too much erases fine texture.' },
        { key: 'deblock', label: 'Artefact cleanup', min: 0, max: 1, step: 0.01, help: 'Smooths the blocking and mosquito noise that compression leaves in flat areas.' }
      ]
    },
    {
      group: 'Reconstruct',
      hint: 'Runs at output resolution.',
      items: [
        { key: 'edge', label: 'Edge reconstruction', min: 0, max: 1, step: 0.01, help: 'Removes staircase edges by resampling along the edge direction.' },
        { key: 'line', label: 'Line darkening', min: 0, max: 1, step: 0.01, help: 'Keeps thin dark lines from fading out. Mostly for animation.' },
        { key: 'sharpen', label: 'Sharpness', min: 0, max: 1, step: 0.01, help: 'Contrast-adaptive: strongest where the image is soft, weakest where it is already busy.' },
        { key: 'haloGuard', label: 'Halo guard', min: 0, max: 1, step: 0.01, help: 'Clamps sharpening overshoot. Raise it if edges show bright outlines.' }
      ]
    },
    {
      group: 'Finish',
      hint: 'Final grade before the frame hits the screen.',
      items: [
        { key: 'deband', label: 'Debanding', min: 0, max: 1, step: 0.01, help: 'Breaks up the stair-step gradients you see in skies and fades.' },
        { key: 'localContrast', label: 'Local contrast', min: 0, max: 1, step: 0.01, help: 'Adds depth by boosting mid-frequency detail.' },
        { key: 'contrast', label: 'Contrast', min: -0.5, max: 0.5, step: 0.01 },
        { key: 'brightness', label: 'Brightness', min: -0.5, max: 0.5, step: 0.01 },
        { key: 'gamma', label: 'Gamma', min: -0.6, max: 0.6, step: 0.01, help: 'Positive values open the shadows.' },
        { key: 'blackLevel', label: 'Black level', min: 0, max: 0.4, step: 0.01 },
        { key: 'highlightRolloff', label: 'Highlight rolloff', min: 0, max: 1, step: 0.01, help: 'Recovers detail in blown-out highlights.' },
        { key: 'saturation', label: 'Saturation', min: -1, max: 1, step: 0.01 },
        { key: 'vibrance', label: 'Vibrance', min: -1, max: 1, step: 0.01, help: 'Boosts muted colours only, protecting skin tones.' },
        { key: 'temperature', label: 'Temperature', min: -1, max: 1, step: 0.01 },
        { key: 'tint', label: 'Tint', min: -1, max: 1, step: 0.01 },
        { key: 'bloom', label: 'Bloom', min: 0, max: 1, step: 0.01 },
        { key: 'grain', label: 'Film grain', min: 0, max: 1, step: 0.01, help: 'A little grain hides compression and reads as "filmic".' },
        { key: 'vignette', label: 'Vignette', min: 0, max: 1, step: 0.01 }
      ]
    }
  ];

  window.VSPresets = { BUILTIN, CONTROLS, makeParams: P };
})();
