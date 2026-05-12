import sys
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

import json
import os
import time
import threading
import unicodedata
from difflib import SequenceMatcher
from pathlib import Path

import cv2
import mss
import numpy as np
from PIL import Image, ImageOps
from rapidocr_onnxruntime import RapidOCR


ROOT_DIR = Path(os.environ.get("AMO_ROOT_DIR", Path(__file__).resolve().parents[2]))
CACHE_DIR = Path(os.environ.get("AMO_CACHE_DIR", ROOT_DIR / "cache"))
IMG_DIR = Path(os.environ.get("AMO_IMG_DIR", ROOT_DIR / "img"))
CHAMPION_CACHE = CACHE_DIR / "champions"
AUGMENTS_ES = CACHE_DIR / "augments_es.json"
ICONS_DIR = IMG_DIR / "aumentos"

POLL_IDLE        = 0.15   # poll inicial del botón
POLL_IDLE_MED    = 0.50   # tras 30s sin botón
POLL_IDLE_SLOW   = 1.00   # tras 2min sin botón
POLL_ACTIVE      = 0.08   # poll entre confirmaciones cuando hay aumentos

# Botón azul de selección — coordenadas relativas al área 16:9
BOTON_REL = {"x": 0.445, "y": 0.7625, "w": 0.1105, "h": 0.0625}

# Rango HSV del azul turquesa del botón
BOTON_HSV_LOW  = np.array([91,  170, 60])
BOTON_HSV_HIGH = np.array([106, 255, 255])
BOTON_MIN_PIXELS = 30  # mínimo de píxeles azules para considerar visible

UMBRAL_TEXTO = 3
CONFIRM_NEEDED = 1
ICON_SIZE = 64
ICON_SHORTLIST = 12
REUSE_ICON_SIMILARITY = 0.992
FAST_CONFIRM_CONFIDENCE = 0.75

champion_id = None
augment_tiers = {}
augments_es = {}
augments_general = {}
augments_id_name = {}

icon_templates = {}
icon_ids = []
icon_template_list = []
icon_fingerprint_matrix = None


def normalizar(texto):
    return "".join(
        c for c in unicodedata.normalize("NFD", texto.lower().strip())
        if unicodedata.category(c) != "Mn"
    )


def limpiar_texto_ocr(texto):
    texto = texto.strip()
    for sep in ["[", "|", "("]:
        if sep in texto:
            texto = texto[:texto.index(sep)].strip()
    while "  " in texto:
        texto = texto.replace("  ", " ")
    return (
        texto.replace(":", " ")
        .replace("’", "'")
        .replace("`", "'")
        .strip()
    )


def fingerprint_icon(img_bgr):
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    small = cv2.resize(gray, (16, 16), interpolation=cv2.INTER_AREA).astype(np.float32)
    vec = small.reshape(-1)
    vec -= vec.mean()
    norm = np.linalg.norm(vec)
    if norm > 0:
        vec /= norm
    return vec


def load_augments_es():
    global augments_es, augments_id_name
    if not AUGMENTS_ES.exists():
        print(f"[OCR] AVISO: no existe {AUGMENTS_ES}", flush=True)
        return
    try:
        data = json.loads(AUGMENTS_ES.read_text(encoding="utf-8"))
        augments_es = {
            normalizar(v.get("displayName", "")): str(k)
            for k, v in data.items()
            if v.get("displayName")
        }
        augments_id_name = {
            str(k): v.get("displayName", "")
            for k, v in data.items()
            if v.get("displayName")
        }
        print(f"[OCR] {len(augments_es)} augments en espanol cargados", flush=True)
    except Exception as e:
        print(f"[OCR] error cargando augments_es.json: {e}", flush=True)


def load_augments_general():
    global augments_general
    cache_file = CACHE_DIR / "augment_stats.json"
    if not cache_file.exists():
        print("[OCR] no existe augment_stats.json - sin fallback general", flush=True)
        return
    try:
        data = json.loads(cache_file.read_text(encoding="utf-8"))
        augments_general = {
            str(aug_id): int(stats.get("tier", 0)) if isinstance(stats, dict) else int(stats)
            for aug_id, stats in data.items()
            if stats
        }
        print(f"[OCR] {len(augments_general)} augments generales cargados", flush=True)
    except Exception as e:
        print(f"[OCR] error cargando augment_stats.json: {e}", flush=True)


