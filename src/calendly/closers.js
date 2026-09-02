// src/calendly/closers.js
// Roster de closers keyeado por PERSONA. Cada persona tiene una o más IDENTIDADES, una por
// Conexión de Calendly (ver ADR 0001): su email de host (event_memberships[0].user_email de
// sus citas ES el closer), su teléfono canónico y, si aplica, su LID de trabajo. De este
// roster se DERIVAN, con estructura idéntica a la de antes:
//   · CLOSERS          — mapa email → { name, phone, account? }  (una entrada por IDENTIDAD)
//   · CLOSER_LIDS      — mapa lid → email                        (de workLid + extraJids)
//   · CLOSER_EXTRA_JIDS— mapa email → [jid, …]                   (aparatos secundarios)
// El resto del código consume esos dos mapas; la persona es solo la unidad de autoría, para que
// sumar/mover un closer sea editar UNA entrada aunque cierre para dos empresas.
//
// EQUIPO — lista dictada por el jefe el 2026-07-14 y validada contra la cuenta real de Calendly.
// Estos son TODO el equipo: quien no esté acá, no se gestiona. (Los pools a los que pertenece
// hoy cada uno son informativos; el PROGRAMA de cada cita se deriva de su event_type, no se
// configura acá, así que un closer queda cubierto en TODOS sus programas sin tocar nada más.)
//   Pablo Lozano        AI Second Brain · AI For Developers
//   Sebastian Rodriguez AI Second Brain (30X) · De Cero a Tactical Investor (Retia)
//   Sebastian Marin     LinkedIn Sales  · Instagram & TikTok
//   Lucas Mendoza       LinkedIn Sales  · Operaciones Escalables
//   Pablo Suarez        AI For Developers
//   Daniela Camacho     Instagram & TikTok · Operaciones Escalables
//   Sebastian Salazar   EstadoX (IA para Abogados)   ← salió de Tactical Investor 2026-09-02
//   Esteban Aguilar     EstadoX (IA para Abogados)
//   Andrea Machado      Retia (De Cero a Tactical Investor) · ComunicArte (Método Comunicarte)
//   Maru Marquez        ComunicArte (Método Comunicarte) · De Cero a Tactical Investor (Retia)
//   Dana Rodriguez      Retia — De Cero a Tactical Investor (alta 2026-08-25)
//
// ⚠️ 2026-08-25: al mudarse IA para Abogados al Calendly propio de EstadoX, los hosts de ese
// programa pasaron a ser los TRES miembros de esa org (comunidad@ es la cuenta de sistema;
// Aguilar y Salazar son los closers). Daniela Camacho NO es miembro de esa org, así que dejó de
// tomar citas de abogados — conserva sus otros dos programas en la conexión 30x y no hay nada que
// cambiar en su entrada. Si alguna vez vuelve a abogados, hay que sumarla ANTES a la org en
// Calendly: sin membresía no hostea, y sin identidad 'estadox' acá su cita caería como host
// desconocido.
//
// La CONEXIÓN de Calendly se configura en cada identidad con `connection` (ver accounts.js).
// La identidad cuya connection es la default ('30x') NO emite el campo `account` en el CLOSERS
// derivado (idéntico al roster histórico); las demás sí.
//
// ⚠️ INVARIANTE (revisada 2026-07-22): un teléfono = una PERSONA, nunca dos personas distintas.
// Una misma persona SÍ puede tener dos identidades con el MISMO teléfono en Conexiones distintas
// (Maru Marquez: comunicarte + retia desde una sola línea de WhatsApp; lo era Sebastian Salazar
// hasta que se le reasignó el buzón el 2026-09-02). NO necesita la migración a
// clave compuesta que antes se temía, porque:
//   · La CUENTA/dry-run/HubSpot se resuelven por EMAIL (accountOfCloser), distinto por identidad
//     → cada programa cae a lo suyo sin ambigüedad.
//   · El OPT-IN es lo único keyed por teléfono (`calendly_optins.phone` PK, contact_jid). UNA
//     sola fila sirve a las dos identidades y es CORRECTO: es el mismo WhatsApp. `registerOptin`
//     hace upsert por teléfono → una fila, nunca choca la PK.
//   · `pickSupersededPushes` matchea por (teléfono, MISMO lead): un lead postula a un solo
//     programa, así que no se pisan pushes entre programas.
//   · El PAUSE por-closer es por IDENTIDAD (email, en la tabla `settings`), no por teléfono → se
//     apaga un programa sin el otro. Ver setCloserPaused/isCloserPaused y `/calendly off <closer>
//     <cuenta>`.
// Lo que SÍ rompería la DB es dos PERSONAS distintas con el mismo teléfono (se pisarían el
// opt-in). El test "un teléfono = una persona" en calendly.closers.test.js lo bloquea.

import { phonesMatch } from '../common/utils.js';
import { DEFAULT_ACCOUNT, accountOf } from './accounts.js';

