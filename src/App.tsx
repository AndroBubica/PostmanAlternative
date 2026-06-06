import { FormEvent, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

type RequestHeader = {
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

const methodColors: Record<string, string> = {
  GET: "method-get",
  POST: "method-post",
  PUT: "method-put",
  PATCH: "method-patch",
  DELETE: "method-delete",
};

function prettyBody(body: string) {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function App() {
  const [method, setMethod] = useState("GET");
  const [url, setUrl] = useState("https://jsonplaceholder.typicode.com/users/1");
  const [body, setBody] = useState('{\n  "name": "Ada",\n  "role": "developer"\n}');
  const [headers, setHeaders] = useState<RequestHeader[]>([
    { id: 1, name: "Accept", value: "application/json", enabled: true },
    { id: 2, name: "Content-Type", value: "application/json", enabled: true },
  ]);
  const [requestTab, setRequestTab] = useState("Body");
  const [responseTab, setResponseTab] = useState("Body");
  const [response, setResponse] = useState<ApiResponse | null>(null);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);

  const responseBody = useMemo(
    () => (response ? prettyBody(response.body) : ""),
    [response],
  );

  async function sendRequest(event: FormEvent) {
    event.preventDefault();
    setSending(true);
    setError("");
    try {
      const result = await invoke<ApiResponse>("send_request", {
        request: {
          method,
          url,
          headers,
          body: ["GET", "HEAD"].includes(method) ? null : body,
        },
      });
      setResponse(result);
      setResponseTab("Body");
    } catch (requestError) {
      setResponse(null);
      setError(String(requestError));
    } finally {
      setSending(false);
    }
  }

  function updateHeader(id: number, field: keyof RequestHeader, value: string | boolean) {
    setHeaders((current) =>
      current.map((header) => (header.id === id ? { ...header, [field]: value } : header)),
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">A</span>
          <strong>API Lantern</strong>
          <span className="local-pill">Local only</span>
        </div>
        <label className="environment">
          <span>Environment</span>
          <select aria-label="Active environment" defaultValue="Local">
            <option>Local</option>
            <option>Staging</option>
            <option>Production</option>
          </select>
        </label>
      </header>

      <aside className="sidebar">
        <div className="sidebar-actions">
          <button className="new-button" type="button">+ New request</button>
          <button className="icon-button" type="button" aria-label="More actions">...</button>
        </div>
        <input className="search" placeholder="Search requests..." aria-label="Search requests" />
        <nav aria-label="Collections">
          <p className="section-label">Collections</p>
          {requestGroups.map((group) => (
            <section className="collection" key={group.name}>
              <h2><span>⌄</span> {group.name}</h2>
              {group.requests.map((request) => (
                <button className="request-item" key={request.name} type="button">
                  <span className={methodColors[request.method]}>{request.method}</span>
                  {request.name}
                </button>
              ))}
            </section>
          ))}
        </nav>
        <div className="privacy-note">
          <strong>Your data stays here.</strong>
          <span>No account, cloud, or telemetry.</span>
        </div>
      </aside>

      <section className="workspace">
        <div className="request-tabs">
          <button className="open-tab active" type="button">
            <span className="method-get">GET</span>
            Service status
            <span className="unsaved-dot" aria-label="Unsaved changes" />
          </button>
          <button className="tab-add" type="button" aria-label="New tab">+</button>
        </div>

        <form className="request-panel" onSubmit={sendRequest}>
          <div className="request-line">
            <select value={method} onChange={(event) => setMethod(event.target.value)} aria-label="HTTP method">
              {["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>
            <input value={url} onChange={(event) => setUrl(event.target.value)} aria-label="Request URL" />
            <button className="send-button" disabled={sending} type="submit">
              {sending ? "Sending..." : "Send"}
            </button>
          </div>

          <div className="panel-tabs" role="tablist" aria-label="Request options">
            {["Params", "Headers", "Body", "Auth"].map((tab) => (
              <button
                className={requestTab === tab ? "active" : ""}
                key={tab}
                onClick={() => setRequestTab(tab)}
                role="tab"
                type="button"
              >
                {tab}{tab === "Headers" ? ` (${headers.filter((header) => header.enabled).length})` : ""}
              </button>
            ))}
          </div>

          <div className="request-editor">
            {requestTab === "Body" && (
              <>
                <div className="editor-toolbar">
                  <span>JSON</span>
                  <button type="button" onClick={() => setBody(prettyBody(body))}>Format</button>
                </div>
                <textarea value={body} onChange={(event) => setBody(event.target.value)} spellCheck={false} />
              </>
            )}
            {requestTab === "Headers" && (
              <div className="header-table">
                {headers.map((header) => (
                  <div className="header-row" key={header.id}>
                    <input
                      checked={header.enabled}
                      onChange={(event) => updateHeader(header.id, "enabled", event.target.checked)}
                      type="checkbox"
                      aria-label={`Enable ${header.name}`}
                    />
                    <input value={header.name} onChange={(event) => updateHeader(header.id, "name", event.target.value)} />
                    <input value={header.value} onChange={(event) => updateHeader(header.id, "value", event.target.value)} />
                  </div>
                ))}
                <button
                  className="add-row"
                  type="button"
                  onClick={() => setHeaders((current) => [...current, { id: Date.now(), name: "", value: "", enabled: true }])}
                >
                  + Add header
                </button>
              </div>
            )}
            {requestTab !== "Body" && requestTab !== "Headers" && (
              <div className="empty-state">{requestTab} editor arrives in the next milestone.</div>
            )}
          </div>
        </form>

        <section className="response-panel" aria-live="polite">
          <div className="response-heading">
            <div className="panel-tabs" role="tablist" aria-label="Response details">
              {["Body", "Headers"].map((tab) => (
                <button
                  className={responseTab === tab ? "active" : ""}
                  key={tab}
                  onClick={() => setResponseTab(tab)}
                  role="tab"
                  type="button"
                >
                  {tab}{tab === "Headers" && response ? ` (${response.headers.length})` : ""}
                </button>
              ))}
            </div>
            {response && (
              <div className="response-meta">
                <strong>{response.status} {response.status_text}</strong>
                <span>{response.elapsed_ms} ms</span>
                <span>{formatBytes(response.size_bytes)}</span>
              </div>
            )}
          </div>
          {error && <div className="error-box"><strong>Request failed</strong><span>{error}</span></div>}
          {!response && !error && <div className="empty-response">Send a request to see the response.</div>}
          {response && responseTab === "Body" && <pre>{responseBody}</pre>}
          {response && responseTab === "Headers" && (
            <div className="response-headers">
              {response.headers.map((header, index) => (
                <div key={`${header.name}-${index}`}><strong>{header.name}</strong><span>{header.value}</span></div>
              ))}
            </div>
          )}
        </section>
      </section>
    </main>
  );
}

export default App;
