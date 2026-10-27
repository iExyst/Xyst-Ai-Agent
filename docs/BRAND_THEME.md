# Xyst brand theme

The interface palette follows the alien artwork in `gui/assets/brand-icon.png`. Its pale aqua faceplate, lime eyes, cyan armor, violet trim, and electric-blue glow define the shared product identity:

| Role | Dark palette | Light palette |
| --- | --- | --- |
| Cyan shell | `#58eaff` | `#087eaa` |
| Mint highlights | `#a1fff1` | `#087e8a` |
| Lime eyes and primary actions | `#c5ff48` | `#537d00` |
| Violet trim | `#b78aff` | `#7146bd` |
| Electric blue glow | `#176cff` | `#176cff` |

The browser and desktop app share semantic color variables in `gui/styles.css`. The alien mark appears in the app identity, workspace footer, welcome screen, and assistant replies. Panels and controls use rounded shapes, cyan focus rings, and restrained blue and violet glow from the artwork. Runtime settings keep **System**, **Dark**, and **Light** appearance choices, including matching code, status, and error surfaces. The VS Code chat uses the same accents while taking its base surfaces from the active editor theme. The startup screen has matching variables in `gui/desktop/ui/styles.css`, and terminal output uses the RGB palette in `src/cli/terminal-theme.mjs`.

When changing the artwork or palette, update those four token sets together. `pnpm smoke:browser` checks representative browser surfaces and brand accents in dark and light themes. Regenerate the desktop icon variants from the canonical artwork in `gui/assets/brand-icon.png` with `pnpm exec node scripts/build-desktop-icon.mjs`; do not hand-edit the generated Tauri icon files.
