/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, EventEmitter, extensions, RelativePattern, Uri, workspace } from "vscode";
import { ISchemaAssociation } from "./messageTypes.js";

export class SchemaAssociationManager implements Disposable {
    private schemaAssociationsCache: ISchemaAssociation[] | undefined;

    private onDidChangeAssociationsEmitter = new EventEmitter<void>();
    public onDidChangeAssociations = this.onDidChangeAssociationsEmitter.event;

    private registrations: Disposable

    constructor() {
        const extensionsChanged = extensions.onDidChange(_ => this.onSourceChanged());

        const associationWatcher = workspace.createFileSystemWatcher(new RelativePattern(Uri.parse(`vscode://schemas-associations/`), '**/schemas-associations.json'));
        const associationWatcherSubscription = associationWatcher.onDidChange(_ => this.onSourceChanged());

        this.registrations = Disposable.from(extensionsChanged, associationWatcherSubscription, associationWatcher);
    }

    private onSourceChanged() {
        this.schemaAssociationsCache = undefined;
            this.onDidChangeAssociationsEmitter.fire();
    }

    public async getSchemaAssociations(): Promise<ISchemaAssociation[]> {
        if (!this.schemaAssociationsCache) {
            this.schemaAssociationsCache = await this.computeSchemaAssociations();
        }
        return this.schemaAssociationsCache;
    }

    private async computeSchemaAssociations(): Promise<ISchemaAssociation[]> {
        const extensionAssociations = this.getSchemaExtensionAssociations();
        return extensionAssociations.concat(await this.getDynamicSchemaAssociations());
    }

    private getSchemaExtensionAssociations(): ISchemaAssociation[] {
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

    private async getDynamicSchemaAssociations(): Promise<ISchemaAssociation[]> {
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

    dispose() {
        this.registrations.dispose();
        this.onDidChangeAssociationsEmitter.dispose();
    }
}