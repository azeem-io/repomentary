/**
 * Database row types for the (not yet wired up) ingestion tables.
 * Will be regenerated with `supabase gen types typescript` once a
 * database instance is actually reachable.
 */
export type JobStatus =
  | "queued"
  | "cloning"
  | "extracting"
  | "encoding"
  | "uploading"
  | "done"
  | "failed";

export interface Database {
  public: {
    Tables: {
      repos: {
        Row: {
          id: string;
          owner: string;
          name: string;
          default_branch: string | null;
          head_sha: string | null;
          commit_count: number | null;
          artifact_key: string | null;
          last_ingested_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          owner: string;
          name: string;
          default_branch?: string | null;
          head_sha?: string | null;
          commit_count?: number | null;
          artifact_key?: string | null;
          last_ingested_at?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          owner?: string;
          name?: string;
          default_branch?: string | null;
          head_sha?: string | null;
          commit_count?: number | null;
          artifact_key?: string | null;
          last_ingested_at?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      ingest_jobs: {
        Row: {
          id: string;
          repo_id: string;
          status: JobStatus;
          error: string | null;
          requester_hash: string | null;
          timings: Record<string, number> | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          repo_id: string;
          status?: JobStatus;
          error?: string | null;
          requester_hash?: string | null;
          timings?: Record<string, number> | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          repo_id?: string;
          status?: JobStatus;
          error?: string | null;
          requester_hash?: string | null;
          timings?: Record<string, number> | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "ingest_jobs_repo_id_fkey";
            columns: ["repo_id"];
            referencedRelation: "repos";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: {
      job_status: JobStatus;
    };
  };
}
