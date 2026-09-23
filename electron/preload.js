// Preload (sandboxed). Exposes a tiny, explicit bridge to the renderer with
// contextIsolation on. File I/O is delegated to the main process over IPC, so
// the preload needs no Node modules (it stays sandboxed and secure).
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // main -> renderer: a file path to open (Finder "Open With" / argv / menu)
  onOpenPath: (cb) => ipcRenderer.on('open-path', (_e, p) => cb(p)),
  // main -> renderer: menu actions (open file/folder)
  onMenuAction: (cb) => ipcRenderer.on('menu', (_e, a) => cb(a)),
  // main -> renderer: the tabs this window held when the app last ran
  onRestoreSession: (cb) => ipcRenderer.on('restore-session', (_e, s) => cb(s)),
  // renderer -> main: the tabs currently open in this window (session.json)
  sessionChanged: (s) => ipcRenderer.send('session-changed', s),
  // renderer -> main: signal the app is wired and ready to receive a path
  ready: () => ipcRenderer.send('renderer-ready'),
  // native file I/O (performed in main) for the open-with autosave path
  readFile: (p) => ipcRenderer.invoke('read-file', p),
  writeFile: (p, data) => ipcRenderer.invoke('write-file', p, data),
  getFilePath: (file) => webUtils.getPathForFile(file),
  openLink: (href, documentPath) => ipcRenderer.invoke('open-link', href, documentPath),
  // export the current page to a PDF file (save dialog handled in main)
  exportPDF: (suggestedName) => ipcRenderer.invoke('export-pdf', suggestedName),
  // renderer -> main: open a file in a brand-new window (tab tear-off)
  openInNewWindow: (p) => ipcRenderer.send('open-in-new-window', p),
});
