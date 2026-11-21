import { useApi } from '../lib/api';
import { PageHead } from '../components/ui';

export function Privacy() {
  const tools = useApi<{ tools: { id: string; name: string; hosts: string[]; active: boolean }[] }>('/api/argos/tools');
  const active = (tools.data?.tools ?? []).filter((t) => t.active);
  return (
    <>
      <PageHead title="Qué se registra" subtitle="Lo que la extensión Argos guarda de cada turno, y lo que nunca guarda." />
      <div className="grid cols-2">
        <div className="card card-pad prose">
          <h2>Sí se registra</h2>
          <ul>
            <li>Hora de inicio y de fin de cada turno.</li>
            <li>Pausas declaradas por la persona y su motivo.</li>
            <li>Por cada minuto del turno, <strong>cuántas</strong> teclas, clics y desplazamientos hubo dentro de las herramientas autorizadas. Solo el número.</li>
            <li>Segundos en que cada herramienta autorizada estuvo en uso.</li>
            <li>Si el equipo estaba activo, inactivo o con pantalla bloqueada.</li>
            <li>Estado de conexión y última sincronización de la extensión.</li>
            <li>Novedades reportadas.</li>
          </ul>
        </div>
        <div className="card card-pad prose">
          <h2>Nunca se registra</h2>
          <ul>
            <li>Qué teclas se pulsan ni el texto escrito.</li>
            <li>Contraseñas: en campos de contraseña no se cuenta nada.</li>
            <li>Contenido de conversaciones, formularios o portapapeles.</li>
            <li>Capturas de pantalla, cámara o micrófono.</li>
            <li>Direcciones de páginas: solo el nombre de la herramienta.</li>
            <li>Sitios personales o cualquier página fuera de las herramientas autorizadas: la extensión no tiene permiso para verlas.</li>
            <li>Ventanas de incógnito.</li>
            <li>Nada fuera del turno ni durante las pausas.</li>
          </ul>
        </div>
      </div>
      <div className="card card-pad prose">
        <h2>Cómo se interpreta</h2>
        <p>
          Los conteos indican que hubo actividad en las herramientas; no miden desempeño. No teclear no significa no trabajar: se puede estar leyendo, en una llamada o resolviendo una novedad.
          Por eso el tablero distingue entre <strong>actividad observada</strong>, <strong>sin actividad observada</strong>, <strong>pausa</strong>, <strong>sin señal</strong> y <strong>sin datos</strong>.
        </p>
        <p>Las ventas, mensajes enviados, conversaciones atendidas y tiempos de respuesta se obtendrán de las propias plataformas mediante integraciones verificables. Nunca se infieren del teclado.</p>
        <p>Cada persona puede ver y descargar los registros por minuto de sus propios turnos en «Mi turno». Los registros por minuto se eliminan automáticamente al cumplirse el plazo de conservación de la empresa.</p>
        <h2>Herramientas autorizadas actualmente</h2>
        {active.length ? (
          <ul>
            {active.map((t) => <li key={t.id}><strong>{t.name}</strong> <span className="mono muted">{t.hosts.join(', ')}</span></li>)}
          </ul>
        ) : (
          <p className="muted">No hay herramientas autorizadas.</p>
        )}
      </div>
    </>
  );
}
