import { Disposable, LogOutputChannel } from "vscode";
import { BaseLanguageClient, LanguageClientOptions } from "vscode-languageclient";

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

export interface AsyncDisposable {
	dispose(): Promise<void>;
}