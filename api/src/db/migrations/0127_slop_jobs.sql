-- Slop jobs (docs/interface-api.md#slop-jobs): project-bound UI/UX review jobs.
-- An agent uploads files into a job; every upload of an existing path adds a
-- revision. A run pins a snapshot (path -> revision) and keeps its result
-- forever, until the job is closed or idles out (24 h), which hard-deletes the
-- job, its revisions, runs and unreferenced blobs. Blob bytes live on disk under
-- DATA_ROOT/slop/blobs, addressed by sha256.
-- Idempotent: CREATE TABLE IF NOT EXISTS.
CREATE TABLE IF NOT EXISTS slop_jobs (
 id char(36) NOT NULL,
 project_id bigint unsigned NOT NULL,
 title varchar(160) NOT NULL,
 description mediumtext NULL,
 description_rev int unsigned NOT NULL DEFAULT 0,
 status varchar(16) NOT NULL DEFAULT 'open',
 created_by varchar(80) NOT NULL,
 created_host_id int unsigned NULL,
 run_count int unsigned NOT NULL DEFAULT 0,
 created_at varchar(100) NOT NULL,
 updated_at varchar(100) NOT NULL,
 last_activity_at varchar(100) NOT NULL,
 PRIMARY KEY (id),
 KEY idx_slop_jobs_project (project_id, updated_at),
 KEY idx_slop_jobs_activity (last_activity_at)
);

CREATE TABLE IF NOT EXISTS slop_job_files (
 id bigint unsigned NOT NULL AUTO_INCREMENT,
 job_id char(36) NOT NULL,
 path varchar(512) NOT NULL,
 rev int unsigned NOT NULL,
 kind varchar(16) NOT NULL,
 sha256 char(64) NULL,
 size_bytes int unsigned NOT NULL DEFAULT 0,
 created_by varchar(80) NOT NULL,
 created_at varchar(100) NOT NULL,
 PRIMARY KEY (id),
 UNIQUE KEY uq_slop_job_files_rev (job_id, path, rev),
 KEY idx_slop_job_files_sha (sha256)
);

CREATE TABLE IF NOT EXISTS slop_runs (
 id char(36) NOT NULL,
 job_id char(36) NOT NULL,
 seq int unsigned NOT NULL,
 client_key varchar(120) NOT NULL,
 mode varchar(8) NOT NULL,
 status varchar(16) NOT NULL,
 snapshot_json mediumtext NOT NULL,
 description_rev int unsigned NOT NULL DEFAULT 0,
 slop_version varchar(32) NULL,
 guidelines_sha256 char(64) NULL,
 exit_code int NULL,
 scan_json mediumtext NULL,
 report_json mediumtext NULL,
 verdict_json mediumtext NULL,
 advisor_session_id char(36) NULL,
 advisor_caller_id char(36) NULL,
 advisor_engine varchar(16) NULL,
 advisor_model varchar(128) NULL,
 advisor_reply_enc mediumtext NULL,
 advisor_reply_status varchar(32) NULL,
 error varchar(2000) NULL,
 created_by varchar(80) NOT NULL,
 created_at varchar(100) NOT NULL,
 updated_at varchar(100) NOT NULL,
 completed_at varchar(100) NULL,
 PRIMARY KEY (id),
 UNIQUE KEY uq_slop_runs_client (client_key),
 UNIQUE KEY uq_slop_runs_seq (job_id, seq),
 KEY idx_slop_runs_status (status)
);
