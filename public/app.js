const revealElements = document.querySelectorAll(".reveal");

if ("IntersectionObserver" in window) {
  const revealObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) {
          return;
        }

        entry.target.classList.add("is-visible");
        revealObserver.unobserve(entry.target);
      });
    },
    { threshold: 0.15 }
  );

  revealElements.forEach((element) => revealObserver.observe(element));
} else {
  revealElements.forEach((element) => element.classList.add("is-visible"));
}

const yearNode = document.getElementById("year");

if (yearNode) {
  yearNode.textContent = new Date().getFullYear();
}

const queueMap = {
  420: "Solo/Duo",
  440: "Flex",
  450: "ARAM",
  400: "Normal",
  430: "Normal",
  700: "Clash",
  900: "URF",
  1020: "Un solo campeón",
  1300: "Nexus Blitz",
  1400: "Spellbook",
};

function communityDragonProfileIcon(iconId) {
  return `https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/profile-icons/${iconId}.jpg`;
}

function communityDragonChampionIcon(championId) {
  return `https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/champion-icons/${championId}.png`;
}

function formatRank(entry) {
  if (!entry) {
    return { tier: "Sin rango", meta: "Sin partidas clasificatorias" };
  }

  const totalGames = (entry.wins || 0) + (entry.losses || 0);
  const winRate = totalGames ? Math.round((entry.wins / totalGames) * 100) : 0;

  return {
    tier: `${entry.tier} ${entry.rank} · ${entry.leaguePoints} LP`,
    meta: `${entry.wins}V / ${entry.losses}D · ${winRate}% WR`,
  };
}

function formatDate(timestamp) {
  return new Date(timestamp).toLocaleDateString("es-ES", {
    day: "2-digit",
    month: "2-digit",
  });
}

function formatMasteryPoints(points) {
  if (points >= 1000000) {
    return `${(points / 1000000).toFixed(1)}M`;
  }

  if (points >= 1000) {
    return `${Math.round(points / 1000)}k`;
  }

  return String(points);
}

function setSummonerStatus(message, isError = false) {
  const statusNode = document.getElementById("summoner-status");

  if (!statusNode) {
    return;
  }

  statusNode.textContent = message || "";
  statusNode.style.color = isError ? "#ef7676" : "";
}

function setSearchMode(enabled) {
  document.body.classList.toggle("search-mode", enabled);
}

function renderSummonerProfile(data) {
  const resultPanel = document.getElementById("summoner-result");
  const contentNode = document.getElementById("summoner-content");

  if (!resultPanel || !contentNode) {
    return;
  }

  resultPanel.classList.remove("hidden");
  contentNode.classList.remove("hidden");

  document.getElementById("summoner-icon").src = communityDragonProfileIcon(data.account.profileIconId);
  document.getElementById("summoner-name").textContent = `${data.account.gameName}#${data.account.tagLine}`;
  document.getElementById("summoner-meta").textContent = `Nivel ${data.account.summonerLevel} · EUW`;

  const soloq = formatRank(data.ranks.soloq);
  const flex = formatRank(data.ranks.flex);

  document.getElementById("rank-solo-tier").textContent = soloq.tier;
  document.getElementById("rank-solo-meta").textContent = soloq.meta;
  document.getElementById("rank-flex-tier").textContent = flex.tier;
  document.getElementById("rank-flex-meta").textContent = flex.meta;

  document.getElementById("summary-winrate").textContent = `${data.summary.winRate}%`;
  document.getElementById("summary-kda").textContent = `${data.summary.avgKills} / ${data.summary.avgDeaths} / ${data.summary.avgAssists}`;
  document.getElementById("summary-games").textContent = String(data.summary.games);
  document.getElementById("summary-damage").textContent = data.summary.avgDamage.toLocaleString("es-ES");
  document.getElementById("summary-gold").textContent = data.summary.avgGold.toLocaleString("es-ES");
  document.getElementById("summary-most-played").textContent = data.summary.mostPlayedChampionName || "-";

  const masteryNode = document.getElementById("mastery-list");
  masteryNode.innerHTML = data.mastery.length
    ? data.mastery
        .map(
          (entry) => `
            <div class="mastery-item">
              <img src="${communityDragonChampionIcon(entry.championId)}" alt="Campeón ${entry.championId}">
              <div class="mastery-level">M${entry.championLevel}</div>
              <div class="mastery-points">${formatMasteryPoints(entry.championPoints)}</div>
            </div>
          `
        )
        .join("")
    : `<div class="match-meta">Sin maestrías disponibles.</div>`;

  const matchNode = document.getElementById("match-list");
  matchNode.innerHTML = data.matches.length
    ? data.matches
        .map((match) => {
          const participant = match.participant;
          const didWin = Boolean(participant.win);
          const duration = `${Math.floor(match.info.gameDuration / 60)}m`;
          const mode = queueMap[match.info.queueId] || `Modo ${match.info.queueId}`;

          return `
            <article class="match-row ${didWin ? "win" : "loss"}">
              <img src="${communityDragonChampionIcon(participant.championId)}" alt="${participant.championName}">
              <div>
                <div class="match-head">
                  <span class="match-result">${didWin ? "Victoria" : "Derrota"}</span>
                  <span class="match-kda">${participant.kills} / ${participant.deaths} / ${participant.assists}</span>
                </div>
                <div class="match-meta">
                  ${participant.championName} · ${mode} · ${participant.totalDamageDealtToChampions.toLocaleString("es-ES")} daño · ${duration} · ${formatDate(match.info.gameCreation)}
                </div>
              </div>
            </article>
          `;
        })
        .join("")
    : `<div class="match-meta">Sin partidas ARAM recientes.</div>`;
}

