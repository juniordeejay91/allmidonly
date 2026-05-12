// ── Aceleración por hardware ──────────────────────────────────
const { app: _appCheck } = require('electron');
const _fs = require('fs');
const _path = require('path');
const _USER_DATA_BASENAME = _appCheck.isPackaged ? 'allmidonly' : 'amo';
const _USER_DATA_DIR = _path.join(_appCheck.getPath('appData'), _USER_DATA_BASENAME);
_appCheck.setPath('userData', _USER_DATA_DIR);
const { supabase } = require('./supabase.js');
const _ROOT_DIR = _path.resolve(__dirname, '..', '..');
const _APP_CACHE_DIR = _path.join(_USER_DATA_DIR, 'cache');
const _APP_SETTINGS_FILE = _path.join(_APP_CACHE_DIR, 'settings.json');

try {
  const _settingsPath = [_APP_SETTINGS_FILE, _path.join(_ROOT_DIR, 'cache', 'settings.json')]
    .find(p => _fs.existsSync(p));
  if (_settingsPath) {
    const _settings = JSON.parse(_fs.readFileSync(_settingsPath, 'utf-8'));
    if (_settings.hwaccel === false) {
      require('electron').app.disableHardwareAcceleration();
    }
  }
} catch(e) {}

// ============================================================
//  ARAM CAOS — Proceso principal Electron
// ============================================================
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage } = require('electron');
const { autoUpdater } = require('electron-updater');
const path   = require('path');
const fs     = require('fs');  // ← añadir esta línea
const { spawn, execFile, exec, spawnSync } = require('child_process');
const https  = require('https');
const os     = require('os');
const { pathToFileURL } = require('url');

let win           = null;
let loadingStartTime = Date.now();
let tray          = null;
let pyProc        = null;
let ocrProc       = null;
let overlayWin    = null;
let lastQueueId    = 0;
let initialHudScale = 50;
let lastChampionId = null;
let pythonLaunchConfig = null;
let skillPollTimer = null;
let currentSkillOrder = null;

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const RUNTIME_ROOT_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'app_runtime')
  : ROOT_DIR;
const RENDERER_DIR = path.join(ROOT_DIR, 'src', 'renderer');
const PYTHON_DIR = path.join(RUNTIME_ROOT_DIR, 'scripts', 'python');
const PYTHON_IMG_DIR = path.join(RUNTIME_ROOT_DIR, 'img');
const ROOT_CACHE_DIR = path.join(ROOT_DIR, 'cache');
const USER_DATA_DIR = app.getPath('userData');
const APP_CACHE_DIR = path.join(USER_DATA_DIR, 'cache');
const APP_HISTORY_DIR = path.join(USER_DATA_DIR, 'historial');
const APP_SETTINGS_FILE = path.join(APP_CACHE_DIR, 'settings.json');
const APP_TIER_PACK_FILE = path.join(APP_CACHE_DIR, 'tier_pack.json');
const APP_PERFIL_CD_FILE = path.join(APP_CACHE_DIR, 'perfil_cd.json');
const BASE = RUNTIME_ROOT_DIR;
const OVERLAY_POSITIONS_FILE = path.join(APP_CACHE_DIR, 'overlay_positions.json');
const IS_DEV = !app.isPackaged;
const APP_PACKAGE = readJsonFile(path.join(ROOT_DIR, 'package.json'), {});
const ENABLE_DEVTOOLS = IS_DEV || APP_PACKAGE.amoEnableDevtools === true;

console.log(`[VERSION] App iniciada en modo ${ENABLE_DEVTOOLS ? 'debug' : 'release'}`);

for (const dir of [APP_CACHE_DIR, APP_HISTORY_DIR]) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
}

function readJsonFile(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

// ── Instancia única — evita doble arranque ───────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
} else {
  app.on('second-instance', async (event, commandLine) => {
    // Traer la ventana al frente
    if (win) { win.show(); win.focus(); }

    // Manejar callback de OAuth de Google
    const url = commandLine.find(arg => arg.startsWith('allmidonly://'));
    if (url) {
      const hashPart = url.split('#')[1] || '';
      const params = new URLSearchParams(hashPart);
      const accessToken  = params.get('access_token');
      const refreshToken = params.get('refresh_token');
      if (accessToken) {
        const { data, error } = await supabase.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken
        });
        if (!error && win) {
          win.webContents.send('supabase-auth-callback', {
            session: data.session
          });
        }
      }
    }
  });
}

process.on('uncaughtException', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log('[Auth] puerto ya en uso, instancia secundaria bloqueada correctamente');
    return;
  }
  console.error('[uncaughtException]', err);
});

// ══════════════════════════════════════════════════════════════
//  LCU: detectar puerto y token del cliente de League
//  Prueba tres métodos en orden hasta que uno funcione
// ══════════════════════════════════════════════════════════════
let _lcuCredsCache = null;
let _lcuCredsCacheTs = 0;

function getLcuCredentials() {
  const now = Date.now();
  if (_lcuCredsCache && (now - _lcuCredsCacheTs) < 30000) {
    return Promise.resolve(_lcuCredsCache);
  }
  return new Promise((resolve) => {

    // Método 1: wmic (Windows 10/11 clásico)
    execFile('wmic', [
      'PROCESS', 'WHERE', "name='LeagueClient.exe'",
      'GET', 'CommandLine', '/FORMAT:LIST'
    ], { timeout: 6000 }, (err, stdout) => {
      if (!err && stdout) {
        const creds = parseLeagueArgs(stdout);
        if (creds) { console.log('[LCU] detectado via wmic'); _lcuCredsCache = creds; _lcuCredsCacheTs = Date.now(); return resolve(creds); }
      }

      // Método 2: PowerShell LeagueClient.exe
      exec(
        `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"name='LeagueClient.exe'\\" | Select-Object -ExpandProperty CommandLine"`,
        { timeout: 8000 },
        (err2, stdout2) => {
          if (!err2 && stdout2) {
            const creds2 = parseLeagueArgs(stdout2);
            if (creds2) { console.log('[LCU] detectado via PowerShell'); _lcuCredsCache = creds2; _lcuCredsCacheTs = Date.now(); return resolve(creds2); }
          }

          // Método 3: PowerShell LeagueClientUx.exe
          exec(
            `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"name='LeagueClientUx.exe'\\" | Where-Object {$_.CommandLine -like '*--app-port=*'} | Select-Object -ExpandProperty CommandLine"`,
            { timeout: 8000 },
            (err3, stdout3) => {
              if (!err3 && stdout3) {
                const creds3 = parseLeagueArgs(stdout3);
                if (creds3) { console.log('[LCU] detectado via LeagueClientUx'); _lcuCredsCache = creds3; _lcuCredsCacheTs = Date.now(); return resolve(creds3); }
              }
              console.log('[LCU] cliente no encontrado');
              resolve(null);
            }
          );
        }
      );
    });
  });
}

function parseLeagueArgs(stdout) {
  const portMatch  = stdout.match(/--app-port=(\d+)/);
  const tokenMatch = stdout.match(/--remoting-auth-token=([\w-]+)/);
  if (!portMatch || !tokenMatch) return null;
  return { port: portMatch[1], token: tokenMatch[1] };
}

const CHAOS_QUEUE_IDS = new Set([900, 2400, 3270]);
const MAP_NAMES = {
  12: 'Abismo de los Lamentos',
  14: 'Puente del Carnicero',
};

function isChaosGame(game = {}) {
  return CHAOS_QUEUE_IDS.has(game.queueId);
}

function getMapVariantInfo(game = {}) {
  const mapId = game.mapId || 0;
  const mutators = Array.isArray(game.gameModeMutators)
    ? game.gameModeMutators.filter(Boolean)
    : [];

  if (mutators.includes('mapskin_ha_bilgewater')) {
    return { key: 'mapskin_ha_bilgewater', name: 'Puente del Carnicero', mutators };
  }
  if (mutators.includes('mapskin_map12_bloom')) {
    return { key: 'mapskin_map12_bloom', name: 'Paso de Koeshin', mutators };
  }
  if (mapId === 12) {
    return {
      key: 'default',
      name: 'Abismo de los Lamentos',
      mutators,
    };
  }

  return {
    key: mapId ? `map_${mapId}` : 'unknown',
    name: MAP_NAMES[mapId] || 'Mapa desconocido',
    mutators,
  };
}

// Petición HTTPS al LCU (certificado autofirmado)
function lcuRequest(port, token, endpoint) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`riot:${token}`).toString('base64');
    const req  = https.request({
      hostname: '127.0.0.1',
      port,
      path: endpoint,
      method: 'GET',
      rejectUnauthorized: false,
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(null); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// Reintentos automáticos para cuando el LCU tarda en responder la primera vez
async function lcuRequestWithRetry(port, token, endpoint, maxRetries = 3, delayMs = 1500) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await lcuRequest(port, token, endpoint);
    } catch (err) {
      const isTimeout = err.message === 'timeout' || err.code === 'ECONNRESET';
      if (isTimeout && attempt < maxRetries) {
        console.log(`[LCU] Intento ${attempt}/${maxRetries} fallido (${err.message}), reintentando en ${delayMs}ms...`);
        await new Promise(r => setTimeout(r, delayMs));
      } else {
        throw err;
      }
    }
  }
}

