import crypto from "node:crypto";
import readline from "node:readline";

function prompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function promptHidden(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;

    if (!stdin.isTTY) {
      const rl = readline.createInterface({
        input: stdin,
        output: stdout,
      });

      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });

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
        stdin.setRawMode(false);
        stdin.pause();
        stdin.off("data", onData);
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

function isValidUsername(value) {
  return /^[\p{Script=Han}A-Za-z0-9][\p{Script=Han}A-Za-z0-9_-]{0,15}$/u.test(value);
}

async function promptUsername() {
  while (true) {
    const input = await prompt("请输入管理员用户名 [默认：admin]：");
    const username = input || "admin";

    if (isValidUsername(username)) {
      return username;
    }

    console.error(
      "用户名无效：只能使用中文、英文、数字、短横线（-）和下划线（_），长度为 1～16 个字符。",
    );
  }
}

async function promptPassword() {
  while (true) {
    const password = await promptHidden("请输入管理员密码：");

    if (!password) {
      console.error("密码不能为空，请重新输入。");
      continue;
    }

    const confirm = await promptHidden("请再次输入管理员密码：");

    if (password !== confirm) {
      console.error("两次输入的密码不一致，请重新输入。");
      continue;
    }

    return password;
  }
}

const username = await promptUsername();
const password = await promptPassword();

const N = 16384;
const r = 8;
const p = 1;
const salt = crypto.randomBytes(16);

const hash = crypto.scryptSync(password, salt, 64, {
  N,
  r,
  p,
  maxmem: 64 * 1024 * 1024,
});

const passwordHash = [
  "scrypt",
  N,
  r,
  p,
  salt.toString("base64url"),
  hash.toString("base64url"),
].join("$");

const sessionSecret = crypto.randomBytes(32).toString("hex");

console.log("");
console.log("----------------------------------------------");
console.log("            行旅手记 · 管理员配置");
console.log("----------------------------------------------");
console.log("");
console.log(`ADMIN_USERNAME=${username}`);
console.log(`ADMIN_PASSWORD_HASH=${passwordHash}`);
console.log(`SESSION_SECRET=${sessionSecret}`);
console.log("");
console.log("----------------------------------------------");
console.log("以上三项配置可以复制到 .env 文件中");
console.log("请妥善保管以上配置信息，打死不要告诉别人！");
console.log("----------------------------------------------");