function moveSearchFormToSearchState() {
  const container = document.getElementById("search-topbar");
  const form = document.querySelector(".search-box");

  if (container && form && !container.contains(form)) {
    container.appendChild(form);
  }
}

function moveSearchFormToLanding() {
  const panel = document.querySelector(".search-panel");
  const heroLogo = document.querySelector(".hero-logo-wrap");
  const form = document.querySelector(".search-box");

  if (panel && heroLogo && form && form.previousElementSibling?.id !== "search-topbar") {
    heroLogo.insertAdjacentElement("afterend", form);
  } else if (panel && heroLogo && form && form.parentElement?.id === "search-topbar") {
    heroLogo.insertAdjacentElement("afterend", form);
  }
}

async function handleSummonerSearch(event) {
  event.preventDefault();

  const input = document.getElementById("summoner-search-input");
  const resultPanel = document.getElementById("summoner-result");
  const contentNode = document.getElementById("summoner-content");

  if (!input || !resultPanel || !contentNode) {
    return;
  }

  const raw = input.value.trim();

  if (!raw || !raw.includes("#")) {
    setSearchMode(false);
    moveSearchFormToLanding();
    resultPanel.classList.remove("hidden");
    contentNode.classList.add("hidden");
    setSummonerStatus("Escribe el invocador como nombre#tag.", true);
    return;
  }

  const [name, ...tagParts] = raw.split("#");
  const tag = tagParts.join("#").trim();

  if (!name.trim() || !tag) {
    setSearchMode(false);
    moveSearchFormToLanding();
    resultPanel.classList.remove("hidden");
    contentNode.classList.add("hidden");
    setSummonerStatus("Falta el tag del invocador.", true);
    return;
  }

  setSearchMode(true);
  moveSearchFormToSearchState();
  resultPanel.classList.remove("hidden");
  contentNode.classList.add("hidden");
  setSummonerStatus("Buscando invocador...");

  try {
    const response = await fetch(`/api/summoner?name=${encodeURIComponent(name.trim())}&tag=${encodeURIComponent(tag)}`);
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.detail || payload.error || "No se pudo cargar el perfil");
    }

    setSummonerStatus(`Perfil cargado para ${payload.account.gameName}#${payload.account.tagLine}`);
    renderSummonerProfile(payload);
    resultPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    contentNode.classList.add("hidden");
    setSummonerStatus(String(error.message || error), true);
  }
}

const summonerSearchForm = document.querySelector(".search-box");

if (summonerSearchForm) {
  summonerSearchForm.addEventListener("submit", handleSummonerSearch);
}

const startupCanvas = document.getElementById("startup-particles");

