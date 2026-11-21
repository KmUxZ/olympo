-- Módulos: Alarmas, Agenda, Mensajes, Acompañamiento y Calidad. (Reportes no necesita tablas propias.)

-- ───────── Alarmas ─────────
CREATE TABLE argos_alarm_rules (
  company_id         uuid NOT NULL REFERENCES core_companies(id),
  type               text NOT NULL,
  enabled            boolean NOT NULL DEFAULT true,
  threshold_minutes  integer NOT NULL,
  PRIMARY KEY (company_id, type)
);

CREATE TABLE argos_alerts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES core_companies(id),
  type         text NOT NULL,
  user_id      uuid NOT NULL REFERENCES core_users(id),   -- persona a la que se refiere
  dedupe_key   text NOT NULL,                              -- una sola alerta abierta por situación
  message      text NOT NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz,                                -- se cierra sola cuando la situación termina
  ack_by       uuid,
  ack_at       timestamptz
);
CREATE UNIQUE INDEX argos_alerts_open_key ON argos_alerts (company_id, dedupe_key) WHERE resolved_at IS NULL;
CREATE INDEX argos_alerts_company_idx ON argos_alerts (company_id, started_at DESC);

-- ───────── Agenda ─────────
CREATE TABLE argos_agenda (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES core_companies(id),
  title         text NOT NULL,
  notes         text NOT NULL DEFAULT '',
  kind          text NOT NULL CHECK (kind IN ('tarea', 'reunion', 'compromiso', 'actividad')),
  starts_at     timestamptz NOT NULL,
  ends_at       timestamptz,
  user_id       uuid REFERENCES core_users(id),   -- para una persona…
  team_id       uuid REFERENCES core_teams(id),   -- …o para un equipo; ambos vacíos = toda la empresa
  created_by    uuid NOT NULL REFERENCES core_users(id),
  status        text NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente', 'hecha', 'cancelada')),
  completed_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX argos_agenda_company_idx ON argos_agenda (company_id, starts_at);

-- ───────── Mensajes internos ─────────
CREATE TABLE argos_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES core_companies(id),
  sender_id   uuid NOT NULL REFERENCES core_users(id),
  to_user_id  uuid REFERENCES core_users(id),
  to_team_id  uuid REFERENCES core_teams(id),
  to_all      boolean NOT NULL DEFAULT false,
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX argos_messages_company_idx ON argos_messages (company_id, created_at DESC);

CREATE TABLE argos_message_reads (
  message_id  uuid NOT NULL REFERENCES argos_messages(id),
  user_id     uuid NOT NULL REFERENCES core_users(id),
  read_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id)
);

-- ───────── Acompañamiento ─────────
CREATE TABLE argos_coaching_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES core_companies(id),
  user_id     uuid NOT NULL REFERENCES core_users(id),
  coach_id    uuid NOT NULL REFERENCES core_users(id),
  held_at     timestamptz NOT NULL,
  topic       text NOT NULL,
  notes       text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX argos_coaching_company_idx ON argos_coaching_sessions (company_id, held_at DESC);

CREATE TABLE argos_commitments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES core_companies(id),
  session_id  uuid NOT NULL REFERENCES argos_coaching_sessions(id),
  user_id     uuid NOT NULL REFERENCES core_users(id),
  text        text NOT NULL,
  due_date    text,   -- 'AAAA-MM-DD'
  status      text NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente', 'cumplido', 'no_cumplido')),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ───────── Calidad ─────────
CREATE TABLE argos_quality_criteria (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES core_companies(id),
  name         text NOT NULL,
  description  text NOT NULL DEFAULT '',
  weight       integer NOT NULL DEFAULT 1 CHECK (weight BETWEEN 1 AND 10),
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE argos_quality_evaluations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES core_companies(id),
  user_id          uuid NOT NULL REFERENCES core_users(id),
  evaluator_id     uuid NOT NULL REFERENCES core_users(id),
  reference        text NOT NULL DEFAULT '',   -- qué se evaluó (conversación, llamada, fecha…)
  observations     text NOT NULL DEFAULT '',
  feedback         text NOT NULL DEFAULT '',
  scores           jsonb NOT NULL,             -- copia de criterios, pesos y notas en el momento de evaluar
  total            integer NOT NULL,           -- 0 a 100
  created_at       timestamptz NOT NULL DEFAULT now(),
  acknowledged_at  timestamptz                 -- la persona evaluada confirma que la leyó
);
CREATE INDEX argos_quality_company_idx ON argos_quality_evaluations (company_id, created_at DESC);