// ⚠️ Sobre `workLid` (backfill 2026-07-30). Declararlo hace DOS cosas: PINNEA la entrega a ese
// LID (`handleCloserOptin` hace `contactJid = workJid || from`, ver optin.js) y vuelve el destino
// VERIFICABLE — sin él, el `contact_jid` es un `@lid` opaco que no se puede contrastar contra
// nada, que es justo el hueco por el que el bug de Pablo Suarez (§18.AJ) vivió una semana.
//
// Por eso solo se declara sobre identidades con ENTREGA PROBADA: se tomó el `contact_jid` vigente
// de quienes venían respondiendo los Push 4 (una respuesta demuestra que el hilo está vivo).
// Declarar un LID equivocado CEMENTA el error, porque a partir de ahí el opt-in ignora desde
// dónde escriba el closer. Las identidades sin prueba de vida (las 3 de Retia, que no reciben
// Push 4) quedan SIN declarar a propósito, hasta capturar su LID de un mensaje nuevo. El test de
// invariante en calendly.closers.test.js vigila que lo declarado coincida con el opt-in real.
//
// ⚠️ Sobre `extraJids` (2026-08-04): lista de aparatos SECUNDARIOS que reciben COPIA de todo lo
// que se le entrega a esa identidad. Es lo contrario de `workLid`, que ELIGE un destino: acá se
// AGREGA uno. Misma exigencia de prueba de vida, y una más: el gate anti-ban de deliver() no lo
// cubre. Ver CLOSER_EXTRA_JIDS abajo.
//
// Exportado (F3a) para que el seed de registries pueda guardar la PERSONA. Los mapas derivados
// de abajo son por IDENTIDAD y ya no saben quién es quién: dos identidades de Sebastian
// Rodriguez no se distinguen de dos personas homónimas (que existen — ver Andrea Machado).
// Nadie más debería consumir esto: el resto del código habla de CLOSERS/CLOSER_LIDS.
export const PEOPLE = {
  daniela_camacho: {
    name: 'Daniela Camacho',
    // Teléfono actualizado 2026-07-28 (jefe): +573103062287 → +573018094666.
    // ⚠️ Rotar un número tiene DOS pasos: este roster es solo la LLAVE del opt-in; el destino
    // real de los pushes es `calendly_optins.contact_jid`. Ver el patrón de Pablo Suarez (§18.AJ)
    // y el runbook de rotación en docs/JUANITO-HANDOFF.md.
    identities: [{ connection: '30x', email: 'daniela.camacho@30x.com', phone: '+573018094666', workLid: '68604267614366' }],
  },
  // Sebastian Rodriguez: UNA persona, DOS identidades. Cierra AI Second Brain en 30X y "De Cero a
  // Tactical Investor" en Retia, con host/teléfono distinto en cada Calendly. Antes eran dos
  // entradas con nombre repetido; ahora es una sola (ADR 0001). resolveCloserByPushName ve el
  // nombre repetido en el CLOSERS derivado (dos teléfonos) → null (ambiguo = SEGURO); NO lo
  // bloquea: el opt-in resuelve por TELÉFONO/LID antes que por pushName, así que cada identidad
  // entra por lo suyo (30x por su LID de trabajo; retia por su celular +57 300 8037326).
  sebastian_rodriguez: {
    name: 'Sebastian Rodriguez',
    identities: [
      // workLid: su pushName de trabajo NO trae "Rodriguez"; el LID PINNEA la entrega al hilo
      // de trabajo aunque escriba desde otro dispositivo. NUNCA un LID personal (recrearía el
      // bug de pushes al número equivocado).
      { connection: '30x', email: 'sebastian@30x.com', phone: '+573102212005', workLid: '158025419608301' },
      // Gmail = su host en el Calendly de retia (9 citas verificadas). Entró 2026-07-21
      // (reemplazó a Alejo Carvajal → IGNORED_CLOSERS).
      // workLid capturado 2026-07-21: escribió "Hola bro" a Juanito desde su WhatsApp de retia y
      // WhatsApp lo presentó como 20671711162446@lid (contacts lo liga a +573008037326). Sin este
      // mapeo su opt-in caía a null: el pushName "Sebastian Rodriguez" es ambiguo (2 identidades),
      // así que resolveCloserByLid es la única vía. PINNEA la entrega a su device de retia.
      { connection: 'retia', email: 'sebasrr321@gmail.com', phone: '+573008037326', workLid: '20671711162446' },
    ],
  },
  // Cierra IA para Abogados en la conexión estadox. UNA sola identidad desde el 2026-09-02.
  // El nombre queda corto ("Sebastian Salazar", no "Juan Sebastian Salazar") para no romper el
  // match por pushName de su hilo.
  //
  // ⚠️ DESVINCULADO de "De Cero a Tactical Investor" el 2026-09-02 (decisión de Retia, confirmada
  // por el jefe). Tenía una segunda identidad en la conexión retia con el BUZÓN-ROL
  // `equipo@ttrading.co` y la MISMA línea de WhatsApp; Retia le reasignó ese buzón a Maru Marquez,
  // así que la identidad se MOVIÓ a PEOPLE.maru_marquez (ver allá). Él era, hasta hoy, el único
  // ejemplo vivo de "una persona, dos identidades, un solo teléfono" — ese lugar lo ocupa Maru.
  //
  // Lo que NO se tocó, a propósito: su fila de `calendly_optins` (+573054312905 →
  // 39415653117990@lid). El opt-in está keyeado por TELÉFONO y él sigue activo en abogados, así
  // que borrarlo lo dejaría sin pushes de su propio programa. Sus 48 pushes históricos bajo
  // equipo@ tampoco se tocan: son historia, y no había ninguno pendiente al rotar (verificado
  // contra la DB de producción — por eso el cambio no desvía nada en vuelo).
  //
  // ⚠️ LA CICATRIZ QUE HAY QUE NO REPETIR (2026-07-29): cuando ÉL heredó este mismo buzón el
  // 22-jul, se asumió que tendría cuenta personal propia (sebastiansalazar1410@gmail.com) y en el
  // mismo movimiento se retiró `equipo@` a IGNORED_CLOSERS. Esa cuenta nunca se creó: 10 citas
  // reales hosteadas por el buzón cayeron en el `continue` SILENCIOSO de isIgnoredCloser, una
  // semana sin pushes y sin una sola alerta. Por eso esta rotación NO manda el buzón a
  // IGNORED_CLOSERS: el buzón sigue vivo y recibiendo citas, lo único que cambió es QUIÉN está
  // detrás. En Retia los cupos se atienden por BUZÓN-ROL (igual que registro@ → Andrea Machado),
  // y rotar la persona es cambiar el TELÉFONO, nunca retirar el correo.
  //
  // ⚠️ MUDANZA 2026-08-25 — su identidad de abogados pasó de connection:'30x' a 'estadox'. El
  // email NO cambia (sigue hosteando como sebastian.salazar@30x.com, ahora dentro de la org de
  // EstadoX), así que su opt-in se reusa tal cual: `calendly_optins` está keyeada por TELÉFONO y
  // el closer se resuelve por EMAIL — ninguno de los dos se movió.
  sebastian_salazar: {
    name: 'Sebastian Salazar',
    identities: [
      { connection: 'estadox', email: 'sebastian.salazar@30x.com', phone: '+573054312905' },
    ],
  },
  // Alta 2026-08-25 junto con la conexión de EstadoX. Hostea 14 de las 17 citas de abogados de la
  // ventana en que se detectó la mudanza — es el closer principal del programa, no un refuerzo.
  // Sin `workLid`: no hay entrega probada todavía (ver la nota de arriba sobre workLid). Se
  // declara recién cuando haya un mensaje suyo del que sacar el LID.
  // ⚠️ Le falta el OPT-IN: con CALENDLY_REQUIRE_OPTIN=true no recibe nada hasta que le escriba a
  // Juanito y quede su fila en `calendly_optins` (source 'self').
  esteban_aguilar: {
    name: 'Esteban Aguilar',
    identities: [
      { connection: 'estadox', email: 'aguilare@estadox.com', phone: '+573186922796' },
    ],
  },
  pablo_lozano: {
    name: 'Pablo Lozano',
    identities: [{ connection: '30x', email: 'pablo.lozano@30x.com', phone: '+573046131437', workLid: '254051828641894' }],
  },
  // Teléfono rotado 2026-07-30 (jefe): +573212100048 → +573170623894. Es un WhatsApp NUEVO,
  // no el mismo número portado, así que su `contact_jid` viejo (248489795702847@lid) era el
  // aparato ANTERIOR y se puso en NULL a propósito: conservarlo habría repetido el bug de
  // Pablo Suarez (§18.AJ), con los pushes yéndose al teléfono viejo y el log en verde.
  //
  // La rotación SE COMPLETÓ: escribió desde la línea nueva y su opt-in quedó en
  // 47657695375437@lid (verificado en la DB de producción el 2026-08-04, sesión de Baileys viva).
  // Por eso ahora SÍ lleva `workLid`: sin él, `contactJid = workJid || from` (optin.js) haría
  // driftear la entrega al aparato desde el que escriba, y con dos líneas activas (ver abajo)
  // eso es cuestión de horas.
  //
  // ⚠️ DOS APARATOS por pedido suyo (2026-08-04, vía el jefe): quiere los pushes en la línea
  // nueva Y en la vieja (+573212100048 = 248489795702847@lid, la misma que se había desconectado
  // en la rotación). `extraJids` NO mueve el destino primario: es una COPIA. El primario sigue
  // siendo el `contact_jid` del opt-in, con todos sus gates; el secundario es una entrega extra
  // declarada a mano. Solo se declara sobre aparatos con TRÁFICO ENTRANTE PROBADO — este lo
  // tiene de sobra (fue su opt-in hasta el 30-jul y su sesión sigue activa).
  sebastian_marin: {
    name: 'Sebastian Marin',
    identities: [
      {
        connection: '30x',
        email: 'sebastian.marin@30x.com',
        phone: '+573170623894',
        workLid: '47657695375437',
        extraJids: ['248489795702847@lid'], // línea vieja +573212100048, a pedido suyo
      },
    ],
  },
  lucas_mendoza: {
    name: 'Lucas Mendoza',
    identities: [{ connection: '30x', email: 'lucas.mendoza@30x.com', phone: '+573014477044', workLid: '145540016799830' }],
  },
  // OJO: su email NO lleva punto (pablosuarez@), a diferencia de pablo.lozano@ — personas
  // distintas, ambas activas. Entró 2026-07-14.
  pablo_suarez: {
    name: 'Pablo Suarez',
    // Teléfono actualizado 2026-07-21 (jefe): +573152573103 → +573189248507.
    // `hubspotEmail`: en HubSpot su owner NO es pablosuarez@ sino pablosuarez+hubspot@ (medido
    // 2026-07-27, owner 95239179). Sin este alias, `meetingsToCalls` descartaba sus 28 meetings
    // al mes — la agenda del día no veía UNA sola call de AI for Developers y el diagnóstico
    // parecía "developers no existe en HubSpot". Ver §18.AN.
    identities: [
      { connection: '30x', email: 'pablosuarez@30x.com', phone: '+573189248507', hubspotEmail: 'pablosuarez+hubspot@30x.com', workLid: '31001912856621' },
    ],
  },
  // ─── Retia (agencia #2) — programa "De Cero a Tactical Investor" ───────────
  // Vieira VENDE el programa (la CARA del pitch), NO es closer → está en IGNORED_CLOSERS.
  // registro@ es un correo DE LA EMPRESA (rol, no personal): si sacan a la closer, el correo pasa
  // al siguiente → al rotar, actualizar el teléfono acá (patrón "Equipo EstadoX").
  // "Andrea Machado" choca de nombre con andrea.machado@30x.com (DEPARTIDA, en IGNORED_CLOSERS):
  // persona DISTINTA, no está en el roster → no confunde a resolveCloserByPushName.
  // Dana salió (2026-07-22): la reemplazó Sebastian Salazar, que SÍ heredó el buzón-rol
  // equipo@ttrading.co (hoy de Maru Marquez; ver la corrección del 2026-07-29). Retia opera
  // con DOS buzones-rol —registro@ y equipo@—, ninguno con cuenta personal detrás.
  //
  // ⚠️ DOS identidades desde 2026-08-25: cierra "De Cero a Tactical Investor" en Retia y
  // "Método Comunicarte" en ComunicArte, con host y TELÉFONO distinto en cada Calendly — mismo
  // patrón que Sebastian Rodriguez (30x + retia), no el de Salazar (una línea para las dos).
  // Las dos son buzones-rol de su empresa: `registro@ttrading.co` e `info@eventoscomunicarte.com`.
  // En el Calendly de ComunicArte la cuenta figura a nombre de "Milena Morales" — ese NO es quien
  // contesta; el roster lleva el nombre de la persona real, igual que registro@ lleva "Andrea
  // Machado" y no "Registro JP Tactical Trading".
  //
  // CONSECUENCIA: "Andrea Machado" pasa a ser un nombre con DOS teléfonos ⇒ resolveCloserByPushName
  // devuelve null (ambiguo = SEGURO) y hay que declararlo en HOMONIMOS_OK del test, igual que
  // Sebastian Rodriguez. NO la bloquea: el opt-in resuelve por TELÉFONO antes que por pushName, así
  // que cada identidad entra por lo suyo. `/calendly on|off Andrea Machado <cuenta>` sigue
  // funcionando porque resolveIdentitiesByName devuelve la lista completa para desambiguar.
  andrea_machado: {
    name: 'Andrea Machado',
    identities: [
      { connection: 'retia', email: 'registro@ttrading.co', phone: '+573132484664' },
      // Hostea 150 de las 219 citas de ComunicArte de la ventana: es la closer principal, no un
      // refuerzo.
      //
      // ⚠️ workLid capturado 2026-08-26 del mapeo `lid-mapping-<lid>_reverse.json` de la sesión de
      // Baileys, que es WhatsApp diciendo a qué número pertenece el LID — no una inferencia por
      // pushName. Le escribió a Juanito y NO fue reconocida: sus tres vías fallaron a la vez
      // (`from` es un @lid opaco ⇒ no matchea por teléfono; sin workLid declarado ⇒ no matchea por
      // LID; y su nombre pasó a ser AMBIGUO al ganar la segunda identidad ⇒ resolveCloserByPushName
      // devuelve null por diseño). Juanito le contestó como a una desconocida.
      //
      // 🩸 LA LECCIÓN: darle a una persona ya existente una segunda identidad le QUITA la vía del
      // pushName, porque su nombre pasa a tener dos teléfonos. Es correcto que devuelva null —un
      // extraño llamado "Andrea Restrepo" no puede secuestrarle los pushes— pero significa que
      // **una segunda identidad tiene que nacer con su workLid, o su dueña no puede registrarse
      // sola nunca**. No es un caso raro: es el patrón, y ya hay dos personas multi-identidad.
      { connection: 'comunicarte', email: 'info@eventoscomunicarte.com', phone: '+573171297303', workLid: '122836635136119' },
    ],
  },
  // Alta 2026-08-25. Entró a "De Cero a Tactical Investor" (host de una cita FUTURA cuando se
  // detectó, la del 25-ago 7pm). Estaba SIN MAPEAR: ni en CLOSERS ni en IGNORED_CLOSERS ⇒ alerta
  // de "closer sin mapear" en cada poll y esa call sin un solo push.
  //
  // ⚠️ NO confundir con `dana@30x.com`, que sigue en IGNORED_CLOSERS: ese correo se ignora porque
  // su volumen real está en "AI for Executives", un programa que no gestionamos. Esta identidad es
  // otra cosa (otro correo, otra conexión, otro programa) y no toca aquella decisión. Si algún día
  // se quiere cubrir su lado de 30x, es un alta nueva —una segunda identidad acá—, no un
  // des-ignorar: lo que se ignoró fue el PROGRAMA, no la persona.
  //
  // Ojo con la historia: Dana ya había salido de Retia el 2026-07-22 (la reemplazó Sebastian
  // Salazar en el buzón-rol equipo@ttrading.co, que desde el 2026-09-02 atiende Maru Marquez).
  // Esto es un regreso con correo PROPIO, no un
  // buzón-rol — a diferencia de registro@ y equipo@, acá el correo es de ella.
  //
  // ✅ OPT-IN HECHO (2026-08-26 14:28, verificado contra la DB de producción): fila en
  // `calendly_optins` con source 'self', `paused=0` y `contact_jid` = el mismo LID que se declara
  // abajo. Ya recibe. Ojo al leer su historial: sus DOS únicos pushes están `skipped`
  // (`sin-optin` y `obsoleto`) porque son ANTERIORES a esa fila — son la call de Michael
  // Castellanos del 26-ago 00:00, que se perdió. Desde el opt-in no se le creó ningún push
  // porque no volvió a hostear, así que un push precall completo todavía no se vio llegar.
  // "Cero pushes" acá es agenda vacía, no cableado roto.
  dana_rodriguez: {
    name: 'Dana Rodriguez',
    // workLid capturado 2026-08-26 del mapeo lid↔número de la sesión de Baileys. Mismo caso que
    // Maru: escribió y no fue reconocida.
    identities: [{ connection: 'retia', email: 'hola.danvar@gmail.com', phone: '+573169835624', workLid: '264471603867732' }],
  },
  // ─── ComunicArte (conexión #4) — programa "Método Comunicarte" ─────────────
  // Hosts verificados 2026-08-25 contra la cuenta real: la org tiene DOS miembros y los dos
  // hostean citas. La otra es Andrea Machado (info@eventoscomunicarte.com), que NO vive acá sino
  // como segunda identidad de su entrada de Retia — es la misma persona (ver arriba).
  // No hay ningún tercero que ignorar entre los hosts VIVOS.
  //
  // ✅ Las dos hicieron OPT-IN el 2026-08-26 (Maru 02:51, Andrea/info@ 03:34) y la conexión ya
  // salió de dry-run (`CALENDLY_DRY_RUN_COMUNICARTE=false` en producción). Verificado contra la
  // DB: ambas con source 'self' y `paused=0`, y con pushes en estado `sent` — o sea la cadena
  // completa (opt-in → poll → cola anti-ban → entrega) está probada de punta a punta acá.
  //
  // Las dos tienen `workLid` declarado, capturado cuando escribieron (ver las notas de cada una).
  // La regla de fondo no cambia: un LID sin entrega probada CEMENTA el destino equivocado, así
  // que un alta nueva sigue entrando sin `workLid` hasta que la persona escriba.
  // ⚠️ DOS identidades desde 2026-09-02: cierra "Método Comunicarte" en ComunicArte y "De Cero a
  // Tactical Investor" en la conexión retia, desde la MISMA línea de WhatsApp. Es el patrón de
  // Sebastian Salazar (a quien reemplaza en el buzón), no el de Andrea Machado ni el de Sebastian
  // Rodriguez, que usan un número por conexión.
  //
  // ⚠️ POR QUÉ SU SEGUNDA IDENTIDAD NO ES SU GMAIL — y por qué eso NO es opcional. En Calendly una
  // cuenta pertenece a UNA organización: el campo del usuario es `current_organization`, uno solo,
  // no una lista. Su gmail vive en la org de ComunicArte (d84e158d…), así que NO puede además ser
  // miembro de la de Tactical Investor (fa27fb07…). Medido contra la API el 2026-09-02: filtrando
  // por ese correo, esa org devuelve 0 miembros y 0 invitaciones de cualquier estado. Retia lo
  // resolvió asignándole el BUZÓN-ROL, que es como opera sus cupos.
  //
  // Si algún día alguien "arregla" esto poniéndole el gmail a las dos identidades: rompe el
  // invariante `un email = una IDENTIDAD` (CLOSERS se deriva keyeado por email → la segunda pisa
  // a la primera en silencio y `accountOfCloser` devuelve la que ganó el sorteo).
  maru_marquez: {
    name: 'Maru Marquez',
    identities: [
      // Gmail personal, pero ES su host real en el Calendly de ComunicArte (2 citas verificadas,
      // la primera del 2026-08-24 → entró hace días). Mismo patrón que sebasrr321@ en Retia.
      // workLid capturado 2026-08-26 del mapeo lid↔número de la sesión de Baileys (ver Andrea
      // Machado arriba). Escribió a Juanito el 26-ago 00:40 y no fue reconocida: sin LID declarado
      // y con `from` viniendo como @lid opaco, la única vía que quedaba era el pushName.
      { connection: 'comunicarte', email: 'soymarumarquez@gmail.com', phone: '+573108600134', workLid: '162173754060966' },
      // BUZÓN-ROL de Retia para "De Cero a Tactical Investor", heredado de Sebastian Salazar el
      // 2026-09-02 (él queda desvinculado del programa; ver PEOPLE.sebastian_salazar). El correo
      // NO cambia de dueño en Calendly —la cuenta sigue llamándose "Equipo JP Tactical Trading"—,
      // así que la API no tiene forma de saber quién está detrás: este roster es el ÚNICO lugar
      // donde ese dato existe. Rotar el buzón = cambiar este teléfono.
      //
      // MISMO teléfono que su identidad de ComunicArte a propósito: es una sola línea. Su opt-in
      // (fila por TELÉFONO, 2026-08-26, contact_jid 162173754060966@lid, paused=0) sirve a las dos
      // identidades sin tocar la DB, así que empieza a recibir estos pushes sin escribir de nuevo.
      // El destino se resuelve contra el roster VIVO al entregar (scheduler/calendly.js:587), no
      // con el teléfono congelado en la fila del push.
      //
      // SIN `workLid`, y no es un olvido: el invariante "ningún workLid se declara dos veces" lo
      // prohíbe (los pushes de ambas identidades irían al mismo hilo por dos caminos distintos), y
      // no hace falta — `workLidForCloser` busca por email, devuelve null acá, y el destino lo fija
      // el `contact_jid` del opt-in, que YA es su hilo de trabajo. Su nombre tampoco se vuelve
      // ambiguo: resolveCloserByPushName deduplica por teléfono y las dos identidades comparten el
      // suyo, así que sigue resolviendo (a diferencia de Andrea, que sí quedó ambigua al ganar la
      // segunda identidad con otro número).
      { connection: 'retia', email: 'equipo@ttrading.co', phone: '+573108600134' },
    ],
  },
};

