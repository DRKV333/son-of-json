/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	workspace, window, languages, ExtensionContext, extensions, Uri, 
	Diagnostic, StatusBarAlignment, TextDocument, 
	Range, Disposable, l10n,
	RelativePattern, CodeAction, CodeActionKind, CodeActionContext
} from 'vscode';

import {
	LanguageClientOptions, 
	DidChangeConfigurationNotification} from 'vscode-languageclient';

import { createDocumentSymbolsLimitItem, createLanguageStatusItem, createLimitStatusItem, createSchemaLoadIssueItem, createSchemaLoadStatusItem } from './languageStatus.js';
import { LanguageParticipants } from './languageParticipants.js';
import { matchesUrlPattern } from './utils/urlMatch.js';
import { ErrorCodes, ForceValidateRequest, ISchemaAssociation, LanguageStatusRequest, SchemaAssociationNotification } from './messageTypes.js';
import { ConfigurationManager, SettingIds } from './configuration.js';
import { JsonClientMiddleware } from './middleware.js';
import { AsyncDisposable, LanguageClientConstructor, Runtime } from './runtimeTypes.js';
import { CommandIds, CommandRegistry } from './commands.js';
import { FormatterRegistration } from './formatterRegistration.js';
import { ContentRequestHandler } from './contentRequestHandler.js';

export const languageServerDescription = l10n.t('JSON Language Server');

export async function startClient(context: ExtensionContext, newLanguageClient: LanguageClientConstructor, runtime: Runtime): Promise<AsyncDisposable> {
	const languageParticipants = new LanguageParticipants();
	context.subscriptions.push(languageParticipants);

	let client: Disposable | undefined = await startClientWithParticipants(context, languageParticipants, newLanguageClient, runtime);

	let restartTrigger: Disposable | undefined;
	languageParticipants.onDidChange(() => {
		if (restartTrigger) {
			restartTrigger.dispose();
		}
		restartTrigger = runtime.timer.setTimeout(async () => {
			if (client) {
				runtime.logOutputChannel.info('Extensions have changed, restarting JSON server...');
				runtime.logOutputChannel.info('');
				const oldClient = client;
				client = undefined;
				await oldClient.dispose();
				client = await startClientWithParticipants(context, languageParticipants, newLanguageClient, runtime);
			}
		}, 2000);
	});

	return {
		dispose: async () => {
			restartTrigger?.dispose();
			await client?.dispose();
		}
	};
}

