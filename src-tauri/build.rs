fn main() {
    // Load .env file if present (for local dev builds)
    if let Ok(content) = std::fs::read_to_string(".env") {
        for line in content.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') { continue; }
            if let Some((key, val)) = line.split_once('=') {
                std::env::set_var(key.trim(), val.trim());
            }
        }
    }

    // XOR-encode the GitHub bug-report PAT at compile time so it doesn't
    // appear as a plaintext string in the binary or source code.
    if let Ok(token) = std::env::var("CODFISH_GH_PAT") {
        let key = 0xA5u8;
        let encoded: Vec<String> = token.bytes().map(|b| format!("0x{:02X}", b ^ key)).collect();
        println!("cargo:rustc-env=GH_PAT_XOR={}", encoded.join(","));
    } else {
        // Fallback: empty token — bug reporting will fail gracefully
        println!("cargo:rustc-env=GH_PAT_XOR=");
    }

    tauri_build::build()
}
