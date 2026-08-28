// test/index.privilegios-grupo.test.js
// Fija QUÉ helper de privilegio usa cada punto de entrada DESDE UN GRUPO.
//
// El contexto (CLAUDE.md, "Sistema de roles"): `roleOf()` termina con un fallback retrocompat
// —"cualquier @lid es el jefe si BOSS_LID no está configurado"— que es deliberado y está
// testeado en roles.test.js. Pero en un GRUPO todos los participantes llegan como @lid, así que
// por esa vía el fallback convierte a cualquier miembro en jefe. Para eso existe
// `isStrictPrivileged()`, que exige identidad configurada explícitamente.
//
// La auditoría del 2026-08-26 encontró que `/grupo` y `/reportes` usaban
// `isPrivileged(roleOf(sender))` en vez del estricto — y al arreglarlo apareció un tercero,
// `onGroupJoin`, donde el costo era que un desconocido autorizara su propio grupo con solo
// agregar al bot.
//
// Por qué un test que lee el FUENTE y no uno de comportamiento: estos tres handlers no se
// exportan de src/index.js y arrastran media docena de imports con deps nativas. Lo que hay que
// impedir es una regresión de UNA palabra, y eso este test lo agarra. La semántica de
// `isStrictPrivileged` en sí ya está cubierta a fondo en roles.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const fuente = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');

// Devuelve el cuerpo de `async function <nombre>(...)` hasta la llave de cierre a nivel 0.
// Ojo: la lista de parámetros viene destructurada (`({ chatId, ... })`), así que hay que cerrar
// primero el paréntesis — el primer `{` del archivo tras el nombre es el del destructuring.
function cuerpoDe(nombre) {
  const inicio = fuente.indexOf(`async function ${nombre}(`);
  assert.notEqual(inicio, -1, `no encontré la función ${nombre} en src/index.js`);

  let paren = 0;
  let finParams = -1;
  for (let i = fuente.indexOf('(', inicio); i < fuente.length; i += 1) {
    if (fuente[i] === '(') paren += 1;
    else if (fuente[i] === ')') {
      paren -= 1;
      if (paren === 0) {
        finParams = i;
        break;
      }
    }
  }
  assert.notEqual(finParams, -1, `no pude cerrar los parámetros de ${nombre}`);

  const abre = fuente.indexOf('{', finParams);
  let nivel = 0;
  for (let i = abre; i < fuente.length; i += 1) {
    if (fuente[i] === '{') nivel += 1;
    else if (fuente[i] === '}') {
      nivel -= 1;
      if (nivel === 0) return fuente.slice(abre, i + 1);
    }
  }
  throw new Error(`no pude delimitar el cuerpo de ${nombre}`);
}

const PUNTOS_DE_GRUPO = [
  ['handleGroupCommand', '/grupo — autoriza o saca al bot del grupo'],
  ['handleGroupReportCommand', '/reportes — publica leads y métricas EN el grupo'],
  ['onGroupJoin', 'add al grupo — autoriza el grupo sin más trámite'],
];

for (const [nombre, queHace] of PUNTOS_DE_GRUPO) {
  test(`${nombre} usa isStrictPrivileged (${queHace})`, () => {
    const cuerpo = cuerpoDe(nombre);
    assert.match(
      cuerpo,
      /isStrictPrivileged\(/,
      `${nombre} tiene que gatear con isStrictPrivileged: le llegan @lid de un grupo`
    );
  });

  test(`${nombre} NO gatea con isPrivileged(roleOf(...))`, () => {
    const cuerpo = cuerpoDe(nombre).replace(/^\s*\/\/.*$/gm, ''); // los comentarios sí lo nombran
    assert.doesNotMatch(
      cuerpo,
      /isPrivileged\(\s*roleOf\(/,
      `${nombre} volvería a dar privilegio a cualquier participante en un despliegue sin BOSS_LID`
    );
  });
}

test('el helper estricto está importado en src/index.js', () => {
  assert.match(fuente, /import\s*\{[^}]*\bisStrictPrivileged\b[^}]*\}\s*from\s*'\.\/common\/roles\.js'/);
});
