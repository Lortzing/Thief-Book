'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('reader', {
  ready: () => ipcRenderer.invoke('reader:ready'),
  next: () => ipcRenderer.invoke('reader:page', { dir: 1 }),
  prev: () => ipcRenderer.invoke('reader:page', { dir: -1 }),
  nextChapter: () => ipcRenderer.invoke('reader:chapter', { dir: 1 }),
  prevChapter: () => ipcRenderer.invoke('reader:chapter', { dir: -1 }),
  openBook: () => ipcRenderer.invoke('reader:open'),
  popupMenu: (x, y) => ipcRenderer.send('reader:menu', { x, y }),
  beginDrag: () => ipcRenderer.send('reader:dragStart'),
  endDrag: () => ipcRenderer.send('reader:dragEnd'),
  onPage: (cb) => ipcRenderer.on('push:page', (_e, page) => cb(page)),
  onVisible: (cb) => ipcRenderer.on('push:visible', (_e, v) => cb(v)),
  onAppearance: (cb) => ipcRenderer.on('push:appearance', (_e, a) => cb(a)),
});
