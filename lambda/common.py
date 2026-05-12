import sqlite3
import os
import os.path
import time
import urllib.parse
from yt_dlp import YoutubeDL

DB_FILE = os.path.join(os.path.dirname(__file__), "youtube_cache.sqlite")

def get_db_connection():
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.executescript("""
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

        CREATE TABLE IF NOT EXISTS playback_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          video_id TEXT NOT NULL,
          title TEXT,
          stream_url TEXT,
          status TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ph_updated_at ON playback_history(updated_at DESC);
    """)
    try:
        cursor.execute("ALTER TABLE video_stream ADD COLUMN query TEXT;")
    except sqlite3.OperationalError:
        pass
    try:
        cursor.execute("ALTER TABLE video_stream ADD COLUMN tag TEXT;")
    except sqlite3.OperationalError:
        pass
    conn.commit()
    conn.close()
    print("SQLite initialized")

def extract_expiry(stream_url):
    try:
        parsed_url = urllib.parse.urlparse(stream_url)
        query_params = urllib.parse.parse_qs(parsed_url.query)
        expire = query_params.get("expire", [None])[0]
        if not expire:
            return int(time.time() * 1000) + 3600000
        return int(expire) * 1000
    except Exception:
        return int(time.time() * 1000) + 3600000

def get_valid_stream(video_id):
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT *
        FROM video_stream
        WHERE
          video_id = ?
          AND stream_url IS NOT NULL
          AND expires_at > ?
        LIMIT 1
    """, (video_id, int(time.time() * 1000)))
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else None

def get_stream(video_id):
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT *
        FROM video_stream
        WHERE video_id = ?
        LIMIT 1
    """, (video_id,))
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else None

def get_latest_video():
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT *
        FROM video_stream
        ORDER BY updated_at DESC
        LIMIT 1
    """)
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else None

def insert_playback_history(video_id):
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("""
        UPDATE video_stream
        SET last_played_at = ?
        WHERE video_id = ?
    """, (int(time.time() * 1000), video_id))
    conn.commit()
    conn.close()

def increment_play_count(video_id):
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("""
        UPDATE video_stream
        SET play_count = play_count + 1,
            updated_at = ?
        WHERE video_id = ?
    """, (int(time.time() * 1000), video_id))
    conn.commit()
    conn.close()

def insert_playback_history_record(video_id, title, status="FETCHING", stream_url=None):
    now = int(time.time() * 1000)
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO playback_history (video_id, title, stream_url, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
    """, (video_id, title, stream_url, status, now, now))
    conn.commit()
    conn.close()

def update_playback_history_status(video_id, status, stream_url=None):
    now = int(time.time() * 1000)
    conn = get_db_connection()
    cursor = conn.cursor()
    if stream_url:
        cursor.execute("""
            UPDATE playback_history
            SET status = ?, stream_url = ?, updated_at = ?
            WHERE video_id = ?
        """, (status, stream_url, now, video_id))
    else:
        cursor.execute("""
            UPDATE playback_history
            SET status = ?, updated_at = ?
            WHERE video_id = ?
        """, (status, now, video_id))
    conn.commit()
    conn.close()

def get_latest_playback_history():
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT *
        FROM playback_history
        ORDER BY updated_at DESC
        LIMIT 1
    """)
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else None

def upsert_video(video_id, title, channel_title, thumbnail, query=None, tag=None):
    now = int(time.time() * 1000)
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO video_stream (
          video_id, title, channel_title, thumbnail, query, tag, created_at, updated_at
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
    """, (video_id, title, channel_title, thumbnail, query, tag, now, now))
    conn.commit()
    conn.close()

def mark_stream_loading(video_id):
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("""
        UPDATE video_stream
        SET stream_status = 'FETCHING',
            updated_at = ?
        WHERE video_id = ?
    """, (int(time.time() * 1000), video_id))
    conn.commit()
    conn.close()

def upsert_stream_cache(video_id, stream_url, mime_type=None, bitrate=None, expires_at=None):
    now = int(time.time() * 1000)
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO video_stream (
          video_id, stream_url, mime_type, bitrate, expires_at, refreshed_at, stream_status, created_at, updated_at
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
    """, (video_id, stream_url, mime_type, bitrate, expires_at, now, now, now))
    conn.commit()
    conn.close()
    return {"success": True, "refreshed_at": now}

def get_audio_url(video_id):
    cached = get_valid_stream(video_id)
    if cached:
        print("[CACHE HIT]", video_id)
        return cached["stream_url"]

    print("[CACHE MISS]", video_id)
    youtube_url = f"https://youtube.com/watch?v={video_id}"
    # 1. Properly expand the tilde path for the cookies
    cookie_path = os.path.expanduser('~/Downloads/cookies.txt')

    # ydl_opts = {
    #     'format': 'bestaudio/best',
    #     # 'cookiefile': cookie_path,
    #     'noplaylist': True,
    #     'quiet': True,
    #     'extractor_args': {'youtube': {'player_client': ['default']}},
    #     'cachedir': os.path.join(os.path.dirname(__file__), 'yt-dlp-cache'),
    # }
    # with YoutubeDL(ydl_opts) as ydl:
    #     info_dict = ydl.extract_info(youtube_url, download=False)
    #     stream_url = info_dict.get('url', None)
    #     if not stream_url:
    #         raise Exception("No stream URL returned")

    stream_url = get_youtube_url(video_id)
         
    expires_at = extract_expiry(stream_url)
    upsert_stream_cache(
        video_id=video_id,
        stream_url=stream_url,
        mime_type="audio/webm",
        bitrate=None,
        expires_at=expires_at
    )
    update_playback_history_status(video_id, 'LOADED', stream_url)
    return stream_url


def get_youtube_url(video_url):
    # This dictionary replicates your CLI flags:
    # -g is download=False
    # --extractor-args "youtube:player_client=default"
    ydl_opts = {
        'quiet': False,  # Set to True to mimic -g (only print URL)
        'format': 'bestaudio/best',
        'extractor_args': {
            'youtube': {
                'player_client': ['default']
            }
        },
    }

    try:
        with YoutubeDL(ydl_opts) as ydl:
            # extract_info with download=False is equivalent to -g (get-url)
            info_dict = ydl.extract_info(video_url, download=False)
            
            # The URL output from -g is stored in 'url'
            print(f"\nDirect Stream URL:\n{info_dict.get('url')}")
            return info_dict.get('url')
            
    except Exception as e:
        print(f"An error occurred: {e}")
