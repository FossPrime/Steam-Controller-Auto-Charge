# shell.nix - Development environment for Steam Controller Auto-Charge
#
# Provides all system dependencies needed to build the Rust WASM obstacle
# detection CNN module and run the Vite dev server.
#
# Usage: nix-shell
#   This drops you into a shell with:
#   - Rust toolchain (stable) with wasm32-unknown-unknown target
#   - wasm-pack for building Rust -> WASM packages
#   - Node.js 20+ for the Vite frontend
#   - pkg-config and OpenSSL (needed by some Rust crates)
#
# The WASM module lives in src/wasm-obstacle-detect/ and is built with:
#   cd src/wasm-obstacle-detect && wasm-pack build --target web --out-dir ../wasm-pkg
#
# Then run the Vite dev server:
#   npm install && npm run dev

{ pkgs ? import <nixpkgs> {} }:

pkgs.mkShell {
  buildInputs = with pkgs; [
    # --- Rust toolchain ---
    # Stable Rust compiler, cargo, and standard library
    rustc
    cargo
    rustfmt
    clippy

    # wasm-pack: builds Rust crates into WASM packages with JS bindings
    wasm-pack

    # wasm-bindgen-cli: generates JS/TS glue code for wasm-bindgen
    wasm-bindgen-cli

    # binaryen: wasm-opt for optimizing WASM output size
    binaryen

    # lld: LLVM linker required for linking wasm32 binaries
    lld

    # --- Node.js ---
    # Node 24+ LTS for Vite dev server and test runner
    nodejs_24

    # --- System libraries ---
    # pkg-config: helps Cargo find native libraries
    pkg-config

    # OpenSSL: required by some Rust networking crates (transitive dep)
    openssl
  ];

  # Set up the Rust WASM target on shell entry
  shellHook = ''
    # Add wasm32 target if not already installed
    rustup target add wasm32-unknown-unknown 2>/dev/null || true

    echo ""
    echo "🎮 Steam Controller Auto-Charge Dev Environment"
    echo "   Rust $(rustc --version | cut -d' ' -f2)"
    echo "   Node $(node --version)"
    echo "   wasm-pack $(wasm-pack --version 2>/dev/null | cut -d' ' -f2)"
    echo ""
    echo "Build WASM:  cd src/wasm-obstacle-detect && wasm-pack build --target web --out-dir ../wasm-pkg"
    echo "Dev server:  npm run dev"
    echo "Run tests:   npm test"
    echo ""
  '';
}
