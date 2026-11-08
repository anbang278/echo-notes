import obsidianmd from "eslint-plugin-obsidianmd";

const PROJECT_BRANDS = [
	"Obsidian",
	"OpenAI",
	"Markdown",
	"Echo Notes",
	"Echo Memory",
	"AgentPlan",
	"MOSI",
	"Audio recorder",
	"Task Center",
	"SecretStorage",
	"API Key",
	"Base URL",
	"Vault",
	"Dataview",
	"LinkOnly",
	"ASR",
	"Codex",
	"Hermes",
	"Agent",
	"Skill",
	"ISO",
	"Unicode"
];

export default [
	...obsidianmd.configs.recommended,
	{
		files: ["src/**/*.ts"],
		languageOptions: {
			parserOptions: {
				project: "./tsconfig.json",
				tsconfigRootDir: import.meta.dirname
			}
		},
		rules: {
			"@typescript-eslint/no-unnecessary-type-assertion": "error",
			"obsidianmd/ui/sentence-case": [
				"warn",
				{
					enforceCamelCaseLower: true,
					brands: PROJECT_BRANDS,
					ignoreRegex: ["^(?:sk-|https?://)", "^Asia/Taipei$", "[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]"]
				}
			]
		}
	},
	{
		files: ["src/agent-memory/node/**/*.ts"],
		languageOptions: { globals: { process: "readonly", Buffer: "readonly", console: "readonly", TextEncoder: "readonly" } },
		rules: {
			"obsidianmd/no-nodejs-modules": "off",
			"obsidianmd/no-global-this": "off",
			"obsidianmd/hardcoded-config-path": "off"
		}
	}
];
