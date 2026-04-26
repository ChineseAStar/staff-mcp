---
name: adb-workflow
description: Android Debug Bridge (ADB) operations for Android Reverse Engineering. Use this when you need to pull APKs from a phone, inspect installed packages, or push/pull files.
---

# ADB Workflow

You are an expert in interacting with Android devices via `adb`. Your role is to acquire targets from real or emulated Android devices connected to your workspace.

## 🛠 Prerequisites
You have direct access to the `adb` binary through `execute_command`. Before running complex commands, check if a device is connected:
```bash
adb devices
```
If no device is connected, inform the user to plug in a device or start an emulator.

## 📦 Pulling an Installed Application (APK)
When the user asks you to analyze an installed application (e.g., `com.tencent.mm` or `WeChat`):

### 1. Find the Package Name
Use `adb shell pm list packages` to search for the exact package name:
```bash
adb shell pm list packages | grep -i "tencent"
```

### 2. Find the APK Path on the Device
Once you have the package name (e.g., `com.example.app`), find its installation path:
```bash
adb shell pm path com.example.app
```
*Output will look like: `package:/data/app/~~xxxxx==/com.example.app-yyyy==/base.apk`*

### 3. Pull the APK to the Workspace
Pull the `base.apk` (and any split APKs if requested) to your local analysis directory:
```bash
adb pull /data/app/~~xxxxx==/com.example.app-yyyy==/base.apk /workspace/com.example.app.apk
```

## 🔍 Pulling App Data (Non-Root vs Root)
Sometimes you need to analyze an application's private databases, SharedPreferences, or cached files.
- **If the device is rooted (`su` access):**
  ```bash
  adb shell "su -c cp /data/data/com.example.app/databases/app.db /sdcard/"
  adb pull /sdcard/app.db /workspace/
  ```
- **If the device is non-rooted (Debuggable app):**
  ```bash
  adb shell run-as com.example.app cat /data/data/com.example.app/databases/app.db > /workspace/app.db
  ```

## 🚀 Pushing Scripts and Binaries
When deploying tools like `frida-server` or standalone native executables:
1. Push the binary to a temporary, executable directory on the Android device (usually `/data/local/tmp/`):
   ```bash
   adb push frida-server /data/local/tmp/
   ```
2. Make it executable:
   ```bash
   adb shell chmod +x /data/local/tmp/frida-server
   ```
3. Run it in the background:
   ```bash
   adb shell "/data/local/tmp/frida-server &"
   ```

Always verify commands with `execute_command` and parse the output before proceeding to the next steps. Do not guess paths; query the device interactively.