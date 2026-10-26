-- Correlate the browser pairing receipt to exactly the device created by exchange.
-- Nullable for outstanding pre-upgrade grants, which retain the legacy UUID fallback.
SET @needs_companion_pairing_device := (
  SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'companion_pairings'
    AND COLUMN_NAME = 'device_id'
);
SET @companion_pairing_device_ddl := IF(@needs_companion_pairing_device,
  'ALTER TABLE companion_pairings ADD COLUMN device_id CHAR(36) NULL',
  'DO 0');
PREPARE add_companion_pairing_device FROM @companion_pairing_device_ddl;
EXECUTE add_companion_pairing_device;
DEALLOCATE PREPARE add_companion_pairing_device;
