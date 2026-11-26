// Run inside the app container by deploy.sh, which recreates the container: exits 1 while a check may be running,
// so a deploy doesn't cut one off after its spend. The slowest real check took two minutes, so a check that started
// more than five minutes ago has ended, even if a crash left its model call marked open.
import { DatabaseSync } from "node:sqlite";

const WINDOW_MS = 5 * 60_000;
const db = new DatabaseSync(process.env.LEDGER_PATH, { readOnly: true });
const { recent } = db.prepare("SELECT COUNT(*) AS recent FROM checks WHERE created_at > ?").get(Date.now() - WINDOW_MS);
db.close();
if (recent > 0) {
  console.log(`Not deploying: ${recent === 1 ? "a check" : `${recent} checks`} started in the last 5 minutes. Deploy again in a few minutes.`);
  process.exit(1);
}
