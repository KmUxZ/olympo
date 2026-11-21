-- Nivel de plataforma: quien opera OLYMPO gestiona las empresas cliente sin ver sus datos operativos.

ALTER TABLE core_users ADD COLUMN is_platform_admin boolean NOT NULL DEFAULT false;

ALTER TABLE core_companies ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended'));
ALTER TABLE core_companies ADD COLUMN suspended_reason text NOT NULL DEFAULT '';
-- Límites del plan contratado, p. ej. {"maxSellers": 10, "maxLines": 5}. Sin clave = sin límite.
ALTER TABLE core_companies ADD COLUMN plan_limits jsonb NOT NULL DEFAULT '{}';
-- Acceso de soporte: lo concede el administrador de la empresa, por tiempo limitado.
ALTER TABLE core_companies ADD COLUMN support_access_until timestamptz;

-- Sesión de plataforma que está operando dentro de una empresa cliente (modo soporte).
ALTER TABLE core_sessions ADD COLUMN support_company_id uuid REFERENCES core_companies(id);
