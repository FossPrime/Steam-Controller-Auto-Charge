# Coding Rules

- **NEVER** use CommonJS (CJS). No `require()`, no `module.exports`, no `.cjs` files.
- **ALWAYS** use modern ESM + TypeScript. `import`/`export`, `.ts`/`.mts`, Node 20+ features, `"type": "module"`.
- Use good TypeScript. Avoid `any`. Prefer `interface`/`type`, proper generics, avoid loose typing.
- Code like Anthony Fu and Evan You: clean, minimal, elegant, high-signal, zero bloat. Thoughtful APIs, excellent DX, performant by default. Avoid over-abstraction and enterprise patterns.
- Prefer Vite
- When generating code, default to the highest quality modern TS/JS the legends would ship. Avoid legacy stuff, when there is a fully functional modern alternative.
- **NEVER** use `!important` in css.
- Prefer using nix-shell for system dependencies over Docker, nix-instantiate or globals.
- Use nix-shell instead of nix-instantiate when possible
- If this is a NixOS machine, You have these linux programs availble out of the box /etc/nixos/configuration.nix
- **ALWAYS** run and test your code, if possible
- **ALWAYS** run all the tests, if any, and fix any issues before finishing. By the end of you run all the tests should be passing.
- When I ask you to fix a bug, fix it and add tests to make sure it doesn't happen again
- Keep the module loading self contained, the user should be able to run this locally with no internet
- Keep system requirements under 16GB of RAM and 8GB of vRAM, it should run on the 2026 Steam Machine's Chromium browser

