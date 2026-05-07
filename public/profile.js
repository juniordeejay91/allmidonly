const SUPABASE_URL = "https://eoyrxsctnxqilzkrjjzy.supabase.co";
const SUPABASE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVveXJ4c2N0bnhxaWx6a3Jqanp5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcwNTc1OTUsImV4cCI6MjA5MjYzMzU5NX0.eGBjhu6ie7is17gOTz0DV9xOacwegnyk7kDD5kKInOY";

const SPELL_KEY_BY_ID = {
  1: "SummonerBoost",
  3: "SummonerExhaust",
  4: "SummonerFlash",
  6: "SummonerHaste",
  7: "SummonerHeal",
  11: "SummonerSmite",
  12: "SummonerTeleport",
  13: "SummonerMana",
  14: "SummonerDot",
  21: "SummonerBarrier",
  30: "SummonerPoroRecall",
  31: "SummonerPoroThrow",
  32: "SummonerSnowball",
};

const state = {
  session: null,
  user: null,
  accounts: [],
  activeAccount: null,
  history: [],
  augmentTable: null,
  augmentGeneral: null,
  ddVersion: "15.10.1",
  championById: {},
  itemData: {},
};

function getWebBasePath() {
  const parts = window.location.pathname.split("/").filter(Boolean);
  if (window.location.hostname.endsWith("github.io") && parts.length > 0) {
    return `/${parts[0]}`;
  }
  return "";
}

function getWebUrlFor(path = "") {
  const cleanPath = String(path || "").replace(/^\/+/, "");
  return `${window.location.origin}${getWebBasePath()}/${cleanPath}`;
}

function getStoredSession() {
  try {
    return JSON.parse(localStorage.getItem("sb_session") || "null");
  } catch {
    localStorage.removeItem("sb_session");
    return null;
  }
}

async function supabaseRequest(path, options = {}) {
  const session = state.session || getStoredSession();
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_KEY,
      "Content-Type": "application/json",
      ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || `Supabase error ${response.status}`);
  }

  return response.status === 204 ? null : response.json();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString("es-ES");
}

