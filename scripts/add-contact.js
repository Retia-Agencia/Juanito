// scripts/add-contact.js
// Cargar/listar contactos del directorio sin escribir SQL a mano.
//
// Uso:
//   node scripts/add-contact.js "Juan" "+57 300 111 2222"   # agregar/actualizar
//   node scripts/add-contact.js --list                       # listar todos
//
// En el VPS (dentro del contenedor):
//   docker compose exec agent node scripts/add-contact.js "Juan" "573001112222"

import 'dotenv/config';
import { upsertContact, listContacts } from '../src/contacts/index.js';

const args = process.argv.slice(2);

function printList() {
  const contacts = listContacts();
  if (!contacts.length) {
    console.log('(directorio de contactos vacío)');
    return;
  }
  console.log(`Contactos (${contacts.length}):`);
  for (const c of contacts) console.log(`  - ${c.name}: ${c.phone}`);
}

if (args[0] === '--list' || args.length === 0) {
  printList();
  process.exit(0);
}

if (args.length < 2) {
  console.error('Uso: node scripts/add-contact.js "Nombre" "+57 300 111 2222"');
  console.error('     node scripts/add-contact.js --list');
  process.exit(1);
}

const [name, phone] = args;
try {
  upsertContact({ name, phone });
  console.log(`✅ Contacto guardado: ${name}`);
  printList();
} catch (err) {
  console.error(`❌ Error: ${err.message}`);
  process.exit(1);
}
