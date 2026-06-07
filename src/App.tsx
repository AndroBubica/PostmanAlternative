import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import "./App.css";
import {
  assertionError,
  assertionOperators,
  assertionResults as evaluateAssertions,
  buildRequest as buildSharedRequest,
  parseCurl,
  reportContents,
  requestToCurl,
} from "./interface";

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
type RequestAssertion = {
  id: string;
  kind: "status" | "header" | "json-path" | "response-time" | "body";
  operator: "equals" | "not-equals" | "contains" | "exists" | "less-than";
  target: string;
  expected: string;
  enabled: boolean;
};
type Collection = { id: string; name: string; parentId?: string; variables: Variable[] };
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
  request_snapshot?: SavedRequest;
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
  preRequestScript: string;
  postResponseScript: string;
  scriptsEnabled: boolean;
  assertions: RequestAssertion[];
};
type WorkspaceSnapshot = {
  root: string;
  portable: boolean;
  collections: Collection[];
  requests: SavedRequest[];
  environments: Environment[];
  history: HistoryEntry[];
  settings: { historyLimit: number; logLimitMb: number; autosave: boolean };
  global_variables: Variable[];
};
type DeletedCollectionSnapshot = { collections: Collection[]; requests: SavedRequest[] };

type OpenTab = {
  key: string;
  request: SavedRequest;
  response: ApiResponse | null;
  error: string;
  testResults: TestResult[];
  responseTab: string;
  responseView: ResponseView;
  responseTree: boolean;
  responseSearch: string;
  requestTab: string;
  saved: boolean;
};
type UndoAction = { message: string; run: () => Promise<void> };
type TestResult = { name: string; passed: boolean; message: string };
type RunItem = { request_id: string; name: string; method: string; url: string; status: number | null; elapsed_ms: number; tests: TestResult[]; error: string };
type RunReport = { collection: string; started_at: string; elapsed_ms: number; passed: number; failed: number; items: RunItem[] };

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

