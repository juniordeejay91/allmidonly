// Script para generar augmentos/augmentos_aram_caos.json
// Ejecutar desde el directorio del proyecto: node scripts/generate_augments.js
//
// Fuente: cherry-augments.json de CommunityDragon
// Este archivo cubre tanto Arena como ARAM Caos (Kiwi), que comparten el mismo sistema.

const https = require('https');
const fs    = require('fs');
const path  = require('path');

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      // Seguir redirecciones
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return get(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error(`JSON parse error (status ${res.statusCode}): ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

async function main() {
  const url = 'https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/cherry-augments.json';
  console.log('Descargando cherry-augments.json...');

  const raw = await get(url);

  // El JSON es un array de objetos con campos: id, nameId, name, desc, iconLarge, iconSmall, rarity, ...
  // iconSmall es una ruta tipo: /lol-game-data/assets/ASSETS/Kiwi/Augments/Icons/...png
  // Se convierte a URL de CommunityDragon: 
  // plugins/rcp-be-lol-game-data/global/default/assets/kiwi/augments/icons/...png

  const result = raw.map(a => {
    let iconUrl = '';
    if (a.iconSmall) {
      // Convertir ruta interna a URL de CommunityDragon
      const p = a.iconSmall.replace('/lol-game-data/assets/', '').toLowerCase();
      iconUrl = `https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/${p}`;
    }
    return {
      id:     a.id,
      nombre: a.name || a.nameId || String(a.id),
      icono:  iconUrl,
      rareza: a.rarity ?? 0,
      desc:   a.desc ? a.desc.replace(/<[^>]+>/g, '').trim() : ''
    };
  }).filter(a => a.id && a.icono);

  const outDir  = path.join(__dirname, '..', 'augmentos');
  const outPath = path.join(outDir, 'augmentos_aram_caos.json');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf-8');

  console.log(`✓ Guardados ${result.length} augmentos en ${outPath}`);
  // Mostrar los IDs conocidos para verificar
  const check = [1356, 1195, 1225, 2009];
  check.forEach(id => {
    const found = result.find(a => a.id === id);
    console.log(`  ID ${id}: ${found ? found.nombre : '❌ NO encontrado'}`);
  });
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
