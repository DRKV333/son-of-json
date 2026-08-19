/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Uri, workspace, Disposable, ConfigurationChangeEvent, Event, EventEmitter } from "vscode";
import { hash } from "./utils/hash.js";

export namespace SettingIds {
	export const jsonsonSection = 'jsonson';
	export const jsonsonSectionSchemasKey = 'schemas';

	export const httpSection = 'http';
	export const httpSectionProxyKey = 'proxy';
	export const httpSectionProxyStrictSSLKey = 'proxyStrictSSL';

	export const enableFormatter = `${jsonsonSection}.format.enable`;
	export const enableKeepLines = `${jsonsonSection}.format.keepLines`;
	export const enableValidation = `${jsonsonSection}.validate.enable`;
	export const enableSchemaDownload = `${jsonsonSection}.schemaDownload.enable`;
	export const trustedDomains = `${jsonsonSection}.schemaDownload.trustedDomains`;
	export const maxItemsComputed = `${jsonsonSection}.maxItemsComputed`;
	
	export const editorSection = 'editor';
	export const editorSectionFoldingMaximumRegionsKey = 'foldingMaximumRegions';
	export const editorSectionColorDecoratorsLimitKey = 'colorDecoratorsLimit';

	export const editorFoldingMaximumRegions = `${editorSection}.${editorSectionFoldingMaximumRegionsKey}`;
	export const editorColorDecoratorsLimit = `${editorSection}.${editorSectionColorDecoratorsLimitKey}`;
}

export interface JSONSchemaSettings {
	uri?: string;
	schemaFile?: string;
	retrievalUri?: string;
	fileMatch?: string[];
	schema?: any;
	folderUri?: string;
};

export interface Settings {
	json: {
		schemas: JSONSchemaSettings[];
		format: { enable?: boolean };
		keepLines: { enable?: boolean };
		validate: { enable?: boolean };
		resultLimit: number;
		jsonFoldingLimit: number;
		jsoncFoldingLimit: number;
		jsonColorDecoratorLimit: number;
		jsoncColorDecoratorLimit: number;
		schemaDownloadEnabled: boolean;
		trustedDomains: Record<string, boolean>;
	};
	http: {
		proxy?: string;
		proxyStrictSSL?: boolean;
	};
};

export class ConfigurationManager implements Disposable {
	private settingsCache: Settings | undefined = undefined;
	private settingsCacheWithExtraLimits: Settings | undefined = undefined;
	private readonly didChangeSubscription: Disposable;

	private didChangeFormatterSettingsEmitter: EventEmitter<ConfigurationChangeEvent> = new EventEmitter<ConfigurationChangeEvent>();
	public onDidChangeFormatterSettings: Event<ConfigurationChangeEvent> = this.didChangeFormatterSettingsEmitter.event;

	private didChangeDownloadSettingsEmitter: EventEmitter<ConfigurationChangeEvent> = new EventEmitter<ConfigurationChangeEvent>();
	public onDidChangeDownloadSettings: Event<ConfigurationChangeEvent> = this.didChangeDownloadSettingsEmitter.event;

	private didChangeAnySettingsEmitter: EventEmitter<ConfigurationChangeEvent> = new EventEmitter<ConfigurationChangeEvent>();
	public onDidChangeAnySettings: Event<ConfigurationChangeEvent> = this.didChangeAnySettingsEmitter.event;

	constructor() {
		this.didChangeSubscription = workspace.onDidChangeConfiguration(e => {
			if (
				e.affectsConfiguration(SettingIds.editorFoldingMaximumRegions) ||
				e.affectsConfiguration(SettingIds.editorColorDecoratorsLimit) ||
				e.affectsConfiguration(SettingIds.httpSection) ||
				e.affectsConfiguration(SettingIds.jsonsonSection)
			) {
				this.settingsCache = undefined;
				this.settingsCacheWithExtraLimits = undefined;
				this.didChangeAnySettingsEmitter.fire(e);
			}

			if (e.affectsConfiguration(SettingIds.enableFormatter)) {
				this.didChangeFormatterSettingsEmitter.fire(e);
			}

			if (e.affectsConfiguration(SettingIds.enableSchemaDownload) || e.affectsConfiguration(SettingIds.trustedDomains)) {
				this.didChangeDownloadSettingsEmitter.fire(e);
			}
		});
	}

	public dispose() {
		this.didChangeSubscription.dispose();
	}

	public getSettingsWithExtraLimits(): Settings {
		if (!this.settingsCacheWithExtraLimits) {
			const settings = this.getSettings();

			// ask for one more so we can detect if the limit has been exceeded

			this.settingsCacheWithExtraLimits = {
				http: settings.http,
				json: {
					validate: settings.json.validate,
					format: settings.json.format,
					keepLines: settings.json.keepLines,
					schemas: settings.json.schemas,
					resultLimit: settings.json.resultLimit + 1, 
					jsonFoldingLimit: settings.json.jsonFoldingLimit + 1,
					jsoncFoldingLimit: settings.json.jsoncFoldingLimit + 1,
					jsonColorDecoratorLimit: settings.json.jsonColorDecoratorLimit + 1,
					jsoncColorDecoratorLimit: settings.json.jsoncColorDecoratorLimit + 1,
					schemaDownloadEnabled: settings.json.schemaDownloadEnabled,
					trustedDomains: settings.json.trustedDomains
				}
			}
		}

		return this.settingsCacheWithExtraLimits;
	}

	public getSettings(): Settings {
		if (!this.settingsCache) {
			this.settingsCache = this.computeSettings();
		}
		return this.settingsCache;
	}

