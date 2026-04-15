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
    installCommand: `npm install --no-save typescript-language-server@latest typescript@latest`,
    extensions: [".ts", ".tsx", ".js", ".jsx"]
  },
  python: {
    command: ["node", path.join(STAFF_NODE_MODULES, "pyright/dist/pyright-langserver.js"), "--stdio"],
    installCommand: `npm install --no-save pyright@latest`,
    extensions: [".py"]
  },
  bash: {
    command: ["node", path.join(STAFF_NODE_MODULES, "bash-language-server/out/cli.js"), "start"],
    installCommand: `npm install --no-save bash-language-server@latest`,
    extensions: [".sh", ".bash"]
  }
};

export class LSPClient {
  private process: ChildProcess | null = null;
  private idCounter = 0;
  private handlers = new Map<number, (res: any) => void>();
  private buffer: Buffer = Buffer.alloc(0);
  public diagnostics = new Map<string, any[]>();

  constructor(private config: LSPConfig, private rootPath: string) {}

  async start() {
    const executable = getPlatformCommand(this.config.command[0]);
    this.process = spawn(executable, this.config.command.slice(1), {
      cwd: this.rootPath,
      stdio: ["pipe", "pipe", "pipe"],
      shell: true // Using shell helps with path resolution on Windows
    });

    this.process.on("error", (err) => {
      console.error(`[LSP Process Error]: Failed to start ${executable}: ${err.message}`);
    });

    this.process.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        console.error(`[LSP Process Exit]: ${executable} exited with code ${code}`);
      }
    });

    this.process.stdout?.on("data", (data: Buffer) => {
      this.handleData(data);
    });

    this.process.stderr?.on("data", (data) => {
      console.error(`[LSP Error]: ${data.toString()}`);
    });

    // Wait for process to be ready or fail
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`LSP start timeout for ${executable}`)), 15000);
      
      const checkReady = async () => {
        try {
          // Initialize
          await this.request("initialize", {
            processId: process.pid,
            rootUri: `file://${this.rootPath}`,
            capabilities: {
              textDocument: {
                publishDiagnostics: {
                  relatedInformation: true
                }
              }
            },
            workspaceFolders: [{ uri: `file://${this.rootPath}`, name: "workspace" }]
          });
          await this.notification("initialized", {});

          this.onNotification("textDocument/publishDiagnostics", (params: any) => {
            this.diagnostics.set(params.uri, params.diagnostics);
          });

          clearTimeout(timeout);
          resolve();
        } catch (e) {
          clearTimeout(timeout);
          reject(e);
        }
      };

      if (this.process?.pid) {
        checkReady();
      } else {
        this.process?.on("spawn", checkReady);
        this.process?.on("error", (e) => {
          clearTimeout(timeout);
          reject(e);
        });
      }
    });
  }

  private notificationHandlers = new Map<string, (params: any) => void>();

  private handleData(data: Buffer) {
    this.buffer = Buffer.concat([this.buffer, data]);
    while (true) {
      // Find the end of the header
      const headerEndIndex = this.buffer.indexOf("\r\n\r\n");
      if (headerEndIndex === -1) break;

      const header = this.buffer.subarray(0, headerEndIndex).toString("ascii");
      const match = header.match(/Content-Length: (\d+)/i);
      if (!match) {
        // Invalid header, just break or throw
        break;
      }

      const contentLength = parseInt(match[1]);
      const totalLength = headerEndIndex + 4 + contentLength;

      if (this.buffer.length < totalLength) break;

      const body = this.buffer.subarray(headerEndIndex + 4, totalLength).toString("utf8");
      this.buffer = this.buffer.subarray(totalLength);

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
    if (!this.process || this.process.exitCode !== null) {
      throw new Error("LSP process is not running");
    }
    const id = this.idCounter++;
    const message = {
      jsonrpc: "2.0",
      id,
      method,
      params
    };
    const json = JSON.stringify(message);
    const header = `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n`;
    
    return new Promise((resolve, reject) => {
      this.handlers.set(id, (res) => {
        if (res.error) {
          reject(new Error(res.error.message || "LSP request failed"));
        } else {
          resolve(res.result);
        }
      });
      const success = this.process?.stdin?.write(header + json);
      if (!success) {
        this.handlers.delete(id);
        reject(new Error("Failed to write to LSP stdin"));
      }
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
  private documentVersions = new Map<string, { version: number, content: string }>();

  constructor() {
    ensureStaffDirs();
    if (!fs.existsSync(STAFF_NODE_MODULES)) {
      fs.mkdirSync(STAFF_NODE_MODULES, { recursive: true });
    }
  }

  async ensureServer(language: string) {
    const config = DEFAULT_CONFIGS[language];
    if (!config) return;

    const cmd = config.command[0];
    const serverPath = config.command[1];

    // Check if it's a node-managed server script
    const isNodeManaged = cmd === "node" && serverPath && path.isAbsolute(serverPath);
    if (isNodeManaged) {
      if (fs.existsSync(serverPath)) {
        return;
      }
      // If node-managed but script is missing, we must install
    } else {
      // Check if the command exists in PATH
      try {
        const checkCmd = process.platform === 'win32' ? `where ${cmd}` : `which ${cmd}`;
        execSync(checkCmd, { stdio: 'ignore' });
        return; // Found in PATH
      } catch {
        // Not found, continue to install
      }
    }

    if (config.installCommand) {
      console.log(`LSP server '${cmd}' not found or missing dependencies. Attempting auto-install for ${language}...`);
      try {
        // Ensure package.json exists in STAFF_TOOLS_DIR to keep node_modules local
        const packageJsonPath = path.join(STAFF_TOOLS_DIR, "package.json");
        if (!fs.existsSync(packageJsonPath)) {
          fs.writeFileSync(packageJsonPath, JSON.stringify({ 
            name: "staff-mcp-tools", 
            version: "1.0.0",
            private: true 
          }, null, 2));
        }

        const installParts = config.installCommand.split(" ");
        const platformNpm = getPlatformCommand(installParts[0]);
        const args = installParts.slice(1);
        
        console.log(`Executing: ${platformNpm} ${args.join(" ")} in ${STAFF_TOOLS_DIR}`);
        execSync(`${platformNpm} ${args.join(" ")}`, { 
          cwd: STAFF_TOOLS_DIR,
          stdio: 'inherit',
          shell: true
        } as any);
        
        // After installation, verify the serverPath if it's node-managed
        if (isNodeManaged && !fs.existsSync(serverPath)) {
          console.error(`Installation finished but ${serverPath} still not found.`);
        }
      } catch (e) {
        console.error(`Failed to install LSP for ${language}:`, e);
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

  async ensureDocumentOpened(client: LSPClient, filePath: string, lang: string): Promise<boolean> {
    const uri = `file://${filePath}`;
    const content = fs.readFileSync(filePath, "utf-8");
    const doc = this.documentVersions.get(filePath);

    if (!doc) {
      await client.notification("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId: lang,
          version: 1,
          text: content
        }
      });
      this.documentVersions.set(filePath, { version: 1, content });
      return true; // Changed
    } else if (doc.content !== content) {
      const newVersion = doc.version + 1;
      await client.notification("textDocument/didChange", {
        textDocument: {
          uri,
          version: newVersion
        },
        contentChanges: [{ text: content }]
      });
      this.documentVersions.set(filePath, { version: newVersion, content });
      return true; // Changed
    }
    return false; // Not changed
  }

  async getDiagnostics(filePath: string, rootPath: string): Promise<any[]> {
    const ext = path.extname(filePath);
    const lang = Object.keys(DEFAULT_CONFIGS).find(l => DEFAULT_CONFIGS[l].extensions.includes(ext));
    if (!lang) return [];

    const client = await this.getClient(lang, rootPath);
    const uri = `file://${filePath}`;
    
    // Determine if file changed before setting up intervals to prevent race conditions
    let changed = false;
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const doc = this.documentVersions.get(filePath);
      changed = !doc || doc.content !== content;
      if (changed) {
        client.diagnostics.delete(uri);
      }
    } catch (e) {
      // Ignore fs errors here
    }

    return new Promise(async (resolve) => {
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          // Return cached if timeout
          resolve(client.diagnostics.get(uri) || []);
        }
      }, 3000); // Wait for async diagnostics

      const checkInterval = setInterval(() => {
        if (client.diagnostics.has(uri) && !resolved) {
          resolved = true;
          clearInterval(checkInterval);
          clearTimeout(timeout);
          resolve(client.diagnostics.get(uri)!);
        }
      }, 100);

      try {
        await this.ensureDocumentOpened(client, filePath, lang);
        // If it didn't change, we resolve immediately if cached
        if (!changed && client.diagnostics.has(uri) && !resolved) {
          resolved = true;
          clearInterval(checkInterval);
          clearTimeout(timeout);
          resolve(client.diagnostics.get(uri)!);
        }
      } catch (e) {
        // ignore
      }
    });
  }

  async hover(filePath: string, line: number, character: number, rootPath: string): Promise<string> {
    const ext = path.extname(filePath);
    const lang = Object.keys(DEFAULT_CONFIGS).find(l => DEFAULT_CONFIGS[l].extensions.includes(ext));
    if (!lang) return "Unsupported language";

    const client = await this.getClient(lang, rootPath);
    await this.ensureDocumentOpened(client, filePath, lang);
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
    await this.ensureDocumentOpened(client, filePath, lang);
    const result = await client.request("textDocument/definition", {
      textDocument: { uri: `file://${filePath}` },
      position: { line: line - 1, character: character - 1 }
    });

    if (!result) return "Definition not found";
    
    const locations = Array.isArray(result) ? result : [result];
    if (locations.length === 0) return "Definition not found";
    
    return locations.map((loc: any) => {
      const uri = loc.uri || loc.targetUri;
      const range = loc.range || loc.targetSelectionRange;
      return `${uri.replace('file://', '')}:${range.start.line + 1}`;
    }).join("\n");
  }
  async getDocumentSymbols(filePath: string, rootPath: string): Promise<any[]> {
    const ext = path.extname(filePath);
    const lang = Object.keys(DEFAULT_CONFIGS).find(l => DEFAULT_CONFIGS[l].extensions.includes(ext));
    if (!lang) throw new Error(`Unsupported language for extension ${ext}`);

    const client = await this.getClient(lang, rootPath);
    await this.ensureDocumentOpened(client, filePath, lang);
    const result = await client.request("textDocument/documentSymbol", {
      textDocument: { uri: `file://${filePath}` }
    });

    return result || [];
  }

  async findReferences(filePath: string, line: number, character: number, rootPath: string): Promise<any[]> {
    const ext = path.extname(filePath);
    const lang = Object.keys(DEFAULT_CONFIGS).find(l => DEFAULT_CONFIGS[l].extensions.includes(ext));
    if (!lang) throw new Error(`Unsupported language for extension ${ext}`);

    const client = await this.getClient(lang, rootPath);
    await this.ensureDocumentOpened(client, filePath, lang);
    const result = await client.request("textDocument/references", {
      textDocument: { uri: `file://${filePath}` },
      position: { line, character },
      context: { includeDeclaration: true }
    });

    return result || [];
  }
}

export const lspManager = new LSPManager();
