// @ts-check

"use strict";

import path from "path";

/** @type {Array<import("webpack").Configuration>} */
export default [
    {
        mode: "production",
        target: "node",
        entry: "./packages/son-of-json/out/node/jsonClientMain.js",
        output: {
            path: path.resolve(import.meta.dirname, "packages", "son-of-json", "dist", "node"),
            filename: "jsonClientMain.js",
            library: {
                type: "module"
            }
        },
        devtool: "nosources-source-map",
        externals: {
            vscode: "commonjs vscode"
        },
        experiments: { outputModule: true }
    },
    {
        mode: "production",
        target: "node",
        entry: "./packages/son-of-json-languageserver/out/node/jsonServerMain.js",
        output: {
            path: path.resolve(import.meta.dirname, "packages", "son-of-json-languageserver", "dist", "node"),
            filename: "jsonServerMain.js",
        },
        devtool: "nosources-source-map",
        experiments: { outputModule: true }
    }
];