// Forgot a password? Run on the server:
//   docker compose exec app node server/reset-password.js <username> "new-password"
import { listUsers, setUserPassword } from "./auth.js";

const [username, pw] = process.argv.slice(2);
const u = listUsers().find(x => x.username === String(username || "").toLowerCase());
if (!u || !pw || pw.length < 8) {
  console.error('Usage: node server/reset-password.js <username> "new password (8+ characters)"');
  console.error("Users: " + (listUsers().map(x => `${x.username} (${x.role})`).join(", ") || "none yet"));
  process.exit(1);
}
setUserPassword(u.id, pw);
console.log(`Password changed for ${u.username}. Their devices were signed out.`);