function formatShortDate(value) {
  if (!value) {
    return "-";
  }

  return new Date(value).toLocaleDateString("es-ES", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function formatDateTime(value) {
  if (!value) {
    return "-";
  }

  return new Date(value).toLocaleString("es-ES", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).replace(",", " ·");
}

function communityDragonProfileIcon(iconId) {
  return `https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/profile-icons/${iconId}.jpg`;
}

function championIconUrl(championId) {
  const ddKey = state.championById[String(championId)];
  if (!ddKey) {
    return "";
  }
  return `https://ddragon.leagueoflegends.com/cdn/${state.ddVersion}/img/champion/${ddKey}.png`;
}

function itemIconUrl(itemId) {
  if (!itemId) {
    return "";
  }
  return `https://ddragon.leagueoflegends.com/cdn/${state.ddVersion}/img/item/${itemId}.png`;
}

function spellIconUrl(spellId) {
  const key = SPELL_KEY_BY_ID[Number(spellId)];
  if (!key) {
    return "";
  }
  return `https://ddragon.leagueoflegends.com/cdn/${state.ddVersion}/img/spell/${key}.png`;
}

function formatRelativeMeta(match) {
  return [match.modo, match.duration, formatShortDate(match.ts)].filter(Boolean).join(" · ");
}

function parseAugments(rawAugments) {
  if (!rawAugments) {
    return [];
  }

  if (Array.isArray(rawAugments)) {
    return rawAugments.map(String).filter(Boolean);
  }

  if (typeof rawAugments === "string") {
    try {
      const parsed = JSON.parse(rawAugments);
      return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [rawAugments];
    } catch {
      return rawAugments
        .split(/[,\s|]+/)
        .map((entry) => entry.trim())
        .filter(Boolean);
    }
  }

  return Object.values(rawAugments).map(String).filter(Boolean);
}

function normalizeMatch(match) {
  const scoreParts = typeof match.k === "string" ? match.k.split("/") : [];
  return {
    puuid: match.puuid || match._puuid || "",
    game_id: String(match.game_id || match.gameId || match._gameId || ""),
    champion: match.champion || match.c || null,
    champion_id: match.champion_id || match.championId || match._champId || null,
    result: match.result || match.r || null,
    kills: Number(match.kills ?? scoreParts[0] ?? 0),
    deaths: Number(match.deaths ?? scoreParts[1] ?? 0),
    assists: Number(match.assists ?? scoreParts[2] ?? 0),
    damage: Number(match.damage ?? match._dmg ?? 0),
    queue_id: match.queue_id || match.queueId || match._queueId || null,
    modo: match.modo || match.mode || match._modo || null,
    duration: match.duration || match._dur || match.d || null,
    ts: match.ts || match.timestamp || match._ts || null,
    augments: match.augments || match._augments || [],
    items: match.items || match._items || [],
    gold: Number(match.gold ?? match._gold ?? 0),
    damage_taken: Number(match.damage_taken ?? match._taken ?? 0),
    map_name: match.map_name || match.mapName || match._mapa || null,
    spell1_id: match.spell1_id || match._spell1 || null,
    spell2_id: match.spell2_id || match._spell2 || null,
    champion_level: match.champion_level || match._level || null,
  };
}

function computeSummary(history) {
  if (!history.length) {
    return {
      games: 0,
      wins: 0,
      winRate: 0,
      avgKills: 0,
      avgDeaths: 0,
      avgAssists: 0,
      avgDamage: 0,
      topChampion: null,
      lastMatch: null,
    };
  }

  let wins = 0;
  let kills = 0;
  let deaths = 0;
  let assists = 0;
  let damage = 0;
  const champions = new Map();

  history.forEach((match) => {
    wins += String(match.result || "").toLowerCase().startsWith("v") ? 1 : 0;
    kills += Number(match.kills || 0);
    deaths += Number(match.deaths || 0);
    assists += Number(match.assists || 0);
    damage += Number(match.damage || 0);
    champions.set(match.champion, (champions.get(match.champion) || 0) + 1);
  });

  const sortedChampions = [...champions.entries()].sort((a, b) => b[1] - a[1]);

  return {
    games: history.length,
    wins,
    winRate: Math.round((wins / history.length) * 100),
    avgKills: (kills / history.length).toFixed(1),
    avgDeaths: (deaths / history.length).toFixed(1),
    avgAssists: (assists / history.length).toFixed(1),
    avgDamage: Math.round(damage / history.length),
    topChampion: sortedChampions[0]?.[0] || null,
    lastMatch: history[0] || null,
  };
}

function normalizeRarity(value) {
  const raw = String(value || "").toLowerCase();
  if (raw.includes("prismatic")) {
    return "Prismático";
  }
  if (raw.includes("gold") || raw.includes("dorado")) {
    return "Dorado";
  }
  if (raw.includes("silver") || raw.includes("plateado")) {
    return "Plateado";
  }
  return "Sin rareza";
}

function buildAugmentMetaMap() {
  const itemMap = new Map();

  Object.values(state.augmentTable?.aumentos || {}).forEach((augment) => {
    itemMap.set(String(augment.id), {
      id: String(augment.id),
      name: augment.nombre || `Aumento ${augment.id}`,
      description: augment.descripcion1 || augment.descripcion2 || "",
      icon: augment.icono || "",
      rarity: normalizeRarity(augment.rango),
      tier: augment.tier || null,
    });
  });

  Object.entries(state.augmentGeneral || {}).forEach(([name, info]) => {
    const match = [...itemMap.values()].find((entry) => entry.name === name);
    if (match) {
      match.rarity = normalizeRarity(info.rareza || match.rarity);
      match.tier = info.tier || match.tier;
    }
  });

  return itemMap;
}

function augmentMetaById(augmentId) {
  const metaMap = buildAugmentMetaMap();
  return metaMap.get(String(augmentId)) || {
    id: String(augmentId),
    name: `Aumento ${augmentId}`,
    description: "",
    icon: "",
    rarity: "Sin rareza",
    tier: "?",
  };
}

function aggregateAugments(history) {
  const counts = new Map();

  history.forEach((match) => {
    parseAugments(match.augments).forEach((augmentId) => {
      const key = String(augmentId);
      const current = counts.get(key) || { id: key, uses: 0, wins: 0 };
      current.uses += 1;
      current.wins += String(match.result || "").toLowerCase().startsWith("v") ? 1 : 0;
      counts.set(key, current);
    });
  });

  return [...counts.values()]
    .map((entry) => {
      const meta = augmentMetaById(entry.id);
      return {
        ...entry,
        name: meta.name,
        description: meta.description,
        icon: meta.icon,
        rarity: meta.rarity,
        tier: meta.tier || "?",
        winRate: entry.uses ? Math.round((entry.wins / entry.uses) * 100) : 0,
      };
    })
    .sort((a, b) => b.uses - a.uses);
}

function renderAuthUser() {
  const avatar = document.getElementById("profile-user-avatar");
  const name = document.getElementById("profile-user-name");
  const email = document.getElementById("profile-user-email");
  const user = state.user;

  if (!user) {
    return;
  }

  const meta = user.user_metadata || {};
  if (avatar) {
    avatar.src = meta.avatar_url || "";
    avatar.style.display = meta.avatar_url ? "block" : "none";
  }
  if (name) {
    name.textContent = meta.full_name || user.email || "Usuario";
  }
  if (email) {
    email.textContent = user.email || "Sesión activa";
  }
}

function renderLinkedAccounts() {
  const listNode = document.getElementById("linked-accounts-list");
  const countNode = document.getElementById("linked-accounts-count");

  if (!listNode || !countNode) {
    return;
  }

  countNode.textContent = String(state.accounts.length);

  if (!state.accounts.length) {
    listNode.innerHTML = '<div class="empty-card">Todavía no hay cuentas de LoL sincronizadas con este usuario.</div>';
    return;
  }

  listNode.innerHTML = state.accounts
    .map((account) => {
      const isActive = Boolean(account.active);
      const activeClass = isActive ? " is-active" : "";
      const iconMarkup = account.icon_id
        ? `<img src="${communityDragonProfileIcon(account.icon_id)}" alt="${escapeHtml(account.name)}">`
        : `<div class="linked-account-fallback">${escapeHtml((account.name || "?").slice(0, 2).toUpperCase())}</div>`;

      return `
        <article class="linked-account${activeClass}">
          <div class="linked-account-media">${iconMarkup}</div>
          <div class="linked-account-copy">
            <strong>${escapeHtml(account.name)}<span>#${escapeHtml(account.tag)}</span></strong>
            <span>${escapeHtml(account.server || "EUW")} · Nivel ${escapeHtml(account.level || "-")}</span>
          </div>
          <span class="linked-account-state">${isActive ? "Activa" : "Asociada"}</span>
        </article>
      `;
    })
    .join("");
}

function renderProfileSummary() {
  const content = document.getElementById("profile-summary");
  const statusNode = document.getElementById("profile-status");

  if (!content || !statusNode) {
    return;
  }

  const account = state.activeAccount;
  const summary = computeSummary(state.history);

  if (!account) {
    statusNode.textContent = "No encontramos ninguna cuenta activa enlazada para este usuario.";
    content.classList.add("hidden");
    return;
  }

  statusNode.textContent = `Sincronizado para ${account.name}#${account.tag}`;
  content.classList.remove("hidden");

  document.getElementById("active-account-name").innerHTML =
    `<span class="app-profile-name-text">${escapeHtml(account.name)}</span><span class="app-profile-tag">#${escapeHtml(account.tag)}</span>`;
  document.getElementById("active-account-meta").textContent =
    `SERVIDOR · ${String(account.server || "EUW").toUpperCase()} · ${summary.games} PARTIDAS GUARDADAS`;
  document.getElementById("active-account-level").textContent = account.level || "-";
  document.getElementById("active-account-icon").src = communityDragonProfileIcon(account.icon_id || 29);

  document.getElementById("profile-games").textContent = String(summary.games);
  document.getElementById("profile-winrate").textContent = `${summary.winRate}%`;
  document.getElementById("profile-kda").textContent = `${summary.avgKills} / ${summary.avgDeaths} / ${summary.avgAssists}`;
  document.getElementById("profile-damage").textContent = formatNumber(summary.avgDamage);
  document.getElementById("profile-champion").textContent = (summary.topChampion || "-").toUpperCase();
  document.getElementById("profile-last-match").textContent = summary.lastMatch ? formatShortDate(summary.lastMatch.ts) : "-";

  const highlights = document.getElementById("sync-highlights");
  highlights.innerHTML = [
    `Cuenta activa sincronizada en Supabase.`,
    `${summary.wins} victorias guardadas sobre ${summary.games} partidas ARAM.`,
    `${aggregateAugments(state.history).length} aumentos distintos detectados en el historial.`,
    `Mostrando la última sincronización enviada desde la app.`,
  ]
    .map((line) => `<div class="stack-item">${escapeHtml(line)}</div>`)
    .join("");

  const recentMatches = document.getElementById("profile-recent-matches");
  recentMatches.innerHTML = state.history.length
    ? state.history.slice(0, 5).map((match, index) => renderHistoryEntry(match, true, `recent-${index}`)).join("")
    : '<div class="empty-card">No hay partidas sincronizadas todavía para esta cuenta.</div>';
}

function renderHistoryEntry(match, compact = false, keySuffix = "main") {
  const normalized = normalizeMatch(match);
  const outcome = String(normalized.result || "").toLowerCase().startsWith("v");
  const accentClass = outcome ? "win" : "loss";
  const championIcon = championIconUrl(normalized.champion_id);
  const matchId = `match-${escapeHtml(normalized.game_id)}-${escapeHtml(keySuffix)}`;
  const augments = parseAugments(normalized.augments).slice(0, 6);
  const items = Array.isArray(normalized.items) ? normalized.items.filter(Boolean).slice(0, 7) : [];

  return `
    <article class="web-match-card ${accentClass}${compact ? " compact" : ""}">
      <button class="web-match-summary" type="button" data-match-toggle="${matchId}">
        <div class="web-match-summary-left">
          <div class="web-match-avatar-wrap">
            ${championIcon
              ? `<img class="web-match-avatar" src="${championIcon}" alt="${escapeHtml(normalized.champion || "Campeón")}">`
              : `<div class="match-avatar">${escapeHtml((normalized.champion || "?").slice(0, 2).toUpperCase())}</div>`}
          </div>
          <div class="web-match-main">
            <div class="web-match-title-row">
              <span class="web-match-result ${accentClass}">${outcome ? "Victoria" : "Derrota"}</span>
              <span class="web-match-kda">${normalized.kills} / ${normalized.deaths} / ${normalized.assists}</span>
            </div>
            <div class="web-match-subline">${escapeHtml(normalized.champion || "Campeón")} · ${escapeHtml(formatRelativeMeta(normalized))}</div>
            <div class="web-match-subline muted">${formatNumber(normalized.damage)} daño${normalized.map_name ? ` · ${escapeHtml(normalized.map_name)}` : ""}</div>
          </div>
        </div>
        <div class="web-match-summary-right">
          <span class="web-match-date">${escapeHtml(formatDateTime(normalized.ts))}</span>
          <span class="web-match-toggle">Desglose</span>
        </div>
      </button>
      <div id="${matchId}" class="web-match-detail">
        <div class="web-match-detail-grid">
          <section class="detail-slab">
            <div class="detail-slab-head">Hechizos</div>
            <div class="detail-spells">
              ${renderSpellIcon(normalized.spell1_id)}
              ${renderSpellIcon(normalized.spell2_id)}
            </div>
          </section>
          <section class="detail-slab detail-slab-wide">
            <div class="detail-slab-head">Build</div>
            <div class="detail-items">${renderItemRow(items)}</div>
          </section>
          <section class="detail-slab detail-slab-wide">
            <div class="detail-slab-head">Aumentos</div>
            <div class="detail-augments">${renderAugmentRow(augments)}</div>
          </section>
          <section class="detail-slab">
            <div class="detail-slab-head">Estadísticas</div>
            <div class="detail-stats">
              <div><strong>${formatNumber(normalized.gold)}</strong><span>Oro</span></div>
              <div><strong>${formatNumber(normalized.damage)}</strong><span>Daño</span></div>
              <div><strong>${formatNumber(normalized.damage_taken)}</strong><span>Recibido</span></div>
              <div><strong>${normalized.champion_level || "-"}</strong><span>Nivel</span></div>
            </div>
          </section>
        </div>
      </div>
    </article>
  `;
}

function renderSpellIcon(spellId) {
  const src = spellIconUrl(spellId);
  if (!src) {
    return '<div class="spell-fallback">-</div>';
  }
  return `<img class="spell-icon" src="${src}" alt="Hechizo ${escapeHtml(String(spellId))}">`;
}

function renderItemRow(items) {
  return items.length
    ? items
        .map((itemId) => {
          const itemInfo = state.itemData[String(itemId)];
          return `
            <div class="detail-icon-box" title="${escapeHtml(itemInfo?.name || `Ítem ${itemId}`)}">
              <img src="${itemIconUrl(itemId)}" alt="${escapeHtml(itemInfo?.name || `Ítem ${itemId}`)}">
            </div>
          `;
        })
        .join("")
    : '<div class="empty-inline">Sin build guardada</div>';
}

function renderAugmentRow(augments) {
  return augments.length
    ? augments
        .map((augmentId) => {
          const meta = augmentMetaById(augmentId);
          return `
            <div class="detail-icon-box augment" title="${escapeHtml(meta.name)}">
              ${meta.icon ? `<img src="${meta.icon}" alt="${escapeHtml(meta.name)}">` : `<span>${escapeHtml(meta.name.slice(0, 2).toUpperCase())}</span>`}
            </div>
          `;
        })
        .join("")
    : '<div class="empty-inline">Sin aumentos sincronizados</div>';
}

function renderHistory() {
  const listNode = document.getElementById("history-list");
  const countNode = document.getElementById("history-count");

  if (!listNode || !countNode) {
    return;
  }

  countNode.textContent = String(state.history.length);
  listNode.innerHTML = state.history.length
    ? state.history.map((match, index) => renderHistoryEntry(match, false, `history-${index}`)).join("")
    : '<div class="empty-card">No hay historial sincronizado para la cuenta activa.</div>';
}

function renderAugments() {
  const augmentList = aggregateAugments(state.history);
  const rarityCounter = new Map();

  augmentList.forEach((augment) => {
    rarityCounter.set(augment.rarity, (rarityCounter.get(augment.rarity) || 0) + augment.uses);
  });

  const topRarity = [...rarityCounter.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "-";

  document.getElementById("augment-total").textContent = String(augmentList.length);
  document.getElementById("augment-most-used").textContent = augmentList[0]?.name || "-";
  document.getElementById("augment-top-rarity").textContent = topRarity;

  const usageList = document.getElementById("augment-usage-list");
  const gridNode = document.getElementById("augment-grid");

  usageList.innerHTML = augmentList.length
    ? augmentList
        .slice(0, 8)
        .map(
          (augment) => `
            <div class="stack-item">
              <strong>${escapeHtml(augment.name)}</strong>
              <span>${augment.uses} usos · ${augment.winRate}% WR · ${escapeHtml(augment.rarity)}</span>
            </div>
          `
        )
        .join("")
    : '<div class="empty-card">Todavía no hay aumentos guardados en el historial.</div>';

  gridNode.innerHTML = augmentList.length
    ? augmentList
        .map((augment) => {
          return `
            <article class="augment-card">
              <div class="augment-card-head">
                <div class="augment-icon-wrap">
                  ${augment.icon ? `<img src="${augment.icon}" alt="${escapeHtml(augment.name)}">` : `<div class="augment-fallback">${escapeHtml(augment.name.slice(0, 2).toUpperCase())}</div>`}
                </div>
                <div>
                  <strong>${escapeHtml(augment.name)}</strong>
                  <p>${escapeHtml(augment.rarity)} · Tier ${escapeHtml(augment.tier)}</p>
                </div>
              </div>
              <div class="augment-card-meta">
                <span>${augment.uses} usos</span>
                <span>${augment.winRate}% WR</span>
              </div>
              <p class="augment-card-copy">${escapeHtml(augment.description || "Sin descripción sincronizada.")}</p>
            </article>
          `;
        })
        .join("")
    : '<div class="empty-card">No hay aumentos recientes para enseñar todavía.</div>';
}

function switchTab(tabId) {
  document.querySelectorAll(".profile-nav-tab").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.tab === tabId);
  });

  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("is-active", panel.id === `tab-${tabId}`);
  });
}

