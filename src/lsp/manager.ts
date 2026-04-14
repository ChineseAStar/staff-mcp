import { spawn, ChildProcess, execSync } from "child_process";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { STAFF_TOOLS_DIR, ensureStaffDirs } from "../utils/paths.js";
import { getPlatformCommand } from "../utils/tool-utils.js";

export interface LSPConfig {
  command: string[];
  installCommand?: string;
  extensions: string[];
}

const STAFF_NODE_MODULES = path.join(STAFF_TOOLS_DIR, "node_modules");

const DEFAULT_CONFIGS: Record<string, LSPConfig> = {
  typescript: {
    command: ["node", path.join(STAFF_NODE_MODULES, "typescript-language-server/lib/cli.mjs"), "--stdio"],
    installCommand: `npm install typescript-language-server typescript`,
    extensions: [".ts", ".tsx", ".js", ".jsx"]
  },
  python: {
    command: ["node", path.join(STAFF_NODE_MODULES, "pyright/dist/pyright-langserver.js"), "--stdio"],
    installCommand: `npm install pyright`,
    extensions: [".py"]
  },
  go: {
    command: ["gopls"],
    installCommand: "go install golang.org/x/tools/gopls@latest",
    extensions: [".go"]
  },
  rust: {
    command: ["rust-analyzer"],
    installCommand: "rustup component add rust-analyzer",
    extensions: [".rs"]
  }
};

export class LSPClient {
  private process: ChildProcess | null = null;
  private idCounter = 0;
  private handlers = new Map<number, (res: any) => void>();
  private buffer = "";

  constructor(private config: LSPConfig, private rootPath: string) {}

  async start() {
    const executable = getPlatformCommand(this.config.command[0]);
    this.process = spawn(executable, this.config.command.slice(1), {
      cwd: this.rootPath,
      stdio: ["pipe", "pipe", "pipe"],
      shell: true // Using shell helps with path resolution on Windows
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
  public readonly DEFAULT_CONFIGS = DEFAULT_CONFIGS;
  private clients = new Map<string, LSPClient>();

  constructor() {
    ensureStaffDirs();
    if (!fs.existsSync(STAFF_NODE_MODULES)) {
      fs.mkdirSync(STAFF_NODE_MODULES, { recursive: true });
    }
  }

  async ensureServer(language: string) {
    const config = DEFAULT_CONFIGS[language];
    if (!config) return;

    // Check if it's a node module we manage
    const serverPath = config.command[1];
    if (serverPath && path.isAbsolute(serverPath) && fs.existsSync(serverPath)) {
      return;
    }

    // Check if the command exists in PATH
    const cmd = config.command[0];
    
    try {
      const checkCmd = process.platform === 'win32' ? `where ${cmd}` : `which ${cmd}`;
      execSync(checkCmd, { stdio: 'ignore' });
      return; // Found in PATH
    } catch {
      if (config.installCommand) {
        console.log(`LSP server '${cmd}' not found. Attempting auto-install for ${language}...`);
        try {
          const installParts = config.installCommand.split(" ");
          const platformNpm = getPlatformCommand(installParts[0]);
          const args = installParts.slice(1);
          
          execSync(`${platformNpm} ${args.join(" ")}`, { 
            cwd: STAFF_TOOLS_DIR,
            stdio: 'inherit',
            shell: true
          } as any);
        } catch (e) {
          console.error(`Failed to install LSP for ${language}:`, e);
        }
      }
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
    
    // Ensure file is opened and notified to server
    const content = fs.readFileSync(filePath, "utf-8");
    await client.notification("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: lang,
        version: 1,
        text: content
      }
    });

    return new Promise(async (resolve) => {
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve([]);
        }
      }, 3000); // Wait for async diagnostics

      client.onNotification("textDocument/publishDiagnostics", (params: any) => {
        // Normalize path for comparison
        const paramPath = params.uri.replace("file://", "");
        const checkPath = filePath.startsWith("/") ? filePath : `/${filePath}`;
        if (paramPath.endsWith(filePath) && !resolved) {
          resolved = true;
          clearTimeout(timeout);
          resolve(params.diagnostics);
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

  async go_to_definition_internal(filePath: string, line: number, character: number, rootPath: string): Promise<string> {
    const ext = path.extname(filePath);
    const lang = Object.keys(DEFAULT_CONFIGS).find(l => DEFAULT_CONFIGS[l].extensions.includes(ext));
    if (!lang) throw new Error(`Unsupported language for extension ${ext}`);

    const client = await this.getClient(lang, rootPath);
    const result = await client.request("textDocument/definition", {
      textDocument: { uri: `file://${filePath}` },
      position: { line: line - 1, character: character - 1 }
    });

    if (!result) return "Definition not found";
    
    const locations = Array.isArray(result) ? result : [result];
    return locations.map((loc: any) => {
      const uri = loc.uri || loc.targetUri;
      const range = loc.range || loc.targetSelectionRange;
      return `${uri.replace('file://', '')}:${range.start.line + 1}`;
    }).join("\n");
  }
}

export const lspManager = new LSPManager();