	private computeSettings(): Settings {
		const configuration = workspace.getConfiguration();
		const httpSettings = workspace.getConfiguration(SettingIds.httpSection);

		const normalizeLimit = (settingValue: any) => Math.trunc(Math.max(0, Number(settingValue))) || 5000;

		const resultLimit = normalizeLimit(workspace.getConfiguration().get(SettingIds.maxItemsComputed));
		const editorJSONSettings = workspace.getConfiguration(SettingIds.editorSection, { languageId: 'json' });
		const editorJSONCSettings = workspace.getConfiguration(SettingIds.editorSection, { languageId: 'jsonc' });

		const jsonFoldingLimit = normalizeLimit(editorJSONSettings.get(SettingIds.editorSectionFoldingMaximumRegionsKey));
		const jsoncFoldingLimit = normalizeLimit(editorJSONCSettings.get(SettingIds.editorSectionFoldingMaximumRegionsKey));
		const jsonColorDecoratorLimit = normalizeLimit(editorJSONSettings.get(SettingIds.editorSectionColorDecoratorsLimitKey));
		const jsoncColorDecoratorLimit = normalizeLimit(editorJSONCSettings.get(SettingIds.editorSectionColorDecoratorsLimitKey));

		const schemaDownloadEnabled = !!configuration.get(SettingIds.enableSchemaDownload);

		const trustedDomains = configuration.get<Record<string, boolean>>(SettingIds.trustedDomains, {});

		const settings: Settings = {
			http: {
				proxy: httpSettings.get(SettingIds.httpSectionProxyKey),
				proxyStrictSSL: httpSettings.get(SettingIds.httpSectionProxyStrictSSLKey)
			},
			json: {
				validate: { enable: configuration.get(SettingIds.enableValidation) },
				format: { enable: configuration.get(SettingIds.enableFormatter) },
				keepLines: { enable: configuration.get(SettingIds.enableKeepLines) },
				schemas: this.computeSchemas(null),
				resultLimit: resultLimit,
				jsonFoldingLimit: jsonFoldingLimit,
				jsoncFoldingLimit: jsoncFoldingLimit,
				jsonColorDecoratorLimit: jsonColorDecoratorLimit,
				jsoncColorDecoratorLimit: jsoncColorDecoratorLimit,
				schemaDownloadEnabled: schemaDownloadEnabled,
				trustedDomains: trustedDomains
			}
		};

		return settings;
	}

	// TODO: This should not be public, but languageStatus.ts needs it.
	public computeSchemas(scope: Uri | null): JSONSchemaSettings[] {
		const schemas: JSONSchemaSettings[] = [];

		/*
		* Add schemas from the settings
		* folderUri to which folder the setting is scoped to. `undefined` means global (also external files)
		* settingsLocation against which path relative schema URLs are resolved
		*/
		const collectSchemaSettings = (schemaSettings: JSONSchemaSettings[] | undefined, folderUri: string | undefined, settingsLocation: Uri | undefined) => {
			if (schemaSettings) {
				for (const setting of schemaSettings) {
					const uri = this.getSchemaId(setting);
					if (uri) {
						if (settingsLocation && setting.schemaFile) {
							setting.retrievalUri = Uri.joinPath(settingsLocation, setting.schemaFile).toString();
						}

						const schemaSetting: JSONSchemaSettings = { uri, retrievalUri: setting.retrievalUri, fileMatch: setting.fileMatch, folderUri, schema: setting.schema };
						schemas.push(schemaSetting);
					}
				}
			}
		};

		let folders = workspace.workspaceFolders ?? [];
		if (scope) {
			const scopeFolder = workspace.getWorkspaceFolder(scope);
			if (scopeFolder) {
				folders = [ scopeFolder ];
			}
		}

		const schemaConfigInfo = workspace.getConfiguration(SettingIds.jsonsonSection, null).inspect<JSONSchemaSettings[]>(SettingIds.jsonsonSectionSchemasKey);
		if (schemaConfigInfo) {
			if (workspace.workspaceFile) {
				// settings in user config
				collectSchemaSettings(schemaConfigInfo.globalValue, undefined, undefined);

				if (schemaConfigInfo.workspaceValue) {
					const settingsLocation = Uri.joinPath(workspace.workspaceFile, '..');
					// settings in the workspace configuration file apply to all files (also external files)
					collectSchemaSettings(schemaConfigInfo.workspaceValue, undefined, settingsLocation);
				}

				for (const folder of folders) {
					const folderUri = folder.uri;
					const folderSchemaConfigInfo = workspace.getConfiguration(SettingIds.jsonsonSection, folderUri).inspect<JSONSchemaSettings[]>(SettingIds.jsonsonSectionSchemasKey);
					collectSchemaSettings(folderSchemaConfigInfo?.workspaceFolderValue, folderUri.toString(false), folderUri);
				}
			} else {
				let locationUri: Uri | undefined = undefined;

				if (folders.length === 1) {
					locationUri = folders[0].uri;
				}

				// settings in user config
				collectSchemaSettings(schemaConfigInfo.globalValue, undefined, locationUri);

				if (schemaConfigInfo.workspaceValue) {
					// single folder workspace: settings apply to all files (also external files)
					collectSchemaSettings(schemaConfigInfo.workspaceValue, undefined, locationUri);
				}
			}
		}

		return schemas;
	}

	private getSchemaId(schema: JSONSchemaSettings): string | undefined {
		if (schema.uri) {
			return schema.uri;
		}
	
		if (schema.retrievalUri) {
			return schema.retrievalUri;
		}
	
		if (schema.schema) {
			return schema.schema.id || `vscode://schemas/custom/${encodeURIComponent(hash(schema.schema).toString(16))}`;
		}
	
		return undefined;
	}
}