import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";

const DB_FILE = join(import.meta.dirname, "youtube_cache.sqlite");

export const db = new DatabaseSync(DB_FILE);

export function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS video_stream (
      video_id TEXT PRIMARY KEY,
      title TEXT,
      channel_title TEXT,
      thumbnail TEXT,
      query TEXT,
      tag TEXT,
      duration_seconds INTEGER,
      stream_url TEXT,
      mime_type TEXT,
      bitrate INTEGER,
      expires_at INTEGER,
      refreshed_at INTEGER,
      stream_status TEXT DEFAULT 'PENDING',
      favorite_rating REAL DEFAULT 0,
      play_count INTEGER DEFAULT 0,
      last_played_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_vs_play_count ON video_stream(play_count DESC);
    CREATE INDEX IF NOT EXISTS idx_vs_rating ON video_stream(favorite_rating DESC);
    CREATE INDEX IF NOT EXISTS idx_vs_expires ON video_stream(expires_at);
    CREATE INDEX IF NOT EXISTS idx_vs_played ON video_stream(last_played_at DESC);

    CREATE VIEW IF NOT EXISTS video_stream_with_status AS 
    SELECT *, 
           CASE 
             WHEN expires_at < CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) THEN 'EXPIRED'
             ELSE stream_status 
           END AS computed_status
    FROM video_stream;
  `);

  try { db.exec(`ALTER TABLE video_stream ADD COLUMN query TEXT;`); } catch (e) { }
  try { db.exec(`ALTER TABLE video_stream ADD COLUMN tag TEXT;`); } catch (e) { }

  console.log("SQLite initialized");
}

export function extractExpiry(streamUrl) {
  try {
    const url = new URL(streamUrl);

    const expire =
      url.searchParams.get("expire");

    if (!expire) {
      return Date.now() + 3600_000;
    }

    return Number(expire) * 1000;
  } catch {
    return Date.now() + 3600_000;
  }
}

export function getValidStream(videoId) {
  const stmt = db.prepare(`
    SELECT *
    FROM video_stream
    WHERE
      video_id = ?
      AND stream_url IS NOT NULL
      AND expires_at > ?
    LIMIT 1
  `);

  return stmt.get(videoId, Date.now());
}

export function getStream(videoId) {
  const stmt = db.prepare(`
    SELECT *
    FROM video_stream
    WHERE video_id = ?
    LIMIT 1
  `);
  return stmt.get(videoId);
}

export function getLatestVideo() {
  const stmt = db.prepare(`
    SELECT *
    FROM video_stream
    ORDER BY updated_at DESC
    LIMIT 1
  `);
  return stmt.get();
}

export function insertPlaybackHistory(
  videoId
) {
  const stmt = db.prepare(`
    UPDATE video_stream
    SET last_played_at = ?
    WHERE video_id = ?
  `);

  stmt.run(Date.now(), videoId);
}

export function incrementPlayCount(
  videoId
) {
  const stmt = db.prepare(`
    UPDATE video_stream
    SET play_count = play_count + 1,
        updated_at = ?
    WHERE video_id = ?
  `);

  stmt.run(Date.now(), videoId);
}

export function upsertVideo({
  video_id,
  title,
  channel_title,
  thumbnail,
  query = null,
  tag = null,
}) {
  const now = Date.now();

  const stmt = db.prepare(`
    INSERT INTO video_stream (
      video_id,
      title,
      channel_title,
      thumbnail,
      query,
      tag,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)

    ON CONFLICT(video_id)
    DO UPDATE SET
      title = excluded.title,
      channel_title = excluded.channel_title,
      thumbnail = excluded.thumbnail,
      query = COALESCE(excluded.query, video_stream.query),
      tag = COALESCE(excluded.tag, video_stream.tag),
      updated_at = excluded.updated_at
  `);

  stmt.run(
    video_id,
    title,
    channel_title,
    thumbnail,
    query,
    tag,
    now,
    now
  );
}

export function markStreamLoading(videoId) {
  const stmt = db.prepare(`
    UPDATE video_stream
    SET stream_status = 'FETCHING',
        updated_at = ?
    WHERE video_id = ?
  `);

  stmt.run(Date.now(), videoId);
}

export function upsertStreamCache({
  video_id,
  stream_url,
  mime_type = null,
  bitrate = null,
  expires_at,
}) {
  const now = Date.now();
  console.log("updating upsert stream cache : ", video_id, stream_url, expires_at);

  const stmt = db.prepare(`
    INSERT INTO video_stream (
      video_id,
      stream_url,
      mime_type,
      bitrate,
      expires_at,
      refreshed_at,
      stream_status,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, 'LOADED', ?, ?)

    ON CONFLICT(video_id)
    DO UPDATE SET
      stream_url = excluded.stream_url,
      mime_type = excluded.mime_type,
      bitrate = excluded.bitrate,
      expires_at = excluded.expires_at,
      refreshed_at = excluded.refreshed_at,
      stream_status = 'LOADED',
      updated_at = excluded.updated_at
  `);

  stmt.run(
    video_id,
    stream_url,
    mime_type,
    bitrate,
    expires_at,
    now,
    now,
    now
  );

  return {
    success: true,
    refreshed_at: now,
  };
}

export async function getAudioUrl(
  videoId
) {
  // CACHE HIT
  const cached =
    getValidStream(videoId);

  if (cached) {
    console.log(
      "[CACHE HIT]",
      videoId
    );
    return cached.stream_url;
  }

  console.log(
    "[CACHE MISS]",
    videoId
  );

  // yt-dlp extraction
  const streamUrl =
    await new Promise(
      (resolve, reject) => {
        const youtubeUrl =
          `https://youtube.com/watch?v=${videoId}`;

        const ytDlp = spawn(
          "/usr/local/bin/yt-dlp",
          [
            "-g",

            "--cache-dir",
            "./lambda/yt-dlp-cache",

            "--extractor-args",
            "youtube:player_client=android",

            "-f",
            "worst[acodec!=none]/worst",

            "--no-playlist",

            youtubeUrl,
          ]
        );

        let output = "";
        let error = "";

        ytDlp.stdout.on(
          "data",
          (d) => {
            output += d.toString();
          }
        );

        ytDlp.stderr.on(
          "data",
          (d) => {
            error += d.toString();
          }
        );

        ytDlp.on(
          "error",
          reject
        );

        ytDlp.on(
          "close",
          (code) => {
            if (code !== 0) {
              return reject(
                new Error(
                  error ||
                  `yt-dlp exited ${code}`
                )
              );
            }

            const url = output
              .trim()
              .split("\n")[0];

            if (!url) {
              return reject(
                new Error(
                  "No stream URL returned"
                )
              );
            }

            resolve(url);
          }
        );
      }
    );

  const expiresAt =
    extractExpiry(streamUrl);

  upsertStreamCache({
    video_id: videoId,
    stream_url: streamUrl,
    mime_type: "audio/webm",
    bitrate: null,
    expires_at: expiresAt,
  });

  return streamUrl;
}