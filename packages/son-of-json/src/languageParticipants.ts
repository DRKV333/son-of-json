/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event, EventEmitter, extensions, Disposable } from 'vscode';

/**
 * JSON language participant contribution.
 */
interface LanguageParticipantContribution {
	/**
	 * The id of the language which participates with the JSON language server.
	 */
	languageId: string;
	/**
	 * true if the language allows comments and false otherwise.
	 * TODO: implement server side setting
	 */
	comments?: boolean;
}

export class LanguageParticipants implements Disposable {

	public readonly onDidChange: Event<void>;
	private readonly changeListener: Disposable;
	private readonly onDidChangeEmitter: EventEmitter<void>;
	private readonly languages = new Set<string>();
	private readonly comments = new Set<string>();

	constructor() {
		this.onDidChangeEmitter = new EventEmitter<void>();
		this.onDidChange = this.onDidChangeEmitter.event;

		this.update();

		this.changeListener = extensions.onDidChange(() => {
			if (this.update()) {
				this.onDidChangeEmitter.fire();
			}
		});
	}

	public get documentSelector(): string[] {
		return Array.from(this.languages);
	}

	public hasLanguage(languageId: string): boolean {
		return this.languages.has(languageId);
	}

	public useComments(languageId: string): boolean {
		return this.comments.has(languageId);
	}

	private update(): boolean {
		const oldLanguages = this.languages, oldComments = this.comments;

		this.languages.clear();
		this.languages.add('json');
		this.languages.add('jsonc');
		this.languages.add('snippets');

		this.comments.clear();
		this.comments.add('jsonc');
		this.comments.add('snippets');

		for (const extension of extensions.all) {
			const jsonLanguageParticipants = extension.packageJSON?.contributes?.jsonLanguageParticipants as LanguageParticipantContribution[];
			if (Array.isArray(jsonLanguageParticipants)) {
				for (const jsonLanguageParticipant of jsonLanguageParticipants) {
					const languageId = jsonLanguageParticipant.languageId;
					if (typeof languageId === 'string') {
						this.languages.add(languageId);
						if (jsonLanguageParticipant.comments === true) {
							this.comments.add(languageId);
						}
					}
				}
			}
		}
		return !isEqualSet(this.languages, oldLanguages) || !isEqualSet(this.comments, oldComments);
	}

	public dispose(): void {
		this.changeListener.dispose();
		this.onDidChangeEmitter.dispose();
	}
}

function isEqualSet<T>(s1: Set<T>, s2: Set<T>) {
	if (s1.size !== s2.size) {
		return false;
	}
	for (const e of s1) {
		if (!s2.has(e)) {
			return false;
		}
	}
	return true;
}