// ─── Identidad de PRUEBA, gateada por entorno (§18.BB) ───────────────────────────────────────
// El setteo del closer (§18.AZ) no se puede probar de punta a punta sin que una PERSONA REAL le
// escriba a Juanito: el rol sale del JID de quien manda el mensaje, y `src/index.js` no es
// testeable (importarlo conecta Baileys). Esto habilita una identidad desechable para ese smoke,
// sin exponerle nada a un closer de verdad.
//
// **Apagada salvo que `TEST_CLOSER_ENABLED=true`.** El gate es la feature, no un detalle: sin él
// esto sería una entrada suelta que alguien tiene que acordarse de borrar, y quitarla costaría
// otro deploy con su reconexión de WhatsApp. Así, terminar la prueba es apagar un flag.
//
// ⚠️ Un closer de mentira NO ejercita la mitad de la feature. Su email no es owner de nada en
// HubSpot, así que la cifra "registrado en HubSpot" sale 0 y TODOS los leads salen con el ⚠️ de
// brecha; y como no tiene calls, la cuota se calcula sobre la jornada entera y sale altísima. Eso
// es esperado, no un bug: lo que este smoke prueba es el ROUTER (que el mensaje del closer llegue
// a su contexto agéntico, el bug que estaba vivo en producción), el parser y los comandos.
//
// ⚠️ El LID va declarado como `workLid` a propósito: en WhatsApp multi-device el mensaje llega
// como `<lid>@lid` opaco, así que sin él el reconocimiento colgaría del pushName del teléfono —
// que es justo la vía que falla EN SILENCIO. Capturado de la sesión de Baileys (2026-08-04).
//
// ⚠️ Y no alcanza con esto: mientras su LID esté en `ADMIN_LID`, `roleOf()` lo resuelve como
// admin ANTES de llegar a la rama de closer. Hay que sacarlo del `.env` durante la prueba.
if (process.env.TEST_CLOSER_ENABLED === 'true') {
  PEOPLE.prueba_setteo = {
    name: 'Prueba Setteo',
    identities: [
      {
        connection: '30x',
        email: 'prueba.setteo@30x.com', // no existe en Calendly ni en HubSpot: nunca recibe pushes
        phone: '+573052933190',
        workLid: '65756133896221',
      },
    ],
  };
}

