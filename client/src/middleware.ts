/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, CompletionContext, CompletionItem, CompletionList, Diagnostic, DocumentSymbol, Hover, MarkdownString, Position, ProviderResult, Range, SymbolInformation, TextDocument, Uri } from "vscode";
import { DocumentDiagnosticReportKind, HandleDiagnosticsSignature, Middleware, ProvideCompletionItemsSignature, ProvideDiagnosticSignature, ProvideDocumentSymbolsSignature, ProvideHoverSignature, vsdiag } from "vscode-languageclient";
import { ConfigurationManager } from "./configuration.js";
import { isSchemaResolveError } from "./messageTypes.js";

export class JsonClientMiddleware implements Middleware {

    constructor(
        private config: ConfigurationManager,
        private schemaLoadStatusItem: { update(uri: Uri, d: Diagnostic[]): void },
        private documentSymbolsLimitStatusbarItem: { update(t: TextDocument, l: number | false): void }
    )
    {
    }

    public async provideDiagnostics(document: TextDocument | Uri, previousResultId: string | undefined, token: CancellationToken, next: ProvideDiagnosticSignature): Promise<vsdiag.DocumentDiagnosticReport | null | undefined> {
        const diagnostics = await next(document, previousResultId, token);
        if (diagnostics && diagnostics.kind === DocumentDiagnosticReportKind.Full) {
            const uri = document instanceof Uri ? document : document.uri;
            diagnostics.items = this.handleSchemaErrorDiagnostics(uri, diagnostics.items);
        }
        return diagnostics;
    }

    public async handleDiagnostics(uri: Uri, diagnostics: Diagnostic[], next: HandleDiagnosticsSignature) {
        diagnostics = this.handleSchemaErrorDiagnostics(uri, diagnostics);
        next(uri, diagnostics);
    }

    private handleSchemaErrorDiagnostics(uri: Uri, diagnostics: Diagnostic[]): Diagnostic[] {
        this.schemaLoadStatusItem.update(uri, diagnostics);
        if (!this.config.getSettings(false).json.schemaDownloadEnabled) {
            return diagnostics.filter(d => !isSchemaResolveError(d));
        }
        return diagnostics;
    }

    // testing the replace / insert mode
    public provideCompletionItem(document: TextDocument, position: Position, context: CompletionContext, token: CancellationToken, next: ProvideCompletionItemsSignature): ProviderResult<CompletionItem[] | CompletionList> {
        function update(item: CompletionItem) {
            const range = item.range;
            if (range instanceof Range && range.end.isAfter(position) && range.start.isBeforeOrEqual(position)) {
                item.range = { inserting: new Range(range.start, position), replacing: range };
            }
            if (item.documentation instanceof MarkdownString) {
                item.documentation = updateMarkdownString(item.documentation);
            }

        }
        function updateProposals(r: CompletionItem[] | CompletionList | null | undefined): CompletionItem[] | CompletionList | null | undefined {
            if (r) {
                (Array.isArray(r) ? r : r.items).forEach(update);
            }
            return r;
        }

        const r = next(document, position, context, token);
        if (isThenable<CompletionItem[] | CompletionList | null | undefined>(r)) {
            return r.then(updateProposals);
        }
        return updateProposals(r);
    }

    public provideHover(document: TextDocument, position: Position, token: CancellationToken, next: ProvideHoverSignature) {
        function updateHover(r: Hover | null | undefined): Hover | null | undefined {
            if (r && Array.isArray(r.contents)) {
                r.contents = r.contents.map(h => h instanceof MarkdownString ? updateMarkdownString(h) : h);
            }
            return r;
        }
        const r = next(document, position, token);
        if (isThenable<Hover | null | undefined>(r)) {
            return r.then(updateHover);
        }
        return updateHover(r);
    }

    public async provideDocumentSymbols(document: TextDocument, token: CancellationToken, next: ProvideDocumentSymbolsSignature): Promise<SymbolInformation[] | DocumentSymbol[] | null | undefined> {
        function countDocumentSymbols(symbols: DocumentSymbol[]): number {
            return symbols.reduce((previousValue, s) => previousValue + 1 + countDocumentSymbols(s.children), 0);
        }

        function isDocumentSymbol(r: any[]): r is DocumentSymbol[] {
            return r[0] instanceof DocumentSymbol;
        }

        const r = await next(document, token);

        const resultLimit = this.config.getSettings(false).json.resultLimit;
        if (Array.isArray(r) && (isDocumentSymbol(r) ? countDocumentSymbols(r) : r.length) > resultLimit) {
            this.documentSymbolsLimitStatusbarItem.update(document, resultLimit);
        } else {
            this.documentSymbolsLimitStatusbarItem.update(document, false);
        }

        return r;
    }
}

function isThenable<T>(obj: unknown): obj is Thenable<T> {
	return !!obj && typeof (obj as unknown as Thenable<T>).then === 'function';
}

function updateMarkdownString(h: MarkdownString): MarkdownString {
    const n = new MarkdownString(h.value, true);
    n.isTrusted = h.isTrusted;
    return n;
}