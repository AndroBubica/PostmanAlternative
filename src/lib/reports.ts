import type { TestResult } from "../domain/types.ts";

type Report = { collection: string; elapsed_ms: number; failed: number; items: Array<{ name: string; elapsed_ms: number; error: string; tests: TestResult[] }> };

export function reportContents(report: Report, format: "json" | "junit") {
  if (format === "json") return JSON.stringify(report, null, 2);
  const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="${escape(report.collection)}" tests="${report.items.length}" failures="${report.failed}" time="${report.elapsed_ms / 1000}">\n${report.items.map((item) => `  <testcase name="${escape(item.name)}" classname="${escape(report.collection)}" time="${item.elapsed_ms / 1000}">${item.error || item.tests.some((test) => !test.passed) ? `<failure message="${escape(item.error || item.tests.filter((test) => !test.passed).map((test) => test.message).join("; "))}"/>` : ""}</testcase>`).join("\n")}\n</testsuite>\n`;
}