async function startClientWithParticipants(_context: ExtensionContext, languageParticipants: LanguageParticipants, newLanguageClient: LanguageClientConstructor, runtime: Runtime): Promise<AsyncDisposable> {

	const toDispose: Disposable[] = [];

	const configurationManager = new ConfigurationManager();
	toDispose.push(configurationManager);

	let schemaAssociationsCache: Promise<ISchemaAssociation[]> | undefined = undefined;

	const documentSelector = languageParticipants.documentSelector;

	const schemaResolutionErrorStatusBarItem = window.createStatusBarItem('status.jsonson.resolveError', StatusBarAlignment.Right, 0);
	schemaResolutionErrorStatusBarItem.name = l10n.t('JSON: Schema Resolution Error');
	schemaResolutionErrorStatusBarItem.text = '$(alert)';
	toDispose.push(schemaResolutionErrorStatusBarItem);

	const documentSymbolsLimitStatusbarItem = createLimitStatusItem((limit: number) => createDocumentSymbolsLimitItem(documentSelector, SettingIds.maxItemsComputed, limit));
	toDispose.push(documentSymbolsLimitStatusbarItem);

	const schemaLoadStatusItem = createSchemaLoadStatusItem((diagnostic: Diagnostic) => createSchemaLoadIssueItem(documentSelector, configurationManager.getSettings().json.schemaDownloadEnabled, diagnostic));
	toDispose.push(schemaLoadStatusItem);

	const middleware = new JsonClientMiddleware();
	toDispose.push(middleware);

	// Options to control the language client
	const clientOptions: LanguageClientOptions = {
		// Register the server for json documents
		documentSelector,
		initializationOptions: {
			handledSchemaProtocols: ['file'], // language server only loads file-URI. Fetching schemas with other protocols ('http'...) are made on the client.
			provideFormatter: false, // tell the server to not provide formatting capability and ignore the `jsonson.format.enable` setting.
			customCapabilities: { rangeFormatting: { editLimit: 10000 } }
		},
		synchronize: {
			// Synchronize the setting section 'json' to the server
			fileEvents: workspace.createFileSystemWatcher('**/*.json')
		},
		middleware
	};

	toDispose.push(middleware.onDiagnostics(e => {
		schemaLoadStatusItem.update(e.uri, e.diagnostics);
	}));

	toDispose.push(middleware.onDocumentSymbols(e => {
		const resultLimit = configurationManager.getSettings().json.resultLimit
		if (e.symbolCount > resultLimit) {
			documentSymbolsLimitStatusbarItem.update(e.document, resultLimit);
		} else {
			documentSymbolsLimitStatusbarItem.update(e.document, false);
		}
	}));

	clientOptions.outputChannel = runtime.logOutputChannel;
	// Create the language client and start the client.
	const client = newLanguageClient('json', languageServerDescription, clientOptions);
	client.registerProposedFeatures();

	const commandRegistry = new CommandRegistry(client, runtime, () => triggerValidation());
	toDispose.push(commandRegistry);
	commandRegistry.registerAll();

	// handle content request
	toDispose.push(new ContentRequestHandler(client, runtime, configurationManager, isTrusted));

	await client.start();

	commandRegistry.SetClientReady();

	toDispose.push(languages.registerCodeActionsProvider(documentSelector, {
		provideCodeActions(_document: TextDocument, _range: Range, context: CodeActionContext): CodeAction[] {
			const codeActions: CodeAction[] = [];

			for (const diagnostic of context.diagnostics) {
				if (typeof diagnostic.code !== 'number') {
					continue;
				}
				switch (diagnostic.code) {
					case ErrorCodes.UntrustedSchemaError: {
						const title = l10n.t('Configure Trusted Domains...');
						const action = new CodeAction(title, CodeActionKind.QuickFix);
						const schemaUri = diagnostic.relatedInformation?.[0]?.location.uri;
						if (schemaUri) {
							action.command = { command: CommandIds.configureTrustedDomainsCommandId, arguments: [schemaUri.toString()], title };
						} else {
							action.command = { command: CommandIds.workbenchActionOpenSettings, arguments: [SettingIds.trustedDomains], title };
						}
						action.diagnostics = [diagnostic];
						action.isPreferred = true;
						codeActions.push(action);
					}
						break;
					case ErrorCodes.HTTPDisabledError: {
						const title = l10n.t('Enable Schema Downloading...');
						const action = new CodeAction(title, CodeActionKind.QuickFix);
						action.command = { command: CommandIds.workbenchActionOpenSettings, arguments: [SettingIds.enableSchemaDownload], title };
						action.diagnostics = [diagnostic];
						action.isPreferred = true;
						codeActions.push(action);
					}
						break;
				}
			}

			return codeActions;
		}
	}, {
		providedCodeActionKinds: [CodeActionKind.QuickFix]
	}));

	client.sendNotification(SchemaAssociationNotification.type, await getSchemaAssociations(false));

	toDispose.push(extensions.onDidChange(async _ => {
		client.sendNotification(SchemaAssociationNotification.type, await getSchemaAssociations(true));
	}));

	const associationWatcher = workspace.createFileSystemWatcher(new RelativePattern(Uri.parse(`vscode://schemas-associations/`), '**/schemas-associations.json'));
	toDispose.push(associationWatcher);
	toDispose.push(associationWatcher.onDidChange(async _e => {
		client.sendNotification(SchemaAssociationNotification.type, await getSchemaAssociations(true));
	}));

	toDispose.push(new FormatterRegistration(client, configurationManager, documentSelector));

	toDispose.push(configurationManager.onDidChangeDownloadSettings(() => {
		triggerValidation();
	}));

	toDispose.push(configurationManager.onDidChangeAnySettings(() => {
		client.sendNotification(DidChangeConfigurationNotification.type, { settings: configurationManager.getSettingsWithExtraLimits() });
	}));
	client.sendNotification(DidChangeConfigurationNotification.type, { settings: configurationManager.getSettingsWithExtraLimits() });

	toDispose.push(workspace.onDidGrantWorkspaceTrust(() => triggerValidation()));

	toDispose.push(createLanguageStatusItem(documentSelector, (uri: string) => client.sendRequest(LanguageStatusRequest.type, uri)));

	async function triggerValidation() { // TODO: Move this to commands somehow
		const activeTextEditor = window.activeTextEditor;
		if (activeTextEditor && languageParticipants.hasLanguage(activeTextEditor.document.languageId)) {
			schemaResolutionErrorStatusBarItem.text = '$(watch)';
			schemaResolutionErrorStatusBarItem.tooltip = l10n.t('Validating...');
			const activeDocUri = activeTextEditor.document.uri.toString();
			await client.sendRequest(ForceValidateRequest.type, activeDocUri);
		}
	}

	async function getSchemaAssociations(forceRefresh: boolean): Promise<ISchemaAssociation[]> {
		if (!schemaAssociationsCache || forceRefresh) {
			schemaAssociationsCache = computeSchemaAssociations();
		}
		return schemaAssociationsCache;
	}

	async function isTrusted(uri: Uri): Promise<boolean> {
		if (uri.scheme !== 'http' && uri.scheme !== 'https') {
			return true;
		}
		const uriString = uri.toString(true);

		// Check against trustedDomains setting
		if (matchesUrlPattern(uri, configurationManager.getSettings().json.trustedDomains)) {
			return true;
		}

		const knownAssociations = await getSchemaAssociations(false);
		for (const association of knownAssociations) {
			if (association.uri === uriString) {
				return true;
			}
		}
		const settings = configurationManager.getSettings();
		for (const schemaSetting of settings.json.schemas) {
			if (schemaSetting.retrievalUri === uriString) {
				return true;
			}
		}

		return false;
	}


	return {
		dispose: async () => {
			await client.stop();
			toDispose.forEach(d => d.dispose());
		}
	};
}

