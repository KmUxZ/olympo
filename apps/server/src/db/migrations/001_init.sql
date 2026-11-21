-- OLYMPO · esquema inicial
-- Prefijos: core_* (plataforma compartida por todos los productos) · argos_* (producto Argos).
-- Todas las tablas llevan company_id: separación de datos por empresa.

CREATE TABLE core_companies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  timezone    text NOT NULL DEFAULT 'UTC',
  is_demo     boolean NOT NULL DEFAULT false,
  settings    jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE core_teams (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES core_companies(id),
  name          text NOT NULL,
  supervisor_id uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE core_users (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES core_companies(id),
  email                 text NOT NULL,
  name                  text NOT NULL,
  role                  text NOT NULL CHECK (role IN ('admin', 'supervisor', 'seller')),
  password_hash         text NOT NULL,
  must_change_password  boolean NOT NULL DEFAULT true,
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  team_id               uuid REFERENCES core_teams(id),
  is_demo               boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX core_users_email_key ON core_users (lower(email));
CREATE INDEX core_users_company_idx ON core_users (company_id);
ALTER TABLE core_teams ADD CONSTRAINT core_teams_supervisor_fk FOREIGN KEY (supervisor_id) REFERENCES core_users(id);

CREATE TABLE core_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES core_companies(id),
  user_id       uuid NOT NULL REFERENCES core_users(id),
  token_hash    text NOT NULL UNIQUE,
  client        text NOT NULL CHECK (client IN ('web', 'extension')),
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz
);
CREATE INDEX core_sessions_user_idx ON core_sessions (user_id);

CREATE TABLE core_audit_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES core_companies(id),
  actor_id     uuid,
  actor_name   text,
  action       text NOT NULL,
  entity_type  text,
  entity_id    text,
  summary      text NOT NULL,
  metadata     jsonb NOT NULL DEFAULT '{}',
  ip           text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX core_audit_company_idx ON core_audit_log (company_id, created_at DESC);

-- ───────────────────────── Argos ─────────────────────────

-- Herramientas de trabajo autorizadas: la extensión solo registra dentro de estos dominios.
CREATE TABLE argos_tools (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES core_companies(id),
  name        text NOT NULL,
  hosts       jsonb NOT NULL DEFAULT '[]',   -- lista de dominios, p. ej. ["web.whatsapp.com"]
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE argos_lines (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES core_companies(id),
  label             text NOT NULL,
  channel           text NOT NULL DEFAULT 'whatsapp',
  identifier        text NOT NULL DEFAULT '',
  assigned_user_id  uuid REFERENCES core_users(id),
  active            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX argos_lines_company_idx ON argos_lines (company_id);

-- Programación semanal del turno de cada persona (una por usuario en el MVP).
CREATE TABLE argos_schedules (
  user_id     uuid PRIMARY KEY REFERENCES core_users(id),
  company_id  uuid NOT NULL REFERENCES core_companies(id),
  weekdays    jsonb NOT NULL DEFAULT '[1,2,3,4,5]',  -- 0 = domingo … 6 = sábado
  start_time  text NOT NULL,                          -- 'HH:MM' en la zona horaria de la empresa
  end_time    text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE argos_shifts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES core_companies(id),
  user_id       uuid NOT NULL REFERENCES core_users(id),
  team_id       uuid,
  lines         jsonb NOT NULL DEFAULT '[]',   -- copia de las líneas asignadas al iniciar
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  started_at    timestamptz NOT NULL DEFAULT now(),
  ended_at      timestamptz,
  end_reason    text,                          -- 'usuario' | 'supervision' | 'automatico'
  ended_by      uuid,
  last_sync_at  timestamptz,
  summary       jsonb
);
CREATE UNIQUE INDEX argos_shifts_one_active ON argos_shifts (user_id) WHERE status = 'active';
CREATE INDEX argos_shifts_company_idx ON argos_shifts (company_id, started_at DESC);

CREATE TABLE argos_breaks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES core_companies(id),
  shift_id    uuid NOT NULL REFERENCES argos_shifts(id),
  user_id     uuid NOT NULL REFERENCES core_users(id),
  reason      text NOT NULL,
  note        text NOT NULL DEFAULT '',
  started_at  timestamptz NOT NULL DEFAULT now(),
  ended_at    timestamptz
);
CREATE UNIQUE INDEX argos_breaks_one_open ON argos_breaks (shift_id) WHERE ended_at IS NULL;

-- Un registro por minuto en que la extensión estuvo viva durante el turno (aunque no haya actividad).
-- Su ausencia significa "sin datos"; received_at tardío significa que hubo falta de conexión.
CREATE TABLE argos_presence_minutes (
  shift_id      uuid NOT NULL REFERENCES argos_shifts(id),
  minute_start  timestamptz NOT NULL,
  company_id    uuid NOT NULL,
  user_id       uuid NOT NULL,
  system_state  text NOT NULL DEFAULT 'unknown',  -- active | idle | locked | unknown (chrome.idle)
  received_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shift_id, minute_start)
);

-- Actividad agregada por minuto y herramienta. Solo conteos: nunca teclas, texto ni URL.
-- La clave natural (turno, minuto, herramienta) hace que los reenvíos no dupliquen datos.
CREATE TABLE argos_activity_minutes (
  shift_id        uuid NOT NULL REFERENCES argos_shifts(id),
  minute_start    timestamptz NOT NULL,
  tool_id         uuid NOT NULL REFERENCES argos_tools(id),
  company_id      uuid NOT NULL,
  user_id         uuid NOT NULL,
  focus_seconds   integer NOT NULL DEFAULT 0,
  active_seconds  integer NOT NULL DEFAULT 0,
  key_count       integer NOT NULL DEFAULT 0,
  click_count     integer NOT NULL DEFAULT 0,
  scroll_count    integer NOT NULL DEFAULT 0,
  received_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shift_id, minute_start, tool_id)
);
CREATE INDEX argos_activity_retention_idx ON argos_activity_minutes (company_id, minute_start);
CREATE INDEX argos_presence_retention_idx ON argos_presence_minutes (company_id, minute_start);

CREATE TABLE argos_incidents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES core_companies(id),
  user_id          uuid NOT NULL REFERENCES core_users(id),   -- persona afectada
  reported_by      uuid NOT NULL REFERENCES core_users(id),
  shift_id         uuid REFERENCES argos_shifts(id),
  line_id          uuid REFERENCES argos_lines(id),
  type             text NOT NULL CHECK (type IN ('conexion', 'linea', 'plataforma', 'ausencia', 'otro')),
  description      text NOT NULL,
  status           text NOT NULL DEFAULT 'abierta' CHECK (status IN ('abierta', 'en_curso', 'resuelta')),
  resolution_note  text NOT NULL DEFAULT '',
  resolved_by      uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  resolved_at      timestamptz
);
CREATE INDEX argos_incidents_company_idx ON argos_incidents (company_id, created_at DESC);
