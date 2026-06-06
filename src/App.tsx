import { FormEvent, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
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
};

type AuthType = "none" | "basic" | "bearer" | "api-key";
type BodyMode = "json" | "text" | "xml" | "form";
type ResponseView = "pretty" | "raw";

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

  function buildRequest() {
    const requestUrl = new URL(url);
    params.filter((row) => row.enabled && row.name).forEach((row) => requestUrl.searchParams.append(row.name, row.value));
    const requestHeaders = headers.map((header) => ({ ...header }));
    const contentTypes: Record<BodyMode, string> = {
      json: "application/json",
      text: "text/plain",
      xml: "application/xml",
      form: "application/x-www-form-urlencoded",
    };
    const contentType = requestHeaders.find((header) => header.name.toLowerCase() === "content-type");
    if (contentType) contentType.value = contentTypes[bodyMode];
    else requestHeaders.push({ id: -2, name: "Content-Type", value: contentTypes[bodyMode], enabled: true });

    if (authType === "basic") {
      requestHeaders.push({ id: -1, name: "Authorization", value: `Basic ${btoa(`${authFields.username}:${authFields.password}`)}`, enabled: true });
    } else if (authType === "bearer") {
      requestHeaders.push({ id: -1, name: "Authorization", value: `Bearer ${authFields.token}`, enabled: true });
    } else if (authType === "api-key" && authFields.key) {
      if (authFields.location === "query") requestUrl.searchParams.append(authFields.key, authFields.value);
      else requestHeaders.push({ id: -1, name: authFields.key, value: authFields.value, enabled: true });
    }

    let requestBody: string | null = body;
    if (["GET", "HEAD"].includes(method)) requestBody = null;
    if (requestBody !== null && bodyMode === "form") {
      requestBody = new URLSearchParams(
        formRows.filter((row) => row.enabled && row.name).map((row) => [row.name, row.value]),
      ).toString();
    }

    return { url: requestUrl.toString(), headers: requestHeaders, body: requestBody };
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
                  <div>{(["json", "text", "xml", "form"] as BodyMode[]).map((mode) => <button className={bodyMode === mode ? "active" : ""} key={mode} onClick={() => setBodyMode(mode)} type="button">{mode === "form" ? "Form URL Encoded" : mode.toUpperCase()}</button>)}</div>
                  {bodyMode === "json" && <button type="button" onClick={() => setBody(prettyBody(body))}>Format</button>}
                </div>
                {bodyMode === "form" ? <KeyValueTable rows={formRows} setRows={setFormRows} label="Field" /> : <textarea value={body} onChange={(event) => setBody(event.target.value)} spellCheck={false} />}
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
            <div className="panel-tabs" role="tablist" aria-label="Response details">{["Body", "Headers"].map((tab) => <button className={responseTab === tab ? "active" : ""} key={tab} onClick={() => setResponseTab(tab)} role="tab" type="button">{tab}{tab === "Headers" && response ? ` (${response.headers.length})` : ""}</button>)}</div>
            {response && <div className="response-meta"><strong className={response.status >= 400 ? "status-error" : ""}>{response.status} {response.status_text}</strong><span>{response.elapsed_ms} ms</span><span>{formatBytes(response.size_bytes)}</span></div>}
          </div>
          {error && <div className="error-box"><strong>Request failed</strong><span>{error}</span></div>}
          {!response && !error && <div className="empty-response">Send a request to see the response.</div>}
          {response && responseTab === "Body" && <><div className="response-tools"><div><button className={responseView === "pretty" ? "active" : ""} onClick={() => setResponseView("pretty")} type="button">Pretty</button><button className={responseView === "raw" ? "active" : ""} onClick={() => setResponseView("raw")} type="button">Raw</button></div><label><input value={responseSearch} onChange={(event) => setResponseSearch(event.target.value)} placeholder="Search response" /><span>{responseSearch ? `${searchMatches} matches` : ""}</span></label><button type="button" onClick={() => navigator.clipboard.writeText(response.body)}>Copy</button></div><pre>{responseBody}</pre></>}
          {response && responseTab === "Headers" && <div className="response-headers">{response.headers.map((header, index) => <div key={`${header.name}-${index}`}><strong>{header.name}</strong><span>{header.value}</span></div>)}</div>}
        </section>
      </section>
    </main>
  );
}

export default App;