function lcuPost(port, token, endpoint, body) {
  return new Promise((resolve, reject) => {
    const auth    = Buffer.from(`riot:${token}`).toString('base64');
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: '127.0.0.1',
      port,
      path: endpoint,
      method: 'PUT',
      rejectUnauthorized: false,
      headers: {
        Authorization:  `Basic ${auth}`,
        Accept:         'application/json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

function liveClientRequest(endpoint) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: '127.0.0.1',
      port: 2999,
      path: endpoint,
      method: 'GET',
      rejectUnauthorized: false,
      headers: { Accept: 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          return resolve(null);
        }
        try { resolve(JSON.parse(data)); }
        catch { resolve(null); }
      });
    });
    req.on('error', reject);
    req.setTimeout(2500, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

function lcuPatch(port, token, endpoint, body) {
  return new Promise((resolve, reject) => {
    const auth    = Buffer.from(`riot:${token}`).toString('base64');
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: '127.0.0.1',
      port,
      path: endpoint,
      method: 'PATCH',
      rejectUnauthorized: false,
      headers: {
        Authorization:  `Basic ${auth}`,
        Accept:         'application/json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

function lcuDelete(port, token, endpoint) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`riot:${token}`).toString('base64');
    const req = https.request({
      hostname: '127.0.0.1',
      port,
      path: endpoint,
      method: 'DELETE',
      rejectUnauthorized: false,
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json',
        'Content-Length': 0,
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

async function lcuGetFirstAvailable(port, token, endpoints) {
  for (const endpoint of endpoints) {
    try {
      const data = await lcuRequest(port, token, endpoint);
      if (data !== null && data !== undefined && !data?.httpStatus) {
        return { endpoint, data };
      }
    } catch {}
  }
  return null;
}

// ── IPC: LCU ─────────────────────────────────────────────────

ipcMain.handle('lcu-get-current-account', async () => {
  try {
    const creds = await getLcuCredentials();
    if (!creds) return { error: 'client_closed' };

    const summoner = await lcuRequestWithRetry(creds.port, creds.token, '/lol-summoner/v1/current-summoner');
    if (!summoner || summoner.errorCode) {
      console.log('[LCU] summoner response:', JSON.stringify(summoner));
      return { error: 'no_summoner' };
    }

    let gameName = summoner.gameName || summoner.displayName || summoner.internalName || '';
    let tagLine  = summoner.tagLine  || 'EUW';

    // Fallback: /lol-login/v1/session para el gameName#tag
    if (!summoner.gameName) {
      try {
        const session = await lcuRequest(creds.port, creds.token, '/lol-login/v1/session');
        if (session && session.username) {
          const parts = session.username.split('#');
          if (!gameName) gameName = parts[0];
          if (tagLine === 'EUW' && parts[1]) tagLine = parts[1];
        }
      } catch(e) { /* ignorar */ }
    }

    console.log(`[LCU] cuenta: ${gameName}#${tagLine} nivel ${summoner.summonerLevel}`);

    // Guardar WindowMode original la primera vez que conecta cuenta
    saveOriginalWindowModeIfNeeded();

    return {
      puuid:      summoner.puuid,
      summonerId: summoner.summonerId || null,
      name:       gameName,
      tag:        tagLine,
      level:      summoner.summonerLevel,
      iconId:     summoner.profileIconId,
    };
  } catch (e) {
    console.error('[LCU] error:', e.message);
    return { error: e.message };
  }
});

ipcMain.handle('lcu-get-aram-matches', async (_, { puuid, count = 99 }) => {
  console.log('[LCU-ARAM] puuid recibido:', puuid);
  try {
    const creds = await getLcuCredentials();
    if (!creds) return { error: 'client_closed' };

    const data = await lcuRequestWithRetry(
      creds.port, creds.token,
      `/lol-match-history/v1/products/lol/${puuid}/matches?begIndex=0&endIndex=${Math.min(count, 99)}`
    );
    console.log('[LCU-ARAM] data recibida:', JSON.stringify(data)?.slice(0, 300));
    
    if (!data || data.errorCode) return { error: 'no_history' };

    const allGames = data.games?.games || [];

    // Filtrar todas las partidas matchmade excepto personalizadas/práctica/tutorial
    const EXCLUDED_QUEUES = new Set([0, 3100, 3120]);
    const aramGames = allGames.filter(g => {
      const gameType = String(g.gameType || '').toUpperCase();
      if (gameType === 'CUSTOM_GAME' || gameType === 'PRACTICE_GAME' || gameType === 'TUTORIAL_GAME') return false;
      if (EXCLUDED_QUEUES.has(g.queueId)) return false;
      if (g.queueId === 0) return false;
      return true;
    });

    // Log para diagnóstico de queueIds presentes
    const queueIds = [...new Set(allGames.map(g => g.queueId))];
    console.log('[LCU] queueIds en historial:', queueIds);
    
    // ← AÑADE ESTO:
    console.log(`[LCU] Total partidas brutas del LCU: ${allGames.length}`);
    allGames.slice(0, 20).forEach((g, i) => {
      const ts = g.gameCreationDate
        ? new Date(g.gameCreationDate).toLocaleString('es-ES')
        : (g.gameCreation ? new Date(g.gameCreation).toLocaleString('es-ES') : '?');
      console.log(`  [${i+1}] queueId=${g.queueId} mapId=${g.mapId} gameMode=${g.gameMode} fecha=${ts}`);
    });
    console.log(`[LCU] Partidas tras filtro ARAM: ${aramGames.length}`);

    const games = aramGames.slice(0, count).map((g, idx) => {
      // Buscar al jugador por puuid, fallback al primero
      const me    = (g.participants || []).find(p => p.puuid === puuid) || g.participants?.[0];
      const stats = me?.stats || {};
      const allChampIds = (g.participants || [])
        .map(p => p?.championId || p?.champion?.id || p?.champion?.championId || null)
        .filter(Boolean);

      const dur   = Math.round((g.gameDuration || 0) / 60);
      const ts    = g.gameCreationDate
        ? new Date(g.gameCreationDate).getTime()
        : (g.gameCreation || 0);

      // ID numérico del campeón — la LCU SIEMPRE lo tiene aunque no tenga nombre texto
      const champId = me?.championId || me?.champion?.id || me?.champion?.championId || null;

      // Nombre del campeón — a veces la LCU no lo devuelve, el frontend lo resolverá por ID
      const champName = me?.championName
        || me?.champion?.name
        || me?.champion?.alias
        || me?.skinName
        || (champId ? `Campeón ${champId}` : '?');

      // Log diagnóstico en la primera partida procesada
      if (idx === 0) {
        console.log('[LCU-DIAG] me keys:', Object.keys(me || {}));
        console.log('[LCU-DIAG] champion:', JSON.stringify(me?.champion));
        console.log('[LCU-DIAG] championId:', me?.championId, '| championName:', me?.championName);
        console.log('[LCU-DIAG] spell1Id:', me?.spell1Id, me?.spell1 , '| stats.spell1Id:', stats.spell1Id);
        console.log('[LCU-DIAG] mapId:', g.mapId, '| queueId:', g.queueId, '| gameMode:', g.gameMode);
      }

      // Summoner spells — pueden estar en me directamente o en stats
      const spell1Id = me?.spell1Id ?? me?.spell1 ?? stats.spell1Id ?? null;
      const spell2Id = me?.spell2Id ?? me?.spell2 ?? stats.spell2Id ?? null;

      // Nivel del jugador al final de la partida
      const playerLevel = stats.champLevel ?? stats.level ?? me?.championLevel ?? null;

      // Ítems (slots 0-6, slot 6 es trinket)
      const items = [
        stats.item0, stats.item1, stats.item2,
        stats.item3, stats.item4, stats.item5, stats.item6,
      ].filter(i => i !== undefined);

      // Mapa: la variante real viene en gameModeMutators.
      const mapId   = g.mapId || 12;
      const queueId = g.queueId || 0;
      const chaosGame = isChaosGame(g);
      const mapInfo = getMapVariantInfo(g);
      const mapName = mapInfo.name;

      // Fecha formateada
      const dateObj = ts ? new Date(ts) : null;
      const fecha   = dateObj
        ? `${dateObj.toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit'})} · ${dateObj.toLocaleDateString('es-ES',{day:'2-digit',month:'2-digit',year:'numeric'})}`
        : '';

      return {
        c:             champName,
        _champId:      champId,      // ID numérico para imagen DDragon
        r:             stats.win ? 'Victoria' : 'Derrota',
        k:             `${stats.kills ?? 0}/${stats.deaths ?? 0}/${stats.assists ?? 0}`,
        d:             `${dur}m`,
        a:             timeAgoMs(ts),
        _ts:           ts,
        _gameId:       g.gameId || null,
        _items:        items,
        _cs:           (stats.totalMinionsKilled || 0) + (stats.neutralMinionsKilled || 0),
        _dmg:          stats.totalDamageDealtToChampions || 0,
        _taken:        stats.totalDamageTaken || 0,
        _gold:         stats.goldEarned || 0,
        _turrets:      stats.turretKills || stats.turretTakedowns || 0,
        _triple:       stats.tripleKills || 0,
        _quadra:       stats.quadraKills || 0,
        _penta:        stats.pentaKills || 0,
        _mapa:         mapName,
        _mapKey:       mapInfo.key,
        _fecha:        fecha,
        _modo:         chaosGame ? 'ARAM: Caos' :
                       queueId === 450 ? 'ARAM' :
                       queueId === 420 ? 'Clasificatoria Solo/Dúo' :
                       queueId === 440 ? 'Clasificatoria Flex' :
                       queueId === 400 || queueId === 430 ? 'Normal 5v5' :
                       queueId === 480 ? 'Swiftplay' :
                       queueId === 490 ? 'Quickplay' :
                       queueId === 900 ? 'ARURF' :
                       queueId === 1900 ? 'URF' :
                       queueId === 1700 || queueId === 1710 ? 'Arena' :
                       queueId === 700 ? 'Clash' :
                       queueId === 720 ? 'Clash ARAM' :
                       queueId === 1020 ? 'One for All' :
                       queueId === 1300 ? 'Nexus Blitz' :
                       queueId === 1400 ? 'Ultimate Spellbook' :
                       queueId === 2300 ? 'Brawl' :
                       `Modo ${queueId}`,
        _spell1:       spell1Id,
        _spell2:       spell2Id,
        _level:        playerLevel,
        _queueId:      queueId,
        _gameType:     g.gameType || '',
        _mapId:        mapId,
        _gameMode:     g.gameMode || '',
        _gameModeMutators: mapInfo.mutators,
        _allChampIds:  allChampIds,
        _augments:     [
          stats.playerAugment1 || 0, stats.playerAugment2 || 0,
          stats.playerAugment3 || 0, stats.playerAugment4 || 0,
          stats.playerAugment5 || 0, stats.playerAugment6 || 0,
        ].filter(x => x > 0),
      };
    });

    console.log(`[LCU] ${allGames.length} partidas totales, ${aramGames.length} ARAM`);
    console.log('[LCU-ARAM] games a devolver:', games.length);
    return { games };
  } catch (e) {
    console.error('[LCU-ARAM] ERROR en handler:', e.message, e.stack)
    return { error: e.message };
  }
});



ipcMain.handle('lcu-import-build', async (_, { runes, items, spells, pageName }) => {
  try {
    const creds = await getLcuCredentials();
    if (!creds) return { error: 'client_closed' };

    const results = {};

    // 1. Importar runas si vienen
    if (runes) {
      const pages = await lcuRequestWithRetry(creds.port, creds.token, '/lol-perks/v1/pages');
      const amoPages = Array.isArray(pages)
        ? pages.filter(p => /^AMO:\s/i.test(String(p?.name || '')))
        : [];
      const safePageName = String(pageName || 'AMO: RUNAS').trim();

      const runesPayload = {
        name:            safePageName,
        primaryStyleId:  runes.primaryTree,
        subStyleId:      runes.secondaryTree,
        selectedPerkIds: runes.ids,
        current:         true,
      };

      for (const page of amoPages) {
        if (!page?.id) continue;
        try {
          await lcuDelete(creds.port, creds.token, `/lol-perks/v1/pages/${page.id}`);
        } catch (err) {
          console.warn('[LCU-Import] no pude borrar página AMO anterior:', page?.name, err.message);
        }
      }

      const auth    = Buffer.from(`riot:${creds.token}`).toString('base64');
      const payload = JSON.stringify(runesPayload);
      results.runes = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: '127.0.0.1', port: creds.port,
          path: '/lol-perks/v1/pages', method: 'POST',
          rejectUnauthorized: false,
          headers: { Authorization: `Basic ${auth}`, Accept: 'application/json', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        }, (res) => {
          let d = ''; res.on('data', c => d += c);
          res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch { resolve({ status: res.statusCode }); } });
        });
        req.on('error', reject);
        req.write(payload); req.end();
      });
    }
    // 2. Importar hechizos si vienen
    if (spells && spells.spell1Id && spells.spell2Id) {
      const spellPayload = { spell1Id: spells.spell1Id, spell2Id: spells.spell2Id };
      const spellAttempts = [
        () => lcuPatch(creds.port, creds.token, '/lol-lobby-team-builder/champ-select/v1/session/my-selection', spellPayload),
        () => lcuPatch(creds.port, creds.token, '/lol-champ-select/v1/session/my-selection', spellPayload),
      ];
      for (const attempt of spellAttempts) {
        results.spells = await attempt();
        if (results.spells?.status >= 200 && results.spells.status < 300) break;
      }
      console.log('[LCU-Import] Hechizos:', JSON.stringify(results.spells));
    }
    console.log('[LCU-Import] Resultado:', JSON.stringify(results));
    return { ok: true, results };
  } catch(e) {
    console.error('[LCU-Import] Error:', e.message);
    return { error: e.message };
  }
});

ipcMain.handle('lcu-import-item-set', async (_, { summonerId, champName, sets }) => {
  try {
    const creds = await getLcuCredentials();
    if (!creds) return { error: 'client_closed' };

    const itemSets = sets.map((s, i) => ({
      associatedChampions: [],
      associatedMaps: [12],
      blocks: [
        s.start?.filter(Boolean).length ? {
          hideIfSummonerSpell: '', showIfSummonerSpell: '',
          type: 'Ítems iniciales',
          items: s.start.filter(Boolean).map(id => ({ count: 1, id: String(id) })),
        } : null,
        s.core?.filter(Boolean).length ? {
          hideIfSummonerSpell: '', showIfSummonerSpell: '',
          type: 'Ítems esenciales',
          items: s.core.filter(Boolean).map(id => ({ count: 1, id: String(id) })),
        } : null,
        s.full?.filter(Boolean).length ? {
          hideIfSummonerSpell: '', showIfSummonerSpell: '',
          type: 'Build final',
          items: s.full.filter(Boolean).map(id => ({ count: 1, id: String(id) })),
        } : null,
        s.situational?.filter(Boolean).length ? {
          hideIfSummonerSpell: '', showIfSummonerSpell: '',
          type: 'Situacionales',
          items: s.situational.filter(Boolean).map(id => ({ count: 1, id: String(id) })),
        } : null,
      ].filter(Boolean),
      map: 'any', mode: 'any',
      preferredItemSlots: [],
      sortrank: i,
      startedFrom: 'blank',
      title: `AMO - ${s.label}`,
      type: 'custom',
      uid: `amo_${champName.toLowerCase().replace(/\s/g,'_')}_${s.label.toLowerCase().replace(/\s/g,'_')}_${Date.now()}_${i}`,
    }));

    const auth = Buffer.from(`riot:${creds.token}`).toString('base64');
    const body = JSON.stringify({ itemSets, timestamp: Date.now() });

    return await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: '127.0.0.1', port: creds.port,
        path: `/lol-item-sets/v1/item-sets/${summonerId}/sets`,
        method: 'PUT', rejectUnauthorized: false,
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      }, (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          console.log('[LCU-ItemSet] status:', res.statusCode);
          resolve({ status: res.statusCode });
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  } catch(e) {
    console.error('[LCU-ItemSet] error:', e.message);
    return { error: e.message };
  }
});

// ── LCU WebSocket: escucha eventos en tiempo real ─────────
const WebSocket = require('ws');
let lcuWs = null;
let lcuWsRetryTimer = null;

// ── Polling de campeón en ChampSelect ────────────────────────
let champSelectPollTimer = null;
let lastCachedChampId    = null;

function stopChampSelectPolling() {
  if (champSelectPollTimer) {
    clearInterval(champSelectPollTimer);
    champSelectPollTimer = null;
  }
  lastCachedChampId = null;
  console.log('[ChampPoll] polling detenido');
}

async function startChampSelectPolling(creds) {
  stopChampSelectPolling();
  console.log('[ChampPoll] iniciando polling de campeón...');

  champSelectPollTimer = setInterval(async () => {
    try {
      const champId = await lcuRequest(creds.port, creds.token, '/lol-champ-select/v1/current-champion');
      if (!champId || typeof champId !== 'number' || champId === 0) return;
      if (champId === lastCachedChampId) return;

      console.log(`[ChampPoll] campeón detectado: ${champId} (anterior: ${lastCachedChampId})`);
      lastCachedChampId = champId;
      lastChampionId    = champId; // ← guardar para cuando arranque el OCR

      // 1. Cachear augments primero
      const cacheRes  = await fetch('http://127.0.0.1:5123/cache-champion-augments', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ champion_id: champId }),
      });
      const cacheJson = await cacheRes.json();
      console.log(`[ChampPoll] cache resultado:`, cacheJson);

    } catch (e) {
      console.warn('[ChampPoll] error:', e.message);
    }
  }, 200);
}

let _lcuKnownClosed = false;

async function startLcuWebSocket() {
  if (lcuWs) return;
  const creds = await getLcuCredentials();
  if (!creds) {
    if (!_lcuKnownClosed) {
      _lcuKnownClosed = true;
      if (win) win.webContents.send('lcu-phase', 'closed');
    }
    lcuWsRetryTimer = setTimeout(startLcuWebSocket, 8000);
    return;
  }
  _lcuKnownClosed = false;

  const auth = Buffer.from(`riot:${creds.token}`).toString('base64');
  const ws = new WebSocket(`wss://127.0.0.1:${creds.port}`, {
    rejectUnauthorized: false,
    headers: { Authorization: `Basic ${auth}` },
  });

  ws.on('open', () => {
    console.log('[LCU-WS] conectado');
    lcuWs = ws;
    ws.send(JSON.stringify([5, 'OnJsonApiEvent_lol-gameflow_v1_gameflow-phase']));
    lcuRequest(creds.port, creds.token, '/lol-gameflow/v1/gameflow-phase')
      .then(phase => {
        console.log('[LCU-WS] fase inicial:', JSON.stringify(phase));
        if (!phase || phase.httpStatus || typeof phase !== 'string') {
          win.webContents.send('lcu-phase', 'closed');
          ws.terminate();
          return;
        }
        const clean = phase.replace(/"/g, '');
        const valid = ['None','Lobby','Matchmaking','ReadyCheck','ChampSelect','InProgress','GameStart','EndOfGame','PreEndOfGame','WaitingForStats','TerminatedInError'];
        if (!valid.includes(clean)) {
          console.log('[LCU-WS] fase inválida, no es League — cerrando WS');
          win.webContents.send('lcu-phase', 'closed');
          ws.terminate();
          return;
        }
        if (win) win.webContents.send('lcu-phase', phase);
      })
      .catch(() => {
        win.webContents.send('lcu-phase', 'closed');
        ws.terminate();
      });
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg[0] === 8 && msg[1] === 'OnJsonApiEvent_lol-gameflow_v1_gameflow-phase') {
        const phase = msg[2]?.data || 'None';
        if (win) win.webContents.send('lcu-phase', phase);

        // Alerta al encontrar partida
        if (phase === 'ReadyCheck') {
          win.webContents.executeJavaScript(
            `(() => { try { const s=JSON.parse(localStorage.getItem('amo_settings')||'{}'); return s.alertFound !== false; } catch(e){ return true; } })()`
          ).then(alertEnabled => {
            if (!alertEnabled) return;
            if (win && !win.isDestroyed()) { win.show(); win.focus(); }
            if (tray) tray.displayBalloon({ title: 'ALL MID ONLY', content: '¡Partida encontrada! Acepta para continuar.', iconType: 'info' });
          }).catch(() => {});
        }

        // ChampSelect → iniciar polling de campeón y guardar queueId
        if (phase === 'ChampSelect') {
          startChampSelectPolling(creds);
          lcuRequest(creds.port, creds.token, '/lol-gameflow/v1/session')
            .then(session => {
              lastQueueId = session?.gameData?.queue?.id || session?.gameData?.queueId || 0;
              console.log('[LCU] queueId detectado en ChampSelect:', lastQueueId);
            })
            .catch(() => { lastQueueId = 0; });

        } else if (phase === 'InProgress' || phase === 'GameStart') {
          stopChampSelectPolling();
          if (win) {
            win.webContents.send('lcu-phase', phase);
            win.webContents.setBackgroundThrottling(true);
            win.webContents.executeJavaScript(`
              (() => { try { return JSON.parse(localStorage.getItem('amo_settings')||'{}').minimizeIngame === true; } catch(e){ return false; } })()
            `).then(shouldMinimize => {
              if (shouldMinimize && win && !win.isDestroyed()) {
                setTimeout(() => { win.minimize(); }, 600);
              }
            }).catch(() => {
              setTimeout(() => { if (win && !win.isDestroyed()) win.minimize(); }, 600);
            });
          }

          // Leer ambos settings de una vez
          win.webContents.executeJavaScript(`
            (() => {
              try {
                const s = JSON.parse(localStorage.getItem('amo_settings')||'{}');
                const order = JSON.parse(localStorage.getItem('last_skill_order')||'null');
                const lastChamp = localStorage.getItem('last_champ_name') || null;
                return {
                  skillEnabled: s.skillOverlay !== false,
                  augEnabled:   s.overlay !== false,
                  order,
                  lastChamp
                };
              } catch(e) { return { skillEnabled: false, augEnabled: false, order: null, lastChamp: null }; }
            })()
          `).then(async ({ skillEnabled, augEnabled, order, lastChamp }) => {
            console.log('[Overlay] InProgress — skillEnabled:', skillEnabled, '| augEnabled:', augEnabled);

            // Si no tenemos campeón, intentar obtenerlo de la Live Client API
            if (!lastChampionId && (skillEnabled || augEnabled)) {
              try {
                const playerData = await liveClientRequest('/liveclientdata/activeplayer');
                if (playerData?.summonerName) {
                  const allPlayers = await liveClientRequest('/liveclientdata/playerlist');
                  if (Array.isArray(allPlayers)) {
                    const me = allPlayers.find(p =>
                      (p.summonerName || p.riotIdGameName || '').toLowerCase() === playerData.summonerName.toLowerCase()
                    );
                    if (me?.championName) {
                      console.log('[Overlay] campeón obtenido de LiveClient:', me.championName);
                      // Notificar al renderer para que actualice su estado
                      win.webContents.executeJavaScript(`
                        window._playLastChampionName = '${me.championName.replace(/'/g,"\\'")}';
                        localStorage.setItem('last_champ_name', '${me.championName.replace(/'/g,"\\'")}');
                      `).catch(() => {});
                      if (ocrProc) {
                        ocrProc.stdin.write(JSON.stringify({ campeon: me.championName }) + '\n');
                      }
                    }
                  }
                }
              } catch(e) {
                console.warn('[Overlay] no se pudo obtener campeón de LiveClient:', e.message);
                // Usar el último conocido del renderer
                if (lastChamp && ocrProc) {
                  ocrProc.stdin.write(JSON.stringify({ campeon: lastChamp }) + '\n');
                }
              }
            }

            const isAramCaos = CHAOS_QUEUE_IDS.has(lastQueueId);

            // WindowMode: forzar sin bordes si cualquiera está activo
            applyWindowModeForOverlay(augEnabled && isAramCaos, skillEnabled);

            // ── Skill overlay ──
            if (skillEnabled) {
              if (order?.length) currentSkillOrder = order;
              console.log('[SkillOverlay] currentSkillOrder length:', currentSkillOrder?.length);
              if (currentSkillOrder?.length) {
                console.log('[SkillOverlay] arrancando, next:', currentSkillOrder[0]);
                // Leer hudScale usando el handler existente
                try {
                  const hudData = await ipcMain.listeners('get-hud-scale')[0]?.({});
                  if (hudData?.sliderValue) initialHudScale = hudData.sliderValue;
                } catch {}
                if (!overlayWin || overlayWin.isDestroyed()) createOverlayWindow();
                startSkillPolling();
              }
            }

            // ── OCR aumentos (solo ARAM Caos) ──
            if (isAramCaos) {
              if (augEnabled) {
                console.log('[OCR] cola es ARAM Caos (' + lastQueueId + '), arrancando OCR');
                if (!overlayWin || overlayWin.isDestroyed()) createOverlayWindow();
                startOCR();
              } else {
                console.log('[OCR] overlay de aumentos desactivado, OCR no arranca');
              }
            } else {
              console.log('[OCR] cola ' + lastQueueId + ' no es ARAM Caos, OCR no arranca');
            }

          }).catch(() => {});

        } else {
          stopChampSelectPolling();
          stopOCR();
          stopSkillPolling();
          if (overlayWin && !overlayWin.isDestroyed()) {
            overlayWin.close();
            overlayWin = null;
          }
          // Restaurar WindowMode original al salir de partida
          try {
            const s = readJsonFile(APP_SETTINGS_FILE, {});
            applyWindowModeForOverlay(s.overlay === true, s.skillOverlay === true);
          } catch(e) {}
          if (win) {
            win.webContents.setBackgroundThrottling(false);
            win.restore();
          }
          lastQueueId = 0;
        }
      }
    } catch {}
  });

  ws.on('close', () => {
    lcuWs = null;
    _lcuCredsCache = null;
    _lcuCredsCacheTs = 0;
    _lcuKnownClosed = false;
    if (win) win.webContents.send('lcu-phase', 'closed');
    lcuWsRetryTimer = setTimeout(startLcuWebSocket, 5000);
  });

  ws.on('error', () => {
    ws.terminate();
  });
}