def load_icon_templates():
    global icon_templates, icon_ids, icon_template_list, icon_fingerprint_matrix
    if not AUGMENTS_ES.exists() or not ICONS_DIR.exists():
        print("[OCR] no se pueden cargar iconos", flush=True)
        return
    try:
        data = json.loads(AUGMENTS_ES.read_text(encoding="utf-8"))
        icon_templates = {}
        fingerprints = []
        for aug_id, augment in data.items():
            filename = augment.get("iconLarge")
            if not filename:
                continue
            path = ICONS_DIR / filename
            if not path.exists():
                continue
            img = cv2.imread(str(path))
            if img is None:
                continue
            img = cv2.resize(img, (ICON_SIZE, ICON_SIZE))
            icon_templates[str(aug_id)] = img
        icon_ids = list(icon_templates.keys())
        icon_template_list = [icon_templates[aug_id] for aug_id in icon_ids]
        for aug_id in icon_ids:
            fingerprints.append(fingerprint_icon(icon_templates[aug_id]))
        icon_fingerprint_matrix = np.vstack(fingerprints) if fingerprints else None
        print(f"[OCR] {len(icon_ids)} iconos cargados para matching", flush=True)
    except Exception as e:
        print(f"[OCR] error cargando iconos: {e}", flush=True)


def load_champion_tiers(champ_id):
    global augment_tiers
    if not champ_id:
        return
    cache_file = CHAMPION_CACHE / f"champion_{champ_id}.json"
    if not cache_file.exists():
        print(f"[OCR] no hay cache para campeon {champ_id}", flush=True)
        augment_tiers = {}
        return
    try:
        data = json.loads(cache_file.read_text(encoding="utf-8"))
        augment_tiers = data.get("augments", {})
        print(f"[OCR] tiers cargados para campeon {champ_id}: {len(augment_tiers)} augments", flush=True)
    except Exception as e:
        print(f"[OCR] error cargando cache campeon {champ_id}: {e}", flush=True)
        augment_tiers = {}


# Posiciones de referencia calibradas en 2560x1440 (21:9, área de juego 16:9)
# Igual que SKILL_POS en el overlay: píxeles absolutos en resolución de referencia
REF_W = 2560
REF_H = 1440

TEXTO_REF = [
    {"cx": 1280 + int(REF_H * -0.3271), "top": int(REF_H * 0.3549), "width": int(REF_H * 0.2333), "height": int(REF_H * 0.0597)},
    {"cx": 1280 + int(REF_H * -0.0014), "top": int(REF_H * 0.3514), "width": int(REF_H * 0.2368), "height": int(REF_H * 0.0611)},
    {"cx": 1280 + int(REF_H *  0.3299), "top": int(REF_H * 0.3549), "width": int(REF_H * 0.2403), "height": int(REF_H * 0.0563)},
]

ICONO_REF = [
    {"cx": 1280 + int(REF_H * -0.3271), "top": int(REF_H * 0.2007), "width": int(REF_H * 0.1757), "height": int(REF_H * 0.1521)},
    {"cx": 1280 + int(REF_H * -0.0007), "top": int(REF_H * 0.1993), "width": int(REF_H * 0.1771), "height": int(REF_H * 0.1500)},
    {"cx": 1280 + int(REF_H *  0.3299), "top": int(REF_H * 0.1993), "width": int(REF_H * 0.1792), "height": int(REF_H * 0.1535)},
]


def _escalar_zonas(ref_zonas, W, H):
    # Igual que calcSkillPos en overlay.html:
    # GAME_W = SCREEN_H * 16/9, scaleX = GAME_W/2560, scaleY = GAME_H/1440
    game_w   = round(H * 16 / 9)
    offset_x = (W - game_w) // 2
    scale_x  = game_w / REF_W
    scale_y  = H      / REF_H
    zonas = []
    for z in ref_zonas:
        w = round(z["width"]  * scale_x)
        h = round(z["height"] * scale_y)
        zonas.append({
            "left":   offset_x + round(z["cx"] * scale_x) - w // 2,
            "top":    round(z["top"] * scale_y),
            "width":  w,
            "height": h,
        })
    return zonas


def calcular_zonas_texto(W, H):
    return _escalar_zonas(TEXTO_REF, W, H)


def calcular_zonas_icono(W, H):
    return _escalar_zonas(ICONO_REF, W, H)


