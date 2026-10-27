-- GitHub Copilot bills premium requests (prompts x a per-model multiplier), not tokens.
-- Both stay NULL for providers priced by tokens.
ALTER TABLE usage_records ADD COLUMN premium_requests numeric(12, 3);
ALTER TABLE usage_records ADD COLUMN premium_multiplier numeric(8, 3);
