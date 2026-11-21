-- Integración con Pancake: métricas de atención verificables, obtenidas de la plataforma (no del teclado).

-- Cada línea de Argos puede conectarse a una página de Pancake.
CREATE TABLE argos_line_connections (
  line_id           uuid PRIMARY KEY REFERENCES argos_lines(id),
  company_id        uuid NOT NULL REFERENCES core_companies(id),
  provider          text NOT NULL DEFAULT 'pancake',
  external_page_id  text NOT NULL,
  secret_enc        text NOT NULL,              -- token de la página, cifrado (AES-256-GCM)
  status            text NOT NULL DEFAULT 'ok', -- ok | error
  last_sync_at      timestamptz,
  last_error        text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- Usuarios de la plataforma externa y a qué cuenta de Argos corresponde cada uno.
CREATE TABLE argos_external_staff (
  company_id    uuid NOT NULL REFERENCES core_companies(id),
  provider      text NOT NULL,
  external_id   text NOT NULL,
  name          text NOT NULL,
  user_id       uuid REFERENCES core_users(id),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, provider, external_id)
);

-- Estadísticas por hora, línea y usuario externo, tal como las entrega la plataforma.
CREATE TABLE argos_channel_hours (
  line_id             uuid NOT NULL REFERENCES argos_lines(id),
  external_id         text NOT NULL,
  hour_start          timestamptz NOT NULL,
  company_id          uuid NOT NULL,
  provider            text NOT NULL,
  inbox_count         integer NOT NULL DEFAULT 0,  -- mensajes de bandeja atendidos
  unique_inbox_count  integer NOT NULL DEFAULT 0,  -- conversaciones distintas atendidas en esa hora
  comment_count       integer NOT NULL DEFAULT 0,
  phone_number_count  integer NOT NULL DEFAULT 0,
  avg_response_ms     integer NOT NULL DEFAULT 0,
  fetched_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (line_id, external_id, hour_start)
);
CREATE INDEX argos_channel_hours_company_idx ON argos_channel_hours (company_id, hour_start);
