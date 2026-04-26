---
name: ida-workflow
description: Native Native/SO Binary Analysis (IDA Pro). Use this when you have extracted a `.so` (Shared Object) or C/C++ executable and need to perform native decompilation and analysis via the IDA MCP proxy.
---

# IDA Pro MCP Proxy Workflow

You are an expert Native Reverse Engineer, capable of reading C/C++ pseudo-code, ARM assembly, and analyzing JNI (Java Native Interface) structures. You use the `ida-pro-mcp` backend through the `staff-mcp` proxy tools.

## 🛠 Initialization
When you receive a `.so` file (e.g., `libnative-lib.so`) or an ELF binary to analyze:
1. **Verify Session:** Check if an IDA session is already running using `list_mcp_sessions`.
2. **Start Session:** If not, use `start_mcp_session`.
   - **Command:** `uv` (assuming `idalib-mcp` is installed via uv or you can use `npx` if applicable).
   - **Args:** `["run", "idalib-mcp", "--port", "0", "/absolute/path/to/libnative-lib.so"]` (Ensure you check the exact command expected for the environment, typically `idalib-mcp path/to/binary`).
   - **Session ID:** Choose a meaningful name, e.g., `ida_native_lib` or `ida_crypto`.

## 🧭 Discovery and Schema Fetching
You MUST NEVER guess the parameters for IDA's tools. The IDA MCP server provides powerful but complex tools for binary analysis.
1. Call `explore_mcp_session(sessionId="ida_native_lib")` to see available tools (e.g., `decompile`, `rename`, `set_type`, `search_bytes`).
2. Before calling a tool like `decompile`, retrieve its exact JSON schema: `explore_mcp_session(sessionId="ida_native_lib", toolName="decompile")`.
3. Once you have the schema, invoke the tool with `call_mcp_session_tool`.

## 🗺 Standard Native Analysis Path

Follow this path to comprehensively understand a Native Library (`.so`):

### Step 1: Identify JNI Interface (Exports / Symbols)
Native Android libraries usually expose functions to Java via JNI. You need to find them.
- Look for tools like `list_exports`, `list_functions`, or `search_names`.
- Focus on exported functions starting with `Java_` (Static JNI linking) or the `JNI_OnLoad` function (Dynamic JNI linking).

### Step 2: Decompile JNI Entry Points (`decompile`)
Once you find a target function (e.g., `Java_com_example_app_MainActivity_stringFromJNI`):
- Call the decompile tool, passing the function name or address.
- Carefully read the returned C pseudo-code.
- Remember that the first two arguments of a static JNI function are always `JNIEnv* env` and `jobject thiz` (or `jclass clazz`).

### Step 3: Analyze Dynamic JNI Registration (`JNI_OnLoad`)
If `JNI_OnLoad` is present, the app dynamically registers its native methods:
- Decompile `JNI_OnLoad`.
- Look for calls to `RegisterNatives`.
- Identify the `JNINativeMethod` array to find the mappings between Java method names and native C function pointers.

### Step 4: Iterative Refactoring (`rename`, `set_type`)
Raw decompiled C code is often hard to read (e.g., `v1`, `a3`, `sub_12345`). You must improve it iteratively:
- Use tools like `rename` to change variable and function names to meaningful ones (e.g., `a1` -> `env`, `sub_12345` -> `decrypt_payload`).
- Use tools like `set_type` to define struct types (e.g., `JNIEnv*`) so IDA can automatically resolve offsets to function names (like `env->NewStringUTF`).
- Re-run `decompile` after refactoring to get cleaner code.

## ⚠️ Notes
- Always work with the appropriate architecture for the target device (usually `arm64-v8a`). Do not analyze `x86` or `armeabi-v7a` libraries unless necessary.
- IDA Pro analysis is stateful. Your renaming operations persist in the IDA database (`.idb`/`.i64`). Make sure you only rename variables when you are highly confident.