-- Retire the reserved `cxx remote` fleet switch. The command family was never
-- implemented and has been removed; nothing reads this key any more.
DELETE FROM versions WHERE name = 'remote_exec_enabled';
