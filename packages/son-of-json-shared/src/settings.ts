/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type SeverityLevel = 'error' | 'warning' | 'ignore';

export interface ServerSettings {
    json?: {
        schemas?: JSONSchemaServerSettings[];
        format?: { enable?: boolean };
        keepLines?: { enable?: boolean };
        validate?: {
            enable?: boolean;
            comments?: SeverityLevel;
            trailingCommas?: SeverityLevel;
            schemaValidation?: SeverityLevel;
            schemaRequest?: SeverityLevel;
        };
        resultLimit?: number;
        jsonFoldingLimit?: number;
        jsoncFoldingLimit?: number;
        jsonColorDecoratorLimit?: number;
        jsoncColorDecoratorLimit?: number;
    };
    http?: {
        proxy?: string;
        proxyStrictSSL?: boolean;
    };
}

export interface JSONSchemaServerSettings {
    uri?: string;
    retrievalUri?: string;
    fileMatch?: string[];
    schema?: any;
    folderUri?: string;
}