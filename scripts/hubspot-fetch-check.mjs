// scripts/hubspot-fetch-check.mjs
// Verificación en crudo de la query de deals de HubSpot (sin DB ni WhatsApp). Cierra los
// open items antes del cutover: formato real de dealname y telefono_de_contcato, y qué trae
// cada deal. Ver docs/HUBSPOT-CUTOVER.md.
//
// Uso (con el token real en el entorno; p.ej. en el VPS):
//   HUBSPOT_TOKEN=pat-xxx node scripts/hubspot-fetch-check.mjs [YYYY-MM-DD]
// Sin fecha usa HOY (hora Bogotá).

import { searchDeals } from '../src/hubspot/client.js';
import { dealToEvent, pipelineConfig } from '../src/hubspot/index.js';

// Ventana UTC del día Bogotá (UTC-5): {D}T05:00:00Z .. {D+1}T04:59:59Z.
function bogotaDayWindow(dateStr) {
  const d = dateStr || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' }); // YYYY-MM-DD
  const [y, m, day] = d.split('-').map(Number);
  const min = new Date(Date.UTC(y, m - 1, day, 5, 0, 0)).toISOString();
  const max = new Date(Date.UTC(y, m - 1, day + 1, 4, 59, 59)).toISOString();
  return { d, minStartIso: min, maxStartIso: max };
}

if (!process.env.HUBSPOT_TOKEN) {
  console.error('Falta HUBSPOT_TOKEN en el entorno.');
  process.exit(1);
}

const { d, minStartIso, maxStartIso } = bogotaDayWindow(process.argv[2]);
console.log(`Ventana Bogotá ${d}: ${minStartIso} .. ${maxStartIso}\n`);

const cfg = pipelineConfig();
const deals = await searchDeals({ minStartIso, maxStartIso, pipelines: cfg });
console.log(`Deals: ${deals.length}\n`);
for (const deal of deals) {
  console.log('— raw:', JSON.stringify(deal.properties));
  console.log('  ev :', JSON.stringify(dealToEvent(deal, cfg)));
}
