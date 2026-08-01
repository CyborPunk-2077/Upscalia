'use strict';

/**
 * The only bridge between the renderer and Node. Everything is an explicit,
 * named method - no raw ipcRenderer, no `require`, no Node globals leak into
 * the page.
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

/** Subscribe helper that returns an unsubscribe function. */
function on(channel, handler) {
  const wrapped = (_event, ...args) => handler(...args);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld('visionance', {
  app: {
    info: () => invoke('app:info'),
    encoders: () => invoke('app:encoders')
  },

  dialog: {
    openVideo: () => invoke('dialog:openVideo'),
    saveVideo: (defaultName) => invoke('dialog:saveVideo', defaultName),
    pickBinary: (which) => invoke('dialog:pickBinary', which)
  },

  media: {
    open: (filePath) => invoke('media:open', filePath),
    resolveUrl: (url, opts) => invoke('media:resolveUrl', url, opts),
    localUrl: (filePath) => invoke('media:localUrl', filePath)
  },

  ytdlp: {
    install: () => invoke('ytdlp:install'),
    onProgress: (cb) => on('ytdlp:progress', cb)
  },

  settings: {
    get: () => invoke('settings:get'),
    patch: (patch) => invoke('settings:patch', patch)
  },

  presets: {
    get: () => invoke('presets:get'),
    save: (preset) => invoke('presets:save', preset),
    remove: (id) => invoke('presets:delete', id)
  },

  recents: {
    get: () => invoke('recents:get'),
    add: (entry) => invoke('recents:add', entry),
    remove: (source) => invoke('recents:remove', source),
    clear: () => invoke('recents:clear')
  },

  resume: {
    get: (key) => invoke('resume:get', key),
    set: (key, seconds) => invoke('resume:set', key, seconds)
  },

  exports: {
    start: (cfg) => invoke('export:start', cfg),
    cancel: (id) => invoke('export:cancel', id),
    list: () => invoke('export:list'),
    clear: () => invoke('export:clear'),
    onUpdate: (cb) => on('export:update', cb)
  },

  system: {
    reveal: (p) => invoke('shell:reveal', p),
    openPath: (p) => invoke('shell:open', p),
    openExternal: (url) => invoke('shell:external', url),
    setFullscreen: (value) => invoke('window:fullscreen', value),
    keepAwake: (enable) => invoke('power:keepAwake', enable)
  },

  events: {
    onMenu: (cb) => on('menu', cb),
    onExternalFile: (cb) => on('open-external-file', cb)
  },

  /**
   * Resolve the on-disk path of a dropped File. `File.path` was removed in
   * newer Electron versions, so go through webUtils when it is available.
   */
  pathForFile: (file) => {
    try {
      if (webUtils && typeof webUtils.getPathForFile === 'function') {
        return webUtils.getPathForFile(file);
      }
    } catch { /* fall through */ }
    return file && file.path ? file.path : null;
  }
});