async function computeSchemaAssociations(): Promise<ISchemaAssociation[]> {
	const extensionAssociations = getSchemaExtensionAssociations();
	return extensionAssociations.concat(await getDynamicSchemaAssociations());
}

function getSchemaExtensionAssociations(): ISchemaAssociation[] {
	const associations: ISchemaAssociation[] = [];
	extensions.all.forEach(extension => {
		const packageJSON = extension.packageJSON;
		if (packageJSON && packageJSON.contributes && packageJSON.contributes.jsonValidation) {
			const jsonValidation = packageJSON.contributes.jsonValidation;
			if (Array.isArray(jsonValidation)) {
				jsonValidation.forEach(jv => {
					let { fileMatch, url } = jv;
					if (typeof fileMatch === 'string') {
						fileMatch = [fileMatch];
					}
					if (Array.isArray(fileMatch) && typeof url === 'string') {
						let uri: string = url;
						if (uri[0] === '.' && uri[1] === '/') {
							uri = Uri.joinPath(extension.extensionUri, uri).toString();
						}
						fileMatch = fileMatch.map(fm => {
							if (fm[0] === '%') {
								fm = fm.replace(/%APP_SETTINGS_HOME%/, '/User');
								fm = fm.replace(/%MACHINE_SETTINGS_HOME%/, '/Machine');
								fm = fm.replace(/%APP_WORKSPACES_HOME%/, '/Workspaces');
							} else if (!fm.match(/^(\w+:\/\/|\/|!)/)) {
								fm = '/' + fm;
							}
							return fm;
						});
						associations.push({ fileMatch, uri });
					}
				});
			}
		}
	});
	return associations;
}

async function getDynamicSchemaAssociations(): Promise<ISchemaAssociation[]> {
	const result: ISchemaAssociation[] = [];
	try {
		const data = await workspace.fs.readFile(Uri.parse(`vscode://schemas-associations/schemas-associations.json`));
		const rawStr = new TextDecoder().decode(data);
		const obj = <Record<string, string[]>>JSON.parse(rawStr);
		for (const item of Object.keys(obj)) {
			result.push({
				fileMatch: obj[item],
				uri: item
			});
		}
	} catch {
		// ignore
	}
	return result;
}
