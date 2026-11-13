import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";

const specs = resolve(import.meta.dir, "../../specs");
const tests = import.meta.dir;
function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? filesUnder(join(directory, entry.name)) : [join(directory, entry.name)]);
}
function refusalCodes(markdown: string): string[] {
  const section = markdown.match(/^## Refusals\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1] ?? "";
  return [...section.matchAll(/^\|\s*`([^`]+)`\s*\|\s*\d+\s*\|/gm)].map((match) => match[1]);
}
function titles(source: string): string[] {
  const result: string[] = [];
  const ast = ts.createSourceFile("test.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && /^(test|it)\b/.test(node.expression.getText(ast))) {
      const title = node.arguments[0];
      if (title && (ts.isStringLiteral(title) || ts.isNoSubstitutionTemplateLiteral(title))) result.push(title.text);
      if (title && ts.isTemplateExpression(title)) result.push(title.head.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return result;
}

test("every Refusals code in every rule spec has a test titled refuses <code>", () => {
  const testTitles = filesUnder(tests).filter((file) => /\.test\.[cm]?[jt]sx?$/.test(file)).flatMap((file) => titles(readFileSync(file, "utf8")));
  const tables = filesUnder(specs).filter((file) => file.endsWith(".md") && /^## Refusals\s*$/m.test(readFileSync(file, "utf8")));
  expect(tables.length).toBeGreaterThan(0);
  const missing = tables.flatMap((file) => refusalCodes(readFileSync(file, "utf8")).filter((code) => !testTitles.some((title) => new RegExp(`\\brefuses ${code}\\b`).test(title))).map((code) => `${file}: refuses ${code}`));
  expect(missing).toEqual([]);
});
test("refusal inventory ignores other tables, comments, helper strings and unrelated headings", () => {
  expect(refusalCodes("## Rules\n| `ignored` | 403 | x |\n## Refusals\n| Code | Status | Message |\n| `kept` | 400 | x |\n## Next\n| `ignored` | 400 | x |\n")).toEqual(["kept"]);
  expect(titles('// test("refuses fake", () => {});\nconst helper = "refuses fake";\ntest.each([1])("refuses kept", () => {});')).toEqual(["refuses kept"]);
});
