// @ts-check

"use strict";

import path from "path";
import WebpackLicensePlugin from "webpack-license-plugin";

/** @type {ConstructorParameters<typeof import("webpack-license-plugin").default>[0]} */
const licensePluginOptions = {
    excludedPackageTest: (packageName) => [ "son-of-json", "son-of-json-languageserver", "son-of-json-shared" ].includes(packageName),
    replenishDefaultLicenseTexts: true,
    additionalFiles: {
        "THIRD_PARTY.txt": (packages) =>
            "This software contains third party packages, subject to the following open source licenses:\n\n----------\n\n" +
            packages.map((p) => `${p.name}@${p.version} ${p.source}\n\n${p.licenseText}`).join("\n\n----------\n\n")
    }
}

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
        module: {
            rules: [
                {
                    test: /\.js$/,
                    extractSourceMap: true,
                }
            ]
        },
        externals: {
            vscode: "commonjs vscode"
        },
        experiments: { outputModule: true },
        plugins: [
            new WebpackLicensePlugin(licensePluginOptions)
        ]
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
        module: {
            rules: [
                {
                    test: /\.js$/,
                    extractSourceMap: true,
                }
            ]
        },
        experiments: { outputModule: true },
        plugins: [
            new WebpackLicensePlugin(licensePluginOptions)
        ]
    }
];