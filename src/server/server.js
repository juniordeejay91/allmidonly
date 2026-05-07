const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const https = require("https");
const { exec, execFile } = require("child_process");

const PORT = process.env.PORT || 3000;
const ROOT_DIR = path.resolve(__dirname, "..", "..");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const PROXY_SCRIPT = path.join(ROOT_DIR, "scripts", "python", "proxy_riot.py");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

let riotKeyCache = null;

const CHAOS_QUEUE_IDS = new Set([900, 2400, 3270]);
const MAP_NAMES = {
  12: "Abismo de los Lamentos",
  14: "Puente del Carnicero",
};

function readRiotKey() {
  if (riotKeyCache) {
    return riotKeyCache;
  }

  if (process.env.RIOT_KEY && process.env.RIOT_KEY.trim()) {
    riotKeyCache = process.env.RIOT_KEY.trim();
    return riotKeyCache;
  }

  try {
    const proxySource = fs.readFileSync(PROXY_SCRIPT, "utf8");
    const match = proxySource.match(/RIOT_KEY\s*=\s*os\.environ\.get\("RIOT_KEY",\s*"([^"]+)"\)/);
    riotKeyCache = match?.[1]?.trim() || "";
    return riotKeyCache;
  } catch {
    return "";
  }
}

function parseLeagueArgs(stdout) {
  const portMatch = stdout.match(/--app-port=(\d+)/);
  const tokenMatch = stdout.match(/--remoting-auth-token=([\w-]+)/);
  if (!portMatch || !tokenMatch) {
    return null;
  }
  return { port: portMatch[1], token: tokenMatch[1] };
}

function getLcuCredentials() {
  return new Promise((resolve) => {
    execFile(
      "wmic",
      ["PROCESS", "WHERE", "name='LeagueClient.exe'", "GET", "CommandLine", "/FORMAT:LIST"],
      { timeout: 6000 },
      (err, stdout) => {
        if (!err && stdout) {
          const creds = parseLeagueArgs(stdout);
          if (creds) {
            return resolve(creds);
          }
        }

        exec(
          `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"name='LeagueClient.exe'\\" | Select-Object -ExpandProperty CommandLine"`,
          { timeout: 8000 },
          (err2, stdout2) => {
            if (!err2 && stdout2) {
              const creds2 = parseLeagueArgs(stdout2);
              if (creds2) {
                return resolve(creds2);
              }
            }

            exec(
              `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"name='LeagueClientUx.exe'\\" | Where-Object {$_.CommandLine -like '*--app-port=*'} | Select-Object -ExpandProperty CommandLine"`,
              { timeout: 8000 },
              (err3, stdout3) => {
                if (!err3 && stdout3) {
                  const creds3 = parseLeagueArgs(stdout3);
                  if (creds3) {
                    return resolve(creds3);
                  }
                }
                resolve(null);
              }
            );
          }
        );
      }
    );
  });
}

function isChaosGame(game = {}) {
  return CHAOS_QUEUE_IDS.has(game.queueId);
}

function getMapVariantInfo(game = {}) {
  const mapId = game.mapId || 0;
  const mutators = Array.isArray(game.gameModeMutators) ? game.gameModeMutators.filter(Boolean) : [];

  if (mutators.includes("mapskin_ha_bilgewater")) {
    return { key: "mapskin_ha_bilgewater", name: "Puente del Carnicero", mutators };
  }
  if (mutators.includes("mapskin_map12_bloom")) {
    return { key: "mapskin_map12_bloom", name: "Paso de Koeshin", mutators };
  }
  if (mapId === 12) {
    return { key: "default", name: "Abismo de los Lamentos", mutators };
  }

  return {
    key: mapId ? `map_${mapId}` : "unknown",
    name: MAP_NAMES[mapId] || "Mapa desconocido",
    mutators,
  };
}

function lcuRequest(port, token, endpoint) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`riot:${token}`).toString("base64");
    const req = https.request(
      {
        hostname: "127.0.0.1",
        port,
        path: endpoint,
        method: "GET",
        rejectUnauthorized: false,
        headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(null);
          }
        });
      }
    );

    req.on("error", reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.end();
  });
}

