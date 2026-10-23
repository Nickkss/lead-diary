// Forgot your password? Run on the server:
//   docker compose exec app node server/reset-password.js "new-password"
import { setPassword } from "./auth.js";

const pw = process.argv[2];
if (!pw || pw.length < 8) { console.error("Usage: node server/reset-password.js \"new password (8+ characters)\""); process.exit(1); }
setPassword(pw);
console.log("Password changed. Every device has been signed out; sign in again with the new password.");
