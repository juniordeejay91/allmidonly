# ============================================================
#  ARAM CAOS — Proxy local para Riot API
#  Evita el bloqueo CORS al llamar desde el navegador.
#  La API key nunca sale del servidor, nunca va al HTML.
# ============================================================
import sys
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')
import os
import threading
import requests
from flask import Flask, request, jsonify, Response
from flask_cors import CORS
from urllib.parse import urlparse

# ── CONFIGURACIÓN ─────────────────────────────────────────────
# Pon aquí tu API key de https://developer.riotgames.com
# Las development keys caducan cada 24h.
RIOT_KEY   = os.environ.get("RIOT_KEY", "RGAPI-20381fc2-e930-4bc1-b9da-359a86b18262")
PROXY_PORT = 5123

ALLOWED_HOSTS = (
    "europe.api.riotgames.com",
    "euw1.api.riotgames.com",
    "eun1.api.riotgames.com",
    "na1.api.riotgames.com",
    "kr.api.riotgames.com",
    "br1.api.riotgames.com",
    "la1.api.riotgames.com",
    "la2.api.riotgames.com",
    "oc1.api.riotgames.com",
    "jp1.api.riotgames.com",
    "ru.api.riotgames.com",
    "tr1.api.riotgames.com",
)
# ──────────────────────────────────────────────────────────────

app = Flask(__name__)
CORS(app, origins=["http://localhost:*", "null", "file://"])

@app.route('/mobalytics', methods=['POST'])
def mobalytics_proxy():
    """Proxy para Mobalytics GraphQL — evita CORS desde el HTML."""
    try:
        body = request.get_json(force=True)
    except Exception:
        return jsonify({'error': 'invalid json'}), 400

    headers = {
        'Content-Type': 'application/json',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Origin': 'https://mobalytics.gg',
        'Referer': 'https://mobalytics.gg/lol/champions/ashe/aram-builds',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
        'x-moba-client': 'mobalytics-web',
        'x-moba-proxy-gql-ops-name': body.get('operationName', ''),
        'Cookie': 'appmobaabgroup=B; appcfcountry=ES; appiscrawler=0; appmobaadsplitgroup=A',
    }
    try:
        r = requests.post(
            'https://mobalytics.gg/api/lol/graphql/v1/query',
            json=body,
            headers=headers,
            timeout=12,
        )
        return Response(
            r.content,
            status=r.status_code,
            content_type=r.headers.get('Content-Type', 'application/json'),
            headers={'Access-Control-Allow-Origin': '*'},
        )
    except requests.exceptions.Timeout:
        return jsonify({'error': 'timeout'}), 504
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route("/riot")
def riot_proxy():
    url  = request.args.get("url", "").strip()
    host = urlparse(url).netloc
    print(f"[DEBUG] KEY usada: {RIOT_KEY}")  # ← añade aquí
    print(f"[DEBUG] URL: {url}")              # ← y aquí

    if not url or host not in ALLOWED_HOSTS:
        return jsonify({"error": "URL no permitida", "host": host}), 400

    try:
        r = requests.get(
            url,
            headers={"X-Riot-Token": RIOT_KEY},
            timeout=10,
        )
        return (r.content, r.status_code, {
            "Content-Type": "application/json; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
        })
    except requests.exceptions.Timeout:
        return jsonify({"error": "timeout"}), 504
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/health")
def health():
    return jsonify({"status": "ok", "port": PROXY_PORT})


IESDEV_TIERS_URL = (
    "https://datalake.v2.iesdev.com/graphql"
    "?query=query+AramMayhemChampionsStats%7BexecuteDatabricksQuery"
    "%28game%3ALEAGUE%2CqueryName%3A%22prod_aram_mayhem_champions%22"
    "%2Cparams%3A%5B%7Bname%3A%22dummy%22%2Cvalue%3A%22dummy%22%7D%5D%29"
    "%7Bmetadata%7BbyteSize+lastModified+statement+parameters%7Dpayload%7D%7D"
)
IESDEV_HEADERS = {
    "Referer":    "https://blitz.gg/",
    "Origin":     "https://blitz.gg",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
}

