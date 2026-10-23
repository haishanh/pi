import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
	isArrayLiteralExpression,
	isCallExpression,
	isExportDeclaration,
	isFunctionDeclaration,
	isIdentifier,
	isImportDeclaration,
	isObjectLiteralExpression,
	isReturnStatement,
	isVariableStatement,
} from "typescript/unstable/ast/is";
import { API } from "typescript/unstable/sync";

export const CLI_PROVIDERS = ["github-copilot", "openai-codex"];
export const CLI_APIS = ["anthropic-messages", "openai-completions", "openai-responses", "openai-codex-responses"];
export const CLI_OAUTH_FLOWS = ["github-copilot", "openai-codex", "radius"];
const providerFactories = new Set(["githubCopilotProvider", "openaiCodexProvider"]);
const oauthLoaders = new Set(["loadGitHubCopilotOAuth", "loadOpenAICodexOAuth", "loadRadiusOAuth"]);
const moduleNames = [
	"packages/ai/dist/providers/all.js",
	"packages/ai/dist/providers/openrouter.js",
	"packages/ai/dist/models.generated.js",
	"packages/ai/dist/compat.js",
	"packages/ai/dist/legacy-api-aliases.js",
	"packages/ai/dist/auth/oauth/load.js",
	"packages/coding-agent/dist/extensions/index.js",
];

