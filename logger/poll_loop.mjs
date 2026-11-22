// Local testing only: poll every 5 minutes (GitHub Actions does this in production).
// Usage: node logger/poll_loop.mjs   (Ctrl+C to stop)
import { runPoll } from './poll.mjs';
import { RULES } from './lib/rules.mjs';

async function tick() {
  try { await runPoll(); } catch (e) { console.error(`poll failed: ${e.stack || e}`); }
}
await tick();
setInterval(tick, RULES.pollSeconds * 1000);
