import type {
  McpServer,
  ReadResourceResult,
  ResourceTemplateType,
} from "@modelcontextprotocol/server";
import { SkillsExtension, SKILL_LIMITS, skillEntry } from "@modelcontextprotocol/server/ext/skills";
import type { Skill, SkillReadResult, SkillSource } from "@modelcontextprotocol/server/ext/skills";
import * as fs from "fs/promises";
import * as path from "path";
import { SkillManager } from "./manager.js";
import type { SkillInfo } from "./manager.js";

const BASE_URI = "skill://staff/";

/** Explicit composition hook for staff's existing resource handler. */
export interface SkillResources {
  template: ResourceTemplateType;
  readResource(uri: string): Promise<ReadResourceResult | undefined>;
}

function parseSkillUri(uri: string): { name: string; relativePath: string } | undefined {
  if (!/^skill:\/\/staff(?:[/?#]|$)/i.test(uri)) return undefined;
  if (!uri.startsWith(BASE_URI) || /[?#\\\0]/.test(uri)) {
    throw new Error("Invalid staff skill URI.");
  }
  const segments = uri
    .slice(BASE_URI.length)
    .split("/")
    .map((segment) => {
      const decoded = decodeURIComponent(segment);
      if (decoded.includes("/")) throw new Error("Invalid encoded skill path separator.");
      SkillManager.validateSkillRelativePath(decoded);
      return decoded;
    });
  if (segments.length < 2) throw new Error("A skill resource must identify a file.");
  const [name, ...relative] = segments;
  return { name, relativePath: relative.join("/") };
}

/** Read only the selected skill's small tree; no workspace scan or retained manifest cache. */
async function buildManifest(
  skill: SkillInfo,
): Promise<{ entry: Skill; files: Record<string, Buffer> }> {
  if (skill.name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name)) {
    throw new Error("Skill name is not valid for the standard skills directory.");
  }
  const baseDir = await SkillManager.getSkillDirectory(skill);
  const files: Record<string, Buffer> = Object.create(null);
  let count = 0;
  let bytes = 0;
  const walk = async (directory: string, prefix: string): Promise<void> => {
    const stat = await fs.lstat(directory);
    const relative = path.relative(baseDir, await fs.realpath(directory));
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error("Skill contains an unsafe directory.");
    }
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const item of entries) {
      const filePath = prefix ? `${prefix}/${item.name}` : item.name;
      SkillManager.validateSkillRelativePath(filePath);
      if (item.isDirectory()) {
        await walk(path.join(directory, item.name), filePath);
      } else if (item.isFile()) {
        if (++count > SKILL_LIMITS.files) throw new Error("Skill exceeds its file-count budget.");
        const raw = await SkillManager.readSkillFile(skill, filePath, SKILL_LIMITS.bytes - bytes);
        bytes += raw.byteLength;
        files[filePath] = raw;
      } else {
        throw new Error("Skill contains a symlink or special file.");
      }
    }
  };
  await walk(baseDir, "");
  if (!files["SKILL.md"]) throw new Error("Skill is missing SKILL.md.");
  toReadResult("SKILL.md", files["SKILL.md"]);
  const entry = await skillEntry(skill.name, files, { baseUri: BASE_URI });
  return { entry, files };
}

function toReadResult(relativePath: string, bytes: Buffer): SkillReadResult {
  try {
    // Keep the BOM: re-encoding the text must reproduce the bytes covered by the digest.
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (!text.includes("\0")) {
      return { text, mimeType: relativePath.endsWith(".md") ? "text/markdown" : "text/plain" };
    }
  } catch {
    // Supporting files may be binary; SKILL.md itself must always be UTF-8 text.
  }
  if (relativePath === "SKILL.md") throw new Error("SKILL.md must be UTF-8 text.");
  return { bytes, mimeType: "application/octet-stream" };
}

/** Synchronous attachment; SDK owns skills RPCs, validation and capability declaration. */
export function registerSkillResources(
  server: McpServer,
  workingDir: string,
  profile: string = "default",
): SkillResources {
  const selected = (name: string): SkillInfo => {
    const skills = SkillManager.loadSkills(workingDir, profile);
    const skill = Object.values(skills).find((item) => item.name === name);
    if (!skill) throw new Error(`Skill "${name}" not found.`);
    return skill;
  };
  const read = async (uri: string): Promise<SkillReadResult | undefined> => {
    const parsed = parseSkillUri(uri);
    if (!parsed) return undefined;
    const { files, entry } = await buildManifest(selected(parsed.name));
    const raw = files[parsed.relativePath];
    if (!raw || entry.frontmatter.name !== parsed.name) throw new Error("Unknown skill resource.");
    return toReadResult(parsed.relativePath, raw);
  };
  const source: SkillSource = {
    async list({ cursor }) {
      if (cursor !== undefined) throw new Error("Skill listing does not accept a cursor.");
      const skills: Skill[] = [];
      for (const selectedSkill of Object.values(SkillManager.loadSkills(workingDir, profile))) {
        try {
          const { entry } = await buildManifest(selectedSkill);
          skills.push(entry);
        } catch {
          console.warn(
            "[Skills] Selected skill omitted: invalid metadata, unsafe files or publication limits.",
          );
        }
      }
      skills.sort((a, b) => (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0));
      return { skills };
    },
    async get(uri) {
      const parsed = parseSkillUri(uri);
      if (!parsed) return undefined;
      if (parsed.relativePath !== "SKILL.md")
        throw new Error("Skill entry URI must end in /SKILL.md.");
      return (await buildManifest(selected(parsed.name))).entry;
    },
    read,
    // No listResources: concrete resources/list stays empty. No directory-read capability.
  };
  new SkillsExtension({
    source,
    baseUri: BASE_URI,
    cacheHint: { ttlMs: 0, cacheScope: "private" },
  }).attach(server);
  return {
    template: {
      name: "io.modelcontextprotocol/skills",
      uriTemplate: `${BASE_URI}{+path}`,
    },
    async readResource(uri) {
      const result = await read(uri);
      if (!result) return undefined;
      return {
        contents: [
          "text" in result
            ? { uri, text: result.text, mimeType: result.mimeType }
            : {
                uri,
                blob: Buffer.from(result.bytes).toString("base64"),
                mimeType: result.mimeType,
              },
        ],
      };
    },
  };
}
