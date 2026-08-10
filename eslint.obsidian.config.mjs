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
	"LinkOnly"
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
			"obsidianmd/ui/sentence-case": [
				"warn",
				{
					enforceCamelCaseLower: true,
					brands: PROJECT_BRANDS,
					ignoreRegex: ["^(?:sk-|https?://)"]
				}
			]
		}
	}
];
