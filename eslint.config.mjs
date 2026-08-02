// Lint config matching what the community-plugin scanner runs.
//
// The sources in src/ are one shared scope split across files — build.sh
// concatenates them in order and 10-core.js declares what the rest closes
// over. Per-file `no-undef` is therefore meaningless there, so it is checked
// on the concatenated main.js instead, where the scope is whole.
import js from "@eslint/js";
import globals from "globals";
import obsidianmd from "eslint-plugin-obsidianmd";

const language = {
  ecmaVersion: 2022,
  sourceType: "commonjs",
  globals: {
    ...globals.browser,
    ...globals.node,
    activeDocument: "readonly",
    activeWindow: "readonly",
  },
};

export default [
  {
    ignores: ["node_modules/**", "piper-server.js", "test/**"],
  },
  js.configs.recommended,
  ...obsidianmd.configs.recommended,
  {
    files: ["src/**/*.js", "main.js"],
    languageOptions: language,
    rules: {
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    files: ["src/**/*.js"],
    rules: {
      "no-undef": "off",
      // Everything declared at the top of a src file is meant to be visible to
      // the files concatenated after it — that is what makes this a bundle and
      // not fifteen unrelated scripts. Both rules read that as a mistake.
      "no-implicit-globals": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  {
    // Generated output. The obsidianmd rules already ran on the sources, and
    // its top level is a CommonJS module scope once Obsidian loads it, not the
    // global scope eslint assumes. What is worth checking here is `no-undef`:
    // the files reach each other through shared scope, so a name that exists
    // nowhere only shows up when the pieces are put back together.
    files: ["main.js"],
    rules: {
      ...Object.fromEntries(
        Object.keys(obsidianmd.rules ?? {}).map((r) => [`obsidianmd/${r}`, "off"]),
      ),
      "no-implicit-globals": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
];
