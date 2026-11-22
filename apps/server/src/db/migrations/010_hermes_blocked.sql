-- Clientes bloqueados: números a los que la empresa decidió no despacharles más (p. ej. rechazos repetidos).
CREATE TABLE hermes_blocked (
  company_id  uuid NOT NULL REFERENCES core_companies(id),
  phone       text NOT NULL,          -- solo dígitos, con indicativo
  name        text NOT NULL DEFAULT '',
  reason      text NOT NULL,
  created_by  uuid REFERENCES core_users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, phone)
);
