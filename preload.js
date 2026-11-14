'use strict'

const { contextBridge, ipcRenderer } = require('electron')

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args)
const listen = (channel) => (callback) => {
  const listener = (_event, payload) => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('api', {
  state: call('state'),
  probe: call('probe'),
  enqueue: call('enqueue'),
  cancel: call('item:cancel'),
  retry: call('item:retry'),
  remove: call('item:remove'),
  open: call('item:open'),
  reveal: call('item:reveal'),
  clearFinished: call('items:clear'),
  exportHistory: call('history:export'),
  importHistory: call('history:import'),
  setSettings: call('settings:set'),
  chooseDirectory: call('settings:choose-directory'),
  openDirectory: call('directory:open'),
  clipboardUrls: call('clipboard:urls'),
  onItems: listen('items'),
  onTools: listen('tools'),
})