// ─── Derivación: mapa email → { name, phone, account? } (una entrada por IDENTIDAD) ──────────
// account se emite SOLO cuando la connection no es la default → el CLOSERS resultante es idéntico
// al roster histórico (las identidades 30x sin campo `account`, las de retia con account:'retia').
export const CLOSERS = Object.fromEntries(
  Object.values(PEOPLE).flatMap((person) =>
    person.identities.map((id) => {
      const entry = { name: person.name, phone: id.phone };
      if (id.connection !== DEFAULT_ACCOUNT) entry.account = id.connection;
      return [id.email.toLowerCase(), entry];
    })
  )
);

// ─── Derivación: owner de HubSpot → email CANÓNICO del closer ────────────────────────────────
// El email con el que una persona es owner en HubSpot no siempre es el mismo con el que hostea
// en Calendly (Pablo Suarez: pablosuarez+hubspot@ vs pablosuarez@). Este mapa hace de puente en
// las DOS direcciones que importan:
//   · pertenencia — ¿este owner es uno de nuestros closers? (antes: un Set de emails de Calendly,
//     que dejaba fuera a quien tuviera alias)
//   · canonicalización — la fila que sale de HubSpot debe llevar el email de CALENDLY, no el de
//     HubSpot. Si no, la misma call no deduplica contra su gemela de Calendly (`dedupKey` va por
//     email) y el jefe la ve DOS VECES; y `resolveCloser` no encuentra el nombre.
// La identidad siempre se mapea a sí misma, así que sin `hubspotEmail` el comportamiento es el
// de antes. Clave y valor en minúsculas.
export const HUBSPOT_OWNER_TO_CLOSER = Object.fromEntries(
  Object.values(PEOPLE).flatMap((person) =>
    person.identities.flatMap((id) => {
      const canonical = id.email.toLowerCase();
      const pairs = [[canonical, canonical]];
      if (id.hubspotEmail) pairs.push([id.hubspotEmail.toLowerCase(), canonical]);
      return pairs;
    })
  )
);