def calcular_zonas_carta(zonas_texto, zonas_icono):
    zonas = []
    for z_texto, z_icono in zip(zonas_texto, zonas_icono):
        left = min(z_texto["left"], z_icono["left"])
        top = min(z_texto["top"], z_icono["top"])
        right = max(z_texto["left"] + z_texto["width"], z_icono["left"] + z_icono["width"])
        bottom = max(z_texto["top"] + z_texto["height"], z_icono["top"] + z_icono["height"])
        zonas.append({
            "left": left,
            "top": top,
            "width": right - left,
            "height": bottom - top,
        })
    return zonas


def get_monitor(sct):
    m = sct.monitors[1]
    return m["width"], m["height"]


def capture_bgr(zona, sct):
    sc = sct.grab(zona)
    return np.frombuffer(sc.raw, dtype=np.uint8).reshape(sc.height, sc.width, 4)[:, :, :3].copy()


def crop_relative(card_bgr, base_zone, sub_zone):
    x1 = max(0, sub_zone["left"] - base_zone["left"])
    y1 = max(0, sub_zone["top"] - base_zone["top"])
    x2 = min(card_bgr.shape[1], x1 + sub_zone["width"])
    y2 = min(card_bgr.shape[0], y1 + sub_zone["height"])
    if x2 <= x1 or y2 <= y1:
        return None
    return card_bgr[y1:y2, x1:x2]


def hay_carta_en_crop(icon_crop):
    try:
        if icon_crop is None or icon_crop.size == 0:
            return False
        h, w = icon_crop.shape[:2]
        pad = max(4, w // 10)
        puntos = [
            icon_crop[pad, pad],
            icon_crop[pad, w - pad - 1],
            icon_crop[h - pad - 1, pad],
            icon_crop[h - pad - 1, w - pad - 1],
        ]
        oscuras = sum(1 for p in puntos if int(p[0]) + int(p[1]) + int(p[2]) < 80)
        return oscuras >= 2
    except Exception as e:
        print(f"[OCR] error hay_carta_en_crop: {e}", flush=True)
        return False


def cosine_similarity(vec_a, vec_b):
    if vec_a is None or vec_b is None:
        return 0.0
    return float(np.dot(vec_a, vec_b))


def leer_texto_desde_bgr(img_bgr, rapid_engine):
    if img_bgr is None or img_bgr.size == 0:
        return ""
    img_rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)
    img = Image.fromarray(img_rgb)
    img = ImageOps.expand(img, border=10, fill=(0, 0, 0))
    img_np = np.array(img)
    try:
        result, _ = rapid_engine(img_np)
    except Exception as e:
        print(f"[OCR] error RapidOCR: {e}", flush=True)
        return ""
    if not result:
        return ""
    partes = [r[1] for r in result if float(r[2]) > 0.50]
    return limpiar_texto_ocr(" ".join(partes))


def similitud(a, b):
    a, b = normalizar(a), normalizar(b)
    if not a or not b:
        return 0
    if a == b:
        return 100
    ratio = SequenceMatcher(None, a, b).ratio()
    pa, pb = set(a.split()), set(b.split())
    comunes = pa & pb
    token_score = 0.0 if not comunes else len(comunes) / max(len(pa), len(pb))
    prefix_score = 0.1 if min(len(a), len(b)) >= 4 and (a.startswith(b[:4]) or b.startswith(a[:4])) else 0.0
    return int(100 * min(1.0, ratio * 0.65 + token_score * 0.25 + prefix_score))


def buscar_augment_por_texto(texto_ocr):
    if not texto_ocr or len(texto_ocr) < UMBRAL_TEXTO:
        return None, 0
    mejor_id = None
    mejor_score = 0
    texto_norm = normalizar(texto_ocr)
    for nombre_es, aug_id in augments_es.items():
        score = similitud(texto_norm, nombre_es)
        if score > mejor_score:
            mejor_score = score
            mejor_id = aug_id
    if mejor_score >= 40:
        return mejor_id, mejor_score
    return None, mejor_score