// ── Auto-updater ──────────────────────────────────────────────
function setupAutoUpdater() {
  autoUpdater.autoDownload    = false; // no descargar sin confirmar
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    console.log('[Updater] buscando actualizaciones...');
  });

  autoUpdater.on('update-available', (info) => {
    console.log('[Updater] actualización disponible:', info.version);
    if (win) win.webContents.send('update-available', info.version);
  });

  autoUpdater.on('update-not-available', () => {
    console.log('[Updater] sin actualizaciones');
  });

  autoUpdater.on('download-progress', (progress) => {
    const pct = Math.round(progress.percent);
    console.log(`[Updater] descargando: ${pct}%`);
    if (win) win.webContents.send('update-progress', pct);
  });

  autoUpdater.on('update-downloaded', () => {
    console.log('[Updater] descarga completa — instalando...');
    if (win) win.webContents.send('update-downloaded');

    setTimeout(() => {
      try { if (ocrProc) { ocrProc.kill('SIGTERM'); ocrProc = null; } } catch(e) {}
      try { if (pyProc)  { pyProc.kill('SIGTERM');  pyProc  = null; } } catch(e) {}
      setTimeout(() => {
        if (win) win.webContents.send('update-installing');
        setTimeout(() => {
          autoUpdater.quitAndInstall(true, true);
        }, 800);
      }, 1000);
    }, 1500);
  });

  autoUpdater.on('error', (e) => {
    console.error('[Updater] error:', e.message);
  });
}

// Registrar protocolo personalizado para OAuth callback
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('allmidonly', process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient('allmidonly');
}

// Manejar el callback de OAuth en Windows
app.on('second-instance', async (event, commandLine) => {
  const url = commandLine.find(arg => arg.startsWith('allmidonly://'));
  if (url) {
    const hashPart = url.split('#')[1] || '';
    const params = new URLSearchParams(hashPart);
    const accessToken  = params.get('access_token');
    const refreshToken = params.get('refresh_token');
    if (accessToken) {
      const { data, error } = await supabase.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken
      });
      if (!error && mainWindow) {
        mainWindow.webContents.send('supabase-auth-callback', {
          session: data.session
        });
      }
    }
  }
});

const http = require('http');

const callbackServer = http.createServer(async (req, res) => {
  const urlParams = new URL(req.url, 'http://localhost:3000');

  if (req.url.startsWith('/callback')) {
    const accessToken  = urlParams.searchParams.get('access_token');
    const refreshToken = urlParams.searchParams.get('refresh_token') || '';
    if (accessToken) {
      const { data, error } = await supabase.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken
      });
      if (!error && win) {
        win.webContents.send('supabase-auth-callback', { session: data.session });
      }
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  // Página bonita que se cierra sola
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!DOCTYPE html>
  <html>
  <head>
    <meta charset="UTF-8">
    <title>AllMidOnly</title>
    <style>
      * { margin:0; padding:0; box-sizing:border-box; }
      body {
        background:#0c1b3a;
        color:#c8bfb0;
        font-family:'Segoe UI',sans-serif;
        display:flex;
        align-items:center;
        justify-content:center;
        height:100vh;
        flex-direction:column;
        gap:20px;
      }
      .logo { font-size:13px; font-weight:700; letter-spacing:3px; color:#4a5060; text-transform:uppercase; }
      .logo span { color:#4d8eff; }
      .check {
        width:72px; height:72px; border-radius:50%;
        background:rgba(39,201,63,.1); border:2px solid #27c93f;
        display:flex; align-items:center; justify-content:center;
      }
      .title { font-size:20px; color:#c8bfb0; font-weight:600; }
      .sub { font-size:13px; color:#4a5060; }
    </style>
    <script>
      const hash   = window.location.hash.substring(1);
      const params = new URLSearchParams(hash);
      const at     = params.get('access_token');
      const rt     = params.get('refresh_token') || '';
      if (at) {
        fetch('http://localhost:3000/callback?access_token=' + encodeURIComponent(at) + '&refresh_token=' + encodeURIComponent(rt))
        .  finally(() => setTimeout(() => window.close(), 800));
      } else {
        setTimeout(() => window.close(), 1500);
      }
    </script>
  </head>
  <body>
    <div class="logo">ALL <span>MID</span> ONLY</div>
    <div class="check">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#27c93f" stroke-width="2.5" stroke-linecap="round">
        <path d="M5 13l4 4L19 7"/>
      </svg>
    </div>
    <div class="title">Sesión iniciada correctamente</div>
    <div class="sub">Cerrando esta ventana...</div>
  </body>
  </html>`);
});

callbackServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log('[Auth] puerto 3000 ya en uso (otra instancia), ignorando');
  } else {
    console.error('[Auth] error servidor callback:', err.message);
  }
});
if (gotLock) {
  callbackServer.listen(3000, '127.0.0.1', () => {
    console.log('[Auth] servidor callback escuchando en localhost:3000');
  });
}

app.whenReady().then(() => {
  // ya tienes createWindow, createTray etc — solo añade esto al final:
  // setTimeout(startLcuWebSocket, 2000);
});

ipcMain.handle('lcu-is-open', async () => {
  const creds = await getLcuCredentials();
  return !!creds;
});

ipcMain.handle('lcu-gameflow-phase', async () => {
  try {
    const creds = await getLcuCredentials();
    // console.log('[PHASE-DEBUG] creds:', JSON.stringify(creds));
    if (!creds) return null;
    const phase = await lcuRequest(creds.port, creds.token, '/lol-gameflow/v1/gameflow-phase');
    // console.log('[PHASE-DEBUG] phase raw:', JSON.stringify(phase));
    if (!phase || phase.httpStatus || typeof phase !== 'string') return null;
    // console.log('[PHASE-DEBUG] creds:', creds.port, '| phase raw:', JSON.stringify(phase));
    if (!phase || phase.httpStatus || typeof phase !== 'string') return null;
    const clean = phase.replace(/"/g, '');
    const valid = ['None','Lobby','Matchmaking','ReadyCheck','ChampSelect','InProgress','GameStart','EndOfGame','PreEndOfGame','WaitingForStats','TerminatedInError'];
    if (!valid.includes(clean)) return null;
    return phase;
  } catch(e) { return null; }
});

ipcMain.handle('lcu-play-session', async () => {
  try {
    const creds = await getLcuCredentials();
    if (!creds) return { error: 'client_closed' };

    const phaseRaw = await lcuRequest(creds.port, creds.token, '/lol-gameflow/v1/gameflow-phase');
    const phase = typeof phaseRaw === 'string' ? phaseRaw.replace(/"/g, '') : null;
    if (!phase) return { error: 'invalid_phase' };

    const out = { phase };

    if (phase === 'Matchmaking') {
      const search =
        await lcuRequest(creds.port, creds.token, '/lol-matchmaking/v1/search')
        || await lcuRequest(creds.port, creds.token, '/lol-matchmaking/v1/search-state');

      if (search && !search.httpStatus) {
        out.search = search;
      }
    }

    if (phase === 'ReadyCheck') {
      const ready = await lcuRequest(creds.port, creds.token, '/lol-matchmaking/v1/ready-check');
      if (ready && !ready.httpStatus) {
        out.readyCheck = ready;
      }
    }

    if (phase === 'InProgress' || phase === 'GameStart') {
      const live = await liveClientRequest('/liveclientdata/allgamedata');
      if (live) {
        out.live = live;
      }
    }

    return out;
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('lcu-accept-match', async () => {
  try {
    const creds = await getLcuCredentials();
    if (!creds) return { error: 'client_closed' };
    const auth = Buffer.from(`riot:${creds.token}`).toString('base64');
    return await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: '127.0.0.1', port: creds.port,
        path: '/lol-matchmaking/v1/ready-check/accept',
        method: 'POST', rejectUnauthorized: false,
        headers: { Authorization: `Basic ${auth}`, 'Content-Length': 0 },
      }, (res) => { resolve({ status: res.statusCode }); });
      req.on('error', reject);
      req.end();
    });
  } catch(e) { return { error: e.message }; }
});

ipcMain.handle('lcu-decline-match', async () => {
  try {
    const creds = await getLcuCredentials();
    if (!creds) return { error: 'client_closed' };
    const auth = Buffer.from(`riot:${creds.token}`).toString('base64');
    return await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: '127.0.0.1', port: creds.port,
        path: '/lol-matchmaking/v1/ready-check/decline',
        method: 'POST', rejectUnauthorized: false,
        headers: { Authorization: `Basic ${auth}`, 'Content-Length': 0 },
      }, (res) => { resolve({ status: res.statusCode }); });
      req.on('error', reject);
      req.end();
    });
  } catch(e) { return { error: e.message }; }
});

ipcMain.handle('lcu-cancel-queue', async () => {
  try {
    const creds = await getLcuCredentials();
    if (!creds) return { error: 'client_closed' };
    const auth = Buffer.from(`riot:${creds.token}`).toString('base64');
    return await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: '127.0.0.1', port: creds.port,
        path: '/lol-matchmaking/v1/search',
        method: 'DELETE', rejectUnauthorized: false,
        headers: { Authorization: `Basic ${auth}`, 'Content-Length': 0 },
      }, (res) => { resolve({ status: res.statusCode }); });
      req.on('error', reject);
      req.end();
    });
  } catch(e) { return { error: e.message }; }
});

ipcMain.handle('lcu-champ-select', async () => {
  try {
    const creds = await getLcuCredentials();
    if (!creds) return { error: 'client_closed' };
    const session = await lcuRequest(creds.port, creds.token, '/lol-champ-select/v1/session');
    if (!session || session.httpStatus) return { error: 'no_session' };
    return session;
  } catch(e) { return { error: e.message }; }
});

ipcMain.handle('lcu-champ-select-my-selection', async () => {
  try {
    const creds = await getLcuCredentials();
    if (!creds) return { error: 'client_closed' };
    const sel = await lcuRequest(creds.port, creds.token, '/lol-champ-select/v1/current-champion');
    if (!sel || sel.httpStatus) return { error: 'no_champion' };
    return sel;
  } catch(e) { return { error: e.message }; }
});

ipcMain.handle('lcu-champ-select-pickable', async () => {
  try {
    const creds = await getLcuCredentials();
    if (!creds) return { error: 'client_closed' };
    const paths = [
      '/lol-lobby-team-builder/champ-select/v1/pickable-champion-ids',
      '/lol-champ-select/v1/pickable-champion-ids',
    ];
    for (const path of paths) {
      const res = await lcuRequest(creds.port, creds.token, path);
      if (Array.isArray(res)) return res;
    }
    return { error: 'no_pickable' };
  } catch(e) { return { error: e.message }; }
});

ipcMain.handle('lcu-champ-select-pick', async (_, { championId }) => {
  try {
    const creds = await getLcuCredentials();
    if (!creds) return { error: 'client_closed' };
    if (!championId) return { error: 'missing_champion_id' };

    const attempts = [
      () => lcuPatch(creds.port, creds.token, '/lol-lobby-team-builder/champ-select/v1/session/my-selection', { selection: championId }),
      () => lcuPatch(creds.port, creds.token, '/lol-champ-select/v1/session/my-selection', { selection: championId }),
    ];

    let lastResponse = null;
    for (const attempt of attempts) {
      lastResponse = await attempt();
      if (lastResponse?.status >= 200 && lastResponse.status < 300) return lastResponse;
    }
    return lastResponse || { error: 'pick_failed' };
  } catch(e) { return { error: e.message }; }
});

ipcMain.handle('lcu-champ-select-bench-swap', async (_, { championId }) => {
  try {
    const creds = await getLcuCredentials();
    if (!creds) return { error: 'client_closed' };
    if (!championId) return { error: 'missing_champion_id' };

    const auth = Buffer.from(`riot:${creds.token}`).toString('base64');
    const postSwap = (path, payload = null) => new Promise((resolve, reject) => {
      const body = payload == null ? '' : JSON.stringify(payload);
      const req = https.request({
        hostname: '127.0.0.1',
        port: creds.port,
        path,
        method: 'POST',
        rejectUnauthorized: false,
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => resolve({ status: res.statusCode, body: data || null, path }));
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });

    const attempts = [
      { path: `/lol-lobby-team-builder/champ-select/v1/session/bench/swap/${championId}`, payload: null },
      { path: `/lol-champ-select/v1/session/bench/swap/${championId}`, payload: null },
      { path: `/lol-lobby-team-builder/champ-select/v1/session/bench/swap/${championId}`, payload: {} },
      { path: `/lol-champ-select/v1/session/bench/swap/${championId}`, payload: {} },
    ];

    let lastResponse = null;
    for (const attempt of attempts) {
      lastResponse = await postSwap(attempt.path, attempt.payload);
      if (lastResponse.status >= 200 && lastResponse.status < 300) {
        return lastResponse;
      }
    }

    return lastResponse || { error: 'swap_failed' };
  } catch(e) {
    return { error: e.message };
  }
});

// Diagnóstico: lista procesos League/Riot en ejecución
ipcMain.handle('lcu-diagnose', async () => {
  return new Promise((resolve) => {
    exec(
      `powershell -NoProfile -Command "Get-Process | Where-Object {$_.Name -like '*League*' -or $_.Name -like '*Riot*'} | Select-Object Name,Id | ConvertTo-Json"`,
      { timeout: 8000 },
      (err, stdout) => {
        if (err) return resolve({ error: err.message, processes: [] });
        try { resolve({ processes: JSON.parse(stdout || '[]') }); }
        catch { resolve({ raw: stdout?.trim() }); }
      }
    );
  });
});

function timeAgoMs(ts) {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 60)  return `hace ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24)  return `hace ${h}h`;
  const d = Math.floor(h / 24);
  if (d === 1) return 'ayer';
  if (d < 7)   return `hace ${d} días`;
  return `hace ${Math.floor(d / 7)} sem`;
}

// ── Crear ventana principal ──────────────────────────────────
function createWindow() {
  win = new BrowserWindow({
    width:  1360,
    height: 870,
    minWidth:  1360,
    minHeight: 870,
    frame:       false,
    transparent: false,
    resizable:   true,
    show: false,         
    backgroundColor: '#08011e',
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          false,
      devTools: ENABLE_DEVTOOLS
    },
    icon: path.join(ROOT_DIR, 'assets', 'images', 'logoicon.ico'),
  });

  win.loadFile(path.join(RENDERER_DIR, 'aram_caos_v6.html'));

  // ── Inicializar settings al cargar ──────────────────────────
  win.webContents.on('did-finish-load', async () => {
    // Inyectar fase actual antes de que el renderer inicialice nada
    try {
      const creds = await getLcuCredentials();
      if (creds) {
        const phaseRaw = await lcuRequest(creds.port, creds.token, '/lol-gameflow/v1/gameflow-phase');
        const phase = typeof phaseRaw === 'string' ? phaseRaw.replace(/"/g,'') : '';
        if (phase === 'InProgress' || phase === 'GameStart') {
          win.webContents.executeJavaScript('window.__INITIAL_PHASE__ = "InProgress";');
        }
      }
    } catch(e) {}
    try {
      const settings = readJsonFile(APP_SETTINGS_FILE, readJsonFile(path.join(ROOT_CACHE_DIR, 'settings.json'), null));
      if (settings) {
        if (settings.hwaccel === false) {
          win.webContents.executeJavaScript(`
            const el = document.getElementById('tog-hwaccel');
            if (el) el.classList.remove('on');
          `);
        }
      }
    } catch(e) {}
  });

  win.once('ready-to-show', () => {
    const SPLASH_VISIBLE_TIME = 3000;
    win.show();
    win.focus();
    setTimeout(() => {
      win.webContents.send('app-startup-transition');
    }, SPLASH_VISIBLE_TIME);
  });
  if (ENABLE_DEVTOOLS) win.webContents.openDevTools();

  win.on('close', (e) => {
    if (app._quitting) return;
    e.preventDefault();
    win.webContents.executeJavaScript(
      `(() => { try { return JSON.parse(localStorage.getItem('amo_settings')||'{}').minimize !== false; } catch(e){ return true; } })()`
    ).then(shouldHide => {
      if (shouldHide) { win.hide(); }
      else { app._quitting = true; app.quit(); }
    }).catch(() => { win.hide(); });
  });

  win.on('maximize',   () => win.webContents.send('win-maximized'));
  win.on('unmaximize', () => win.webContents.send('win-unmaximized'));
}


// ── Tray ─────────────────────────────────────────────────────
function createTray() {
  let icon;
  try {
    icon = nativeImage.createFromPath(path.join(ROOT_DIR, 'assets', 'images', 'logoicon.ico'));
    if (icon.isEmpty()) throw new Error('empty');
  } catch {
    icon = nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAAdgAAAHYBTnsmCAAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAABHSURBVDiNY2AYBdQFTAz/GRj+M5ABGMiVZxgFgx8wMJCrBqoegAWkGkCuBlINIFcDqQaQawCpBpBrAKkGkGsAqQaQawCpBgDZ0gY3vITEowAAAABJRU5ErkJggg=='
    );
  }
  tray = new Tray(icon);
  tray.setToolTip('ALL MID ONLY');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir ALL MID ONLY', click: () => { win.show(); win.focus(); } },
    { type: 'separator' },
    { label: 'Salir', click: () => { app._quitting = true; app.quit(); } },
  ]));
  tray.on('double-click', () => { win.show(); win.focus(); });
}