async function lcuRequestWithRetry(port, token, endpoint, maxRetries = 3, delayMs = 1500) {
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      return await lcuRequest(port, token, endpoint);
    } catch (error) {
      const isRetryable = error.message === "timeout" || error.code === "ECONNRESET";
      if (!isRetryable || attempt >= maxRetries) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return null;
}

async function readLocalLolSync() {
  const creds = await getLcuCredentials();
  if (!creds) {
    const error = new Error("No se ha detectado el cliente de League of Legends abierto");
    error.status = 404;
    throw error;
  }

  const summoner = await lcuRequestWithRetry(creds.port, creds.token, "/lol-summoner/v1/current-summoner");
  if (!summoner || summoner.errorCode) {
    const error = new Error("No se ha podido leer la cuenta actual del cliente");
    error.status = 502;
    throw error;
  }

  let gameName = summoner.gameName || summoner.displayName || summoner.internalName || "";
  let tagLine = summoner.tagLine || "EUW";

  if (!summoner.gameName) {
    try {
      const session = await lcuRequest(creds.port, creds.token, "/lol-login/v1/session");
      if (session?.username) {
        const parts = session.username.split("#");
        gameName = gameName || parts[0] || "";
        tagLine = tagLine === "EUW" ? parts[1] || tagLine : tagLine;
      }
    } catch {}
  }

  const historyResponse = await lcuRequestWithRetry(
    creds.port,
    creds.token,
    `/lol-match-history/v1/products/lol/${summoner.puuid}/matches?begIndex=0&endIndex=99`
  );

  const allGames = historyResponse?.games?.games || [];
  const excludedQueues = new Set([0, 3100, 3120]);
  const games = allGames
    .filter((game) => {
      const gameType = String(game.gameType || "").toUpperCase();
      if (gameType === "CUSTOM_GAME" || gameType === "PRACTICE_GAME" || gameType === "TUTORIAL_GAME") {
        return false;
      }
      if (excludedQueues.has(game.queueId)) {
        return false;
      }
      return true;
    })
    .slice(0, 99)
    .map((game) => {
      const me = (game.participants || []).find((participant) => participant.puuid === summoner.puuid) || game.participants?.[0];
      const stats = me?.stats || {};
      const durationMinutes = Math.round((game.gameDuration || 0) / 60);
      const timestamp = game.gameCreationDate ? new Date(game.gameCreationDate).getTime() : game.gameCreation || 0;
      const championId = me?.championId || me?.champion?.id || me?.champion?.championId || null;
      const championName =
        me?.championName || me?.champion?.name || me?.champion?.alias || me?.skinName || (championId ? `Campeón ${championId}` : "?");
      const queueId = game.queueId || 0;
      const mapInfo = getMapVariantInfo(game);
      const augmentIds = [
        stats.playerAugment1,
        stats.playerAugment2,
        stats.playerAugment3,
        stats.playerAugment4,
        stats.playerAugment5,
        stats.playerAugment6,
      ].filter((value) => Number(value) > 0);

      return {
        puuid: summoner.puuid,
        gameId: String(game.gameId || ""),
        champion: championName,
        championId,
        result: stats.win ? "Victoria" : "Derrota",
        kills: Number(stats.kills || 0),
        deaths: Number(stats.deaths || 0),
        assists: Number(stats.assists || 0),
        damage: Number(stats.totalDamageDealtToChampions || 0),
        queueId,
        mode: isChaosGame(game)
          ? "ARAM: Caos"
          : queueId === 450
            ? "ARAM"
            : queueId === 420
              ? "Clasificatoria Solo/Dúo"
              : queueId === 440
                ? "Clasificatoria Flex"
                : game.gameMode || "Otro",
        duration: `${durationMinutes}m`,
        timestamp,
        mapName: mapInfo.name,
        items: [
          stats.item0,
          stats.item1,
          stats.item2,
          stats.item3,
          stats.item4,
          stats.item5,
          stats.item6,
        ].filter((value) => value !== undefined && value !== null),
        gold: Number(stats.goldEarned || 0),
        damageTaken: Number(stats.totalDamageTaken || 0),
        augments: augmentIds,
      };
    })
    .filter((game) => game.gameId);

  return {
    account: {
      puuid: summoner.puuid,
      summonerId: summoner.summonerId || null,
      name: gameName,
      tag: tagLine,
      level: summoner.summonerLevel,
      iconId: summoner.profileIconId,
      server: "EUW",
      active: true,
    },
    matches: games,
  };
}

