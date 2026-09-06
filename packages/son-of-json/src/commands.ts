/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { commands, Disposable, l10n, Range, TextDocument, TextEdit, Uri, window, workspace } from "vscode";
import { DocumentSortingParams, DocumentSortingRequest, SchemaContentChangeNotification, SortOptions, ValidateContentRequest } from "son-of-json-shared/messageTypes.js";
import { BaseLanguageClient, Diagnostic } from "vscode-languageclient";
import { Runtime } from "./runtimeTypes.js";
import { SettingIds } from "./configuration.js";

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

interface QuickPickItemWithAction {
    label: string;
    description?: string;
    execute: () => Promise<void>;
}

export class CommandRegistry implements Disposable {
    toDispose?: Disposable
    isClientReady: boolean = false

    public constructor(
        private readonly client: BaseLanguageClient,
        private readonly runtime: Runtime,
        private readonly triggerValidation: () => Promise<void>
    ) {}

    public registerAll() {
        if (this.toDispose)
            return;

        this.toDispose = Disposable.from(
            commands.registerCommand(CommandIds.clearCacheCommandId, async () => {
                if (this.isClientReady && this.runtime.schemaRequests.clearCache) {
                    const cachedSchemas = await this.runtime.schemaRequests.clearCache();
                    await this.client.sendNotification(SchemaContentChangeNotification.type, cachedSchemas);
                }
                window.showInformationMessage(l10n.t('JSON schema cache cleared.'));
            }),

            commands.registerCommand(CommandIds.validateCommandId, async (schemaUri: Uri, content: string) => {
                const diagnostics: Diagnostic[] = await this.client.sendRequest(ValidateContentRequest.type, { schemaUri: schemaUri.toString(), content });
                return diagnostics.map(this.client.protocol2CodeConverter.asDiagnostic);
            }),

            commands.registerCommand(CommandIds.sortCommandId, async () => {
                if (this.isClientReady) {
                    const textEditor = window.activeTextEditor;
                    if (textEditor) {
                        const documentOptions = textEditor.options;
                        const textEdits = await this.getSortTextEdits(textEditor.document, documentOptions.tabSize, documentOptions.insertSpaces);
                        const success = await textEditor.edit(mutator => {
                            for (const edit of textEdits) {
                                mutator.replace(this.client.protocol2CodeConverter.asRange(edit.range), edit.newText);
                            }
                        });
                        if (!success) {
                            window.showErrorMessage(l10n.t('Failed to sort the JSONC document, please consider opening an issue.'));
                        }
                    }
                }
            }),

            commands.registerCommand(CommandIds.retryResolveSchemaCommandId, this.triggerValidation),

            commands.registerCommand(CommandIds.configureTrustedDomainsCommandId, async (schemaUri: string) => {
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
                    this.runtime.logOutputChannel.error(`Failed to parse schema URI: ${schemaUri}`);
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
            })
        );
    }

    private async getSortTextEdits(document: TextDocument, tabSize: string | number = 4, insertSpaces: string | boolean = true): Promise<TextEdit[]> {
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
        const edits = await this.client.sendRequest(DocumentSortingRequest.type, params);
        // Here we convert the JSON objects to real TextEdit objects
        return edits.map((edit) => {
            return new TextEdit(
                new Range(edit.range.start.line, edit.range.start.character, edit.range.end.line, edit.range.end.character),
                edit.newText
            );
        });
    }

    public SetClientReady() {
        this.isClientReady = true;
    }

    public dispose() {
        this.toDispose?.dispose();
    }
}

async function updateTrustedDomains(updateDomain: string): Promise<void> {
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

function normalizeTrustedDomains(domains: Record<string, boolean>): Record<string, boolean> {
    return Object.fromEntries(Object.entries(domains).sort(([a], [b]) => a.localeCompare(b)));
};