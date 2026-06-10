// src/sheets/columns.js
// Mapa de columnas del tab "IA para abogados _ EstadoX" del Google Sheet de leads
// (§18.B). Índices 0-based (A=0, B=1, …). Estructura inspeccionada el 2026-06-10:
// 47 columnas, el Sheet está conectado a un Google Form (cada fila = una postulación).
//
// Sólo se usan estas 4 columnas; el resto son UTM/PII (nombre, teléfono, correo) y
// NO entran al reporte del grupo.

export const COL = {
  submittedAt: 19, // T — marca temporal "Submitted At", formato D/M/YYYY H:MM:SS (hora local Bogotá)
  iaPrev: 5,       // F — "¿experiencia previa con IA?" (TRUE/FALSE)
  inversion: 6,    // G — "¿invertir hasta $1200 USD?" (Sí / No / Sí pero financiado)
  momento: 12,     // M — "¿Cuál describe mejor tu momento profesional?"
};

// Categorías para el desglose del reporte. El orden de este arreglo = el orden en
// que aparecen en el mensaje. `normalize` (opcional) unifica/embellece el valor
// crudo de la celda antes de contarlo (ej. TRUE/FALSE → Sí/No).
export const CATEGORIES = [
  {
    key: 'momento',
    col: COL.momento,
    label: 'Momento profesional',
  },
  {
    key: 'iaPrev',
    col: COL.iaPrev,
    label: 'Experiencia previa con IA',
    normalize: (v) => {
      const s = v.trim().toLowerCase();
      if (s === 'true' || s === 'sí' || s === 'si' || s === 'verdadero') return 'Sí';
      if (s === 'false' || s === 'no' || s === 'falso') return 'No';
      return v.trim();
    },
  },
  {
    key: 'inversion',
    col: COL.inversion,
    label: 'Dispuesto a invertir (hasta $1200 USD)',
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
