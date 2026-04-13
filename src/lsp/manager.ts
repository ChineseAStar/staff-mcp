import { spawn, ChildProcess } from "child_process";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";

export interface LSPConfig {
  command: string[];
  installCommand?: string;
  extensions: string[];
}

const DEFAULT_CONFIGS: Record<string, LSPConfig> = {
  typescript: {
    command: ["node", path.join(os.homedir(), ".staff/lsp/node_modules/typescript-language-server/lib/cli.mjs"), "--stdio"],
    installCommand: "npm install --prefix " + path.join(os.homedir(), ".staff/lsp") + " typescript-language-server typescript",
    extensions: [".ts", ".tsx", ".js", ".jsx"]
  },
  python: {
    command: ["node", path.join(os.homedir(), ".staff/lsp/node_modules/pyright/dist/pyright-langserver.js"), "--stdio"],
    installCommand: "npm install --prefix " + path.join(os.homedir(), ".staff/lsp") + " pyright",
    extensions: [".py"]
  }
};

export class LSPClient {
  private process: ChildProcess | null = null;
  private idCounter = 0;
  private handlers = new Map<number, (res: any) => void>();
  private buffer = "";

  constructor(private config: LSPConfig, private rootPath: string) {}

  async start() {
    this.process = spawn(this.config.command[0], this.config.command.slice(1), {
      cwd: this.rootPath,
      stdio: ["pipe", "pipe", "pipe"]
    });

    this.process.stdout?.on("data", (data) => {
      this.handleData(data.toString());
    });

    this.process.stderr?.on("data", (data) => {
      console.error(`[LSP Error]: ${data.toString()}`);
    });

    // Initialize
    await this.request("initialize", {
      processId: process.pid,
      rootUri: `file://${this.rootPath}`,
      capabilities: {},
      workspaceFolders: [{ uri: `file://${this.rootPath}`, name: "workspace" }]
    });
    await this.notification("initialized", {});
  }

  private notificationHandlers = new Map<string, (params: any) => void>();

  private handleData(data: string) {
    this.buffer += data;
    while (true) {
      const match = this.buffer.match(/Content-Length: (\d+)\r\n\r\n/);
      if (!match) break;

      const contentLength = parseInt(match[1]);
      const headerLength = match[0].length;
      const totalLength = headerLength + contentLength;

      if (this.buffer.length < totalLength) break;

      const body = this.buffer.slice(headerLength, totalLength);
      this.buffer = this.buffer.slice(totalLength);

      try {
        const response = JSON.parse(body);
        if (response.id !== undefined) {
          const handler = this.handlers.get(response.id);
          if (handler) {
            handler(response);
            this.handlers.delete(response.id);
          }
        } else if (response.method) {
          const handler = this.notificationHandlers.get(response.method);
          if (handler) {
            handler(response.params);
          }
        }
      } catch (e) {
        console.error("Failed to parse LSP response", e);
      }
    }
  }

  onNotification(method: string, handler: (params: any) => void) {
    this.notificationHandlers.set(method, handler);
  }

  async request(method: string, params: any): Promise<any> {
    const id = this.idCounter++;
    const message = {
      jsonrpc: "2.0",
      id,
      method,
      params
    };
    const json = JSON.stringify(message);
    const header = `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n`;
    
    return new Promise((resolve) => {
      this.handlers.set(id, (res) => resolve(res.result));
      this.process?.stdin?.write(header + json);
    });
  }

  async notification(method: string, params: any) {
    const message = {
      jsonrpc: "2.0",
      method,
      params
    };
    const json = JSON.stringify(message);
    const header = `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n`;
    this.process?.stdin?.write(header + json);
  }

  stop() {
    this.process?.kill();
    this.process = null;
  }
}

export class LSPManager {
  private clients = new Map<string, LSPClient>();
  private lspDir = path.join(os.homedir(), ".staff/lsp");

  constructor() {
    if (!fs.existsSync(this.lspDir)) {
      fs.mkdirSync(this.lspDir, { recursive: true });
    }
  }

  async ensureServer(language: string) {
    const config = DEFAULT_CONFIGS[language];
    if (!config || !config.installCommand) return;

    const binPath = config.command[1]; // Approximate binary path
    if (!fs.existsSync(binPath)) {
      console.log(`Installing LSP for ${language}...`);
      const { execSync } = await import("child_process");
      execSync(config.installCommand);
    }
  }

  async getClient(language: string, rootPath: string): Promise<LSPClient> {
    const key = `${language}:${rootPath}`;
    if (this.clients.has(key)) return this.clients.get(key)!;

    await this.ensureServer(language);
    const config = DEFAULT_CONFIGS[language];
    if (!config) throw new Error(`Unsupported language: ${language}`);

    const client = new LSPClient(config, rootPath);
    await client.start();
    this.clients.set(key, client);
    return client;
  }

  async getDiagnostics(filePath: string, rootPath: string): Promise<any[]> {
    const ext = path.extname(filePath);
    const lang = Object.keys(DEFAULT_CONFIGS).find(l => DEFAULT_CONFIGS[l].extensions.includes(ext));
    if (!lang) return [];

    const client = await this.getClient(lang, rootPath);
    const uri = `file://${filePath}`;
    
    return new Promise(async (resolve) => {
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve([]);
        }
      }, 5000); // 5s timeout

      client.onNotification("textDocument/publishDiagnostics", (params: any) => {
        if (params.uri === uri && !resolved) {
          resolved = true;
          clearTimeout(timeout);
          resolve(params.diagnostics);
        }
      });

      const content = fs.readFileSync(filePath, "utf-8");
      await client.notification("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId: lang,
          version: 1,
          text: content
        }
      });
    });
  }

  async hover(filePath: string, line: number, character: number, rootPath: string): Promise<string> {
    const ext = path.extname(filePath);
    const lang = Object.keys(DEFAULT_CONFIGS).find(l => DEFAULT_CONFIGS[l].extensions.includes(ext));
    if (!lang) return "Unsupported language";

    const client = await this.getClient(lang, rootPath);
    const result = await client.request("textDocument/hover", {
      textDocument: { uri: `file://${filePath}` },
      position: { line, character }
    });
    
    if (!result || !result.contents) return "No hover information found";
    if (typeof result.contents === "string") return result.contents;
    if (Array.isArray(result.contents)) return result.contents.map((c: any) => typeof c === "string" ? c : c.value).join("\n");
    return result.contents.value || "No hover information found";
  }
}

export const lspManager = new LSPManager();
