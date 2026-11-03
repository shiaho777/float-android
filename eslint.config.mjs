import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "out/**",
      "android/**",
      "ios/**",
      "node_modules/**",
      "_unused_assets/**",
      "public/**",
      "scripts/verify/.build/**",
    ],
  },
  {
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.browser },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    files: ["scripts/**/*.{js,mjs,cjs}", "*.{js,mjs,cjs}"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    files: ["scripts/**/*.js"],
    languageOptions: {
      sourceType: "commonjs",
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    rules: {
      // 存量风格问题：保留为警告（npm run lint 不会因此失败），后续逐步清理
      "@typescript-eslint/no-unused-vars": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
      "no-useless-escape": "warn",
      "no-useless-assignment": "warn",
      // 本地存储、可选能力探测等“尽力而为”的场景大量使用空 catch
      "no-empty": ["error", { allowEmptyCatch: true }],
      // 清洗模型输出、文件名时有意匹配控制字符
      "no-control-regex": "off",
      // 中文提示词正文里的全角空格是内容，不是排版错误
      "no-irregular-whitespace": ["error", { skipStrings: true, skipTemplates: true }],
    },
  },
);
