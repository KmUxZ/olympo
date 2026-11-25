-- Zeus queda en pausa para el público: solo lo conserva la empresa que opera la plataforma.
UPDATE core_companies SET products = products - 'zeus'
 WHERE products @> '["zeus"]'::jsonb AND id NOT IN (SELECT company_id FROM core_users WHERE is_platform_admin);
ALTER TABLE core_companies ALTER COLUMN products SET DEFAULT '["argos", "hermes", "athena"]';
