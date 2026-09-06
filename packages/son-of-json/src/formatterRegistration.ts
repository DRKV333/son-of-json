/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, Disposable, DocumentRangeFormattingEditProvider, FormattingOptions, languages, ProviderResult, Range, TextDocument, TextEdit, workspace } from "vscode";
import { ConfigurationManager } from "./configuration.js";
import { BaseLanguageClient, DocumentRangeFormattingParams, DocumentRangeFormattingRequest } from "vscode-languageclient";

export class FormatterRegistration implements Disposable, DocumentRangeFormattingEditProvider {
    private rangeFormatting?: Disposable
    private configSubscription: Disposable

    public constructor(
        private readonly client: BaseLanguageClient,
        private readonly config: ConfigurationManager,
        private readonly documentSelector: string[]
    ) {
        this.configSubscription = config.onDidChangeFormatterSettings(() => this.updateFormatterRegistration());
        // manually register / deregister format provider based on the `json.format.enable` setting avoiding issues with late registration. See #71652.
        this.updateFormatterRegistration();
    }

    private updateFormatterRegistration() {
        const formatEnabled = this.config.getSettings().json.format.enable;
        if (!formatEnabled && this.rangeFormatting) {
            this.rangeFormatting.dispose();
            this.rangeFormatting = undefined;
        } else if (formatEnabled && !this.rangeFormatting) {
            this.rangeFormatting = languages.registerDocumentRangeFormattingEditProvider(this.documentSelector, this);
        }
    }

    public provideDocumentRangeFormattingEdits(document: TextDocument, range: Range, options: FormattingOptions, token: CancellationToken): ProviderResult<TextEdit[]> {
        const filesConfig = workspace.getConfiguration('files', document);
        const fileFormattingOptions = {
            trimTrailingWhitespace: filesConfig.get<boolean>('trimTrailingWhitespace'),
            trimFinalNewlines: filesConfig.get<boolean>('trimFinalNewlines'),
            insertFinalNewline: filesConfig.get<boolean>('insertFinalNewline'),
        };
        const params: DocumentRangeFormattingParams = {
            textDocument: this.client.code2ProtocolConverter.asTextDocumentIdentifier(document),
            range: this.client.code2ProtocolConverter.asRange(range),
            options: this.client.code2ProtocolConverter.asFormattingOptions(options, fileFormattingOptions)
        };

        return this.client.sendRequest(DocumentRangeFormattingRequest.type, params, token).then(
            this.client.protocol2CodeConverter.asTextEdits,
            (error) => {
                this.client.handleFailedRequest(DocumentRangeFormattingRequest.type, undefined, error, []);
                return Promise.resolve([]);
            }
        );
    }

    dispose() {
        this.configSubscription.dispose();
        this.rangeFormatting?.dispose();
    }
}