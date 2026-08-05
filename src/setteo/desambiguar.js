// src/setteo/desambiguar.js
// Elegir A CUÁL contacto de HubSpot se refiere el closer cuando hay varios con el mismo nombre.
// PURO: recibe los datos ya traídos y decide. Sin red ni DB → se puede iterar en Windows.
//
// Por qué existe (medido el 2026-08-04 sobre 30 leads reales de Registrado/Calificado):
//   · 19 de 30 (63%) devolvían VARIOS candidatos → el cruce se rendía y el lead salía con ⚠️.
//   · De esos 19, 16 quedan en UNO SOLO exigiendo que el candidato tenga un deal en etapa
//     setteable, y los 3 restantes exigiendo además que ese deal sea del MISMO owner.
//   · Ninguno quedaba irresoluble.
// O sea: el cruce pasa de 37% a 100% en la muestra. Sin esto, la cifra "registrado en HubSpot"
// —que es la razón de ser de /missetteos— le dice "no pude cruzarlo" 6 de cada 10 veces, y una
// señal que falla más de lo que acierta se deja de mirar.
//
// La regla NO es una heurística de conveniencia, es el proceso de ventas: un lead se settea
// mientras está en Registrado o Calificado; cuando agenda pasa a Agendado y deja de ser setteo.
// Así que "el candidato que tiene un deal en etapa setteable" ES, por definición, el lead que
// el closer está trabajando.
//
// Ante la duda NO se elige: devolver null (y mostrar el ⚠️) es preferible a atribuirle la
// gestión al homónimo equivocado, que le ensuciaría el conteo a dos personas a la vez.

// `candidatos`        : [{ id, … }] tal como los devuelve searchContactsByName
// `dealsPorContacto`  : Map(contactId → [{ dealstage, ownerId }])
// `etapasSetteables`  : Set(stageId)
// `ownerId`           : owner de HubSpot del closer que reporta (string) o null
//
// Devuelve { id, via } | null.  via: 'unico' | 'etapa' | 'owner' — para poder medir en el log
// cuánto está aportando cada regla sin tener que instrumentar aparte.
export function elegirContacto({ candidatos = [], dealsPorContacto = new Map(), etapasSetteables = new Set(), ownerId = null } = {}) {
  if (!candidatos.length) return null;
  if (candidatos.length === 1) return { id: String(candidatos[0].id), via: 'unico' };

  const dealsDe = (c) => dealsPorContacto.get(String(c.id)) || [];
  const enEtapa = (d) => etapasSetteables.has(d?.dealstage);

  // 1) ¿Cuál de los homónimos tiene un deal VIVO en etapa de setteo?
  const conEtapa = candidatos.filter((c) => dealsDe(c).some(enEtapa));
  if (conEtapa.length === 1) return { id: String(conEtapa[0].id), via: 'etapa' };

  // 2) Si varios lo tienen, gana el que además es del closer que está reportando. Sin ownerId
  //    (owner no resuelto, HubSpot a medias) no se adivina: se cae a null.
  if (conEtapa.length > 1 && ownerId) {
    const delOwner = conEtapa.filter((c) => dealsDe(c).some((d) => enEtapa(d) && String(d.ownerId) === String(ownerId)));
    if (delOwner.length === 1) return { id: String(delOwner[0].id), via: 'owner' };
  }

  // 0 candidatos en etapa setteable también cae acá: si NINGUNO está en Registrado/Calificado,
  // lo más probable es que el closer se refiera a alguien que no tenemos bien identificado.
  // Inventar un match ahí sería peor que el ⚠️.
  return null;
}
