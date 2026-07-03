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

// §18 1B — aislamiento de memoria personal por LID (el bug "me llamo Alejandro" se filtraba).
test('memoria por LID: la personal de un dueño no aparece para otro ni en el contexto global', () => {
  const JEFE = '111@lid';
  const ADMIN = '222@lid';
  db.setMemory('sistema:banco', 'Bancolombia', null);        // sistema (la ven todos)
  db.setMemory(`boss_note:${JEFE}:gusto`, 'café sin azúcar', JEFE);
  db.setMemory(`boss_note:${ADMIN}:nombre`, 'me llamo Alejandro', ADMIN);

  // El jefe ve: sistema + SU nota, nunca la del admin.
  const delJefe = db.getAllMemory(JEFE);
  assert.ok(delJefe.some((m) => m.key === 'sistema:banco'));
  assert.ok(delJefe.some((m) => m.value === 'café sin azúcar'));
  assert.ok(!delJefe.some((m) => m.value === 'me llamo Alejandro'), 'no debe ver la del admin');

  // El admin ve: sistema + SU nota, nunca la del jefe.
  const delAdmin = db.getAllMemory(ADMIN);
  assert.ok(delAdmin.some((m) => m.value === 'me llamo Alejandro'));
  assert.ok(!delAdmin.some((m) => m.value === 'café sin azúcar'), 'no debe ver la del jefe');

  // Sin dueño (grupos/desconocidos): SOLO sistema, ninguna nota personal.
  const sinDuenio = db.getAllMemory();
  assert.ok(sinDuenio.some((m) => m.key === 'sistema:banco'));
  assert.ok(!sinDuenio.some((m) => m.key.startsWith('boss_note:')), 'cero notas personales');

  // search también respeta el aislamiento.
  assert.ok(db.searchMemory('Alejandro', ADMIN).length >= 1);
  assert.equal(db.searchMemory('Alejandro', JEFE).length, 0);
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

test('scheduled_drafts: ciclo completo create→approve→publish + UNIQUE + feedback', () => {
  const sid = db.createScheduledMessage({
    groupId: 'patah@g.us',
    groupName: 'Patah',
    days: '1,2,3,4,5,6,0',
    timeHm: '09:00',
    text: '',
    createdBy: 'boss@lid',
    kind: 'generated',
    brief: 'San José',
  });
  assert.equal(db.listScheduledMessages().find((r) => r.id === Number(sid)).kind, 'generated');

  const did = db.createDraft({ scheduledId: sid, publishDate: '2026-06-12', draft: 'v1' });
  assert.ok(Number(did) > 0);
  assert.equal(db.createDraft({ scheduledId: sid, publishDate: '2026-06-12', draft: 'otro' }), null, 'UNIQUE por (sched, fecha)');
  assert.equal(db.getDraftFor(sid, '2026-06-12').draft, 'v1');

  // revise mantiene pending y guarda feedback
  assert.equal(db.reviseDraft(did, 'v2', 'más corto'), 1);
  const revised = db.getDraft(did);
  assert.equal(revised.draft, 'v2');
  assert.equal(revised.status, 'pending');

  // approve → published; publish sin approve no hace nada
  assert.equal(db.markDraftPublished(did), 0, 'publicar sin aprobar = 0 filas');
  assert.equal(db.approveDraft(did), 1);
  assert.equal(db.approveDraft(did), 0, 'doble aprobación = 0 filas');
  assert.equal(db.markDraftPublished(did), 1);
  assert.equal(db.getDraft(did).status, 'published');

  // listas
  assert.ok(db.listDraftsForDate('2026-06-12').some((d) => d.id === Number(did)));
  assert.equal(db.listPendingDrafts('2026-06-12').length, 0);
  assert.deepEqual(db.listRecentPublishedDrafts(sid, 3), ['v2']);

  // reminded
  db.markDraftReminded(did);
  assert.equal(db.getDraft(did).reminded, 1);
});

test('scheduled_drafts: discardDraft descarta pending/approved y no toca published', () => {
  const sid = db.createScheduledMessage({
    groupId: 'patah2@g.us',
    groupName: 'Patah2',
    days: '5',
    timeHm: '09:00',
    text: '',
    createdBy: 'boss@lid',
    kind: 'generated',
    brief: 'San José',
  });

  // pending → discarded
  const d1 = db.createDraft({ scheduledId: sid, publishDate: '2026-06-19', draft: 'p1' });
  assert.equal(db.discardDraft(d1), 1);
  assert.equal(db.getDraft(d1).status, 'discarded');
  assert.equal(db.discardDraft(d1), 0, 'ya descartado = 0 filas');
  assert.equal(db.listPendingDrafts('2026-06-19').length, 0, 'descartado no aparece como pendiente');

  // approved → discarded (rescate antes de publicar)
  const d2 = db.createDraft({ scheduledId: sid, publishDate: '2026-06-26', draft: 'p2' });
  assert.equal(db.approveDraft(d2), 1);
  assert.equal(db.discardDraft(d2), 1);
  assert.equal(db.getDraft(d2).status, 'discarded');

  // published NO se descarta
  const d3 = db.createDraft({ scheduledId: sid, publishDate: '2026-07-03', draft: 'p3' });
  db.approveDraft(d3);
  db.markDraftPublished(d3);
  assert.equal(db.discardDraft(d3), 0, 'publicado no se descarta');
  assert.equal(db.getDraft(d3).status, 'published');
});

test('aprobación por grupo: flag require_approval (solo grupos autorizados)', () => {
  db.authorizeGroup({ groupId: 'appr@g.us', groupName: 'Grupo Aprobación', authorizedBy: 'test' });
  assert.equal(db.getGroupApproval('appr@g.us'), false, 'arranca en OFF');
  assert.equal(db.setGroupApproval('appr@g.us', true), 1);
  assert.equal(db.getGroupApproval('appr@g.us'), true);
  assert.ok(db.listApprovalGroups().some((g) => g.group_id === 'appr@g.us'));
  assert.equal(db.setGroupApproval('appr@g.us', false), 1);
  assert.equal(db.getGroupApproval('appr@g.us'), false);
  // grupo inexistente → 0 filas (no se puede activar sin autorizar)
  assert.equal(db.setGroupApproval('nope@g.us', true), 0);
});

test('pending_replies: ciclo aprobar/enviar, revise, discard y caducidad', () => {
  const id = db.createPendingReply({
    groupId: 'g@g.us',
    groupName: 'Patah',
    triggerSender: 'Pedro',
    triggerText: '¿a qué hora?',
    draft: 'A las 6:30pm',
  });
  assert.ok(Number(id) > 0);
  assert.equal(db.listPendingReplies().length, 1);

  // revise mantiene pending y guarda feedback
  assert.equal(db.revisePendingReply(id, 'A las 6:30 p.m. 🙏', '- más cálido'), 1);
  assert.equal(db.getPendingReply(id).draft, 'A las 6:30 p.m. 🙏');
  assert.equal(db.getPendingReply(id).status, 'pending');

  // approve → aparece en la cola de envío; markSent lo saca
  assert.equal(db.approvePendingReply(id), 1);
  assert.equal(db.approvePendingReply(id), 0, 'doble aprobación = 0');
  assert.ok(db.listApprovedPendingReplies().some((r) => r.id === Number(id)));
  assert.equal(db.markPendingReplySent(id), 1);
  assert.equal(db.getPendingReply(id).status, 'sent');
  assert.equal(db.listPendingReplies().length, 0);

  // discard sobre pending/approved; no sobre sent
  const id2 = db.createPendingReply({ groupId: 'g@g.us', groupName: 'Patah', triggerSender: 'Ana', triggerText: 'hola', draft: 'hola Ana' });
  assert.equal(db.discardPendingReply(id2), 1);
  assert.equal(db.getPendingReply(id2).status, 'discarded');
  assert.equal(db.discardPendingReply(id), 0, 'sent no se descarta');

  // caducidad: una pendiente con created_at de hace 60 min cae con ttl 30, no con ttl 120
  const id3 = db.createPendingReply({ groupId: 'g@g.us', groupName: 'Patah', triggerSender: 'Leo', triggerText: 'eco', draft: 'eco' });
  db.default.prepare(`UPDATE pending_replies SET created_at = datetime('now','-60 minutes') WHERE id = ?`).run(id3);
  assert.ok(db.listExpiredPendingReplies(30).some((r) => r.id === Number(id3)), 'caduca con ttl 30');
  assert.ok(!db.listExpiredPendingReplies(120).some((r) => r.id === Number(id3)), 'no caduca con ttl 120');
  assert.equal(db.markPendingReplyExpired(id3), 1);
  assert.equal(db.getPendingReply(id3).status, 'expired');
});

test('pending_replies: persiste la identidad del mensaje gatillo (para citar)', () => {
  const id = db.createPendingReply({
    groupId: 'g2@g.us',
    groupName: 'Patah',
    triggerSender: 'Pedro',
    triggerText: '¿a qué hora?',
    triggerMsgId: 'MSGID-99',
    triggerParticipant: '57301@s.whatsapp.net',
    draft: 'A las 8',
  });
  const row = db.getPendingReply(id);
  assert.equal(row.trigger_msg_id, 'MSGID-99');
  assert.equal(row.trigger_participant, '57301@s.whatsapp.net');
  // y viaja en la cola de aprobadas (SELECT *)
  db.approvePendingReply(id);
  const approved = db.listApprovedPendingReplies().find((r) => r.id === Number(id));
  assert.equal(approved.trigger_msg_id, 'MSGID-99');
});

test('group_reply_usage: cuenta por grupo/hora y corta al tope', () => {
  const g = 'cap@g.us';
  const cap = 3;
  const counts = [];
  for (let i = 0; i < 4; i++) counts.push(db.checkAndIncrementGroupReplyQuota(g, cap));
  assert.deepEqual(counts.map((c) => c.count), [1, 2, 3, 4]);
  assert.deepEqual(counts.map((c) => c.allowed), [true, true, true, false]);
  // otro grupo lleva su propio contador
  assert.equal(db.checkAndIncrementGroupReplyQuota('otro@g.us', cap).count, 1);
});

test('migración crea group_reply_usage y columnas de cita en pending_replies', () => {
  const def = db.default;
  const tables = def.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name);
  assert.ok(tables.includes('group_reply_usage'), 'falta tabla group_reply_usage');
  const cols = def.prepare('PRAGMA table_info(pending_replies)').all().map((c) => c.name);
  for (const c of ['trigger_msg_id', 'trigger_participant', 'kind']) assert.ok(cols.includes(c), `falta ${c}`);
});

test('pending_replies: createPendingReply persiste kind (default group; dm explícito)', () => {
  const gid = db.createPendingReply({ groupId: 'g@g.us', groupName: 'Patah', draft: 'x' });
  assert.equal(db.getPendingReply(gid).kind, 'group', 'default debe ser group');
  const did = db.createPendingReply({ kind: 'dm', groupId: '57300@s.whatsapp.net', groupName: 'DM de Pedro', draft: 'hola' });
  assert.equal(db.getPendingReply(did).kind, 'dm');
});

// ─── Reprogramación de recurrentes + overrides de un solo día (§18.AC) ─────────

test('scheduled_messages: reschedule permanente y override de un día (que el cambio permanente limpia)', () => {
  const id = db.createScheduledMessage({
    groupId: 'g@g.us',
    groupName: 'G',
    days: '0,4',
    timeHm: '20:00',
    text: 'hola',
    createdBy: 'boss@lid',
  });

  // Override de un solo día: queda en la fila y sale por list.
  assert.equal(db.setScheduledMessageOverride(id, { date: '2026-07-09', timeHm: '18:00' }), 1);
  let row = db.listScheduledMessages().find((r) => r.id === Number(id));
  assert.equal(row.override_date, '2026-07-09');
  assert.equal(row.override_time, '18:00');

  // Cambio permanente: nueva hora (y días si vienen) + limpia el override.
  assert.equal(db.rescheduleScheduledMessage(id, { timeHm: '19:00', days: '1' }), 1);
  row = db.listScheduledMessages().find((r) => r.id === Number(id));
  assert.equal(row.time_hm, '19:00');
  assert.equal(row.days, '1');
  assert.equal(row.override_date, null, 'el horario nuevo es la verdad completa');

  // Solo hora (days=null no pisa los días).
  assert.equal(db.rescheduleScheduledMessage(id, { timeHm: '21:00' }), 1);
  row = db.listScheduledMessages().find((r) => r.id === Number(id));
  assert.equal(row.days, '1');
  assert.equal(row.time_hm, '21:00');

  // Cancelado → ni reschedule ni override lo tocan.
  db.cancelScheduledMessage(id);
  assert.equal(db.rescheduleScheduledMessage(id, { timeHm: '10:00' }), 0);
  assert.equal(db.setScheduledMessageOverride(id, { date: '2026-07-10', timeHm: '10:00' }), 0);
});

test('outreach_schedules: reschedule por recur_kind y override solo para daily', () => {
  const onceId = db.createOutreach({
    toPhone: '573000000009',
    toName: 'Ana',
    intent: 'saludo',
    recurKind: 'once',
    dueAt: '2026-07-05 10:00:00',
    createdBy: 'boss@lid',
  });
  assert.equal(db.rescheduleOutreach(onceId, { dueAt: '2026-07-06 15:00:00' }), 1);
  assert.equal(db.listActiveOutreach().find((r) => r.id === Number(onceId)).due_at, '2026-07-06 15:00:00');

  const dailyId = db.createOutreach({
    toPhone: '573000000009',
    toName: 'Ana',
    intent: 'buenos días',
    recurKind: 'daily',
    days: '1,3',
    timeHm: '09:00',
    createdBy: 'boss@lid',
  });
  // Override de un día (permitido: daily).
  assert.equal(db.setOutreachOverride(dailyId, { date: '2026-07-06', timeHm: '07:30' }), 1);
  let row = db.listActiveOutreach().find((r) => r.id === Number(dailyId));
  assert.equal(row.override_date, '2026-07-06');
  // Cambio permanente de hora limpia el override.
  assert.equal(db.rescheduleOutreach(dailyId, { timeHm: '08:00' }), 1);
  row = db.listActiveOutreach().find((r) => r.id === Number(dailyId));
  assert.equal(row.time_hm, '08:00');
  assert.equal(row.override_date, null);
  assert.equal(row.days, '1,3', 'los días no se tocan si no vienen');

  // Override sobre un once → 0 cambios (solo aplica a daily).
  assert.equal(db.setOutreachOverride(onceId, { date: '2026-07-06', timeHm: '07:30' }), 0);

  // Cerrado → reschedule no lo toca.
  db.finishOutreach(dailyId, 'cancelled');
  assert.equal(db.rescheduleOutreach(dailyId, { timeHm: '11:00' }), 0);
});

test('pending_tasks: kind se persiste (capability_gap) y default task (§18.AC)', () => {
  const t1 = db.createTask({ request: 'encargo normal', createdBy: 'boss@lid' });
  const t2 = db.createTask({ request: 'que mande audios', createdBy: 'boss@lid', kind: 'capability_gap' });
  assert.equal(db.getTask(t1).kind, 'task');
  assert.equal(db.getTask(t2).kind, 'capability_gap');
});
