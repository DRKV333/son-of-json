/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	workspace, window, languages, commands, LogOutputChannel, ExtensionContext, extensions, Uri, 
	Diagnostic, StatusBarAlignment, TextDocument, FormattingOptions, CancellationToken, 
	ProviderResult, TextEdit, Range, Disposable, l10n,
	RelativePattern, CodeAction, CodeActionKind, CodeActionContext
} from 'vscode';
import {
	LanguageClientOptions, 
	Diagnostic as LSPDiagnostic,
	DidChangeConfigurationNotification, ResponseError, DocumentRangeFormattingParams,
	DocumentRangeFormattingRequest, BaseLanguageClient} from 'vscode-languageclient';

import { createDocumentSymbolsLimitItem, createLanguageStatusItem, createLimitStatusItem, createSchemaLoadIssueItem, createSchemaLoadStatusItem } from './languageStatus.js';
import { LanguageParticipants } from './languageParticipants.js';
import { matchesUrlPattern } from './utils/urlMatch.js';
import { DocumentSortingParams, DocumentSortingRequest, ErrorCodes, ForceValidateRequest, ISchemaAssociation, LanguageStatusRequest, SchemaAssociationNotification, SchemaContentChangeNotification, SchemaRequestServiceErrors, SortOptions, ValidateContentRequest, VSCodeContentRequest } from './messageTypes.js';
import { ConfigurationManager, SettingIds } from './configuration.js';
import { JsonClientMiddleware } from './middleware.js';

export namespace CommandIds {
	export const workbenchActionOpenSettings = 'workbench.action.openSettings';
	export const workbenchTrustManage = 'workbench.trust.manage';
	export const retryResolveSchemaCommandId = '_jsonson.retryResolveSchema';
	export const configureTrustedDomainsCommandId = '_jsonson.configureTrustedDomains';
	export const showAssociatedSchemaList = '_jsonson.showAssociatedSchemaList';
	export const clearCacheCommandId = 'jsonson.clearCache';
	export const validateCommandId = 'jsonson.validate';
	export const sortCommandId = 'jsonson.sort';
}

export type LanguageClientConstructor = (name: string, description: string, clientOptions: LanguageClientOptions) => BaseLanguageClient;

export interface Runtime {
	schemaRequests: SchemaRequestService;
	readonly timer: {
		setTimeout(callback: (...args: any[]) => void, ms: number, ...args: any[]): Disposable;
	};
	logOutputChannel: LogOutputChannel;
}

export interface SchemaRequestService {
	getContent(uri: string): Promise<string>;
	clearCache?(): Promise<string[]>;
}

export const languageServerDescription = l10n.t('JSON Language Server');

