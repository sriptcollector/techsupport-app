# Tech Support by Westward (desktop app)

A button in your Mac menu bar or by the Windows clock. Press it and pick **"I don't know how to do something"** or **"Something is broken"**, then talk or type. A small character with a headset moves to each spot, says what it's doing, and does the clicks and typing, so you learn as it goes. Risky things (deleting, paying, sending, passwords, installing) wait for one big **Yes**.

This repository is the whole desktop app, open so anyone can check what it does on their computer. The service it talks to (sign-in, billing, the AI) is run by Westward at techsupport.westwardconsulting.ai.

## What leaves your computer
- **Screenshots**, only during a help session you started, scaled down before they're sent.
- **Your voice**, only while the mic is on (the computer's own mic light shows it), turned into words and not kept.
- **What you type** in the help box.
Nothing runs in the background except the button.

## Rules the AI can't change
These live in this code, not on the server (`app/src-tauri/src/input.rs`, `app/src/agent.ts`):
- It never types card numbers, social security numbers or one-time codes; you type those.
- Risky actions need a Yes; a line that sounds risky without a Yes blocks the next click.
- Moving the mouse, pressing Esc, saying "stop" or pressing Stop halts everything immediately.
- Its own windows are hidden from the screenshots the AI sees.

## Build it yourself
Needs [Bun](https://bun.sh) and [Rust](https://rustup.rs).
```
cd app
bun install
bunx tauri build
```
Release builds are made by `.github/workflows/release.yml`; each lists its SHA-256.

## License
GPL-3.0. See `LICENSE`.