function JsonTree({ value, name }: { value: unknown; name?: string }) {
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return <details open className="json-node"><summary>{name && <strong>{name}: </strong>}{Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`}</summary>{entries.map(([key, child]) => <JsonTree key={key} name={key} value={child} />)}</details>;
  }
  return <div className="json-leaf">{name && <strong>{name}: </strong>}<span className={`json-${value === null ? "null" : typeof value}`}>{JSON.stringify(value)}</span></div>;
}

function HighlightedJson({ body }: { body: string }) {
  const highlighted = body.replace(/(&|<|>)/g, (value) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[value]!)
    .replace(/("(?:\\u[\da-fA-F]{4}|\\[^u]|[^\\"])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, (match, string, key) => `<span class="${key ? "json-key" : string ? "json-string" : /true|false/.test(match) ? "json-boolean" : /null/.test(match) ? "json-null" : "json-number"}">${match}</span>`);
  return <pre dangerouslySetInnerHTML={{ __html: highlighted }} />;
}

function JsonTreeBody({ body }: { body: string }) {
  try {
    return <div className="json-tree"><JsonTree value={JSON.parse(body)} /></div>;
  } catch {
    return <pre>{body}</pre>;
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
  const [favorite, setFavorite] = useState(false);
  const [preRequestScript, setPreRequestScript] = useState("");
  const [postResponseScript, setPostResponseScript] = useState("");
  const [scriptsEnabled, setScriptsEnabled] = useState(false);
  const [assertions, setAssertions] = useState<RequestAssertion[]>([]);
  const [testResults, setTestResults] = useState<TestResult[]>([]);
  const [runReport, setRunReport] = useState<RunReport | null>(null);
  const [runningCollection, setRunningCollection] = useState(false);
  const [runnerProgress, setRunnerProgress] = useState("");
  const [openTabs, setOpenTabs] = useState<OpenTab[]>([]);
  const [activeTabKey, setActiveTabKey] = useState("");
  const [temporaryVariables, setTemporaryVariables] = useState<Variable[]>([]);
  const [variableScope, setVariableScope] = useState<"temporary" | "environment" | "collection" | "global">("environment");
  const [vaultEntries, setVaultEntries] = useState<Record<string, string> | null>(null);
  const [undoAction, setUndoAction] = useState<UndoAction | null>(null);
  const [responseTree, setResponseTree] = useState(false);
  const [pendingWrites, setPendingWrites] = useState(0);
  const [collapsedCollections, setCollapsedCollections] = useState<Set<string>>(() => new Set(JSON.parse(localStorage.getItem("collapsedCollections") ?? "[]")));
  const skipDirty = useRef(true);
  const activeRequestId = useRef("");
  const runnerCancelled = useRef(false);
  const workspaceWriteQueue = useRef<Promise<unknown>>(Promise.resolve());

  function queueWorkspaceWrite<T>(write: () => Promise<T>) {
    const queued = workspaceWriteQueue.current.then(write, write);
    workspaceWriteQueue.current = queued.catch(() => undefined);
    return queued;
  }

  async function refreshWorkspace() {
    const loaded = await invoke<WorkspaceSnapshot>("load_workspace");
    setWorkspace(loaded);
    if (!activeEnvironmentId && loaded.environments.length) setActiveEnvironmentId(loaded.environments[0].id);
  }

  useEffect(() => {
    refreshWorkspace().catch((workspaceError) => setError(String(workspaceError)));
  }, []);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!saved || pendingWrites > 0) event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [saved, pendingWrites]);

  useEffect(() => {
    if (skipDirty.current) {
      skipDirty.current = false;
      return;
    }
    setSaved(false);
  }, [requestName, collectionId, method, url, body, bodyMode, params, headers, formRows, multipartRows, binaryFile, authType, authFields, timeoutMs, followRedirects, favorite, preRequestScript, postResponseScript, scriptsEnabled, assertions]);

  useEffect(() => {
    if (saved || !requestId || !workspace?.settings.autosave) return;
    const timer = window.setTimeout(() => {
      const request = currentRequest();
      setPendingWrites((count) => count + 1);
      invoke("save_workspace_request", { request }).then(() => {
        setSaved(true);
        setNotice(`Autosaved "${request.name}".`);
        refreshWorkspace().catch(() => undefined);
      }).catch((saveError) => setError(String(saveError))).finally(() => setPendingWrites((count) => count - 1));
    }, 900);
    return () => window.clearTimeout(timer);
  }, [saved, requestId, workspace?.settings.autosave]);

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      const modifier = event.metaKey || event.ctrlKey;
      if (modifier && event.key.toLowerCase() === "s") { event.preventDefault(); saveRequest().catch((saveError) => setError(String(saveError))); }
      if (modifier && event.key.toLowerCase() === "n") { event.preventDefault(); newRequest(); }
      if (modifier && event.key === "Enter") { event.preventDefault(); document.querySelector<HTMLFormElement>(".request-panel")?.requestSubmit(); }
      if (modifier && event.key.toLowerCase() === "f") { event.preventDefault(); document.querySelector<HTMLInputElement>(".search")?.focus(); }
      if (modifier && event.key === "Tab" && openTabs.length) {
        event.preventDefault();
        const index = openTabs.findIndex((tab) => tab.key === activeTabKey);
        switchTab(openTabs[(index + (event.shiftKey ? -1 : 1) + openTabs.length) % openTabs.length]);
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  });

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
  const activeCollection = workspace?.collections.find((collection) => collection.id === collectionId);
  const scopedVariables = useMemo(() => {
    const result = new Map<string, { variable: Variable; source: string }>();
    const add = (variables: Variable[], source: string) => variables.filter((variable) => variable.enabled && variable.name).forEach((variable) => result.set(variable.name, { variable, source }));
    add(workspace?.global_variables ?? [], "Global");
    add(activeCollection?.variables ?? [], `Collection: ${activeCollection?.name}`);
    add(activeEnvironment?.variables ?? [], `Environment: ${activeEnvironment?.name}`);
    add(temporaryVariables, "Temporary");
    return result;
  }, [workspace, activeCollection, activeEnvironment, temporaryVariables]);
  const urlVariables = useMemo(() => [...url.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map((match) => ({ name: match[1], source: scopedVariables.get(match[1])?.source })), [url, scopedVariables]);
  const visibleRequests = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (workspace?.requests ?? []).filter((request) =>
      !query || [request.name, request.url, request.method].some((value) => value.toLowerCase().includes(query)),
    );
  }, [search, workspace]);

  function buildRequest() {
    return buildSharedRequest(currentRequest(), variableValues());
  }

  function runSandboxScript(
    script: string,
    context: { request: Record<string, unknown>; response: ApiResponse | null; variables: Record<string, string> },
  ): Promise<{ request: Record<string, unknown>; variables: Record<string, string>; tests: TestResult[] }> {
    const workerSource = `
      const ScriptFunction = Function;
      self.fetch = undefined; self.XMLHttpRequest = undefined; self.WebSocket = undefined; self.EventSource = undefined;
      self.WebTransport = undefined; self.Worker = undefined; self.SharedWorker = undefined; self.importScripts = undefined;
      self.indexedDB = undefined; self.caches = undefined; self.eval = undefined; self.Function = undefined;
      self.onmessage = ({ data }) => {
        const tests = [];
        const lantern = {
          setVariable(name, value) { data.variables[String(name)] = String(value); },
          getVariable(name) { return data.variables[String(name)]; },
          test(name, fn) {
            try { fn(); tests.push({ name: String(name), passed: true, message: "" }); }
            catch (error) { tests.push({ name: String(name), passed: false, message: String(error?.message || error) }); }
          },
          expect(value) {
            return {
              toEqual(expected) { if (value !== expected) throw new Error(JSON.stringify(value) + " did not equal " + JSON.stringify(expected)); },
              toContain(expected) { if (!String(value).includes(String(expected))) throw new Error(JSON.stringify(value) + " did not contain " + JSON.stringify(expected)); },
              toBeLessThan(expected) { if (!(Number(value) < Number(expected))) throw new Error(value + " was not less than " + expected); }
            };
          }
        };
        try {
          ScriptFunction("lantern", "request", "response", "variables", '"use strict";\\n' + data.script)(lantern, data.request, data.response, data.variables);
          self.postMessage({ request: data.request, variables: data.variables, tests });
        } catch (error) {
          self.postMessage({ error: String(error?.message || error), request: data.request, variables: data.variables, tests });
        }
      };
    `;
    return new Promise((resolve, reject) => {
      const objectUrl = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
      const worker = new Worker(objectUrl);
      const timeout = window.setTimeout(() => {
        worker.terminate();
        URL.revokeObjectURL(objectUrl);
        reject(new Error("Script stopped after the 1 second sandbox limit."));
      }, 1000);
      worker.onmessage = (event) => {
        window.clearTimeout(timeout);
        worker.terminate();
        URL.revokeObjectURL(objectUrl);
        if (event.data.error) reject(new Error(event.data.error));
        else resolve(event.data);
      };
      worker.onerror = (event) => {
        window.clearTimeout(timeout);
        worker.terminate();
        URL.revokeObjectURL(objectUrl);
        reject(new Error(event.message));
      };
      worker.postMessage({ script, ...context });
    });
  }

  function variableValues(requestCollectionId = collectionId) {
    const values: Record<string, string> = {};
    const add = (variables: Variable[]) => variables.filter((variable) => variable.enabled && variable.name).forEach((variable) => {
      values[variable.name] = variable.secret && vaultEntries?.[variable.name] !== undefined ? vaultEntries[variable.name] : variable.value;
    });
    add(workspace?.global_variables ?? []);
    add(workspace?.collections.find((item) => item.id === requestCollectionId)?.variables ?? []);
    add(activeEnvironment?.variables ?? []);
    add(temporaryVariables);
    return values;
  }

  const assertionResults = evaluateAssertions;

  async function sendRequest(event: FormEvent) {
    event.preventDefault();
    if (runningCollection) {
      setError("Cancel or finish the collection run before sending another request.");
      return;
    }
    setSending(true);
    setError("");
    const transportRequestId = crypto.randomUUID();
    activeRequestId.current = transportRequestId;
    try {
      const invalid = assertions.map(assertionError).filter(Boolean);
      if (invalid.length) throw new Error(`Fix assertions before sending: ${invalid.join(" ")}`);
      let built = buildRequest();
      let scriptResults: TestResult[] = [];
      if (scriptsEnabled && preRequestScript.trim()) {
        try {
          const scripted = await runSandboxScript(preRequestScript, { request: built, response: null, variables: variableValues() });
          built = scripted.request as typeof built;
          scriptResults = scripted.tests.map((test) => ({ ...test, name: `Pre-request: ${test.name}` }));
        } catch (scriptError) {
          scriptResults = [{ name: "Pre-request script", passed: false, message: String(scriptError) }];
        }
      }
      const result = await invoke<ApiResponse>("send_request", {
        request: {
          id: transportRequestId,
          method,
          ...built,
          timeout_ms: timeoutMs,
          follow_redirects: followRedirects,
        },
      });
      setResponse(result);
      let results = [...scriptResults, ...assertionResults(assertions, result)];
      if (scriptsEnabled && postResponseScript.trim()) {
        try {
          const scripted = await runSandboxScript(postResponseScript, { request: built, response: result, variables: variableValues() });
          results = [...results, ...scripted.tests.map((test) => ({ ...test, name: `Post-response: ${test.name}` }))];
        } catch (scriptError) {
          results = [...results, { name: "Post-response script", passed: false, message: String(scriptError) }];
        }
      }
      setTestResults(results);
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
        request_snapshot: currentRequest(),
      };
      await invoke("add_workspace_history", { entry });
      await refreshWorkspace();
    } catch (requestError) {
      if (!response) setTestResults([]);
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
      favorite,
      preRequestScript,
      postResponseScript,
      scriptsEnabled,
      assertions,
    };
  }

  async function saveRequest() {
    const request = currentRequest();
    setPendingWrites((count) => count + 1);
    try { await invoke("save_workspace_request", { request }); }
    finally { setPendingWrites((count) => count - 1); }
    setRequestId(request.id);
    setRequestName(request.name);
    setSaved(true);
    setNotice(`Saved "${request.name}".`);
    await refreshWorkspace();
  }

  function activeSnapshotTab(): OpenTab {
    return {
      key: crypto.randomUUID(), request: currentRequest(), response, error, testResults,
      responseTab, responseView, responseTree, responseSearch, requestTab, saved,
    };
  }

  function loadRequest(request: SavedRequest) {
    if (activeTabKey) captureActiveTab();
    const existing = openTabs.find((tab) => tab.request.id === request.id);
    if (existing) {
      if (existing.key === activeTabKey) return;
      switchTab(existing);
      return;
    }
    const tab: OpenTab = {
      key: crypto.randomUUID(), request, response: null, error: "", testResults: [],
      responseTab: "Body", responseView: "pretty", responseTree: false, responseSearch: "", requestTab: "Body", saved: true,
    };
    setOpenTabs((current) => current.length ? [...current, tab] : [activeSnapshotTab(), tab]);
    setActiveTabKey(tab.key);
    applyRequest(tab);
  }

  function applyRequest(tab: OpenTab) {
    const { request } = tab;
    skipDirty.current = true;
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
    setFavorite(request.favorite);
    setPreRequestScript(request.preRequestScript ?? "");
    setPostResponseScript(request.postResponseScript ?? "");
    setScriptsEnabled(request.scriptsEnabled ?? false);
    setAssertions(request.assertions ?? []);
    setTestResults(tab.testResults);
    setResponse(tab.response);
    setError(tab.error);
    setResponseTab(tab.responseTab);
    setResponseView(tab.responseView);
    setResponseTree(tab.responseTree);
    setResponseSearch(tab.responseSearch);
    setRequestTab(tab.requestTab);
    setSaved(tab.saved);
  }

  function captureActiveTab() {
    if (!activeTabKey) return;
    const request = currentRequest();
    setOpenTabs((current) => current.map((tab) => tab.key === activeTabKey ? {
      ...tab, request, response, error, testResults, responseTab, responseView, responseTree, responseSearch, requestTab, saved,
    } : tab));
  }

  function switchTab(tab: OpenTab) {
    captureActiveTab();
    setActiveTabKey(tab.key);
    applyRequest(tab);
  }

  function newRequest() {
    captureActiveTab();
    const blank: SavedRequest = {
      id: crypto.randomUUID(), collectionId: "default", name: "Untitled request", method: "GET", url: "https://",
      params: [emptyRow()], headers: [{ id: 1, name: "Accept", value: "application/json", enabled: true }],
      body: "", bodyMode: "json", formRows: [emptyRow()], multipartRows: [emptyMultipartRow()], binaryFile: "",
      authType: "none", authFields: {}, timeoutMs: 30000, followRedirects: true, favorite: false,
      preRequestScript: "", postResponseScript: "", scriptsEnabled: false, assertions: [],
    };
    const tab: OpenTab = {
      key: crypto.randomUUID(), request: blank, response: null, error: "", testResults: [],
      responseTab: "Body", responseView: "pretty", responseTree: false, responseSearch: "", requestTab: "Body", saved: false,
    };
    setOpenTabs((current) => current.length ? [...current, tab] : [activeSnapshotTab(), tab]);
    setActiveTabKey(tab.key);
    applyRequest(tab);
    setRequestId("");
    setRequestName("Untitled request");
    setMethod("GET");
    setUrl("https://");
    setParams([emptyRow()]);
    setHeaders([{ id: 1, name: "Accept", value: "application/json", enabled: true }]);
    setBody("");
    setResponse(null);
    setFavorite(false);
    setPreRequestScript("");
    setPostResponseScript("");
    setScriptsEnabled(false);
    setAssertions([]);
    setTestResults([]);
    setSaved(false);
  }

  function closeTab(key: string) {
    const closing = openTabs.find((tab) => tab.key === key);
    const closingSaved = key === activeTabKey ? saved : closing?.saved;
    if ((closingSaved === false || pendingWrites > 0) && !window.confirm("Close this tab and discard its unsaved or pending changes?")) return;
    const remaining = openTabs.filter((tab) => tab.key !== key);
    setOpenTabs(remaining);
    if (key === activeTabKey) {
      const next = remaining[remaining.length - 1];
      if (next) switchTab(next);
      else newRequest();
    }
  }

  async function createCollection(parentId?: string) {
    const name = window.prompt(parentId ? "Folder name" : "Collection name");
    if (!name?.trim()) return;
    const collection = await invoke<Collection>("create_workspace_collection", { name, parentId });
    setCollectionId(collection.id);
    await refreshWorkspace();
  }

  async function renameCollection(collection: Collection) {
    const name = window.prompt("Rename collection folder", collection.name);
    if (!name?.trim() || name.trim() === collection.name) return;
    await invoke("save_workspace_collection", { collection: { ...collection, name: name.trim() } });
    await refreshWorkspace();
  }

  function collectionPath(collection: Collection) {
    const names = [collection.name];
    let parentId = collection.parentId;
    while (parentId) {
      const parent = workspace?.collections.find((item) => item.id === parentId);
      if (!parent) break;
      names.unshift(parent.name);
      parentId = parent.parentId;
    }
    return names.join(" / ");
  }

  async function moveCollection(collection: Collection) {
    if (!workspace || collection.id === "default") return;
    const descendantIds = new Set<string>([collection.id]);
    let changed = true;
    while (changed) {
      changed = false;
      workspace.collections.forEach((candidate) => {
        if (candidate.parentId && descendantIds.has(candidate.parentId) && !descendantIds.has(candidate.id)) {
          descendantIds.add(candidate.id);
          changed = true;
        }
      });
    }
    const destinations = workspace.collections.filter((candidate) => !descendantIds.has(candidate.id));
    const choices = ["Top level", ...destinations.map(collectionPath)];
    const answer = window.prompt(`Move "${collection.name}" to:\n${choices.map((choice, index) => `${index}: ${choice}`).join("\n")}`, "0");
    if (answer === null) return;
    const index = Number(answer);
    if (!Number.isInteger(index) || index < 0 || index >= choices.length) {
      setError("Choose a destination number from the move-folder list.");
      return;
    }
    const parentId = index === 0 ? undefined : destinations[index - 1].id;
    await invoke("save_workspace_collection", { collection: { ...collection, parentId } });
    setNotice(`Moved "${collection.name}" to ${choices[index]}.`);
    await refreshWorkspace();
  }

  async function deleteCollection(collection: Collection) {
    if (!window.confirm(`Delete "${collection.name}" and every request and folder inside it?`)) return;
    const snapshot = await invoke<DeletedCollectionSnapshot>("delete_workspace_collection", { collectionId: collection.id });
    const deletedRequestIds = new Set(snapshot.requests.map((request) => request.id));
    setOpenTabs((current) => current.filter((tab) => !deletedRequestIds.has(tab.request.id)));
    if (deletedRequestIds.has(requestId)) newRequest();
    if (collectionId === collection.id) setCollectionId("default");
    setNotice(`Deleted "${collection.name}".`);
    setUndoAction({ message: `Restore "${collection.name}"`, run: async () => {
      await invoke("restore_workspace_collection", { snapshot });
      await refreshWorkspace();
    } });
    await refreshWorkspace();
  }

  async function duplicateRequest(request: SavedRequest) {
    const duplicate = { ...request, id: crypto.randomUUID(), name: `${request.name} copy` };
    await invoke("save_workspace_request", { request: duplicate });
    setNotice(`Duplicated "${request.name}".`);
    await refreshWorkspace();
  }

  async function deleteRequest(request: SavedRequest) {
    if (!window.confirm(`Delete "${request.name}"?`)) return;
    await invoke("delete_workspace_request", { requestId: request.id });
    if (requestId === request.id) newRequest();
    setOpenTabs((current) => current.filter((tab) => tab.request.id !== request.id));
    setNotice(`Deleted "${request.name}".`);
    setUndoAction({ message: `Restore "${request.name}"`, run: async () => {
      await invoke("save_workspace_request", { request });
      await refreshWorkspace();
    } });
    await refreshWorkspace();
  }

  async function toggleFavorite(request: SavedRequest) {
    await invoke("save_workspace_request", { request: { ...request, favorite: !request.favorite } });
    if (requestId === request.id) setFavorite(!request.favorite);
    await refreshWorkspace();
  }

  function toggleCollection(id: string) {
    setCollapsedCollections((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      localStorage.setItem("collapsedCollections", JSON.stringify([...next]));
      return next;
    });
  }

  async function moveRequest(request: SavedRequest) {
    if (!workspace) return;
    const choices = workspace.collections.map(collectionPath);
    const answer = window.prompt(`Move "${request.name}" to:\n${choices.map((choice, index) => `${index}: ${choice}`).join("\n")}`, String(Math.max(0, workspace.collections.findIndex((item) => item.id === request.collectionId))));
    if (answer === null) return;
    const index = Number(answer);
    if (!Number.isInteger(index) || !workspace.collections[index]) {
      setError("Choose a destination number from the move-request list.");
      return;
    }
    await invoke("save_workspace_request", { request: { ...request, collectionId: workspace.collections[index].id } });
    setNotice(`Moved "${request.name}" to ${choices[index]}.`);
    await refreshWorkspace();
  }

  function buildSavedRequest(request: SavedRequest) {
    return buildSharedRequest(request, variableValues(request.collectionId));
  }

  async function runCollection(collection: Collection) {
    if (!workspace || runningCollection) return;
    runnerCancelled.current = false;
    setRunningCollection(true);
    setError("");
    setResponseTab("Runner");
    const started = performance.now();
    const ids = new Set([collection.id]);
    let changed = true;
    while (changed) {
      changed = false;
      workspace.collections.forEach((candidate) => {
        if (candidate.parentId && ids.has(candidate.parentId) && !ids.has(candidate.id)) { ids.add(candidate.id); changed = true; }
      });
    }
    try {
      const items: RunItem[] = [];
      const requests = workspace.requests.filter((request) => ids.has(request.collectionId));
      for (const [index, savedRequest] of requests.entries()) {
        if (runnerCancelled.current) break;
        setRunnerProgress(`${index + 1}/${requests.length}: ${savedRequest.name}`);
        const itemStarted = performance.now();
        try {
          let built = buildSavedRequest(savedRequest);
          let scriptTests: TestResult[] = [];
          if (savedRequest.scriptsEnabled && savedRequest.preRequestScript?.trim()) {
            try {
              const scripted = await runSandboxScript(savedRequest.preRequestScript, { request: built, response: null, variables: variableValues(savedRequest.collectionId) });
              built = scripted.request as typeof built;
              scriptTests = scripted.tests.map((test) => ({ ...test, name: `Pre-request: ${test.name}` }));
            } catch (scriptError) {
              scriptTests = [{ name: "Pre-request script", passed: false, message: String(scriptError) }];
            }
          }
          const transportId = crypto.randomUUID();
          activeRequestId.current = transportId;
          const result = await invoke<ApiResponse>("send_request", { request: { id: transportId, method: savedRequest.method, ...built, timeout_ms: savedRequest.timeoutMs, follow_redirects: savedRequest.followRedirects } });
          let tests = [...scriptTests, ...assertionResults(savedRequest.assertions ?? [], result)];
          if (savedRequest.scriptsEnabled && savedRequest.postResponseScript?.trim()) {
            try {
              const scripted = await runSandboxScript(savedRequest.postResponseScript, { request: built, response: result, variables: variableValues(savedRequest.collectionId) });
              tests = [...tests, ...scripted.tests.map((test) => ({ ...test, name: `Post-response: ${test.name}` }))];
            } catch (scriptError) {
              tests = [...tests, { name: "Post-response script", passed: false, message: String(scriptError) }];
            }
          }
          items.push({ request_id: savedRequest.id, name: savedRequest.name, method: savedRequest.method, url: built.url, status: result.status, elapsed_ms: result.elapsed_ms, tests, error: "" });
        } catch (runError) {
          items.push({ request_id: savedRequest.id, name: savedRequest.name, method: savedRequest.method, url: savedRequest.url, status: null, elapsed_ms: Math.round(performance.now() - itemStarted), tests: [], error: String(runError) });
        }
      }
      const passed = items.filter((item) => !item.error && item.tests.every((test) => test.passed)).length;
      setRunReport({ collection: collectionPath(collection), started_at: new Date().toISOString(), elapsed_ms: Math.round(performance.now() - started), passed, failed: items.length - passed, items });
    } catch (runError) {
      setError(String(runError));
    } finally {
      activeRequestId.current = "";
      setRunnerProgress("");
      setRunningCollection(false);
    }
  }

  async function cancelCollectionRun() {
    runnerCancelled.current = true;
    await cancelRequest();
  }

  async function exportRunReport(format: "json" | "junit") {
    if (!runReport) return;
    const path = await save({ defaultPath: `api-lantern-report.${format === "junit" ? "xml" : "json"}` });
    if (!path) return;
    const contents = reportContents(runReport, format);
    await invoke("save_text_file", { path, contents });
    setNotice(`Saved ${format.toUpperCase()} report.`);
  }

  function renderCollection(collection: Collection, depth = 0): React.ReactNode {
    const requests = visibleRequests.filter((request) => request.collectionId === collection.id);
    const children = workspace?.collections.filter((item) => item.parentId === collection.id) ?? [];
    return (
      <section className="collection" key={collection.id} style={{ marginLeft: `${depth * 10}px` }}>
        <div className="collection-heading">
          <h2><button className="collection-toggle" type="button" aria-expanded={!collapsedCollections.has(collection.id)} onClick={() => toggleCollection(collection.id)}>{collapsedCollections.has(collection.id) ? "›" : "⌄"}</button> {collection.name}</h2>
          <div className="collection-actions">
            <button type="button" disabled={runningCollection} title="Run collection" aria-label={`Run ${collection.name}`} onClick={() => runCollection(collection)}>▶</button>
            <button type="button" title="New nested folder" aria-label={`New folder in ${collection.name}`} onClick={() => createCollection(collection.id)}>+</button>
            <button type="button" title="Rename" aria-label={`Rename ${collection.name}`} onClick={() => renameCollection(collection)}>✎</button>
            {collection.id !== "default" && <button type="button" title="Move folder" aria-label={`Move ${collection.name}`} onClick={() => moveCollection(collection)}>↪</button>}
            {collection.id !== "default" && <button type="button" title="Delete" aria-label={`Delete ${collection.name}`} onClick={() => deleteCollection(collection)}>×</button>}
          </div>
        </div>
        {!collapsedCollections.has(collection.id) && requests.map((request) => (
          <div className="request-item-row" key={request.id}>
            <button className="request-item" onClick={() => loadRequest(request)} type="button"><span className={methodColors[request.method]}>{request.method}</span>{request.name}</button>
            <div className="request-actions">
              <button type="button" title={request.favorite ? "Remove favorite" : "Add favorite"} aria-label={request.favorite ? `Remove ${request.name} from favorites` : `Add ${request.name} to favorites`} onClick={() => toggleFavorite(request)}>{request.favorite ? "★" : "☆"}</button>
              <button type="button" title="Duplicate" aria-label={`Duplicate ${request.name}`} onClick={() => duplicateRequest(request)}>⧉</button>
              <button type="button" title="Move" aria-label={`Move ${request.name}`} onClick={() => moveRequest(request)}>↪</button>
              <button type="button" title="Delete" aria-label={`Delete ${request.name}`} onClick={() => deleteRequest(request)}>×</button>
            </div>
          </div>
        ))}
        {!collapsedCollections.has(collection.id) && children.map((child) => renderCollection(child, depth + 1))}
      </section>
    );
  }

  async function importFile() {
    const path = await open({ multiple: false, directory: false, filters: [{ name: "API files", extensions: ["json", "yaml", "yml"] }] });
    if (!path) return;
    const result = await invoke<{ message: string }>("import_workspace_file", { path });
    setNotice(result.message);
    await refreshWorkspace();
  }

  async function importCurl() {
    const command = window.prompt("Paste a cURL command");
    if (!command?.trim()) return;
    const imported = parseCurl(command, emptyRow);
    if (!imported.url) {
      setError("The cURL command does not contain an HTTP URL.");
      return;
    }
    newRequest();
    setRequestName("Imported cURL request");
    setMethod(imported.method);
    setUrl(imported.url);
    setHeaders(imported.headers.length ? imported.headers : [{ id: 1, name: "Accept", value: "application/json", enabled: true }]);
    setBody(imported.body);
    setBodyMode(imported.bodyMode);
    setFormRows(imported.formRows.length ? imported.formRows : [emptyRow()]);
    setMultipartRows(imported.multipartRows.length ? imported.multipartRows : [emptyMultipartRow()]);
    setBinaryFile(imported.binaryFile);
    setAuthType(imported.authType);
    setAuthFields((current) => ({ ...current, ...imported.authFields }));
    setNotice(imported.warnings.length ? `Imported cURL. Unsupported options: ${imported.warnings.join(", ")}` : "Imported cURL into a new unsaved request.");
  }

  async function exportPortable() {
    const path = await save({ defaultPath: "api-lantern-portable-workspace.zip", filters: [{ name: "ZIP archive", extensions: ["zip"] }] });
    if (!path) return;
    await invoke("export_portable_workspace", { path });
    setNotice("Exported a portable workspace without secrets.");
  }

  function generateCurl() {
    try {
      navigator.clipboard.writeText(requestToCurl(method, buildRequest())).then(() => setNotice("Copied cURL command.")).catch((copyError) => setError(String(copyError)));
    } catch (curlError) { setError(String(curlError)); }
  }

  async function unlockVault() {
    const password = window.prompt("Vault password");
    if (!password) return;
    const entries = await invoke<Record<string, string>>("unlock_vault", { password });
    setVaultEntries(entries);
    setNotice("Secret vault unlocked.");
  }

  async function lockVault() {
    await invoke("lock_vault");
    setVaultEntries(null);
    setNotice("Secret vault locked.");
  }

  async function saveVaultEntry(name: string, value: string) {
    setVaultEntries((current) => ({ ...current, [name]: value }));
    const entries = await queueWorkspaceWrite(() => invoke<Record<string, string>>("mutate_vault_entry", { operation: "set", oldName: name, newName: name, value }));
    setVaultEntries(entries);
  }

  async function renameVariable(index: number, name: string) {
    const variable = variablesForScope()[index];
    if (!variable || variable.name === name) return;
    if (variable.secret && !vaultEntries) {
      setError("Unlock the vault before renaming a secret.");
      return;
    }
    const variables = variablesForScope().map((item, itemIndex) => itemIndex === index ? { ...item, name } : item);
    const metadataWrite = updateVariables(variableScope, variables);
    if (variable.secret) {
      setVaultEntries((current) => {
        const entries = { ...current };
        if (variable.name in entries) {
          entries[name] = entries[variable.name];
          delete entries[variable.name];
        }
        return entries;
      });
      const entries = await queueWorkspaceWrite(() => invoke<Record<string, string>>("mutate_vault_entry", { operation: "rename", oldName: variable.name, newName: name, value: "" }));
      setVaultEntries(entries);
    }
    await metadataWrite;
  }

  async function updateVariables(scope: typeof variableScope, variables: Variable[]) {
    if (scope === "temporary") {
      setTemporaryVariables(variables);
      return;
    }
    if (!workspace) return;
    if (scope === "environment" && activeEnvironment) {
      const environment = { ...activeEnvironment, variables };
      setWorkspace((current) => current ? { ...current, environments: current.environments.map((item) => item.id === environment.id ? environment : item) } : current);
      await queueWorkspaceWrite(() => invoke("save_workspace_environment", { environment }));
    }
    if (scope === "collection" && activeCollection) {
      const collection = { ...activeCollection, variables };
      setWorkspace((current) => current ? { ...current, collections: current.collections.map((item) => item.id === collection.id ? collection : item) } : current);
      await queueWorkspaceWrite(() => invoke("save_workspace_collection", { collection }));
    }
    if (scope === "global") {
      setWorkspace((current) => current ? { ...current, global_variables: variables } : current);
      await queueWorkspaceWrite(() => invoke("save_workspace_globals", { variables }));
    }
  }

  function variablesForScope() {
    if (variableScope === "temporary") return temporaryVariables;
    if (variableScope === "environment") return activeEnvironment?.variables ?? [];
    if (variableScope === "collection") return activeCollection?.variables ?? [];
    return workspace?.global_variables ?? [];
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

  async function renameEnvironment() {
    if (!activeEnvironment) return;
    const name = window.prompt("Rename environment", activeEnvironment.name);
    if (!name?.trim() || name.trim() === activeEnvironment.name) return;
    await updateEnvironment({ ...activeEnvironment, name: name.trim() });
    setNotice(`Renamed environment to "${name.trim()}".`);
  }

  async function deleteEnvironment() {
    if (!activeEnvironment || !window.confirm(`Delete environment "${activeEnvironment.name}"?`)) return;
    const environment = activeEnvironment;
    setWorkspace((current) => current ? { ...current, environments: current.environments.filter((item) => item.id !== environment.id) } : current);
    setActiveEnvironmentId("");
    await queueWorkspaceWrite(() => invoke("delete_workspace_environment", { environmentId: environment.id }));
    setNotice(`Deleted environment "${environment.name}".`);
    await refreshWorkspace();
  }

  async function updateEnvironment(environment: Environment) {
    setWorkspace((current) => current ? { ...current, environments: current.environments.map((item) => item.id === environment.id ? environment : item) } : current);
    await queueWorkspaceWrite(() => invoke("save_workspace_environment", { environment }));
  }

  async function saveWorkspaceSettings(settings: WorkspaceSnapshot["settings"]) {
    if (!workspace || settings.historyLimit < 0 || settings.logLimitMb < 1 || !Number.isInteger(settings.historyLimit) || !Number.isInteger(settings.logLimitMb)) {
      setError("History entries must be zero or more and log limit must be at least 1 MB.");
      return;
    }
    setWorkspace({ ...workspace, settings });
    await queueWorkspaceWrite(() => invoke("save_workspace_settings", { settings }));
    setError("");
    setNotice("Saved workspace settings.");
  }

  async function toggleVariableSecret(index: number) {
    const variable = variablesForScope()[index];
    if (!variable) return;
    if (!vaultEntries) {
      setError("Unlock the vault before converting a variable to or from a secret.");
      return;
    }
    const variables = variablesForScope().map((item, itemIndex) => {
      if (itemIndex !== index) return item;
      if (item.secret) {
        const value = vaultEntries[item.name] ?? item.value;
        return { ...item, secret: false, value };
      }
      return { ...item, secret: true, value: "" };
    });
    const entries = await queueWorkspaceWrite(() => invoke<Record<string, string>>("mutate_vault_entry", {
      operation: variable.secret ? "plain" : "set", oldName: variable.name, newName: variable.name, value: variable.value,
    }));
    setVaultEntries(entries);
    await updateVariables(variableScope, variables);
  }

  async function removeVariable(index: number) {
    const variable = variablesForScope()[index];
    if (!variable) return;
    if (variable.secret && !window.confirm(`Remove secret "${variable.name || "unnamed"}" from this scope and the vault?`)) return;
    if (variable.secret && !vaultEntries) {
      setError("Unlock the vault before removing a secret.");
      return;
    }
    if (variable.secret && vaultEntries && variable.name in vaultEntries) {
      const entries = await queueWorkspaceWrite(() => invoke<Record<string, string>>("mutate_vault_entry", { operation: "remove", oldName: variable.name, newName: "", value: "" }));
      setVaultEntries(entries);
    }
    await updateVariables(variableScope, variablesForScope().filter((_item, itemIndex) => itemIndex !== index));
  }

  function openHistoryEntry(entry: HistoryEntry) {
    const linked = entry.request_id ? workspace?.requests.find((request) => request.id === entry.request_id) : undefined;
    if (linked) {
      loadRequest(linked);
      return;
    }
    if (entry.request_snapshot) {
      loadRequest({ ...entry.request_snapshot, id: crypto.randomUUID(), name: entry.name });
      setRequestId("");
      setSaved(false);
    } else {
      newRequest();
      setMethod(entry.method);
      setUrl(entry.url);
      setRequestName(entry.name);
    }
  }

  async function saveResponse() {
    if (!response) return;
    const path = await save({
      defaultPath: `response.${responseExtension(response.content_type)}`,
    });
    if (path) {
      await invoke("save_response", { path, bodyBase64: response.body_base64 });
      setNotice("Saved response.");
    }
  }

  function updateMultipartRow(id: number, field: keyof MultipartRow, value: string | boolean) {
    setMultipartRows((current) =>
      current.map((row) => (row.id === id ? { ...row, [field]: value } : row)),
    );
  }

  function handleTabKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    const current = tabs.indexOf(document.activeElement as HTMLButtonElement);
    if (current < 0 || !tabs.length) return;
    event.preventDefault();
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next].focus();
    tabs[next].click();
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">A</span><strong>API Lantern</strong><span className="local-pill">{workspace?.portable ? "Portable" : "Local only"}</span></div>
        <div className="top-actions">
          {pendingWrites > 0 && <span className="notice" role="status">Writing to disk...</span>}
          {pendingWrites === 0 && notice && <span className="notice" role="status">{notice}</span>}
          <button type="button" onClick={importFile}>Import</button>
          <button type="button" onClick={importCurl}>cURL</button>
          <button type="button" onClick={generateCurl}>Copy cURL</button>
          <button type="button" onClick={exportPortable}>Portable ZIP</button>
          <button type="button" onClick={vaultEntries ? lockVault : unlockVault}>{vaultEntries ? "Lock vault" : "Unlock vault"}</button>
          <label className="environment"><span>Environment</span><select aria-label="Active environment" value={activeEnvironmentId} onChange={(event) => setActiveEnvironmentId(event.target.value)}><option value="">No environment</option>{workspace?.environments.map((environment) => <option key={environment.id} value={environment.id}>{environment.name}</option>)}</select></label>
          <button type="button" onClick={() => setSidebarView("environment")}>Variables</button>
        </div>
      </header>

      <aside className="sidebar">
        <div className="sidebar-actions"><button className="new-button" onClick={newRequest} type="button">+ New request</button><button className="icon-button" onClick={() => createCollection()} type="button" aria-label="New collection">+</button></div>
        <div className="sidebar-switcher"><button className={sidebarView === "collections" ? "active" : ""} onClick={() => setSidebarView("collections")} type="button">Collections</button><button className={sidebarView === "history" ? "active" : ""} onClick={() => setSidebarView("history")} type="button">History</button></div>
        {sidebarView === "collections" && <><input className="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search requests..." aria-label="Search requests" />
        <nav aria-label="Collections">
          {visibleRequests.some((request) => request.favorite) && <section className="collection favorites">
            <h2>★ Favorites</h2>
            {visibleRequests.filter((request) => request.favorite).map((request) => <button className="request-item" key={request.id} onClick={() => loadRequest(request)} type="button"><span className={methodColors[request.method]}>{request.method}</span>{request.name}</button>)}
          </section>}
          {workspace?.collections.filter((collection) => !collection.parentId).map((collection) => renderCollection(collection))}
        </nav></>}
        {sidebarView === "history" && <nav aria-label="Request history"><p className="section-label">Recent requests</p>{workspace?.history.map((entry) => <button className="history-item" key={entry.id} onClick={() => openHistoryEntry(entry)} type="button"><span className={methodColors[entry.method]}>{entry.method}</span><strong>{entry.name}</strong><small>{entry.status ?? "Failed"} · {new Date(entry.created_at).toLocaleString()}</small></button>)}{!workspace?.history.length && <div className="sidebar-empty">Sent requests will appear here.</div>}</nav>}
        {sidebarView === "environment" && <div className="environment-editor"><div className="environment-heading"><strong>Variables</strong><div><button onClick={addEnvironment} type="button">+ Environment</button>{activeEnvironment && <><button onClick={renameEnvironment} type="button">Rename</button><button onClick={deleteEnvironment} type="button">Delete</button></>}</div></div>
          <select className="scope-select" value={variableScope} onChange={(event) => setVariableScope(event.target.value as typeof variableScope)} aria-label="Variable scope"><option value="temporary">Temporary</option><option value="environment">Environment</option><option value="collection">Collection</option><option value="global">Global</option></select>
          <p>{variableScope === "environment" ? activeEnvironment?.name ?? "No environment" : variableScope === "collection" ? activeCollection?.name : `${variableScope[0].toUpperCase()}${variableScope.slice(1)} scope`}</p>
          {variablesForScope().map((variable, index) => <div className="variable-row" key={`${variable.name}-${index}`}>
            <input aria-label="Enable variable" checked={variable.enabled} onChange={(event) => updateVariables(variableScope, variablesForScope().map((item, itemIndex) => itemIndex === index ? { ...item, enabled: event.target.checked } : item))} type="checkbox" />
            <input value={variable.name} onChange={(event) => renameVariable(index, event.target.value)} placeholder="Name" aria-label="Variable name" />
            <input disabled={variable.secret && !vaultEntries} type={variable.secret ? "password" : "text"} value={variable.secret ? vaultEntries?.[variable.name] ?? "" : variable.value} onChange={(event) => variable.secret && vaultEntries ? saveVaultEntry(variable.name, event.target.value) : updateVariables(variableScope, variablesForScope().map((item, itemIndex) => itemIndex === index ? { ...item, value: event.target.value } : item))} placeholder={variable.secret && !vaultEntries ? "Locked secret" : "Value"} aria-label="Variable value" />
            <div className="variable-actions"><button title="Toggle secret" onClick={() => toggleVariableSecret(index)} type="button">{variable.secret ? "Encrypted" : "Plain"}</button>
            <button title="Remove variable" aria-label={`Remove variable ${variable.name || index + 1}`} onClick={() => removeVariable(index)} type="button">Remove</button></div>
          </div>)}
          <button className="add-variable" onClick={() => updateVariables(variableScope, [...variablesForScope(), { name: "", value: "", secret: false, enabled: true }])} type="button">+ Add variable</button>
          {variableScope === "environment" && !activeEnvironment && <div className="sidebar-empty">Create or select an environment to add variables.</div>}
          {workspace && <div className="workspace-settings"><strong>Workspace settings</strong><label>History entries<input min="0" type="number" value={workspace.settings.historyLimit} onChange={(event) => saveWorkspaceSettings({ ...workspace.settings, historyLimit: Number(event.target.value) })} /></label><label>Log limit (MB)<input min="1" type="number" value={workspace.settings.logLimitMb} onChange={(event) => saveWorkspaceSettings({ ...workspace.settings, logLimitMb: Number(event.target.value) })} /></label><label><input checked={workspace.settings.autosave} onChange={(event) => saveWorkspaceSettings({ ...workspace.settings, autosave: event.target.checked })} type="checkbox" /> Autosave saved requests</label></div>}
        </div>}
        <div className="privacy-note"><strong>Your data stays here.</strong><span>No account, cloud, or telemetry.</span></div>
      </aside>

      <section className="workspace">
        <div className="request-tabs" role="tablist" aria-label="Open requests" onKeyDown={handleTabKeyDown}>{openTabs.length ? openTabs.map((tab) => <div className={`open-tab ${tab.key === activeTabKey ? "active" : ""}`} key={tab.key} role="presentation"><button aria-selected={tab.key === activeTabKey} className="tab-select" onClick={() => switchTab(tab)} role="tab" tabIndex={tab.key === activeTabKey ? 0 : -1} type="button"><span className={methodColors[tab.key === activeTabKey ? method : tab.request.method]}>{tab.key === activeTabKey ? method : tab.request.method}</span>{tab.key === activeTabKey ? requestName : tab.request.name}{tab.key === activeTabKey && !saved && <span className="unsaved-dot" aria-label="Unsaved changes" />}</button><button className="tab-close" aria-label={`Close ${tab.request.name}`} onClick={() => closeTab(tab.key)} type="button">×</button></div>) : <div className="open-tab active" role="presentation"><button aria-selected="true" className="tab-select" role="tab" tabIndex={0} type="button"><span className={methodColors[method]}>{method}</span>{requestName}{!saved && <span className="unsaved-dot" aria-label="Unsaved changes" />}</button></div>}<button className="tab-add" onClick={newRequest} type="button" aria-label="New tab">+</button></div>

        <form className="request-panel" onSubmit={sendRequest}>
          <div className="request-line">
            <input className="request-name" value={requestName} onChange={(event) => { setRequestName(event.target.value); setSaved(false); }} aria-label="Request name" />
            <select className="collection-select" value={collectionId} onChange={(event) => { setCollectionId(event.target.value); setSaved(false); }} aria-label="Collection">{workspace?.collections.map((collection) => <option key={collection.id} value={collection.id}>{collectionPath(collection)}</option>)}</select>
            <button className={`favorite-button ${favorite ? "active" : ""}`} onClick={() => { setFavorite((current) => !current); setSaved(false); }} type="button" aria-label={favorite ? "Remove from favorites" : "Add to favorites"}>{favorite ? "★" : "☆"}</button>
            <select value={method} onChange={(event) => setMethod(event.target.value)} aria-label="HTTP method">{["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].map((item) => <option key={item}>{item}</option>)}</select>
            <div className="url-field"><input value={url} onChange={(event) => setUrl(event.target.value)} aria-label="Request URL" />{urlVariables.length > 0 && <div className="url-variables">{urlVariables.map((variable, index) => <span className={variable.source ? "" : "unresolved"} title={variable.source ? `${variable.name} supplied by ${variable.source}` : `${variable.name} is unresolved`} key={`${variable.name}-${index}`}>{`{{${variable.name}}}`} · {variable.source ?? "unresolved"}</span>)}</div>}</div>
            <button className="save-button" onClick={saveRequest} type="button">Save</button>
            {sending ? <button className="cancel-button" onClick={cancelRequest} type="button">Cancel</button> : <button className="send-button" disabled={runningCollection} type="submit">Send</button>}
          </div>

          <div className="panel-tabs" role="tablist" aria-label="Request options" onKeyDown={handleTabKeyDown}>
            {["Params", "Headers", "Body", "Auth", "Scripts", "Tests", "Settings"].map((tab) => (
              <button aria-selected={requestTab === tab} className={requestTab === tab ? "active" : ""} key={tab} onClick={() => setRequestTab(tab)} role="tab" tabIndex={requestTab === tab ? 0 : -1} type="button">
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
                {!["form", "multipart", "binary"].includes(bodyMode) && <textarea aria-label={`${bodyMode} request body`} value={body} onChange={(event) => setBody(event.target.value)} spellCheck={false} />}
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
            {requestTab === "Scripts" && <div className="script-editor">
              <label className="script-toggle"><input checked={scriptsEnabled} onChange={(event) => setScriptsEnabled(event.target.checked)} type="checkbox" /><span>Enable scripts for this request</span></label>
              <p>Scripts run locally in an isolated worker with network, storage, worker creation, dynamic imports, and eval removed, with a one-second limit. Scripts are marked as failed compatibility checks in CLI runs; use friendly assertions for CI.</p>
              <label><span>Pre-request JavaScript</span><textarea aria-label="Pre-request JavaScript" value={preRequestScript} onChange={(event) => setPreRequestScript(event.target.value)} placeholder={'request.headers.push({ name: "X-Run", value: "test", enabled: true });'} spellCheck={false} /></label>
              <label><span>Post-response JavaScript</span><textarea aria-label="Post-response JavaScript" value={postResponseScript} onChange={(event) => setPostResponseScript(event.target.value)} placeholder={'lantern.test("status is 200", () => lantern.expect(response.status).toEqual(200));'} spellCheck={false} /></label>
            </div>}
            {requestTab === "Tests" && <div className="assertion-editor">
              <div className="editor-toolbar"><strong>Friendly assertions</strong><button type="button" onClick={() => setAssertions((current) => [...current, { id: crypto.randomUUID(), kind: "status", operator: "equals", target: "", expected: "200", enabled: true }])}>+ Add assertion</button></div>
              {assertions.map((assertion) => <div className="assertion-row" key={assertion.id}>
                <input checked={assertion.enabled} onChange={(event) => setAssertions((current) => current.map((item) => item.id === assertion.id ? { ...item, enabled: event.target.checked } : item))} type="checkbox" aria-label="Enable assertion" />
                <select value={assertion.kind} onChange={(event) => setAssertions((current) => current.map((item) => item.id === assertion.id ? { ...item, kind: event.target.value as RequestAssertion["kind"], operator: assertionOperators(event.target.value as RequestAssertion["kind"])[0] } : item))}><option value="status">Status</option><option value="header">Header</option><option value="json-path">JSON path</option><option value="response-time">Response time</option><option value="body">Body</option></select>
                <input disabled={!["header", "json-path"].includes(assertion.kind)} value={assertion.target} onChange={(event) => setAssertions((current) => current.map((item) => item.id === assertion.id ? { ...item, target: event.target.value } : item))} placeholder={assertion.kind === "header" ? "Header name" : assertion.kind === "json-path" ? "$.data.items[0].id" : "No target needed"} />
                <select value={assertion.operator} onChange={(event) => setAssertions((current) => current.map((item) => item.id === assertion.id ? { ...item, operator: event.target.value as RequestAssertion["operator"] } : item))}>{assertionOperators(assertion.kind).map((operator) => <option key={operator} value={operator}>{operator.replace("-", " ")}</option>)}</select>
                <input disabled={assertion.operator === "exists"} value={assertion.expected} onChange={(event) => setAssertions((current) => current.map((item) => item.id === assertion.id ? { ...item, expected: event.target.value } : item))} placeholder={assertion.operator === "exists" ? "Not required" : "Expected value"} title={assertionError(assertion)} />
                <button className="row-remove" type="button" onClick={() => setAssertions((current) => current.filter((item) => item.id !== assertion.id))} aria-label="Remove assertion">×</button>
              </div>)}
              {!assertions.length && <div className="empty-state">Add assertions for status, headers, JSON paths, body content, or timing.</div>}
            </div>}
            {requestTab === "Settings" && <div className="settings-grid"><label><span>Timeout (milliseconds)</span><input min="1" type="number" value={timeoutMs} onChange={(event) => setTimeoutMs(Math.max(1, Number(event.target.value) || 1))} /></label><label className="check-setting"><input checked={followRedirects} onChange={(event) => setFollowRedirects(event.target.checked)} type="checkbox" /><span>Follow redirects (up to 10)</span></label></div>}
          </div>
        </form>

        <section className="response-panel" aria-live="polite">
          <div className="response-heading">
            <div className="panel-tabs" role="tablist" aria-label="Response details" onKeyDown={handleTabKeyDown}>{["Body", "Headers", "Cookies", "Tests", "Runner"].map((tab) => <button aria-selected={responseTab === tab} className={responseTab === tab ? "active" : ""} key={tab} onClick={() => setResponseTab(tab)} role="tab" tabIndex={responseTab === tab ? 0 : -1} type="button">{tab}{tab === "Headers" && response ? ` (${response.headers.length})` : tab === "Cookies" && response ? ` (${cookies.length})` : tab === "Tests" && testResults.length ? ` (${testResults.length})` : ""}</button>)}</div>
            {response && <div className="response-meta"><strong className={response.status >= 400 ? "status-error" : ""}>{response.status} {response.status_text}</strong><span>{response.elapsed_ms} ms</span><span>{formatBytes(response.size_bytes)}</span></div>}
          </div>
          {error && <div className="error-box"><strong>Request failed</strong><span>{error}</span></div>}
          {!response && !error && <div className="empty-response">Send a request to see the response.</div>}
          {response && responseTab === "Body" && <><div className="response-tools"><div><button className={responseView === "pretty" ? "active" : ""} onClick={() => setResponseView("pretty")} type="button">Pretty</button><button className={responseView === "raw" ? "active" : ""} onClick={() => setResponseView("raw")} type="button">Raw</button><button className={responseView === "preview" ? "active" : ""} onClick={() => setResponseView("preview")} type="button">Preview</button>{response.content_type.includes("json") && <button className={responseTree ? "active" : ""} onClick={() => setResponseTree((current) => !current)} type="button">Tree</button>}</div><label><input aria-label="Search response" value={responseSearch} onChange={(event) => setResponseSearch(event.target.value)} placeholder="Search response" /><span>{responseSearch ? `${searchMatches} matches` : ""}</span></label><button type="button" onClick={() => navigator.clipboard.writeText(response.body).then(() => setNotice("Copied response.")).catch((copyError) => setError(String(copyError)))}>Copy</button><button type="button" onClick={saveResponse}>Save</button></div>{responseView === "preview" ? <div className="response-preview">{response.content_type.startsWith("image/") ? <img src={`data:${response.content_type};base64,${response.body_base64}`} alt="Response preview" /> : response.content_type.includes("html") ? <iframe srcDoc={response.body} sandbox="" title="Response preview" /> : <div className="empty-state">Preview is available for HTML and image responses.</div>}</div> : responseTree ? <JsonTreeBody body={response.body} /> : responseView === "pretty" && response.content_type.includes("json") ? <HighlightedJson body={responseBody} /> : <pre>{responseBody}</pre>}</>}
          {response && responseTab === "Headers" && <div className="response-headers">{response.headers.map((header, index) => <div key={`${header.name}-${index}`}><strong>{header.name}</strong><span>{header.value}</span></div>)}</div>}
          {response && responseTab === "Cookies" && <div className="response-cookies">{cookies.length ? cookies.map((cookie, index) => <div key={`${cookie.name}-${index}`}><strong>{cookie.name}</strong><span>{cookie.value}</span><small>{cookie.attributes || "No attributes"}</small></div>) : <div className="empty-state">This response did not set any cookies.</div>}</div>}
          {responseTab === "Tests" && <div className="test-results">{testResults.length ? testResults.map((test, index) => <div className={test.passed ? "test-pass" : "test-fail"} key={`${test.name}-${index}`}><strong>{test.passed ? "PASS" : "FAIL"}</strong><span>{test.name}</span><small>{test.message}</small></div>) : <div className="empty-state">Send this request to run its assertions and enabled scripts.</div>}</div>}
          {responseTab === "Runner" && <div className="runner-results">{runningCollection ? <div className="runner-summary"><strong>Running collection</strong><span>{runnerProgress}</span><button type="button" onClick={cancelCollectionRun}>Cancel</button></div> : runReport ? <><div className="runner-summary"><strong>{runReport.collection}</strong><span>{runReport.passed} passed · {runReport.failed} failed · {runReport.elapsed_ms} ms</span><button type="button" onClick={() => exportRunReport("json")}>Save JSON</button><button type="button" onClick={() => exportRunReport("junit")}>Save JUnit</button></div>{runReport.items.map((item) => <details className={item.error || item.tests.some((test) => !test.passed) ? "run-fail" : "run-pass"} key={item.request_id}><summary><strong>{item.method} {item.name}</strong><span>{item.status ?? "Error"} · {item.elapsed_ms} ms · {item.tests.filter((test) => test.passed).length}/{item.tests.length} tests</span></summary><small>{item.url}</small>{item.error && <small>{item.error}</small>}{item.tests.filter((test) => !test.passed).map((test, index) => <small key={`${test.name}-${index}`}>{test.name}: {test.message}</small>)}</details>)}</> : <div className="empty-state">Use the play button beside a collection to run all of its requests.</div>}</div>}
        </section>
      </section>
      {undoAction && <div className="undo-toast"><span>{undoAction.message}</span><button type="button" onClick={() => undoAction.run().then(() => setUndoAction(null))}>Undo</button><button aria-label="Dismiss undo" type="button" onClick={() => setUndoAction(null)}>×</button></div>}
    </main>
  );
}

export default App;
