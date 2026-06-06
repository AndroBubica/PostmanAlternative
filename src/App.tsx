import { FormEvent, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import "./App.css";

type KeyValueRow = {
  id: number;
  name: string;
  value: string;
  enabled: boolean;
};

type ApiResponse = {
  status: number;
  status_text: string;
  elapsed_ms: number;
  size_bytes: number;
  headers: Array<{ name: string; value: string }>;
  body: string;
  body_base64: string;
  content_type: string;
};

type AuthType = "none" | "basic" | "bearer" | "api-key";
type BodyMode = "json" | "text" | "xml" | "form" | "multipart" | "binary";
type ResponseView = "pretty" | "raw" | "preview";
type MultipartRow = KeyValueRow & { kind: "text" | "file" };

const methodColors: Record<string, string> = {
  GET: "method-get",
  POST: "method-post",
  PUT: "method-put",
  PATCH: "method-patch",
  DELETE: "method-delete",
};

const requestGroups = [
  { name: "Health checks", requests: [{ method: "GET", name: "Service status" }] },
  {
    name: "Users API",
    requests: [
      { method: "GET", name: "List users" },
      { method: "POST", name: "Create user" },
    ],
  },
];

const emptyRow = (): KeyValueRow => ({
  id: Date.now() + Math.random(),
  name: "",
  value: "",
  enabled: true,
});

const emptyMultipartRow = (): MultipartRow => ({ ...emptyRow(), kind: "text" });

function fileName(path: string) {
  return path.split(/[\\/]/).pop() || path;
}

function prettyBody(body: string) {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function parseCookies(headers: ApiResponse["headers"]) {
  return headers
    .filter((header) => header.name.toLowerCase() === "set-cookie")
    .map((header) => {
      const [pair, ...attributes] = header.value.split(";").map((part) => part.trim());
      const separator = pair.indexOf("=");
      return {
        name: separator >= 0 ? pair.slice(0, separator) : pair,
        value: separator >= 0 ? pair.slice(separator + 1) : "",
        attributes: attributes.join("; "),
      };
    });
}

function responseExtension(contentType: string) {
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

function KeyValueTable({
  rows,
  setRows,
  label,
}: {
  rows: KeyValueRow[];
  setRows: React.Dispatch<React.SetStateAction<KeyValueRow[]>>;
  label: string;
}) {
  function updateRow(id: number, field: keyof KeyValueRow, value: string | boolean) {
    setRows((current) =>
      current.map((row) => (row.id === id ? { ...row, [field]: value } : row)),
    );
  }

  return (
    <div className="key-value-table">
      <div className="table-labels"><span /><span>Key</span><span>Value</span><span /></div>
      {rows.map((row) => (
        <div className="key-value-row" key={row.id}>
          <input
            checked={row.enabled}
            onChange={(event) => updateRow(row.id, "enabled", event.target.checked)}
            type="checkbox"
            aria-label={`Enable ${row.name || label}`}
          />
          <input
            value={row.name}
            onChange={(event) => updateRow(row.id, "name", event.target.value)}
            placeholder={`${label} name`}
            aria-label={`${label} name`}
          />
          <input
            value={row.value}
            onChange={(event) => updateRow(row.id, "value", event.target.value)}
            placeholder="Value"
            aria-label={`${label} value`}
          />
          <button
            type="button"
            className="row-remove"
            onClick={() => setRows((current) => current.filter((item) => item.id !== row.id))}
            aria-label={`Remove ${label}`}
          >
            ×
          </button>
        </div>
      ))}
      <button className="add-row" type="button" onClick={() => setRows((current) => [...current, emptyRow()])}>
        + Add {label.toLowerCase()}
      </button>
    </div>
  );
}

function App() {
  const [method, setMethod] = useState("GET");
  const [url, setUrl] = useState("https://jsonplaceholder.typicode.com/users/1");
  const [body, setBody] = useState('{\n  "name": "Ada",\n  "role": "developer"\n}');
  const [bodyMode, setBodyMode] = useState<BodyMode>("json");
  const [formRows, setFormRows] = useState<KeyValueRow[]>([emptyRow()]);
  const [multipartRows, setMultipartRows] = useState<MultipartRow[]>([emptyMultipartRow()]);
  const [binaryFile, setBinaryFile] = useState("");
  const [params, setParams] = useState<KeyValueRow[]>([emptyRow()]);
  const [headers, setHeaders] = useState<KeyValueRow[]>([
    { id: 1, name: "Accept", value: "application/json", enabled: true },
    { id: 2, name: "Content-Type", value: "application/json", enabled: true },
  ]);
  const [authType, setAuthType] = useState<AuthType>("none");
  const [authFields, setAuthFields] = useState({ username: "", password: "", token: "", key: "", value: "", location: "header" });
  const [timeoutMs, setTimeoutMs] = useState(30000);
  const [followRedirects, setFollowRedirects] = useState(true);
  const [requestTab, setRequestTab] = useState("Body");
  const [responseTab, setResponseTab] = useState("Body");
  const [responseView, setResponseView] = useState<ResponseView>("pretty");
  const [responseSearch, setResponseSearch] = useState("");
  const [response, setResponse] = useState<ApiResponse | null>(null);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const activeRequestId = useRef("");

  const responseBody = useMemo(
    () => (responseView === "pretty" && response ? prettyBody(response.body) : response?.body ?? ""),
    [response, responseView],
  );
  const searchMatches = useMemo(() => {
    if (!responseSearch) return 0;
    return responseBody.toLowerCase().split(responseSearch.toLowerCase()).length - 1;
  }, [responseBody, responseSearch]);
  const cookies = useMemo(() => (response ? parseCookies(response.headers) : []), [response]);

  function buildRequest() {
    const requestUrl = new URL(url);
    params.filter((row) => row.enabled && row.name).forEach((row) => requestUrl.searchParams.append(row.name, row.value));
    const requestHeaders = headers.map((header) => ({ ...header }));
    const contentTypes: Partial<Record<BodyMode, string>> = {
      json: "application/json",
      text: "text/plain",
      xml: "application/xml",
      form: "application/x-www-form-urlencoded",
      binary: "application/octet-stream",
    };
    const contentType = requestHeaders.find((header) => header.name.toLowerCase() === "content-type");
    if (bodyMode === "multipart") {
      if (contentType) contentType.enabled = false;
    } else {
      const value = contentTypes[bodyMode];
      if (value && contentType) contentType.value = value;
      else if (value) requestHeaders.push({ id: -2, name: "Content-Type", value, enabled: true });
    }

    if (authType === "basic") {
      requestHeaders.push({ id: -1, name: "Authorization", value: `Basic ${btoa(`${authFields.username}:${authFields.password}`)}`, enabled: true });
    } else if (authType === "bearer") {
      requestHeaders.push({ id: -1, name: "Authorization", value: `Bearer ${authFields.token}`, enabled: true });
    } else if (authType === "api-key" && authFields.key) {
      if (authFields.location === "query") requestUrl.searchParams.append(authFields.key, authFields.value);
      else requestHeaders.push({ id: -1, name: authFields.key, value: authFields.value, enabled: true });
    }

    const canHaveBody = !["GET", "HEAD"].includes(method);
    let requestBody: string | null = canHaveBody ? body : null;
    if (requestBody !== null && bodyMode === "form") {
      requestBody = new URLSearchParams(
        formRows.filter((row) => row.enabled && row.name).map((row) => [row.name, row.value]),
      ).toString();
    }
    if (bodyMode === "multipart" || bodyMode === "binary") requestBody = null;

    return {
      url: requestUrl.toString(),
      headers: requestHeaders,
      body_kind: canHaveBody && (bodyMode === "multipart" || bodyMode === "binary") ? bodyMode : "text",
      body: requestBody,
      multipart_fields: canHaveBody && bodyMode === "multipart" ? multipartRows : [],
      binary_file: canHaveBody && bodyMode === "binary" && binaryFile ? binaryFile : null,
    };
  }

  async function sendRequest(event: FormEvent) {
    event.preventDefault();
    setSending(true);
    setError("");
    const requestId = crypto.randomUUID();
    activeRequestId.current = requestId;
    try {
      const built = buildRequest();
      const result = await invoke<ApiResponse>("send_request", {
        request: {
          id: requestId,
          method,
          ...built,
          timeout_ms: timeoutMs,
          follow_redirects: followRedirects,
        },
      });
      setResponse(result);
      setResponseTab("Body");
    } catch (requestError) {
      setResponse(null);
      setError(String(requestError));
    } finally {
      activeRequestId.current = "";
      setSending(false);
    }
  }

  async function cancelRequest() {
    if (activeRequestId.current) {
      await invoke("cancel_request", { requestId: activeRequestId.current });
    }
  }

  function updateAuth(field: string, value: string) {
    setAuthFields((current) => ({ ...current, [field]: value }));
  }

  async function chooseFile(onSelected: (path: string) => void) {
    const selected = await open({ multiple: false, directory: false });
    if (selected) onSelected(selected);
  }

  async function saveResponse() {
    if (!response) return;
    const path = await save({
      defaultPath: `response.${responseExtension(response.content_type)}`,
    });
    if (path) {
      await invoke("save_response", { path, bodyBase64: response.body_base64 });
    }
  }

  function updateMultipartRow(id: number, field: keyof MultipartRow, value: string | boolean) {
    setMultipartRows((current) =>
      current.map((row) => (row.id === id ? { ...row, [field]: value } : row)),
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">A</span><strong>API Lantern</strong><span className="local-pill">Local only</span></div>
        <label className="environment"><span>Environment</span><select aria-label="Active environment" defaultValue="Local"><option>Local</option><option>Staging</option><option>Production</option></select></label>
      </header>

      <aside className="sidebar">
        <div className="sidebar-actions"><button className="new-button" type="button">+ New request</button><button className="icon-button" type="button" aria-label="More actions">...</button></div>
        <input className="search" placeholder="Search requests..." aria-label="Search requests" />
        <nav aria-label="Collections">
          <p className="section-label">Collections</p>
          {requestGroups.map((group) => (
            <section className="collection" key={group.name}>
              <h2><span>⌄</span> {group.name}</h2>
              {group.requests.map((request) => <button className="request-item" key={request.name} type="button"><span className={methodColors[request.method]}>{request.method}</span>{request.name}</button>)}
            </section>
          ))}
        </nav>
        <div className="privacy-note"><strong>Your data stays here.</strong><span>No account, cloud, or telemetry.</span></div>
      </aside>

      <section className="workspace">
        <div className="request-tabs"><button className="open-tab active" type="button"><span className={methodColors[method]}>{method}</span>Service status<span className="unsaved-dot" aria-label="Unsaved changes" /></button><button className="tab-add" type="button" aria-label="New tab">+</button></div>

        <form className="request-panel" onSubmit={sendRequest}>
          <div className="request-line">
            <select value={method} onChange={(event) => setMethod(event.target.value)} aria-label="HTTP method">{["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].map((item) => <option key={item}>{item}</option>)}</select>
            <input value={url} onChange={(event) => setUrl(event.target.value)} aria-label="Request URL" />
            {sending ? <button className="cancel-button" onClick={cancelRequest} type="button">Cancel</button> : <button className="send-button" type="submit">Send</button>}
          </div>

          <div className="panel-tabs" role="tablist" aria-label="Request options">
            {["Params", "Headers", "Body", "Auth", "Settings"].map((tab) => (
              <button className={requestTab === tab ? "active" : ""} key={tab} onClick={() => setRequestTab(tab)} role="tab" type="button">
                {tab}{tab === "Headers" ? ` (${headers.filter((header) => header.enabled).length})` : tab === "Params" ? ` (${params.filter((param) => param.enabled && param.name).length})` : ""}
              </button>
            ))}
          </div>

          <div className="request-editor">
            {requestTab === "Params" && <KeyValueTable rows={params} setRows={setParams} label="Parameter" />}
            {requestTab === "Headers" && <KeyValueTable rows={headers} setRows={setHeaders} label="Header" />}
            {requestTab === "Body" && (
              <>
                <div className="editor-toolbar body-toolbar">
                  <div>{(["json", "text", "xml", "form", "multipart", "binary"] as BodyMode[]).map((mode) => <button className={bodyMode === mode ? "active" : ""} key={mode} onClick={() => setBodyMode(mode)} type="button">{mode === "form" ? "Form URL Encoded" : mode === "multipart" ? "Multipart" : mode.toUpperCase()}</button>)}</div>
                  {bodyMode === "json" && <button type="button" onClick={() => setBody(prettyBody(body))}>Format</button>}
                </div>
                {bodyMode === "form" && <KeyValueTable rows={formRows} setRows={setFormRows} label="Field" />}
                {bodyMode === "multipart" && <div className="key-value-table multipart-table">
                  <div className="table-labels"><span /><span>Type</span><span>Field</span><span>Value</span><span /></div>
                  {multipartRows.map((row) => <div className="key-value-row" key={row.id}>
                    <input checked={row.enabled} onChange={(event) => updateMultipartRow(row.id, "enabled", event.target.checked)} type="checkbox" aria-label={`Enable ${row.name || "multipart field"}`} />
                    <select value={row.kind} onChange={(event) => updateMultipartRow(row.id, "kind", event.target.value)} aria-label="Multipart field type"><option value="text">Text</option><option value="file">File</option></select>
                    <input value={row.name} onChange={(event) => updateMultipartRow(row.id, "name", event.target.value)} placeholder="Field name" aria-label="Multipart field name" />
                    {row.kind === "file" ? <button className="file-picker" type="button" onClick={() => chooseFile((path) => updateMultipartRow(row.id, "value", path))}>{row.value ? fileName(row.value) : "Choose file..."}</button> : <input value={row.value} onChange={(event) => updateMultipartRow(row.id, "value", event.target.value)} placeholder="Value" aria-label="Multipart field value" />}
                    <button type="button" className="row-remove" onClick={() => setMultipartRows((current) => current.filter((item) => item.id !== row.id))} aria-label="Remove multipart field">×</button>
                  </div>)}
                  <button className="add-row" type="button" onClick={() => setMultipartRows((current) => [...current, emptyMultipartRow()])}>+ Add field</button>
                </div>}
                {bodyMode === "binary" && <div className="file-body"><strong>Binary file</strong><span>{binaryFile || "No file selected."}</span><button className="file-picker" type="button" onClick={() => chooseFile(setBinaryFile)}>{binaryFile ? "Choose another file" : "Choose file..."}</button></div>}
                {!["form", "multipart", "binary"].includes(bodyMode) && <textarea value={body} onChange={(event) => setBody(event.target.value)} spellCheck={false} />}
              </>
            )}
            {requestTab === "Auth" && (
              <div className="settings-grid">
                <label><span>Authentication</span><select value={authType} onChange={(event) => setAuthType(event.target.value as AuthType)}><option value="none">None</option><option value="basic">Basic</option><option value="bearer">Bearer token</option><option value="api-key">API key</option></select></label>
                {authType === "basic" && <><label><span>Username</span><input value={authFields.username} onChange={(event) => updateAuth("username", event.target.value)} /></label><label><span>Password</span><input type="password" value={authFields.password} onChange={(event) => updateAuth("password", event.target.value)} /></label></>}
                {authType === "bearer" && <label><span>Token</span><input type="password" value={authFields.token} onChange={(event) => updateAuth("token", event.target.value)} /></label>}
                {authType === "api-key" && <><label><span>Key</span><input value={authFields.key} onChange={(event) => updateAuth("key", event.target.value)} /></label><label><span>Value</span><input type="password" value={authFields.value} onChange={(event) => updateAuth("value", event.target.value)} /></label><label><span>Add to</span><select value={authFields.location} onChange={(event) => updateAuth("location", event.target.value)}><option value="header">Header</option><option value="query">Query parameter</option></select></label></>}
              </div>
            )}
            {requestTab === "Settings" && <div className="settings-grid"><label><span>Timeout (milliseconds)</span><input min="1" type="number" value={timeoutMs} onChange={(event) => setTimeoutMs(Number(event.target.value))} /></label><label className="check-setting"><input checked={followRedirects} onChange={(event) => setFollowRedirects(event.target.checked)} type="checkbox" /><span>Follow redirects (up to 10)</span></label></div>}
          </div>
        </form>

        <section className="response-panel" aria-live="polite">
          <div className="response-heading">
            <div className="panel-tabs" role="tablist" aria-label="Response details">{["Body", "Headers", "Cookies"].map((tab) => <button className={responseTab === tab ? "active" : ""} key={tab} onClick={() => setResponseTab(tab)} role="tab" type="button">{tab}{tab === "Headers" && response ? ` (${response.headers.length})` : tab === "Cookies" && response ? ` (${cookies.length})` : ""}</button>)}</div>
            {response && <div className="response-meta"><strong className={response.status >= 400 ? "status-error" : ""}>{response.status} {response.status_text}</strong><span>{response.elapsed_ms} ms</span><span>{formatBytes(response.size_bytes)}</span></div>}
          </div>
          {error && <div className="error-box"><strong>Request failed</strong><span>{error}</span></div>}
          {!response && !error && <div className="empty-response">Send a request to see the response.</div>}
          {response && responseTab === "Body" && <><div className="response-tools"><div><button className={responseView === "pretty" ? "active" : ""} onClick={() => setResponseView("pretty")} type="button">Pretty</button><button className={responseView === "raw" ? "active" : ""} onClick={() => setResponseView("raw")} type="button">Raw</button><button className={responseView === "preview" ? "active" : ""} onClick={() => setResponseView("preview")} type="button">Preview</button></div><label><input value={responseSearch} onChange={(event) => setResponseSearch(event.target.value)} placeholder="Search response" /><span>{responseSearch ? `${searchMatches} matches` : ""}</span></label><button type="button" onClick={() => navigator.clipboard.writeText(response.body)}>Copy</button><button type="button" onClick={saveResponse}>Save</button></div>{responseView === "preview" ? <div className="response-preview">{response.content_type.startsWith("image/") ? <img src={`data:${response.content_type};base64,${response.body_base64}`} alt="Response preview" /> : response.content_type.includes("html") ? <iframe srcDoc={response.body} sandbox="" title="Response preview" /> : <div className="empty-state">Preview is available for HTML and image responses.</div>}</div> : <pre>{responseBody}</pre>}</>}
          {response && responseTab === "Headers" && <div className="response-headers">{response.headers.map((header, index) => <div key={`${header.name}-${index}`}><strong>{header.name}</strong><span>{header.value}</span></div>)}</div>}
          {response && responseTab === "Cookies" && <div className="response-cookies">{cookies.length ? cookies.map((cookie, index) => <div key={`${cookie.name}-${index}`}><strong>{cookie.name}</strong><span>{cookie.value}</span><small>{cookie.attributes || "No attributes"}</small></div>) : <div className="empty-state">This response did not set any cookies.</div>}</div>}
        </section>
      </section>
    </main>
  );
}

export default App;
