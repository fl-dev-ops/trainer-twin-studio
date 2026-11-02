// Local dev: run web, copilot, chat and the voice agent under pm2, each logging to logs/<name>.log.
//   pm2 start ecosystem.config.cjs     start all (or: pm2 start ecosystem.config.cjs --only web)
//   pm2 logs [name]                    follow logs live      pm2 monit    dashboard
//   pm2 restart <name> | pm2 stop all  pm2 delete all       pm2 flush    empty the log files
// Start pm2 from your own terminal (`pm2 kill` first if a daemon is already up) so the apps get your shell's env,
// e.g. NODE_EXTRA_CA_CERTS for portless.

const app = (name, cwd, script, args) => ({
  name,
  cwd: `${__dirname}/${cwd}`,
  script,
  args,
  interpreter: "none",
  // Dev servers reload themselves; a crash should stay visible in the log, not restart in a loop.
  autorestart: false,
  out_file: `${__dirname}/logs/${name}.log`,
  error_file: `${__dirname}/logs/${name}.log`,
  merge_logs: true,
  log_date_format: "YYYY-MM-DD HH:mm:ss",
  env: { FORCE_COLOR: "0" }, // plain text in the log files
});

module.exports = {
  apps: [
    app("web", "web", "bun", "run dev"), // :3000, behind portless (*.trainertwin.localhost)
    app("copilot", "copilot", "bun", "run dev -- --port 2001 --no-ui"),
    app("chat", "chat", "bun", "run dev -- --port 2000 --no-ui"),
    app("agent", "agent", "uv", "run src/agent.py dev"),
  ],
};
