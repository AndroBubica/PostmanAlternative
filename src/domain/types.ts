export type KeyValueRow = { id: number; name: string; value: string; enabled: boolean };
export type MultipartRow = KeyValueRow & { kind: "text" | "file" };
export type BodyMode = "json" | "text" | "xml" | "form" | "multipart" | "binary";
export type AuthType = "none" | "basic" | "bearer" | "api-key";
export type ResponseView = "pretty" | "raw" | "preview";

export type RequestAssertion = {
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

export type SavedRequest = RequestShape & {
  id: string;
  collectionId: string;
  name: string;
  timeoutMs: number;
  followRedirects: boolean;
  favorite: boolean;
  preRequestScript: string;
  postResponseScript: string;
  scriptsEnabled: boolean;
  assertions: RequestAssertion[];
};

export type BuiltRequest = {
  url: string;
  headers: KeyValueRow[];
  body_kind: "text" | "multipart" | "binary";
  body: string | null;
  multipart_fields: MultipartRow[];
  binary_file: string | null;
};

export type ApiResponse = {
  status: number;
  status_text: string;
  elapsed_ms: number;
  size_bytes: number;
  headers: Array<{ name: string; value: string }>;
  body: string;
  body_base64: string;
  content_type: string;
};

export type ResponseShape = Pick<ApiResponse, "status" | "elapsed_ms" | "headers" | "body">;
export type TestResult = { name: string; passed: boolean; message: string };
export type Variable = { name: string; value: string; secret: boolean; enabled: boolean };
export type Collection = { id: string; name: string; parentId?: string; variables: Variable[] };
export type Environment = { id: string; name: string; variables: Variable[] };

export type HistoryEntry = {
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

export type WorkspaceSnapshot = {
  root: string;
  portable: boolean;
  collections: Collection[];
  requests: SavedRequest[];
  environments: Environment[];
  history: HistoryEntry[];
  settings: { historyLimit: number; logLimitMb: number; autosave: boolean };
  global_variables: Variable[];
};

export type DeletedCollectionSnapshot = { collections: Collection[]; requests: SavedRequest[] };
export type RunItem = { request_id: string; name: string; method: string; url: string; status: number | null; elapsed_ms: number; tests: TestResult[]; error: string };
export type RunReport = { collection: string; started_at: string; elapsed_ms: number; passed: number; failed: number; items: RunItem[] };

export type OpenTab = {
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