if (startupCanvas) {
  const ctx = startupCanvas.getContext("2d");
  let particles = [];
  let streaks = [];
  let width = 0;
  let height = 0;

  const colors = ["#d4a84f", "#f0d18a", "#f7f1e7"];

  function resizeStartupCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const bounds = startupCanvas.getBoundingClientRect();

    width = bounds.width;
    height = bounds.height;

    startupCanvas.width = Math.max(1, Math.floor(width * dpr));
    startupCanvas.height = Math.max(1, Math.floor(height * dpr));
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
  }

  function createParticle() {
    return {
      x: Math.random() * width,
      y: Math.random() * height,
      size: Math.random() * 3.2 + 0.8,
      speedX: Math.random() * 1.2 - 0.6,
      speedY: Math.random() * 1.2 - 0.6,
      opacity: Math.random() * 0.45 + 0.08,
      fade: Math.random() * 0.003 + 0.0009,
      color: colors[Math.floor(Math.random() * colors.length)],
    };
  }

  function createStreak() {
    const startLeft = Math.random() > 0.5;
    return {
      x: startLeft ? -120 : width + 120,
      y: Math.random() * height * 0.85,
      length: Math.random() * 120 + 70,
      speedX: startLeft ? Math.random() * 4 + 2.2 : -(Math.random() * 4 + 2.2),
      speedY: Math.random() * 0.7 + 0.2,
      opacity: Math.random() * 0.2 + 0.08,
      lineWidth: Math.random() * 1.4 + 0.6,
    };
  }

  function resetParticles() {
    particles = Array.from({ length: 90 }, createParticle);
    streaks = Array.from({ length: 7 }, createStreak);
  }

  function drawStartupParticles() {
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "rgba(7, 7, 7, 0.08)";
    ctx.fillRect(0, 0, width, height);

    streaks.forEach((streak, index) => {
      streak.x += streak.speedX;
      streak.y += streak.speedY;

      const outRight = streak.speedX > 0 && streak.x - streak.length > width + 160;
      const outLeft = streak.speedX < 0 && streak.x + streak.length < -160;
      const outBottom = streak.y > height + 60;

      if (outRight || outLeft || outBottom) {
        streaks[index] = createStreak();
        return;
      }

      const gradient = ctx.createLinearGradient(
        streak.x,
        streak.y,
        streak.x - streak.length,
        streak.y - streak.length * 0.12
      );
      gradient.addColorStop(0, `rgba(240, 209, 138, ${streak.opacity})`);
      gradient.addColorStop(0.4, "rgba(247, 241, 231, 0.10)");
      gradient.addColorStop(1, "rgba(247, 241, 231, 0)");

      ctx.save();
      ctx.strokeStyle = gradient;
      ctx.lineWidth = streak.lineWidth;
      ctx.shadowBlur = 16;
      ctx.shadowColor = "rgba(240, 209, 138, 0.18)";
      ctx.beginPath();
      ctx.moveTo(streak.x, streak.y);
      ctx.lineTo(streak.x - streak.length, streak.y - streak.length * 0.12);
      ctx.stroke();
      ctx.restore();
    });

    particles.forEach((particle, index) => {
      particle.x += particle.speedX;
      particle.y += particle.speedY;
      particle.opacity -= particle.fade;

      if (
        particle.opacity <= 0 ||
        particle.x < -20 ||
        particle.x > width + 20 ||
        particle.y < -20 ||
        particle.y > height + 20
      ) {
        particles[index] = createParticle();
        return;
      }

      ctx.save();
      ctx.globalAlpha = particle.opacity;
      ctx.fillStyle = particle.color;
      ctx.shadowBlur = 20;
      ctx.shadowColor = particle.color;
      ctx.beginPath();
      ctx.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    });

    requestAnimationFrame(drawStartupParticles);
  }

  resizeStartupCanvas();
  resetParticles();
  drawStartupParticles();
  window.addEventListener("resize", () => {
    resizeStartupCanvas();
    resetParticles();
  });
}

// ── Supabase Web Auth ──────────────────────────────────────
const SUPABASE_URL  = 'https://eoyrxsctnxqilzkrjjzy.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVveXJ4c2N0bnhxaWx6a3Jqanp5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcwNTc1OTUsImV4cCI6MjA5MjYzMzU5NX0.eGBjhu6ie7is17gOTz0DV9xOacwegnyk7kDD5kKInOY';

async function supabaseFetch(path, opts = {}) {
  const session = JSON.parse(localStorage.getItem('sb_session') || 'null');
  const headers = {
    'apikey': SUPABASE_KEY,
    'Content-Type': 'application/json',
    ...(session ? { 'Authorization': `Bearer ${session.access_token}` } : {})
  };
  const res = await fetch(SUPABASE_URL + path, { ...opts, headers: { ...headers, ...(opts.headers||{}) } });
  return res.json();
}

function getWebBasePath() {
  const parts = window.location.pathname.split('/').filter(Boolean);
  if (window.location.hostname.endsWith('github.io') && parts.length > 0) {
    return `/${parts[0]}`;
  }
  return '';
}

function getWebUrlFor(path = '') {
  const base = getWebBasePath();
  const cleanPath = String(path || '').replace(/^\/+/, '');
  return `${window.location.origin}${base}/${cleanPath}`;
}

async function webLogin() {
  const redirectTo = getWebUrlFor('auth.html');
  const authUrl = `${SUPABASE_URL}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(redirectTo)}`;
  window.location.href = authUrl;
}

async function webLogout() {
  localStorage.removeItem('sb_session');
  updateWebAuthUI(null);
  window.location.href = getWebUrlFor('');
}

function updateWebAuthUI(session) {
  const btns  = document.getElementById('web-auth-btns');
  const info  = document.getElementById('web-user-info');
  if (!btns || !info) return;
  if (session) {
    btns.style.display = 'none';
    info.style.display = 'flex';
    const avatar = document.getElementById('web-user-avatar');
    const name   = document.getElementById('web-user-name');
    if (avatar) avatar.src = session.user?.user_metadata?.avatar_url || '';
    if (name)   name.textContent = session.user?.user_metadata?.full_name || session.user?.email || '';
  } else {
    btns.style.display = 'flex';
    info.style.display = 'none';
  }
}

// Comprobar sesión al cargar
(async function initWebAuth() {
  const stored = localStorage.getItem('sb_session');
  if (stored) {
    try {
      const session = JSON.parse(stored);
      updateWebAuthUI(session);
    } catch(e) {
      localStorage.removeItem('sb_session');
    }
  }
})();
