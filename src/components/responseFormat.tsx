import type { ApiResponse } from "../domain/types.ts";

export function fileName(path: string) {
  return path.split(/[\\/]/).pop() || path;
}

export function prettyBody(body: string) {
  try { return JSON.stringify(JSON.parse(body), null, 2); } catch { return body; }
}

function JsonTree({ value, name }: { value: unknown; name?: string }) {
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return <details open className="json-node"><summary>{name && <strong>{name}: </strong>}{Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`}</summary>{entries.map(([key, child]) => <JsonTree key={key} name={key} value={child} />)}</details>;
  }
  return <div className="json-leaf">{name && <strong>{name}: </strong>}<span className={`json-${value === null ? "null" : typeof value}`}>{JSON.stringify(value)}</span></div>;
}

export function HighlightedJson({ body }: { body: string }) {
  const highlighted = body.replace(/(&|<|>)/g, (value) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[value]!)
    .replace(/("(?:\\u[\da-fA-F]{4}|\\[^u]|[^\\"])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, (match, string, key) => `<span class="${key ? "json-key" : string ? "json-string" : /true|false/.test(match) ? "json-boolean" : /null/.test(match) ? "json-null" : "json-number"}">${match}</span>`);
  return <pre dangerouslySetInnerHTML={{ __html: highlighted }} />;
}

export function JsonTreeBody({ body }: { body: string }) {
  try { return <div className="json-tree"><JsonTree value={JSON.parse(body)} /></div>; } catch { return <pre>{body}</pre>; }
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function parseCookies(headers: ApiResponse["headers"]) {
  return headers.filter((header) => header.name.toLowerCase() === "set-cookie").map((header) => {
    const [pair, ...attributes] = header.value.split(";").map((part) => part.trim());
    const separator = pair.indexOf("=");
    return { name: separator >= 0 ? pair.slice(0, separator) : pair, value: separator >= 0 ? pair.slice(separator + 1) : "", attributes: attributes.join("; ") };
  });
}

export function responseExtension(contentType: string) {
  if (contentType.includes("json")) return "json";
  if (contentType.includes("html")) return "html";
  if (contentType.includes("xml")) return "xml";
  if (contentType.includes("png")) return "png";
  if (contentType.includes("jpeg")) return "jpg";
  if (contentType.includes("gif")) return "gif";
  if (contentType.includes("svg")) return "svg";
  if (contentType.startsWith("text/")) return "txt";
  return "bin";
}
