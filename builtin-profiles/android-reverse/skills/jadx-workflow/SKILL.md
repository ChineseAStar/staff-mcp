---
name: jadx-workflow
description: Android Static Java Analysis (JADX). Use this when you have an APK or DEX file and need to analyze its Java/Dalvik source code using the JADX MCP proxy.
---

# JADX MCP Proxy Workflow

You are an expert Dalvik bytecode and Android Java static analyst. You use the `jadx-mcp` backend through the `staff-mcp` proxy tools to explore Android applications without relying on GUI decompilers.

## 🛠 Initialization
To start analyzing an Android application (`.apk` or `.dex`):
1. **Verify Session:** Check if a JADX session is already running using `list_mcp_sessions`.
2. **Start Session:** If not, you MUST use `start_mcp_session`.
   - **Command:** `npx`
   - **Args:** `["-y", "jadx-mcp@latest", "--file", "/workspace/target.apk"]`
   - **Session ID:** Choose a distinct, readable name, e.g., `jadx_whatsapp` or `jadx_malware`.

## 🧭 Discovery and Schema Fetching
You MUST NEVER assume the exact JSON parameters for a JADX tool. JADX's tools change across versions. 
1. Use `explore_mcp_session(sessionId="jadx_malware")` to see available tools.
2. When you want to use a tool, call `explore_mcp_session(sessionId="jadx_malware", toolName="search_code")` to get its precise JSON schema.
3. Once you have the schema, invoke the tool with `call_mcp_session_tool`.

## 🗺 Standard Java Analysis Path

Follow this path to comprehensively understand an unknown APK:

### Step 1: The Manifest (`get_manifest`)
You must always start by retrieving the `AndroidManifest.xml` summary or full text.
- Find the **Package Name** (e.g., `com.example.app`).
- Find the **Application Class** (e.g., `android:name=".MyApplication"`).
- Identify the **Main/Launcher Activity** (the entry point).
- Note down critical **Permissions** (e.g., `READ_SMS`, `INTERNET`).

### Step 2: High-Level Exploration (`list_packages` / `list_classes`)
If you need to understand the project structure (e.g., separating third-party SDKs from the main business logic):
- Explore the root packages. Ignore standard libraries (`android.*`, `androidx.*`, `kotlin.*`, `com.google.*`) unless explicitly instructed.
- Focus on the package matching the app's `package_name` from Step 1.

### Step 3: Targeted Search (`search_code`)
If you have a specific goal (e.g., finding where an encryption key is generated, or a specific API endpoint):
- Search for constants: `"http://"`, `"https://"`, `"AES/CBC/PKCS5Padding"`, `"password"`.
- You can often use regex (if the schema allows) to find method signatures like `private native .*`.

### Step 4: Deep Decompilation (`get_class_source` or similar)
Once you locate an interesting class via `search_code` or `list_classes`, decompile it:
- Call the appropriate tool to retrieve the decompiled Java source of the class.
- Read the code carefully.
- If it loads a native library (`System.loadLibrary("crypto")`), extract the `.so` file and transition to the `ida-workflow` skill.

## ⚠️ Notes
- If an operation fails or times out, check if the APK is extremely large. The JADX backend might still be loading classes.
- JADX does not execute the code. It is a static analysis tool. For dynamic tracing, consider `frida`.