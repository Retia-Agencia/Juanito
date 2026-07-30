// Tabla genérica: deriva las columnas de las claves del primer objeto. Sirve para
// los 12 tabs sin escribir 12 tablas — los datos ya vienen con nombres del esquema y
// esos nombres son el vocabulario del repo, no hay que traducirlos.

const NUMERICA = /^(id|n|count|attempts|push_n|sent_count|minutos)$/;

function celda(valor) {
  if (valor === null || valor === undefined || valor === '') return '—';
  if (typeof valor === 'boolean') return valor ? 'sí' : 'no';
  if (typeof valor === 'object') return JSON.stringify(valor);
  return String(valor);
}

export default function Tabla({ filas, vacio = 'Sin registros', columnas = null }) {
  if (!filas?.length) return <div className="envoltura"><div className="vacio">{vacio}</div></div>;
  const cols = columnas || Object.keys(filas[0]);

  return (
    <div className="envoltura">
      <table>
        <thead>
          <tr>{cols.map((c) => <th key={c}>{c.replace(/_/g, ' ')}</th>)}</tr>
        </thead>
        <tbody>
          {filas.map((f, i) => (
            <tr key={f.id ?? i}>
              {cols.map((c) => (
                <td key={c} className={NUMERICA.test(c) ? 'num' : undefined} title={celda(f[c])}>
                  {celda(f[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
