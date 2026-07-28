// test/hubspot.phone-by-name.test.js
// Rescate del teléfono del lead POR NOMBRE (findPhoneByName), con `fetch` interceptado.
//
// Por qué existe: el lead llena el formulario con un correo y agenda en Calendly con otro, así
// que HubSpot queda con DOS contactos de la misma persona. El que Juanito consulta (el del
// correo de Calendly) es un cascarón sin teléfono → el push precall salía "mándalo manual"
// teniendo el número en el gemelo. Casos reales medidos el 2026-07-28: Francisco Patarroyo y
// Diana Fonseca.
//
// Lo que de verdad se fija acá es la REGLA DE AMBIGÜEDAD: ante homónimos con teléfonos
// distintos hay que devolver null. Si esta regla se rompe, el closer le manda el push precall
// —con el nombre del lead— al teléfono de OTRA persona.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.HUBSPOT_PAT = 'fake-pak-para-tests';
delete process.env.HUBSPOT_ENABLED;

const { findPhoneByName } = await import('../src/hubspot/client.js');

const contacto = (id, firstname, lastname, phone, mobilephone = null) => ({
  id: String(id),
  properties: { firstname, lastname, email: `${id}@x.com`, phone, mobilephone },
});

// Intercepta el intercambio de token y el /search. Devuelve las búsquedas capturadas.
function stubFetch(resultados) {
  const capturado = [];
  global.fetch = async (url, opts) => {
    if (String(url).includes('/localdevauth/')) {
      return {
        ok: true,
        json: async () => ({ oauthAccessToken: 'tok', expiresAtMillis: Date.now() + 20 * 60_000 }),
      };
    }
    capturado.push(JSON.parse(opts.body));
    return { ok: true, json: async () => ({ results: resultados, total: resultados.length }) };
  };
  return capturado;
}

test('un solo homónimo con teléfono → lo devuelve (caso Francisco Patarroyo)', async () => {
  const capturado = stubFetch([contacto(237475367219, 'Francisco', 'Patarroyo', '573209836707')]);
  assert.equal(await findPhoneByName('Francisco Leonardo Patarroyo'), '573209836707');
  // El apellido que se busca es la ÚLTIMA palabra, no la segunda: "Francisco Leonardo
  // Patarroyo" tiene que buscar por Patarroyo, no por Leonardo.
  const filtros = capturado[0].filterGroups[0].filters;
  assert.equal(filtros.find((f) => f.propertyName === 'firstname').value, 'Francisco');
  assert.equal(filtros.find((f) => f.propertyName === 'lastname').value, 'Patarroyo');
});

test('dos homónimos con el MISMO teléfono en distinto formato → no es ambigüedad (caso Diana Fonseca)', async () => {
  // Real: los dos contactos de Diana traen el mismo número, uno con "+" y otro sin él.
  stubFetch([
    contacto(230939957127, 'Diana', 'Fonseca', '+573215087717'),
    contacto(237629150473, 'Diana', 'Fonseca', '573215087717'),
  ]);
  const tel = await findPhoneByName('Diana Fonseca');
  assert.ok(tel, 'un solo número real → debe resolver');
  assert.equal(String(tel).replace(/\D/g, ''), '573215087717');
});

test('homónimos con teléfonos DISTINTOS → null (nunca adivinar a quién se le escribe)', async () => {
  stubFetch([
    contacto(1, 'Juan', 'Pérez', '573001111111'),
    contacto(2, 'Juan', 'Pérez', '573002222222'),
  ]);
  assert.equal(await findPhoneByName('Juan Pérez'), null);
});

test('sin homónimos, o con homónimos sin teléfono → null', async () => {
  stubFetch([]);
  assert.equal(await findPhoneByName('Nadie Existente'), null);
  stubFetch([contacto(3, 'Ana', 'Gómez', null, null)]);
  assert.equal(await findPhoneByName('Ana Gómez'), null);
});

test('prefiere mobilephone sobre phone (igual que getContactPhone)', async () => {
  stubFetch([contacto(4, 'Luis', 'Díaz', '573000000000', '573114445566')]);
  assert.equal(await findPhoneByName('Luis Díaz'), '573114445566');
});

test('un nombre de UNA palabra no identifica a nadie → null SIN consultar la API', async () => {
  const capturado = stubFetch([contacto(5, 'Dana', 'X', '573009999999')]);
  assert.equal(await findPhoneByName('Dana'), null);
  assert.equal(await findPhoneByName(''), null);
  assert.equal(await findPhoneByName(null), null);
  assert.equal(capturado.length, 0, 'no debe llegar a pegarle a HubSpot');
});

test('si la API falla, devuelve null en vez de tirar (el push precall no se puede romper)', async () => {
  global.fetch = async (url) => {
    if (String(url).includes('/localdevauth/')) {
      return { ok: true, json: async () => ({ oauthAccessToken: 'tok', expiresAtMillis: Date.now() + 20 * 60_000 }) };
    }
    return { ok: false, status: 500, text: async () => 'boom' };
  };
  assert.equal(await findPhoneByName('Francisco Patarroyo'), null);
});

test('la búsqueda es READ-ONLY: solo /search de contactos, nada de escritura', async () => {
  const capturado = [];
  global.fetch = async (url, opts) => {
    if (String(url).includes('/localdevauth/')) {
      return { ok: true, json: async () => ({ oauthAccessToken: 'tok', expiresAtMillis: Date.now() + 20 * 60_000 }) };
    }
    capturado.push(String(url));
    return { ok: true, json: async () => ({ results: [] }) };
  };
  await findPhoneByName('Francisco Patarroyo');
  assert.deepEqual(capturado, ['https://api.hubapi.com/crm/v3/objects/contacts/search']);
});