def candidatos_por_icono(icon_crop, top_n=5):
    if not icon_ids or icon_crop is None or icon_crop.size == 0:
        return []
    try:
        img_np = cv2.resize(icon_crop, (ICON_SIZE, ICON_SIZE))
        shortlist_idx = range(len(icon_ids))
        if icon_fingerprint_matrix is not None and len(icon_ids) > ICON_SHORTLIST:
            fp = fingerprint_icon(img_np)
            cheap_scores = icon_fingerprint_matrix @ fp
            shortlist_idx = np.argsort(cheap_scores)[-ICON_SHORTLIST:][::-1]
        scores = []
        for idx in shortlist_idx:
            idx = int(idx)
            score = float(cv2.matchTemplate(img_np, icon_template_list[idx], cv2.TM_CCOEFF_NORMED)[0][0])
            scores.append((icon_ids[idx], score))
        scores.sort(key=lambda x: x[1], reverse=True)
        return scores[:top_n]
    except Exception as e:
        print(f"[OCR] error icon matching: {e}", flush=True)
        return []


def get_tier(aug_id):
    if not aug_id:
        return None
    tier = augment_tiers.get(str(aug_id), augment_tiers.get(aug_id))
    if tier is not None:
        return int(tier)
    tier = augments_general.get(str(aug_id))
    if tier is not None:
        return int(tier)
    return None

def _crear_ocr():
    """Intenta GPU (DML → CUDA) y cae a CPU si no está disponible."""
    import onnxruntime as ort
    providers_disponibles = ort.get_available_providers()
    print(f"[OCR] providers ONNX disponibles: {providers_disponibles}", flush=True)

    if "DmlExecutionProvider" in providers_disponibles:
        try:
            engine = RapidOCR(providers=["DmlExecutionProvider", "CPUExecutionProvider"])
            engine(np.zeros((40, 200, 3), dtype=np.uint8))
            print("[OCR] usando DirectML (GPU)", flush=True)
            return engine
        except Exception as e:
            print(f"[OCR] DirectML falló, probando CUDA: {e}", flush=True)

    if "CUDAExecutionProvider" in providers_disponibles:
        try:
            engine = RapidOCR(det_use_cuda=True, rec_use_cuda=True)
            engine(np.zeros((40, 200, 3), dtype=np.uint8))
            print("[OCR] usando CUDA (NVIDIA GPU)", flush=True)
            return engine
        except Exception as e:
            print(f"[OCR] CUDA falló, usando CPU: {e}", flush=True)

    print("[OCR] usando CPU (sin GPU disponible)", flush=True)
    return RapidOCR()


