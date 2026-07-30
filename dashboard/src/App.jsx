import { useEffect, useState, useCallback, Component } from 'react';
import Tabla from './Tabla.jsx';
import {
  useEscrituras,
  postear,
  Boton,
  Botones,
  FormaProgramado,
  FormaRecordatorio,
} from './Escrituras.jsx';

// Las escrituras (F2) se encienden TAB POR TAB con `DASH_WRITES` en el .env del VPS.
// Con la variable vacía esto es exactamente el dashboard read-only de F1: sin botones,
// sin columna de acciones, sin formas. Ver docs/DASHBOARD-ROADMAP.md.

const TABS = [
  { id: 'salud', nombre: 'Salud', ruta: '/api/salud' },
  { id: 'aprobaciones', nombre: 'Aprobaciones', ruta: '/api/aprobaciones' },
  { id: 'calls', nombre: 'Calls', ruta: '/api/calls' },
  { id: 'grupos', nombre: 'Grupos', ruta: '/api/grupos' },
  { id: 'programados', nombre: 'Programados', ruta: '/api/programados' },
  { id: 'outreach', nombre: 'Outreach', ruta: '/api/outreach' },
  { id: 'recordatorios', nombre: 'Recordatorios', ruta: '/api/recordatorios' },
  { id: 'tareas', nombre: 'Tareas', ruta: '/api/tareas' },
  { id: 'negocio', nombre: 'Negocio', ruta: '/api/negocio' },
  { id: 'optins', nombre: 'Opt-ins', ruta: '/api/optins' },
  { id: 'toggles', nombre: 'Toggles', ruta: '/api/toggles' },
  { id: 'registries', nombre: 'Registries', ruta: '/api/registries' },
  { id: 'alertas', nombre: 'Alertas', ruta: '/api/alertas' },
];

const traer = (ruta) =>
  fetch(ruta).then((r) => (r.ok ? r.json() : r.json().then((e) => Promise.reject(new Error(e.error)))));

// Pide un texto con el valor actual precargado. null/vacío = el operador se arrepintió.
const pedirTexto = (etiqueta, actual = '') => {
  const v = window.prompt(etiqueta, actual);
  return v && v.trim() ? v.trim() : null;
};

// ── Salud ───────────────────────────────────────────────────────────────────

function TarjetaCheck({ check }) {
  return (
    <div className={`tarjeta ${check.level}`}>
      <div className="fila">
        <span className="titulo">{check.label}</span>
        <span className="numero">{check.count}</span>
      </div>
      <div className="detalle">{check.detail}</div>
      {check.rows?.length > 0 && (
        <details>
          <summary>Ver {check.rows.length} fila(s)</summary>
          <Tabla filas={check.rows} />
        </details>
      )}
    </div>
  );
}

function Salud({ datos }) {
  // Los checks en rojo primero: si algo está mal, no debería haber que buscarlo.
  const orden = { error: 0, warn: 1, ok: 2 };
  const checks = [...datos.checks].sort((a, b) => orden[a.level] - orden[b.level]);
  return <div className="rejilla">{checks.map((c) => <TarjetaCheck key={c.key} check={c} />)}</div>;
}

// ── Tabs con varias secciones ───────────────────────────────────────────────

function Secciones({ grupos }) {
  return grupos.map(({ titulo, filas, vacio, columnas, acciones }) => (
    <div className="seccion" key={titulo}>
      <h3>{titulo} {Array.isArray(filas) && `(${filas.length})`}</h3>
      <Tabla filas={filas} vacio={vacio} columnas={columnas} acciones={acciones} />
    </div>
  ));
}

// Interruptor global: una tarjeta con su estado y un botón. `encendido` = la función
// está haciendo lo suyo, no el valor crudo de la columna (calendly_paused es al revés).
function Interruptor({ titulo, detalle, encendido, textoOn, textoOff, onCambiar }) {
  return (
    <div className={`tarjeta ${encendido ? 'ok' : 'warn'}`}>
      <div className="fila">
        <span className="titulo">{titulo}</span>
        <span className={`estado ${encendido ? 'si' : 'no'}`}>{encendido ? textoOn : textoOff}</span>
      </div>
      <div className="detalle">{detalle}</div>
      {onCambiar && (
        <Botones>
          <Boton peligro={encendido} onClick={() => onCambiar(!encendido)}>
            {encendido ? textoOff : textoOn}
          </Boton>
        </Botones>
      )}
    </div>
  );
}

