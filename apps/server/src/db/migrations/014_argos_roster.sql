-- Malla de turnos: el turno de cada persona en una fecha concreta.
-- Manda sobre el horario fijo semanal (argos_schedules) en ese día. Sin horas = descanso.
CREATE TABLE argos_roster (
  user_id     uuid NOT NULL REFERENCES core_users(id),
  company_id  uuid NOT NULL REFERENCES core_companies(id),
  day         text NOT NULL,   -- 'AAAA-MM-DD' en la zona horaria de la empresa
  start_time  text,            -- 'HH:MM'; NULL junto con end_time = descanso
  end_time    text,
  updated_by  uuid,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, day)
);
CREATE INDEX argos_roster_company_idx ON argos_roster (company_id, day);
