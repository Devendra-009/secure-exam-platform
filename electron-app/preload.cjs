const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('secureExam', {
  setSecure: (enabled) => ipcRenderer.invoke('exam:set-secure', Boolean(enabled)),
  getSecure: () => ipcRenderer.invoke('exam:get-secure'),
  onViolation: (callback) => {
    const handler = (_event, detail) => callback(detail);
    ipcRenderer.on('exam:violation', handler);
    return () => ipcRenderer.removeListener('exam:violation', handler);
  },
  onFullscreenState: (callback) => {
    const handler = (_event, detail) => callback(detail);
    ipcRenderer.on('exam:fullscreen', handler);
    return () => ipcRenderer.removeListener('exam:fullscreen', handler);
  },
});
