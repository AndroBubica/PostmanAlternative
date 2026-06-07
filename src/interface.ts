export type KeyValueRow = { id: number; name: string; value: string; enabled: boolean };
export type MultipartRow = KeyValueRow & { kind: "text" | "file" };
export type BodyMode = "json" | "text" | "xml" | "form" | "multipart" | "binary";
export type AuthType = "none" | "basic" | "bearer" | "api-key";
export type Assertion = {
  id: string;
  kind: "status" | "header" | "json-path" | "response-time" | "body";
  operator: "equals" | "not-equals" | "contains" | "exists" | "less-than";
  target: string;
  expected: string;
  enabled: boolean;
};
export type RequestShape = {
  method: string;
  url: string;
  params: KeyValueRow[];
  headers: KeyValueRow[];
  body: string;
  bodyMode: BodyMode;
  formRows: KeyValueRow[];
  multipartRows: MultipartRow[];
  binaryFile: string;
  authType: AuthType;
  authFields: Record<string, string>;
};
export type BuiltRequest = {
  url: string;
  headers: KeyValueRow[];
  body_kind: "text" | "multipart" | "binary";
  body: string | null;
  multipart_fields: MultipartRow[];
  binary_file: string | null;
};
export type TestResult = { name: string; passed: boolean; message: string };
export type ResponseShape = {
  status: number;
  elapsed_ms: number;
  headers: Array<{ name: string; value: string }>;
  body: string;
};

const variablePattern = /\{\{\s*([^}]+?)\s*\}\}/g;

export function resolver(variables: Record<string, string>) {
  return (value: string) => {
    const missing: string[] = [];
    const resolved = value.replace(variablePattern, (_match, name: string) => {
      if (!(name in variables)) {
        missing.push(name);
        return `{{${name}}}`;
      }
      return variables[name];
    });
    if (missing.length) throw new Error(`Unresolved variables: ${[...new Set(missing)].join(", ")}`);
    return resolved;
  };
}

export function buildRequest(request: RequestShape, variables: Record<string, string>): BuiltRequest {
  const resolve = resolver(variables);
  const requestUrl = new URL(resolve(request.url));
  request.params.filter((row) => row.enabled && row.name).forEach((row) => requestUrl.searchParams.append(resolve(row.name), resolve(row.value)));
  const requestHeaders = request.headers.filter((header) => header.enabled && header.name).map((header) => ({ ...header, name: resolve(header.name), value: resolve(header.value) }));
  const contentTypeDisabled = request.headers.some((header) => !header.enabled && header.name.toLowerCase() === "content-type");
  const contentTypes: Partial<Record<BodyMode, string>> = {
    json: "application/json", text: "text/plain", xml: "application/xml",
    form: "application/x-www-form-urlencoded", binary: "application/octet-stream",
  };
  const contentType = requestHeaders.find((header) => header.name.toLowerCase() === "content-type");
  if (request.bodyMode === "multipart") {
    if (contentType) contentType.enabled = false;
  } else if (contentTypes[request.bodyMode]) {
    if (contentType) contentType.value = contentTypes[request.bodyMode]!;
    else if (!contentTypeDisabled) requestHeaders.push({ id: -2, name: "Content-Type", value: contentTypes[request.bodyMode]!, enabled: true });
  }
  if (request.authType === "basic") requestHeaders.push({ id: -1, name: "Authorization", value: `Basic ${btoa(`${resolve(request.authFields.username ?? "")}:${resolve(request.authFields.password ?? "")}`)}`, enabled: true });
  if (request.authType === "bearer") requestHeaders.push({ id: -1, name: "Authorization", value: `Bearer ${resolve(request.authFields.token ?? "")}`, enabled: true });
  if (request.authType === "api-key" && request.authFields.key) {
    if (request.authFields.location === "query") requestUrl.searchParams.append(resolve(request.authFields.key), resolve(request.authFields.value ?? ""));
    else requestHeaders.push({ id: -1, name: resolve(request.authFields.key), value: resolve(request.authFields.value ?? ""), enabled: true });
  }
  const canHaveBody = !["GET", "HEAD"].includes(request.method);
  let body: string | null = canHaveBody ? resolve(request.body) : null;
  if (canHaveBody && request.bodyMode === "form") {
    body = new URLSearchParams(request.formRows.filter((row) => row.enabled && row.name).map((row) => [resolve(row.name), resolve(row.value)])).toString();
  }
  if (request.bodyMode === "multipart" || request.bodyMode === "binary") body = null;
  return {
    url: requestUrl.toString(),
    headers: requestHeaders,
    body_kind: canHaveBody && (request.bodyMode === "multipart" || request.bodyMode === "binary") ? request.bodyMode : "text",
    body,
    multipart_fields: canHaveBody && request.bodyMode === "multipart"
      ? request.multipartRows.filter((row) => row.enabled && row.name).map((row) => ({ ...row, name: resolve(row.name), value: resolve(row.value) }))
      : [],
    binary_file: canHaveBody && request.bodyMode === "binary" && request.binaryFile ? resolve(request.binaryFile) : null,
  };
}

