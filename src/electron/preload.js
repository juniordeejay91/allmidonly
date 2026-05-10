// ============================================================
//  ARAM CAOS — Preload (bridge seguro HTML <-> Electron)
// ============================================================
const { contextBridge, ipcRenderer } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const isPackaged = !process.defaultApp;

function resolveAssetUrl(relativePath) {
  const assetBase = isPackaged
    ? path.join(process.resourcesPath, 'app_runtime')
    : path.resolve(__dirname, '..', '..');
  return pathToFileURL(path.join(assetBase, relativePath)).href;
}

contextBridge.exposeInMainWorld('electronAPI', {
  minimize:    () => ipcRenderer.send('win-minimize'),
  maximize:    () => ipcRenderer.send('win-maximize'),
  bringToFront: () => ipcRenderer.send('win-bring-to-front'),
  close:       () => ipcRenderer.send('win-close'),
  quit:        () => ipcRenderer.send('win-quit'),
  isMaximized: () => ipcRenderer.sendSync('win-is-maximized'),
  writeAmoItemSets: (opts) => ipcRenderer.invoke('write-amo-item-sets', opts),
  onLcuPhase: (cb) => {
    ipcRenderer.removeAllListeners('lcu-phase');
    ipcRenderer.on('lcu-phase', (_, phase) => cb(phase));
  },
  onAppStartupTransition: (cb) => {
    ipcRenderer.removeAllListeners('app-startup-transition');
    ipcRenderer.on('app-startup-transition', () => cb());
  },
  lcuChampSelect:          () => ipcRenderer.invoke('lcu-champ-select'),
  lcuChampSelectMySel:     () => ipcRenderer.invoke('lcu-champ-select-my-selection'),
  lcuImportItemSet: (opts) => ipcRenderer.invoke('lcu-import-item-set', opts),

  onMaximizeChange: (cb) => {
    ipcRenderer.on('win-maximized',   () => cb(true));
    ipcRenderer.on('win-unmaximized', () => cb(false));
  },

  lcuGetCurrentAccount: () => ipcRenderer.invoke('lcu-get-current-account'),
  lcuGetAramMatches:    (opts) => ipcRenderer.invoke('lcu-get-aram-matches', opts),
  lcuIsOpen:            () => ipcRenderer.invoke('lcu-is-open'),
  lcuDiagnose:          () => ipcRenderer.invoke('lcu-diagnose'),
  lcuGetMatchDetail:    (opts) => ipcRenderer.invoke('lcu-get-match-detail', opts),
  lcuImportBuild:       (opts) => ipcRenderer.invoke('lcu-import-build', opts),
  invoke:               (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  ocrSetCampeon:        (nombre) => ipcRenderer.invoke('ocr-set-campeon', nombre),
  getAugments:          () => ipcRenderer.invoke('get-augments'),
  getAugmentSets:       () => ipcRenderer.invoke('get-augment-sets'),
  getAugmentStats:      () => ipcRenderer.invoke('get-augment-stats'),
  getAugmentSetStats:   () => ipcRenderer.invoke('get-augment-set-stats'),
  getItemsDynamic:      () => ipcRenderer.invoke('get-items-dynamic'),
  closeLoading:         () => ipcRenderer.invoke('close-loading-btn'),
  onUpdateAvailable: (cb) => ipcRenderer.on('update-available',  (_, v) => cb(v)),
  onUpdateProgress:  (cb) => ipcRenderer.on('update-progress',   (_, p) => cb(p)),
  onUpdateDownloaded:(cb) => ipcRenderer.on('update-downloaded',  ()    => cb()),
  onUpdateInstalling:(cb) => ipcRenderer.on('update-installing',  ()    => cb()),
  downloadUpdate:    ()   => ipcRenderer.invoke('download-update'),
  getVersion: () => ipcRenderer.invoke('get-version'),
  assetUrl: (relativePath) => resolveAssetUrl(relativePath),
  isPackaged: () => isPackaged,

  // Supabase / Google Auth
  supabaseGoogleLogin:  () => ipcRenderer.invoke('supabase-google-login'),
  supabaseGetSession:   () => ipcRenderer.invoke('supabase-get-session'),
  supabaseLogout:       () => ipcRenderer.invoke('supabase-logout'),
  supabaseSyncAccounts: (opts) => ipcRenderer.invoke('supabase-sync-accounts', opts),
  supabaseSyncHistory:  (opts) => ipcRenderer.invoke('supabase-sync-history', opts),
  onSupabaseAuthCallback: (cb) => {
    ipcRenderer.removeAllListeners('supabase-auth-callback');
    ipcRenderer.on('supabase-auth-callback', (_, data) => cb(data));
  },
  supabaseGetProfile:    (args) => ipcRenderer.invoke('supabase-get-profile', args),
  supabaseUpsertProfile: (args) => ipcRenderer.invoke('supabase-upsert-profile', args),
  perfilCdGet: (key) => ipcRenderer.invoke('perfil-cd-get', key),
  perfilCdSet: (key) => ipcRenderer.invoke('perfil-cd-set', key),

  lcuGetLiveGame: (opts) => ipcRenderer.invoke('lcu-get-live-game', opts),
});