// LIDs CONOCIDOS de cada identidad: para closers cuyo @lid no mapea a su teléfono canónico y
// cuyo pushName no permite el match. Mapear el LID hace que el bot lo RECONOZCA (rol de closer,
// setteo, respuestas de Push 4) y que su contact_jid se AUTOCORRIJA al hilo correcto en vez de
// driftear al número equivocado. Clave = solo dígitos del LID (sin @lid); valor = email.
//
// Incluye los `extraJids` a propósito: si un closer recibe copia en un segundo aparato, lo más
// probable es que también CONTESTE desde ahí — y sin este mapeo su respuesta llegaría como la de
// un desconocido. Reconocer no mueve la entrega: el destino primario lo fija `workLidForCloser`,
// que lee `workLid` y NUNCA un extra (ver abajo).
export const CLOSER_LIDS = Object.fromEntries(
  Object.values(PEOPLE).flatMap((person) =>
    person.identities.flatMap((id) => {
      const email = id.email.toLowerCase();
      const lids = id.workLid ? [id.workLid] : [];
      for (const jid of id.extraJids || []) {
        const lid = String(jid).split('@')[0].replace(/\D/g, '');
        if (lid) lids.push(lid);
      }
      return lids.map((lid) => [lid, email]);
    })
  )
);