def hay_boton(sct, W, H):
    """Detecta si el botón azul de selección de aumentos está visible."""
    game_w   = round(H * 16 / 9)
    offset_x = (W - game_w) // 2
    scale_x  = game_w / REF_W
    scale_y  = H      / REF_H
    bw = round(REF_W * BOTON_REL["w"] * scale_x)
    zona = {
        "left":   offset_x + round(REF_W * BOTON_REL["x"] * scale_x) - bw // 2,
        "top":    round(REF_H * BOTON_REL["y"] * scale_y),
        "width":  bw,
        "height": round(REF_H * BOTON_REL["h"] * scale_y),
    }
    # Clamp para no salirse de pantalla
    zona["left"] = max(0, zona["left"])
    zona["top"]  = max(0, zona["top"])

    try:
        bgr = capture_bgr(zona, sct)
        hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
        mask = cv2.inRange(hsv, BOTON_HSV_LOW, BOTON_HSV_HIGH)
        return int(mask.sum() // 255) >= BOTON_MIN_PIXELS
    except Exception:
        return False

def main_loop():
    global champion_id

    load_augments_es()
    load_augments_general()
    load_icon_templates()
    icon_templates.clear()

    rapid = _crear_ocr()
    try:
        _dummy = np.zeros((int(1440 * 0.0611) + 20, int(1440 * 0.2368) + 20, 3), dtype=np.uint8)
        for _ in range(4):
            rapid(_dummy)
        print("[OCR] RapidOCR precalentado OK", flush=True)
    except Exception:
        pass

    sct = mss.mss()
    W, H = get_monitor(sct)
    sct = mss.mss()

    zonas_texto = calcular_zonas_texto(W, H)
    zonas_icono = calcular_zonas_icono(W, H)
    zonas_carta = calcular_zonas_carta(zonas_texto, zonas_icono)

    print(f"[OCR] resolucion: {W}x{H}", flush=True)
    for i, z in enumerate(zonas_texto):
        print(f"[OCR] texto zona {i+1}: x={z['left']} y={z['top']} {z['width']}x{z['height']}", flush=True)
    for i, z in enumerate(zonas_icono):
        print(f"[OCR] icono zona {i+1}: x={z['left']} y={z['top']} {z['width']}x{z['height']}", flush=True)
    for i, z in enumerate(zonas_carta):
        print(f"[OCR] carta zona {i+1}: x={z['left']} y={z['top']} {z['width']}x{z['height']}", flush=True)
    print("[OCR] RapidOCR iniciado - esperando boton...", flush=True)

    boton_visible = False
    tiempo_sin_texto = None
    last_ids = None
    stable_ids = None
    stable_count = 0
    tiempo_sin_boton = time.time()
    slot_cache = [
        {"visible": False, "icon_fp": None, "texto": "", "candidatos": [], "analysis_reused": False}
        for _ in range(3)
    ]

    while True:
        # ── Fase idle: esperar al botón ──────────────────────────
        if not hay_boton(sct, W, H):
            if not boton_visible:
                elapsed = time.time() - tiempo_sin_boton
                if elapsed > 120:
                    time.sleep(POLL_IDLE_SLOW)
                elif elapsed > 30:
                    time.sleep(POLL_IDLE_MED)
                else:
                    time.sleep(POLL_IDLE)
                continue
            else:
                boton_visible = True
                tiempo_sin_boton = time.time()

        # ── Fase activa: analizar las 3 cartas ──────────────────
        _t0 = time.time()
        cards = []
        cartas_reales = 0  # ← cartas visibles en pantalla sin cache
        for idx in range(3):
            cache_entry = slot_cache[idx]
            try:
                card_bgr  = capture_bgr(zonas_carta[idx], sct)
                icon_crop = crop_relative(card_bgr, zonas_carta[idx], zonas_icono[idx])
                text_crop = crop_relative(card_bgr, zonas_carta[idx], zonas_texto[idx])
                visible   = hay_carta_en_crop(icon_crop)

                if visible:
                    cartas_reales += 1  # ← contar solo las reales

                texto         = ""
                candidatos    = []
                icon_fp       = None
                analysis_reused = False

                # Si el icono está tapado pero teníamos datos del slot, los reutilizamos
                if not visible and cache_entry["visible"] and cache_entry["texto"]:
                    texto           = cache_entry["texto"]
                    candidatos      = cache_entry["candidatos"]
                    icon_fp         = cache_entry["icon_fp"]
                    analysis_reused = True
                    visible         = True  # tratar como visible para no romper el flujo

                if visible:
                    icon_small = cv2.resize(icon_crop, (ICON_SIZE, ICON_SIZE)) if icon_fp is None else None
                    if icon_fp is None and icon_small is not None:
                        icon_fp = fingerprint_icon(icon_small)
                    if not analysis_reused and cache_entry["visible"] and cache_entry["icon_fp"] is not None:
                        similarity = cosine_similarity(icon_fp, cache_entry["icon_fp"])
                        if similarity >= REUSE_ICON_SIMILARITY:
                            texto           = cache_entry["texto"]
                            candidatos      = cache_entry["candidatos"]
                            analysis_reused = True
                    if not analysis_reused:
                        texto      = leer_texto_desde_bgr(text_crop, rapid)
                        candidatos = candidatos_por_icono(icon_crop)

                cards.append({
                    "idx": idx, "visible": visible, "icon_fp": icon_fp,
                    "texto": texto, "candidatos": candidatos,
                    "analysis_reused": analysis_reused,
                })
                slot_cache[idx] = {
                    "visible": visible, "icon_fp": icon_fp,
                    "texto": texto, "candidatos": candidatos,
                    "analysis_reused": analysis_reused,
                }
            except Exception as e:
                print(f"[OCR] error carta {idx+1}: {e}", flush=True)
                cards.append({
                    "idx": idx, "visible": False, "icon_fp": None,
                    "texto": "", "candidatos": [], "analysis_reused": False,
                })

        # Sin cartas reales en pantalla durante 1s → ocultar
        if cartas_reales == 0:
            if tiempo_sin_texto is None:
                tiempo_sin_texto = time.time()
            elif time.time() - tiempo_sin_texto >= 1.0:
                print(json.dumps({"type": "ocultar"}), flush=True)
                boton_visible    = False
                tiempo_sin_texto = None
                last_ids         = None
                tiempo_sin_boton = time.time()
                stable_ids       = None
                stable_count     = 0
                slot_cache = [
                    {"visible": False, "icon_fp": None, "texto": "", "candidatos": [], "analysis_reused": False}
                    for _ in range(3)
                ]
            time.sleep(POLL_ACTIVE)
            continue

        tiempo_sin_texto = None
        print(f"[PERF] captura+análisis: {(time.time()-_t0)*1000:.0f}ms", flush=True)

        # Sin texto suficiente todavía (cartas visibles pero OCR no leyó aún)
        if not any(len(c["texto"]) >= UMBRAL_TEXTO for c in cards):
            time.sleep(POLL_ACTIVE)
            continue
        
        # ── Fusión de scores (igual que antes) ──────────────────
        matches       = []
        result_ids    = []
        combined_scores = []
        reused_slots  = 0

        for i, card in enumerate(cards):
            texto      = card["texto"]
            candidatos = card["candidatos"]
            if card["analysis_reused"]:
                reused_slots += 1

            id_ocr, score_ocr = buscar_augment_por_texto(texto)
            score_ocr_norm    = score_ocr / 100.0

            if not candidatos:
                aug_id      = id_ocr
                sc_icon     = 0.0
                sc_combined = round(score_ocr_norm * 0.8, 2)
            else:
                mejor_score_icon    = candidatos[0][1]
                score_icon_para_ocr = next((sc for aid, sc in candidatos if aid == id_ocr), 0.0)
                if id_ocr and score_icon_para_ocr > 0:
                    aug_id      = id_ocr
                    sc_icon     = score_icon_para_ocr
                    sc_combined = round(sc_icon * 0.5 + score_ocr_norm * 0.5, 2)
                elif id_ocr and score_ocr >= 70:
                    aug_id      = id_ocr
                    sc_icon     = mejor_score_icon
                    sc_combined = round(mejor_score_icon * 0.3 + score_ocr_norm * 0.7, 2)
                else:
                    aug_id      = candidatos[0][0]
                    sc_icon     = mejor_score_icon
                    sc_combined = round(mejor_score_icon * 0.7 + score_ocr_norm * 0.3, 2)

            tier   = get_tier(aug_id)
            nombre = augments_id_name.get(str(aug_id), "") if aug_id else ""
            result_ids.append(aug_id)
            matches.append({
                "id": aug_id, "name": nombre, "tier": tier,
                "recognizedText": texto, "reused": card["analysis_reused"],
                "score": {"icon": round(sc_icon, 2), "ocr": round(score_ocr_norm, 2), "combined": sc_combined},
            })
            combined_scores.append(sc_combined)
            print(
                f"[OCR] zona {i+1}: '{texto}' icon={sc_icon:.2f} ocr={score_ocr_norm:.2f} "
                f"combined={sc_combined} reused={card['analysis_reused']} -> id={aug_id} tier={tier}",
                flush=True,
            )

        result_tiers = [m["tier"] for m in matches]

        if result_ids == stable_ids:
            stable_count += 1
        else:
            stable_ids   = result_ids
            stable_count = 1

        required_confirmations = CONFIRM_NEEDED
        if combined_scores and min(combined_scores) >= FAST_CONFIRM_CONFIDENCE:
            required_confirmations = 1
        elif reused_slots >= 2 and combined_scores and max(combined_scores) >= 0.80:
            required_confirmations = 1

        if stable_count >= required_confirmations and result_ids != last_ids:
            if champion_id is None:
                print("[OCR] esperando champion_id...", flush=True)
                time.sleep(0.5)
                continue
            msg = {
                "type": "tiers", "tiers": result_tiers,
                "ids": result_ids, "campeon": champion_id, "matches": matches,
            }
            print(json.dumps(msg), flush=True)
            print(f"[OCR] enviado al overlay: tiers={result_tiers} ids={result_ids}", flush=True)
            last_ids     = result_ids
            stable_count = 0

        time.sleep(POLL_ACTIVE)



def stdin_reader():
    global champion_id
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
            if "campeon" in msg:
                new_id = str(msg["campeon"])
                if new_id != champion_id:
                    champion_id = new_id
                    load_champion_tiers(champion_id)
                    print(f"[OCR] campeon actualizado: {champion_id}", flush=True)
        except Exception as e:
            print(f"[OCR] error stdin: {e}", flush=True)


if __name__ == "__main__":
    t = threading.Thread(target=stdin_reader, daemon=True)
    t.start()
    main_loop()
