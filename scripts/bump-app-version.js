const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const versionPath = path.join(rootDir, "app-version.json");

function pad(value) {
  return String(value).padStart(2, "0");
}

function buildVersion(date) {
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hour = pad(date.getHours());
  const minute = pad(date.getMinutes());
  const second = pad(date.getSeconds());
  return `${year}-${month}-${day}-${hour}${minute}${second}`;
}

const version = process.argv[2] || buildVersion(new Date());
const payload = `${JSON.stringify({ version }, null, 2)}\n`;

fs.writeFileSync(versionPath, payload, "utf8");
console.log(`Updated app-version.json to ${version}`);
