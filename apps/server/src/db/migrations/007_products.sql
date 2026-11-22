-- Productos del ecosistema que tiene contratados cada empresa. Se venden por separado.
ALTER TABLE core_companies ADD COLUMN products jsonb NOT NULL DEFAULT '["argos", "hermes"]';
