// Strict linting for the SDK. This is the public contract other codebases import, so
// the rules lean toward catching unsound types and an unclear public surface.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**"] },
  {
    files: ["src/**/*.ts"],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.strictTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The public API must have explicit input and output types so the generated
      // types stay stable and a change to the surface is deliberate.
      "@typescript-eslint/explicit-module-boundary-types": "error",
      // Interpolating a number (an HTTP status, a byte count) is fine and readable.
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
    },
  },
);
