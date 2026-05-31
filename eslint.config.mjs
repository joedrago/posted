import js from "@eslint/js"
import globals from "globals"

const unusedVars = [
    "error",
    {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_"
    }
]

export default [
    js.configs.recommended,

    // Backend (CLI + server): runs under Node.
    {
        files: ["bin/**/*.{js,mjs,cjs}", "src/**/*.{js,mjs,cjs}", "*.{js,mjs,cjs}"],
        languageOptions: { globals: { ...globals.node } },
        rules: {
            "no-unused-vars": unusedVars
        }
    },

    // Frontend: vanilla JS served to the browser, no build step.
    {
        files: ["public/**/*.{js,mjs,cjs}"],
        languageOptions: { globals: { ...globals.browser } },
        rules: {
            "no-unused-vars": unusedVars
        }
    }
]