const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

export function requestToCurl(method: string, built: BuiltRequest) {
  const parts = ["curl", "-X", method, shellQuote(built.url)];
  built.headers.filter((header) => header.enabled).forEach((header) => parts.push("-H", shellQuote(`${header.name}: ${header.value}`)));
  if (built.body_kind === "binary" && built.binary_file) parts.push("--data-binary", shellQuote(`@${built.binary_file}`));
  else if (built.body_kind === "multipart") {
    built.multipart_fields.forEach((field) => parts.push("-F", shellQuote(`${field.name}=${field.kind === "file" ? "@" : ""}${field.value}`)));
  } else if (built.body) parts.push("--data-raw", shellQuote(built.body));
  return parts.join(" ");
}

export function assertionOperators(kind: Assertion["kind"]): Assertion["operator"][] {
  if (kind === "response-time") return ["less-than"];
  if (kind === "status") return ["equals", "not-equals"];
  if (kind === "body") return ["contains", "equals", "not-equals"];
  return ["equals", "not-equals", "contains", "exists"];
}

export function assertionError(assertion: Assertion) {
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

export function assertionResults(items: Assertion[], result: ResponseShape): TestResult[] {
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

export function parseCurl(command: string, row: () => KeyValueRow) {
  const tokens = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((token) => token.replace(/^(['"])(.*)\1$/, "$2")) ?? [];
  let method = "GET";
  let url = "";
  let body = "";
  let bodyMode: BodyMode = "text";
  let binaryFile = "";
  let authType: AuthType = "none";
  const authFields: Record<string, string> = {};
  const headers: KeyValueRow[] = [];
  const formRows: KeyValueRow[] = [];
  const multipartRows: MultipartRow[] = [];
  const warnings: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const next = () => tokens[++index] ?? "";
    if (["curl", "-s", "--silent", "-L", "--location", "--compressed"].includes(token)) continue;
    if (token === "-X" || token === "--request") method = next().toUpperCase();
    else if (token === "--url") url = next();
    else if (token === "-H" || token === "--header") {
      const header = next(); const separator = header.indexOf(":");
      if (separator >= 0) headers.push({ ...row(), name: header.slice(0, separator).trim(), value: header.slice(separator + 1).trim() });
    } else if (token === "-u" || token === "--user") {
      const [username, ...password] = next().split(":"); authType = "basic"; Object.assign(authFields, { username, password: password.join(":") });
    } else if (["-d", "--data", "--data-raw"].includes(token)) {
      body = next(); if (method === "GET") method = "POST";
    } else if (token === "--data-binary") {
      const value = next(); bodyMode = "binary"; binaryFile = value.startsWith("@") ? value.slice(1) : value; if (method === "GET") method = "POST";
    } else if (token === "-F" || token === "--form") {
      const value = next(); const separator = value.indexOf("="); const field = value.slice(separator + 1);
      multipartRows.push({ ...row(), name: value.slice(0, separator), value: field.startsWith("@") ? field.slice(1) : field, kind: field.startsWith("@") ? "file" : "text" });
      bodyMode = "multipart"; if (method === "GET") method = "POST";
    } else if (/^https?:\/\//.test(token)) url = token;
    else if (token.startsWith("-")) warnings.push(token);
  }
  if (bodyMode === "text" && headers.some((header) => header.value.includes("application/x-www-form-urlencoded"))) {
    bodyMode = "form";
    new URLSearchParams(body).forEach((value, name) => formRows.push({ ...row(), name, value }));
  }
  return { method, url, body, bodyMode, binaryFile, authType, authFields, headers, formRows, multipartRows, warnings };
}

export function reportContents(report: { collection: string; elapsed_ms: number; failed: number; items: Array<{ name: string; elapsed_ms: number; error: string; tests: TestResult[] }> }, format: "json" | "junit") {
  if (format === "json") return JSON.stringify(report, null, 2);
  const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="${escape(report.collection)}" tests="${report.items.length}" failures="${report.failed}" time="${report.elapsed_ms / 1000}">\n${report.items.map((item) => `  <testcase name="${escape(item.name)}" classname="${escape(report.collection)}" time="${item.elapsed_ms / 1000}">${item.error || item.tests.some((test) => !test.passed) ? `<failure message="${escape(item.error || item.tests.filter((test) => !test.passed).map((test) => test.message).join("; "))}"/>` : ""}</testcase>`).join("\n")}\n</testsuite>\n`;
}
