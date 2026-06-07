import type { ApiResponse, TestResult } from "../domain/types.ts";

export type SandboxContext = {
  request: Record<string, unknown>;
  response: ApiResponse | null;
  variables: Record<string, string>;
};

export type SandboxResult = {
  request: Record<string, unknown>;
  variables: Record<string, string>;
  tests: TestResult[];
};

export function runSandboxScript(script: string, context: SandboxContext): Promise<SandboxResult> {
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