async function enrichWithLiveProfile() {
  if (!state.activeAccount) {
    return;
  }

  try {
    const response = await fetch(
      `/api/summoner?name=${encodeURIComponent(state.activeAccount.name)}&tag=${encodeURIComponent(state.activeAccount.tag)}`
    );

    if (!response.ok) {
      return;
    }

    const payload = await response.json();
    document.getElementById("active-account-meta").textContent =
      `SERVIDOR · ${String(state.activeAccount.server || "EUW").toUpperCase()} · NIVEL ${payload.account.summonerLevel}`;

    const solo = payload.ranks?.soloq;
    const flex = payload.ranks?.flex;

    document.getElementById("profile-rank-solo").textContent = solo
      ? `${solo.tier} ${solo.rank} · ${solo.leaguePoints} LP`
      : "Sin rango";
    document.getElementById("profile-rank-solo-meta").textContent = solo
      ? `${solo.wins}V / ${solo.losses}D`
      : "Sin partidas clasificatorias";
    document.getElementById("profile-rank-flex").textContent = flex
      ? `${flex.tier} ${flex.rank} · ${flex.leaguePoints} LP`
      : "Sin rango";
    document.getElementById("profile-rank-flex-meta").textContent = flex
      ? `${flex.wins}V / ${flex.losses}D`
      : "Sin partidas clasificatorias";
  } catch {
    // Mantener datos sincronizados desde app/Supabase.
  }
}