// ── IPC: detalle de partida ───────────────────────────────────
ipcMain.handle('lcu-get-match-detail', async (_, { gameId }) => {
  try {
    const creds = await getLcuCredentials();
    if (!creds) return { error: 'client_closed' };

    const data = await lcuRequestWithRetry(
      creds.port, creds.token,
      `/lol-match-history/v1/games/${gameId}`
    );

    if (!data || data.errorCode || data.httpStatus) {
      // console.log('[LCU detail] error:', JSON.stringify(data));
      return { error: data?.message || 'no_data' };
    }

    // Normalizar los datos de la partida
    const participants = data.participants || [];
    const identities   = data.participantIdentities || [];
    const rawTeams     = data.teams || [];

    // Construir mapas de identidad para nombre/tagline/puuid por participantId
    const nameMap = {};
    const tagMap  = {};
    const puuidMap = {};
    identities.forEach(pi => {
      const pid    = pi.participantId;
      const player = pi.player || {};
      const name   = player.gameName || player.summonerName || player.riotIdGameName || player.riotId || '';
      const tag    = player.tagLine || player.riotIdTagline || '';
      const puuid  = player.puuid || '';
      if(name) nameMap[pid] = name;
      if(tag)  tagMap[pid]  = tag;
      if(puuid) puuidMap[pid] = puuid;
    });

    const normalizeWinFlag = (value, fallback = false) => {
      if (value === true || value === false) return value;
      if (typeof value === 'string') {
        const v = value.trim().toLowerCase();
        if (['win', 'won', 'true', 'victory'].includes(v)) return true;
        if (['fail', 'loss', 'lose', 'lost', 'false', 'defeat'].includes(v)) return false;
      }
      if (typeof value === 'number') return value !== 0;
      return fallback;
    };

    // Calcular máximo de daño para las barras
    const allDmg = participants.map(p => p.stats?.totalDamageDealtToChampions || 0);
    const maxDmg = Math.max(...allDmg, 1);

    // Agrupar por equipo
    const teams = {};
    participants.forEach(p => {
      const tid   = p.teamId || 100;
      const stats = p.stats || {};
      const riotIdGameName = nameMap[p.participantId]
                          || p.player?.gameName
                          || p.player?.riotIdGameName
                          || p.player?.summonerName
                          || '';
      const riotIdTagline = tagMap[p.participantId]
                         || p.player?.tagLine
                         || p.player?.riotIdTagline
                         || '';
      const name = riotIdGameName || '';

      if(!teams[tid]) {
        const teamMeta = rawTeams.find(t => (t.teamId || t.id) === tid) || {};
        const towerKills = teamMeta.towerKills
          ?? teamMeta.objectives?.tower?.kills
          ?? teamMeta.objectives?.turret?.kills
          ?? null;

        teams[tid] = {
          teamId: tid,
          win: normalizeWinFlag(
            teamMeta.win ?? teamMeta.isWinner ?? teamMeta.winner,
            normalizeWinFlag(stats.win, false)
          ),
          towerKills,
          objectives: teamMeta.objectives || null,
          participants: []
        };
      }
      teams[tid].participants.push({
        participantId:              p.participantId,
        puuid:                      puuidMap[p.participantId] || p.player?.puuid || p.puuid || '',
        summonerName:               name,
        riotIdGameName,
        riotIdTagline,
        championId:                 p.championId,
        championName:               p.championName || '',
        championLevel:              stats.champLevel || 0,
        spell1Id:                   p.spell1Id,
        spell2Id:                   p.spell2Id,
        kills:                      stats.kills   || 0,
        deaths:                     stats.deaths  || 0,
        assists:                    stats.assists || 0,
        tripleKills:                stats.tripleKills || 0,
        quadraKills:                stats.quadraKills || 0,
        pentaKills:                 stats.pentaKills || 0,
        totalDamageDealtToChampions:stats.totalDamageDealtToChampions || 0,
        totalDamageTaken:           stats.totalDamageTaken || 0,
        totalHeal:                  stats.totalHeal || 0,
        goldEarned:                 stats.goldEarned || 0,
        turretKills:                stats.turretKills || 0,
        turretTakedowns:            stats.turretTakedowns || 0,
        item0: stats.item0, item1: stats.item1, item2: stats.item2,
        item3: stats.item3, item4: stats.item4, item5: stats.item5, item6: stats.item6,
        // Aumentos (perks/augments en ARAM CAOS)
        perk0: stats.perk0, perk1: stats.perk1, perk2: stats.perk2,
        perk3: stats.perk3, perk4: stats.perk4, perk5: stats.perk5,
        playerAugment1: stats.playerAugment1, playerAugment2: stats.playerAugment2,
        playerAugment3: stats.playerAugment3, playerAugment4: stats.playerAugment4,
        playerAugment5: stats.playerAugment5, playerAugment6: stats.playerAugment6,
      });

      // Log diagnóstico: muestra TODOS los campos stats del primer jugador
      if (p === participants[0]) {
        const augKeys = Object.keys(stats).filter(k =>
          /augment|perk|cherry|rune|shard/i.test(k)
        );
        // console.log('[AUG-DIAG] gameId:', gameId, '| gameMode:', data.gameMode, '| mapId:', data.mapId);
        // console.log('[AUG-DIAG] Campos augment/perk en stats:', augKeys);
        augKeys.forEach(k => console.log(`  stats.${k} =`, stats[k]));
        if (augKeys.length === 0) {
          // console.log('[AUG-DIAG] Todos los campos de stats:', Object.keys(stats).join(', '));
        }
      }
    });

    const result = {
      gameId,
      teams:   Object.values(teams),
      maxDmg,
      gameCreation: data.gameCreation || data.gameCreationDate || 0,
      gameDuration: data.gameDuration || data.gameLength || 0,
      queueId: data.queueId || 0,
      mapId:   data.mapId   || 0,
      gameMode: data.gameMode || '',
      gameModeMutators: Array.isArray(data.gameModeMutators) ? data.gameModeMutators.filter(Boolean) : [],
      mapVariant: getMapVariantInfo(data).name,
    };

    // Guardar en disco si la opción está activada
    try {
      const settings = readJsonFile(APP_SETTINGS_FILE, readJsonFile(path.join(ROOT_CACHE_DIR, 'settings.json'), {})) || {};
      if(settings.localHistory){
        const histDir = APP_HISTORY_DIR;
        if(!fs.existsSync(histDir)) fs.mkdirSync(histDir, { recursive: true });
        const filePath = path.join(histDir, `${gameId}.json`);
        fs.writeFileSync(filePath, JSON.stringify(result), 'utf-8');
        console.log(`[LocalHistory] Partida guardada: ${gameId}.json`);
      }
    } catch(he){ console.error('[LocalHistory] error guardando:', he.message); }

    return result;
  } catch(e) {
    console.error('[LCU detail] error:', e.message);
    return { error: e.message };
  }
});

// ── Python proxy ─────────────────────────────────────────────
function getPythonEnv() {
  return {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
    AMO_ROOT_DIR: RUNTIME_ROOT_DIR,
    AMO_CACHE_DIR: APP_CACHE_DIR,
    AMO_HISTORY_DIR: APP_HISTORY_DIR,
    AMO_IMG_DIR: PYTHON_IMG_DIR,
  };
}

function resolvePythonLaunchConfig() {
  if (pythonLaunchConfig) return pythonLaunchConfig;

  const embeddedCandidates = [
    { command: path.join(process.resourcesPath, 'python', 'python.exe'), args: [] },
    { command: path.join(ROOT_DIR, 'python', 'python.exe'), args: [] },
    { command: path.join(ROOT_DIR, 'vendor', 'python', 'python.exe'), args: [] },
    { command: path.join(ROOT_DIR, 'scripts', 'python', 'python.exe'), args: [] },
  ];

  for (const candidate of embeddedCandidates) {
    if (fs.existsSync(candidate.command)) {
      pythonLaunchConfig = candidate;
      console.log('[Python] usando runtime embebido:', candidate.command);
      return pythonLaunchConfig;
    }
  }

  const commandCandidates = [
    { command: 'python', args: [] },
    { command: 'py', args: ['-3'] },
  ];

  for (const candidate of commandCandidates) {
    try {
      const probe = spawnSync(candidate.command, [...candidate.args, '--version'], {
        timeout: 5000,
        windowsHide: true,
        encoding: 'utf8',
      });
      if (!probe.error && probe.status === 0) {
        pythonLaunchConfig = candidate;
        console.log('[Python] usando runtime del sistema:', [candidate.command, ...candidate.args].join(' '));
        return pythonLaunchConfig;
      }
    } catch {}
  }

  pythonLaunchConfig = null;
  console.warn('[Python] no se ha encontrado un interprete disponible');
  return null;
}

function spawnPythonProcess(script, options = {}) {
  const launchConfig = resolvePythonLaunchConfig();
  if (!launchConfig) return null;

  const extraArgs = options.args || [];
  delete options.args;
  return spawn(launchConfig.command, [...launchConfig.args, script, ...extraArgs], options);
}

function startPython() {
  require('child_process').exec('for /f "tokens=5" %a in (\'netstat -aon ^| find "5123"\') do taskkill /F /PID %a', 
    (err) => {
      const script = path.join(PYTHON_DIR, 'proxy_riot.py');
      if (!fs.existsSync(script)) { console.log('proxy_riot.py no encontrado'); return; }
      pyProc = spawnPythonProcess(script, { cwd: RUNTIME_ROOT_DIR, stdio: ['ignore', 'pipe', 'pipe'], env: getPythonEnv() });
      if (!pyProc) {
        console.warn('[py] proxy no iniciado: no hay interprete Python disponible');
        return;
      }
      pyProc.stdout.on('data', d => console.log('[py]', d.toString().trim()));
      pyProc.stderr.on('data', d => console.error('[py]', d.toString().trim()));
      pyProc.on('error', err => {
        console.error('[py] error proceso:', err.message);
        pyProc = null;
      });
      pyProc.on('close', code => console.log('[py] cerrado, código:', code));
    }
  );
}

