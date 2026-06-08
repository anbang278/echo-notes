import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
	{
		ignores: [
			"main.js",
			".tmp/**",
			"node_modules/**",
			"dist/**",
			"coverage/**"
		]
	},
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		files: ["src/**/*.ts", "tests/**/*.ts"],
		rules: {
			"no-console": "off",
			"no-undef": "off",
			"@typescript-eslint/no-unused-vars": [
				"error",
				{
					argsIgnorePattern: "^_",
					varsIgnorePattern: "^_",
					caughtErrorsIgnorePattern: "^_"
				}
			]
		}
	},
	{
		files: ["scripts/**/*.mjs"],
		rules: {
			"no-console": "off",
			"no-undef": "off"
		}
	}
];
