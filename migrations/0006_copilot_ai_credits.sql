-- GitHub Copilot moved from premium requests to AI Credits (tokens at per-model rates, 1 credit =
-- USD 0.01), so Copilot turns record credits instead. NULL for providers billed in money directly.
ALTER TABLE usage_records DROP COLUMN premium_requests;
ALTER TABLE usage_records DROP COLUMN premium_multiplier;
ALTER TABLE usage_records ADD COLUMN credits numeric(14, 3);
