import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
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
type Collection = { id: string; name: string };
type Variable = { name: string; value: string; secret: boolean; enabled: boolean };
type Environment = { id: string; name: string; variables: Variable[] };
type HistoryEntry = {
  id: string;
  request_id: string | null;
  name: string;
  method: string;
  url: string;
  status: number | null;
  elapsed_ms: number | null;
  created_at: number;
};
type SavedRequest = {
  id: string;
  collectionId: string;
  name: string;
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
  timeoutMs: number;
  followRedirects: boolean;
  favorite: boolean;
};
type WorkspaceSnapshot = {
  root: string;
  portable: boolean;
  collections: Collection[];
  requests: SavedRequest[];
  environments: Environment[];
  history: HistoryEntry[];
};

const methodColors: Record<string, string> = {
  GET: "method-get",
  POST: "method-post",
  PUT: "method-put",
  PATCH: "method-patch",
  DELETE: "method-delete",
};

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
  const [requestId, setRequestId] = useState("");
  const [requestName, setRequestName] = useState("Untitled request");
  const [collectionId, setCollectionId] = useState("default");
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
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot | null>(null);
  const [activeEnvironmentId, setActiveEnvironmentId] = useState("");
  const [sidebarView, setSidebarView] = useState<"collections" | "history" | "environment">("collections");
  const [search, setSearch] = useState("");
  const [notice, setNotice] = useState("");
  const [saved, setSaved] = useState(true);
  const activeRequestId = useRef("");

  async function refreshWorkspace() {
    const loaded = await invoke<WorkspaceSnapshot>("load_workspace");
    setWorkspace(loaded);
    if (!activeEnvironmentId && loaded.environments.length) setActiveEnvironmentId(loaded.environments[0].id);
  }

  useEffect(() => {
    refreshWorkspace().catch((workspaceError) => setError(String(workspaceError)));
  }, []);

  const responseBody = useMemo(
    () => (responseView === "pretty" && response ? prettyBody(response.body) : response?.body ?? ""),
    [response, responseView],
  );
  const searchMatches = useMemo(() => {
    if (!responseSearch) return 0;
    return responseBody.toLowerCase().split(responseSearch.toLowerCase()).length - 1;
  }, [responseBody, responseSearch]);
  const cookies = useMemo(() => (response ? parseCookies(response.headers) : []), [response]);
  const activeEnvironment = workspace?.environments.find((environment) => environment.id === activeEnvironmentId);
  const visibleRequests = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (workspace?.requests ?? []).filter((request) =>
      !query || [request.name, request.url, request.method].some((value) => value.toLowerCase().includes(query)),
    );
  }, [search, workspace]);

  function resolveVariables(value: string) {
    const variables = new Map(
      (activeEnvironment?.variables ?? [])
        .filter((variable) => variable.enabled)
        .map((variable) => [variable.name, variable.value]),
    );
    const unresolved: string[] = [];
    const resolved = value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, name: string) => {
      if (!variables.has(name)) {
        unresolved.push(name);
        return `{{${name}}}`;
      }
      return variables.get(name) ?? "";
    });
    if (unresolved.length) throw new Error(`Unresolved variables: ${[...new Set(unresolved)].join(", ")}`);
    return resolved;
  }

  function buildRequest() {
    const requestUrl = new URL(resolveVariables(url));
    params.filter((row) => row.enabled && row.name).forEach((row) => requestUrl.searchParams.append(resolveVariables(row.name), resolveVariables(row.value)));
    const requestHeaders = headers.map((header) => ({ ...header, name: resolveVariables(header.name), value: resolveVariables(header.value) }));
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
    let requestBody: string | null = canHaveBody ? resolveVariables(body) : null;
    if (requestBody !== null && bodyMode === "form") {
      requestBody = new URLSearchParams(
        formRows.filter((row) => row.enabled && row.name).map((row) => [resolveVariables(row.name), resolveVariables(row.value)]),
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
      const entry: HistoryEntry = {
        id: crypto.randomUUID(),
        request_id: requestId || null,
        name: requestName,
        method,
        url,
        status: result.status,
        elapsed_ms: result.elapsed_ms,
        created_at: Date.now(),
      };
      await invoke("add_workspace_history", { entry });
      await refreshWorkspace();
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

  function currentRequest(): SavedRequest {
    return {
      id: requestId || crypto.randomUUID(),
      collectionId,
      name: requestName.trim() || "Untitled request",
      method,
      url,
      params,
      headers,
      body,
      bodyMode,
      formRows,
      multipartRows,
      binaryFile,
      authType,
      authFields,
      timeoutMs,
      followRedirects,
      favorite: false,
    };
  }

  async function saveRequest() {
    const request = currentRequest();
    await invoke("save_workspace_request", { request });
    setRequestId(request.id);
    setRequestName(request.name);
    setSaved(true);
    setNotice(`Saved "${request.name}".`);
    await refreshWorkspace();
  }

  function loadRequest(request: SavedRequest) {
    setRequestId(request.id);
    setCollectionId(request.collectionId);
    setRequestName(request.name);
    setMethod(request.method);
    setUrl(request.url);
    setParams(request.params);
    setHeaders(request.headers);
    setBody(request.body);
    setBodyMode(request.bodyMode);
    setFormRows(request.formRows);
    setMultipartRows(request.multipartRows);
    setBinaryFile(request.binaryFile);
    setAuthType(request.authType);
    setAuthFields({ username: "", password: "", token: "", key: "", value: "", location: "header", ...request.authFields });
    setTimeoutMs(request.timeoutMs);
    setFollowRedirects(request.followRedirects);
    setResponse(null);
    setError("");
    setSaved(true);
  }

  function newRequest() {
    setRequestId("");
    setRequestName("Untitled request");
    setMethod("GET");
    setUrl("https://");
    setParams([emptyRow()]);
    setHeaders([{ id: 1, name: "Accept", value: "application/json", enabled: true }]);
    setBody("");
    setResponse(null);
    setSaved(false);
  }

  async function createCollection() {
    const name = window.prompt("Collection name");
    if (!name?.trim()) return;
    const collection = await invoke<Collection>("create_workspace_collection", { name });
    setCollectionId(collection.id);
    await refreshWorkspace();
  }

  async function importFile() {
    const path = await open({ multiple: false, directory: false, filters: [{ name: "API files", extensions: ["json"] }] });
    if (!path) return;
    const result = await invoke<{ message: string }>("import_workspace_file", { path });
    setNotice(result.message);
    await refreshWorkspace();
  }

  async function importCurl() {
    const command = window.prompt("Paste a cURL command");
    if (!command?.trim()) return;
    const tokens = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((token) => token.replace(/^(['"])(.*)\1$/, "$2")) ?? [];
    let importedMethod = "GET";
    let importedUrl = "";
    let importedBody = "";
    const importedHeaders: KeyValueRow[] = [];
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if ((token === "-X" || token === "--request") && tokens[index + 1]) importedMethod = tokens[++index].toUpperCase();
      else if ((token === "-H" || token === "--header") && tokens[index + 1]) {
        const header = tokens[++index];
        const separator = header.indexOf(":");
        importedHeaders.push({ ...emptyRow(), name: header.slice(0, separator).trim(), value: header.slice(separator + 1).trim() });
      } else if (["-d", "--data", "--data-raw"].includes(token) && tokens[index + 1]) {
        importedBody = tokens[++index];
        if (importedMethod === "GET") importedMethod = "POST";
      } else if (/^https?:\/\//.test(token)) importedUrl = token;
    }
    if (!importedUrl) {
      setError("The cURL command does not contain an HTTP URL.");
      return;
    }
    newRequest();
    setRequestName("Imported cURL request");
    setMethod(importedMethod);
    setUrl(importedUrl);
    setHeaders(importedHeaders.length ? importedHeaders : [{ id: 1, name: "Accept", value: "application/json", enabled: true }]);
    setBody(importedBody);
    setNotice("Imported cURL into a new unsaved request.");
  }

  async function exportPortable() {
    const path = await save({ defaultPath: "api-lantern-portable-workspace.zip", filters: [{ name: "ZIP archive", extensions: ["zip"] }] });
    if (!path) return;
    await invoke("export_portable_workspace", { path });
    setNotice("Exported a portable workspace without secrets.");
  }

  async function addEnvironment() {
    const name = window.prompt("Environment name");
    if (!name?.trim()) return;
    const environment: Environment = { id: crypto.randomUUID(), name: name.trim(), variables: [] };
    await invoke("save_workspace_environment", { environment });
    setActiveEnvironmentId(environment.id);
    await refreshWorkspace();
    setSidebarView("environment");
  }

  async function updateEnvironment(environment: Environment) {
    await invoke("save_workspace_environment", { environment });
    setWorkspace((current) => current ? { ...current, environments: current.environments.map((item) => item.id === environment.id ? environment : item) } : current);
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
        <div className="brand"><span className="brand-mark">A</span><strong>API Lantern</strong><span className="local-pill">{workspace?.portable ? "Portable" : "Local only"}</span></div>
        <div className="top-actions">
          {notice && <span className="notice">{notice}</span>}
          <button type="button" onClick={importFile}>Import</button>
          <button type="button" onClick={importCurl}>cURL</button>
          <button type="button" onClick={exportPortable}>Portable ZIP</button>
          <label className="environment"><span>Environment</span><select aria-label="Active environment" value={activeEnvironmentId} onChange={(event) => setActiveEnvironmentId(event.target.value)}><option value="">No environment</option>{workspace?.environments.map((environment) => <option key={environment.id} value={environment.id}>{environment.name}</option>)}</select></label>
          <button type="button" onClick={() => setSidebarView("environment")}>Variables</button>
        </div>
      </header>

      <aside className="sidebar">
        <div className="sidebar-actions"><button className="new-button" onClick={newRequest} type="button">+ New request</button><button className="icon-button" onClick={createCollection} type="button" aria-label="New collection">+</button></div>
        <div className="sidebar-switcher"><button className={sidebarView === "collections" ? "active" : ""} onClick={() => setSidebarView("collections")} type="button">Collections</button><button className={sidebarView === "history" ? "active" : ""} onClick={() => setSidebarView("history")} type="button">History</button></div>
        {sidebarView === "collections" && <><input className="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search requests..." aria-label="Search requests" />
        <nav aria-label="Collections">
          {workspace?.collections.map((collection) => (
            <section className="collection" key={collection.id}>
              <h2><span>⌄</span> {collection.name}</h2>
              {visibleRequests.filter((request) => request.collectionId === collection.id).map((request) => <button className="request-item" key={request.id} onClick={() => loadRequest(request)} type="button"><span className={methodColors[request.method]}>{request.method}</span>{request.name}</button>)}
            </section>
          ))}
        </nav></>}
        {sidebarView === "history" && <nav aria-label="Request history"><p className="section-label">Recent requests</p>{workspace?.history.map((entry) => <button className="history-item" key={entry.id} onClick={() => { setMethod(entry.method); setUrl(entry.url); setRequestName(entry.name); }} type="button"><span className={methodColors[entry.method]}>{entry.method}</span><strong>{entry.name}</strong><small>{entry.status ?? "Failed"} · {new Date(entry.created_at).toLocaleString()}</small></button>)}</nav>}
        {sidebarView === "environment" && <div className="environment-editor"><div className="environment-heading"><strong>Variables</strong><button onClick={addEnvironment} type="button">+ Environment</button></div>{activeEnvironment ? <><p>{activeEnvironment.name}</p>{activeEnvironment.variables.map((variable, index) => <div className="variable-row" key={`${variable.name}-${index}`}><input aria-label="Enable variable" checked={variable.enabled} onChange={(event) => updateEnvironment({ ...activeEnvironment, variables: activeEnvironment.variables.map((item, itemIndex) => itemIndex === index ? { ...item, enabled: event.target.checked } : item) })} type="checkbox" /><input value={variable.name} onChange={(event) => updateEnvironment({ ...activeEnvironment, variables: activeEnvironment.variables.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item) })} placeholder="Name" /><input type={variable.secret ? "password" : "text"} value={variable.value} onChange={(event) => updateEnvironment({ ...activeEnvironment, variables: activeEnvironment.variables.map((item, itemIndex) => itemIndex === index ? { ...item, value: event.target.value } : item) })} placeholder="Value" /><button title="Toggle secret" onClick={() => updateEnvironment({ ...activeEnvironment, variables: activeEnvironment.variables.map((item, itemIndex) => itemIndex === index ? { ...item, secret: !item.secret } : item) })} type="button">{variable.secret ? "Masked" : "Plain"}</button></div>)}<button className="add-variable" onClick={() => updateEnvironment({ ...activeEnvironment, variables: [...activeEnvironment.variables, { name: "", value: "", secret: false, enabled: true }] })} type="button">+ Add variable</button></> : <div className="empty-state">Choose or create an environment.</div>}</div>}
        <div className="privacy-note"><strong>Your data stays here.</strong><span>No account, cloud, or telemetry.</span></div>
      </aside>

      <section className="workspace">
        <div className="request-tabs"><button className="open-tab active" type="button"><span className={methodColors[method]}>{method}</span>{requestName}{!saved && <span className="unsaved-dot" aria-label="Unsaved changes" />}</button><button className="tab-add" onClick={newRequest} type="button" aria-label="New tab">+</button></div>

        <form className="request-panel" onSubmit={sendRequest}>
          <div className="request-line">
            <input className="request-name" value={requestName} onChange={(event) => { setRequestName(event.target.value); setSaved(false); }} aria-label="Request name" />
            <select className="collection-select" value={collectionId} onChange={(event) => { setCollectionId(event.target.value); setSaved(false); }} aria-label="Collection">{workspace?.collections.map((collection) => <option key={collection.id} value={collection.id}>{collection.name}</option>)}</select>
            <select value={method} onChange={(event) => setMethod(event.target.value)} aria-label="HTTP method">{["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].map((item) => <option key={item}>{item}</option>)}</select>
            <input value={url} onChange={(event) => setUrl(event.target.value)} aria-label="Request URL" />
            <button className="save-button" onClick={saveRequest} type="button">Save</button>
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
