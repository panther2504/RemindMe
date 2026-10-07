'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('remindme', {
  onUpdate: (callback) => ipcRenderer.on('reminder:update', (_event, payload) => callback(payload)),
  act: (action, minutes) => ipcRenderer.invoke('reminder:act', { action, minutes }),
});
