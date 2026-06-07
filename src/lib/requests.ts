import type { AuthType, BodyMode, BuiltRequest, KeyValueRow, MultipartRow, RequestShape } from "../domain/types.ts";

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

export function parseCurl(command: string, row: () => KeyValueRow) {
  const tokens = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((token) => token.replace(/^(['"])(.*)\1$/, "$2")) ?? [];
  let method = "GET"; let url = ""; let body = ""; let bodyMode: BodyMode = "text"; let binaryFile = ""; let authType: AuthType = "none";
  const authFields: Record<string, string> = {}; const headers: KeyValueRow[] = []; const formRows: KeyValueRow[] = []; const multipartRows: MultipartRow[] = []; const warnings: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]; const next = () => tokens[++index] ?? "";
    if (["curl", "-s", "--silent", "-L", "--location", "--compressed"].includes(token)) continue;
    if (token === "-X" || token === "--request") method = next().toUpperCase();
    else if (token === "--url") url = next();
    else if (token === "-H" || token === "--header") { const header = next(); const separator = header.indexOf(":"); if (separator >= 0) headers.push({ ...row(), name: header.slice(0, separator).trim(), value: header.slice(separator + 1).trim() }); }
    else if (token === "-u" || token === "--user") { const [username, ...password] = next().split(":"); authType = "basic"; Object.assign(authFields, { username, password: password.join(":") }); }
    else if (["-d", "--data", "--data-raw"].includes(token)) { body = next(); if (method === "GET") method = "POST"; }
    else if (token === "--data-binary") { const value = next(); bodyMode = "binary"; binaryFile = value.startsWith("@") ? value.slice(1) : value; if (method === "GET") method = "POST"; }
    else if (token === "-F" || token === "--form") { const value = next(); const separator = value.indexOf("="); const field = value.slice(separator + 1); multipartRows.push({ ...row(), name: value.slice(0, separator), value: field.startsWith("@") ? field.slice(1) : field, kind: field.startsWith("@") ? "file" : "text" }); bodyMode = "multipart"; if (method === "GET") method = "POST"; }
    else if (/^https?:\/\//.test(token)) url = token;
    else if (token.startsWith("-")) warnings.push(token);
  }
  if (bodyMode === "text" && headers.some((header) => header.value.includes("application/x-www-form-urlencoded"))) {
    bodyMode = "form"; new URLSearchParams(body).forEach((value, name) => formRows.push({ ...row(), name, value }));
  }
  return { method, url, body, bodyMode, binaryFile, authType, authFields, headers, formRows, multipartRows, warnings };
}
