ALTER TABLE events ADD COLUMN IF NOT EXISTS search_text String MATERIALIZED lowerUTF8(concat(description,' ',actor_name,' ',tenant_name,' ',arrayStringConcat(target_names,' '))) CODEC(ZSTD(3));
ALTER TABLE events ADD COLUMN IF NOT EXISTS attribute_items Array(String) ALIAS arrayMap((k,v) -> concat(toString(length(k)),':',k,v),mapKeys(attributes),mapValues(attributes));
ALTER TABLE events ADD INDEX IF NOT EXISTS idx_search_text search_text TYPE text(tokenizer = splitByNonAlpha);
ALTER TABLE events ADD INDEX IF NOT EXISTS idx_attribute_items attribute_items TYPE text(tokenizer = array);
ALTER TABLE events MATERIALIZE INDEX idx_search_text;
ALTER TABLE events MATERIALIZE INDEX idx_attribute_items;
