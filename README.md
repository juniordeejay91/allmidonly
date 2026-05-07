# ARAM CAOS

Helper de Electron para ARAM Caos con overlay OCR, integración con LCU y versión web ligera.

## Estructura

```text
aram-caos/
├── main.js
├── preload.js
├── aram_caos_v6.html
├── overlay.html
├── overlay_preload.js
├── aramcaos_ocr.py
├── proxy_riot.py
├── server.js
├── package.json
├── public/
├── cache/
├── campeones/
├── img/
├── augmentos/
├── objetos/
├── docs/
├── scripts/
├── tools/
└── legacy/
```

## Qué va en cada sitio

- `docs/`: setup, notas y pendientes.
- `scripts/`: generadores y utilidades de mantenimiento.
- `tools/calibration/`: herramientas para recalibrar OCR.
- `tools/debug/`: pruebas manuales, capturas y utilidades OCR.
- `tools/experiments/`: pruebas no integradas en el flujo principal.
- `legacy/`: archivos antiguos fuera del arranque actual.

## Arranque

```bash
npm install
npm start
```

## Nota

El núcleo de producción se mantiene en la raíz para no romper rutas de Electron y Python.