async function loadUser() {
  state.session = getStoredSession();

  if (!state.session?.access_token) {
    window.location.replace(getWebUrlFor("index.html"));
    return false;
  }

  const user = await supabaseRequest("/auth/v1/user");
  state.user = user;
  state.session.user = user;
  localStorage.setItem("sb_session", JSON.stringify(state.session));
  renderAuthUser();
  return true;
}

async function loadAccountsAndHistory() {
  const accounts = await supabaseRequest(
    `/rest/v1/lol_accounts?select=*&user_id=eq.${encodeURIComponent(state.user.id)}&order=active.desc`
  );

  state.accounts = [...accounts].sort((a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active)));
  state.activeAccount = state.accounts.find((account) => account.active) || state.accounts[0] || null;
  renderLinkedAccounts();

  if (!state.activeAccount) {
    renderProfileSummary();
    renderHistory();
    renderAugments();
    return;
  }

  let history = await supabaseRequest(
    `/rest/v1/match_history?select=*&user_id=eq.${encodeURIComponent(state.user.id)}&puuid=eq.${encodeURIComponent(state.activeAccount.puuid)}&order=ts.desc`
  );

  let normalizedHistory = history.map(normalizeMatch);

  if (!normalizedHistory.length) {
    const allHistory = await supabaseRequest(
      `/rest/v1/match_history?select=*&user_id=eq.${encodeURIComponent(state.user.id)}&order=ts.desc`
    );
    const fallbackHistory = allHistory.map(normalizeMatch);
    const missingPuuidRows = fallbackHistory.filter((match) => !match.puuid);

    if (missingPuuidRows.length) {
      normalizedHistory = missingPuuidRows;
    } else if (state.accounts.length === 1) {
      normalizedHistory = fallbackHistory;
    }
  }

  state.history = normalizedHistory;
  renderProfileSummary();
  renderHistory();
  renderAugments();
}

