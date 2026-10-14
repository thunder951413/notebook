fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        cc::Build::new().file("native/input_source.c").compile("notebook_input_source");
        cc::Build::new().file("native/pasteboard.m").flag("-fobjc-arc").compile("notebook_pasteboard");
        println!("cargo:rustc-link-lib=framework=AppKit");
        println!("cargo:rerun-if-changed=native/pasteboard.m");
        println!("cargo:rustc-link-lib=framework=Carbon");
        println!("cargo:rustc-link-lib=framework=CoreFoundation");
        println!("cargo:rerun-if-changed=native/input_source.c");
    }
    tauri_build::build()
}
