# Visionance

**Real-time GPU video enhancement.** Play a local file or paste a link, and
Visionance upscales, cleans and grades every frame on your GPU as it plays —
no download, no re-encode, no waiting.

The problem it solves: a 1080p stream and a 4K file often look far more similar
than the 20 GB size difference suggests, because most of what you notice is
compression damage, not missing resolution. Visionance repairs the damage and
reconstructs edges live, so you get most of the "premium" look from the file you
already have.

---

## What it actually does

Every frame runs through four shader stages before it reaches the screen:

| Stage | Runs at | What it fixes |
|---|---|---|
| **Restore** | source resolution | Edge-aware denoise and compression-artefact cleanup. Runs *before* scaling so noise is never magnified. |
| **Reconstruct** | output resolution | Catmull-Rom resampling plus edge-directed correction, which removes staircase edges instead of blurring them. Optional line darkening keeps animation line art from fading out. |
| **Sharpen** | output resolution | AMD-style contrast-adaptive sharpening: strong where the picture is soft, restrained where it is already detailed, with halo suppression. |
| **Finish** | output resolution | Debanding, local contrast, filmic tone curve, colour, bloom, grain, vignette. |

Nothing is written to disk during playback. Rendering happens in a WebGL2
context using half-float intermediates where the GPU supports them.

### Presets

Nine built-ins, each tuned for a specific failure mode rather than a vague
"quality" dial:

`Original` · `Balanced` · `Streaming Rescue` · `Anime / Animation` ·
`Film / Cinematic` · `Sports / Motion` · `Low Light` · `Screencast / Text` ·
`Vivid Showcase`

Every parameter is exposed in the **Adjust** tab, and any combination can be
saved as your own preset.

### Other things worth knowing

- **Split compare** — drag a divider across the frame to see original versus
  enhanced on the same moving picture.
- **Adaptive quality** — if the GPU can't hold the frame budget, the render
  resolution drops instead of the playback stuttering. It never goes below the
  source resolution, because that would destroy real detail.
- **Auto render resolution** — renders exactly enough pixels to saturate your
  display, capped at 4×. No point computing 8K for a 1080p panel.
- **Export** — when you genuinely need a file, the same look is rendered to disk
  with ffmpeg, using hardware encoders (NVENC / Quick Sync / AMF /
  VideoToolbox) when they're available.
- **Resume, recents, snapshots, picture-in-picture** — the picture-in-picture
  window shows the *enhanced* frame, not the raw video.

---

## Install

```bash
npm install
npm start
```

Requires Node.js 22.12 or newer (Electron 43's minimum) and a GPU with WebGL2.
No Docker, database or separate backend is involved.

### External tools

| Tool | Needed for | How it's found |
|---|---|---|
| **ffmpeg / ffprobe** | Export, media probing | Bundled via `ffmpeg-static`; a system install or a manual path set in Settings also works |
| **yt-dlp** | Playing online links | Not bundled. Settings -> *Install* downloads the latest build into your user data folder |

Both can be overridden from **Settings** if you keep your own builds.

### Dependency install scripts

npm v12 blocks dependency install scripts by default. This project approves
exactly one, in the `allowScripts` field of `package.json`:

- `ffmpeg-static` — **approved**. It is a direct dependency and its install
  script downloads the ffmpeg binary the Export tab needs.
- `electron-winstaller` — **denied**. It arrives transitively with
  electron-builder and is only used by the Squirrel.Windows target, which this
  project does not build (it builds NSIS and portable).

Electron needs no approval: since v43 it has no install script and fetches its
runtime on first use instead.

---

## Building installers

```bash
npm run dist:win     # NSIS installer + portable exe
npm run dist:mac     # dmg
npm run dist:linux   # AppImage + deb
```

To ship ffmpeg and yt-dlp inside the installer, drop the binaries into `bin/`
before building — see `bin/README.md`.

---

## Keyboard

| Key | Action |
|---|---|
| `Space` / `K` | Play / pause |
| `←` `→` | ±5 s (hold `Shift` for ±60 s) |
| `J` / `L` | ±10 s |
| `↑` `↓` | Volume |
| `0`–`9` | Jump to 0–90% |
| `M` | Mute |
| `F` | Fullscreen |
| `C` | Split compare |
| `B` | Toggle enhancement |
| `S` | Save the current enhanced frame as PNG |

---

## Architecture

```
src/
  main/
    main.js        Window, menus, the vs:// protocol, IPC surface
    preload.js     The only renderer<->Node bridge (context-isolated)
    binaries.js    Locates/downloads ffmpeg, ffprobe, yt-dlp
    ytdlp.js       Resolves page URLs into playable stream URLs
    exporter.js    ffmpeg job queue with progress and cancellation
    store.js       Atomic JSON store for settings, presets, recents
  renderer/
    index.html     UI shell
    styles.css     Theme
    js/shaders.js  GLSL ES 3.00 sources for all four passes
    js/engine.js   WebGL2 context, framebuffers, frame loop, adaptive quality
    js/presets.js  Built-in presets and the slider definitions
    js/app.js      UI wiring
tools/             Verification harnesses (dev only, not shipped)
```

### Security posture

- `contextIsolation: true`, `nodeIntegration: false`; the renderer sees exactly
  the methods listed in `preload.js` and nothing else.
- A Content-Security-Policy restricts the page to its own origin.
- Renderer assets *and* media are served over one custom `vs://app` scheme.
  Same-origin media matters: a cross-origin `<video>` would taint the WebGL
  canvas and make reading enhanced frames impossible.
- Remote streams are proxied through the main process, which is also how
  yt-dlp's required request headers get applied.
- External links open in the system browser; the window itself can't navigate
  away from the app.

---

## Verification

Three harnesses, all runnable without a GUI:

```bash
npm run verify:gl        # compiles every shader in a real GL context,
                         # renders each preset, checks for GL errors
npm run verify:export    # runs real ffmpeg renders, checks output resolution,
                         # audio handling, progress and cancellation
npm run verify:app       # boots the app and asserts the IPC bridge, engine
                         # and UI all came up

# add a real playback pass to the boot test
VISIONANCE_TEST_VIDEO=/path/to/clip.mp4 npm run verify:app
```

On a headless Linux box, prefix with `xvfb-run -a`.

---

## Notes on online video

Visionance resolves stream URLs with yt-dlp and plays them directly; it does not
download or store copies. You are responsible for only using it with content you
are entitled to access, and for complying with the terms of service of the sites
you point it at. yt-dlp is not bundled — the app downloads it on request.

---

## Licence

MIT. Bundled and downloaded third-party tools carry their own licences:
ffmpeg (LGPL/GPL depending on build), yt-dlp (Unlicense), Electron (MIT).
The contrast-adaptive sharpening pass follows the algorithm published by AMD as
part of FidelityFX CAS (MIT).
