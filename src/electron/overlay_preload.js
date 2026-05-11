const { contextBridge, ipcRenderer } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const isPackaged = !process.defaultApp;

function resolveAssetUrl(relativePath) {
  const assetBase = isPackaged
    ? path.join(process.resourcesPath, 'app_runtime')
    : path.resolve(__dirname, '..', '..', '..');
  return pathToFileURL(path.join(assetBase, relativePath)).href;
}

contextBridge.exposeInMainWorld('overlayAPI', {
  onTiers:    (cb) => ipcRenderer.on('ocr-tiers',    (_, d) => cb(d)),
  onOcultar:  (cb) => ipcRenderer.on('ocr-ocultar',  () => cb()),
  onEditMode: (cb) => ipcRenderer.on('overlay-edit', () => cb()),
  editDone:   ()   => ipcRenderer.send('overlay-edit-done'),
  onPositions:(cb) => ipcRenderer.on('overlay-positions', (_, p) => cb(p)),
  onPack:     (cb) => ipcRenderer.on('overlay-pack', (_, p) => cb(p)),
  assetUrl:   (relativePath) => resolveAssetUrl(relativePath),
  getHudScale: () => ipcRenderer.invoke('get-hud-scale'),
  onSkillUp: (cb) => {
    ipcRenderer.removeAllListeners('overlay-skill-up');
    ipcRenderer.on('overlay-skill-up', (_, data) => cb(data));
  },
});