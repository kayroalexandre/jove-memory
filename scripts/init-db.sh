#!/bin/sh
# Database initialization. Runs once, on first start of an empty volume.
#
# Creates one database per workspace plus the _shared database that holds
# entity edges crossing workspace boundaries. Everything is created from a
# template database so every workspace has identical schema.

set -e

SUPERUSER="${POSTGRES_USER:-paradigm}"

echo "creating template database"
psql -v ON_ERROR_STOP=1 --username "$SUPERUSER" --dbname postgres <<-EOSQL
	CREATE DATABASE paradigm_template;
EOSQL

# Extensions live in the template, so each workspace database inherits them.
echo "installing extensions into template"
psql -v ON_ERROR_STOP=1 --username "$SUPERUSER" --dbname paradigm_template <<-EOSQL
	CREATE EXTENSION IF NOT EXISTS vector;
	CREATE EXTENSION IF NOT EXISTS pg_trgm;

	-- pg_search (ParadeDB) provides true BM25. It is not available in every
	-- base image; when it is missing the application detects its absence and
	-- falls back to tsvector + GIN. See docs/ARCHITECTURE.md.
	DO \$\$
	BEGIN
		CREATE EXTENSION IF NOT EXISTS pg_search;
		RAISE NOTICE 'pg_search installed — BM25 available';
	EXCEPTION WHEN OTHERS THEN
		RAISE WARNING 'pg_search unavailable, falling back to tsvector+GIN: %', SQLERRM;
	END
	\$\$;
EOSQL

echo "creating workspace databases"
for WS in main _shared; do
	psql -v ON_ERROR_STOP=1 --username "$SUPERUSER" --dbname postgres <<-EOSQL
		CREATE DATABASE "${WS}" TEMPLATE paradigm_template;
EOSQL
done

echo "creating MinIO bucket"
# Deferred to the application on first S3 use, so the bucket name stays in
# application config rather than here.
echo "initialization complete"
