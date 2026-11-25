-- La empresa que opera la plataforma tiene siempre todos los productos, incluidos los que están en pausa para el público.
UPDATE core_companies SET products = '["argos", "hermes", "zeus", "athena"]'::jsonb
 WHERE id IN (SELECT company_id FROM core_users WHERE is_platform_admin);
