import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { transformSync } from "esbuild";
import { CLI_APIS, CLI_OAUTH_FLOWS, CLI_PROVIDERS, pruneCliProviderModules } from "./coding-agent-bundle-profile.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const paths = [
	"packages/ai/src/providers/all.ts",
	"packages/ai/src/providers/openrouter.ts",
	"packages/ai/src/models.generated.ts",
	"packages/ai/src/compat.ts",
	"packages/ai/src/legacy-api-aliases.ts",
	"packages/ai/src/auth/oauth/load.ts",
	"packages/coding-agent/src/extensions/index.ts",
];

function inputs() {
	return new Map(
		paths.map((path) => [
			resolve(root, path.replace("/src/", "/dist/").replace(/\.ts$/, ".js")),
			transformSync(readFileSync(resolve(root, path), "utf8"), { loader: "ts" }).code,
		]),
	);
}

test("Node CLI catalogs and provider factories contain only the selected builtins", () => {
	const files = inputs();
	const originals = [...files];
	const output = pruneCliProviderModules(root, files);
	const providers = output.get(resolve(root, "packages/ai/dist/providers/all.js"));
	const catalog = output.get(resolve(root, "packages/ai/dist/models.generated.js"));
	assert.match(providers, /return \[githubCopilotProvider\(\),openaiCodexProvider\(\)\]/);
	assert.doesNotMatch(providers, /amazonBedrockProvider|googleProvider|anthropicProvider/);
	assert.match(providers, /export \{\s*radiusProvider\s*\}/);
	for (const provider of CLI_PROVIDERS) assert.ok(catalog.includes(`"${provider}":`));
	assert.doesNotMatch(catalog, /"anthropic":|"google":|"radius":|AMAZON_BEDROCK/);
	assert.deepEqual([...files], originals);
});

test("compat retains Copilot protocols and custom API registration without unrelated SDKs", () => {
	const output = pruneCliProviderModules(root, inputs());
	const compat = output.get(resolve(root, "packages/ai/dist/compat.js"));
	const aliases = output.get(resolve(root, "packages/ai/dist/legacy-api-aliases.js"));
	for (const api of CLI_APIS) assert.ok(compat.includes(`"${api}"`));
	assert.doesNotMatch(compat, /azure-openai-responses|bedrock-converse-stream|google-generative-ai|mistral-conversations/);
	assert.match(compat, /function registerApiProvider/);
	assert.match(compat, /function registerFauxProvider/);
	assert.match(aliases, /streamAnthropic|streamOpenAICompletions|streamOpenAICodexResponses/);
	assert.doesNotMatch(aliases, /azureOpenAI|googleGenerative|googleVertex|mistralConversations|streamGoogle/);
});

test("every retained OAuth loader has an emitted lazy entry", () => {
	const output = pruneCliProviderModules(root, inputs());
	const oauth = output.get(resolve(root, "packages/ai/dist/auth/oauth/load.js"));
	const flows = [...oauth.matchAll(/importOAuthModule\("\.\/([^"]+)\.ts"\)/g)].map((match) => match[1]).sort();
	assert.deepEqual(flows, [...CLI_OAUTH_FLOWS].sort());
	assert.doesNotMatch(oauth, /loadAnthropicOAuth|loadOpenAIChatGPTOAuth|loadOpenRouterOAuth|loadXaiOAuth/);
});

test("the Node CLI does not register the bundled llama.cpp provider", () => {
	const output = pruneCliProviderModules(root, inputs());
	const extensions = output.get(resolve(root, "packages/coding-agent/dist/extensions/index.js"));
	assert.doesNotMatch(extensions, /llama/);
	for (const name of ["codemode", "mcp", "tool-search"]) assert.ok(extensions.includes(`"${name}"`));
});

test("OpenRouter personalization does not retain its provider factory or model catalog", () => {
	const output = pruneCliProviderModules(root, inputs());
	const openrouter = output.get(resolve(root, "packages/ai/dist/providers/openrouter.js"));
	assert.match(openrouter, /function personalizeOpenRouterCatalog/);
	assert.doesNotMatch(openrouter, /openrouterProvider|openrouter\.models|loadOpenRouterOAuth|lazyOAuth|openrouterImagesApi/);
});

test("provider-profile drift fails the build rather than silently shipping missing providers", () => {
	const files = inputs();
	const path = resolve(root, "packages/ai/dist/providers/all.js");
	files.set(path, files.get(path).replace("openaiCodexProvider(),", ""));
	assert.throws(() => pruneCliProviderModules(root, files), /CLI provider factories are missing/);
});

test("missing catalog entries fail the build", () => {
	const files = inputs();
	const path = resolve(root, "packages/ai/dist/models.generated.js");
	files.set(path, files.get(path).replace(/"openai-codex": OPENAI_CODEX_MODELS,/, ""));
	assert.throws(() => pruneCliProviderModules(root, files), /CLI providers missing from MODELS/);
});
