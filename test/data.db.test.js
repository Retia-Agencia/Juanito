// test/data.db.test.js — migración idempotente + recordatorios + memoria + resúmenes
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'sba-db-'));
const DB_PATH = join(dir, 'test.sqlite');
process.env.DB_PATH = DB_PATH;

let db;

before(async () => {
  // Migrar dos veces para comprobar idempotencia
  const env = { ...process.env, DB_PATH };
  execFileSync('node', ['src/db/migrate.js'], { env, stdio: 'pipe' });
  execFileSync('node', ['src/db/migrate.js'], { env, stdio: 'pipe' });
  db = await import('../src/db/index.js');
});

after(() => rmSync(dir, { recursive: true, force: true }));

test('migración crea las tablas y columnas nuevas', () => {
  const def = db.default;
  const cols = def.prepare('PRAGMA table_info(reminders)').all().map((c) => c.name);
  for (const c of ['to_phone', 'created_by', 'status', 'sent_at']) assert.ok(cols.includes(c), `falta ${c}`);
  const tables = def
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((t) => t.name);
  for (const t of ['contacts', 'reminders', 'messages', 'memory', 'group_context']) {
    assert.ok(tables.includes(t), `falta tabla ${t}`);
  }
  const optinCols = def.prepare('PRAGMA table_info(calendly_optins)').all().map((c) => c.name);
  for (const c of ['source', 'contact_jid', 'paused']) {
    assert.ok(optinCols.includes(c), `falta columna ${c} en calendly_optins`);
  }
  assert.ok(tables.includes('settings'), 'falta tabla settings');
  assert.ok(tables.includes('authorized_groups'), 'falta tabla authorized_groups');
});

test('grupos autorizados: authorize/isAuthorized/deauthorize + upsert', () => {
  const gid = '123456@g.us';
  assert.equal(db.isGroupAuthorized(gid), false, 'arranca no autorizado');
  assert.equal(db.isGroupAuthorized(null), false, 'null nunca autorizado');
  db.authorizeGroup({ groupId: gid, groupName: 'Equipo', authorizedBy: 'boss@lid' });
  assert.equal(db.isGroupAuthorized(gid), true, 'queda autorizado');
  // upsert no duplica ni rompe
  db.authorizeGroup({ groupId: gid, groupName: 'Equipo (rename)', authorizedBy: 'participant' });
  assert.equal(db.listAuthorizedGroups().filter((g) => g.group_id === gid).length, 1, 'sigue siendo una fila');
  assert.equal(db.deauthorizeGroup(gid), 1, 'borra 1 fila');
  assert.equal(db.isGroupAuthorized(gid), false, 'tras deauth, no autorizado');
});

test('settings: getSetting/setSetting con default y upsert', () => {
  assert.equal(db.getSetting('no_existe', 'def'), 'def');
  db.setSetting('foo', 'bar');
  assert.equal(db.getSetting('foo'), 'bar');
  db.setSetting('foo', 'baz'); // upsert
  assert.equal(db.getSetting('foo'), 'baz');
});

test('botón de pánico global: isCalendlyPaused / setCalendlyPaused', () => {
  assert.equal(db.isCalendlyPaused(), false, 'por defecto NO pausado');
  db.setCalendlyPaused(true);
  assert.equal(db.isCalendlyPaused(), true);
  db.setCalendlyPaused(false);
  assert.equal(db.isCalendlyPaused(), false);
});

test('pausa por-closer: setCloserPaused marca la fila y getOptin lo expone', () => {
  db.registerOptin({ phone: '+57 300 222 0001', name: 'C', source: 'self', contactJid: 'c@lid' });
  assert.equal(db.getOptin('573002220001').paused, 0, 'arranca activo');
  assert.equal(db.setCloserPaused('+57 300 222 0001', true), 1, 'afecta 1 fila');
  assert.equal(db.getOptin('573002220001').paused, 1, 'queda pausado');
  db.setCloserPaused('573002220001', false);
  assert.equal(db.getOptin('573002220001').paused, 0, 'se reactiva');
  // Closer sin opt-in → 0 filas afectadas
  assert.equal(db.setCloserPaused('+57 300 999 9999', true), 0, 'sin fila → no afecta nada');
});

