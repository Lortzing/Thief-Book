'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settings', {
  getState: () => ipcRenderer.invoke('settings:get'),
  set: (key, value) => ipcRenderer.invoke('settings:set', { key, value }),
  setKeys: (keys) => ipcRenderer.invoke('settings:setKeys', keys),
  openBook: (path) => ipcRenderer.invoke('settings:openBook', { path }),
  forgetBook: (path) => ipcRenderer.invoke('settings:forgetBook', { path }),
  jump: (percent) => ipcRenderer.invoke('settings:jump', { percent }),
  pickBook: () => ipcRenderer.invoke('settings:pickBook'),
  probeKey: (accel) => ipcRenderer.invoke('settings:probeKey', { accel }),
  onBooks: (cb) => ipcRenderer.on('push:books', (_e, books) => cb(books)),
});
