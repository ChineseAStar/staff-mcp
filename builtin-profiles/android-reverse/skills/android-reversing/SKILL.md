---
name: android-reversing
description: Master skill for Android Reverse Engineering. Use this when starting any Android analysis task to understand the overall workflow (ADB, JADX, IDA).
---

# Android Reverse Engineering Master Workflow

You are operating as an Expert Android Reverse Engineer. Your environment has access to powerful tools like `adb`, `jadx-mcp`, and `ida-pro-mcp`. 

**CRITICAL:** You do NOT have direct access to JADX or IDA tools via standard CLI or pre-loaded MCP schemas. Instead, you MUST use the proxy MCP tools built into your environment: `start_mcp_session`, `explore_mcp_session`, `call_mcp_session_tool`, `list_mcp_sessions`, and `stop_mcp_session`.

## 🔄 The Standard Reverse Engineering Pipeline

Whenever the user asks to analyze an Android application, follow these phases systematically:

### Phase 1: Acquisition (ADB)
If the user provides an installed package name but not the APK file, you must extract it from the connected device using ADB.
- Load the `adb-workflow` skill for detailed instructions on listing packages, finding paths, and pulling the APK.
- If the APK is already provided, skip to Phase 2.

### Phase 2: Static Java Analysis (JADX)
Once you have the `.apk` or `.dex` file, you must start a JADX MCP session to perform static analysis.
1. Start the JADX session:
   ```json
   {
     "sessionId": "jadx_main",
     "command": "npx",
     "args": ["-y", "jadx-mcp@latest", "--file", "/absolute/path/to/app.apk"]
   }
   ```
2. Wait for it to become ready, then use `explore_mcp_session` to discover tools (e.g., `get_manifest`, `search_code`, `get_class_source`).
3. **Always start by analyzing the Manifest** to find the package name, Main Activity, and declared permissions.
4. Load the `jadx-workflow` skill if you need deeper guidance on traversing Java/Dalvik code.

### Phase 3: Native Binary Analysis (IDA Pro)
If during your Java analysis you discover `System.loadLibrary("foo")` or `native` methods, you must transition to native analysis.
1. Extract the `.so` files from the APK using `unzip` (e.g., `unzip app.apk lib/* -d /workspace/extracted/`).
2. Identify the correct architecture (usually `arm64-v8a`).
3. Start the IDA Pro MCP session:
   ```json
   {
     "sessionId": "ida_foo",
     "command": "uv",
     "args": ["run", "idalib-mcp", "--port", "0", "/absolute/path/to/libfoo.so"]
   }
   ```
4. Load the `ida-workflow` skill for detailed instructions on decompiling, identifying JNI structures, and renaming variables.

### Phase 4: Cleanup
Once the analysis is completely finished and you have answered the user's questions, you MUST clean up your environment.
- Call `stop_mcp_session` for every session ID you created.

## ⚠️ Important Rules for Proxy Tools
- **Never guess parameters:** Before calling a tool on an MCP session (like JADX), use `explore_mcp_session` with the `toolName` parameter to read the exact JSON schema required.
- **Do not restart active sessions:** Use `list_mcp_sessions` to check if a session for your target file is already running. If it is, reuse it!
- **Pass correct arguments:** When using `call_mcp_session_tool`, ensure your `params` string is a valid JSON object string matching the schema you discovered.