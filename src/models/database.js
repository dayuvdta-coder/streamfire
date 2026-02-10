const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');

const dbPath = process.env.DB_PATH || './db/streamfire.db';

const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  try {
    fs.mkdirSync(dbDir, { recursive: true });
    logger.info(`Created database directory: ${dbDir}`);
  } catch (err) {
    logger.error(`Failed to create database directory: ${err.message}`);
  }
}

let db;

function connectWithRetry(attempts = 3, delay = 1000) {
  return new Promise((resolve, reject) => {
    function tryConnect(attempt) {
      db = new sqlite3.Database(dbPath, (err) => {
        if (err) {
          logger.error(`Database connection attempt ${attempt} failed: ${err.message}`);
          if (attempt < attempts) {
            setTimeout(() => tryConnect(attempt + 1), delay);
          } else {
            logger.error(`FATAL: Failed to connect to database after ${attempts} attempts.`);
            reject(new Error(`Failed to connect to database: ${err.message}`));
          }
        } else {
          logger.info(`Connected to SQLite database at ${dbPath}`);
          resolve(db);
        }
      });
    }
    tryConnect(1);
  });
}

const dbWrapper = {
  run: function (...args) {
    if (db) db.run(...args);
    else logger.error('Database not initialized yet (run)');
  },
  get: function (...args) {
    if (db) db.get(...args);
    else logger.error('Database not initialized yet (get)');
  },
  all: function (...args) {
    if (db) db.all(...args);
    else logger.error('Database not initialized yet (all)');
  },
  serialize: function (callback) {
    if (db) db.serialize(callback);
    else if (callback) callback();
  }
};

async function initializeDatabase() {
  try {
    await connectWithRetry();

    db.serialize(() => {
      db.run(`CREATE TABLE IF NOT EXISTS videos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            filename TEXT,
            title TEXT,
            thumbnail TEXT,
            views INTEGER DEFAULT 0,
            destinations TEXT,
            start_time TEXT DEFAULT NULL
        )`, (err) => {
        if (err) {
          logger.error(`Error creating videos table: ${err.message}`);
        } else {
          db.all("PRAGMA table_info(videos)", (err, rows) => {
            const hasStartTime = rows.some(r => r.name === 'start_time');
            if (!hasStartTime) {
              db.run("ALTER TABLE videos ADD COLUMN start_time TEXT DEFAULT NULL", (err) => {
                if (err) logger.error("Migration start_time failed: " + err.message);
                else logger.info("Migration: Added start_time column");
              });
            }

            const hasResolution = rows.some(r => r.name === 'resolution');
            if (!hasResolution) {
              const newCols = [
                "ALTER TABLE videos ADD COLUMN resolution TEXT DEFAULT '1280x720'",
                "ALTER TABLE videos ADD COLUMN fps TEXT DEFAULT '30'",
                "ALTER TABLE videos ADD COLUMN bitrate TEXT DEFAULT '2500k'",
                "ALTER TABLE videos ADD COLUMN loop BOOLEAN DEFAULT 0"
              ];
              newCols.forEach(sql => {
                db.run(sql, err => {
                  if (err) logger.error("Migration config failed: " + err.message);
                });
              });
            }
          });
          logger.info('Videos table check passed');
        }
      });

      db.run(`CREATE TABLE IF NOT EXISTS schedules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        video_id INTEGER,
        platforms TEXT,
        schedule_time TEXT,
        timezone TEXT,
        status TEXT DEFAULT 'pending',
        FOREIGN KEY(video_id) REFERENCES videos(id)
      )`);

      db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        avatar TEXT,
        language TEXT DEFAULT 'id',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )`, (err) => {
        if (err) logger.error(`Error creating users table: ${err.message}`);
        else {
          logger.info('Users table check passed');
          const columnsToAdd = ['avatar', 'language'];
          columnsToAdd.forEach(col => {
            db.run(`ALTER TABLE users ADD COLUMN ${col} TEXT`, (err) => {
            });
          });
        }
      });
    });

  } catch (err) {
    logger.error(`Database initialization failed: ${err.message}`);
  }
}

initializeDatabase();

module.exports = dbWrapper;