/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { NotificationType, RequestType } from "vscode-jsonrpc"
import { Diagnostic, FormattingOptions } from "vscode-languageserver-types";

export namespace VSCodeContentRequest {
	export const type: RequestType<string, string, any> = new RequestType('vscode/content');
}

export namespace ForceValidateRequest {
	export const type: RequestType<string, Diagnostic[], any> = new RequestType('json/validate');
}

export namespace ForceValidateAllRequest {
	export const type: RequestType<void, void, any> = new RequestType('json/validateAll');
}

export namespace LanguageStatusRequest {
	export const type: RequestType<string, JSONLanguageStatus, any> = new RequestType('json/languageStatus');
}

export namespace ValidateContentRequest {
	export const type: RequestType<{ schemaUri: string; content: string }, Diagnostic[], any> = new RequestType('json/validateContent');
}

export namespace DocumentSortingRequest {
	export interface ITextEdit {
		range: {
			start: { line: number; character: number };
			end: { line: number; character: number };
		};
		newText: string;
	}

	export const type: RequestType<DocumentSortingParams, ITextEdit[], any> = new RequestType('json/sort');
}

export namespace SchemaContentChangeNotification {
	export const type: NotificationType<string | string[]> = new NotificationType('json/schemaContent');
}

export namespace SchemaAssociationNotification {
	export const type: NotificationType<ISchemaAssociations | ISchemaAssociation[]> = new NotificationType('json/schemaAssociations');
}

export interface SortOptions extends FormattingOptions {
}

export interface JSONLanguageStatus {
    schemas: string[]
};

export interface DocumentSortingParams {
	/**
	 * The uri of the document to sort.
	 */
	readonly uri: string;
	/**
	 * The sort options
	 */
	readonly options: SortOptions;
}

export interface ISchemaAssociations {
	[pattern: string]: string[];
}

export interface ISchemaAssociation {
	fileMatch: string[];
	uri: string;
}

export enum SchemaRequestServiceErrors {
    UntrustedWorkspaceError = 1,
    UntrustedSchemaError = 2,
    OpenTextDocumentAccessError = 3,
    HTTPDisabledError = 4,
    HTTPError = 5,
    VSCodeAccessError = 6,
    UntitledAccessError = 7,
}

export namespace ErrorCodes {
	export const SchemaResolveError = 0x10000;
	export const UntrustedSchemaError = SchemaResolveError + SchemaRequestServiceErrors.UntrustedSchemaError;
	export const HTTPDisabledError = SchemaResolveError + SchemaRequestServiceErrors.HTTPDisabledError;
}

export function isSchemaResolveError(diagnostic: { code?: any }) {
	return typeof diagnostic.code === 'number' && diagnostic.code >= ErrorCodes.SchemaResolveError;
}