async function loadAugmentSources() {
  const [augmentTable, augmentGeneral] = await Promise.all([
    fetch("/assets/data/tabladeaumentos.json").then((response) => (response.ok ? response.json() : { aumentos: {} })),
    fetch("/assets/data/aumentosgeneral.json").then((response) => (response.ok ? response.json() : {})),
  ]);

  state.augmentTable = augmentTable;
  state.augmentGeneral = augmentGeneral;
}

async function loadStaticGameData() {
  try {
    const versions = await fetch("https://ddragon.leagueoflegends.com/api/versions.json").then((response) => response.json());
    state.ddVersion = versions?.[0] || state.ddVersion;
  } catch {}

  try {
    const championData = await fetch(`https://ddragon.leagueoflegends.com/cdn/${state.ddVersion}/data/en_US/champion.json`).then((response) => response.json());
    Object.values(championData?.data || {}).forEach((champion) => {
      if (champion?.key && champion?.id) {
        state.championById[String(champion.key)] = champion.id;
      }
    });
  } catch {}

  try {
    const itemData = await fetch(`https://ddragon.leagueoflegends.com/cdn/${state.ddVersion}/data/es_ES/item.json`).then((response) => response.json());
    state.itemData = itemData?.data || {};
  } catch {
    state.itemData = {};
  }
}

function attachEventHandlers() {
  document.querySelectorAll(".profile-nav-tab").forEach((button) => {
    button.addEventListener("click", () => switchTab(button.dataset.tab));
  });

  document.addEventListener("click", (event) => {
    const toggleButton = event.target.closest("[data-match-toggle]");
    if (!toggleButton) {
      return;
    }

    const targetId = toggleButton.getAttribute("data-match-toggle");
    const panel = document.getElementById(targetId);
    if (!panel) {
      return;
    }

    panel.classList.toggle("open");
    toggleButton.classList.toggle("open");
  });
}

async function webLogout() {
  localStorage.removeItem("sb_session");
  window.location.replace(getWebUrlFor("index.html"));
}

window.webLogout = webLogout;

async function initProfilePage() {
  const ready = await loadUser();
  if (!ready) {
    return;
  }

  attachEventHandlers();
  await Promise.all([loadStaticGameData(), loadAugmentSources()]);
  await loadAccountsAndHistory();
  await enrichWithLiveProfile();
}

initProfilePage().catch((error) => {
  const statusNode = document.getElementById("profile-status");
  if (statusNode) {
    statusNode.textContent = String(error.message || error);
  }
});