export interface AsyncDisposable {
	dispose(): Promise<void>;
}

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

	let rangeFormatting: Disposable | undefined = undefined;
	let schemaAssociationsCache: Promise<ISchemaAssociation[]> | undefined = undefined;

	const documentSelector = languageParticipants.documentSelector;

	const schemaResolutionErrorStatusBarItem = window.createStatusBarItem('status.jsonson.resolveError', StatusBarAlignment.Right, 0);
	schemaResolutionErrorStatusBarItem.name = l10n.t('JSON: Schema Resolution Error');
	schemaResolutionErrorStatusBarItem.text = '$(alert)';
	toDispose.push(schemaResolutionErrorStatusBarItem);

	const fileSchemaErrors = new Map<string, string>();
	let schemaDownloadEnabled = !!workspace.getConfiguration().get(SettingIds.enableSchemaDownload);
	let trustedDomains = workspace.getConfiguration().get<Record<string, boolean>>(SettingIds.trustedDomains, {});

	let isClientReady = false;

	const documentSymbolsLimitStatusbarItem = createLimitStatusItem((limit: number) => createDocumentSymbolsLimitItem(documentSelector, SettingIds.maxItemsComputed, limit));
	toDispose.push(documentSymbolsLimitStatusbarItem);

	const schemaLoadStatusItem = createSchemaLoadStatusItem((diagnostic: Diagnostic) => createSchemaLoadIssueItem(documentSelector, schemaDownloadEnabled, diagnostic));
	toDispose.push(schemaLoadStatusItem);

	toDispose.push(commands.registerCommand(CommandIds.clearCacheCommandId, async () => {
		if (isClientReady && runtime.schemaRequests.clearCache) {
			const cachedSchemas = await runtime.schemaRequests.clearCache();
			await client.sendNotification(SchemaContentChangeNotification.type, cachedSchemas);
		}
		window.showInformationMessage(l10n.t('JSON schema cache cleared.'));
	}));

	toDispose.push(commands.registerCommand(CommandIds.validateCommandId, async (schemaUri: Uri, content: string) => {
		const diagnostics: LSPDiagnostic[] = await client.sendRequest(ValidateContentRequest.type, { schemaUri: schemaUri.toString(), content });
		return diagnostics.map(client.protocol2CodeConverter.asDiagnostic);
	}));

	toDispose.push(commands.registerCommand(CommandIds.sortCommandId, async () => {

		if (isClientReady) {
			const textEditor = window.activeTextEditor;
			if (textEditor) {
				const documentOptions = textEditor.options;
				const textEdits = await getSortTextEdits(textEditor.document, documentOptions.tabSize, documentOptions.insertSpaces);
				const success = await textEditor.edit(mutator => {
					for (const edit of textEdits) {
						mutator.replace(client.protocol2CodeConverter.asRange(edit.range), edit.newText);
					}
				});
				if (!success) {
					window.showErrorMessage(l10n.t('Failed to sort the JSONC document, please consider opening an issue.'));
				}
			}
		}
	}));

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
		middleware: new JsonClientMiddleware(configurationManager, schemaLoadStatusItem, documentSymbolsLimitStatusbarItem)
	};

	clientOptions.outputChannel = runtime.logOutputChannel;
	// Create the language client and start the client.
	const client = newLanguageClient('json', languageServerDescription, clientOptions);
	client.registerProposedFeatures();

	const schemaDocuments: { [uri: string]: boolean } = {};

	// handle content request
	client.onRequest(VSCodeContentRequest.type, async (uriPath: string) => {
		const uri = Uri.parse(uriPath);
		const uriString = uri.toString(true);
		if (uri.scheme === 'untitled') {
			throw new ResponseError(SchemaRequestServiceErrors.UntitledAccessError, l10n.t('Unable to load {0}', uriString));
		}
		if (uri.scheme === 'vscode') {
			try {
				runtime.logOutputChannel.info('read schema from vscode: ' + uriString);
				ensureFilesystemWatcherInstalled(uri);
				const content = await workspace.fs.readFile(uri);
				return new TextDecoder().decode(content);
			} catch (e) {
				throw new ResponseError(SchemaRequestServiceErrors.VSCodeAccessError, e.toString(), e);
			}
		} else if (uri.scheme !== 'http' && uri.scheme !== 'https') {
			try {
				const document = await workspace.openTextDocument(uri);
				schemaDocuments[uriString] = true;
				return document.getText();
			} catch (e) {
				throw new ResponseError(SchemaRequestServiceErrors.OpenTextDocumentAccessError, e.toString(), e);
			}
		} else if (schemaDownloadEnabled) {
			if (!workspace.isTrusted) {
				throw new ResponseError(SchemaRequestServiceErrors.UntrustedWorkspaceError, l10n.t('Downloading schemas is disabled in untrusted workspaces'));
			}
			if (!await isTrusted(uri)) {
				throw new ResponseError(SchemaRequestServiceErrors.UntrustedSchemaError, l10n.t('Location {0} is untrusted', uriString));
			}
			try {
				return await runtime.schemaRequests.getContent(uriString);
			} catch (e) {
				throw new ResponseError(SchemaRequestServiceErrors.HTTPError, e.toString(), e);
			}
		} else {
			throw new ResponseError(SchemaRequestServiceErrors.HTTPDisabledError, l10n.t('Downloading schemas is disabled through setting \'{0}\'', SettingIds.enableSchemaDownload));
		}
	});

	await client.start();

	isClientReady = true;

	const handleContentChange = (uriString: string) => {
		if (schemaDocuments[uriString]) {
			client.sendNotification(SchemaContentChangeNotification.type, uriString);
			return true;
		}
		return false;
	};
	const handleContentClosed = (uriString: string) => {
		if (handleContentChange(uriString)) {
			delete schemaDocuments[uriString];
		}
		fileSchemaErrors.delete(uriString);
	};

	const watchers: Map<string, Disposable> = new Map();
	toDispose.push(new Disposable(() => {
		for (const d of watchers.values()) {
			d.dispose();
		}
	}));


	const ensureFilesystemWatcherInstalled = (uri: Uri) => {

		const uriString = uri.toString();
		if (!watchers.has(uriString)) {
			try {
				const watcher = workspace.createFileSystemWatcher(new RelativePattern(uri, '*'));
				const handleChange = (uri: Uri) => {
					runtime.logOutputChannel.info('schema change detected ' + uri.toString());
					client.sendNotification(SchemaContentChangeNotification.type, uriString);
				};
				const createListener = watcher.onDidCreate(handleChange);
				const changeListener = watcher.onDidChange(handleChange);
				const deleteListener = watcher.onDidDelete(() => {
					const watcher = watchers.get(uriString);
					if (watcher) {
						watcher.dispose();
						watchers.delete(uriString);
					}
				});
				watchers.set(uriString, Disposable.from(watcher, createListener, changeListener, deleteListener));
			} catch {
				runtime.logOutputChannel.info('Problem installing a file system watcher for ' + uriString);
			}
		}
	};

	toDispose.push(workspace.onDidChangeTextDocument(e => handleContentChange(e.document.uri.toString())));
	toDispose.push(workspace.onDidCloseTextDocument(d => handleContentClosed(d.uri.toString())));

	toDispose.push(commands.registerCommand(CommandIds.retryResolveSchemaCommandId, triggerValidation));

	toDispose.push(commands.registerCommand(CommandIds.configureTrustedDomainsCommandId, configureTrustedDomains));

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

	// manually register / deregister format provider based on the `json.format.enable` setting avoiding issues with late registration. See #71652.
	updateFormatterRegistration();
	toDispose.push({ dispose: () => rangeFormatting && rangeFormatting.dispose() });

	toDispose.push(workspace.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration(SettingIds.enableFormatter)) {
			updateFormatterRegistration();
		} else if (e.affectsConfiguration(SettingIds.enableSchemaDownload)) {
			schemaDownloadEnabled = !!workspace.getConfiguration().get(SettingIds.enableSchemaDownload);
			triggerValidation();
		} else if (e.affectsConfiguration(SettingIds.editorFoldingMaximumRegions) || e.affectsConfiguration(SettingIds.editorColorDecoratorsLimit) || e.affectsConfiguration("http") || e.affectsConfiguration("jsonson")) {
			client.sendNotification(DidChangeConfigurationNotification.type, { settings: configurationManager.getSettingsWithExtraLimits(true) });
		} else if (e.affectsConfiguration(SettingIds.trustedDomains)) {
			trustedDomains = workspace.getConfiguration().get<Record<string, boolean>>(SettingIds.trustedDomains, {});
			triggerValidation();
		}
	}));
	client.sendNotification(DidChangeConfigurationNotification.type, { settings: configurationManager.getSettingsWithExtraLimits(true) });

	toDispose.push(workspace.onDidGrantWorkspaceTrust(() => triggerValidation()));

	toDispose.push(createLanguageStatusItem(documentSelector, (uri: string) => client.sendRequest(LanguageStatusRequest.type, uri)));

	function updateFormatterRegistration() {
		const formatEnabled = workspace.getConfiguration().get(SettingIds.enableFormatter);
		if (!formatEnabled && rangeFormatting) {
			rangeFormatting.dispose();
			rangeFormatting = undefined;
		} else if (formatEnabled && !rangeFormatting) {
			rangeFormatting = languages.registerDocumentRangeFormattingEditProvider(documentSelector, {
				provideDocumentRangeFormattingEdits(document: TextDocument, range: Range, options: FormattingOptions, token: CancellationToken): ProviderResult<TextEdit[]> {
					const filesConfig = workspace.getConfiguration('files', document);
					const fileFormattingOptions = {
						trimTrailingWhitespace: filesConfig.get<boolean>('trimTrailingWhitespace'),
						trimFinalNewlines: filesConfig.get<boolean>('trimFinalNewlines'),
						insertFinalNewline: filesConfig.get<boolean>('insertFinalNewline'),
					};
					const params: DocumentRangeFormattingParams = {
						textDocument: client.code2ProtocolConverter.asTextDocumentIdentifier(document),
						range: client.code2ProtocolConverter.asRange(range),
						options: client.code2ProtocolConverter.asFormattingOptions(options, fileFormattingOptions)
					};

					return client.sendRequest(DocumentRangeFormattingRequest.type, params, token).then(
						client.protocol2CodeConverter.asTextEdits,
						(error) => {
							client.handleFailedRequest(DocumentRangeFormattingRequest.type, undefined, error, []);
							return Promise.resolve([]);
						}
					);
				}
			});
		}
	}

	async function triggerValidation() {
		const activeTextEditor = window.activeTextEditor;
		if (activeTextEditor && languageParticipants.hasLanguage(activeTextEditor.document.languageId)) {
			schemaResolutionErrorStatusBarItem.text = '$(watch)';
			schemaResolutionErrorStatusBarItem.tooltip = l10n.t('Validating...');
			const activeDocUri = activeTextEditor.document.uri.toString();
			await client.sendRequest(ForceValidateRequest.type, activeDocUri);
		}
	}

	async function getSortTextEdits(document: TextDocument, tabSize: string | number = 4, insertSpaces: string | boolean = true): Promise<TextEdit[]> {
		const filesConfig = workspace.getConfiguration('files', document);
		const options: SortOptions = {
			tabSize: Number(tabSize),
			insertSpaces: Boolean(insertSpaces),
			trimTrailingWhitespace: filesConfig.get<boolean>('trimTrailingWhitespace'),
			trimFinalNewlines: filesConfig.get<boolean>('trimFinalNewlines'),
			insertFinalNewline: filesConfig.get<boolean>('insertFinalNewline'),
		};
		const params: DocumentSortingParams = {
			uri: document.uri.toString(),
			options
		};
		const edits = await client.sendRequest(DocumentSortingRequest.type, params);
		// Here we convert the JSON objects to real TextEdit objects
		return edits.map((edit) => {
			return new TextEdit(
				new Range(edit.range.start.line, edit.range.start.character, edit.range.end.line, edit.range.end.character),
				edit.newText
			);
		});
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
		if (matchesUrlPattern(uri, trustedDomains)) {
			return true;
		}

		const knownAssociations = await getSchemaAssociations(false);
		for (const association of knownAssociations) {
			if (association.uri === uriString) {
				return true;
			}
		}
		const settings = configurationManager.getSettings(false);
		for (const schemaSetting of settings.json.schemas) {
			if (schemaSetting.retrievalUri === uriString) {
				return true;
			}
		}

		return false;
	}

	async function configureTrustedDomains(schemaUri: string): Promise<void> {
		interface QuickPickItemWithAction {
			label: string;
			description?: string;
			execute: () => Promise<void>;
		}

		const normalizeTrustedDomains = (domains: Record<string, boolean>): Record<string, boolean> => {
			return Object.fromEntries(Object.entries(domains).sort(([a], [b]) => a.localeCompare(b)));
		};

		const updateTrustedDomains = async (updateDomain: string): Promise<void> => {
			const config = workspace.getConfiguration();
			const currentDomains = config.get<Record<string, boolean>>(SettingIds.trustedDomains, {});
			if (currentDomains[updateDomain] === true) {
				return;
			}
			const nextDomains = normalizeTrustedDomains({
				...currentDomains,
				[updateDomain]: true
			});
			await config.update(SettingIds.trustedDomains, nextDomains, true);
		};

		const items: QuickPickItemWithAction[] = [];

		try {
			const uri = Uri.parse(schemaUri);
			const domain = `${uri.scheme}://${uri.authority}`;

			// Add "Trust domain" option
			items.push({
				label: l10n.t('Trust Domain: {0}', domain),
				description: l10n.t('Allow all schemas from this domain'),
				execute: async () => {
					await updateTrustedDomains(domain);
					await commands.executeCommand(CommandIds.workbenchActionOpenSettings, SettingIds.trustedDomains);
				}
			});

			// Add "Trust URI" option
			items.push({
				label: l10n.t('Trust URI: {0}', schemaUri),
				description: l10n.t('Allow only this specific schema'),
				execute: async () => {
					await updateTrustedDomains(schemaUri);
					await commands.executeCommand(CommandIds.workbenchActionOpenSettings, SettingIds.trustedDomains);
				}
			});
		} catch (e) {
			runtime.logOutputChannel.error(`Failed to parse schema URI: ${schemaUri}`);
		}


		// Always add "Configure setting" option
		items.push({
			label: l10n.t('Configure Setting'),
			description: l10n.t('Open settings editor'),
			execute: async () => {
				await commands.executeCommand(CommandIds.workbenchActionOpenSettings, SettingIds.trustedDomains);
			}
		});

		const selected = await window.showQuickPick(items, {
			placeHolder: l10n.t('Select how to configure trusted schema domains')
		});

		if (selected) {
			await selected.execute();
		}
	}


	return {
		dispose: async () => {
			await client.stop();
			toDispose.forEach(d => d.dispose());
			rangeFormatting?.dispose();
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