// Specialize only the Node CLI bundle. The installed pi-ai library, SDK and Bun
// entrypoints continue to use the complete provider catalog and API registry.
export function pruneCliProviderModules(root, files) {
	const configPath = join(root, "__pi_cli_bundle_profile__.json");
	const config = JSON.stringify({
		compilerOptions: { allowJs: true, noResolve: true, noLib: true, types: [] },
		files: [...files.keys()],
	});
	const api = new API({
		cwd: root,
		fs: {
			fileExists: (path) => (resolve(root, path) === configPath || files.has(resolve(root, path)) ? true : undefined),
			readFile: (path) => (resolve(root, path) === configPath ? config : files.get(resolve(root, path))),
		},
	});
	try {
		const project = api.updateSnapshot({ openProjects: [configPath] }).getProject(configPath);
		if (!project) throw new Error("Could not open CLI bundle profile project");
		const result = new Map();
		for (const [path, text] of files) {
			const source = project.program.getSourceFile(path);
			if (!source) throw new Error(`Could not parse CLI bundle input: ${path}`);
			const edits = [];
			const disabledBindings = new Set();
			let specialized = 0;
			const replace = (node, replacement) =>
				edits.push({ start: node.getStart(source), end: node.end, replacement });
			for (const statement of source.statements) {
				if (isImportDeclaration(statement) || isExportDeclaration(statement)) {
					const specifier = statement.moduleSpecifier?.text?.replace(/\.ts$/, ".js");
					const providerModule = specifier && /^\.\/([^/]+)\.js$/.exec(specifier)?.[1];
					const apiModule = specifier && /^\.\/api\/(.+)\.lazy\.js$/.exec(specifier)?.[1];
					const catalogModule = specifier && /^\.\/providers\/(.+)\.models\.js$/.exec(specifier)?.[1];
					const disabled =
						(basename(path) === "all.js" &&
							providerModule &&
							!CLI_PROVIDERS.includes(providerModule) &&
							// Explicitly configured Radius gateways remain custom providers.
							providerModule !== "radius") ||
						(apiModule && !CLI_APIS.includes(apiModule)) ||
						(catalogModule && !CLI_PROVIDERS.includes(catalogModule)) ||
						(specifier === "./llama/index.js") ||
						(basename(path) === "openrouter.js" &&
							!["../utils/model-operations.js", "./openrouter-api.js"].includes(specifier));
					if (disabled) {
						if (isImportDeclaration(statement)) {
							for (const element of statement.importClause?.namedBindings?.elements ?? []) {
								disabledBindings.add(element.name.text);
							}
						}
						replace(statement, "");
					}
				}
				// ModelRuntime imports OpenRouter's catalog-personalization helper
				// independently of its provider factory.
				if (
					basename(path) === "openrouter.js" &&
					isFunctionDeclaration(statement) &&
					statement.name?.text === "openrouterProvider"
				) {
					replace(statement, "");
					specialized++;
				}
				if (isFunctionDeclaration(statement) && statement.name?.text === "builtinProviders") {
					const returned = statement.body?.statements.find(isReturnStatement)?.expression;
					if (!returned || !isArrayLiteralExpression(returned)) {
						throw new Error("Unexpected builtinProviders() shape");
					}
					const retained = returned.elements.filter(
						(element) => isCallExpression(element) && providerFactories.has(element.expression.getText(source)),
					);
					if (retained.length !== providerFactories.size) throw new Error("CLI provider factories are missing");
					replace(returned, `[${retained.map((element) => element.getText(source)).join(",")}]`);
					specialized++;
				}
				if (!isVariableStatement(statement)) continue;
				for (const declaration of statement.declarationList.declarations) {
					const name = declaration.name.getText(source);
					const initializer = declaration.initializer;
					if (
						basename(path) === "models.generated.js" &&
						["MODELS", "IMAGE_MODELS", "CLASSIFIER_MODELS"].includes(name)
					) {
						if (!initializer || !isObjectLiteralExpression(initializer)) {
							throw new Error(`Unexpected ${name} catalog shape`);
						}
						const retained = initializer.properties.filter((property) => CLI_PROVIDERS.includes(property.name?.text));
						if (retained.length !== CLI_PROVIDERS.length) throw new Error(`CLI providers missing from ${name}`);
						replace(initializer, `{${retained.map((property) => property.getText(source)).join(",")}}`);
						specialized++;
					} else if (name === "BUILTIN_APIS") {
						if (!initializer || !isArrayLiteralExpression(initializer)) {
							throw new Error("Unexpected BUILTIN_APIS shape");
						}
						const retained = initializer.elements.filter(
							(element) => isArrayLiteralExpression(element) && CLI_APIS.includes(element.elements[0]?.text),
						);
						if (retained.length !== CLI_APIS.length) throw new Error("CLI API implementations are missing");
						replace(initializer, `[${retained.map((element) => element.getText(source)).join(",")}]`);
						specialized++;
					} else if (name === "builtInExtensions") {
						if (!initializer || !isArrayLiteralExpression(initializer)) {
							throw new Error("Unexpected builtInExtensions shape");
						}
						const retained = initializer.elements.filter(
							(element) =>
								!isObjectLiteralExpression(element) ||
								!element.properties.some(
									(property) => property.name?.text === "name" && property.initializer?.text === "llama.cpp",
								),
						);
						if (retained.length !== initializer.elements.length - 1) {
							throw new Error("Built-in llama extension missing");
						}
						replace(initializer, `[${retained.map((element) => element.getText(source)).join(",")}]`);
						specialized++;
					} else if (basename(path) === "load.js" && /^load.*OAuth$/.test(name)) {
						if (!oauthLoaders.has(name)) {
							replace(statement, "");
						} else {
							const visit = (node) => {
								if (isCallExpression(node) && node.expression.getText(source) === "importOAuthModule") {
									const flow = node.arguments[0]?.text?.replace(/^\.\//, "").replace(/\.ts$/, "");
									if (!CLI_OAUTH_FLOWS.includes(flow)) throw new Error(`Missing CLI OAuth entry: ${flow}`);
								}
								node.forEachChild(visit);
							};
							visit(initializer);
							specialized++;
						}
					} else if (basename(path) === "legacy-api-aliases.js") {
						let disabled = false;
						const visit = (node) => {
							if (isIdentifier(node) && disabledBindings.has(node.text)) disabled = true;
							node.forEachChild(visit);
						};
						if (initializer) visit(initializer);
						if (disabled) {
							if (statement.declarationList.declarations.length !== 1) {
								throw new Error("Unexpected combined legacy API declarations");
							}
							disabledBindings.add(name);
							replace(statement, "");
						}
					}
				}
			}
			const expected = {
				"all.js": 1,
				"openrouter.js": 1,
				"models.generated.js": 3,
				"compat.js": 1,
				"legacy-api-aliases.js": 0,
				"load.js": oauthLoaders.size,
				"index.js": 1,
			};
			if (specialized !== expected[basename(path)]) throw new Error(`CLI bundle profile did not match ${path}`);
			let contents = text;
			for (const edit of edits.sort((a, b) => b.start - a.start)) {
				contents = contents.slice(0, edit.start) + edit.replacement + contents.slice(edit.end);
			}
			result.set(path, contents);
		}
		return result;
	} finally {
		api.close();
	}
}

export function cliProviderProfilePlugin(root) {
	let modules;
	return {
		name: "cli-provider-profile",
		setup(build) {
			build.onStart(() => {
				const files = new Map(
					moduleNames.map((name) => {
						const path = resolve(root, name);
						return [path, readFileSync(path, "utf8")];
					}),
				);
				modules = pruneCliProviderModules(root, files);
			});
			build.onLoad(
				{ filter: /[/\\](?:all|openrouter|models\.generated|compat|legacy-api-aliases|load|index)\.js$/ },
				({ path }) => {
					const contents = modules.get(path);
					return contents === undefined ? undefined : { contents, loader: "js" };
				},
			);
		},
	};
}