@app.route("/iesdev-debug")
def iesdev_debug():
    r = requests.get(IESDEV_TIERS_URL, headers=IESDEV_HEADERS, timeout=12)
    return r.text, 200, {"Access-Control-Allow-Origin": "*", "Content-Type": "text/plain"}

@app.route("/iesdev-tiers")
def iesdev_tiers():
    import time, os, json as _json
    root_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
    cache_path = os.path.join(root_dir, 'cache', 'cache_tiers.json')
    if os.path.exists(cache_path):
        try:
            cached = _json.loads(open(cache_path).read())
            if time.time() - cached.get('ts', 0) < 21600:
                return jsonify(cached['data']), 200, {"Access-Control-Allow-Origin": "*"}
        except: pass
    try:
        r = requests.get(IESDEV_TIERS_URL, headers=IESDEV_HEADERS, timeout=12)
        raw = r.json()
        rows = (
            raw.get("data", {})
               .get("executeDatabricksQuery", {})
               .get("payload", {})
               .get("result", {})
               .get("dataArray", [])
        )
        result = {}
        import json as _json
        for row in rows:
            if not row or len(row) < 2:
                continue
            champ_id = str(row[0])
            try:
                stats = _json.loads(row[1]) if isinstance(row[1], str) else row[1]
                tier  = int(stats.get("tier", 5))
                wr    = round(float(stats.get("win_rate", 0)) * 100, 1)
            except Exception:
                tier = 5
                wr   = 0
            result[champ_id] = {"tier": tier, "wr": wr}
        try:
            with open(cache_path, 'w') as f:
                _json.dump({'ts': time.time(), 'data': result}, f)
        except: pass
        return jsonify(result), 200, {"Access-Control-Allow-Origin": "*"}
    except requests.exceptions.Timeout:
        return jsonify({"error": "timeout"}), 504
    except Exception as e:
        return jsonify({"error": str(e)}), 500


def iniciar_proxy():
    """Arranca el proxy en un hilo daemon. Llamar desde main() de aramcaos.py."""
    t = threading.Thread(
        target=lambda: app.run(
            host="127.0.0.1",
            port=PROXY_PORT,
            debug=False,
            use_reloader=False,
        ),
        daemon=True,
        name="ProxyRiot",
    )
    t.start()
    print(f"✅ Proxy Riot API escuchando en http://127.0.0.1:{PROXY_PORT}")

# ============================================================
#  AUGMENTS SYNC — Descarga y cachea imágenes de aumentos
# ============================================================
import json as _json
import time as _time
from pathlib import Path
import os as _os

AUGMENTS_IMG_DIR  = Path(__file__).parent / "img" / "aumentos"
AUGMENTS_MANIFEST = AUGMENTS_IMG_DIR / "manifest.json"
AUGMENTS_JSON_URL = "https://utils.iesdev.com/static/json/lol/mayham/{version}/augments_es_es"
AUGMENTS_IMG_URL  = "https://blitz-cdn.blitz.gg/blitz/lol/arena/augments/{filename}"

IESDEV_HEADERS_IMG = {
    "Referer":    "https://blitz.gg/",
    "Origin":     "https://blitz.gg",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
}

_sync_status = {"running": False, "total": 0, "done": 0, "errors": 0, "msg": "idle"}


