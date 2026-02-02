/**
 * PM2 进程配置
 * 启动: pnpm pm2:start 或 pm2 start ecosystem.config.cjs
 */

module.exports = {
  apps: [
    {
      name: 'feishu-bot',
      script: 'server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'development',
      },
      env_production: {
        NODE_ENV: 'production',
      },
      max_memory_restart: '200M',
      error_file: './logs/err.log',
      out_file: './logs/out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
