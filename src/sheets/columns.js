// src/sheets/columns.js
// Mapa de columnas del tab "IA para abogados _ EstadoX" del Google Sheet de leads
// (§18.B). Índices 0-based (A=0, B=1, …). Estructura inspeccionada el 2026-06-10:
// 47 columnas, el Sheet está conectado a un Google Form (cada fila = una postulación).
//
// Sólo se usan estas columnas; el resto son UTM/PII (nombre, teléfono, correo) y
// NO entran al reporte del grupo.

export const COL = {
  submittedAt: 19, // T — marca temporal "Submitted At", formato D/M/YYYY H:MM:SS (hora local Bogotá)
  iaPrev: 5,       // F — "¿experiencia previa con IA?" (TRUE/FALSE) — ya no entra al reporte
  inversion: 6,    // G — "¿invertir hasta $1200 USD?" (Sí / No / Sí pero financiado)
  momento: 12,     // M — "¿Cuál describe mejor tu momento profesional?" — ya no entra al reporte
  calendly: 8,     // I — "Agenda aquí tu entrevista final…" → URL de invitee de Calendly (booked si no vacío)
};

// Categorías para el desglose del reporte. El orden de este arreglo = el orden en
// que aparecen en el mensaje. `normalize` (opcional) unifica/embellece el valor
// crudo de la celda antes de contarlo (ej. TRUE/FALSE → Sí/No).
//
// El jefe pidió (2026-06-10) que el reporte automático de las 8pm muestre SÓLO la
// inversión: "momento profesional" y "experiencia previa con IA" salen del desglose.
export const CATEGORIES = [
  {
    key: 'inversion',
    col: COL.inversion,
    // La columna G del Form sigue preguntando por $1200, pero el precio real del
    // programa es $1000 USD → lo mostramos así en el mensaje (sólo rótulo, los datos
    // se siguen leyendo de la misma columna).
    label: 'Dispuesto a invertir ($1000 USD)',
    // El Form guarda frases largas ("No. Es imposible para mi invertir ese monto.")
    // → las condensamos a 3 categorías legibles para el reporte.
    normalize: (v) => {
      const s = v.trim().toLowerCase();
      if (s.includes('financ')) return 'Sí (financiado)';
      if (s.startsWith('no')) return 'No';
      if (s.startsWith('sí') || s.startsWith('si')) return 'Sí';
      return v.trim();
    },
  },
];

// Columnas del tab "📞 Setteo Pendiente" — fuente del conteo de self-checkout (§18.B).
// El jefe indicó (2026-06-10) tomar el self-checkout de esta hoja, no del tab de leads.
// Índices 0-based. Estructura inspeccionada el 2026-06-10.
export const SETTEO = {
  fecha: 0,      // A — "Fecha detección", formato DD/MM/YYYY H:MM (la automatización lo sella)
  estadoPago: 6, // G — "💳 Self-checkout" | "No hizo self-checkout"
};
