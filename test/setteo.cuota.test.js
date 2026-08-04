// test/setteo.cuota.test.js
// Cuota de setteo (§18.AZ): 15 leads por HORA LIBRE. PURO → corre en Windows.
// Lo que estos tests protegen: que las dobles reservas no le inventen horas ocupadas al
// closer, y que una call fuera de jornada no le baje la cuota.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { calcularCuota, horasCubiertas, horaLocalDe } = await import('../src/setteo/cuota.js');

const TZ = 'America/Bogota';
const FECHA = '2026-08-03';
const base = { fecha: FECHA, tz: TZ, inicio: 8, fin: 17, minutosPorCall: 60, porHora: 15 };
// Bogotá es UTC-5 → 14:00 UTC = 09:00 local. Admite horas fraccionarias (16.5 = 16:30).
const call = (hhLocal) => {
  const utc = hhLocal + 5;
  const hh = Math.floor(utc);
  const mm = Math.round((utc - hh) * 60);
  return { call_start: `2026-08-03 ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00` };
};

test('horaLocalDe convierte UTC a hora local del negocio', () => {
  assert.equal(horaLocalDe('2026-08-03 14:00:00', FECHA, TZ), 9);
  assert.equal(horaLocalDe('2026-08-03 14:30:00', FECHA, TZ), 9.5);
});

test('horaLocalDe descarta una call de OTRO día local', () => {
  // 2026-08-03 02:00 UTC = 2026-08-02 21:00 en Bogotá → no es del día 3.
  assert.equal(horaLocalDe('2026-08-03 02:00:00', FECHA, TZ), null);
  assert.equal(horaLocalDe('basura', FECHA, TZ), null);
  assert.equal(horaLocalDe(null, FECHA, TZ), null);
});

test('sin calls, toda la jornada es libre', () => {
  const r = calcularCuota({ ...base, calls: [] });
  assert.equal(r.horasJornada, 9);
  assert.equal(r.horasOcupadas, 0);
  assert.equal(r.horasLibres, 9);
  assert.equal(r.cuota, 135); // 9 × 15
});

test('cada call ocupa una hora y baja la cuota', () => {
  const r = calcularCuota({ ...base, calls: [call(9), call(11), call(14)] });
  assert.equal(r.horasOcupadas, 3);
  assert.equal(r.horasLibres, 6);
  assert.equal(r.cuota, 90);
  assert.equal(r.callsEnJornada, 3);
});

// §18.AU: las dobles reservas son reales (8 de 14 colisiones medidas en 2 meses).
test('DOBLE RESERVA: dos calls en el mismo slot ocupan UNA hora, no dos', () => {
  const r = calcularCuota({ ...base, calls: [call(9), call(9)] });
  assert.equal(r.horasOcupadas, 1, 'sumar duraciones a secas le inventaría una hora ocupada');
  assert.equal(r.horasLibres, 8);
  assert.equal(r.cuota, 120);
});

test('solape PARCIAL: 9:00-10:00 y 9:30-10:30 ocupan 1.5h', () => {
  const calls = [{ call_start: '2026-08-03 14:00:00' }, { call_start: '2026-08-03 14:30:00' }];
  const r = calcularCuota({ ...base, calls });
  assert.equal(r.horasOcupadas, 1.5);
});

test('una call FUERA de la jornada no consume hora libre, pero se cuenta aparte', () => {
  const r = calcularCuota({ ...base, calls: [call(7), call(19)] }); // 7am y 7pm
  assert.equal(r.horasOcupadas, 0);
  assert.equal(r.horasLibres, 9);
  assert.equal(r.callsFuera, 2);
  assert.equal(r.callsEnJornada, 0);
});

test('una call a caballo del cierre se RECORTA, no se descarta', () => {
  const r = calcularCuota({ ...base, calls: [call(16.5)] }); // 16:30–17:30, jornada cierra 17:00
  assert.equal(r.horasOcupadas, 0.5);
  assert.equal(r.horasLibres, 8.5);
});

test('agenda llena: cuota 0, nunca negativa', () => {
  const calls = [8, 9, 10, 11, 12, 13, 14, 15, 16].map(call);
  const r = calcularCuota({ ...base, calls });
  assert.equal(r.horasOcupadas, 9);
  assert.equal(r.horasLibres, 0);
  assert.equal(r.cuota, 0);
});

test('la duración de la call es configurable (30 min)', () => {
  const r = calcularCuota({ ...base, minutosPorCall: 30, calls: [call(9), call(11)] });
  assert.equal(r.horasOcupadas, 1);
  assert.equal(r.horasLibres, 8);
  assert.equal(r.cuota, 120);
});

test('horasCubiertas: intervalos disjuntos, contenidos y contiguos', () => {
  assert.equal(horasCubiertas([{ desde: 9, hasta: 10 }, { desde: 11, hasta: 12 }], 8, 17), 2);
  assert.equal(horasCubiertas([{ desde: 9, hasta: 12 }, { desde: 10, hasta: 11 }], 8, 17), 3);
  assert.equal(horasCubiertas([{ desde: 9, hasta: 10 }, { desde: 10, hasta: 11 }], 8, 17), 2);
  assert.equal(horasCubiertas([], 8, 17), 0);
});
