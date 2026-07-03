-- Migration number: 0000 	 2026-07-03T16:00:00.000Z
CREATE TABLE IF NOT EXISTS credentials (
    username TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL
);
