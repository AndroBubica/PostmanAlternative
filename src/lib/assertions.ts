import type { RequestAssertion, ResponseShape, TestResult } from "../domain/types.ts";

export function assertionOperators(kind: RequestAssertion["kind"]): RequestAssertion["operator"][] {
  if (kind === "response-time") return ["less-than"];
  if (kind === "status") return ["equals", "not-equals"];
  if (kind === "body") return ["contains", "equals", "not-equals"];
  return ["equals", "not-equals", "contains", "exists"];
}

export function assertionError(assertion: RequestAssertion) {
  if (!assertion.enabled) return "";
  if (!assertionOperators(assertion.kind).includes(assertion.operator)) return `${assertion.operator} is not valid for ${assertion.kind}.`;
  if (["header", "json-path"].includes(assertion.kind) && !assertion.target.trim()) return "Target is required.";
  if (assertion.operator !== "exists" && !assertion.expected.trim()) return "Expected value is required.";
  if (assertion.kind === "response-time" && !Number.isFinite(Number(assertion.expected))) return "Expected must be a number.";
  return "";
}

export function jsonPath(value: unknown, path: string): unknown {
  const parts = path.replace(/^\$\.?/, "").match(/[^.[\]]+|\[(\d+)\]/g) ?? [];
  return parts.reduce<unknown>((current, part) => {
    const key = part.startsWith("[") ? Number(part.slice(1, -1)) : part;
    return current !== null && current !== undefined ? (current as Record<string | number, unknown>)[key] : undefined;
  }, value);
}

export function assertionResults(items: RequestAssertion[], result: ResponseShape): TestResult[] {
  return items.filter((item) => item.enabled).map((item) => {
    const invalid = assertionError(item);
    if (invalid) return { name: `${item.kind} ${item.target || item.operator}`, passed: false, message: invalid };
    let actual: unknown;
    try {
      if (item.kind === "status") actual = result.status;
      if (item.kind === "response-time") actual = result.elapsed_ms;
      if (item.kind === "body") actual = result.body;
      if (item.kind === "header") actual = result.headers.find((header) => header.name.toLowerCase() === item.target.toLowerCase())?.value;
      if (item.kind === "json-path") actual = jsonPath(JSON.parse(result.body), item.target);
      const passed = item.operator === "exists" ? actual !== undefined && actual !== null
        : item.operator === "contains" ? String(actual).includes(item.expected)
        : item.operator === "not-equals" ? String(actual) !== item.expected
        : item.operator === "less-than" ? Number(actual) < Number(item.expected)
        : String(actual) === item.expected;
      return { name: `${item.kind} ${item.target || item.operator}`, passed, message: passed ? "" : `Expected ${item.operator} ${item.expected || "a value"}, received ${JSON.stringify(actual)}` };
    } catch (error) {
      return { name: `${item.kind} ${item.target || item.operator}`, passed: false, message: String(error) };
    }
  });
}