// Aparatos SECUNDARIOS a los que se copia todo lo que sale hacia una identidad (`extraJids`).
// Mapa email → [jid, …]. Se derivan por IDENTIDAD, no por persona, y es deliberado: dos
// identidades de la misma persona pueden ser dos líneas distintas (Sebastian Rodriguez: una en
// 30x y otra en retia), y copiarle el push de una empresa al WhatsApp que usa para la otra sería
// filtrar leads entre clientes. Quien quiera la copia en las dos, la declara en las dos.
//
// ⚠️ Esto SALTEA el gate de "hilo establecido" de deliver(), que es la defensa anti-ban: el
// primario se valida contra `calendly_optins.contact_jid` (prueba de que ese hilo escribió), el
// secundario se valida contra el criterio de quien edita este archivo. Declararlo solo con
// TRÁFICO ENTRANTE PROBADO — la receta está en docs/JUANITO-HANDOFF.md (los archivos
// `session-<lid>_*.json` / `tctoken-<lid>@lid.json` de la sesión de Baileys solo existen si hubo
// mensajes de verdad). Un JID inventado acá es exactamente el envío en frío que causó el softban.
export const CLOSER_EXTRA_JIDS = Object.fromEntries(
  Object.values(PEOPLE).flatMap((person) =>
    person.identities
      .filter((id) => id.extraJids?.length)
      .map((id) => [id.email.toLowerCase(), [...id.extraJids]])
  )
);

