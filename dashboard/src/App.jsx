import { useEffect, useState, useCallback } from 'react';
import Tabla from './Tabla.jsx';

// F1 es SOLO LECTURA: no hay un solo botón que escriba. Las escrituras llegan en F2,
// tab por tab (garantía 4 de docs/DASHBOARD-ROADMAP.md).

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
  { id: 'registries', nombre: 'Registries', ruta: '/api/registries' },
  { id: 'alertas', nombre: 'Alertas', ruta: '/api/alertas' },
];

const traer = (ruta) =>
  fetch(ruta).then((r) => (r.ok ? r.json() : r.json().then((e) => Promise.reject(new Error(e.error)))));

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
  return grupos.map(({ titulo, filas, vacio, columnas }) => (
    <div className="seccion" key={titulo}>
      <h3>{titulo} {Array.isArray(filas) && `(${filas.length})`}</h3>
      <Tabla filas={filas} vacio={vacio} columnas={columnas} />
    </div>
  ));
}

function Contenido({ tab, datos }) {
  switch (tab) {
    case 'salud':
      return <Salud datos={datos} />;

    case 'aprobaciones':
      return <Secciones grupos={[
        { titulo: 'Borradores de hoy', filas: datos.drafts, vacio: 'Ningún borrador para hoy' },
        { titulo: 'Respuestas pendientes', filas: datos.respuestas, vacio: 'Nada esperando aprobación' },
        { titulo: 'Retenidas por horario silencioso', filas: datos.retenidas, vacio: 'Ninguna retenida' },
      ]} />;

    case 'calls':
      return <Secciones grupos={[
        { titulo: 'Agenda (−2h a +24h)', filas: datos.agenda, vacio: 'Sin calls en la ventana' },
        { titulo: 'Outcomes (últimas 24h)', filas: datos.outcomes, vacio: 'Sin outcomes registrados' },
        { titulo: 'Pushes por enviar ahora', filas: datos.porEnviar, vacio: 'Ninguno vencido' },
      ]} />;

    case 'negocio':
      return <Secciones grupos={[
        { titulo: 'Hechos activos', filas: datos.activos, vacio: 'Sin contexto de negocio' },
        { titulo: 'Propuestos (esperan /negocio ok)', filas: datos.propuestos, vacio: 'Nada propuesto' },
      ]} />;

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

    case 'registries':
      return (
        <>
          <div className="aviso">
            Fuente: <code>src/calendly/*.js</code>. Solo lectura hasta F3 — para cambiar algo hoy
            todavía hay que editar código y desplegar.
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

// ── App ─────────────────────────────────────────────────────────────────────

export default function App() {
  const [tab, setTab] = useState('salud');
  const [datos, setDatos] = useState(null);
  const [salud, setSalud] = useState(null);
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState(null);
  const [cargando, setCargando] = useState(true);

  const ruta = TABS.find((t) => t.id === tab).ruta;

  const cargar = useCallback(() => {
    setError(null);
    traer(ruta).then(setDatos).catch((e) => setError(e.message)).finally(() => setCargando(false));
  }, [ruta]);

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
          </button>
        ))}
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
              alertas WhatsApp {meta.alertasWhatsapp ? 'ON' : 'OFF'} · solo lectura
            </span>
          )}
        </div>

        {error && <div className="aviso error-caja">Error al cargar: {error}</div>}
        {cargando && !datos && <div className="vacio">Cargando…</div>}
        {datos && <Contenido tab={tab} datos={datos} />}
      </main>
    </div>
  );
}
