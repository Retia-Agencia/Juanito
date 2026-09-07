// src/calendly/mirror.js
// Alcance del ESPEJO DE DEV (§18.BM/§18.BV): qué Conexiones se copian al DM del dev.
//
// Módulo PURO y minúsculo a propósito. Existe porque el mismo dato lo leen dos lugares que no
// se pueden importar entre sí: el scheduler (que decide si copia un push) y el comando `/espejo`
// (que muestra y cambia el alcance). Duplicar el parseo en los dos es exactamente la deriva entre
// representaciones que este repo ya pagó caro en otros lados, y encima commands.js evita importar
// el scheduler para seguir siendo testeable sin deps nativas.
//
// Precedencia: lo que dejó el comando en la DB (`override`) le gana al `.env`. La distinción
// null/'' es la clave, y por eso es `??` y no `||`:
//   null / undefined → nadie usó el comando  → manda el `.env`
//   ''               → apagado POR COMANDO   → no se copia nada, diga lo que diga el `.env`
export function mirrorConnections(override, envValue) {
  return String((override ?? envValue) || '')
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}
