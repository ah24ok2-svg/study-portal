/** test/*.test.js をすべて実行する。node test/run.js */
const fs = require("fs");
const path = require("path");

let pass = 0;
let fail = 0;
const files = fs.readdirSync(__dirname).filter((f) => f.endsWith(".test.js")).sort();
for (const file of files) {
  const before = { pass, fail };
  const t = (name, cond, extra) => {
    if (cond) pass++;
    else {
      fail++;
      console.log("  FAIL " + file + ": " + name + (extra !== undefined ? " " + JSON.stringify(extra).slice(0, 300) : ""));
    }
  };
  try {
    require(path.join(__dirname, file))(t);
  } catch (err) {
    fail++;
    console.log("  ERROR " + file + ": " + err.stack);
  }
  console.log(file.padEnd(24) + " pass " + (pass - before.pass) + "  fail " + (fail - before.fail));
}
console.log("total: pass " + pass + ", fail " + fail);
process.exit(fail ? 1 : 0);
