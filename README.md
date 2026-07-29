# Son of JSON

Son of JSON is a fork of VS code's built-in JSON language feature extension, with some extra features.

**When using this extension, you should disable the built-in one, which you can find [here](vscode:extension/vscode.json-language-features), or by searching `@id:vscode.json-language-features` in the Extensions panel.**

## How to Build

In the `workspace` folder: `npm install && npm run package`

## New Features

### Better support for mapping schema content to URIs

JSON Schemas are identified by URIs. These look like URLs, but should be treated as arbitrary identifiers. The schema may or may not be retrievable from its URI.

It is the responsibility of the JSON Schema implementation to map schema URIs to their actual content. In VS Code this is typically handled by automatically fetching the schema from its URI, leaving little room to override this behavior. This results in poor support for loading schemas from local files.

Son of JSON changes the built-in extension's configuration approach. Schemas can now be defined with a separate identifier URI and a retrieval URI, supporting the following use cases:

**Map URI to a different URI for retrieval**

```json
"jsonson.schemas": [
    {
        "uri": "test://schemas/hello",
        "retrievalUri": "file:///home/vince/Test/hello.schema.json"
    }
]
```

**Map URI to a file relative to the current workspace**

```json
"jsonson.schemas": [
    {
        "uri": "test://schemas/hello",
        "schemaFile": "hello.schema.json"
    }
]
```

**Map URI to an inline schema**

```json
"jsonson.schemas": [
    {
        "uri": "test://schemas/hello",
        "schema": {
            "type": "array"
        }
    }
]
```

**Map files based on path/name to a URI, schema content, or both**

```json
"jsonson.schemas": [
    {
        "fileMatch": [ "test.json" ],
        "uri": "test://schemas/hello"
    },
    {
        "uri": "test://schemas/hello",
        "schema": {
            "type": "array"
        }
    },
    {
        "fileMatch": [ "test2.json" ],
        "schema": {
            "type": "integer"
        }
    }
]
```

## Limitations and Changes Compared to Built-in

- JSON Schema contributions from extensions running on different extension hosts (e.g., when using SSH remote development) are not supported, because the `extensions.allAcrossExtensionHosts` proposed API is not available to third-party extensions.

- Schema downloads are disabled by default. You can enable them by adding `"jsonson.schemaDownload.enable": true` to your settings.

- This extension currently does not support running in a Web Worker extension host, so it won’t work in web-only environments, like https://vscode.dev/. It will work if a Node.js extension host is also available, such as when using `code serve-web`.

- Telemetry has been disabled.