// Hosts de Calendly que aparecen en el query org-wide pero que DELIBERADAMENTE NO
// gestionamos con pushes. Se saltan en SILENCIO — sin alerta de "closer sin mapear" al admin.
// Mover a CLOSERS cuando se quieran activar.
//
// Auditoría 2026-07-14 (45 días de historia + 14 de agenda futura contra la cuenta real):
// TODOS los de esta lista tienen CERO calls futuras y llevan entre 20 y 42 días sin hostear
// — están fuera del equipo o dormidos. Camilo/Natalia/registro@ estaban SIN MAPEAR (ni acá
// ni en CLOSERS), así que sus calls disparaban alertas de "closer sin mapear" en cada poll.
export const IGNORED_CLOSERS = new Set([
  // Salió del equipo (2026-07-14). No está en la lista de closers que dictó el jefe.
  // Tenía 139 calls en Second Brain pero CERO futuras y sin hostear desde el 3 jul.
  // Su opt-in también se borró de la DB — si vuelve, tiene que escribirle a Juanito de nuevo.
  'maca.celis@30x.com',
  'andrea.machado@30x.com',   // salió del equipo (2026-07-14; última call 25 jun)
  'mateo.leon@30x.com',       // salió del equipo (2026-06-24)
  'natalia.gonzalez@30x.com', // salió del equipo (2026-06-24; se documentó pero no se ignoró → alertas)
  'camilo.castiblanco@30x.com', // salió del equipo (2026-07-14; última call 8 jun)
  'dana@30x.com',             // su volumen real está en "AI for Executives" (programa no gestionado)
  'yuli@30x.com',             // idem Dana
  'equipo@estadox.com',       // cuenta compartida de EstadoX — standby
  'registro@estadox.com',     // cuenta de sistema de EstadoX — nunca fue un closer
  // Retia (2026-07-21):
  'jvieira@ttrading.co',      // Juan Pablo Vieira VENDE el programa (cara), no es closer. Tomó citas
                              // en el pasado (12 en la ventana) pero YA NO → skip silencioso.
  'alejocarpa1108@gmail.com', // salió de Tactical Investor 2026-07-21; lo reemplazó Sebastian Rodriguez.
  // ComunicArte (2026-08-25): usuario BORRADO de Calendly. Hosteó 67 citas (56 de "Método" + 11
  // de "Evento") y NINGUNA futura — su última es del pasado. Calendly ya no expone su correo:
  // devuelve este placeholder. Se ignora para que, si alguna vez una de sus citas cayera en la
  // ventana del poll, no dispare una alerta de "closer sin mapear" por alguien que ya no existe.
  '0df1f193-cdc3-44dc-89d2-82f47077e9d8@deleted.calendly.com',
  // NO agregar 'equipo@ttrading.co': es el buzón-rol que hoy atiende Maru Marquez (antes Sebastian
  // Salazar, hasta el 2026-09-02; antes Dana, hasta el 22-jul) y vive en
  // CLOSERS (ver PEOPLE.sebastian_salazar). Estuvo acá del 22 al 29 de julio por asumir que Salazar
  // tendría cuenta propia, y ese skip silencioso le costó una semana de pushes.
  // Owner de HubSpot, NO de Calendly. Decisión del jefe 2026-07-27: se ignora para que el poll de
  // meetings no dispare alertas de "closer sin mapear" ni le meta sesiones a la agenda del jefe.
  //
  // ⚠️ CORRECCIÓN 2026-07-29 — la razón anotada acá ("383 meetings 'Sesión Programa LinkedIn
  // Sales 30X' en 30 días ⇒ son sesiones grupales") NO se reproduce. Medido directo por ownerId
  // (90154139), 30 días, paginado hasta agotar: 246 meetings, de los cuales "Sesión Programa
  // LinkedIn Sales 30X" son 18, no 383. El grueso son ~200 "AI Second Brain Admisiones — <lead>",
  // UNO por lead y con UN solo contacto asociado (75 de 100 en la muestra) → son calls 1-a-1,
  // no sesiones. Las grupales (Office Hour, Sesión N, Networking Dinner) son ~32.
  // O sea: el volumen 1-a-1 existe. Mantener o no la exclusión es decisión del jefe, no un dato
  // técnico; mientras siga acá no recibe pushes —y de todos modos no podría, porque no está en el
  // roster (sin teléfono) ni tiene opt-in ganado.
  'danieltovar@30x.com',
]);

export function isIgnoredCloser(email) {
  if (!email) return false;
  return IGNORED_CLOSERS.has(String(email).toLowerCase().trim());
}

// Devuelve { name, phone } | null
export function resolveCloser(email) {
  if (!email) return null;
  return CLOSERS[String(email).toLowerCase().trim()] || null;
}

// Key de la cuenta de Calendly a la que pertenece un closer. Es la REGLA ÚNICA con la que
// se decide todo lo que sale hacia un closer (dry-run, Push 4, HubSpot): el closer siempre
// se conoce — en el loop de entrega por `closer_email` de la fila, en los digests porque
// agrupan por closer — mientras que el programa puede venir NULL en filas viejas.
// Un email desconocido cae a la cuenta default, que es el comportamiento histórico.
export function accountOfCloser(email) {
  const c = CLOSERS[String(email || '').toLowerCase().trim()];
  return c?.account || DEFAULT_ACCOUNT;
}

// Resuelve un closer por su número entrante (cuando le escribe a Juanito).
// Devuelve { email, name, phone } | null
export function resolveCloserByPhone(phone) {
  if (!phone) return null;
  for (const [email, c] of Object.entries(CLOSERS)) {
    if (phonesMatch(c.phone, phone)) return { email, name: c.name, phone: c.phone };
  }
  return null;
}

// Resuelve un closer por el LID desde el que escribe (CLOSER_LIDS). Para cuentas cuyo @lid no
// mapea al teléfono canónico y cuyo pushName no permite el match. Acepta el JID completo
// (158025419608301@lid) o solo los dígitos. Devuelve { email, name, phone } | null.
export function resolveCloserByLid(jid) {
  if (!jid) return null;
  const lid = String(jid).split('@')[0].replace(/\D/g, '');
  if (!lid) return null;
  const email = CLOSER_LIDS[lid];
  if (!email) return null;
  const c = CLOSERS[email];
  return c ? { email, name: c.name, phone: c.phone } : null;
}