test('opt-in anti-ban: source self vs seeded e isVerifiedOptedIn', () => {
  // Sembrado (default 'seeded'): existe pero NO verificado → no se envía en frío
  db.registerOptin({ phone: '+57 300 111 0001', closerEmail: 'a@x.com', name: 'A' });
  assert.equal(db.isOptedIn('573001110001'), true, 'la fila existe');
  assert.equal(db.isVerifiedOptedIn('573001110001'), false, 'seeded NO está verificado');

  // Ganado ('self'): el closer escribió → verificado → recibe
  db.registerOptin({
    phone: '+57 300 111 0002', closerEmail: 'b@x.com', name: 'B', source: 'self', contactJid: '12345@lid',
  });
  assert.equal(db.isVerifiedOptedIn('573001110002'), true, 'self queda verificado');

  // Upgrade: una fila seeded que luego escribe → pasa a verificado
  db.registerOptin({ phone: '+57 300 111 0001', source: 'self', contactJid: '999@lid' });
  assert.equal(db.isVerifiedOptedIn('573001110001'), true, 'seeded → self (upgrade)');

  // No-degradación: un self que recibe otra escritura seeded → sigue verificado
  db.registerOptin({ phone: '+57 300 111 0002' });
  assert.equal(db.isVerifiedOptedIn('573001110002'), true, 'self no se degrada a seeded');

  // getOptin: expone contact_jid para enrutar la entrega al hilo real (anti-ban)
  const row = db.getOptin('573001110002');
  assert.equal(row.source, 'self');
  assert.equal(row.contact_jid, '12345@lid', 'contact_jid del primer self se preserva');
  assert.equal(db.getOptin('573009990000'), null, 'sin fila → null');
});

test('recordatorio con destinatario: save -> pending -> sent', () => {
  const past = '2000-01-01 09:00:00';
  db.saveReminder({ text: 'call con Juan', dueAt: past, toPhone: '573001112222', createdBy: 'jefe' });
  const pending = db.getPendingReminders();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].to_phone, '573001112222');
  assert.equal(pending[0].status, 'pending');

  db.markReminderSent(pending[0].id);
  assert.equal(db.getPendingReminders().length, 0);
});

test('getUpcomingReminders solo trae pendientes futuros en ventana', () => {
  const def = db.default;
  def.prepare(
    `INSERT INTO reminders (text, due_at, status) VALUES ('en 2h', datetime('now','+2 hours'), 'pending')`
  ).run();
  def.prepare(
    `INSERT INTO reminders (text, due_at, status) VALUES ('en 5 dias', datetime('now','+5 days'), 'pending')`
  ).run();
  const up = db.getUpcomingReminders(24);
  assert.ok(up.some((r) => r.text === 'en 2h'));
  assert.ok(!up.some((r) => r.text === 'en 5 dias'), 'no debe traer fuera de ventana');
});

test('memoria: set/get/getAll/search', () => {
  db.setMemory('numero_cuenta', '1234567');
  assert.equal(db.getMemory('numero_cuenta'), '1234567');
  db.setMemory('numero_cuenta', '7654321'); // upsert
  assert.equal(db.getMemory('numero_cuenta'), '7654321');
  assert.ok(db.getAllMemory().some((m) => m.key === 'numero_cuenta'));
  assert.ok(db.searchMemory('cuenta').length >= 1);
});

test('resúmenes: save y recuperación', () => {
  db.saveSummary({
    chatId: '123@g.us',
    chatName: 'Closers',
    summary: 'cerraron 3 deals esta semana',
    periodStart: '2026-06-01',
    periodEnd: '2026-06-03',
  });
  const recent = db.getRecentSummaries(5);
  assert.equal(recent[0].chat_name, 'Closers');
  assert.equal(recent[0].chat_id, '123@g.us');
  assert.ok(db.searchSummaries('deals').length >= 1);
});

test('dedup de webhooks: markIfNew', () => {
  assert.equal(db.markIfNew('msg-1'), true);
  assert.equal(db.markIfNew('msg-1'), false);
  assert.equal(db.markIfNew(null), true);
});

// ─── §18.D Hardening grupos grandes ────────────────────────────────────────────

test('rate limit: {allowed,count}, 1ª denegación detectable, sigue contando intentos', () => {
  const sender = '999888777@lid';
  const limit = 3;

  for (let i = 1; i <= limit; i++) {
    const r = db.checkAndIncrementGroupUsage(sender, limit);
    assert.equal(r.allowed, true, `intento ${i} permitido`);
    assert.equal(r.count, i);
  }

  // Primera denegación: count === limit + 1 (gatilla el aviso único).
  const first = db.checkAndIncrementGroupUsage(sender, limit);
  assert.equal(first.allowed, false);
  assert.equal(first.count, limit + 1);

  // Denegaciones siguientes: siguen contando (silencio, sin aviso).
  const second = db.checkAndIncrementGroupUsage(sender, limit);
  assert.equal(second.allowed, false);
  assert.equal(second.count, limit + 2);
});

