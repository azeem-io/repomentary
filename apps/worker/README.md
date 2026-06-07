# @repomentary/worker

Placeholder for the ingestion worker. When it lands it will:

1. Poll the `ingest` pgmq queue (Supabase Postgres).
2. `git clone --bare --filter=blob:none` the requested repo.
3. Extract history with `git log --raw --no-renames` (never `--numstat`, which
   lazily downloads blobs and defeats the partial clone).
4. Encode the versioned artifact (`@repomentary/artifact`) and upload it to R2.
5. Update job status rows in Postgres along the way.

Runs on a small always-on VPS next to the database. If it ever needs to
scale, the same container image can move to Cloudflare Containers or Fly
Machines.
