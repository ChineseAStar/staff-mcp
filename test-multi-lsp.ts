import { lspManager } from "./src/lsp/manager.js";
import * as path from "path";
import * as fs from "fs";

async function testLanguage(lang: string, fileName: string, content: string, hoverPos: {line: number, char: number}) {
    console.log(`\n--- Testing Language: ${lang} ---`);
    const rootPath = process.cwd();
    const filePath = path.resolve(fileName);
    fs.writeFileSync(filePath, content);

    try {
        console.log(`[${lang}] Checking Server Status...`);
        // Just check if we can get client
        const client = await lspManager.getClient(lang, rootPath);
        
        console.log(`[${lang}] Testing Diagnostics...`);
        const diagnostics = await lspManager.getDiagnostics(filePath, rootPath);
        console.log(`[${lang}] Diagnostics Count:`, diagnostics.length);

        console.log(`[${lang}] Testing Hover...`);
        const hover = await lspManager.hover(filePath, hoverPos.line, hoverPos.char, rootPath);
        console.log(`[${lang}] Hover Result:`, hover.substring(0, 100) + (hover.length > 100 ? "..." : ""));

        console.log(`[${lang}] Testing Definition...`);
        const definition = await lspManager.go_to_definition_internal(filePath, hoverPos.line + 1, hoverPos.char + 1, rootPath);
        console.log(`[${lang}] Definition Result:`, definition);

    } catch (e: any) {
        console.log(`[${lang}] ⚠️ Skipped or failed: Server might not be in environment.`);
    } finally {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
}

async function runAllTests() {
    // 1. Python (Should be auto-installed)
    await testLanguage("python", "test.py", "def hello():\n    print('hi')\nhello()", {line: 0, char: 4});

    // 2. Go (If gopls exists)
    await testLanguage("go", "test.go", "package main\nimport \"fmt\"\nfunc main() {\n    fmt.Println(\"hello\")\n}", {line: 3, char: 8});

    // 3. Rust (If rust-analyzer exists)
    await testLanguage("rust", "test.rs", "fn main() {\n    let x = 5;\n    println!(\"{}\", x);\n}", {line: 1, char: 8});

    // 4. C++ (If clangd exists)
    await testLanguage("cpp", "test.cpp", "#include <iostream>\nint main() {\n    int a = 10;\n    return 0;\n}", {line: 2, char: 8});

    process.exit(0);
}

runAllTests();