console.log('[DEBUG] __dirname:', __dirname);
// ── WindowMode helper (overlay sobre fullscreen) ──────────────
const GAME_CFG_PATHS = [
  path.join(os.homedir(), 'AppData', 'Local', 'Riot Games', 'League of Legends', 'Config', 'game.cfg'),
  'C:\\Riot Games\\League of Legends\\Config\\game.cfg',
];
const ORIGINAL_WINDOW_MODE_FILE = path.join(APP_CACHE_DIR, 'original_window_mode.json');

function getGameCfgPath() {
  return GAME_CFG_PATHS.find(p => fs.existsSync(p)) || null;
}

function saveOriginalWindowModeIfNeeded() {
  if (fs.existsSync(ORIGINAL_WINDOW_MODE_FILE)) return;
  const cfgPath = getGameCfgPath();
  if (!cfgPath) return;
  const m = fs.readFileSync(cfgPath, 'utf-8').match(/WindowMode\s*=\s*(\d)/i);
  if (!m) return;
  fs.writeFileSync(ORIGINAL_WINDOW_MODE_FILE, JSON.stringify({ windowMode: parseInt(m[1]) }), 'utf-8');
  console.log('[WindowMode] original guardado:', m[1]);
}

function setWindowMode(mode) {
  const cfgPath = getGameCfgPath();
  if (!cfgPath) return;
  let content = fs.readFileSync(cfgPath, 'utf-8');
  if (/WindowMode\s*=\s*\d/i.test(content)) {
    content = content.replace(/WindowMode\s*=\s*\d/i, `WindowMode=${mode}`);
  } else {
    content += `\nWindowMode=${mode}`;
  }
  fs.writeFileSync(cfgPath, content, 'utf-8');
  console.log('[WindowMode] escrito:', mode);
}

function applyWindowModeForOverlay(overlayEnabled, skillOverlayEnabled) {
  try {
    saveOriginalWindowModeIfNeeded();
    if (overlayEnabled || skillOverlayEnabled) {
      setWindowMode(2);
    } else {
      const saved = readJsonFile(ORIGINAL_WINDOW_MODE_FILE, null);
      setWindowMode(saved?.windowMode ?? 2);
    }
  } catch(e) {
    console.error('[WindowMode] error:', e.message);
  }
}

console.log('[DEBUG] preload path:', path.join(__dirname, 'overlay_preload.js'));

function createOverlayWindow() {
  const { screen } = require('electron');
  const { width, height } = screen.getPrimaryDisplay().bounds;

  overlayWin = new BrowserWindow({
    x:           0,
    y:           0,
    width:       width,
    height:      height,
    transparent: true,
    frame:       false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable:   false,
    resizable:   false,
    fullscreen:  false,
    type:        'toolbar',
    webPreferences: {
      preload:          path.join(__dirname, 'overlay_preload.js'),
      contextIsolation: true,
      sandbox:          false,
    },
  });
  overlayWin.setIgnoreMouseEvents(true);
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.loadFile(path.join(RENDERER_DIR, 'overlay.html'));
  // overlayWin.webContents.openDevTools({ mode: 'detach' });
  overlayWin.webContents.on('did-finish-load', () => {
    setTimeout(async () => {
      try {
        if (fs.existsSync(OVERLAY_POSITIONS_FILE)) {
          const positions = JSON.parse(fs.readFileSync(OVERLAY_POSITIONS_FILE, 'utf-8'));
          overlayWin.webContents.send('overlay-positions', positions);
          console.log('[overlay] posiciones cargadas desde disco');
        }
      } catch(e) { console.error('[overlay] error posiciones:', e.message); }

      try {
        const packFile = APP_TIER_PACK_FILE;
        console.log('[overlay] buscando pack en:', packFile);
        console.log('[overlay] existe:', fs.existsSync(packFile));
        if (fs.existsSync(packFile)) {
          const raw  = fs.readFileSync(packFile, 'utf-8');
          console.log('[overlay] raw:', raw.slice(0, 120));
          const saved = JSON.parse(raw);
          console.log('[overlay] saved.name:', saved.name, '| saved.pack keys:', Object.keys(saved.pack || saved));
          const pack = saved.pack || saved;
          overlayWin.webContents.send('overlay-pack', pack);
          console.log('[overlay] pack enviado OK');
        }
      } catch(e) { console.error('[overlay] error pack:', e.message); }

      // Skill order — mandar al overlay recién cargado si hay uno activo
      try {
        if (currentSkillOrder?.length) {
          // Verificar que ya estamos ingame antes de mostrar
          const gameStats = await liveClientRequest('/liveclientdata/gamestats');
          if (gameStats && (gameStats.gameTime ?? 0) >= 3) {
            const nextSkill = currentSkillOrder[0] || null;
            overlayWin.webContents.send('overlay-skill-up', { nextSkill, levels: {Q:0,W:0,E:0,R:0}, hudScale: initialHudScale });
            console.log('[SkillOverlay] enviado tras carga overlay:', nextSkill);
          }
        }
      } catch(e) {}
    }, 500);
  });
}

function startSkillPolling() {
  stopSkillPolling();
  let _lastTotalLevels = -1;
  let _lastHasPoint = false;
  let _hudScaleCache = null;
  let _lastScaleRead = 0;

  function readHudScale() {
    try {
      const cfgPaths = [
        path.join(os.homedir(), 'AppData', 'Local', 'Riot Games', 'League of Legends', 'Config', 'game.cfg'),
        'C:\\Riot Games\\League of Legends\\Config\\game.cfg',
      ];
      for (const cp of cfgPaths) {
        if (fs.existsSync(cp)) {
          const m = fs.readFileSync(cp, 'utf-8').match(/GlobalScale\s*=\s*([\d.]+)/i);
          if (m) return Math.round(parseFloat(m[1]) * 100);
        }
      }
    } catch {}
    return _hudScaleCache;
  }

  skillPollTimer = setInterval(async () => {
    if (!overlayWin || overlayWin.isDestroyed()) return;
    if (!currentSkillOrder || currentSkillOrder.length === 0) return;
    try {
      const gameStats = await liveClientRequest('/liveclientdata/gamestats');
      if (!gameStats || (gameStats.gameTime ?? 0) < 3) {
        if (_lastHasPoint) {
          _lastHasPoint = false;
          _lastTotalLevels = -1;
          overlayWin.webContents.send('overlay-skill-up', { nextSkill: null, levels: null });
        }
        return;
      }

      const playerData = await liveClientRequest('/liveclientdata/activeplayer');
      if (!playerData) return;

      const abilities = playerData.abilities || {};
      const levels = {
        Q: abilities.Q?.abilityLevel ?? 0,
        W: abilities.W?.abilityLevel ?? 0,
        E: abilities.E?.abilityLevel ?? 0,
        R: abilities.R?.abilityLevel ?? 0,
      };
      const totalLevels = levels.Q + levels.W + levels.E + levels.R;
      const champLevel  = playerData.level ?? totalLevels;
      const hasPoint    = champLevel > totalLevels;
      const nextSkill   = hasPoint ? (currentSkillOrder[totalLevels] || null) : null;

      // Si hay punto pendiente, releer scale cada 3 segundos
      if (hasPoint) {
        const now = Date.now();
        if (!_lastScaleRead || now - _lastScaleRead > 3000) {
          _lastScaleRead = now;
          const newScale = readHudScale();
          if (newScale !== _hudScaleCache) {
            _hudScaleCache = newScale;
            overlayWin.webContents.send('overlay-skill-up', { nextSkill, levels, hudScale: _hudScaleCache });
          }
        }
      }

      if (totalLevels !== _lastTotalLevels || hasPoint !== _lastHasPoint) {
        console.log(`[SkillPoll] total:${totalLevels} champ:${champLevel} hasPoint:${hasPoint} next:${nextSkill}`);
        _lastTotalLevels = totalLevels;
        _lastHasPoint    = hasPoint;
        if (!hasPoint) _hudScaleCache = readHudScale();
        overlayWin.webContents.send('overlay-skill-up', { nextSkill, levels, hudScale: _hudScaleCache });
      }

      const targetMs = hasPoint ? 500 : 1500;
      if (skillPollTimer._idleTimeout !== targetMs) {
        clearInterval(skillPollTimer);
        skillPollTimer = setInterval(arguments.callee, targetMs);
      }
    } catch(e) {
      if (e.message?.includes('ECONNREFUSED')) {
        if (_lastHasPoint) {
          _lastHasPoint = false;
          _lastTotalLevels = -1;
          overlayWin.webContents.send('overlay-skill-up', { nextSkill: null, levels: null });
        }
      } else {
        console.log('[SkillPoll] error:', e.message);
      }
    }
  }, 500);
}

function stopSkillPolling() {
  if (skillPollTimer) { clearInterval(skillPollTimer); skillPollTimer = null; }
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.webContents.send('overlay-skill-up', { nextSkill: null, levels: null });
  }
}

function stopOCR() {
  stopSkillPolling();
  if (ocrProc) {
    const pid = ocrProc.pid;
    ocrProc = null;

    // Ocultar overlay antes de matar el proceso
    if (overlayWin) overlayWin.webContents.send('ocr-ocultar');
    
    try {
      require('child_process').exec(`taskkill /PID ${pid} /T /F`, (err, stdout) => {
        if (err) console.warn('[OCR] taskkill error:', err.message);
        else     console.log('[OCR] proceso detenido PID:', pid, stdout?.trim());
      });
    } catch(e) {
      console.warn('[OCR] error al matar proceso:', e.message);
    }
  }
}

function startOCR() {
  if (ocrProc) {
    console.log('[OCR] ya esta corriendo, ignorando llamada duplicada');
    return;
  }

  const script = path.join(PYTHON_DIR, 'aramcaos_ocr.py');
  if (!fs.existsSync(script)) {
    console.error('[OCR] aramcaos_ocr.py no encontrado en', PYTHON_DIR);
    return;
  }

  ocrProc = spawnPythonProcess(script, {
    cwd:   BASE,
    stdio: ['pipe', 'pipe', 'pipe'],
    env:   getPythonEnv(),
  });
  if (!ocrProc) {
    console.warn('[OCR] no iniciado: no hay interprete Python disponible');
    return;
  }

  ocrProc.stdout.setEncoding('utf-8');
  ocrProc.stderr.setEncoding('utf-8');
  let ocrStdoutBuffer = '';

  console.log('[OCR] proceso arrancado PID:', ocrProc.pid, '| champion:', lastChampionId);

  ocrProc.on('close', (code) => {
    console.log(`[OCR] proceso cerrado codigo: ${code}`);
    ocrProc = null;
  });

  ocrProc.on('error', (err) => {
    console.error('[OCR] error proceso:', err.message);
    ocrProc = null;
  });

  setTimeout(() => {
    if (!ocrProc) {
      console.error('[OCR] proceso muerto antes de enviar champion_id');
      return;
    }
    if (!lastChampionId) {
      console.warn('[OCR] lastChampionId es null — usara TIER_DEFAULT');
      return;
    }
    try {
      ocrProc.stdin.write(JSON.stringify({ campeon: lastChampionId }) + '\n');
      const packFile = APP_TIER_PACK_FILE;
       if (fs.existsSync(packFile) && overlayWin) {
        const saved = JSON.parse(fs.readFileSync(packFile, 'utf-8'));
        const pack  = saved.pack || saved;
        overlayWin.webContents.send('overlay-pack', pack);
      }
    } catch(e) {
      console.error('[OCR] error enviando champion_id:', e.message);
    }
  }, 300);

  ocrProc.stdout.on('data', d => {
    ocrStdoutBuffer += d;
    const lines = ocrStdoutBuffer.split(/\r?\n/);
    ocrStdoutBuffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed);
        if (msg.type === 'tiers') {
          console.log('[OCR->Overlay] tiers:', msg.tiers, '| overlayWin:', !!overlayWin);
          if (overlayWin) {
            overlayWin.setAlwaysOnTop(true, 'screen-saver');
            overlayWin.webContents.send('ocr-tiers', msg);
          }
        }
        if (msg.type === 'ocultar') {
          console.log('[OCR->Overlay] ocultar');
          if (overlayWin) overlayWin.webContents.send('ocr-ocultar');
        }
      } catch {
        console.log('[ocr]', trimmed);
      }
    }
  });

  ocrProc.stderr.on('data', d => {
    console.error('[ocr-stderr]', d.trim());
  });
}

// ── IPC: ventana ─────────────────────────────────────────────
ipcMain.on('win-minimize',     () => win?.minimize());
ipcMain.on('win-maximize',     () => { win?.isMaximized() ? win.unmaximize() : win?.maximize(); });
ipcMain.on('win-close', () => {
  if (!win || win.isDestroyed()) return;
  win.webContents.executeJavaScript(
    `(() => { try { return JSON.parse(localStorage.getItem('amo_settings')||'{}').minimize !== false; } catch(e){ return true; } })()`
  ).then(shouldHide => {
    if (shouldHide) { win.hide(); }
    else { app._quitting = true; app.quit(); }
  }).catch(() => { win.hide(); });
});
ipcMain.on('win-quit',         () => { app._quitting = true; app.quit(); });
ipcMain.on('win-is-maximized', (e) => { e.returnValue = win?.isMaximized() ?? false; });

