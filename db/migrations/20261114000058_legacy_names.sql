-- migrate:up
-- Kept so the migration numbers match every database (14.11.2026). On the database this project ran
-- on before publishing, this step gave the archive of an earlier outreach tool neutral names
-- (legacy_*). The migrations in this repo create those names directly, so here there is nothing to do.
select 1;

-- migrate:down
select 1;
