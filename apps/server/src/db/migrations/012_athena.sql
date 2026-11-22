-- Athena: vendedora IA. Atiende al cliente con el catálogo y las reglas de la empresa, toma los datos,
-- crea el pedido en Hermes y pasa la conversación a una persona cuando no sabe o el cliente lo pide.

CREATE TABLE athena_settings (
  company_id       uuid PRIMARY KEY REFERENCES core_companies(id),
  enabled          boolean NOT NULL DEFAULT false,        -- responde en el canal real (las pruebas siempre responden)
  driver           text NOT NULL DEFAULT 'simulado' CHECK (driver IN ('simulado', 'pancake')),
  assistant_name   text NOT NULL DEFAULT 'Athena',
  business_about   text NOT NULL DEFAULT '',              -- qué vende la empresa y cómo se presenta
  tone             text NOT NULL DEFAULT '',              -- cómo debe hablar
  shipping_policy  text NOT NULL DEFAULT '',
  payment_policy   text NOT NULL DEFAULT '',
  extra_rules      text NOT NULL DEFAULT '',              -- qué no debe prometer, cuándo pasar a una persona, etc.
  model            text NOT NULL DEFAULT 'claude-opus-5-5',
  create_orders    boolean NOT NULL DEFAULT true          -- puede crear el pedido en Hermes sin que una persona lo revise
);

CREATE TABLE athena_products (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES core_companies(id),
  name         text NOT NULL,
  description  text NOT NULL DEFAULT '',
  price        integer NOT NULL DEFAULT 0,
  offers       text NOT NULL DEFAULT '',                  -- combos y precios por cantidad, en texto
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX athena_products_company ON athena_products (company_id);

CREATE TABLE athena_knowledge (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES core_companies(id),
  question     text NOT NULL,
  answer       text NOT NULL,
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX athena_knowledge_company ON athena_knowledge (company_id);

CREATE TABLE athena_conversations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES core_companies(id),
  phone           text NOT NULL,
  customer_name   text NOT NULL DEFAULT '',
  is_test         boolean NOT NULL DEFAULT false,         -- conversación de prueba hecha desde la plataforma
  -- 'bot': responde Athena. 'humano': la lleva una persona. 'cerrada': terminada.
  status          text NOT NULL DEFAULT 'bot' CHECK (status IN ('bot', 'humano', 'cerrada')),
  attention       boolean NOT NULL DEFAULT false,         -- espera a una persona
  handoff_reason  text NOT NULL DEFAULT '',
  taken_by        text NOT NULL DEFAULT '',
  draft           jsonb NOT NULL DEFAULT '{}',            -- datos del pedido que Athena va reuniendo
  order_id        uuid,
  order_code      text NOT NULL DEFAULT '',
  last_message_at timestamptz NOT NULL DEFAULT now(),
  seen_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX athena_conversations_company ON athena_conversations (company_id, last_message_at DESC);

CREATE TABLE athena_messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES core_companies(id),
  conversation_id  uuid NOT NULL REFERENCES athena_conversations(id),
  -- cliente | athena | persona | sistema (hitos: pedido creado, pasó a una persona…)
  role             text NOT NULL CHECK (role IN ('cliente', 'athena', 'persona', 'sistema')),
  body             text NOT NULL,
  sender           text NOT NULL DEFAULT '',
  -- 'ia' o 'guion' en las respuestas de Athena; estado del envío en las salientes
  meta             jsonb NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX athena_messages_conversation ON athena_messages (conversation_id, created_at);

-- Las empresas existentes reciben Athena, igual que pasó con Hermes.
UPDATE core_companies SET products = products || '["athena"]'::jsonb WHERE NOT (products @> '["athena"]'::jsonb);
ALTER TABLE core_companies ALTER COLUMN products SET DEFAULT '["argos", "hermes", "athena"]';
