CREATE UNIQUE INDEX IF NOT EXISTS submissions_short_id_idx
ON submissions ((request->>'short_id'))
WHERE request ? 'short_id';
