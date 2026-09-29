-- Retire the `spark` quota lane preference.
--
-- gpt-5.3-codex-spark left the Codex catalog (codex-cli 0.158.0), is rejected by
-- a live call ("not supported when using Codex with a ChatGPT account") and the
-- ChatGPT usage endpoint no longer reports its rate-limit bucket. A host pinned
-- to `spark` would launch a model that fails, so clear it back to inherit: NULL
-- keeps whatever fleet or per-host model override applies, where `normal` would
-- pin gpt-6-astra over it. Re-running only touches rows still on `spark`.
UPDATE hosts SET lane_preference = NULL WHERE lane_preference = 'spark';
