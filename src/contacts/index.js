// src/contacts/index.js
// Directorio de contactos — resolver "Juan" -> número de teléfono.

import db from '../db/index.js';
import { normalizePhone, phonesMatch } from '../common/utils.js';

// ─── Upsert / listado ─────────────────────────────────────────────────────────

export function upsertContact({ name, phone }) {
  const cleanName = String(name || '').trim();
  const cleanPhone = normalizePhone(phone);
  if (!cleanName || !cleanPhone) {
    throw new Error('upsertContact requiere name y phone válidos');
  }
  return db
    .prepare(`
      INSERT INTO contacts (name, phone)
      VALUES (?, ?)
      ON CONFLICT(name) DO UPDATE SET phone = excluded.phone
    `)
    .run(cleanName, cleanPhone);
}

export function listContacts() {
  return db.prepare(`SELECT name, phone FROM contacts ORDER BY name ASC`).all();
}

// ─── Resolución ───────────────────────────────────────────────────────────────
// Acepta un nombre ("Juan") o un número ("+57 300...") y devuelve { name, phone } | null.

export function resolveContact(nameOrPhone) {
  const input = String(nameOrPhone || '').trim();
  if (!input) return null;

  const contacts = listContacts();

  // 1. ¿Parece un número? (mayoría de dígitos) -> match por teléfono
  const digits = normalizePhone(input);
  const looksLikePhone = digits.length >= 7 && digits.length / input.replace(/\s/g, '').length > 0.6;
  if (looksLikePhone) {
    const byPhone = contacts.find((c) => phonesMatch(c.phone, digits));
    if (byPhone) return { name: byPhone.name, phone: byPhone.phone };
    // Número crudo no guardado: igual lo devolvemos para poder enviarle
    return { name: null, phone: digits };
  }

  // 2. Match por nombre: exacto -> empieza con -> contiene (case-insensitive)
  const q = input.toLowerCase();
  const exact = contacts.find((c) => c.name.toLowerCase() === q);
  if (exact) return { name: exact.name, phone: exact.phone };

  const starts = contacts.filter((c) => c.name.toLowerCase().startsWith(q));
  if (starts.length === 1) return { name: starts[0].name, phone: starts[0].phone };

  const includes = contacts.filter((c) => c.name.toLowerCase().includes(q));
  if (includes.length === 1) return { name: includes[0].name, phone: includes[0].phone };

  // Ambiguo o no encontrado
  return null;
}