// ── App lifecycle ────────────────────────────────────────────
app.whenReady().then(async () => {
  createWindow();
  createTray();
  startPython();
  setTimeout(startLcuWebSocket, 2000);

  // ── Sync imágenes de aumentos al arrancar ──────────────────
  // Espera 3s a que el proxy Python esté listo antes de llamarlo
  setTimeout(async () => {
    try {
      const patch = await getCurrentPatch(); // ej: "16.8"
      if (!patch) { console.warn('[AugSync] no se pudo obtener versión del parche'); return; }

      console.log(`[AugSync] versión del parche: ${patch} — verificando imágenes...`);

      const res = await fetch(`http://127.0.0.1:5123/augments-sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: patch }),
      });
      const json = await res.json();

      if (json.status === 'up_to_date') {
        console.log('[AugSync] imágenes ya al día, nada que hacer');
      } else if (json.status === 'started') {
        console.log(`[AugSync] descarga iniciada para parche ${patch}`);

        // Polling de estado cada 2s hasta que termine
        const poll = setInterval(async () => {
          try {
            const s = await fetch('http://127.0.0.1:5123/augments-sync-status').then(r => r.json());
            console.log(`[AugSync] ${s.msg} (${s.done}/${s.total})`);
            if (!s.running) {
              clearInterval(poll);
              console.log(`[AugSync] ✅ finalizado — ${s.errors} errores`);
            }
          } catch { clearInterval(poll); }
        }, 2000);
      }
    // Cachear nombres en español
    await fetch('http://127.0.0.1:5123/cache-augments-es', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: patch }),
    });
    console.log('[AugSync] nombres en español cacheados');
    } catch (e) {
      console.warn('[AugSync] error al sincronizar imágenes:', e.message);
    }
  }, 3000);
  if (app.isPackaged) {
    setTimeout(() => {
      try { setupAutoUpdater(); autoUpdater.checkForUpdates(); } catch(e) {}
    }, 5000);
  }
});

app.on('window-all-closed', (e) => e.preventDefault());
app.on('before-quit', () => { app._quitting = true; if (pyProc) pyProc.kill(); if (ocrProc) ocrProc.kill(); });
app.on('before-quit', () => {
  app._quitting = true;
  if (pyProc) { pyProc.kill('SIGKILL'); pyProc = null; }
  if (ocrProc) { ocrProc.kill('SIGKILL'); ocrProc = null; }
});

app.on('window-all-closed', () => {
  if (pyProc) { pyProc.kill('SIGKILL'); pyProc = null; }
  if (ocrProc) { ocrProc.kill('SIGKILL'); ocrProc = null; }
  app.quit();
});

process.on('SIGTERM', () => {
  if (pyProc) { pyProc.kill('SIGKILL'); pyProc = null; }
  if (ocrProc) { ocrProc.kill('SIGKILL'); ocrProc = null; }
  app.quit();
});

process.on('SIGINT', () => {
  if (pyProc) { pyProc.kill('SIGKILL'); pyProc = null; }
  if (ocrProc) { ocrProc.kill('SIGKILL'); ocrProc = null; }
  app.quit();
});
app.on('activate',    () => { if (!win) createWindow(); else win.show(); });

ipcMain.handle('set-skill-order', (_, skillOrder) => {
  currentSkillOrder = skillOrder;
  console.log('[SkillOverlay] skill order recibido:', skillOrder);
});

ipcMain.handle('ocr-set-campeon', (_, nombre) => {
  if (ocrProc?.stdin) {
    ocrProc.stdin.write(JSON.stringify({ campeon: nombre }) + '\n');
  }
});

ipcMain.on('win-bring-to-front', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  win.setAlwaysOnTop(true);
  setTimeout(() => win.setAlwaysOnTop(false), 1000);
});

ipcMain.handle('overlay-edit-mode', () => {
  if (overlayWin) {
    overlayWin.setIgnoreMouseEvents(false);
    overlayWin.webContents.send('overlay-edit');
  }
});

ipcMain.on('overlay-edit-done', () => {
  if (overlayWin) {
    overlayWin.setIgnoreMouseEvents(true, { forward: true });
    console.log('[overlay] modo edición finalizado');
  }
});

ipcMain.handle('overlay-set-positions', (_, positions) => {
  // Guardar en disco
  try {
    fs.writeFileSync(OVERLAY_POSITIONS_FILE, JSON.stringify(positions), 'utf-8');
    console.log('[overlay] posiciones guardadas en disco');
  } catch(e) {
    console.error('[overlay] error guardando posiciones:', e.message);
  }
  // Mandar al overlay en tiempo real
  if (overlayWin) overlayWin.webContents.send('overlay-positions', positions);
});

// ══════════════════════════════════════════════════════════════
//  UTILIDADES COMPARTIDAS: versión de parche + fetch HTTPS
// ══════════════════════════════════════════════════════════════

const CACHE_DIR      = APP_CACHE_DIR;
const VERSIONS_URL   = 'https://ddragon.leagueoflegends.com/api/versions.json';
const AUG_ICON_BASE  = 'https://blitz-cdn.blitz.gg/blitz/lol/arena/augments/';
const AUG_RARITY_MAP = { 0: 'COMÚN', 1: 'ÉPICO', 2: 'LEGENDARIO' };

/** GET HTTPS → string, sigue redirecciones */
function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return httpsGet(res.headers.location, headers).then(resolve).catch(reject);
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

/** "16.7.1" → "16.7" */
async function getCurrentPatch() {
  try {
    const list = JSON.parse(await httpsGet(VERSIONS_URL));
    const [major, minor] = list[0].split('.');
    return `${major}.${minor}`;
  } catch (e) { console.warn('[Patch]', e.message); return null; }
}

function readCache(file) {
  try {
    const p = [path.join(CACHE_DIR, file), path.join(ROOT_CACHE_DIR, file)].find(candidate => fs.existsSync(candidate));
    if (!p) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch { return null; }
}

function writeCache(file, data) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(path.join(CACHE_DIR, file), JSON.stringify(data), 'utf-8');
  } catch (e) { console.warn('[Cache]', file, e.message); }
}

// ── IPC: aumentos ARAM CAOS — dinámico + caché por versión ───
const BLITZ_HEADERS = {
  'accept': '*/*', 'origin': 'https://blitz.gg', 'referer': 'https://blitz.gg/',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
};

function buildAugmentMap(raw) {
  const map = {};
  const arr = Array.isArray(raw) ? raw : (raw.augments || raw.data || Object.values(raw));
  arr.forEach(a => {
    if (!a.id) return;
    const rawName  = a.name || '';
    const nameDisp = a.displayName || rawName.replace(/^ARAM_/i,'').replace(/_/g,' ');
    const iconFile = (a.iconLarge || a.iconSmall || '').toLowerCase();
    const iconUrl = iconFile ? AUG_ICON_BASE + iconFile : '';
    const desc = (a.description || '')
      .replace(/<keywordMajor>([\s\S]*?)<\/keywordMajor>/gi, '$1')
      .replace(/<magicDamage>([\s\S]*?)<\/magicDamage>/gi, '$1')
      .replace(/<status>([\s\S]*?)<\/status>/gi, '$1')
      .replace(/<rules>[\s\S]*?<\/rules>/gi, '')
      .replace(/<[^>]+>/g, '')
      .replace(/@[\w.]+@/g, '?')
      .trim();
    map[String(a.id)] = {
      n: nameDisp || String(a.id),
      i: iconUrl,
      r: AUG_RARITY_MAP[a.rareza ?? a.rarity] || '',
      d: desc,
    };
  });
  return map;
}

function cleanAugmentText(text = '') {
  return String(text || '')
    .replace(/<keywordMajor>([\s\S]*?)<\/keywordMajor>/gi, '$1')
    .replace(/<magicDamage>([\s\S]*?)<\/magicDamage>/gi, '$1')
    .replace(/<status>([\s\S]*?)<\/status>/gi, '$1')
    .replace(/<attention>([\s\S]*?)<\/attention>/gi, '$1')
    .replace(/<scale\w+>([\s\S]*?)<\/scale\w+>/gi, '$1')
    .replace(/<healing>([\s\S]*?)<\/healing>/gi, '$1')
    .replace(/<shield>([\s\S]*?)<\/shield>/gi, '$1')
    .replace(/<spellName>([\s\S]*?)<\/spellName>/gi, '$1')
    .replace(/<gold>([\s\S]*?)<\/gold>/gi, '$1')
    .replace(/<speed>([\s\S]*?)<\/speed>/gi, '$1')
    .replace(/<scaleHealth>([\s\S]*?)<\/scaleHealth>/gi, '$1')
    .replace(/<scaleAD>([\s\S]*?)<\/scaleAD>/gi, '$1')
    .replace(/<scaleBonus>([\s\S]*?)<\/scaleBonus>/gi, '$1')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<rules>[\s\S]*?<\/rules>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/@[\w.]+@/g, '?')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildAugmentSetMap(raw) {
  const src = Array.isArray(raw) ? raw : (raw?.augmentSets || raw?.data || raw || {});
  const entries = Array.isArray(src) ? src.map(set => [set.id, set]) : Object.entries(src);
  const map = {};
  entries.forEach(([key, set]) => {
    if (!set) return;
    const id = String(set.id || key || '').trim();
    if (!id) return;
    const tiers = {};
    Object.entries(set.tiers || {}).forEach(([tier, info]) => {
      const tierNum = Number(tier);
      if (!Number.isFinite(tierNum)) return;
      tiers[tierNum] = {
        description: cleanAugmentText(info?.description || ''),
      };
    });
    map[id] = {
      id,
      n: set.name || id,
      d: cleanAugmentText(set.description || ''),
      augments: Array.isArray(set.augments) ? set.augments.map(a => String(a)).filter(Boolean) : [],
      tiers,
      icon: set.icon || '',
    };
  });
  return map;
}

function parseIesdevObjects(raw) {
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.data)) return raw.data;
  if (Array.isArray(raw?.results)) return raw.results;
  if (Array.isArray(raw?.items)) return raw.items;
  if (Array.isArray(raw?.objects)) return raw.objects;
  if (Array.isArray(raw?.rows)) return raw.rows;
  if (raw && typeof raw === 'object') {
    const values = Object.values(raw).filter(v => v && typeof v === 'object');
    if (values.length && values.every(v => !Array.isArray(v))) return values;
  }
  return [];
}

function buildAugmentStatsMap(raw) {
  const map = {};
  parseIesdevObjects(raw).forEach(entry => {
    const id = String(entry?.augment_id || entry?.id || '').trim();
    if (!id) return;
    const stats = entry?.stats || entry;
    map[id] = {
      tier: Number(stats?.tier) || null,
      win_rate: Number(stats?.win_rate) || null,
      num_games: Number(stats?.num_games) || null,
      top_champions: Array.isArray(stats?.top_champions)
        ? stats.top_champions.map(ch => String(ch?.champion_id || '').trim()).filter(Boolean)
        : [],
    };
  });
  return map;
}

function buildAugmentSetStatsMap(raw) {
  const map = {};
  parseIesdevObjects(raw).forEach(entry => {
    const id = String(entry?.augment_set_id || entry?.id || '').trim();
    if (!id) return;
    const stats = entry?.stats || entry;
    map[id] = {
      tier: Number(stats?.tier) || null,
      win_rate: Number(stats?.win_rate) || null,
      num_games: Number(stats?.num_games) || null,
      top_champions: Array.isArray(stats?.top_champions)
        ? stats.top_champions.map(ch => String(ch?.champion_id || '').trim()).filter(Boolean)
        : [],
    };
  });
  return map;
}

ipcMain.handle('get-augments', async () => {
  const patch  = await getCurrentPatch();
  const cached = readCache('augments.json');
  if (cached?.version === patch && Object.keys(cached.data || {}).length > 0) {
    console.log(`[Augments] caché ${patch}: ${Object.keys(cached.data).length} aumentos`);
    return cached.data;
  }

  const [major, minor] = (patch || '16.7').split('.').map(Number);
  const patches = [patch, `${major}.${minor - 1}`, `${major}.${minor - 2}`].filter(Boolean);

  for (const v of patches) {
    const url = `https://utils.iesdev.com/static/json/lol/mayham/${v}/augments_es_es`;
    try {
      console.log(`[Augments] probando ${url}`);
      const map = buildAugmentMap(JSON.parse(await httpsGet(url, BLITZ_HEADERS)));
      if (!Object.keys(map).length) continue;
      writeCache('augments.json', { version: patch || v, data: map });
      console.log(`[Augments] ${Object.keys(map).length} aumentos desde parche ${v}`);
      return map;
    } catch (e) { console.warn(`[Augments] parche ${v} falló:`, e.message); }
  }

  if (Object.keys(cached?.data || {}).length > 0) {
    console.warn('[Augments] usando caché obsoleta'); return cached.data;
  }
  return {};
});

ipcMain.handle('get-augment-sets', async () => {
  const patch = await getCurrentPatch();
  const cached = readCache('augment_sets.json');
  if (cached?.version === patch && Object.keys(cached.data || {}).length > 0) {
    console.log(`[AugmentSets] caché ${patch}: ${Object.keys(cached.data).length} sets`);
    return cached.data;
  }

  const [major, minor] = (patch || '16.7').split('.').map(Number);
  const patches = [patch, `${major}.${minor - 1}`, `${major}.${minor - 2}`].filter(Boolean);

  for (const v of patches) {
    const url = `https://utils.iesdev.com/static/json/lol/mayham/${v}/augment_sets_es_es`;
    try {
      console.log(`[AugmentSets] probando ${url}`);
      const map = buildAugmentSetMap(JSON.parse(await httpsGet(url, BLITZ_HEADERS)));
      if (!Object.keys(map).length) continue;
      writeCache('augment_sets.json', { version: patch || v, data: map });
      console.log(`[AugmentSets] ${Object.keys(map).length} sets desde parche ${v}`);
      return map;
    } catch (e) { console.warn(`[AugmentSets] parche ${v} falló:`, e.message); }
  }

  if (Object.keys(cached?.data || {}).length > 0) {
    console.warn('[AugmentSets] usando caché obsoleta');
    return cached.data;
  }
  return {};
});

async function getTimedCache(file, maxAgeMs) {
  const cached = readCache(file);
  if (cached?.ts && (Date.now() - Number(cached.ts)) < maxAgeMs && Object.keys(cached.data || {}).length > 0) {
    return cached.data;
  }
  return null;
}

ipcMain.handle('get-augment-stats', async () => {
  const fresh = await getTimedCache('augment_stats.json', 1000 * 60 * 60 * 12);
  if (fresh) {
    console.log(`[AugmentStats] caché: ${Object.keys(fresh).length} entradas`);
    return fresh;
  }

  const stale = readCache('augment_stats.json');
  try {
    const raw = JSON.parse(await httpsGet('https://data.v2.iesdev.com/api/v1/query_objects/prod/lol/aram_mayhem_augments', BLITZ_HEADERS));
    const map = buildAugmentStatsMap(raw);
    if (Object.keys(map).length) {
      writeCache('augment_stats.json', { ts: Date.now(), data: map });
      console.log(`[AugmentStats] ${Object.keys(map).length} entradas actualizadas`);
      return map;
    }
  } catch (e) {
    console.warn('[AugmentStats] error:', e.message);
  }

  if (Object.keys(stale?.data || {}).length > 0) {
    console.warn('[AugmentStats] usando caché obsoleta');
    return stale.data;
  }
  return {};
});

ipcMain.handle('get-augment-set-stats', async () => {
  const fresh = await getTimedCache('augment_set_stats.json', 1000 * 60 * 60 * 12);
  if (fresh) {
    console.log(`[AugmentSetStats] caché: ${Object.keys(fresh).length} entradas`);
    return fresh;
  }

  const stale = readCache('augment_set_stats.json');
  try {
    const raw = JSON.parse(await httpsGet('https://data.v2.iesdev.com/api/v1/query_objects/prod/lol/aram_mayhem_augment_sets', BLITZ_HEADERS));
    const map = buildAugmentSetStatsMap(raw);
    if (Object.keys(map).length) {
      writeCache('augment_set_stats.json', { ts: Date.now(), data: map });
      console.log(`[AugmentSetStats] ${Object.keys(map).length} entradas actualizadas`);
      return map;
    }
  } catch (e) {
    console.warn('[AugmentSetStats] error:', e.message);
  }

  if (Object.keys(stale?.data || {}).length > 0) {
    console.warn('[AugmentSetStats] usando caché obsoleta');
    return stale.data;
  }
  return {};
});

// ── IPC: ítems LoL — dinámico desde DDragon + caché ──────────
function buildItemMap(ddData, version) {
  const map = {};
  Object.entries(ddData.data || {}).forEach(([id, item]) => {
    const raw = item.description || '';

    // Extraer bloque de stats (dentro de <stats>...</stats>)
    const statsMatch = raw.match(/<stats>([\s\S]*?)<\/stats>/i);
    const statsHtml  = statsMatch ? statsMatch[1] : '';
    const statsText  = statsHtml
      .replace(/<attention>([\s\S]*?)<\/attention>/gi, '$1')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .split('\n').map(l => l.trim()).filter(Boolean)
      .map(l => `• ${l}`).join('\n');

    // Extraer cuerpo principal (fuera de <stats>)
    const mainText = raw
      .replace(/<mainText>|<\/mainText>/gi, '')
      .replace(/<stats>[\s\S]*?<\/stats>/gi, '')
      .replace(/<passive>([\s\S]*?)<\/passive>/gi, '\nPasiva: $1')
      .replace(/<active>([\s\S]*?)<\/active>/gi,  '\nActiva: $1')
      .replace(/<attention>([\s\S]*?)<\/attention>/gi, '$1')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    map[id] = {
      n: item.name || '',
      p: item.gold?.total ?? 0,
      i: `https://ddragon.leagueoflegends.com/cdn/${version}/img/item/${item.image?.full || id + '.png'}`,
      s: statsText,   // "• 45 de daño de ataque\n• 40% de velocidad de ataque"
      f: mainText,    // "Pasiva: La práctica hace al asesino\nAl atacar..."
    };
  });
  return map;
}

ipcMain.handle('get-items-dynamic', async () => {
  let fullVersion = null;
  try { fullVersion = JSON.parse(await httpsGet(VERSIONS_URL))[0]; }
  catch (e) { console.warn('[Items] versión:', e.message); }

  const cached = readCache('items.json');
  if (cached?.version === fullVersion && Object.keys(cached.data || {}).length > 0) {
    console.log(`[Items] caché ${fullVersion}: ${Object.keys(cached.data).length} ítems`);
    return cached.data;
  }

  const versionsToTry = fullVersion ? [fullVersion] : ['16.7.1', '16.6.1'];
  for (const v of versionsToTry) {
    const url = `https://ddragon.leagueoflegends.com/cdn/${v}/data/es_ES/item.json`;
    try {
      console.log(`[Items] descargando ${url}`);
      const raw = JSON.parse(await httpsGet(url));
      const map = buildItemMap(raw, v);
      if (!Object.keys(map).length) continue;
      writeCache('items.json', { version: fullVersion || v, data: map });
      console.log(`[Items] ${Object.keys(map).length} ítems desde DDragon ${v}`);
      return map;
    } catch (e) { console.warn(`[Items] versión ${v} falló:`, e.message); }
  }

  if (Object.keys(cached?.data || {}).length > 0) {
    console.warn('[Items] usando caché obsoleta'); return cached.data;
  }
  return {};
});


// ── IPC: detalle de partida individual (LCU) ─────────────────
ipcMain.handle('get-items', () => {
  const filePath = path.join(ROOT_DIR, 'objetos', 'objetos_lol_es.json');
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  const items = {};

  raw.forEach(item => {
    const pasivas = [];

    // Añadir descripciones de stats como primeras entradas
    [item.descripcion, item.descripcion2, item.descripcion3, item.descripcion4]
      .filter(d => d && d.trim() !== '')
      .forEach(d => pasivas.push({ t: '', d: d }));

    // Añadir pasivas/activas
    let i = 1;
    while (item[`pasiva${i}_titulo`] !== undefined) {
      const titulo = item[`pasiva${i}_titulo`] || '';
      const desc   = item[`pasiva${i}_descripcion`] || '';
      if (titulo || desc) pasivas.push({ t: titulo, d: desc });
      i++;
    }

    items[item.id] = {
      n: item.nombre,
      p: item.precio_total,
      f: pasivas,
      i: item.imagen
    };
  });

  return items;
});

ipcMain.handle('close-loading-btn', () => {
  if (win) {
    app._quitting = true;
    app.quit();
  }
});

// IPC legacy: si algún renderer antiguo lo llama, cerramos la app
ipcMain.on('close-loading', () => {
  app._quitting = true;
  app.quit();
});

// ── Escribir item sets como archivos JSON en carpeta del cliente ──
ipcMain.handle('write-amo-item-sets', async (_, { sets }) => {
  try {
    // Rutas conocidas donde League guarda los Recommended item sets
    const candidates = [
      'C:\\Riot Games\\League of Legends\\Config\\Global\\Recommended',
      path.join('C:\\', 'Riot Games', 'League of Legends', 'Config', 'Global', 'Recommended'),
    ];

    // Intentar obtener la ruta real via LCU
    try {
      const creds = await getLcuCredentials();
      if (creds) {
        const gamePath = await lcuRequest(creds.port, creds.token, '/lol-patch/v1/game-path');
        if (gamePath && typeof gamePath === 'string') {
          const clean = gamePath.replace(/"/g, '').replace(/\//g, '\\');
          candidates.unshift(path.join(clean, 'Config', 'Global', 'Recommended'));
        }
      }
    } catch {}

    // Usar la primera ruta que exista
    let targetDir = null;
    for (const c of candidates) {
      if (fs.existsSync(c)) { targetDir = c; break; }
    }
    // Si no existe ninguna, crearla en la ruta principal
    if (!targetDir) {
      targetDir = candidates[candidates.length - 1];
      fs.mkdirSync(targetDir, { recursive: true });
    }

    // Borrar archivos !!!blitz-* y !!!amo-* anteriores
    fs.readdirSync(targetDir).forEach(file => {
      if ((file.startsWith('!!!blitz-') || file.startsWith('!!!amo-')) && file.endsWith('.json')) {
        try { fs.unlinkSync(path.join(targetDir, file)); } catch {}
      }
    });

    // Escribir nuevos archivos !!!amo-N.json
    sets.forEach((set, i) => {
      const filePath = path.join(targetDir, `!!!amo-${i}.json`);
      fs.writeFileSync(filePath, JSON.stringify(set), 'utf-8');
    });

    console.log(`[AmoSets] ${sets.length} archivos escritos en ${targetDir}`);
    return { ok: true, count: sets.length, dir: targetDir };
  } catch(e) {
    console.error('[AmoSets] error:', e.message);
    return { error: e.message };
  }
});

// ── IPC: escanear packs de tiers ─────────────────────────────
ipcMain.handle('get-tier-packs', () => {
  const tiersDir = path.join(BASE, 'img', 'tiers');
  try {
    const files = fs.readdirSync(tiersDir);
    const packs = {};
    files.forEach(f => {
      const match = f.match(/^tier(\d)(.*)\.png$/i);
      if (!match) return;
      const num  = match[1];
      const name = match[2] || 'Default';
      if (!packs[name]) packs[name] = {};
      packs[name][num] = pathToFileURL(path.join(tiersDir, f)).href;
    });
    // Solo packs con los 5 tiers completos
    const valid = {};
    Object.entries(packs).forEach(([name, tiers]) => {
      if (['1','2','3','4','5'].every(n => tiers[n])) valid[name] = tiers;
    });
    console.log('[TierPacks]', Object.keys(valid).length, 'packs:', Object.keys(valid));
    return valid;
  } catch(e) {
    console.error('[TierPacks] error:', e.message);
    return {};
  }
});

ipcMain.handle('overlay-set-pack', (_, { pack, name }) => {
  console.log('[TierPacks] recibido pack:', name, Object.keys(pack));
  if (overlayWin) overlayWin.webContents.send('overlay-pack', pack);
  try {
    const packFile = APP_TIER_PACK_FILE;
    fs.writeFileSync(packFile, JSON.stringify({ name, pack }), 'utf-8');
    console.log('[TierPacks] guardado en:', packFile);
    // Verificar que se escribió
    const verify = JSON.parse(fs.readFileSync(packFile, 'utf-8'));
    console.log('[TierPacks] verificación:', verify.name, Object.keys(verify.pack));
  } catch(e) {
    console.error('[TierPacks] ERROR guardando:', e.message);
  }
});

// ── IPC: guardar detalle de múltiples partidas (batch al actualizar historial) ──
ipcMain.handle('save-local-match-details-batch', async (_, { gameIds }) => {
  try {
    const histDir = APP_HISTORY_DIR;
    if(!fs.existsSync(histDir)) fs.mkdirSync(histDir, { recursive: true });

    // Filtrar las que ya existen para no reprocesarlas
    const pendientes = gameIds.filter(id => {
      return !fs.existsSync(path.join(histDir, `${id}.json`));
    });

    if(pendientes.length === 0) return { saved: 0, skipped: gameIds.length };

    const creds = await getLcuCredentials();
    if(!creds) return { error: 'client_closed' };

    let saved = 0;
    for(const gameId of pendientes){
      try {
        const data = await lcuRequestWithRetry(
          creds.port, creds.token,
          `/lol-match-history/v1/games/${gameId}`
        );
        if(!data || data.errorCode || data.httpStatus) continue;

        // Reutilizar la misma lógica de normalización
        const participants = data.participants || [];
        const identities   = data.participantIdentities || [];
        const rawTeams     = data.teams || [];

        const nameMap = {}; const tagMap = {}; const puuidMap = {};
        identities.forEach(pi => {
          const pid = pi.participantId; const player = pi.player || {};
          const name = player.gameName || player.summonerName || player.riotIdGameName || '';
          const tag  = player.tagLine  || player.riotIdTagline || '';
          const puuid = player.puuid   || '';
          if(name) nameMap[pid] = name;
          if(tag)  tagMap[pid]  = tag;
          if(puuid) puuidMap[pid] = puuid;
        });

        const normalizeWinFlag = (value, fallback = false) => {
          if(value === true || value === false) return value;
          if(typeof value === 'string'){
            const v = value.trim().toLowerCase();
            if(['win','won','true','victory'].includes(v)) return true;
            if(['fail','loss','lose','lost','false','defeat'].includes(v)) return false;
          }
          if(typeof value === 'number') return value !== 0;
          return fallback;
        };

        const allDmg = participants.map(p => p.stats?.totalDamageDealtToChampions || 0);
        const maxDmg = Math.max(...allDmg, 1);

        const teams = {};
        participants.forEach(p => {
          const tid = p.teamId || 100; const stats = p.stats || {};
          const riotIdGameName = nameMap[p.participantId] || p.player?.gameName || p.player?.summonerName || '';
          const riotIdTagline  = tagMap[p.participantId]  || p.player?.tagLine  || '';
          if(!teams[tid]){
            const teamMeta = rawTeams.find(t => (t.teamId || t.id) === tid) || {};
            const towerKills = teamMeta.towerKills ?? teamMeta.objectives?.tower?.kills ?? teamMeta.objectives?.turret?.kills ?? null;
            teams[tid] = {
              teamId: tid,
              win: normalizeWinFlag(teamMeta.win ?? teamMeta.isWinner ?? teamMeta.winner, normalizeWinFlag(stats.win, false)),
              towerKills, objectives: teamMeta.objectives || null, participants: []
            };
          }
          teams[tid].participants.push({
            participantId: p.participantId,
            puuid: puuidMap[p.participantId] || p.player?.puuid || '',
            summonerName: riotIdGameName, riotIdGameName, riotIdTagline,
            championId: p.championId, championName: p.championName || '',
            championLevel: stats.champLevel || 0,
            spell1Id: p.spell1Id, spell2Id: p.spell2Id,
            kills: stats.kills||0, deaths: stats.deaths||0, assists: stats.assists||0,
            tripleKills: stats.tripleKills||0, quadraKills: stats.quadraKills||0, pentaKills: stats.pentaKills||0,
            totalDamageDealtToChampions: stats.totalDamageDealtToChampions||0,
            totalDamageTaken: stats.totalDamageTaken||0, totalHeal: stats.totalHeal||0,
            goldEarned: stats.goldEarned||0, turretKills: stats.turretKills||0, turretTakedowns: stats.turretTakedowns||0,
            item0:stats.item0,item1:stats.item1,item2:stats.item2,item3:stats.item3,item4:stats.item4,item5:stats.item5,item6:stats.item6,
            perk0:stats.perk0,perk1:stats.perk1,perk2:stats.perk2,perk3:stats.perk3,perk4:stats.perk4,perk5:stats.perk5,
            playerAugment1:stats.playerAugment1,playerAugment2:stats.playerAugment2,
            playerAugment3:stats.playerAugment3,playerAugment4:stats.playerAugment4,
            playerAugment5:stats.playerAugment5,playerAugment6:stats.playerAugment6,
          });
        });

        const getMapVariantInfo = (d) => { try { return require('./main.js').getMapVariantInfo?.(d) || {name:''}; } catch{ return {name:''}; } };

        const result = {
          gameId,
          teams: Object.values(teams),
          maxDmg,
          gameCreation: data.gameCreation || data.gameCreationDate || 0,
          gameDuration: data.gameDuration || data.gameLength || 0,
          queueId: data.queueId || 0,
          mapId:   data.mapId   || 0,
          gameMode: data.gameMode || '',
          gameModeMutators: Array.isArray(data.gameModeMutators) ? data.gameModeMutators.filter(Boolean) : [],
        };

        fs.writeFileSync(path.join(histDir, `${gameId}.json`), JSON.stringify(result), 'utf-8');
        saved++;
        console.log(`[LocalHistory] batch guardada ${saved}/${pendientes.length}: ${gameId}`);
      } catch(e){
        console.error(`[LocalHistory] error en ${gameId}:`, e.message);
      }
    }
    return { saved, skipped: gameIds.length - pendientes.length };
  } catch(e){
    console.error('[LocalHistory] batch error:', e.message);
    return { error: e.message };
  }
});

// ── IPC: leer detalle de partida desde historial local ────────
ipcMain.handle('load-local-match-detail', async (_, { gameId }) => {
  try {
    const filePath = path.join(APP_HISTORY_DIR, `${gameId}.json`);
    if(!fs.existsSync(filePath)) return { error: 'not_found' };
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return data;
  } catch(e){
    console.error('[LocalHistory] error leyendo:', e.message);
    return { error: e.message };
  }
});

ipcMain.handle('save-setting', (_, { key, value }) => {
  try {
    const settingsPath = APP_SETTINGS_FILE;
    let settings = {};
    if (fs.existsSync(settingsPath)) {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    }
    settings[key] = value;
    fs.writeFileSync(settingsPath, JSON.stringify(settings), 'utf-8');
    console.log(`[Settings] ${key} = ${value}`);

    // Si cambia overlay o skillOverlay, ajustar WindowMode inmediatamente
    if (key === 'overlay' || key === 'skillOverlay') {
      const overlayOn      = key === 'overlay'      ? value : (settings.overlay      !== false);
      const skillOverlayOn = key === 'skillOverlay' ? value : (settings.skillOverlay !== false);
      applyWindowModeForOverlay(overlayOn, skillOverlayOn);
    }
  } catch(e) {
    console.error('[Settings] error:', e.message);
  }
});

ipcMain.handle('set-autostart', (_, enable) => {
  app.setLoginItemSettings({ openAtLogin: !!enable });
  return app.getLoginItemSettings().openAtLogin;
});

ipcMain.handle('download-update', () => {
  if (app.isPackaged) autoUpdater.downloadUpdate();
});

ipcMain.handle('get-version', () => app.getVersion());

// Login con Google
ipcMain.handle('supabase-google-login', async () => {
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: 'http://localhost:3000'
    }
  });
  if (error) return { error: error.message };
  const { shell } = require('electron');
  shell.openExternal(data.url);
  return { ok: true };
});

// Obtener sesión actual
ipcMain.handle('supabase-get-session', async () => {
  const { data, error } = await supabase.auth.getSession();
  if (error) return { error: error.message };
  return { session: data.session };
});

// Cerrar sesión
ipcMain.handle('supabase-logout', async () => {
  const { error } = await supabase.auth.signOut();
  if (error) return { error: error.message };
  return { ok: true };
});

// ══ AMO POINTS — Supabase ══
ipcMain.handle('amo-get', async (_, { puuid }) => {
  try {
    const { data, error } = await supabase
      .from('amo_data')
      .select('*')
      .eq('riot_puuid', puuid)
      .maybeSingle();
    if (error) { console.error('[AMO] get error:', error); return null; }
    return data;
  } catch(e) { console.error('[AMO] get exception:', e); return null; }
});

ipcMain.handle('amo-upsert', async (_, { puuid, data }) => {
  try {
    const { error } = await supabase
      .from('amo_data')
      .upsert({
        riot_puuid:      puuid,
        points:          data.points,
        reward_ledger:   data.reward_ledger,
        unlocked_themes: data.unlocked_themes,
        unlocked_packs:  data.unlocked_packs,
        quests_data:     data.quests_data,
        summoner_name:   data.summoner_name || null,
        updated_at:      new Date().toISOString()
      }, { onConflict: 'riot_puuid' });
    if (error) { console.error('[AMO] upsert error:', error); return false; }
    return true;
  } catch(e) { console.error('[AMO] upsert exception:', e); return false; }
});

// Sincronizar cuentas LoL a Supabase
ipcMain.handle('supabase-sync-accounts', async (_, { userId, accounts }) => {
  for (const acc of accounts) {
    const { error } = await supabase.from('lol_accounts').upsert({
      user_id: userId,
      puuid: acc.puuid,
      summoner_id: acc.summonerId || null,
      name: acc.name,
      tag: acc.tag,
      level: acc.level || null,
      icon_id: acc.iconId || null,
      server: acc.server || 'EUW',
      active: acc.active || false
    }, { onConflict: 'user_id,puuid' });
    if (error) console.error('[Supabase] error sync cuenta:', error.message);
  }
  return { ok: true };
});

// ── Obtener perfil desde Supabase ────────────────────────────
ipcMain.handle('supabase-get-profile', async (_, { name, tag }) => {
  const { data, error } = await supabase
    .from('player_profiles')
    .select('*')
    .eq('name', name)
    .eq('tag', tag)
    .single();
  if (error || !data) return { notFound: true };
  return { profile: data };
});

// ── Guardar/actualizar perfil en Supabase ────────────────────
ipcMain.handle('supabase-upsert-profile', async (_, { name, tag, profileData }) => {
  const { error } = await supabase
    .from('player_profiles')
    .upsert({
      puuid:      profileData.puuid,
      name,
      tag,
      data:       profileData,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'puuid' });
  if (error) {
    console.error('[Supabase] error upsert profile:', error.message);
    return { error: error.message };
  }
  return { ok: true };
});

// Sincronizar historial a Supabase
ipcMain.handle('supabase-sync-history', async (_, { userId, matches }) => {
  const fullRows = matches.map(m => ({
    user_id: userId,
    puuid: m._puuid || '',
    game_id: String(m._gameId || m.gameId || ''),
    champion: m.c || null,
    champion_id: m._champId || null,
    result: m.r || null,
    kills: m.k ? parseInt(m.k.split('/')[0]) : null,
    deaths: m.k ? parseInt(m.k.split('/')[1]) : null,
    assists: m.k ? parseInt(m.k.split('/')[2]) : null,
    damage: m._dmg || null,
    queue_id: m._queueId || null,
    modo: m._modo || null,
    duration: m._dur || null,
    ts: m._ts || null,
    augments: m._augments || null,
    items: m._items || null,
    gold: m._gold || null,
    damage_taken: m._taken || null,
    map_name: m._mapa || null,
    spell1_id: m._spell1 || null,
    spell2_id: m._spell2 || null,
    champion_level: m._level || null,
  }));

  let { error } = await supabase.from('match_history').upsert(fullRows, {
    onConflict: 'user_id,game_id'
  });

  if (error) {
    const legacyRows = fullRows.map((row) => ({
      user_id: row.user_id,
      puuid: row.puuid,
      game_id: row.game_id,
      champion: row.champion,
      result: row.result,
      kills: row.kills,
      deaths: row.deaths,
      assists: row.assists,
      damage: row.damage,
      queue_id: row.queue_id,
      modo: row.modo,
      duration: row.duration,
      ts: row.ts,
      augments: row.augments,
    }));

    const retry = await supabase.from('match_history').upsert(legacyRows, {
      onConflict: 'user_id,game_id'
    });
    error = retry.error || null;
    if (retry.error) {
      console.error('[Supabase] error sync historial:', retry.error.message);
    } else {
      console.warn('[Supabase] historial sincronizado en modo legacy; faltan columnas nuevas en match_history');
    }
  }

  return { ok: true };
});

// ── CD de actualización de perfil ────────────────────────────
ipcMain.handle('perfil-cd-get', (_, key) => {
  try {
    const p = APP_PERFIL_CD_FILE;
    if(!fs.existsSync(p)) return 0;
    const obj = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return obj[key] || 0;
  } catch(e){ return 0; }
});

ipcMain.handle('perfil-cd-set', (_, key) => {
  try {
    const p = APP_PERFIL_CD_FILE;
    let obj = {};
    if(fs.existsSync(p)) obj = JSON.parse(fs.readFileSync(p, 'utf-8'));
    obj[key] = Date.now();
    fs.writeFileSync(p, JSON.stringify(obj), 'utf-8');
    return true;
  } catch(e){ return false; }
});

// ── Live Game: obtener partida activa + datos deeplol ─────────
ipcMain.handle('lcu-get-live-game', async (_, { summonerId, puuid: argPuuid }) => {
  console.log('[LG ARGS] summonerId:', summonerId, 'puuid:', argPuuid);
  const fetch = (...args) => import('node-fetch').then(m => m.default(...args));

  try {
    let game = null;
    let mainPuuid = argPuuid || null;

    // 1. Intentar LCU si el cliente está abierto (solo funciona para TU cuenta)
    if (summonerId) {
      try {
        const creds = await getLcuCredentials();
        if (creds) {
          const lcuGame = await lcuRequest(creds.port, creds.token,
            `/lol-spectator/v2/spectate/active-games/by-summoner/${summonerId}`);
          if (lcuGame && !lcuGame.httpStatus) game = lcuGame;
        }
      } catch(e) {}
    }

    // 2. Riot Spectator API pública via proxy (funciona para cualquier jugador)
    if (!game && mainPuuid) {
      try {
        const res = await fetch(
          `https://allmidonly-backend.onrender.com/riot?url=https://euw1.api.riotgames.com/lol/spectator/v5/active-games/by-summoner/${mainPuuid}`,
          { headers: { Accept: 'application/json' } }
        );
        const data = await res.json();
        if (data && !data.status) game = data;
      } catch(e) {}
    }

    if (!game) return { error: 'not_in_game' };

    const participants = game.participants || [];
    const gameId = game.gameId;

    // 3. Enriquecer con rangos via Riot League API (10 llamadas paralelas)
    await Promise.all(participants.map(async (p) => {
      console.log('[PUUIDS]', participants.map(p => p.puuid?.slice(0,15)).join(' | '));
      if (!p.puuid) return;
      try {
        const res = await fetch(
          `https://allmidonly-backend.onrender.com/riot?url=https://euw1.api.riotgames.com/lol/league/v4/entries/by-puuid/${p.puuid}`,
          { headers: { Accept: 'application/json' } }
        );
        const entries = await res.json();
        if (Array.isArray(entries)) {
          p.leagues = entries.map(e => ({
            queueType:    e.queueType,
            tier:         e.tier,
            rank:         e.rank,
            leaguePoints: e.leaguePoints,
            wins:         e.wins,
            losses:       e.losses,
          }));
        }
      } catch(e) {}

      // Parsear riotId si viene como string "nombre#tag"
      if (typeof p.riotId === 'string') {
        const [gameName, tagLine] = p.riotId.split('#');
        p.summonerName = gameName;
        p.riotId = { gameName, tagLine };
      }

      // Las runas ya vienen completas de la Spectator API
      if (p.perks && !p.perks.perkStyle) {
        p.perks = {
          perkStyle:    p.perks.perkStyle    || 0,
          perkSubStyle: p.perks.perkSubStyle || 0,
          perkIds:      p.perks.perkIds      || [],
        };
      }

      // Mapear perks (árbol de runas) desde la Spectator API
      if (p.perks && !p.perks.perkStyle) {
        // Spectator v5: p.perks = { perkIds:[], perkStyle:N, perkSubStyle:N }
        p.perks = {
          perkStyle:    p.perks.perkStyle    || p.perks.style    || 0,
          perkSubStyle: p.perks.perkSubStyle || p.perks.subStyle || 0,
          perkIds:      p.perks.perkIds      || p.perks.ids      || [],
        };
      }
    }));

    // 4. Enriquecer con deeplol
    if (gameId && mainPuuid) {
      try {
        // 4a: obtener puuid de deeplol buscando por nombre#tag del jugador buscado
        const targetName = participants.find(p => p.puuid === mainPuuid)?.riotId?.gameName
          || (typeof participants.find(p => p.puuid === mainPuuid)?.riotId === 'string'
            ? participants.find(p => p.puuid === mainPuuid)?.riotId?.split('#')[0] : null);
        const targetTag = participants.find(p => p.puuid === mainPuuid)?.riotId?.tagLine
          || (typeof participants.find(p => p.puuid === mainPuuid)?.riotId === 'string'
            ? participants.find(p => p.puuid === mainPuuid)?.riotId?.split('#')[1] : null);

        let dlPuuid = null;
        if (targetName && targetTag) {
          const summRes = await fetch(
            `http://127.0.0.1:5123/deeplol-summoner?name=${encodeURIComponent(targetName)}&tag=${encodeURIComponent(targetTag)}&platform_id=EUW1`,
            { headers: { Accept: 'application/json' } }
          );
          const summData = await summRes.json();
          dlPuuid = summData?.summoner_basic_info_dict?.puu_id || null;
          console.log('[DEEPLOL SUMMONER]', targetName, targetTag, '→', dlPuuid?.slice(0,20));
        }

        // 4b: ingame-check con el puuid de deeplol
        let realPuuids = [];
        if (dlPuuid) {
          const checkRes = await fetch(
            `http://127.0.0.1:5123/deeplol-check-ingame?puuid=${encodeURIComponent(dlPuuid)}&platform_id=EUW1`,
            { headers: { Accept: 'application/json' } }
          );
          const checkData = await checkRes.json();
          console.log('[CHECK INGAME]', JSON.stringify(checkData).slice(0, 300));
          realPuuids = (checkData?.participants || []).map(p => p?.puuid || p?.puu_id).filter(Boolean);
        }

        // 4c: probar puuids hasta obtener datos
        let dlList = [];
        const puuidsToTry = realPuuids.length > 0 ? realPuuids : [dlPuuid].filter(Boolean);
        for (const tryPuuid of puuidsToTry) {
          const dlUrl = `http://127.0.0.1:5123/deeplol-ingame?puuid=${encodeURIComponent(tryPuuid)}&platform_id=EUW1&match_id=${gameId}&season=27`;
          const dlRes = await fetch(dlUrl, { headers: { Accept: 'application/json' } });
          const dlData = await dlRes.json();
          if (dlData?.participants_list?.length > 0) {
            dlList = dlData.participants_list;
            break;
          }
        }

        console.log('[DEEPLOL PARTICIPANTS]', dlList.length);
        if (dlList.length > 0) {
          const dlMap = {};
          for (const dp of dlList) {
            if (dp.puu_id) dlMap[dp.puu_id] = dp;
            if (dp.puuid) dlMap[dp.puuid] = dp;
          }
          // Mapa adicional por nombre#tag
          const dlMapByName = {};
          for (const dp of dlList) {
            const key = `${dp.riot_id_name}#${dp.riot_id_tag_line}`.toLowerCase();
            dlMapByName[key] = dp;
          }

          for (const p of participants) {
            const riotIdStr = typeof p.riotId === 'string' ? p.riotId : `${p.riotId?.gameName}#${p.riotId?.tagLine}`;
            const dp = dlMap[p.puuid] || dlMap[p.puu_id] || dlMapByName[riotIdStr?.toLowerCase()];
            if (!dp) continue;

            const posMap = { top:'Top', jungle:'Jungle', middle:'Middle', mid:'Middle', bottom:'Bottom', bot:'Bottom', adc:'Bottom', support:'Support', supporter:'Support', utility:'Support' };
            p.position = dp.position ? (posMap[dp.position.toLowerCase()] || dp.position) : '';
            console.log('[POSITION]', p.riotId, dp.position, '->', p.position);

            const rd = dp.rune_detail_dict;
            if (rd) {
              p.perks = {
                perkStyle:    rd.perk_primary_style || 0,
                perkSubStyle: rd.perk_sub_style || 0,
                perkIds:      [rd.perk_0,rd.perk_1,rd.perk_2,rd.perk_3,rd.perk_4,rd.perk_5].filter(Boolean),
              };
            }

            if (dp.spell_id_dict) {
              p.spell1Id = dp.spell_id_dict.spell_1 || p.spell1Id;
              p.spell2Id = dp.spell_id_dict.spell_2 || p.spell2Id;
            }

            p.aiScore = dp.participant_info?.summoner_info_dict?.ai_score_avg ?? null;
            p.tag = dp.participant_info?.summoner_info_dict?.tag || {};
            p.isMainPosition = dp.participant_info?.summoner_info_dict?.is_main_position ?? false;
            p.mainPosition = dp.participant_info?.summoner_info_dict?.main_position || '';

            const prevSeasons = dp.summoner_data?.summoner_basic_info_dict?.previous_season_tier_list || [];
            const s2025 = prevSeasons.find(s => s.season === 25) || prevSeasons[prevSeasons.length-1] || null;
            p.prevSeason = s2025 ? { tier: s2025.tier, division: s2025.division, lp: s2025.lp } : null;

            const proInfo = dp.summoner_data?.summoner_basic_info_dict?.pro_streamer_info_dict;
            p.proName = proInfo?.name || '';

            const rtSolo = dp.summoner_realtime_data?.season_tier_info_dict?.ranked_solo_5x5;
            if (rtSolo?.tier) {
              p.leagues = [{
                queueType:    'RANKED_SOLO_5x5',
                tier:         rtSolo.tier,
                rank:         ['I','II','III','IV'][rtSolo.division-1] || 'I',
                leaguePoints: rtSolo.league_points,
                wins:         rtSolo.wins,
                losses:       rtSolo.losses,
              }];
            }

            const cs = dp.participant_info?.season_champion_info_dict;
            if (cs && cs.games > 0) {
              p.championStats = {
                games: cs.games,
                wr:    Math.round(cs.win_rate),
                kda:   cs.kda,
              };
            }
          }
        }
      } catch(e) {
        console.warn('[LiveGame] deeplol fallido:', e.message);
      }
    }

    return { game };
  } catch(e) {
    console.error('[LiveGame] error:', e.message);
    return { error: 'not_in_game' };
  }
});

// ── Leer HUD scale del juego ──────────────────────────────────
ipcMain.handle('get-hud-scale', async () => {
  try {
    // Obtener ruta real del juego via LCU
    let gameRoot = 'C:\\Riot Games\\League of Legends';
    try {
      const creds = await getLcuCredentials();
      if (creds) {
        const gamePath = await lcuRequest(creds.port, creds.token, '/lol-patch/v1/game-path');
        if (gamePath && typeof gamePath === 'string') {
          gameRoot = gamePath.replace(/"/g, '').replace(/\//g, '\\');
        }
      }
    } catch {}

    // Rutas candidatas del game.cfg
    const cfgCandidates = [
      path.join(gameRoot, 'Config', 'game.cfg'),
      path.join(os.homedir(), 'AppData', 'Local', 'Riot Games', 'League of Legends', 'Config', 'game.cfg'),
      'C:\\Riot Games\\League of Legends\\Config\\game.cfg',
    ];

    let cfgContent = null;
    for (const p of cfgCandidates) {
      if (fs.existsSync(p)) {
        cfgContent = fs.readFileSync(p, 'utf-8');
        console.log('[HudScale] cfg encontrado en:', p);
        break;
      }
    }

    if (!cfgContent) return { error: 'cfg_not_found' };

    // Parsear HudScale
    const match = cfgContent.match(/GlobalScale\s*=\s*([\d.]+)/i);
    const hudScale = match ? parseFloat(match[1]) : 0.11;
    console.log('[HudScale] GlobalScale:', hudScale, '→ slider:', Math.round(hudScale * 100));
    return { hudScale, sliderValue: Math.round(hudScale * 100) };

  } catch (e) {
    console.error('[HudScale] error:', e.message);
    return { error: e.message };
  }
});
