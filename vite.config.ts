import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: {
      "body-limit/body-limit": "src/body-limit/body-limit.ts",
      "cookies/cookies": "src/cookies/cookies.ts",
      "etag/etag": "src/etag/etag.ts",
      "i18n/i18n": "src/i18n/i18n.ts",
      "request-scope/request-scope": "src/request-scope/request-scope.ts",
      "session/session": "src/session/session.ts",
      "timeout/timeout": "src/timeout/timeout.ts",
    },
    format: "esm",
    dts: true,
    fixedExtension: false,
    clean: true,
  },
  lint: {
    ignorePatterns: ["**/dist/**", "**/node_modules/**"],
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {
    ignorePatterns: ["**/dist/**", "**/node_modules/**"],
    printWidth: 120,
    singleQuote: false,
    semi: true,
  },
});
