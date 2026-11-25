// Static registration counts only. Never import a test module or execute a test.
import ts from "typescript";
import { readdirSync, readFileSync } from "node:fs";
const fileCounts = {}, fileOnly = [];
const tokens = readFileSync("src/ui/tokens.css", "utf8");
const palettes = [...tokens.matchAll(/\{([^{}]*--surface-canvas:[^{}]*)\}/g)].length;
for (const file of readdirSync("tests").filter(f => f.endsWith(".test.ts")).sort()) {
  const text = readFileSync("tests/" + file, "utf8");
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let cases = 0;
  function scan(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "test") {
      if (node.arguments.length !== 2) throw Error("Test options need review: " + file);
      let multiple = 1;
      for (let p = node.parent; p !== ast; p = p.parent) {
        if (ts.isForOfStatement(p)) {
          let list = p.expression;
          if (ts.isAsExpression(list)) list = list.expression;
          if (ts.isArrayLiteralExpression(list)) multiple *= list.elements.length;
          else if (file === "unit010-accessibility.test.ts" && list.getText() === "palettes.entries()") multiple *= palettes;
          else throw Error("Unknown registration loop " + list.getText());
        } else if (!(ts.isExpressionStatement(p) || ts.isBlock(p))) {
          throw Error("Conditional or indirect test registration: " + file + " " + p.getText().slice(0, 48));
        }
      }
      cases += multiple;
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        ["skip", "todo", "only", "runOnly"].includes(node.expression.name.text)) throw Error("Case selector in " + file);
    ts.forEachChild(node, scan);
  }
  scan(ast);
  if (cases === 0) fileOnly.push("tests/" + file);
  fileCounts["tests/" + file] = Math.max(cases, 1);
}
const total = Object.values(fileCounts).reduce((a, b) => a + b, 0);
if (total !== 285 || fileOnly.join() !== "tests/unit08.test.ts") throw Error("Unexpected source census " + total);
console.log(JSON.stringify({ total, fileOnly, fileCounts, registeredMuseumCases: fileCounts["tests/unit011-museum.test.ts"] }, null, 2));
