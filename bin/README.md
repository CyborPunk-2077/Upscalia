# bin/

Drop platform binaries here to bundle them with a packaged build.

Visionance looks for `ffmpeg`, `ffprobe` and `yt-dlp` (with `.exe` on Windows)
in this folder **first**, before falling back to the npm packages or the system
PATH. Anything placed here is copied into the installer by electron-builder via
the `extraResources` entry in `package.json`.

Leave the folder empty to ship a smaller installer — the app will then use
`ffmpeg-static` for encoding and offer a one-click yt-dlp download on first run.

Binaries are not tracked in git.
