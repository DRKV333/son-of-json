/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, CompletionContext, CompletionItem, CompletionList, Diagnostic, DocumentSymbol, Disposable, EventEmitter, Hover, MarkdownString, Position, Range, SymbolInformation, TextDocument, Uri } from "vscode";
import { DocumentDiagnosticReportKind, HandleDiagnosticsSignature, Middleware, ProvideCompletionItemsSignature, ProvideDiagnosticSignature, ProvideDocumentSymbolsSignature, ProvideHoverSignature, vsdiag } from "vscode-languageclient";

export interface DiagnosticsEventData {
    uri: Uri,
    diagnostics: Diagnostic[]
}

export interface DocumentSymbolsEventData {
    document: TextDocument,
    symbolCount: number
}

export class JsonClientMiddleware implements Middleware, Disposable {

    private readonly onDiagnosticsEmitter = new EventEmitter<DiagnosticsEventData>();
    public readonly onDiagnostics = this.onDiagnosticsEmitter.event;

    private readonly onDocumentSymbolsEmitter = new EventEmitter<DocumentSymbolsEventData>();
    public readonly onDocumentSymbols = this.onDocumentSymbolsEmitter.event;

    public async provideDiagnostics(document: TextDocument | Uri, previousResultId: string | undefined, token: CancellationToken, next: ProvideDiagnosticSignature): Promise<vsdiag.DocumentDiagnosticReport | null | undefined> {
        const diagnostics = await next(document, previousResultId, token);
        if (diagnostics && diagnostics.kind === DocumentDiagnosticReportKind.Full) {
            const uri = document instanceof Uri ? document : document.uri;
            this.onDiagnosticsEmitter.fire({ uri, diagnostics: diagnostics.items });
        }
        return diagnostics;
    }

    public async handleDiagnostics(uri: Uri, diagnostics: Diagnostic[], next: HandleDiagnosticsSignature) {
        this.onDiagnosticsEmitter.fire({ uri, diagnostics });
        next(uri, diagnostics);
    }

    // testing the replace / insert mode
    public async provideCompletionItem(document: TextDocument, position: Position, context: CompletionContext, token: CancellationToken, next: ProvideCompletionItemsSignature): Promise<CompletionItem[] | CompletionList | null | undefined> {
        const r = await next(document, position, context, token);
        if (r) {
            (Array.isArray(r) ? r : r.items).forEach(item => {
                const range = item.range;
                if (range instanceof Range && range.end.isAfter(position) && range.start.isBeforeOrEqual(position)) {
                    item.range = { inserting: new Range(range.start, position), replacing: range };
                }
                if (item.documentation instanceof MarkdownString) {
                    item.documentation = updateMarkdownString(item.documentation);
                }
            });
        }
        return r;
    }

    public async provideHover(document: TextDocument, position: Position, token: CancellationToken, next: ProvideHoverSignature): Promise<Hover | null | undefined> {
        const r = await next(document, position, token);
        if (r && Array.isArray(r.contents)) {
            r.contents = r.contents.map(h => h instanceof MarkdownString ? updateMarkdownString(h) : h);
        }
        return r;
    }

    public async provideDocumentSymbols(document: TextDocument, token: CancellationToken, next: ProvideDocumentSymbolsSignature): Promise<SymbolInformation[] | DocumentSymbol[] | null | undefined> {
        function countDocumentSymbols(symbols: DocumentSymbol[]): number {
            return symbols.reduce((previousValue, s) => previousValue + 1 + countDocumentSymbols(s.children), 0);
        }

        const r = await next(document, token);

        let symbolCount = 0;
        if (Array.isArray(r)) {
            if (r[0] instanceof DocumentSymbol) {
                symbolCount = countDocumentSymbols(<DocumentSymbol[]>r);
            } else {
                symbolCount = r.length;
            }
        }

        this.onDocumentSymbolsEmitter.fire({ document, symbolCount });

        return r;
    }

    dispose() {
        this.onDiagnosticsEmitter.dispose();
        this.onDocumentSymbolsEmitter.dispose();
    }
}

function updateMarkdownString(h: MarkdownString): MarkdownString {
    const n = new MarkdownString(h.value, true);
    n.isTrusted = h.isTrusted;
    return n;
}