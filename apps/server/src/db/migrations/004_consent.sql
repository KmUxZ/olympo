-- Consentimiento informado: constancia de que cada persona leyó y aceptó qué registra la extensión.
-- Se guarda una fila por aceptación; si el aviso cambia de versión, hay que aceptarlo de nuevo.
CREATE TABLE argos_consents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES core_companies(id),
  user_id      uuid NOT NULL REFERENCES core_users(id),
  version      text NOT NULL,
  accepted_at  timestamptz NOT NULL DEFAULT now(),
  client       text NOT NULL,
  ip           text,
  user_agent   text,
  UNIQUE (user_id, version)
);
