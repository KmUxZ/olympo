import { useState } from 'react';
import { api } from '../lib/api';
import { INCIDENT_LABEL } from '../lib/format';
import { Field, FormModal } from './ui';

/** Registro de una novedad. Supervisores y administradores pueden registrarla a nombre de otra persona. */
export function IncidentForm({ people, onClose, onSaved }: { people?: { id: string; name: string }[]; onClose: () => void; onSaved: () => Promise<void> | void }) {
  const [type, setType] = useState('conexion');
  const [description, setDescription] = useState('');
  const [userId, setUserId] = useState('');
  async function save() {
    await api('POST', '/api/argos/incidents', { type, description, ...(userId ? { userId } : {}) });
    await onSaved();
  }
  return (
    <FormModal title="Registrar novedad" submitLabel="Registrar" onClose={onClose} onSubmit={save}>
      {people && people.length > 0 && (
        <Field label="Persona afectada">
          <select value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">Yo</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
      )}
      <Field label="Tipo">
        <select value={type} onChange={(e) => setType(e.target.value)}>
          {Object.entries(INCIDENT_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </Field>
      <Field label="Descripción" hint="Qué pasó, desde cuándo y cómo afecta la atención.">
        <textarea required minLength={3} maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
    </FormModal>
  );
}
