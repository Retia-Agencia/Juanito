// dashboard/src/Escrituras.jsx
// Plomería de las escrituras (F2). Tres piezas:
//
//   · useEscrituras  → qué se puede escribir (lo dice el servidor en /api/meta), cómo
//                      se dispara y dónde se muestra el resultado.
//   · Boton          → el botón, para que todos se vean igual.
//   · Las dos formas de creación (mensaje recurrente y recordatorio).
//
// `window.confirm` y `window.prompt` a propósito: son nativos, accesibles, no piden una
// sola dependencia ni un componente de modal, y el número de campos acá es de uno o dos.
// La forma con varios campos sí es un <form> de verdad. F6 puede embellecer todo esto.

import { useCallback, useEffect, useState } from 'react';

export const postear = (ruta, cuerpo) =>
  fetch(ruta, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
  }).then(async (r) => {
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    return d;
  });

export function useEscrituras(meta, recargar) {
  const [aviso, setAviso] = useState(null);
  const [ocupado, setOcupado] = useState(false);
  const catalogo = meta?.escrituras || {};

  const notificar = useCallback((nivel, texto) => setAviso({ nivel, texto }), []);
  const puede = useCallback((tab, accion) => !!catalogo[tab]?.[accion], [catalogo]);
  // ¿Este tab escribe algo? Con las escrituras apagadas no se dibuja ni la columna de
  // botones: la UI es la de F1, sin huecos.
  const activo = useCallback((tab) => !!catalogo[tab], [catalogo]);

  // `resumen` describe el efecto en palabras del operador y solo se usa cuando la
  // acción manda un WhatsApp real: el servidor marca cuáles con `sale`, acá no se
  // adivina. Un push a un closer no se dispara por un click distraído.
  const actuar = useCallback(
    async (tab, accion, cuerpo, resumen = '') => {
      if (catalogo[tab]?.[accion]?.sale) {
        const ok = window.confirm(`${resumen}\n\nEsto termina en un mensaje de WhatsApp REAL. ¿Confirmás?`);
        if (!ok) return;
      }
      setOcupado(true);
      try {
        const r = await postear(`/api/w/${tab}/${accion}`, cuerpo);
        notificar(
          r.ok ? 'ok' : 'warn',
          r.ok
            ? `${tab}/${accion}: listo`
            : `${tab}/${accion}: sin efecto — la fila ya había cambiado de estado`
        );
        recargar();
      } catch (e) {
        notificar('error', `${tab}/${accion}: ${e.message}`);
      } finally {
        setOcupado(false);
      }
    },
    [catalogo, notificar, recargar]
  );

  return { puede, activo, actuar, notificar, ocupado, aviso, cerrarAviso: () => setAviso(null) };
}

export function Boton({ children, onClick, peligro = false, titulo }) {
  return (
    <button type="button" className={`accion${peligro ? ' peligro' : ''}`} onClick={onClick} title={titulo}>
      {children}
    </button>
  );
}

export const Botones = ({ children }) => <div className="botones">{children}</div>;

// ─── Formas de creación ───────────────────────────────────────────────────────

const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];