async function riotFetch(url) {
  const riotKey = readRiotKey();

  if (!riotKey) {
    const error = new Error("No se ha encontrado la API key de Riot");
    error.status = 500;
    throw error;
  }

  const response = await fetch(url, {
    headers: {
      "X-Riot-Token": riotKey,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    const error = new Error(body || `Riot API error ${response.status}`);
    error.status = response.status;
    throw error;
  }

  return response.json();
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function computeAramSummary(matches, puuid) {
  const relevant = matches
    .map((match) => {
      const participant = match?.info?.participants?.find((entry) => entry.puuid === puuid);
      return participant ? { match, participant } : null;
    })
    .filter(Boolean);

  if (!relevant.length) {
    return {
      games: 0,
      wins: 0,
      winRate: 0,
      avgKills: 0,
      avgDeaths: 0,
      avgAssists: 0,
      avgKda: 0,
      avgDamage: 0,
      avgGold: 0,
      mostPlayedChampionId: null,
      mostPlayedChampionName: null,
    };
  }

  let wins = 0;
  let kills = 0;
  let deaths = 0;
  let assists = 0;
  let damage = 0;
  let gold = 0;
  const champCount = new Map();

  for (const { participant } of relevant) {
    wins += participant.win ? 1 : 0;
    kills += participant.kills || 0;
    deaths += participant.deaths || 0;
    assists += participant.assists || 0;
    damage += participant.totalDamageDealtToChampions || 0;
    gold += participant.goldEarned || 0;
    champCount.set(
      participant.championName,
      (champCount.get(participant.championName) || 0) + 1
    );
  }

  const [mostPlayedChampionName] = [...champCount.entries()].sort((a, b) => b[1] - a[1])[0] || [null];
  const firstMostPlayed = relevant.find(
    ({ participant }) => participant.championName === mostPlayedChampionName
  )?.participant;

  const games = relevant.length;
  const avgKills = kills / games;
  const avgDeaths = deaths / games;
  const avgAssists = assists / games;

  return {
    games,
    wins,
    winRate: Math.round((wins / games) * 100),
    avgKills: Number(avgKills.toFixed(1)),
    avgDeaths: Number(avgDeaths.toFixed(1)),
    avgAssists: Number(avgAssists.toFixed(1)),
    avgKda: Number(((avgKills + avgAssists) / Math.max(avgDeaths, 1)).toFixed(2)),
    avgDamage: Math.round(damage / games),
    avgGold: Math.round(gold / games),
    mostPlayedChampionId: firstMostPlayed?.championId || null,
    mostPlayedChampionName: mostPlayedChampionName || null,
  };
}

async function handleSummonerApi(requestUrl, response) {
  const name = requestUrl.searchParams.get("name")?.trim() || "";
  const tag = requestUrl.searchParams.get("tag")?.trim() || "";

  if (!name || !tag) {
    sendJson(response, 400, { error: "Debes indicar nombre y tag" });
    return;
  }

  try {
    const account = await riotFetch(
      `https://europe.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`
    );

    const [summoner, ranks, mastery, matchIds] = await Promise.all([
      riotFetch(`https://euw1.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${account.puuid}`),
      riotFetch(`https://euw1.api.riotgames.com/lol/league/v4/entries/by-puuid/${account.puuid}`).catch(() => []),
      riotFetch(
        `https://euw1.api.riotgames.com/lol/champion-mastery/v4/champion-masteries/by-puuid/${account.puuid}/top?count=7`
      ).catch(() => []),
      riotFetch(
        `https://europe.api.riotgames.com/lol/match/v5/matches/by-puuid/${account.puuid}/ids?queue=450&start=0&count=10`
      ).catch(() => []),
    ]);

    const matches = await Promise.all(
      matchIds.map((matchId) =>
        riotFetch(`https://europe.api.riotgames.com/lol/match/v5/matches/${matchId}`).catch(() => null)
      )
    );

    const cleanMatches = matches.filter(Boolean);
    const soloq = ranks.find((entry) => entry.queueType === "RANKED_SOLO_5x5") || null;
    const flex = ranks.find((entry) => entry.queueType === "RANKED_FLEX_SR") || null;

    const payload = {
      account: {
        puuid: account.puuid,
        gameName: account.gameName,
        tagLine: account.tagLine,
        summonerLevel: summoner.summonerLevel,
        profileIconId: summoner.profileIconId,
      },
      ranks: {
        soloq,
        flex,
      },
      mastery: mastery.map((entry) => ({
        championId: entry.championId,
        championLevel: entry.championLevel,
        championPoints: entry.championPoints,
      })),
      summary: computeAramSummary(cleanMatches, account.puuid),
      matches: cleanMatches.map((match) => {
        const participant = match.info.participants.find((entry) => entry.puuid === account.puuid);
        return {
          metadata: {
            matchId: match.metadata.matchId,
          },
          info: {
            gameCreation: match.info.gameCreation,
            gameDuration: match.info.gameDuration,
            queueId: match.info.queueId,
          },
          participant: {
            championId: participant.championId,
            championName: participant.championName,
            kills: participant.kills,
            deaths: participant.deaths,
            assists: participant.assists,
            totalDamageDealtToChampions: participant.totalDamageDealtToChampions,
            goldEarned: participant.goldEarned,
            win: participant.win,
          },
        };
      }),
    };

    sendJson(response, 200, payload);
  } catch (error) {
    sendJson(response, error.status || 500, {
      error: "No se pudo consultar el invocador",
      detail: String(error.message || error),
    });
  }
}

async function handleLocalSyncApi(response) {
  try {
    const payload = await readLocalLolSync();
    sendJson(response, 200, payload);
  } catch (error) {
    sendJson(response, error.status || 500, {
      error: "No se pudo sincronizar con el cliente local",
      detail: String(error.message || error),
    });
  }
}

function resolveFilePath(urlPath) {
  const cleanPath = urlPath === "/" ? "/index.html" : urlPath;
  const decodedPath = decodeURIComponent(cleanPath.split("?")[0]);
  const assetRoots = [
    { prefix: "/assets/", baseDir: path.join(ROOT_DIR, "assets") },
    { prefix: "/img/", baseDir: path.join(ROOT_DIR, "img") },
  ];

  for (const assetRoot of assetRoots) {
    if (decodedPath === assetRoot.prefix || decodedPath.startsWith(assetRoot.prefix)) {
      const relativeAssetPath =
        decodedPath === assetRoot.prefix
          ? path.basename(decodedPath)
          : decodedPath.slice(assetRoot.prefix.length);
      const assetPath = path.normalize(path.join(assetRoot.baseDir, relativeAssetPath));

      if (assetPath.startsWith(assetRoot.baseDir)) {
        return assetPath;
      }

      return null;
    }
  }

  const targetPath = path.normalize(path.join(PUBLIC_DIR, decodedPath));

  if (!targetPath.startsWith(PUBLIC_DIR)) {
    return null;
  }

  return targetPath;
}

const server = http.createServer((request, response) => {
  const requestUrl = new URL(request.url || "/", `http://${request.headers.host || `localhost:${PORT}`}`);

  if (request.method === "GET" && requestUrl.pathname === "/api/summoner") {
    handleSummonerApi(requestUrl, response);
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/local-sync") {
    handleLocalSyncApi(response);
    return;
  }

  const filePath = resolveFilePath(requestUrl.pathname);

  if (!filePath) {
    response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Acceso denegado");
    return;
  }

  fs.stat(filePath, (statError, stats) => {
    if (statError || !stats.isFile()) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("No encontrado");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";

    response.writeHead(200, { "Content-Type": contentType });
    fs.createReadStream(filePath).pipe(response);
  });
});

server.listen(PORT, () => {
  console.log(`ARAM CAOS WEB disponible en http://localhost:${PORT}`);
});