def _load_manifest():
    try:
        return _json.loads(AUGMENTS_MANIFEST.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_manifest(data):
    AUGMENTS_MANIFEST.write_text(_json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def _do_sync(version: str):
    global _sync_status
    _sync_status = {"running": True, "total": 0, "done": 0, "errors": 0, "msg": "Descargando lista de aumentos..."}

    AUGMENTS_IMG_DIR.mkdir(parents=True, exist_ok=True)

    # 1. Descargar JSON de aumentos
    try:
        r = requests.get(
            AUGMENTS_JSON_URL.format(version=version),
            headers=IESDEV_HEADERS_IMG,
            timeout=15,
        )
        augments_data = r.json()
    except Exception as e:
        _sync_status["running"] = False
        _sync_status["msg"] = f"Error descargando lista: {e}"
        return

    manifest = _load_manifest()
    manifest_augments = manifest.get("augments", {})

    # 2. Calcular cuáles faltan o han cambiado
    to_download = []
    for aug_id, aug in augments_data.items():
        filename = aug.get("iconLarge")
        if not filename:
            continue
        local_path = AUGMENTS_IMG_DIR / filename.lower()
        if not local_path.exists():
            to_download.append((aug_id, filename))
        # Si ya existe, no comparamos tamaño (confiamos en la versión del parche)

    _sync_status["total"] = len(to_download)
    _sync_status["msg"] = f"Descargando {len(to_download)} imágenes nuevas..."

    if len(to_download) == 0:
        # Todo OK, solo actualizamos manifest
        manifest["version"]     = version
        manifest["last_sync"]   = _time.strftime("%Y-%m-%dT%H:%M:%S")
        manifest["augments"]    = {k: v.get("iconLarge") for k, v in augments_data.items() if v.get("iconLarge")}
        _save_manifest(manifest)
        _sync_status["running"] = False
        _sync_status["msg"]     = "OK — todas las imágenes están al día"
        return

    # 3. Descargar imágenes faltantes
    errors = 0
    for i, (aug_id, filename) in enumerate(to_download):
        _sync_status["done"] = i
        _sync_status["msg"]  = f"Descargando {filename} ({i+1}/{len(to_download)})"
        try:
            img_r = requests.get(
                AUGMENTS_IMG_URL.format(filename=filename.lower()),
                headers=IESDEV_HEADERS_IMG,
                timeout=15,
            )
            if img_r.status_code == 200:
                (AUGMENTS_IMG_DIR / filename).write_bytes(img_r.content)
            else:
                errors += 1
        except Exception:
            errors += 1

    # 4. Guardar manifest actualizado
    manifest["version"]   = version
    manifest["last_sync"] = _time.strftime("%Y-%m-%dT%H:%M:%S")
    manifest["augments"]  = {k: v.get("iconLarge") for k, v in augments_data.items() if v.get("iconLarge")}
    _save_manifest(manifest)

    _sync_status["running"] = False
    _sync_status["errors"]  = errors
    _sync_status["done"]    = len(to_download)
    _sync_status["msg"]     = f"Sync completado. {len(to_download) - errors} OK, {errors} errores"


@app.route("/augments-sync", methods=["POST"])
def augments_sync():
    """
    Body: { "version": "16.8" }
    Si la versión del manifest coincide, no hace nada.
    Si es nueva, lanza sync en background.
    """
    body    = request.get_json(force=True) or {}
    version = str(body.get("version", "")).strip()

    if not version:
        return jsonify({"error": "version requerida"}), 400

    manifest = _load_manifest()

    if manifest.get("version") == version and not body.get("force", False):
        return jsonify({
            "status":  "up_to_date",
            "version": version,
            "msg":     "Imágenes ya al día para esta versión",
        })

    if _sync_status["running"]:
        return jsonify({"status": "already_running"})

    t = threading.Thread(target=_do_sync, args=(version,), daemon=True, name="AugmentsSync")
    t.start()

    return jsonify({"status": "started", "version": version})


@app.route("/augments-sync-status")
def augments_sync_status():
    """Devuelve el progreso actual del sync."""
    return jsonify(_sync_status), 200, {"Access-Control-Allow-Origin": "*"}


@app.route("/augments-manifest")
def augments_manifest_endpoint():
    """Devuelve el manifest completo (id → filename)."""
    m = _load_manifest()
    return jsonify(m), 200, {"Access-Control-Allow-Origin": "*"}

# ============================================================
#  CACHE AUGMENTS POR CAMPEÓN
# ============================================================
ROOT_DIR = Path(_os.environ.get("AMO_ROOT_DIR", Path(__file__).resolve().parents[2]))
CACHE_DIR = Path(_os.environ.get("AMO_CACHE_DIR", ROOT_DIR / "cache"))
CHAMPION_CACHE_DIR = CACHE_DIR / "champions"
CHAMPION_API_URL   = "https://data.v2.iesdev.com/api/v1/query_objects/prod/lol/aram_mayhem_champion?champion_id={champion_id}"

@app.route("/cache-champion-augments", methods=["POST"])
def cache_champion_augments():
    """
    Body: { "champion_id": 11 }
    Descarga y cachea el JSON de augments para ese campeón.
    Sobreescribe siempre (se llama al entrar en ChampSelect).
    """
    body        = request.get_json(force=True) or {}
    champion_id = body.get("champion_id")
    if not champion_id:
        return jsonify({"error": "champion_id requerido"}), 400

    champion_id = str(champion_id)
    CHAMPION_CACHE_DIR.mkdir(parents=True, exist_ok=True)

    try:
        r = requests.get(
            CHAMPION_API_URL.format(champion_id=champion_id),
            headers=IESDEV_HEADERS_IMG,
            timeout=12,
        )
        raw = r.json()
        entry = (raw.get("data") or [{}])[0]
        augments_raw = entry.get("data", {}).get("augments", {})

        # Simplificamos: solo guardamos {augment_id: tier}
        augment_tiers = {
            aug_id: aug_data.get("tier", 5)
            for aug_id, aug_data in augments_raw.items()
        }

        cache_data = {
            "champion_id": champion_id,
            "patch":       entry.get("patch", ""),
            "augments":    augment_tiers,
            "ts":          _time.time(),
        }

        cache_file = CHAMPION_CACHE_DIR / f"champion_{champion_id}.json"
        cache_file.write_text(
            _json.dumps(cache_data, ensure_ascii=False, indent=2),
            encoding="utf-8"
        )

        print(f"[ChampCache] campeón {champion_id}: {len(augment_tiers)} augments cacheados")
        return jsonify({"ok": True, "champion_id": champion_id, "total": len(augment_tiers)})

    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/get-champion-augments/<champion_id>")
def get_champion_augments(champion_id):
    """Devuelve el cache de augments de un campeón."""
    cache_file = CHAMPION_CACHE_DIR / f"champion_{champion_id}.json"
    if not cache_file.exists():
        return jsonify({"error": "no_cache"}), 404
    return jsonify(_json.loads(cache_file.read_text(encoding="utf-8")))

@app.route("/cache-augments-es", methods=["POST"])
def cache_augments_es():
    """Descarga y cachea el JSON de augments en español."""
    body    = request.get_json(force=True) or {}
    version = str(body.get("version", "16.8")).strip()
    try:
        r = requests.get(
            f"https://utils.iesdev.com/static/json/lol/mayham/{version}/augments_es_es",
            headers=IESDEV_HEADERS_IMG,
            timeout=15,
        )
        data = r.json()
        cache_path = CACHE_DIR / "augments_es.json"
        cache_path.parent.mkdir(exist_ok=True)
        cache_path.write_text(_json.dumps(data, ensure_ascii=False), encoding="utf-8")
        print(f"[AugES] {len(data)} augments en español cacheados", flush=True)
        return jsonify({"ok": True, "total": len(data)})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/summoner-by-name")
def summoner_by_name():
    """Dado name+tag, devuelve los datos de summoner (flujo completo)."""
    name = request.args.get("name", "").strip()
    tag  = request.args.get("tag", "").strip()
    if not name or not tag:
        return jsonify({"error": "name y tag requeridos"}), 400
    try:
        # 1. Obtener puuid RSO
        acc_r = requests.get(
            f"https://europe.api.riotgames.com/riot/account/v1/accounts/by-riot-id/{requests.utils.quote(name)}/{requests.utils.quote(tag)}",
            headers={"X-Riot-Token": RIOT_KEY},
            timeout=10,
        )
        if not acc_r.ok:
            return acc_r.content, acc_r.status_code, {"Content-Type": "application/json", "Access-Control-Allow-Origin": "*"}
        acc = acc_r.json()
        # 2. Obtener summoner con el puuid RSO
        summ_r = requests.get(
            f"https://euw1.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/{acc['puuid']}",
            headers={"X-Riot-Token": RIOT_KEY},
            timeout=10,
        )
        return summ_r.content, summ_r.status_code, {"Content-Type": "application/json", "Access-Control-Allow-Origin": "*"}
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# ============================================================
#  DEEPLOL INGAME — proxy para obtener info de partida activa
# ============================================================
DEEPLOL_HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "Origin": "https://www.deeplol.gg",
    "Referer": "https://www.deeplol.gg/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
    "sec-ch-ua": '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
}

@app.route("/deeplol-check-ingame")
def deeplol_check_ingame():
    puuid       = request.args.get("puuid", "").strip()
    platform_id = request.args.get("platform_id", "EUW1").strip()

    if not puuid:
        return jsonify({"error": "puuid requerido"}), 400

    try:
        boundary = "----WebKitFormBoundaryn8BfAleMXzr6T0ms"
        body = (
            f'--{boundary}\r\n'
            f'Content-Disposition: form-data; name="puu_id"\r\n\r\n'
            f'{puuid}\r\n'
            f'--{boundary}\r\n'
            f'Content-Disposition: form-data; name="platform_id"\r\n\r\n'
            f'{platform_id}\r\n'
            f'--{boundary}--\r\n'
        )
        headers = {**DEEPLOL_HEADERS, 'content-type': f'multipart/form-data; boundary={boundary}'}
        r = requests.post('https://ingame-check.deeplol-gg.workers.dev/', 
                         headers=headers, data=body.encode('utf-8'), timeout=10)
        print(f"[check-ingame] status={r.status_code} body={r.text[:300]}")
        return Response(r.content, status=r.status_code,
            content_type="application/json; charset=utf-8",
            headers={"Access-Control-Allow-Origin": "*"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/deeplol-summoner")
def deeplol_summoner():
    name        = request.args.get("name", "").strip()
    tag         = request.args.get("tag", "").strip()
    platform_id = request.args.get("platform_id", "EUW1").strip()

    if not name or not tag:
        return jsonify({"error": "name y tag requeridos"}), 400

    try:
        url = (
            f"https://b2c-api-cdn.deeplol.gg/summoner/summoner"
            f"?riot_id_name={requests.utils.quote(name)}"
            f"&riot_id_tag_line={requests.utils.quote(tag)}"
            f"&platform_id={platform_id}"
        )
        r = requests.get(url, headers=DEEPLOL_HEADERS, timeout=10)
        return Response(r.content, status=r.status_code,
            content_type="application/json; charset=utf-8",
            headers={"Access-Control-Allow-Origin": "*"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/deeplol-ingame")
def deeplol_ingame():
    puuid       = request.args.get("puuid", "").strip()
    platform_id = request.args.get("platform_id", "EUW1").strip()
    match_id    = request.args.get("match_id", "").strip()
    season      = request.args.get("season", "27").strip()

    if not puuid or not match_id:
        return jsonify({"error": "puuid y match_id requeridos"}), 400

    try:
        url = (
            f"https://b2c-api-cdn.deeplol.gg/ingame/ingame_info"
            f"?puu_id={requests.utils.quote(puuid)}"
            f"&platform_id={platform_id}"
            f"&season={season}"
            f"&match_id={match_id}"
        )
        print(f"[deeplol] → {url}")
        r = requests.get(url, headers=DEEPLOL_HEADERS, timeout=15)
        return Response(
            r.content, status=r.status_code,
            content_type="application/json; charset=utf-8",
            headers={"Access-Control-Allow-Origin": "*"},
        )
    except requests.exceptions.Timeout:
        return jsonify({"error": "timeout"}), 504
    except Exception as e:
        return jsonify({"error": str(e)}), 500

if __name__ == "__main__":
    print(f"  ARAM CAOS — Proxy Riot API  (:{PROXY_PORT})")
    app.run(host="127.0.0.1", port=PROXY_PORT, debug=False)  # ← False aquí