// Mensaje recurrente a un grupo. Solo grupos AUTORIZADOS: la lista sale de
// /api/grupos, que es la misma tabla que el bot consulta (default-deny anti-secuestro).
export function FormaProgramado({ ops }) {
  const [grupos, setGrupos] = useState([]);
  const [f, setF] = useState({ grupoId: '', dias: [], hora: '09:00', modo: 'fijo', cuerpo: '' });

  useEffect(() => {
    fetch('/api/grupos').then((r) => r.json()).then(setGrupos).catch(() => {});
  }, []);

  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const alternarDia = (d) =>
    set('dias', f.dias.includes(d) ? f.dias.filter((x) => x !== d) : [...f.dias, d]);

  const listo = f.grupoId && f.dias.length && f.hora && f.cuerpo.trim();
  const nombre = grupos.find((g) => g.group_id === f.grupoId)?.group_name || f.grupoId;

  const enviar = () => {
    const clave = f.modo === 'fijo' ? 'texto' : 'brief';
    ops.actuar(
      'programados',
      'crear',
      { grupoId: f.grupoId, dias: f.dias, hora: f.hora, [clave]: f.cuerpo.trim() },
      `Programar un mensaje ${f.modo === 'fijo' ? 'FIJO' : 'GENERADO'} en "${nombre}", ` +
        `los ${f.dias.map((d) => DIAS[d]).join(', ')} a las ${f.hora}.`
    );
    set('cuerpo', '');
  };

  return (
    <details className="forma">
      <summary>Programar un mensaje recurrente</summary>
      <div className="campos">
        <label>
          Grupo
          <select value={f.grupoId} onChange={(e) => set('grupoId', e.target.value)}>
            <option value="">— elegí un grupo autorizado —</option>
            {grupos.map((g) => (
              <option key={g.group_id} value={g.group_id}>{g.group_name || g.group_id}</option>
            ))}
          </select>
        </label>

        <label>
          Días
          <span className="dias">
            {DIAS.map((d, i) => (
              <button
                key={d}
                type="button"
                className={`dia${f.dias.includes(i) ? ' activo' : ''}`}
                onClick={() => alternarDia(i)}
              >
                {d}
              </button>
            ))}
          </span>
        </label>

        <label>
          Hora (local, 24h)
          <input type="time" value={f.hora} onChange={(e) => set('hora', e.target.value)} />
        </label>

        <label>
          Tipo
          <select value={f.modo} onChange={(e) => set('modo', e.target.value)}>
            <option value="fijo">Fijo — se publica este texto literal</option>
            <option value="generado">Generado — Claude redacta y el jefe aprueba antes</option>
          </select>
        </label>

        <label className="ancho">
          {f.modo === 'fijo' ? 'Texto exacto que se publica' : 'Brief editorial (tema, tono, qué incluir)'}
          <textarea rows={3} value={f.cuerpo} onChange={(e) => set('cuerpo', e.target.value)} />
        </label>

        <Botones>
          <Boton onClick={enviar} titulo={listo ? '' : 'Faltan campos'}>
            {listo ? 'Crear' : 'Faltan campos'}
          </Boton>
        </Botones>
      </div>
    </details>
  );
}

// Recordatorio. Es el mismo outbox que usa el watchdog: el bot lo despacha por la cola
// anti-ban en el siguiente minuto. Sin teléfono, queda como nota sin destinatario.
export function FormaRecordatorio({ ops }) {
  const [f, setF] = useState({ texto: '', cuando: '', telefono: '' });
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));

  const enviar = () => {
    // <input type="datetime-local"> da 'YYYY-MM-DDTHH:MM'; la columna guarda hora LOCAL
    // con segundos.
    const cuando = `${f.cuando.replace('T', ' ')}:00`;
    ops.actuar(
      'recordatorios',
      'crear',
      { texto: f.texto.trim(), cuando, telefono: f.telefono.trim() || null },
      `Recordatorio para ${f.telefono.trim() || '(sin destinatario)'} el ${cuando}: «${f.texto.trim()}»`
    );
    setF({ texto: '', cuando: '', telefono: '' });
  };

  return (
    <details className="forma">
      <summary>Crear un recordatorio</summary>
      <div className="campos">
        <label className="ancho">
          Texto
          <input value={f.texto} onChange={(e) => set('texto', e.target.value)} />
        </label>
        <label>
          Cuándo (hora local)
          <input type="datetime-local" value={f.cuando} onChange={(e) => set('cuando', e.target.value)} />
        </label>
        <label>
          Destinatario (LID o número, sin +)
          <input value={f.telefono} onChange={(e) => set('telefono', e.target.value)} placeholder="opcional" />
        </label>
        <Botones>
          <Boton onClick={enviar}>{f.texto.trim() && f.cuando ? 'Crear' : 'Faltan campos'}</Boton>
        </Botones>
      </div>
    </details>
  );
}
