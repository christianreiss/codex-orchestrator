-- Slop job paths are case-sensitive repository paths: src/Hero.html and
-- src/hero.html are different files. 0127 inherited the database default
-- collation (utf8mb4_0900_ai_ci), so uq_slop_job_files_rev made the second
-- spelling collide with the first. Compare paths byte-exactly instead.
SET @slop_path_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='slop_job_files' AND COLUMN_NAME='path'
    AND COLLATION_NAME='utf8mb4_bin')=0,
  'ALTER TABLE slop_job_files MODIFY COLUMN path VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL',
  'SELECT 1');
PREPARE slop_path_stmt FROM @slop_path_ddl;
EXECUTE slop_path_stmt;
DEALLOCATE PREPARE slop_path_stmt;
