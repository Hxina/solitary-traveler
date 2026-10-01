import crypto from "node:crypto";
import readline from "node:readline";

function promptHidden(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    if (!stdin.isTTY) {
      const rl = readline.createInterface({ input: stdin, output: stdout });
      rl.question(question, (answer) => { rl.close(); resolve(answer); });
      return;
    }

    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const onData = (char) => {
      if (char === "\r" || char === "\n") {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.off("data", onData);
        stdout.write("\n");
        resolve(value);
        return;
      }
      if (char === "\u0003") {
        process.exit(130);
      }
      if (char === "\u007f") {
        value = value.slice(0, -1);
        return;
      }
      value += char;
    };
    stdin.on("data", onData);
  });
}

const password = await promptHidden("Password: ");
if (!password) {
  console.error("Password cannot be empty.");
  process.exit(1);
}

const N = 16384;
const r = 8;
const p = 1;
const salt = crypto.randomBytes(16);
const hash = crypto.scryptSync(password, salt, 64, { N, r, p, maxmem: 64 * 1024 * 1024 });

console.log(`ADMIN_PASSWORD_HASH=scrypt$${N}$${r}$${p}$${salt.toString("base64url")}$${hash.toString("base64url")}`);
console.log("Generate a separate SESSION_SECRET with: openssl rand -hex 32");
