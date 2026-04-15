const path = require("path");
require("dotenv").config({
  path: path.resolve(__dirname, ".env"),
});

const baseEnv = {
  ...process.env,
  NODE_ENV: "production",
};

module.exports = {
  apps: [
    {
      name: "yua-engine",
      cwd: "/home/dmsal020813/projects/yua-backend",
      script: "dist/bootstrap.js",
      // Zero-downtime deploy: kill_timeout으로 graceful shutdown 대기
      kill_timeout: 5000,        // 기존 프로세스 종료 대기 5초
      listen_timeout: 10000,     // 새 프로세스 ready 대기 10초
      wait_ready: false,         // pm2 restart로도 빠르게 전환
      env: baseEnv
    },
    {
      name: "yua-title-worker",
      cwd: "/home/dmsal020813/projects/yua-backend",
      script: "dist/ai/activity/title-worker.js",
      env: baseEnv
    },
    {
      name: "yua-translator",
      cwd: "/home/dmsal020813/projects/yua-backend/src/ai/translator",
      script: "/home/dmsal020813/projects/yua-backend/src/ai/translator/.venv/bin/python",
      args: "-m uvicorn translator_service:app --host 127.0.0.1 --port 8088",
      env: baseEnv
    },
    {
      name: "yua-memory-decay",
      cwd: "/home/dmsal020813/projects/yua-backend",
      script: "dist/ai/memory/run-memory-decay.js",
      cron_restart: "0 3 * * *",
      autorestart: false,
      env: baseEnv
    },
    {
      name: "yua-memory-merge",
      cwd: "/home/dmsal020813/projects/yua-backend",
      script: "dist/ai/memory/run-memory-merge.js",
      cron_restart: "0 4 * * 0",
      autorestart: false,
      env: baseEnv
    },
    {
      // Phase F.4 — Data export fulfillment worker.
      // Polls `data_export_requests` for pending rows, dumps the user's
      // data to /mnt/yua/exports/{uid}/{id}.zip, flips the row to
      // `ready`, and emails a JWT-gated magic link. One instance is
      // enough — worker claims rows with FOR UPDATE SKIP LOCKED.
      name: "yua-export-worker",
      cwd: "/home/dmsal020813/projects/yua-backend",
      script: "dist/workers/export-worker.js",
      autorestart: true,
      // 512M budget: 500MB hard cap on bundle + ~12MB Node overhead.
      // JSZip buffers the whole zip in RAM before writing (see
      // buildExportBundle), so if a future user hits the MAX_TOTAL_BYTES
      // cap, PM2 will restart cleanly without taking down other apps.
      max_memory_restart: "512M",
      env: baseEnv
    },
    {
      name: "yua-web",
      cwd: "/home/dmsal020813/projects/yua-web",
      script: "node_modules/next/dist/bin/next",
      args: "start -H 127.0.0.1 -p 3000",
      env: { ...baseEnv, NEXT_DISABLE_SWC_PATCH: "1" }
    }
  ]
};