// Devuelve el JID de TRABAJO canónico (`<lid>@lid`) de un closer si su identidad declara
// `workLid`, o null. Sirve para PINNEAR el contact_jid de entrega al hilo de trabajo:
// aunque el closer escriba desde otro dispositivo (ej: Sebas desde su WhatsApp personal,
// cuyo pushName "Sebastian Rodriguez" SÍ matchea y haría driftear el contact_jid), la
// entrega se mantiene en el LID de trabajo. Mata el bug recurrente de "pushes al personal".
//
// ⚠️ Lee `workLid` del roster, NO CLOSER_LIDS. Antes escaneaba ese mapa y devolvía el primer LID
// que apuntara al email, lo cual dejó de ser equivalente cuando CLOSER_LIDS pasó a incluir los
// `extraJids`: para un closer con aparato secundario podía devolver el SECUNDARIO y pinear ahí
// la entrega primaria — justo lo contrario de lo que "extra" significa.
export function workLidForCloser(email) {
  if (!email) return null;
  const e = String(email).toLowerCase().trim();
  for (const person of Object.values(PEOPLE)) {
    for (const id of person.identities) {
      if (id.workLid && id.email.toLowerCase() === e) return `${id.workLid}@lid`;
    }
  }
  return null;
}

// Aparatos secundarios de una identidad (copia de todo lo que se le entrega). Array, vacío por
// defecto — que es el caso de casi todo el roster. Ver CLOSER_EXTRA_JIDS para las advertencias.
export function extraJidsForCloser(email) {
  if (!email) return [];
  return CLOSER_EXTRA_JIDS[String(email).toLowerCase().trim()] || [];
}

// Resuelve un closer por su nombre de WhatsApp (pushName), fallback cuando el LID
// no se puede mapear a teléfono. Requiere que el pushName contenga el nombre completo
// del closer (ej: "Pablo Lozano") para evitar ambigüedades (ej: dos Sebastians).
// Devuelve { email, name, phone } | null — null si no hay match o hay ambigüedad.
// Normaliza para comparar nombres: minúsculas, SIN ACENTOS, sin emojis ni puntuación.
// Los acentos importan: en el mapa los nombres van sin tilde ("Pablo Suarez") pero el
// pushName de WhatsApp casi siempre la trae ("Pablo Suárez") → sin esto no matchean.
function nameWords(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\s*\(.*\)/, '') // quita "(EstadoX)" y similares
    .replace(/[^\w\s]/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

export function resolveCloserByPushName(pushName) {
  if (!pushName) return null;
  const words = nameWords(pushName);
  if (!words.length) return null;

  const seen = new Map(); // phone → entry, para deduplicar si dos emails apuntan al mismo número
  for (const [email, c] of Object.entries(CLOSERS)) {
    const closerWords = nameWords(c.name);
    // Un nombre de UNA sola palabra ("Dana") no identifica a nadie: matchearía a cualquier
    // desconocido cuyo nombre de WhatsApp la contenga ("Dana Beauty Salon", "Juan Andrea").
    // Y el match acá NO es inocuo: handleCloserOptin le pone al opt-in del closer el
    // contact_jid de QUIEN ESCRIBIÓ → todos sus pushes (con nombres y teléfonos de leads)
    // se irían a esa persona. Mismo bug que 491f604, pero disparable por cualquiera.
    // Un nombre de una palabra es ambiguo por definición → mismo trato que la ambigüedad.
    if (closerWords.length < 2) continue;
    // Exigir que TODAS las palabras del closer estén en el pushName (evita falsos parciales)
    if (closerWords.every(w => words.includes(w))) {
      if (!seen.has(c.phone)) seen.set(c.phone, { email, name: c.name, phone: c.phone });
    }
  }
  return seen.size === 1 ? [...seen.values()][0] : null;
}

// TODAS las identidades cuyo nombre de closer matchea `name` (nombre completo). A diferencia de
// resolveCloserByPushName —que colapsa a null ante ambigüedad para NO auto-registrar al closer
// equivocado—, acá devolvemos la LISTA completa a propósito: la usa `/calendly on|off <closer>`
// para desambiguar por CONEXIÓN cuando una persona tiene 1+ identidades (ej: Sebastian Rodriguez
// en 30x y en retia). Cada elemento: { email, name, phone, account, accountLabel }, con
// account = key de la Conexión (DEFAULT_ACCOUNT para la identidad default). Dedup por teléfono
// (una identidad = un teléfono, invariante del roster). Vacío si no matchea nadie.
export function resolveIdentitiesByName(name) {
  if (!name) return [];
  const words = nameWords(name);
  if (!words.length) return [];
  const out = [];
  // Dedup por (teléfono, cuenta): una persona puede tener DOS identidades con el MISMO teléfono en
  // cuentas distintas (Sebastian Salazar: 30x + retia) → hay que listar AMBAS para que el dev
  // desambigüe por cuenta. Solo colapsa un duplicado real (mismo teléfono Y misma cuenta, que no
  // debería existir en el roster).
  const seen = new Set();
  for (const [email, c] of Object.entries(CLOSERS)) {
    const closerWords = nameWords(c.name);
    if (closerWords.length < 2) continue; // un nombre de una palabra no identifica a nadie
    if (!closerWords.every((w) => words.includes(w))) continue;
    const account = c.account || DEFAULT_ACCOUNT;
    const key = `${c.phone}|${account}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ email, name: c.name, phone: c.phone, account, accountLabel: accountOf(account)?.label || account });
  }
  return out;
}

// ¿El JID desde el que un closer se registró apunta a un número DISTINTO al canónico de
// trabajo? Es la señal del bug "pushes al número personal": el closer escribió desde otro
// número y el contact_jid del opt-in (a donde se entregan los pushes) quedó apuntando ahí.
// Solo se puede juzgar para JIDs de TELÉFONO (@s.whatsapp.net / @c.us): los @lid de
// multi-device son opacos y no mapean a un número, así que ahí devolvemos false (no alarmar).
export function isNonCanonicalOptinJid(canonicalPhone, fromJid) {
  if (!canonicalPhone || !fromJid) return false;
  if (String(fromJid).includes('@lid')) return false; // opaco: no se puede comparar con un número
  return !phonesMatch(canonicalPhone, fromJid);
}