test('migración crea el índice idx_messages_chat_source_created', () => {
  const idx = db.default
    .prepare("SELECT name FROM sqlite_master WHERE type='index'")
    .all()
    .map((i) => i.name);
  assert.ok(idx.includes('idx_messages_chat_source_created'), 'falta el índice de chat');
});

test('getRecentMessages: sinceHours filtra por ventana y limit es tope duro', async () => {
  const wa = await import('../src/whatsapp/index.js');
  const def = db.default;
  const gid = 'window-test@g.us';
  const ins = def.prepare(
    `INSERT INTO messages (role, content, source, chat_id, created_at)
     VALUES ('user', ?, 'group', ?, datetime('now', ?))`
  );
  ins.run('[A]: viejo (10h)', gid, '-10 hours');
  ins.run('[B]: dentro (2h)', gid, '-2 hours');
  ins.run('[C]: dentro (1h)', gid, '-1 hours');
  ins.run('[D]: ahora', gid, '-0 hours');

  // Ventana de 4h → excluye el de 10h.
  const inWindow = await wa.getRecentMessages(gid, 50, 4);
  assert.deepEqual(
    inWindow.map((m) => m.body),
    ['dentro (2h)', 'dentro (1h)', 'ahora']
  );

  // El tope corta a los MÁS RECIENTES dentro de la ventana.
  const capped = await wa.getRecentMessages(gid, 2, 4);
  assert.deepEqual(
    capped.map((m) => m.body),
    ['dentro (1h)', 'ahora']
  );

  // Sin sinceHours → comportamiento histórico (últimos N sin ventana).
  const legacy = await wa.getRecentMessages(gid, 50);
  assert.equal(legacy.length, 4);
});

// ─── Personalidad por grupo + mensajes recurrentes ─────────────────────────────

test('group_personality: set (upsert) / get / delete / list', () => {
  const gid = 'patah@g.us';
  assert.equal(db.getGroupPersona(gid), null, 'sin configurar → null');
  db.setGroupPersona({ groupId: gid, groupName: 'Patah ✝️', persona: 'Tono religioso, di "muchachos"', updatedBy: 'a@lid' });
  assert.equal(db.getGroupPersona(gid), 'Tono religioso, di "muchachos"');
  db.setGroupPersona({ groupId: gid, groupName: 'Patah ✝️', persona: 'Versión 2', updatedBy: 'a@lid' });
  assert.equal(db.getGroupPersona(gid), 'Versión 2', 'upsert actualiza');
  assert.equal(db.listGroupPersonas().filter((p) => p.group_id === gid).length, 1, 'una sola fila');
  assert.equal(db.deleteGroupPersona(gid), 1);
  assert.equal(db.getGroupPersona(gid), null);
  assert.equal(db.deleteGroupPersona(gid), 0, 'borrar de nuevo no afecta filas');
  assert.equal(db.getGroupPersona(null), null, 'null tolerado');
});

test('scheduled_messages: create / list / markSent / cancel', () => {
  const id = db.createScheduledMessage({
    groupId: 'patah@g.us',
    groupName: 'Patah ✝️',
    days: '0,4',
    timeHm: '20:00',
    text: 'Muchachos, ¡reunión hoy!',
    createdBy: 'boss@lid',
  });
  assert.ok(Number(id) > 0);

  const rows = db.listScheduledMessages();
  const row = rows.find((r) => r.id === Number(id));
  assert.ok(row, 'aparece en la lista de activos');
  assert.equal(row.days, '0,4');
  assert.equal(row.time_hm, '20:00');
  assert.equal(row.last_sent_date, null);

  db.markScheduledMessageSent(id, '2026-06-11');
  assert.equal(db.listScheduledMessages().find((r) => r.id === Number(id)).last_sent_date, '2026-06-11');

  assert.equal(db.cancelScheduledMessage(id), 1);
  assert.ok(!db.listScheduledMessages().some((r) => r.id === Number(id)), 'cancelado sale de los activos');
  assert.ok(db.listScheduledMessages({ activeOnly: false }).some((r) => r.id === Number(id)), 'pero la fila queda (auditoría)');
  assert.equal(db.cancelScheduledMessage(id), 0, 'cancelar dos veces no afecta');
});
