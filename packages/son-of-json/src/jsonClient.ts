/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	workspace, window, languages, ExtensionContext, 
	Diagnostic, StatusBarAlignment, TextDocument, 
	Range, Disposable, l10n,
	CodeAction, CodeActionKind, CodeActionContext
} from 'vscode';

import {
	LanguageClientOptions, 
	DidChangeConfigurationNotification} from 'vscode-languageclient';

import { createDocumentSymbolsLimitItem, createLanguageStatusItem, createLimitStatusItem, createSchemaLoadIssueItem, createSchemaLoadStatusItem } from './languageStatus.js';
import { LanguageParticipants } from './languageParticipants.js';
import { ErrorCodes, ForceValidateRequest, LanguageStatusRequest, SchemaAssociationNotification } from './messageTypes.js';
import { ConfigurationManager, SettingIds } from './configuration.js';
import { JsonClientMiddleware } from './middleware.js';
import { AsyncDisposable, LanguageClientConstructor, Runtime } from './runtimeTypes.js';
import { CommandIds, CommandRegistry } from './commands.js';
import { FormatterRegistration } from './formatterRegistration.js';
import { ContentRequestHandler } from './contentRequestHandler.js';
import { SchemaAssociationManager } from './schemaAssociations.js';

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

	const schemaAssociationManager = new SchemaAssociationManager();
	toDispose.push(schemaAssociationManager);

	// handle content request
	toDispose.push(new ContentRequestHandler(client, runtime, configurationManager, schemaAssociationManager));

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

	client.sendNotification(SchemaAssociationNotification.type, await schemaAssociationManager.getSchemaAssociations());
	toDispose.push(schemaAssociationManager.onDidChangeAssociations(async () => {
		client.sendNotification(SchemaAssociationNotification.type, await schemaAssociationManager.getSchemaAssociations());
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

	return {
		dispose: async () => {
			await client.stop();
			toDispose.forEach(d => d.dispose());
		}
	};
}
