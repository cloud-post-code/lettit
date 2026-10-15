-- Databases migrated before these were removed from the schema: the imported document, seed bookkeeping that
-- nothing read, and the alias table that only the import wrote (old house ids live in LEGACY_IDS).
drop table if exists board_legacy, seeded, agent_aliases;
