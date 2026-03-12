// Patch vscode-jsonrpc to add an exports map for Node.js ESM compatibility.
// The package ships node.js / browser.js entry points but lacks an "exports"
// field, so `import "vscode-jsonrpc/node"` fails under strict ESM resolution.
const fs = require("fs");

try {
	const pkgPath = require.resolve("vscode-jsonrpc/package.json", {
		paths: [process.cwd()],
	});
	const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
	if (!pkg.exports) {
		pkg.exports = {
			".": "./lib/node/main.js",
			"./node": "./node.js",
			"./node.js": "./node.js",
			"./browser": "./browser.js",
			"./browser.js": "./browser.js",
			"./lib/*": "./lib/*",
			"./package.json": "./package.json",
		};
		fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, "\t") + "\n");
	}
} catch {
	// Best effort — don't break install if the dep isn't present yet
}
