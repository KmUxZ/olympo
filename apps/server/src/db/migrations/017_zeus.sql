-- Zeus · CRM de clientes y recompra.
-- La ficha del cliente se calcula a partir de los pedidos de Hermes (un cliente = un teléfono).
-- Aquí solo se guarda lo que las personas añaden: etiquetas, notas, seguimientos y los ajustes.
CREATE TABLE zeus_settings (
  company_id      uuid PRIMARY KEY REFERENCES core_companies(id),
  repurchase_days integer NOT NULL DEFAULT 30   -- días desde la última entrega para proponer una recompra
);

CREATE TABLE zeus_profiles (
  company_id  uuid NOT NULL REFERENCES core_companies(id),
  phone       text NOT NULL,                    -- solo dígitos, con indicativo (igual que en Hermes)
  tags        jsonb NOT NULL DEFAULT '[]',
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, phone)
);

CREATE TABLE zeus_notes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES core_companies(id),
  phone        text NOT NULL,
  body         text NOT NULL,
  author_id    uuid REFERENCES core_users(id),
  author_name  text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX zeus_notes_phone_idx ON zeus_notes (company_id, phone, created_at DESC);

-- Seguimiento: algo que una persona debe hacer con un cliente (volver a ofrecerle, llamarlo, etc.).
CREATE TABLE zeus_followups (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES core_companies(id),
  phone             text NOT NULL,
  customer_name     text NOT NULL DEFAULT '',
  title             text NOT NULL,
  due_on            text NOT NULL,              -- 'AAAA-MM-DD' en la zona horaria de la empresa
  assigned_user_id  uuid REFERENCES core_users(id),
  status            text NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente', 'hecho', 'descartado')),
  outcome           text NOT NULL DEFAULT '' CHECK (outcome IN ('', 'compro', 'interesado', 'no_interesado', 'no_contesta')),
  result            text NOT NULL DEFAULT '',   -- qué pasó, en palabras de quien lo gestionó
  created_by        uuid REFERENCES core_users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  done_at           timestamptz
);
CREATE INDEX zeus_followups_pending_idx ON zeus_followups (company_id, status, due_on);
CREATE INDEX zeus_followups_phone_idx ON zeus_followups (company_id, phone);

-- Zeus trabaja sobre los pedidos de Hermes: lo reciben las empresas que ya tienen Hermes.
UPDATE core_companies SET products = products || '["zeus"]'::jsonb WHERE products @> '["hermes"]'::jsonb AND NOT (products @> '["zeus"]'::jsonb);
ALTER TABLE core_companies ALTER COLUMN products SET DEFAULT '["argos", "hermes", "athena", "zeus"]';
