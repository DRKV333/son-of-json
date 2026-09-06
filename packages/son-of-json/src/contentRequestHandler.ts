/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, l10n, RelativePattern, Uri, workspace } from "vscode";
import { BaseLanguageClient, ResponseError } from "vscode-languageclient";
import { SchemaContentChangeNotification, SchemaRequestServiceErrors, VSCodeContentRequest } from "./messageTypes.js";
import { Runtime } from "./runtimeTypes.js";
import { ConfigurationManager, SettingIds } from "./configuration.js";
import { SchemaAssociationManager } from "./schemaAssociations.js";
import { matchesUrlPattern } from "./utils/urlMatch.js";

export class ContentRequestHandler implements Disposable {
    private registrations: Disposable
    private watchers = new Map<string, Disposable>();
    private schemaDocuments = new Set<string>();

    constructor(
        private client: BaseLanguageClient,
        private runtime: Runtime,
        private config: ConfigurationManager,
        private associations: SchemaAssociationManager
    ) {
        const handler = client.onRequest(VSCodeContentRequest.type, async (uriPath: string) => {
            const uri = Uri.parse(uriPath);
            const uriString = uri.toString(true);
            if (uri.scheme === 'untitled') {
                throw new ResponseError(SchemaRequestServiceErrors.UntitledAccessError, l10n.t('Unable to load {0}', uriString));
            }
            if (uri.scheme === 'vscode') {
                try {
                    runtime.logOutputChannel.info('read schema from vscode: ' + uriString);
                    this.ensureFilesystemWatcherInstalled(uri);
                    const content = await workspace.fs.readFile(uri);
                    return new TextDecoder().decode(content);
                } catch (e) {
                    throw new ResponseError(SchemaRequestServiceErrors.VSCodeAccessError, e.toString(), e);
                }
            } else if (uri.scheme !== 'http' && uri.scheme !== 'https') {
                try {
                    const document = await workspace.openTextDocument(uri);
                    this.schemaDocuments.add(uriString);
                    return document.getText();
                } catch (e) {
                    throw new ResponseError(SchemaRequestServiceErrors.OpenTextDocumentAccessError, e.toString(), e);
                }
            } else if (config.getSettings().json.schemaDownloadEnabled) {
                if (!workspace.isTrusted) {
                    throw new ResponseError(SchemaRequestServiceErrors.UntrustedWorkspaceError, l10n.t('Downloading schemas is disabled in untrusted workspaces'));
                }
                if (!await this.isTrusted(uri)) {
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

        const contentChanged = workspace.onDidChangeTextDocument(e => {
            return this.handleContentChange(e.document.uri.toString());
        });

        const contentClosed = workspace.onDidCloseTextDocument(e => {
            const uriString = e.uri.toString();
            if (this.handleContentChange(uriString)) {
                this.schemaDocuments.delete(uriString);
            }
        });

        this.registrations = Disposable.from(handler, contentChanged, contentClosed);
    }

    private handleContentChange(uriString: string): boolean {
        if (this.schemaDocuments.has(uriString)) {
            this.client.sendNotification(SchemaContentChangeNotification.type, uriString);
            return true;
        }
        return false;
    }

    private ensureFilesystemWatcherInstalled(uri: Uri) {
        const uriString = uri.toString();
        if (!this.watchers.has(uriString)) {
            try {
                const watcher = workspace.createFileSystemWatcher(new RelativePattern(uri, '*'));
                const handleChange = (uri: Uri) => {
                    this.runtime.logOutputChannel.info('schema change detected ' + uri.toString());
                    this.client.sendNotification(SchemaContentChangeNotification.type, uriString);
                };
                const createListener = watcher.onDidCreate(handleChange);
                const changeListener = watcher.onDidChange(handleChange);
                const deleteListener = watcher.onDidDelete(() => {
                    const watcher = this.watchers.get(uriString);
                    if (watcher) {
                        watcher.dispose();
                        this.watchers.delete(uriString);
                    }
                });
                this.watchers.set(uriString, Disposable.from(watcher, createListener, changeListener, deleteListener));
            } catch {
                this.runtime.logOutputChannel.info('Problem installing a file system watcher for ' + uriString);
            }
        }
    }

    private async isTrusted(uri: Uri): Promise<boolean> {
        if (uri.scheme !== 'http' && uri.scheme !== 'https') {
            return true;
        }
        const uriString = uri.toString(true);

        const settings = this.config.getSettings();

        // Check against trustedDomains setting
        if (matchesUrlPattern(uri, settings.json.trustedDomains)) {
            return true;
        }

        const knownAssociations = await this.associations.getSchemaAssociations();
        for (const association of knownAssociations) {
            if (association.uri === uriString) {
                return true;
            }
        }
        for (const schemaSetting of settings.json.schemas) {
            if (schemaSetting.retrievalUri === uriString) {
                return true;
            }
        }

        return false;
    }

    dispose() {
        this.registrations.dispose();
        for (const d of this.watchers.values()) {
            d.dispose();
        }
    }
}