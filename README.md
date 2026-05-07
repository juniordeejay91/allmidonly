# ALL MID ONLY

Aplicacion de escritorio creada con Electron para apoyar partidas de ARAM con utilidades visuales, integracion con el cliente de League of Legends y build para Windows.

## Caracteristicas

- Aplicacion de escritorio con Electron
- Integracion con LCU
- Recursos locales para overlays, imagenes y datos
- Build para Windows con `electron-builder`
- Preparada para publicar releases en GitHub

## Stack

- Electron
- Node.js
- electron-builder
- Supabase
- Puppeteer

## Estructura

```text
allmidonly/
├── assets/
├── img/
├── objetos/
├── public/
├── scripts/
├── src/
├── package.json
└── README.md
```

## Desarrollo

Instalar dependencias:

```bash
npm install
```

Arrancar la app:

```bash
npm start
```

Servidor web auxiliar:

```bash
npm run web:start
```

## Build

Generar instalador Windows:

```bash
npm run build:release
```

Build local con devtools:

```bash
npm run build:local
```

El instalador generado queda en:

```text
dist/ALL MID ONLY Setup.exe
```

## GitHub

El proyecto publica sus releases en:

`juniordeejay91/allmidonly`

## Archivos ignorados

Estos directorios no deben subirse al repo:

- `node_modules/`
- `cache/`
- `historial/`
- `dist/`
- `vendor/python/`