// ── Contenido por tab ───────────────────────────────────────────────────────

function Contenido({ tab, datos, ops }) {
  switch (tab) {
    case 'salud':
      return <Salud datos={datos} />;

    case 'aprobaciones': {
      // Aprobar publica de verdad: el cron de group-messages lo recoge en minutos.
      const draft = (f) => (
        <Botones>
          {f.status === 'pending' && ops.puede('aprobaciones', 'draft.aprobar') && (
            <Boton
              onClick={() =>
                ops.actuar(
                  'aprobaciones',
                  'draft.aprobar',
                  { id: f.id },
                  `Aprobar el borrador #${f.id} → se publica en "${f.group_name}" a las ${f.time_hm}.\n\n«${f.draft}»`
                )
              }
            >
              Aprobar
            </Boton>
          )}
          {['pending', 'approved'].includes(f.status) && ops.puede('aprobaciones', 'draft.corregir') && (
            <Boton
              onClick={() => {
                const texto = pedirTexto('Texto corregido del borrador:', f.draft);
                if (texto) ops.actuar('aprobaciones', 'draft.corregir', { id: f.id, texto });
              }}
            >
              Corregir
            </Boton>
          )}
          {['pending', 'approved'].includes(f.status) && ops.puede('aprobaciones', 'draft.descartar') && (
            <Boton peligro onClick={() => ops.actuar('aprobaciones', 'draft.descartar', { id: f.id })}>
              Descartar
            </Boton>
          )}
        </Botones>
      );

      const respuesta = (f) => (
        <Botones>
          {ops.puede('aprobaciones', 'respuesta.aprobar') && (
            <Boton
              onClick={() =>
                ops.actuar(
                  'aprobaciones',
                  'respuesta.aprobar',
                  { id: f.id },
                  `Aprobar la respuesta #${f.id} → se publica en "${f.group_name}".\n\n«${f.draft}»`
                )
              }
            >
              Aprobar
            </Boton>
          )}
          {ops.puede('aprobaciones', 'respuesta.corregir') && (
            <Boton
              onClick={() => {
                const texto = pedirTexto('Respuesta corregida:', f.draft);
                if (texto) ops.actuar('aprobaciones', 'respuesta.corregir', { id: f.id, texto });
              }}
            >
              Corregir
            </Boton>
          )}
          {ops.puede('aprobaciones', 'respuesta.descartar') && (
            <Boton peligro onClick={() => ops.actuar('aprobaciones', 'respuesta.descartar', { id: f.id })}>
              Descartar
            </Boton>
          )}
        </Botones>
      );

      const on = ops.activo('aprobaciones');
      return (
        <Secciones grupos={[
          { titulo: 'Borradores de hoy', filas: datos.drafts, vacio: 'Ningún borrador para hoy', acciones: on ? draft : null },
          { titulo: 'Respuestas pendientes', filas: datos.respuestas, vacio: 'Nada esperando aprobación', acciones: on ? respuesta : null },
          { titulo: 'Retenidas por horario silencioso', filas: datos.retenidas, vacio: 'Ninguna retenida', acciones: on ? respuesta : null },
        ]} />
      );
    }

    case 'calls':
      return <Secciones grupos={[
        { titulo: 'Agenda (−2h a +24h)', filas: datos.agenda, vacio: 'Sin calls en la ventana' },
        { titulo: 'Outcomes (últimas 24h)', filas: datos.outcomes, vacio: 'Sin outcomes registrados' },
        { titulo: 'Pushes por enviar ahora', filas: datos.porEnviar, vacio: 'Ninguno vencido' },
      ]} />;

    case 'grupos': {
      // Desautorizar NO está: en el bot va con leaveGroup() y acá no hay socket. Salir
      // de un grupo sigue siendo un acto deliberado por WhatsApp.
      const acciones = (f) => (
        <Botones>
          {ops.puede('grupos', 'aprobacion') && (
            <Boton
              onClick={() =>
                ops.actuar('grupos', 'aprobacion', { grupoId: f.group_id, activo: !f.requiere_aprobacion })
              }
            >
              {f.requiere_aprobacion ? 'Quitar aprobación' : 'Exigir aprobación'}
            </Boton>
          )}
          {ops.puede('grupos', 'persona') && (
            <Boton
              onClick={() => {
                const persona = pedirTexto(`Persona de Juanito en "${f.group_name}":`, f.persona || '');
                if (persona) ops.actuar('grupos', 'persona', { grupoId: f.group_id, persona });
              }}
            >
              Persona
            </Boton>
          )}
          {f.persona && ops.puede('grupos', 'persona.borrar') && (
            <Boton peligro onClick={() => ops.actuar('grupos', 'persona.borrar', { grupoId: f.group_id })}>
              Borrar persona
            </Boton>
          )}
        </Botones>
      );
      return (
        <>
          <div className="aviso">
            Autorizar un grupo nuevo sigue siendo <code>/grupo on</code> por WhatsApp: para eso hace
            falta el socket del bot (control server, F6).
          </div>
          <Tabla filas={datos} vacio="Sin grupos autorizados" acciones={ops.activo('grupos') ? acciones : null} />
        </>
      );
    }

    case 'programados': {
      const acciones = (f) => (
        <Botones>
          {f.active === 1 && ops.puede('programados', 'cancelar') && (
            <Boton peligro onClick={() => ops.actuar('programados', 'cancelar', { id: f.id })}>
              Cancelar
            </Boton>
          )}
        </Botones>
      );
      return (
        <>
          {ops.puede('programados', 'crear') && <FormaProgramado ops={ops} />}
          <Tabla filas={datos} vacio="Sin mensajes recurrentes" acciones={ops.activo('programados') ? acciones : null} />
        </>
      );
    }

    case 'outreach': {
      const acciones = (f) => (
        <Botones>
          {ops.puede('outreach', 'cancelar') && (
            <Boton
              peligro
              onClick={() => ops.actuar('outreach', 'cancelar', { id: f.id })}
              titulo="Lo apaga: no vuelve a escribirle"
            >
              Cancelar
            </Boton>
          )}
        </Botones>
      );
      return (
        <>
          <div className="aviso">
            Crear un outreach sigue siendo por DM al bot: resolver el contacto, validar el número,
            el piso anti-spam y de parte de quién va son reglas que viven en el bot y no se
            duplican acá. Apagar uno que se está portando mal sí se hace desde acá.
          </div>
          <Tabla filas={datos} vacio="Sin outreach activos" acciones={ops.activo('outreach') ? acciones : null} />
        </>
      );
    }

    case 'recordatorios': {
      const acciones = (f) => (
        <Botones>
          {f.status === 'pending' && ops.puede('recordatorios', 'posponer') && (
            <Boton
              onClick={() => {
                const cuando = pedirTexto('Nueva fecha y hora local (YYYY-MM-DD HH:MM:SS):', f.due_at);
                if (cuando) ops.actuar('recordatorios', 'posponer', { id: f.id, cuando });
              }}
            >
              Posponer
            </Boton>
          )}
          {f.status === 'pending' && ops.puede('recordatorios', 'cancelar') && (
            <Boton peligro onClick={() => ops.actuar('recordatorios', 'cancelar', { id: f.id })}>
              Cancelar
            </Boton>
          )}
        </Botones>
      );
      return (
        <>
          {ops.puede('recordatorios', 'crear') && <FormaRecordatorio ops={ops} />}
          <Tabla filas={datos} vacio="Sin recordatorios pendientes" acciones={ops.activo('recordatorios') ? acciones : null} />
        </>
      );
    }

    case 'tareas': {
      // "Hecha" le avisa por WhatsApp al que pidió la tarea, igual que /tareas hecha.
      const acciones = (f) => (
        <Botones>
          {ops.puede('tareas', 'hecha') && (
            <Boton
              onClick={() =>
                ops.actuar(
                  'tareas',
                  'hecha',
                  { id: f.id },
                  `Cerrar la tarea #${f.id} y avisarle a ${f.created_by || 'nadie (sin solicitante)'}:\n\n«${f.request}»`
                )
              }
            >
              Hecha
            </Boton>
          )}
          {ops.puede('tareas', 'descartar') && (
            <Boton peligro onClick={() => ops.actuar('tareas', 'descartar', { id: f.id })}>
              Descartar
            </Boton>
          )}
        </Botones>
      );
      return <Tabla filas={datos} vacio="Sin tareas pendientes" acciones={ops.activo('tareas') ? acciones : null} />;
    }

    case 'negocio': {
      const activar = (f) => (
        <Botones>
          {ops.puede('negocio', 'estado') && (
            <Boton peligro onClick={() => ops.actuar('negocio', 'estado', { id: f.id, estado: 'archived' })}>
              Archivar
            </Boton>
          )}
        </Botones>
      );
      const decidir = (f) => (
        <Botones>
          {ops.puede('negocio', 'estado') && (
            <>
              <Boton onClick={() => ops.actuar('negocio', 'estado', { id: f.id, estado: 'active' })}>Aprobar</Boton>
              <Boton peligro onClick={() => ops.actuar('negocio', 'estado', { id: f.id, estado: 'archived' })}>
                Archivar
              </Boton>
            </>
          )}
        </Botones>
      );
      const on = ops.activo('negocio');
      return <Secciones grupos={[
        { titulo: 'Hechos activos', filas: datos.activos, vacio: 'Sin contexto de negocio', acciones: on ? activar : null },
        { titulo: 'Propuestos (esperan /negocio ok)', filas: datos.propuestos, vacio: 'Nada propuesto', acciones: on ? decidir : null },
      ]} />;
    }

    case 'optins':
      return (
        <>
          <div className="aviso">
            {datos.total} opt-in(s) · <strong>{datos.ganados} ganados</strong> (el closer escribió) ·{' '}
            {datos.sembrados} sembrados. Solo los ganados habilitan envío en frío.
          </div>
          <Tabla filas={datos.filas} vacio="Sin opt-ins" />
        </>
      );

    case 'toggles': {
      const closer = (f) => (
        <Botones>
          {ops.puede('toggles', 'closer') && (
            <Boton
              peligro={!f.pausado}
              onClick={() => ops.actuar('toggles', 'closer', { email: f.email, pausado: !f.pausado })}
            >
              {f.pausado ? 'Reactivar' : 'Pausar'}
            </Boton>
          )}
        </Botones>
      );
      return (
        <>
          <div className="aviso">
            Misma fuente de verdad que <code>/calendly on|off</code> y <code>/confirmaciones dm</code>:
            la tabla <code>settings</code>. Lo que cambies acá se ve igual desde WhatsApp.
          </div>
          <div className="rejilla">
            <Interruptor
              titulo="Calendly — pushes precall"
              detalle="Pausa GLOBAL. Con esto apagado ningún closer recibe recordatorio de call."
              encendido={!datos.calendlyPausado}
              textoOn="ACTIVO"
              textoOff="PAUSADO"
              onCambiar={ops.puede('toggles', 'calendly') ? (on) => ops.actuar('toggles', 'calendly', { pausado: !on }) : null}
            />
            <Interruptor
              titulo="Aprobación de DMs de desconocidos"
              detalle="Con esto ON, todo DM de un desconocido se retiene y pasa por el visto bueno del jefe."
              encendido={datos.dmAprobacion}
              textoOn="ON"
              textoOff="OFF"
              onCambiar={ops.puede('toggles', 'dm') ? (on) => ops.actuar('toggles', 'dm', { activo: on }) : null}
            />
          </div>
          <div className="seccion">
            <h3>Pausa por closer ({datos.closers.length} identidades)</h3>
            <Tabla filas={datos.closers} acciones={ops.activo('toggles') ? closer : null} />
          </div>
        </>
      );
    }

    case 'registries':
      return (
        <>
          <div className="aviso">
            Fuente: <code>src/calendly/*.js</code>. Solo lectura hasta F3 — para cambiar algo hoy
            todavía hay que editar código y desplegar.
          </div>
          <div className="aviso">
            <strong>Token, dry-run y Push 4 salen «—» a propósito.</strong> Dependen de variables
            de entorno del proceso del <em>bot</em>, y el dashboard corre en otro contenedor que no
            las recibe. Antes se mostraban los defaults de <em>este</em> proceso como si fueran la
            config del bot: decía <code>dry-run: sí</code> con los pushes saliendo de verdad.
            Verlos requiere preguntarle al bot (control server, F6).
          </div>
          <Secciones grupos={[
            { titulo: 'Programas', filas: datos.programas },
            { titulo: 'Conexiones de Calendly', filas: datos.conexiones },
            { titulo: 'Closers', filas: datos.closers },
            {
              titulo: 'Hosts ignorados en silencio',
              filas: datos.ignorados.map((email) => ({ email })),
              vacio: 'Ninguno',
            },
          ]} />
          <div className="aviso">
            Los hosts ignorados se saltan <strong>sin log ni contador</strong>: desde el bot, uno
            retirado y uno que factura calls a diario se ven igual. Esa indistinguibilidad fue
            exactamente el bug §18.AV.
          </div>
        </>
      );

    default:
      return <Tabla filas={datos} />;
  }
}

// ── Frontera de error ───────────────────────────────────────────────────────
// Sin esto, UNA excepción de render en UN tab desmonta la app entera y deja la pantalla en
// negro, sin un solo mensaje. Fue exactamente lo que pasó con Toggles y Registries, y es lo
// contrario de la garantía 5 del roadmap ("el dashboard degrada solo"): la consola sirve
// justamente cuando algo anda mal, así que no puede ser lo primero que se cae.
// Acota el daño AL TAB: el resto de la navegación sigue viva y el error se puede leer.
// Tiene que ser una clase — React 19 sigue sin dar frontera de error en hooks.
class FronteraDeError extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="aviso error-caja">
        <strong>El tab «{this.props.tab}» falló al dibujarse.</strong> Los demás siguen funcionando.
        <pre>{String(this.state.error?.stack || this.state.error)}</pre>
      </div>
    );
  }
}

// ── App ─────────────────────────────────────────────────────────────────────

export default function App() {
  const [tab, setTab] = useState('salud');
  const [datos, setDatos] = useState(null);
  const [salud, setSalud] = useState(null);
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState(null);
  const [cargando, setCargando] = useState(true);

  const ruta = TABS.find((t) => t.id === tab).ruta;

  // Los datos se guardan JUNTO AL TAB al que pertenecen, y `Contenido` solo se dibuja cuando
  // los dos coinciden. Sin eso, cambiar de tab renderiza el tab NUEVO con los datos del
  // ANTERIOR: `setTab` re-renderiza de inmediato y el `setDatos(null)` del efecto de abajo
  // corre DESPUÉS del commit, o sea tarde. Once tabs sobrevivían de casualidad porque pasan
  // por <Tabla>, que tolera `undefined` (`!filas?.length`); Toggles y Registries reventaban
  // con pantalla negra por desreferenciar directo (`datos.closers.length`, `datos.ignorados.map`).
  // De paso mata la carrera de respuestas fuera de orden: ir a A → B → A rápido ya no deja que
  // la respuesta lenta de B se pinte encima de A.
  const cargar = useCallback(() => {
    setError(null);
    traer(ruta)
      .then((d) => setDatos({ tab, payload: d }))
      .catch((e) => setError(e.message))
      .finally(() => setCargando(false));
  }, [ruta, tab]);

  const ops = useEscrituras(meta, cargar);

  // ¿Los datos que hay en mano son de ESTE tab?
  const listo = datos?.tab === tab;

  useEffect(() => { setCargando(true); setDatos(null); cargar(); }, [cargar]);
  useEffect(() => { traer('/api/meta').then(setMeta).catch(() => {}); }, []);

  // La salud se refresca sola cada 30s aunque estés en otro tab: el badge del lateral
  // es lo que te entera de que algo se rompió sin que te avise un humano.
  useEffect(() => {
    const tick = () => traer('/api/salud').then(setSalud).catch(() => {});
    tick();
    const id = setInterval(tick, 30000);
    return () => clearInterval(id);
  }, []);

  const rojos = salud?.checks.filter((c) => c.level === 'error').length || 0;
  const amarillos = salud?.checks.filter((c) => c.level === 'warn').length || 0;
  const tabsQueEscriben = Object.keys(meta?.escrituras || {});

  // El deploy `todo` reconstruye la imagen y RECONECTA Baileys. El backoff de
  // entrypoint.sh existe por un softban real, así que el aviso es explícito y distinto.
  const desplegar = async (alcance) => {
    const advertencia =
      alcance === 'todo'
        ? 'Deploy COMPLETO: reconstruye la imagen y RECONECTA WhatsApp (riesgo de softban si se repite). ¿Seguro?'
        : 'Deploy del dashboard. No toca el contenedor del bot. ¿Dale?';
    if (!window.confirm(advertencia)) return;
    try {
      const r = await postear('/api/deploy', { alcance });
      ops.notificar('ok', `Deploy (${alcance}) disparado en ${r.repo}@${r.rama} — seguilo en GitHub Actions`);
    } catch (e) {
      ops.notificar('error', `Deploy: ${e.message}`);
    }
  };

  return (
    <div className="app">
      <nav className="lateral">
        <div className="marca">
          <h1>Juanito</h1>
          <div className="sub">
            {meta ? `${meta.sha.slice(0, 7)} · ${meta.tz}` : 'conectando…'}
          </div>
        </div>

        {TABS.map((t) => (
          <button
            key={t.id}
            className="tab"
            aria-current={t.id === tab}
            onClick={() => setTab(t.id)}
          >
            {t.nombre}
            {t.id === 'salud' && rojos > 0 && <span className="pill error">{rojos}</span>}
            {t.id === 'salud' && rojos === 0 && amarillos > 0 && <span className="pill warn">{amarillos}</span>}
            {tabsQueEscriben.includes(t.id) && <span className="pill escribe" title="escrituras habilitadas">rw</span>}
          </button>
        ))}

        {meta?.deploy && (
          <div className="deploy">
            <Boton onClick={() => desplegar('dash')} titulo="rsync del dashboard + recrear solo el contenedor dash">
              Deploy dashboard
            </Boton>
            <Boton peligro onClick={() => desplegar('todo')} titulo="Reconstruye la imagen y reconecta WhatsApp">
              Deploy todo
            </Boton>
          </div>
        )}
      </nav>

      <main className="principal">
        <div className="encabezado">
          <h2>{TABS.find((t) => t.id === tab).nombre}</h2>
          {salud && (
            <span className="semaforo">
              <span className={`punto ${salud.nivel}`} />
              {salud.nivel === 'ok' ? 'todo en orden' : `${rojos} rojo(s) · ${amarillos} amarillo(s)`}
            </span>
          )}
          {meta && (
            <span className="meta">
              uptime {Math.floor(meta.uptimeSeg / 3600)}h{Math.floor((meta.uptimeSeg % 3600) / 60)}m ·
              alertas WhatsApp {meta.alertasWhatsapp ? 'ON' : 'OFF'} ·
              {tabsQueEscriben.length ? ` escriben: ${tabsQueEscriben.join(', ')}` : ' solo lectura'}
              {ops.ocupado && ' · escribiendo…'}
            </span>
          )}
        </div>

        {ops.aviso && (
          <div className={`aviso ${ops.aviso.nivel === 'error' ? 'error-caja' : ops.aviso.nivel}`}>
            {ops.aviso.texto}
            <button type="button" className="cerrar" onClick={ops.cerrarAviso}>×</button>
          </div>
        )}
        {error && <div className="aviso error-caja">Error al cargar: {error}</div>}
        {cargando && !listo && <div className="vacio">Cargando…</div>}
        {listo && (
          // `key={tab}` remonta la frontera al cambiar de tab: si no, un tab que reventó deja
          // la frontera en estado de error y el siguiente hereda el mensaje.
          <FronteraDeError key={tab} tab={tab}>
            <Contenido tab={tab} datos={datos.payload} ops={ops} />
          </FronteraDeError>
        )}
      </main>
    </div>
  );
}
